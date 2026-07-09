package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPersistAuthPasswordQuotesYAMLSpecialCharacters(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	initial := strings.Join([]string{
		"server:",
		"  host: 0.0.0.0",
		"auth:",
		"  password: old-password # Web 登录密码",
		"  session_duration_hours: 12",
		"log:",
		"  level: info",
		"",
	}, "\n")
	if err := os.WriteFile(path, []byte(initial), 0644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	want := `@abc:def # still password`
	if err := PersistAuthPassword(path, want); err != nil {
		t.Fatalf("PersistAuthPassword: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if !strings.Contains(string(data), `password: "@abc:def # still password" # Web 登录密码`) {
		t.Fatalf("password was not safely quoted or comment was not preserved:\n%s", data)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load after PersistAuthPassword: %v", err)
	}
	if cfg.Auth.Password != want {
		t.Fatalf("Auth.Password = %q, want %q", cfg.Auth.Password, want)
	}
}

func TestPersistAuthPasswordDoesNotTreatQuotedHashAsComment(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	initial := strings.Join([]string{
		"auth:",
		`  password: "old#password"`,
		"  session_duration_hours: 12",
		"",
	}, "\n")
	if err := os.WriteFile(path, []byte(initial), 0644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	if err := PersistAuthPassword(path, "new-password"); err != nil {
		t.Fatalf("PersistAuthPassword: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if strings.Contains(string(data), "#password") {
		t.Fatalf("old quoted password fragment was incorrectly preserved as a comment:\n%s", data)
	}
}

func TestEnsureLocalConfigCreatesFromExampleWithGeneratedPassword(t *testing.T) {
	dir := t.TempDir()
	examplePath := filepath.Join(dir, "config.example.yaml")
	configPath := filepath.Join(dir, "config.yaml")

	example := []byte(`auth:
  password: "change-me-use-a-long-random-password"
  session_duration_hours: 12
server:
  host: 127.0.0.1
  port: 8080
`)
	if err := os.WriteFile(examplePath, example, 0644); err != nil {
		t.Fatalf("write example: %v", err)
	}

	result, err := EnsureLocalConfig(configPath)
	if err != nil {
		t.Fatalf("EnsureLocalConfig: %v", err)
	}
	if !result.Created {
		t.Fatal("Created = false, want true")
	}
	if result.GeneratedPassword == "" {
		t.Fatal("GeneratedPassword is empty")
	}
	if result.ExamplePath != examplePath {
		t.Fatalf("ExamplePath = %q, want %q", result.ExamplePath, examplePath)
	}

	cfg, err := Load(configPath)
	if err != nil {
		t.Fatalf("Load generated config: %v", err)
	}
	if cfg.Auth.Password == "change-me-use-a-long-random-password" {
		t.Fatal("auth.password still contains the template placeholder")
	}
	if cfg.Auth.Password != result.GeneratedPassword {
		t.Fatalf("Auth.Password = %q, want generated password %q", cfg.Auth.Password, result.GeneratedPassword)
	}

	second, err := EnsureLocalConfig(configPath)
	if err != nil {
		t.Fatalf("EnsureLocalConfig existing: %v", err)
	}
	if second.Created {
		t.Fatal("Created = true for existing config, want false")
	}
}

func TestHitlAuditModelEffectiveFallsBackToMainConfig(t *testing.T) {
	main := OpenAIConfig{
		Provider: "openai",
		BaseURL:  "https://api.example.com/v1",
		APIKey:   "main-key",
		Model:    "large-model",
	}

	got := (HitlConfig{
		AuditModel: OpenAIConfig{Model: "small-reviewer"},
	}).AuditModelEffective(main)

	if got.Provider != main.Provider || got.BaseURL != main.BaseURL || got.APIKey != main.APIKey {
		t.Fatalf("expected provider/base_url/api_key to inherit main config, got %+v", got)
	}
	if got.Model != "small-reviewer" {
		t.Fatalf("expected audit model override, got %q", got.Model)
	}
}

func TestSummarizationUserIntentLedgerRunesEffective(t *testing.T) {
	var zero MultiAgentEinoMiddlewareConfig
	if got := zero.SummarizationUserIntentLedgerMaxRunesEffective(); got != DefaultSummarizationUserIntentLedgerMaxRunes {
		t.Fatalf("default ledger max runes = %d, want %d", got, DefaultSummarizationUserIntentLedgerMaxRunes)
	}
	if got := zero.SummarizationUserIntentLedgerEntryMaxRunesEffective(); got != DefaultSummarizationUserIntentLedgerEntryMaxRunes {
		t.Fatalf("default ledger entry max runes = %d, want %d", got, DefaultSummarizationUserIntentLedgerEntryMaxRunes)
	}

	custom := MultiAgentEinoMiddlewareConfig{
		SummarizationUserIntentLedgerMaxRunes:      12345,
		SummarizationUserIntentLedgerEntryMaxRunes: 2345,
	}
	if got := custom.SummarizationUserIntentLedgerMaxRunesEffective(); got != 12345 {
		t.Fatalf("custom ledger max runes = %d", got)
	}
	if got := custom.SummarizationUserIntentLedgerEntryMaxRunesEffective(); got != 2345 {
		t.Fatalf("custom ledger entry max runes = %d", got)
	}
}

func TestLatestUserMessageRunesEffective(t *testing.T) {
	var zero MultiAgentEinoMiddlewareConfig
	if got := zero.LatestUserMessageMaxRunesEffective(); got != DefaultLatestUserMessageMaxRunes {
		t.Fatalf("default latest user max runes = %d, want %d", got, DefaultLatestUserMessageMaxRunes)
	}
	if got := zero.LatestUserMessageHeadRunesEffective(); got != DefaultLatestUserMessageHeadRunes {
		t.Fatalf("default latest user head runes = %d, want %d", got, DefaultLatestUserMessageHeadRunes)
	}
	if got := zero.LatestUserMessageTailRunesEffective(); got != DefaultLatestUserMessageTailRunes {
		t.Fatalf("default latest user tail runes = %d, want %d", got, DefaultLatestUserMessageTailRunes)
	}

	custom := MultiAgentEinoMiddlewareConfig{
		LatestUserMessageMaxRunes:  100,
		LatestUserMessageHeadRunes: 40,
		LatestUserMessageTailRunes: 60,
	}
	if got := custom.LatestUserMessageMaxRunesEffective(); got != 100 {
		t.Fatalf("custom latest user max runes = %d", got)
	}
	if got := custom.LatestUserMessageHeadRunesEffective(); got != 40 {
		t.Fatalf("custom latest user head runes = %d", got)
	}
	if got := custom.LatestUserMessageTailRunesEffective(); got != 60 {
		t.Fatalf("custom latest user tail runes = %d", got)
	}
}
