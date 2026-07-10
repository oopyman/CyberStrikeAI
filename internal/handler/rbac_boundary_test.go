package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"cyberstrike-ai/internal/authctx"
	"cyberstrike-ai/internal/database"
	"cyberstrike-ai/internal/mcp"
	"cyberstrike-ai/internal/security"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

func TestDetachedAgentContextRetainsPrincipalWithoutParentCancellation(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	parent = authctx.WithPrincipal(parent, authctx.NewPrincipal("u1", "user", database.RBACScopeAssigned, map[string]bool{"agent:execute": true}))
	detached := detachedAgentContext(parent)
	cancel()
	if err := detached.Err(); err != nil {
		t.Fatalf("detached context inherited cancellation: %v", err)
	}
	principal, ok := authctx.PrincipalFromContext(detached)
	if !ok || principal.UserID != "u1" || !principal.HasPermission("agent:execute") {
		t.Fatalf("detached context lost principal: %#v, ok=%v", principal, ok)
	}
}

func TestPromoteAttackChainRequiresSourceConversationAccess(t *testing.T) {
	db, err := database.NewDB(filepath.Join(t.TempDir(), "promote-rbac.db"), zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	project, _ := db.CreateProject(&database.Project{Name: "owned"})
	conversation, _ := db.CreateConversation("foreign", database.ConversationCreateMeta{})
	_ = db.SetResourceOwner("project", project.ID, "u1")
	_ = db.SetResourceOwner("conversation", conversation.ID, "u2")
	h := NewProjectHandler(db, zap.NewNop())
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(security.ContextSessionKey, security.Session{UserID: "u1", Scope: database.RBACScopeOwn})
		c.Next()
	})
	router.POST("/api/projects/:id/promote-attack-chain/:conversationId", h.PromoteAttackChain)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/projects/"+project.ID+"/promote-attack-chain/"+conversation.ID, nil))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403: %s", w.Code, w.Body.String())
	}
}

func TestVulnerabilityCannotBeReparentedToForeignProject(t *testing.T) {
	db, err := database.NewDB(filepath.Join(t.TempDir(), "vuln-reparent-rbac.db"), zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	owned, _ := db.CreateProject(&database.Project{Name: "owned"})
	foreign, _ := db.CreateProject(&database.Project{Name: "foreign"})
	_ = db.SetResourceOwner("project", owned.ID, "u1")
	_ = db.SetResourceOwner("project", foreign.ID, "u2")
	vulnerability, err := db.CreateVulnerability(&database.Vulnerability{Title: "v", Severity: "high", ProjectID: owned.ID})
	if err != nil {
		t.Fatal(err)
	}
	_ = db.SetResourceOwner("vulnerability", vulnerability.ID, "u1")
	h := NewVulnerabilityHandler(db, zap.NewNop())
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(security.ContextSessionKey, security.Session{UserID: "u1", Scope: database.RBACScopeOwn})
		c.Next()
	})
	router.PUT("/api/vulnerabilities/:id", h.UpdateVulnerability)
	body, _ := json.Marshal(map[string]interface{}{"project_id": foreign.ID})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/api/vulnerabilities/"+vulnerability.ID, bytes.NewReader(body)))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403: %s", w.Code, w.Body.String())
	}
}

func TestAgentTaskEndpointsFilterAndRejectForeignConversations(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, user := setupConversationRBACTest(t)
	allowed, _ := db.CreateConversation("allowed", database.ConversationCreateMeta{})
	hidden, _ := db.CreateConversation("hidden", database.ConversationCreateMeta{})
	if err := db.AssignResourceToUser(user.ID, "conversation", allowed.ID); err != nil {
		t.Fatal(err)
	}
	tasks := NewAgentTaskManager()
	if _, err := tasks.StartTask(allowed.ID, "visible", func(error) {}); err != nil {
		t.Fatal(err)
	}
	if _, err := tasks.StartTask(hidden.ID, "secret", func(error) {}); err != nil {
		t.Fatal(err)
	}
	h := &AgentHandler{db: db, tasks: tasks, logger: zap.NewNop()}

	w := performAssignedHandler(user, http.MethodGet, "/api/agent-loop/tasks", nil, h.ListAgentTasks)
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d: %s", w.Code, w.Body.String())
	}
	var response struct {
		Tasks []*AgentTask `json:"tasks"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Tasks) != 1 || response.Tasks[0].ConversationID != allowed.ID {
		t.Fatalf("tasks = %#v, want only %s", response.Tasks, allowed.ID)
	}

	w = performAssignedHandler(user, http.MethodPost, "/api/agent-loop/cancel", map[string]string{"conversationId": hidden.ID}, h.CancelAgentLoop)
	if w.Code != http.StatusForbidden {
		t.Fatalf("cancel status = %d, want %d: %s", w.Code, http.StatusForbidden, w.Body.String())
	}
}

func TestChatUploadPathAuthorizationFollowsConversationAccess(t *testing.T) {
	db, user := setupConversationRBACTest(t)
	allowed, _ := db.CreateConversation("allowed", database.ConversationCreateMeta{})
	hidden, _ := db.CreateConversation("hidden", database.ConversationCreateMeta{})
	if err := db.AssignResourceToUser(user.ID, "conversation", allowed.ID); err != nil {
		t.Fatal(err)
	}
	h := NewChatUploadsHandler(zap.NewNop(), db)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Set(security.ContextSessionKey, security.Session{UserID: user.ID, Scope: database.RBACScopeAssigned, Permissions: map[string]bool{"chat:write": true}})

	if !h.pathAllowed(c, filepath.ToSlash(filepath.Join("2026-07-10", allowed.ID, "a.txt"))) {
		t.Fatal("assigned conversation attachment should be accessible")
	}
	if h.pathAllowed(c, filepath.ToSlash(filepath.Join("2026-07-10", hidden.ID, "secret.txt"))) {
		t.Fatal("foreign conversation attachment should be denied")
	}
	if h.pathAllowed(c, "2026-07-10/_manual/secret.txt") {
		t.Fatal("unowned manual attachment should fail closed")
	}
}

func TestPrepareMultiAgentSessionRejectsForeignConversation(t *testing.T) {
	db, user := setupConversationRBACTest(t)
	hidden, _ := db.CreateConversation("hidden", database.ConversationCreateMeta{})
	h := &AgentHandler{db: db, logger: zap.NewNop()}
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Set(security.ContextSessionKey, security.Session{UserID: user.ID, Scope: database.RBACScopeAssigned, Permissions: map[string]bool{"chat:write": true}})

	_, err := h.prepareMultiAgentSession(&ChatRequest{ConversationID: hidden.ID, Message: "write"}, c, "test")
	if err == nil || err.Error() != "无权访问该对话" {
		t.Fatalf("err = %v, want unauthorized conversation", err)
	}
}

func TestMonitorExecutionDetailRejectsForeignOwner(t *testing.T) {
	db, user := setupConversationRBACTest(t)
	for _, exec := range []*mcp.ToolExecution{
		{ID: "exec-allowed", ToolName: "allowed", Status: "completed", StartTime: time.Now(), OwnerUserID: user.ID},
		{ID: "exec-hidden", ToolName: "hidden", Status: "completed", StartTime: time.Now(), OwnerUserID: "another-user"},
	} {
		if err := db.SaveToolExecution(exec); err != nil {
			t.Fatal(err)
		}
	}
	h := NewMonitorHandler(mcp.NewServerWithStorage(zap.NewNop(), db), nil, db, zap.NewNop())

	request := func(id string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest(http.MethodGet, "/api/monitor/execution/"+id, nil)
		c.Params = gin.Params{{Key: "id", Value: id}}
		c.Set(security.ContextSessionKey, security.Session{UserID: user.ID, Scope: database.RBACScopeAssigned})
		h.GetExecution(c)
		return w
	}
	if w := request("exec-hidden"); w.Code != http.StatusForbidden {
		t.Fatalf("hidden status = %d, want %d: %s", w.Code, http.StatusForbidden, w.Body.String())
	}
	if w := request("exec-allowed"); w.Code != http.StatusOK {
		t.Fatalf("allowed status = %d, want %d: %s", w.Code, http.StatusOK, w.Body.String())
	}
}

func performAssignedHandler(user *database.RBACUser, method, path string, body interface{}, handler gin.HandlerFunc) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	var req *http.Request
	if body == nil {
		req = httptest.NewRequest(method, path, nil)
	} else {
		payload, _ := json.Marshal(body)
		req = httptest.NewRequest(method, path, bytes.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
	}
	c.Request = req
	c.Set(security.ContextSessionKey, security.Session{UserID: user.ID, Scope: database.RBACScopeAssigned})
	handler(c)
	return w
}
