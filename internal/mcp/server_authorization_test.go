package mcp

import (
	"context"
	"errors"
	"testing"

	"cyberstrike-ai/internal/authctx"

	"go.uber.org/zap"
)

func TestToolAuthorizerIsUniversalAndExecutionKeepsOwner(t *testing.T) {
	server := NewServer(zap.NewNop())
	server.RegisterTool(Tool{Name: "echo", InputSchema: map[string]interface{}{"type": "object"}}, func(ctx context.Context, args map[string]interface{}) (*ToolResult, error) {
		return &ToolResult{Content: []Content{{Type: "text", Text: "ok"}}}, nil
	})
	server.SetToolAuthorizer(func(ctx context.Context, toolName string, args map[string]interface{}) error {
		if _, ok := authctx.PrincipalFromContext(ctx); !ok {
			return errors.New("principal required")
		}
		return nil
	})
	if _, _, err := server.CallTool(context.Background(), "echo", nil); err == nil {
		t.Fatal("tool call without principal was allowed")
	}
	ctx := authctx.WithPrincipal(context.Background(), authctx.NewPrincipal("u1", "user", "assigned", map[string]bool{"mcp:execute": true}))
	_, executionID, err := server.CallTool(ctx, "echo", nil)
	if err != nil {
		t.Fatal(err)
	}
	execution, ok := server.GetExecution(executionID)
	if !ok || execution.OwnerUserID != "u1" {
		t.Fatalf("execution owner = %#v, want u1", execution)
	}
}
