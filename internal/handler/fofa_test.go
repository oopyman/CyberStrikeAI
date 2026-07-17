package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"cyberstrike-ai/internal/config"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

func TestFofaSearchUsesAPIKeyWithoutEmail(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv("FOFA_API_KEY", "")
	t.Setenv("FOFA_EMAIL", "legacy@example.com")

	var receivedEmail string
	var receivedKey string
	fofaServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedEmail = r.URL.Query().Get("email")
		receivedKey = r.URL.Query().Get("key")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"error":false,"size":1,"page":1,"results":[["https://example.com"]]}`))
	}))
	defer fofaServer.Close()

	h := NewFofaHandler(&config.Config{
		FOFA: config.FofaConfig{
			BaseURL: fofaServer.URL,
			APIKey:  "test-api-key",
		},
	}, zap.NewNop())

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	body := `{"query":"domain=\"example.com\"","fields":"host"}`
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/fofa/search", strings.NewReader(body))
	ctx.Request.Header.Set("Content-Type", "application/json")

	h.Search(ctx)

	if recorder.Code != http.StatusOK {
		t.Fatalf("Search() status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if receivedEmail != "" {
		t.Fatalf("FOFA request unexpectedly included email = %q", receivedEmail)
	}
	if receivedKey != "test-api-key" {
		t.Fatalf("FOFA request key = %q, want %q", receivedKey, "test-api-key")
	}

	var response fofaSearchResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.ResultsCount != 1 {
		t.Fatalf("results_count = %d, want 1", response.ResultsCount)
	}
}

func TestSafeFofaRequestErrorDoesNotExposeURLOrAPIKey(t *testing.T) {
	const secretURL = "https://fofa.info/api/v1/search/all?key=secret-api-key"
	err := &url.Error{
		Op:  http.MethodGet,
		URL: secretURL,
		Err: context.DeadlineExceeded,
	}

	status, message, timeout := safeFofaRequestError(err)

	if status != http.StatusGatewayTimeout {
		t.Fatalf("status = %d, want %d", status, http.StatusGatewayTimeout)
	}
	if !timeout {
		t.Fatal("timeout = false, want true")
	}
	if strings.Contains(message, "secret-api-key") || strings.Contains(message, secretURL) {
		t.Fatalf("safe error exposed request URL or API key: %q", message)
	}
}
