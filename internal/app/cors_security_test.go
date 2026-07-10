package app

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestCORSMiddlewareAllowsSameOriginAndRejectsForeignOrigin(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(corsMiddleware())
	router.GET("/test", func(c *gin.Context) { c.Status(http.StatusNoContent) })

	same := httptest.NewRequest(http.MethodGet, "http://app.example/test", nil)
	same.Host = "app.example"
	same.Header.Set("Origin", "http://app.example")
	sameW := httptest.NewRecorder()
	router.ServeHTTP(sameW, same)
	if sameW.Code != http.StatusNoContent || sameW.Header().Get("Access-Control-Allow-Origin") != "http://app.example" {
		t.Fatalf("same-origin response = %d, allow-origin=%q", sameW.Code, sameW.Header().Get("Access-Control-Allow-Origin"))
	}

	foreign := httptest.NewRequest(http.MethodGet, "http://app.example/test", nil)
	foreign.Host = "app.example"
	foreign.Header.Set("Origin", "https://evil.example")
	foreignW := httptest.NewRecorder()
	router.ServeHTTP(foreignW, foreign)
	if foreignW.Code != http.StatusForbidden {
		t.Fatalf("foreign-origin response = %d, want %d", foreignW.Code, http.StatusForbidden)
	}
}
