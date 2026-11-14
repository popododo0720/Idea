package main

// The review step of the merge gate: after the tests passed, an agent reads
// the pull request's diff against the issue and approves it or asks for
// changes. See gate() in tasks.go.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

const (
	// maxReviewRounds is how many reviews may ask for changes before the task fails.
	maxReviewRounds = 3
	// reviewTimeout is how long a review session may take to answer.
	reviewTimeout = 20 * time.Minute
	// maxDiffBytes caps the diff in the review prompt.
	maxDiffBytes = 120_000
	// maxCommentBytes keeps a review within Forgejo's comment size limit.
	maxCommentBytes = 60_000

	verdictApprove = "approve"
	verdictChanges = "changes"
)

// agentAPI is what the gate needs from a dsh. *dshClient implements it;
// tests replace it.
type agentAPI interface {
	ensureWorkspace(ctx context.Context, project string) (string, error)
	createSession(ctx context.Context, workspaceID, sessionID, title, preset string) (string, error)
	prompt(ctx context.Context, sessionID, requestID, text string) error
	state(ctx context.Context, sessionID string) (dshState, error)
	cancel(ctx context.Context, sessionID string) error
	lastAnswer(ctx context.Context, sessionID string, afterSeq int64) (string, error)
}

// agentOf is the dsh of a VM ("" is the agent dsh on the main VM).
func (c *Controller) agentOf(vm string) agentAPI {
	if c.agent != nil {
		return c.agent(vm)
	}
	return c.workers.client(vm)
}

// parseVerdict reads the last non-empty line of a review. Anything but the
// exact approval counts as a request for changes.
func parseVerdict(answer string) string {
	lines := strings.Split(strings.TrimSpace(answer), "\n")
	last := strings.TrimSpace(lines[len(lines)-1])
	if last == "VERDICT: approve" {
		return verdictApprove
	}
	return verdictChanges
}

// truncate cuts s to at most n bytes on a character boundary, and says so.
func truncate(s string, n int, what string) string {
	if len(s) <= n {
		return s
	}
	return strings.ToValidUTF8(s[:n], "") + fmt.Sprintf("\n\n[%s truncated: %d of %d bytes shown]\n", what, n, len(s))
}

func reviewPrompt(t taskView, diff string) string {
	return fmt.Sprintf(`You are reviewing a pull request before it is merged. Its tests passed. Do not change any files.

# Issue #%d: %s

%s

# Pull request diff

%s

# Review instructions

1. Check the diff against the issue's goal and acceptance criteria, point by point.
2. List concrete problems: missed cases the issue did not spell out, missing tests, behaviour changes nobody asked for, secrets, broken docs. Name the file and line.
3. If there are none, say so briefly.
4. End your answer with exactly one last line, either:
VERDICT: approve
VERDICT: changes
`, t.issue, t.title, t.body, diff)
}

func reviewFollowUp(number int64, review string) string {
	return fmt.Sprintf(`A review of pull request #%d found problems:

%s

Address this review: fix what it lists, run the tests, and push to the same branch (git push --force-with-lease). Do not open a new pull request. Reply when it is pushed.`, number, review)
}

// statusString reads a string field of the task's status.
func statusString(t taskView, key string) string {
	s, _, _ := unstructured.NestedString(t.obj.Object, "status", key)
	return s
}

func statusInt(t taskView, key string) int64 {
	n, _, _ := unstructured.NestedInt64(t.obj.Object, "status", key)
	return n
}

// review runs the review of the pull request's current head. It reports
// whether the pull request may be merged now; otherwise the task waits, was
// sent back to its agent, or failed.
func (c *Controller) review(ctx context.Context, t taskView, number int64, sha string) (bool, error) {
	switch {
	case statusString(t, "reviewApproved") == sha:
		return true, nil
	case statusString(t, "reviewSHA") != sha:
		return false, c.startReview(ctx, t, number, sha)
	case statusString(t, "reviewVerdict") == verdictChanges:
		// The agent finished without pushing a new commit.
		return false, c.fail(ctx, t, fmt.Sprintf("the agent pushed no new commit after the review of pull request #%d; not merged", number))
	}
	return c.collectReview(ctx, t, number, sha)
}

func (c *Controller) startReview(ctx context.Context, t taskView, number int64, sha string) error {
	d := c.agentOf("")
	diff, err := c.fj.Raw(ctx, fmt.Sprintf("/repos/%s/pulls/%d.diff", t.repo, number))
	if err != nil {
		return fmt.Errorf("review diff: %w", err)
	}
	ws, err := d.ensureWorkspace(ctx, t.project())
	if errors.Is(err, errDshNotReady) {
		return nil
	}
	if err != nil {
		return err
	}
	round := statusInt(t, "reviewRounds") + 1
	// A fixed id: after a crash, creating it again returns the same session.
	id := fmt.Sprintf("idea-review-%s-%d-%.8s", t.name, round, sha)
	session, err := d.createSession(ctx, ws, id, fmt.Sprintf("review #%d %s", t.issue, t.title), c.cfg.AgentPreset)
	if err != nil {
		return err
	}
	st, err := d.state(ctx, session)
	if err != nil {
		return err
	}
	if err := d.prompt(ctx, session, id+"-prompt", reviewPrompt(t, truncate(diff, maxDiffBytes, "diff"))); err != nil {
		return err
	}
	return c.setPhase(ctx, t, phaseGate, fmt.Sprintf("tests passed; an agent is reviewing pull request #%d", number), map[string]any{
		"reviewSHA": sha, "reviewSession": session, "reviewCursor": st.Cursor, "reviewVerdict": "",
		"reviewSince": time.Now().UTC().Format(time.RFC3339),
	})
}

func (c *Controller) collectReview(ctx context.Context, t taskView, number int64, sha string) (bool, error) {
	d := c.agentOf("")
	session, cursor := statusString(t, "reviewSession"), statusInt(t, "reviewCursor")
	st, err := d.state(ctx, session)
	if errors.Is(err, errDshNotReady) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	answer := ""
	if !st.busy() && st.Cursor > cursor {
		if answer, err = d.lastAnswer(ctx, session, cursor); err != nil {
			return false, err
		}
	}
	if answer == "" {
		since, _ := time.Parse(time.RFC3339, statusString(t, "reviewSince"))
		if time.Since(since) > reviewTimeout {
			_ = d.cancel(ctx, session)
			return false, c.fail(ctx, t, "no review within 20 minutes; not merged")
		}
		return false, nil
	}
	review := truncate(answer, maxCommentBytes, "review")
	verdict := parseVerdict(answer)
	comment := fmt.Sprintf("**Agent review of the head `%.8s`**\n\n%s\n\n(idea task `%s`)", sha, review, t.name)
	if err := c.fj.Comment(ctx, t.repo, number, comment); err != nil {
		return false, err
	}
	if verdict == verdictApprove {
		return true, c.setPhase(ctx, t, phaseGate, fmt.Sprintf("review approved pull request #%d", number),
			map[string]any{"reviewApproved": sha, "reviewVerdict": verdict})
	}
	return false, c.requestChanges(ctx, t, number, review)
}

// requestChanges sends the review to the task's own session; the task goes
// back to Working and through tests and review again with the new commit.
func (c *Controller) requestChanges(ctx context.Context, t taskView, number int64, review string) error {
	rounds := statusInt(t, "reviewRounds") + 1
	if rounds >= maxReviewRounds {
		return c.fail(ctx, t, fmt.Sprintf("review did not approve after %d rounds", maxReviewRounds))
	}
	if t.session == "" {
		return c.fail(ctx, t, fmt.Sprintf("review asked for changes to pull request #%d but the task has no session", number))
	}
	d := c.agentOf(t.vm)
	st, err := d.state(ctx, t.session)
	if err != nil {
		return err
	}
	if err := d.prompt(ctx, t.session, fmt.Sprintf("idea-%s-review-%d", t.name, rounds), reviewFollowUp(number, review)); err != nil {
		return err
	}
	return c.setPhase(ctx, t, phaseWorking, fmt.Sprintf("review asked for changes to pull request #%d; the agent is fixing them", number),
		map[string]any{"promptCursor": st.Cursor, "reviewRounds": rounds, "reviewVerdict": verdictChanges})
}

// eventsPage is the part of dsh's session/events reply the gate reads.
type eventsPage struct {
	Records []struct {
		Event struct {
			Type string `json:"type"`
			Seq  int64  `json:"seq"`
			Data struct {
				Message struct {
					Content []struct {
						Type string `json:"type"`
						Text string `json:"text"`
					} `json:"content"`
				} `json:"message"`
			} `json:"data"`
		} `json:"event"`
	} `json:"records"`
}

// answerOf is the text of the newest assistant message after afterSeq, or "".
func (p eventsPage) answerOf(afterSeq int64) string {
	var best int64
	var text string
	for _, r := range p.Records {
		e := r.Event
		if e.Type != "assistant/message" || e.Seq <= afterSeq || e.Seq < best {
			continue
		}
		var parts []string
		for _, b := range e.Data.Message.Content {
			if b.Type == "text" {
				parts = append(parts, b.Text)
			}
		}
		best, text = e.Seq, strings.TrimSpace(strings.Join(parts, "\n"))
	}
	return text
}

// lastAnswer returns the final answer of a session after the event sequence
// afterSeq, or "".
func (d *dshClient) lastAnswer(ctx context.Context, sessionID string, afterSeq int64) (string, error) {
	var page eventsPage
	err := d.call(ctx, "session/events", map[string]any{
		"address":     map[string]string{"kind": "session", "sessionId": sessionID},
		"maxMessages": 20,
	}, &page)
	return page.answerOf(afterSeq), err
}
