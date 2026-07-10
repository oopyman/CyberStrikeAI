package handler

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"cyberstrike-ai/internal/config"
	"cyberstrike-ai/internal/database"

	"go.uber.org/zap"
)

func TestRobotUsersAreResourceIsolated(t *testing.T) {
	db, err := database.NewDB(filepath.Join(t.TempDir(), "robot-rbac.db"), zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	cfg := &config.Config{}
	cfg.Project.Enabled = true
	h := NewRobotHandler(cfg, db, nil, zap.NewNop())

	conversationID, _ := h.getOrCreateConversation("wecom", "alice", "alice conversation")
	if conversationID == "" {
		t.Fatal("alice conversation was not created")
	}
	if got := h.cmdList("wecom", "bob"); strings.Contains(got, conversationID) {
		t.Fatalf("bob listed alice conversation: %s", got)
	}
	if got := h.cmdSwitch("wecom", "bob", conversationID); !strings.Contains(got, "不存在") && !strings.Contains(got, "无权访问") {
		t.Fatalf("bob switched to alice conversation: %s", got)
	}
	if got := h.cmdDelete("wecom", "bob", conversationID); !strings.Contains(got, "无权访问") {
		t.Fatalf("bob deleted alice conversation: %s", got)
	}
	if _, err := db.GetConversation(conversationID); err != nil {
		t.Fatalf("alice conversation was deleted: %v", err)
	}

	createReply := h.cmdNewProject("wecom", "alice", "alice project")
	if !strings.Contains(createReply, "已创建项目") {
		t.Fatalf("create project reply: %s", createReply)
	}
	if got := h.cmdProjects("wecom", "bob"); strings.Contains(got, "alice project") {
		t.Fatalf("bob listed alice project: %s", got)
	}
}

func TestWecomReplayGuardRequiresFreshUniqueRequest(t *testing.T) {
	h := NewRobotHandler(&config.Config{}, nil, nil, zap.NewNop())
	timestamp := time.Now().Unix()
	if !h.acceptFreshWecomRequest(fmt.Sprintf("%d", timestamp), "nonce", "signature") {
		t.Fatal("fresh request was rejected")
	}
	if h.acceptFreshWecomRequest(fmt.Sprintf("%d", timestamp), "nonce", "signature") {
		t.Fatal("duplicate request was accepted")
	}
	if h.acceptFreshWecomRequest(fmt.Sprintf("%d", timestamp-600), "old", "signature") {
		t.Fatal("stale request was accepted")
	}
}
