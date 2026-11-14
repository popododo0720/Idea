package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeAgent struct {
	mu       sync.Mutex
	sessions []string
	prompts  map[string][]string // session -> prompts
	answer   string
	busy     bool
	cursor   int64
	cancels  int
}

func (f *fakeAgent) ensureWorkspace(context.Context, string) (string, error) { return "ws", nil }
func (f *fakeAgent) createSession(_ context.Context, _, id, _, _ string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sessions = append(f.sessions, id)
	return id, nil
}
func (f *fakeAgent) prompt(_ context.Context, s, _, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.prompts == nil {
		f.prompts = map[string][]string{}
	}
	f.prompts[s] = append(f.prompts[s], text)
	return nil
}
func (f *fakeAgent) state(context.Context, string) (dshState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return dshState{Cursor: f.cursor, Running: f.busy}, nil
}
func (f *fakeAgent) cancel(context.Context, string) error { f.cancels++; return nil }
func (f *fakeAgent) lastAnswer(context.Context, string, int64) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.answer, nil
}

func TestParseVerdict(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"approve", "Looks fine.\nVERDICT: approve", verdictApprove},
		{"trailing blank lines", "ok\nVERDICT: approve\n\n  \n", verdictApprove},
		{"changes", "Missing test.\nVERDICT: changes", verdictChanges},
		{"approve not last", "VERDICT: approve\nbut wait", verdictChanges},
		{"no verdict", "Looks fine.", verdictChanges},
		{"empty", "", verdictChanges},
		{"wrong case", "VERDICT: Approve", verdictChanges},
		{"extra text", "VERDICT: approve, mostly", verdictChanges},
		{"both lines", "VERDICT: approve\nVERDICT: changes", verdictChanges},
		{"indented approve", "x\n  VERDICT: approve  ", verdictApprove},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseVerdict(tc.in); got != tc.want {
				t.Fatalf("parseVerdict(%q) = %s, want %s", tc.in, got, tc.want)
			}
		})
	}
}

func TestTruncate(t *testing.T) {
	if got := truncate("abc", 10, "diff"); got != "abc" {
		t.Fatal(got)
	}
	got := truncate("héllo wörld", 2, "diff")
	if !strings.Contains(got, "[diff truncated: 2 of 13 bytes shown]") || strings.Contains(got, "\ufffd") {
		t.Fatalf("got %q", got)
	}
}

func TestAnswerOf(t *testing.T) {
	var p eventsPage
	raw := `{"records":[
	 {"event":{"type":"user/message","seq":3}},
	 {"event":{"type":"assistant/message","seq":9,"data":{"message":{"content":[{"type":"reasoning","text":"hm"},{"type":"text","text":"final"},{"type":"text","text":"VERDICT: approve"}]}}}},
	 {"event":{"type":"assistant/message","seq":5,"data":{"message":{"content":[{"type":"text","text":"early"}]}}}}]}`
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		t.Fatal(err)
	}
	if got := p.answerOf(4); got != "final\nVERDICT: approve" {
		t.Fatalf("got %q", got)
	}
	if got := p.answerOf(9); got != "" {
		t.Fatalf("got %q", got)
	}
}

const (
	gateDiff     = "GET /repos/idea/shop/pulls/3.diff"
	prComment    = "POST /repos/idea/shop/issues/3/comments"
	reviewedOpen = `,"state":"open","mergeable":true`
)

func reviewEnv(t *testing.T, since time.Duration, extra map[string]any) (*testEnv, *fakeAgent, string) {
	t.Helper()
	e := newEnv(t, gateTask(since, extra))
	e.c.cfg.Review = true
	ag := &fakeAgent{cursor: 5}
	e.c.agent = func(string) agentAPI { return ag }
	e.fj.on(gatePulls, 200, gatePR(reviewedOpen))
	e.fj.on(gateStatus, 200, gateStatusJSON("success", 1))
	e.fj.on(gateMerge, 200, ``)
	e.fj.on(gateComment, 201, `{}`)
	e.fj.on(prComment, 201, `{}`)
	setDiff(e, "+++ b/x.go\n+new line\n")
	return e, ag, taskName("idea/shop", 7)
}

func runGate(t *testing.T, e *testEnv, name string) taskView {
	t.Helper()
	if err := e.c.gate(t.Context(), e.task(t, name)); err != nil {
		t.Fatalf("gate: %v", err)
	}
	return e.task(t, name)
}

func TestReviewApprove(t *testing.T) {
	e, ag, name := reviewEnv(t, 2*time.Minute, map[string]any{"session": "s1"})

	got := runGate(t, e, name)
	if got.phase != phaseGate || !strings.Contains(got.message(), "reviewing") || len(ag.sessions) != 1 {
		t.Fatalf("task %s %q sessions %v", got.phase, got.message(), ag.sessions)
	}
	p := ag.prompts[ag.sessions[0]][0]
	for _, want := range []string{"Issue #7", "+new line", "VERDICT: approve"} {
		if !strings.Contains(p, want) {
			t.Fatalf("prompt lacks %q: %s", want, p)
		}
	}
	if len(e.fj.called(gateMerge)) != 0 {
		t.Fatal("merged before the review answered")
	}

	// Still working: nothing happens.
	ag.busy = true
	if got = runGate(t, e, name); got.phase != phaseGate || len(e.fj.called(prComment)) != 0 {
		t.Fatal("acted on a running review")
	}

	ag.busy, ag.cursor, ag.answer = false, 9, "All good.\nVERDICT: approve"
	got = runGate(t, e, name)
	if c := e.fj.called(prComment); len(c) != 1 || !strings.Contains(c[0].Body, "All good.") {
		t.Fatalf("comments %v", c)
	}
	if got.phase != phaseDone || len(e.fj.called(gateMerge)) != 1 {
		t.Fatalf("task %s %q merges %d", got.phase, got.message(), len(e.fj.called(gateMerge)))
	}
	if len(ag.sessions) != 1 {
		t.Fatalf("review started again: %v", ag.sessions)
	}
}

func TestReviewChangesThenNewSHA(t *testing.T) {
	e, ag, name := reviewEnv(t, 2*time.Minute, map[string]any{"session": "s1"})
	runGate(t, e, name)
	ag.cursor, ag.answer = 9, "Missing a test.\nVERDICT: changes"

	got := runGate(t, e, name)
	if got.phase != phaseWorking || len(e.fj.called(gateMerge)) != 0 {
		t.Fatalf("task %s %q", got.phase, got.message())
	}
	if c := e.fj.called(prComment); len(c) != 1 || !strings.Contains(c[0].Body, "Missing a test.") {
		t.Fatalf("comments %v", c)
	}
	if pr := ag.prompts["s1"]; len(pr) != 1 || !strings.Contains(pr[0], "Missing a test.") || !strings.Contains(pr[0], "push to the same branch") {
		t.Fatalf("task session prompts %v", pr)
	}

	// The agent pushed: a new head SHA, back in the gate, and the review runs again.
	e.fj.on(gatePulls, 200, strings.ReplaceAll(gatePR(reviewedOpen), "abc123", "def456"))
	e.fj.on("GET /repos/idea/shop/commits/def456/status", 200, gateStatusJSON("success", 1))
	if err := e.c.setPhase(t.Context(), e.task(t, name), phaseGate, "pr", map[string]any{"headSHA": "def456"}); err != nil {
		t.Fatal(err)
	}
	ag.answer = ""
	got = runGate(t, e, name)
	if len(ag.sessions) != 2 || ag.sessions[0] == ag.sessions[1] || !strings.Contains(got.message(), "reviewing") {
		t.Fatalf("sessions %v, message %q", ag.sessions, got.message())
	}
}

func TestReviewChangesWithoutNewCommit(t *testing.T) {
	e, _, name := reviewEnv(t, 2*time.Minute, map[string]any{
		"reviewSHA": "abc123", "reviewSession": "r1", "reviewVerdict": verdictChanges, "reviewRounds": int64(1),
	})
	got := runGate(t, e, name)
	if got.phase != phaseFailed || !strings.Contains(got.message(), "no new commit") {
		t.Fatalf("task %s %q", got.phase, got.message())
	}
}

func TestReviewFailsAfterThreeRounds(t *testing.T) {
	e, ag, name := reviewEnv(t, 2*time.Minute, map[string]any{
		"session": "s1", "reviewSHA": "abc123", "reviewSession": "r1", "reviewCursor": int64(1), "reviewRounds": int64(2),
		"reviewSince": time.Now().UTC().Format(time.RFC3339),
	})
	ag.cursor, ag.answer = 9, "Still wrong.\nVERDICT: changes"
	got := runGate(t, e, name)
	if got.phase != phaseFailed || got.message() != "review did not approve after 3 rounds" {
		t.Fatalf("task %s %q", got.phase, got.message())
	}
	if len(ag.prompts["s1"]) != 0 || len(e.fj.called(gateMerge)) != 0 {
		t.Fatal("sent or merged after the last round")
	}
}

func TestReviewTimeout(t *testing.T) {
	e, ag, name := reviewEnv(t, 2*time.Minute, map[string]any{
		"reviewSHA": "abc123", "reviewSession": "r1", "reviewCursor": int64(1),
		"reviewSince": time.Now().Add(-21 * time.Minute).UTC().Format(time.RFC3339),
	})
	ag.busy = true
	got := runGate(t, e, name)
	if got.phase != phaseFailed || !strings.Contains(got.message(), "no review within 20 minutes") || ag.cancels != 1 {
		t.Fatalf("task %s %q cancels %d", got.phase, got.message(), ag.cancels)
	}
}

func TestReviewOff(t *testing.T) {
	e, ag, name := reviewEnv(t, 2*time.Minute, nil)
	e.c.cfg.Review = false
	got := runGate(t, e, name)
	if got.phase != phaseDone || len(e.fj.called(gateMerge)) != 1 || len(ag.sessions) != 0 {
		t.Fatalf("task %s %q sessions %v", got.phase, got.message(), ag.sessions)
	}
}

func TestReviewWaitsForMergeable(t *testing.T) {
	e, ag, name := reviewEnv(t, 10*time.Second, nil)
	e.fj.on(gatePulls, 200, gatePR(`,"state":"open","mergeable":false`))
	got := runGate(t, e, name)
	if got.phase != phaseGate || len(ag.sessions) != 0 {
		t.Fatalf("task %s sessions %v", got.phase, ag.sessions)
	}
}

func TestReviewDiffTruncated(t *testing.T) {
	e, ag, name := reviewEnv(t, 2*time.Minute, nil)
	setDiff(e, strings.Repeat("+x\n", maxDiffBytes))
	runGate(t, e, name)
	p := ag.prompts[ag.sessions[0]][0]
	if !strings.Contains(p, "diff truncated") || len(p) > maxDiffBytes+5000 {
		t.Fatalf("prompt of %d bytes: %s", len(p), fmt.Sprint(strings.Contains(p, "truncated")))
	}
}

func setDiff(e *testEnv, diff string) {
	e.fj.mu.Lock()
	defer e.fj.mu.Unlock()
	e.fj.routes[gateDiff] = fjReply{Type: "text/plain", Body: diff}
}
