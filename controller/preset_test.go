package main

import (
	"os"
	"testing"
)

func TestAgentPreset(t *testing.T) {
	t.Run("default is poteto-mode", func(t *testing.T) {
		t.Setenv("AGENT_PRESET", "")
		if err := os.Unsetenv("AGENT_PRESET"); err != nil {
			t.Fatal(err)
		}
		if got := agentPreset(); got != "poteto-mode" {
			t.Fatalf("agentPreset() = %q, want poteto-mode", got)
		}
	})
	t.Run("set", func(t *testing.T) {
		t.Setenv("AGENT_PRESET", " other-mode ")
		if got := agentPreset(); got != "other-mode" {
			t.Fatalf("agentPreset() = %q, want other-mode", got)
		}
	})
	t.Run("empty turns it off", func(t *testing.T) {
		t.Setenv("AGENT_PRESET", "")
		if got := agentPreset(); got != "" {
			t.Fatalf("agentPreset() = %q, want empty", got)
		}
	})
}
