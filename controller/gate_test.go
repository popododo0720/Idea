package main

import (
	"fmt"
	"strings"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	k8stesting "k8s.io/client-go/testing"
)

const (
	gatePulls   = "GET /repos/idea/shop/pulls"
	gateStatus  = "GET /repos/idea/shop/commits/abc123/status"
	gateMerge   = "POST /repos/idea/shop/pulls/3/merge"
	gateComment = "POST /repos/idea/shop/issues/7/comments"
	gateRunsAPI = "GET /repos/idea/shop/actions/tasks"
)

// gateRuns is a Forgejo Actions run listing with one run of sha.
func gateRuns(sha, status string) string {
	return fmt.Sprintf(`{"workflow_runs":[{"head_sha":%q,"status":%q}],"total_count":1}`, sha, status)
}

// gatePR is the pulls listing with the task's pull request (#3, branch
// idea/issue-7, head abc123) next to another task's.
func gatePR(fields string) string {
	other := `{"number":9,"state":"open","mergeable":true,"head":{"ref":"idea/issue-70","sha":"fff"}}`
	return `[` + other + `,{"number":3,"head":{"ref":"idea/issue-7","sha":"abc123"}` + fields + `}]`
}

func gateStatusJSON(state string, n int) string {
	return fmt.Sprintf(`{"state":%q,"total_count":%d}`, state, n)
}

func gateTask(since time.Duration, extra map[string]any) *unstructured.Unstructured {
	status := map[string]any{
		"phase": phaseGate, "message": "pull request #3 opened; waiting for tests",
		"phaseSince":  time.Now().UTC().Add(-since).Format(time.RFC3339),
		"pullRequest": int64(3), "headSHA": "abc123",
	}
	for k, v := range extra {
		status[k] = v
	}
	return taskObj(7, status)
}

func TestGate(t *testing.T) {
	open := `,"state":"open","mergeable":true`
	cases := []struct {
		name        string
		since       time.Duration
		extra       map[string]any // more task status
		pulls       fjReply
		status      fjReply
		runs        fjReply // Forgejo Actions runs; unset: 404 (Actions off)
		merge       fjReply
		wantErr     string // part of the returned error
		wantPhase   string
		wantMsg     string // part of the task's message
		wantMerge   bool
		wantComment string // part of the issue comment; "" for none
	}{
		{
			name: "merged by hand", since: time.Minute,
			pulls:     fjReply{Body: gatePR(`,"state":"closed","merged":true`)},
			wantPhase: phaseDone, wantMsg: "pull request #3 merged",
		},
		{
			name: "tests passed", since: 2 * time.Minute,
			pulls: fjReply{Body: gatePR(open)}, status: fjReply{Body: gateStatusJSON("success", 1)},
			wantPhase: phaseDone, wantMsg: "pull request #3 merged", wantMerge: true, wantComment: "Tests passed and pull request #3 was merged",
		},
		{
			name: "tests failed", since: 2 * time.Minute,
			pulls: fjReply{Body: gatePR(open)}, status: fjReply{Body: gateStatusJSON("failure", 2)},
			wantPhase: phaseFailed, wantMsg: "tests failed on pull request #3; not merged", wantComment: "**not merged**",
		},
		{
			name: "tests errored", since: 2 * time.Minute,
			pulls: fjReply{Body: gatePR(open)}, status: fjReply{Body: gateStatusJSON("error", 1)},
			wantPhase: phaseFailed, wantMsg: "tests failed", wantComment: "Tests failed",
		},
		{
			name: "tests running", since: 5 * time.Minute,
			pulls: fjReply{Body: gatePR(open)}, status: fjReply{Body: gateStatusJSON("pending", 1)},
			wantPhase: phaseGate, wantMsg: "waiting for tests",
		},
		{
			// A slow runner or a queue of pull requests: keep waiting.
			name: "tests still running after 25 minutes", since: 25 * time.Minute,
			pulls: fjReply{Body: gatePR(open)}, status: fjReply{Body: gateStatusJSON("pending", 1)},
			wantPhase: phaseGate, wantMsg: "waiting for tests",
		},
		{
			name: "tests still running after 3 hours", since: 3*time.Hour + time.Minute,
			pulls: fjReply{Body: gatePR(open)}, status: fjReply{Body: gateStatusJSON("pending", 1)},
			wantPhase: phaseFailed, wantMsg: "tests did not finish within 3 hours; not merged",
		},
		{
			// The run waits for the runner and has no status yet.
			name: "tests queued after 40 minutes", since: 40 * time.Minute,
			pulls: fjReply{Body: gatePR(open)}, status: fjReply{Body: gateStatusJSON("", 0)},
			runs:      fjReply{Body: gateRuns("abc123", "waiting")},
			wantPhase: phaseGate, wantMsg: "waiting for tests",
		},
		{
			name: "only other commits' runs after 21 minutes", since: 21 * time.Minute,
			pulls: fjReply{Body: gatePR(open)}, status: fjReply{Body: gateStatusJSON("", 0)},
			runs:      fjReply{Body: gateRuns("fff", "running")},
			wantPhase: phaseFailed, wantMsg: "no test result within 20 minutes; not merged",
		},
		{
			name: "this commit's run finished without a status", since: 21 * time.Minute,
			pulls: fjReply{Body: gatePR(open)}, status: fjReply{Body: gateStatusJSON("", 0)},
			runs:      fjReply{Body: gateRuns("abc123", "cancelled")},
			wantPhase: phaseFailed, wantMsg: "no test result within 20 minutes; not merged",
		},
		{
			name: "runs unreadable", since: 21 * time.Minute,
			pulls: fjReply{Body: gatePR(open)}, status: fjReply{Body: gateStatusJSON("", 0)},
			runs:    fjReply{Status: 500},
			wantErr: "HTTP 500", wantPhase: phaseGate, wantMsg: "waiting for tests",
		},
		{
			name: "no status yet", since: 3 * time.Minute,
			pulls: fjReply{Body: gatePR(open)}, status: fjReply{Body: gateStatusJSON("", 0)},
			wantPhase: phaseGate, wantMsg: "waiting for tests",
		},
		{
			name: "no status after 20 minutes", since: 21 * time.Minute,
			pulls: fjReply{Body: gatePR(open)}, status: fjReply{Body: gateStatusJSON("", 0)},
			wantPhase: phaseFailed, wantMsg: "no test result within 20 minutes; not merged",
		},
		{
			// Without any status there were no tests, whatever the state says.
			name: "success without statuses", since: 21 * time.Minute,
			pulls: fjReply{Body: gatePR(open)}, status: fjReply{Body: gateStatusJSON("success", 0)},
			wantPhase: phaseFailed, wantMsg: "no test result",
		},
		{
			name: "pull request gone", since: time.Minute,
			pulls:     fjReply{Body: `[{"number":9,"head":{"ref":"idea/issue-70"}}]`},
			wantPhase: phaseFailed, wantMsg: "the pull request disappeared",
		},
		{
			name: "no pull requests at all", since: time.Minute,
			pulls:     fjReply{Body: `[]`},
			wantPhase: phaseFailed, wantMsg: "disappeared",
		},
		{
			// Forgejo answers a merge of a closed pull request with 404.
			name: "closed without merging", since: 2 * time.Minute,
			pulls: fjReply{Body: gatePR(`,"state":"closed","mergeable":true`)}, status: fjReply{Body: gateStatusJSON("success", 1)},
			merge:     fjReply{Status: 404, Body: `{"message":"not found"}`},
			wantPhase: phaseFailed, wantMsg: "pull request #3 was closed without merging",
		},
		{
			name: "merge refused", since: 2 * time.Minute,
			pulls: fjReply{Body: gatePR(open)}, status: fjReply{Body: gateStatusJSON("success", 1)},
			merge:   fjReply{Status: 405, Body: `{"message":"not allowed"}`},
			wantErr: "merge: ", wantPhase: phaseGate, wantMsg: "waiting for tests", wantMerge: true,
		},
		{
			name: "Forgejo down for the pull requests", since: 2 * time.Minute,
			pulls:   fjReply{Status: 503},
			wantErr: "HTTP 503", wantPhase: phaseGate, wantMsg: "waiting for tests",
		},
		{
			name: "status unreadable", since: 25 * time.Minute,
			pulls: fjReply{Body: gatePR(open)}, status: fjReply{Status: 500},
			wantErr: "HTTP 500", wantPhase: phaseGate, wantMsg: "waiting for tests",
		},
		{
			name: "conflicts, no session to rebase in", since: 2 * time.Minute,
			pulls: fjReply{Body: gatePR(`,"state":"open","mergeable":false`)}, status: fjReply{Body: gateStatusJSON("success", 1)},
			wantPhase: phaseFailed, wantMsg: "pull request #3 conflicts with main",
		},
		{
			name: "conflicts after three rebases", since: 2 * time.Minute, extra: map[string]any{"session": "s1", "conflicts": int64(3)},
			pulls: fjReply{Body: gatePR(`,"state":"open","mergeable":false`)}, status: fjReply{Body: gateStatusJSON("success", 1)},
			wantPhase: phaseFailed, wantMsg: "still conflicts with main after 3 rebases; not merged",
		},
		{
			// Forgejo checks mergeability shortly after a push: right after
			// one, "not mergeable" is not trusted yet.
			name: "not mergeable right after a push", since: 10 * time.Second,
			pulls: fjReply{Body: gatePR(`,"state":"open","mergeable":false`)}, status: fjReply{Body: gateStatusJSON("pending", 1)},
			wantPhase: phaseGate, wantMsg: "waiting for tests",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t, gateTask(tc.since, tc.extra))
			e.fj.mu.Lock()
			e.fj.routes[gatePulls] = tc.pulls
			if tc.status.Body != "" || tc.status.Status != 0 {
				e.fj.routes[gateStatus] = tc.status
			}
			if tc.runs.Body != "" || tc.runs.Status != 0 {
				e.fj.routes[gateRunsAPI] = tc.runs
			}
			e.fj.routes[gateComment] = fjReply{Status: 201, Body: `{}`}
			e.fj.routes[gateMerge] = tc.merge
			e.fj.mu.Unlock()
			name := taskName("idea/shop", 7)

			err := e.c.gate(t.Context(), e.task(t, name))
			if tc.wantErr == "" && err != nil {
				t.Fatalf("gate: %v", err)
			}
			if tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
				t.Fatalf("gate error %v, want %q", err, tc.wantErr)
			}
			got := e.task(t, name)
			if got.phase != tc.wantPhase || !strings.Contains(got.message(), tc.wantMsg) {
				t.Fatalf("task %s %q, want %s %q", got.phase, got.message(), tc.wantPhase, tc.wantMsg)
			}
			merges := e.fj.called(gateMerge)
			if tc.wantMerge != (len(merges) == 1) || len(merges) > 1 {
				t.Fatalf("merge calls: %d", len(merges))
			}
			if q := e.fj.called(gatePulls); len(q) != 1 || q[0].Query != "state=all&limit=50" {
				t.Fatalf("pulls calls %+v", q)
			}
			comments := e.fj.called(gateComment)
			if tc.wantComment == "" && len(comments) != 0 {
				t.Fatalf("unexpected comment %s", comments[0].Body)
			}
			if tc.wantComment != "" && (len(comments) != 1 || !strings.Contains(comments[0].Body, tc.wantComment) ||
				!strings.Contains(comments[0].Body, "`"+name+"`")) {
				t.Fatalf("comments %+v, want %q", comments, tc.wantComment)
			}
			// An ended task's gate job is removed.
			if tc.wantPhase == phaseDone || tc.wantPhase == phaseFailed {
				if !deletedJob(e, "g-"+name) {
					t.Fatal("the gate job was not cleaned up")
				}
				// The phase change starts a new phase clock.
				if time.Since(got.since) > time.Minute {
					t.Fatalf("phaseSince not reset: %v", got.since)
				}
			}
		})
	}
}

func deletedJob(e *testEnv, name string) bool {
	for _, a := range e.kube.Actions() {
		if d, ok := a.(k8stesting.DeleteAction); ok && a.GetResource().Resource == "jobs" && d.GetName() == name {
			return true
		}
	}
	return false
}

// A mirrored project's pull request is checked before it is merged.
func TestGatePublishHold(t *testing.T) {
	cleanCommit := `[{"sha":"abc123","commit":{"message":"Add x","author":{"email":"idea-worker@idea.internal"},"committer":{"email":"idea-worker@idea.internal"}}}]`
	cases := []struct {
		name        string
		commits     fjReply
		diff        string
		wantPhase   string
		wantMsg     string
		wantMerge   bool
		wantComment string
	}{
		{
			name: "clean", commits: fjReply{Body: cleanCommit}, diff: "+++ b/x.go\n@@ -1 +1,2 @@\n+fine\n",
			wantPhase: phaseDone, wantMsg: "merged", wantMerge: true, wantComment: "Tests passed",
		},
		{
			name:      "foreign e-mail",
			commits:   fjReply{Body: strings.ReplaceAll(cleanCommit, `"author":{"email":"idea-worker@idea.internal"}`, `"author":{"email":"me@corp.example"}`)},
			wantPhase: phaseFailed, wantMsg: "cannot be published", wantComment: "**not merged**",
		},
		{
			name: "private string in the diff", commits: fjReply{Body: cleanCommit}, diff: "+++ b/x.go\n@@ -1 +1,2 @@\n+url = \"https://box.lan\"\n",
			wantPhase: phaseFailed, wantMsg: "x.go, line 1", wantComment: "published to a mirror",
		},
		{
			// Held until it can be checked; nothing is merged meanwhile.
			name: "commits unreadable", commits: fjReply{Status: 500},
			wantPhase: phaseGate, wantMsg: "not merged yet: ",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mirrored := projectObj("shop", map[string]any{"mirror": map[string]any{"url": "git@github.com:o/shop.git"}})
			private := secret(testSystemNS, privateStringsSecret, map[string]string{"strings": "# private\nbox.lan\n\n"})
			e := newEnv(t, gateTask(2*time.Minute, nil), mirrored, private)
			e.fj.on(gatePulls, 200, gatePR(`,"state":"open","mergeable":true`))
			e.fj.on(gateStatus, 200, gateStatusJSON("success", 1))
			e.fj.on(gateMerge, 200, ``)
			e.fj.on(gateComment, 201, `{}`)
			e.fj.mu.Lock()
			e.fj.routes["GET /repos/idea/shop/pulls/3/commits"] = tc.commits
			e.fj.routes["GET /repos/idea/shop/pulls/3.diff"] = fjReply{Type: "text/plain", Body: tc.diff}
			e.fj.mu.Unlock()
			name := taskName("idea/shop", 7)

			if err := e.c.gate(t.Context(), e.task(t, name)); err != nil {
				t.Fatalf("gate: %v", err)
			}
			got := e.task(t, name)
			if got.phase != tc.wantPhase || !strings.Contains(got.message(), tc.wantMsg) {
				t.Fatalf("task %s %q, want %s %q", got.phase, got.message(), tc.wantPhase, tc.wantMsg)
			}
			if strings.Contains(got.message(), "box.lan") {
				t.Fatal("the private string leaked into the task message")
			}
			if n := len(e.fj.called(gateMerge)); (n == 1) != tc.wantMerge {
				t.Fatalf("merge calls %d", n)
			}
			comments := e.fj.called(gateComment)
			if tc.wantComment == "" && len(comments) != 0 {
				t.Fatalf("unexpected comment %s", comments[0].Body)
			}
			if tc.wantComment != "" && (len(comments) != 1 || !strings.Contains(comments[0].Body, tc.wantComment)) {
				t.Fatalf("comments %+v", comments)
			}
			for _, c := range comments {
				if strings.Contains(c.Body, "box.lan") {
					t.Fatal("the private string leaked into a comment")
				}
			}
		})
	}
}

// GATE_MODE=controller: the controller runs the tests in a Job and records
// the outcome as the commit status the gate then reads.
func TestRunGateJob(t *testing.T) {
	const statuses = "POST /repos/idea/shop/statuses/abc123"
	job := func(sha string, succeeded, failed int32) *batchv1.Job {
		return &batchv1.Job{
			ObjectMeta: metav1.ObjectMeta{Namespace: testWorkNS, Name: "g-" + taskName("idea/shop", 7),
				Annotations: map[string]string{"idea.dev/sha": sha}},
			Status: batchv1.JobStatus{Succeeded: succeeded, Failed: failed},
		}
	}
	cases := []struct {
		name       string
		job        *batchv1.Job
		wantState  string // commit status posted; "" for none
		wantJob    bool   // a Job exists afterwards
		wantDelete bool
	}{
		{name: "first pass starts the tests", wantState: "pending", wantJob: true},
		{name: "running", job: job("abc123", 0, 0), wantJob: true},
		{name: "passed", job: job("abc123", 1, 0), wantState: "success", wantJob: true},
		{name: "failed", job: job("abc123", 0, 1), wantState: "failure", wantJob: true},
		{name: "branch moved", job: job("old", 1, 0), wantDelete: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			objs := []runtime.Object{gateTask(time.Minute, nil)}
			if tc.job != nil {
				objs = append(objs, tc.job)
			}
			e := newEnv(t, objs...)
			e.c.cfg.WorkerImage = "worker:1"
			e.fj.on(statuses, 201, `{}`)
			tv := e.task(t, taskName("idea/shop", 7))
			if err := e.c.runGateJob(t.Context(), tv, "abc123"); err != nil {
				t.Fatalf("runGateJob: %v", err)
			}
			posted := e.fj.called(statuses)
			if tc.wantState == "" && len(posted) != 0 {
				t.Fatalf("unexpected status %s", posted[0].Body)
			}
			if tc.wantState != "" && (len(posted) != 1 || !strings.Contains(posted[0].Body, `"state":"`+tc.wantState+`"`) ||
				!strings.Contains(posted[0].Body, `"context":"idea/tests"`)) {
				t.Fatalf("statuses %+v, want %s", posted, tc.wantState)
			}
			j, err := e.kube.BatchV1().Jobs(testWorkNS).Get(t.Context(), tv.gateJob(), metav1.GetOptions{})
			if tc.wantJob != (err == nil) {
				t.Fatalf("job exists: %v", err)
			}
			if tc.wantDelete && !deletedJob(e, tv.gateJob()) {
				t.Fatal("the job of the old commit was not deleted")
			}
			if tc.job == nil {
				// A new Job: the commit to test, in a Kata VM, without cluster credentials.
				spec := j.Spec.Template.Spec
				if j.Annotations["idea.dev/sha"] != "abc123" || spec.RuntimeClassName == nil || *spec.RuntimeClassName != "kata" ||
					spec.AutomountServiceAccountToken == nil || *spec.AutomountServiceAccountToken ||
					*j.Spec.BackoffLimit != 0 || spec.Containers[0].Image != "worker:1" ||
					!strings.Contains(spec.Containers[0].Command[2], "git checkout -q abc123") {
					t.Fatalf("job = %+v", j)
				}
			}
		})
	}
}

// One pass in controller mode: the Job is started and the task waits.
func TestGateControllerMode(t *testing.T) {
	e := newEnv(t, gateTask(time.Minute, nil))
	e.c.cfg.GateMode = "controller"
	e.fj.on(gatePulls, 200, gatePR(`,"state":"open","mergeable":true`))
	e.fj.on("POST /repos/idea/shop/statuses/abc123", 201, `{}`)
	e.fj.on(gateStatus, 200, gateStatusJSON("pending", 1))
	name := taskName("idea/shop", 7)
	if err := e.c.gate(t.Context(), e.task(t, name)); err != nil {
		t.Fatal(err)
	}
	if _, err := e.kube.BatchV1().Jobs(testWorkNS).Get(t.Context(), "g-"+name, metav1.GetOptions{}); err != nil {
		t.Fatalf("no gate job: %v", err)
	}
	if got := e.task(t, name); got.phase != phaseGate || len(e.fj.called(gateMerge)) != 0 {
		t.Fatalf("task %s", got.phase)
	}
}
