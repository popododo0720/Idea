package main

// The Task state machine. One pass looks at every Task and moves it at most
// one step. Each step is idempotent: it derives what to do from the Task's
// status and from what exists in the cluster and the agent dsh, so a pass can
// be repeated or interrupted at any point.
//
// A task runs as a session in a worker VM's dsh (workers.go, dsh.go), in its
// project's workspace, so the owner can watch and steer it from their own
// dsh. Tasks started before the worker VMs existed stay in the agent dsh.
//
//	Pending ─▶ Working ─▶ Gate ─▶ Done
//	   └──────────┴─────────┴────▶ Failed

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

var taskGVR = schema.GroupVersionResource{Group: "idea.dev", Version: "v1alpha1", Resource: "tasks"}

// retryMarker separates the owner's retry instruction in a task's body.
const retryMarker = "\n\n---\nFollow-up instruction from the owner:\n"

const (
	phasePending  = "Pending"
	phaseStarting = "WorkerStarting" // older controllers; treated as Pending
	phaseWorking  = "Working"
	phaseGate     = "Gate"
	phaseDone     = "Done"
	phaseFailed   = "Failed"

	gateContext = "idea/tests"
)

func ptr[T any](v T) *T { return &v }

// taskName is deterministic, so creating the same task twice is a no-op.
func taskName(repo string, issue int64) string {
	short := repo[strings.LastIndex(repo, "/")+1:]
	return fmt.Sprintf("%s-issue-%d", strings.ToLower(short), issue)
}

func (c *Controller) createTask(ctx context.Context, repo string, issue int64, title, body, source string) error {
	name := taskName(repo, issue)
	claimed, err := c.store.Claim(ctx, repo, issue, name)
	if err != nil {
		return err
	}
	obj := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "idea.dev/v1alpha1",
		"kind":       "Task",
		"metadata":   map[string]any{"name": name, "namespace": c.cfg.SystemNS},
		"spec":       map[string]any{"repo": repo, "issue": issue, "title": title, "body": body},
	}}
	_, err = c.dyn.Resource(taskGVR).Namespace(c.cfg.SystemNS).Create(ctx, obj, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		return nil // already being handled: never pick the same issue twice
	}
	if err != nil {
		return err
	}
	slog.Info("task created", "task", name, "source", source, "firstClaim", claimed)
	c.store.Event(ctx, name, phasePending, "created from "+source)
	return nil
}

type taskView struct {
	obj     *unstructured.Unstructured
	name    string
	repo    string
	issue   int64
	title   string
	body    string
	phase   string
	since   time.Time // when the current phase began
	pr      int64
	sha     string
	branch  string
	session string // dsh session id, once created
	vm      string // worker VM the session is on ("" is the agent dsh)
	prompts int64  // prompts sent to the session (initial + retries)
	cursor  int64  // session log position when the last prompt was sent
}

func viewOf(u *unstructured.Unstructured) taskView {
	t := taskView{obj: u, name: u.GetName()}
	t.repo, _, _ = unstructured.NestedString(u.Object, "spec", "repo")
	t.issue, _, _ = unstructured.NestedInt64(u.Object, "spec", "issue")
	t.title, _, _ = unstructured.NestedString(u.Object, "spec", "title")
	t.body, _, _ = unstructured.NestedString(u.Object, "spec", "body")
	t.phase, _, _ = unstructured.NestedString(u.Object, "status", "phase")
	if t.phase == "" {
		t.phase = phasePending
	}
	t.pr, _, _ = unstructured.NestedInt64(u.Object, "status", "pullRequest")
	t.sha, _, _ = unstructured.NestedString(u.Object, "status", "headSHA")
	t.session, _, _ = unstructured.NestedString(u.Object, "status", "session")
	t.vm, _, _ = unstructured.NestedString(u.Object, "status", "vm")
	t.prompts, _, _ = unstructured.NestedInt64(u.Object, "status", "prompts")
	t.cursor, _, _ = unstructured.NestedInt64(u.Object, "status", "promptCursor")
	if t.phase == phaseStarting {
		t.phase = phasePending
	}
	if s, _, _ := unstructured.NestedString(u.Object, "status", "phaseSince"); s != "" {
		t.since, _ = time.Parse(time.RFC3339, s)
	}
	if t.since.IsZero() {
		t.since = u.GetCreationTimestamp().Time
	}
	t.branch = fmt.Sprintf("idea/issue-%d", t.issue)
	return t
}

func (t taskView) gateJob() string { return "g-" + t.name }

// project is the repository name, which is also the project's name.
func (t taskView) project() string { return t.repo[strings.LastIndex(t.repo, "/")+1:] }

// setPhase writes the new phase (and extra status fields) to the Task.
func (c *Controller) setPhase(ctx context.Context, t taskView, phase, message string, extra map[string]any) error {
	status, _, _ := unstructured.NestedMap(t.obj.Object, "status")
	if status == nil {
		status = map[string]any{}
	}
	if status["phase"] != phase {
		status["phaseSince"] = time.Now().UTC().Format(time.RFC3339)
	}
	status["phase"] = phase
	status["message"] = message
	status["branch"] = t.branch
	for k, v := range extra {
		status[k] = v
	}
	u := t.obj.DeepCopy()
	u.Object["status"] = status
	_, err := c.dyn.Resource(taskGVR).Namespace(u.GetNamespace()).UpdateStatus(ctx, u, metav1.UpdateOptions{})
	if err != nil {
		return err
	}
	slog.Info("task phase", "task", t.name, "phase", phase, "message", message)
	c.store.Event(ctx, t.name, phase, message)
	return nil
}

// dshOf is the dsh a task's session lives in.
func (c *Controller) dshOf(t taskView) *dshClient { return c.workers.client(t.vm) }

func (c *Controller) reconcileTasks(ctx context.Context) error {
	list, err := c.dyn.Resource(taskGVR).Namespace(c.cfg.SystemNS).List(ctx, metav1.ListOptions{})
	if err != nil {
		return err
	}
	active := 0
	perVM := map[string]int{} // working sessions on each worker VM
	for i := range list.Items {
		t := viewOf(&list.Items[i])
		switch t.phase {
		case phaseWorking, phaseGate:
			active++
		}
		if t.phase == phaseWorking && t.vm != "" {
			perVM[t.vm]++
		}
	}
	for vm, n := range c.workers.teamBusy() {
		perVM[vm] += n // teammates (team.go) use the same slots
	}
	vms, replicas, err := c.workers.list(ctx)
	if err != nil {
		return fmt.Errorf("worker VMs: %w", err)
	}
	for i := range list.Items {
		t := viewOf(&list.Items[i])
		if t.phase == phasePending {
			if c.cfg.MaxActive > 0 && active >= c.cfg.MaxActive {
				_ = c.waitMessage(ctx, t, fmt.Sprintf("waiting: %d tasks are working (the most at once)", active))
				continue
			}
			if t.session == "" {
				// A new task: a worker VM with a free slot, or more VMs.
				vm := c.workers.pick(vms, perVM)
				if vm == "" {
					if err := c.waitMessage(ctx, t, c.workers.grow(ctx, vms, replicas)); err != nil {
						slog.Warn("task step", "task", t.name, "err", err.Error())
					}
					continue
				}
				t.vm = vm
				perVM[vm]++
			}
			active++
		}
		if err := c.step(ctx, t); err != nil {
			slog.Warn("task step", "task", t.name, "phase", t.phase, "err", err.Error())
		}
	}
	return nil
}

func (c *Controller) step(ctx context.Context, t taskView) error {
	switch t.phase {
	case phasePending:
		return c.startSession(ctx, t)

	case phaseWorking:
		if t.session == "" {
			// Started by an older controller (work pod + main job): start over.
			return c.setPhase(ctx, t, phasePending, "moved to the agent dsh", nil)
		}
		st, err := c.dshOf(t).state(ctx, t.session)
		if err != nil {
			if errors.Is(err, errDshNotReady) {
				return nil // the agent dsh is restarting; the session survives
			}
			return err
		}
		if len(st.PendingInput) > 0 {
			const asking = "the agent is asking a question: answer it in the session"
			if msg, _, _ := unstructured.NestedString(t.obj.Object, "status", "message"); msg != asking {
				return c.setPhase(ctx, t, phaseWorking, asking, nil)
			}
			return nil
		}
		if st.busy() || st.Cursor <= t.cursor {
			if time.Since(t.since) > 90*time.Minute {
				_ = c.dshOf(t).cancel(ctx, t.session)
				return c.fail(ctx, t, "the agent did not finish in 90 minutes")
			}
			return nil // still working (or the prompt has not started yet)
		}
		// What counts is whether a pull request exists, not what the agent said.
		pr, err := c.fj.FindPR(ctx, t.repo, t.branch)
		if err != nil {
			return err
		}
		if pr == nil {
			return c.fail(ctx, t, "the agent stopped without opening a pull request (see its session)")
		}
		return c.setPhase(ctx, t, phaseGate, fmt.Sprintf("pull request #%d opened; waiting for tests", pr.Number),
			map[string]any{"pullRequest": pr.Number, "headSHA": pr.Head.SHA, "pullRequestURL": pr.URL})

	case phaseGate:
		return c.gate(ctx, t)

	case phaseFailed:
		// The owner may carry on in the task's session (for example after
		// adding a model key, or to fix failing tests). When its agent is
		// working again, so is the task.
		if t.session == "" {
			return nil
		}
		st, err := c.dshOf(t).state(ctx, t.session)
		if err != nil {
			if errors.Is(err, errDshNotReady) || isRemote(err, "session/not-found") {
				return nil
			}
			return err
		}
		if !st.busy() {
			return nil
		}
		for _, k := range []string{"pullRequest", "pullRequestURL", "headSHA"} {
			unstructured.RemoveNestedField(t.obj.Object, "status", k)
		}
		return c.setPhase(ctx, t, phaseWorking, "the session was continued in dsh", map[string]any{"promptCursor": st.Cursor})
	}
	return nil
}

// startSession sends the task to the agent dsh: the first time as a new
// session in the project's workspace, on a retry as a follow-up prompt in
// the same session, so the conversation stays in one place.
func (c *Controller) startSession(ctx context.Context, t taskView) error {
	session := t.session
	d := c.dshOf(t)
	where := "the agent dsh"
	if t.vm != "" {
		where = "worker VM " + t.vm
	}
	if session == "" {
		// On a worker VM, tasks run side by side: each gets its own checkout.
		dir := t.project()
		if t.vm != "" {
			dir = t.name
		}
		ws, err := d.ensureWorkspace(ctx, dir)
		if errors.Is(err, errDshNotReady) {
			return c.waitMessage(ctx, t, "waiting for "+where+" to start")
		}
		if err != nil {
			return err
		}
		// A fixed id: creating it again (after a crash) returns the same session.
		session, err = d.createSession(ctx, ws, "idea-"+t.name, fmt.Sprintf("#%d %s", t.issue, t.title))
		if err != nil {
			return err
		}
	}
	st, err := d.state(ctx, session)
	if errors.Is(err, errDshNotReady) {
		return c.waitMessage(ctx, t, "waiting for "+where+" to start")
	}
	if err != nil {
		return err
	}
	text := c.taskPrompt(t)
	if t.prompts > 0 {
		text = c.retryPrompt(t)
	}
	// The request id makes a repeated send (after a crash) the same message.
	if err := d.prompt(ctx, session, fmt.Sprintf("idea-%s-%d", t.name, t.prompts+1), text); err != nil {
		return err
	}
	return c.setPhase(ctx, t, phaseWorking, "the agent is working in its dsh session on "+where, map[string]any{
		"session": session, "vm": t.vm, "prompts": t.prompts + 1, "promptCursor": st.Cursor,
	})
}

// maxConflicts is how often a task's agent is asked to rebase before the
// task fails.
const maxConflicts = 3

// resolveConflict asks the task's agent, in its session, to rebase the pull
// request onto the latest main; the task goes back to Working and through
// the gate again with the new commit.
func (c *Controller) resolveConflict(ctx context.Context, t taskView, number int64) error {
	conflicts, _, _ := unstructured.NestedInt64(t.obj.Object, "status", "conflicts")
	if conflicts >= maxConflicts {
		return c.fail(ctx, t, fmt.Sprintf("pull request #%d still conflicts with main after %d rebases; not merged", number, conflicts))
	}
	if t.session == "" {
		return c.fail(ctx, t, fmt.Sprintf("pull request #%d conflicts with main", number))
	}
	d := c.dshOf(t)
	st, err := d.state(ctx, t.session)
	if errors.Is(err, errDshNotReady) {
		return nil
	}
	if err != nil {
		return err
	}
	text := fmt.Sprintf(`Pull request #%d can no longer be merged: other work was merged into main meanwhile and it conflicts.
Update branch %s:
1. git fetch origin && git rebase origin/main
2. Resolve every conflict so both the work already on main and this issue's change are kept.
3. Run the tests with: npm test
4. git push --force-with-lease
Do not open a new pull request; the existing one follows the branch. Reply when it is pushed.`, number, t.branch)
	if err := d.prompt(ctx, t.session, fmt.Sprintf("idea-%s-conflict-%d", t.name, conflicts+1), text); err != nil {
		return err
	}
	_ = c.fj.Comment(ctx, t.repo, t.issue, fmt.Sprintf(
		"Pull request #%d conflicts with main after other work was merged; its agent is rebasing it. (idea task `%s`)", number, t.name))
	return c.setPhase(ctx, t, phaseWorking, fmt.Sprintf("pull request #%d conflicts with main; the agent is rebasing it", number),
		map[string]any{"promptCursor": st.Cursor, "conflicts": conflicts + 1})
}

// waitMessage records why a pending task is waiting, once.
func (c *Controller) waitMessage(ctx context.Context, t taskView, msg string) error {
	if cur, _, _ := unstructured.NestedString(t.obj.Object, "status", "message"); cur == msg {
		return nil
	}
	return c.setPhase(ctx, t, phasePending, msg, nil)
}

// gate merges the pull request only when its tests passed.
func (c *Controller) gate(ctx context.Context, t taskView) error {
	pr, err := c.fj.FindPR(ctx, t.repo, t.branch)
	if err != nil {
		return err
	}
	if pr == nil {
		return c.fail(ctx, t, "the pull request disappeared")
	}
	if pr.Merged {
		c.cleanup(ctx, t)
		return c.setPhase(ctx, t, phaseDone, fmt.Sprintf("pull request #%d merged", pr.Number), nil)
	}
	sha := pr.Head.SHA

	// Tasks run side by side: another task's pull request may have been
	// merged first and this one now conflicts with main. Its agent rebases.
	if pr.State == "open" && !pr.Mergeable && time.Since(t.since) > time.Minute {
		return c.resolveConflict(ctx, t, pr.Number)
	}

	if c.cfg.GateMode == "controller" {
		// Run the tests ourselves in a clean Kata pod and record the result
		// as a commit status, so the decision below reads the same either way.
		if err := c.runGateJob(ctx, t, sha); err != nil {
			return err
		}
	}

	st, err := c.fj.Status(ctx, t.repo, sha)
	if err != nil {
		return err
	}
	switch {
	case st.TotalCount > 0 && st.State == "success":
		if err := c.fj.Merge(ctx, t.repo, pr.Number); err != nil {
			return fmt.Errorf("merge: %w", err)
		}
		_ = c.fj.Comment(ctx, t.repo, t.issue, fmt.Sprintf(
			"Tests passed and pull request #%d was merged. (idea task `%s`)", pr.Number, t.name))
		c.cleanup(ctx, t)
		return c.setPhase(ctx, t, phaseDone, fmt.Sprintf("pull request #%d merged", pr.Number), nil)

	case st.TotalCount > 0 && (st.State == "failure" || st.State == "error"):
		_ = c.fj.Comment(ctx, t.repo, t.issue, fmt.Sprintf(
			"Tests failed on pull request #%d, so it was **not merged**. (idea task `%s`)", pr.Number, t.name))
		return c.fail(ctx, t, fmt.Sprintf("tests failed on pull request #%d; not merged", pr.Number))
	}
	if time.Since(t.since) > 20*time.Minute {
		return c.fail(ctx, t, "no test result within 20 minutes; not merged")
	}
	return nil
}

func (c *Controller) fail(ctx context.Context, t taskView, message string) error {
	c.cleanup(ctx, t)
	return c.setPhase(ctx, t, phaseFailed, message, nil)
}

// cleanup stops what a task runs. Its dsh session stays, as its history.
func (c *Controller) cleanup(ctx context.Context, t taskView) {
	bg := metav1.DeletePropagationBackground
	_ = c.kube.BatchV1().Jobs(c.cfg.WorkNS).Delete(ctx, t.gateJob(), metav1.DeleteOptions{PropagationPolicy: &bg})
	if t.session != "" && t.phase == phaseWorking {
		_ = c.dshOf(t).cancel(ctx, t.session)
	}
}

func podReady(p *corev1.Pod) bool {
	for _, cond := range p.Status.Conditions {
		if cond.Type == corev1.PodReady && cond.Status == corev1.ConditionTrue {
			return true
		}
	}
	return false
}

func ignoreExists(err error) error {
	if apierrors.IsAlreadyExists(err) {
		return nil
	}
	return err
}

// ---------------------------------------------------------------- pods

func restrictedContainer() *corev1.SecurityContext {
	return &corev1.SecurityContext{
		AllowPrivilegeEscalation: ptr(false),
		Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
	}
}

func restrictedPod() *corev1.PodSecurityContext {
	return &corev1.PodSecurityContext{
		RunAsNonRoot:   ptr(true),
		RunAsUser:      ptr(int64(1000)),
		RunAsGroup:     ptr(int64(1000)),
		FSGroup:        ptr(int64(1000)),
		SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
	}
}

// forgejoHost is how pods in the work namespace reach Forgejo.
func (c *Controller) forgejoHost() string {
	return "forgejo-http." + c.cfg.SystemNS + ".svc:3000"
}

// ------------------------------------------------------------ the prompts

func (c *Controller) taskPrompt(t taskView) string {
	return fmt.Sprintf(`You are an autonomous software engineer. This workspace is the project %q.

Repository: %s (Forgejo, http://%s/%s.git)
Issue #%d: %s

%s

Do exactly this:
1. If this directory is not a Git checkout yet, clone the repository into it: git clone http://%s/%s.git .
   Git already has credentials for this server; never print or write tokens.
2. Start from the latest main, without leftovers from earlier tasks:
   git fetch origin && git reset --hard && git clean -fdx && git checkout -B %s origin/main
3. Implement what the issue asks, including tests for it. Follow the issue literally, even if it asks for something that makes a test fail.
4. Run the tests with: npm test
5. Commit your work with a clear message and push the branch: git push --force-with-lease -u origin %s
6. Open the pull request with the forgejo_pull_request tool: repo %q, head %q, title %q, body "Closes #%d".
7. Reply with the pull request URL and whether the tests passed.

Do not open more than one pull request, and do not open issues: other agents work on those.`,
		t.project(), t.repo, c.forgejoHost(), t.repo, t.issue, t.title, t.body,
		c.forgejoHost(), t.repo, t.branch, t.branch, t.repo, t.branch,
		fmt.Sprintf("%s (#%d)", t.title, t.issue), t.issue)
}

// retryPrompt continues the same session after a failed attempt.
func (c *Controller) retryPrompt(t taskView) string {
	note := ""
	if i := strings.LastIndex(t.body, retryMarker); i >= 0 {
		note = strings.TrimSpace(t.body[i+len(retryMarker):])
	}
	msg := fmt.Sprintf(`The previous attempt at issue #%d did not end in a merged pull request (%s).
Try again: the steps from the first message still apply (start from the latest main on branch %s, push it, open or update the pull request with forgejo_pull_request).`,
		t.issue, t.message(), t.branch)
	if note != "" {
		msg += "\n\nInstruction from the owner:\n" + note
	}
	return msg
}

func (t taskView) message() string {
	m, _, _ := unstructured.NestedString(t.obj.Object, "status", "message")
	if m == "" {
		return "no reason recorded"
	}
	return m
}

// ------------------------------------------------- tests run by the controller

// runGateJob runs the repository's tests for one commit in a clean Kata pod
// and records the outcome as a commit status. Used when GATE_MODE=controller.
func (c *Controller) runGateJob(ctx context.Context, t taskView, sha string) error {
	jobs := c.kube.BatchV1().Jobs(c.cfg.WorkNS)
	job, err := jobs.Get(ctx, t.gateJob(), metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		labels := map[string]string{
			"idea.dev/role":                "worker",
			"idea.dev/task":                t.name,
			"app.kubernetes.io/managed-by": "idea-controller",
		}
		script := fmt.Sprintf(`set -eu
git clone -q "http://%s/%s.git" /tmp/src
cd /tmp/src
git checkout -q %s
npm test`, c.forgejoHost(), t.repo, sha)
		job = &batchv1.Job{
			ObjectMeta: metav1.ObjectMeta{Name: t.gateJob(), Labels: labels,
				Annotations: map[string]string{"idea.dev/sha": sha}},
			Spec: batchv1.JobSpec{
				BackoffLimit:          ptr(int32(0)),
				ActiveDeadlineSeconds: ptr(int64(600)),
				Template: corev1.PodTemplateSpec{
					ObjectMeta: metav1.ObjectMeta{Labels: labels},
					Spec: corev1.PodSpec{
						RuntimeClassName:             ptr("kata"),
						RestartPolicy:                corev1.RestartPolicyNever,
						AutomountServiceAccountToken: ptr(false),
						EnableServiceLinks:           ptr(false),
						SecurityContext:              restrictedPod(),
						Containers: []corev1.Container{{
							Name:            "tests",
							Image:           c.cfg.WorkerImage,
							Command:         []string{"/bin/bash", "-c", script},
							SecurityContext: restrictedContainer(),
							Resources: corev1.ResourceRequirements{
								Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("250m"), corev1.ResourceMemory: resource.MustParse("512Mi")},
								Limits:   corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("1Gi")},
							},
						}},
					},
				},
			},
		}
		if _, err := jobs.Create(ctx, job, metav1.CreateOptions{}); ignoreExists(err) != nil {
			return fmt.Errorf("gate job: %w", err)
		}
		return c.fj.SetStatus(ctx, t.repo, sha, "pending", gateContext, "tests are running in a clean VM")
	}
	if err != nil {
		return err
	}
	if job.Annotations["idea.dev/sha"] != sha {
		// The branch moved: test the new commit instead.
		bg := metav1.DeletePropagationBackground
		return jobs.Delete(ctx, t.gateJob(), metav1.DeleteOptions{PropagationPolicy: &bg})
	}
	switch {
	case job.Status.Succeeded > 0:
		return c.fj.SetStatus(ctx, t.repo, sha, "success", gateContext, "tests passed in a clean VM")
	case job.Status.Failed > 0:
		return c.fj.SetStatus(ctx, t.repo, sha, "failure", gateContext, "tests failed in a clean VM")
	}
	return nil
}
