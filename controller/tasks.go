package main

// The Task state machine. One pass looks at every Task and moves it at most
// one step. Each step is idempotent: it derives what to do from the Task's
// status and from what exists in the cluster, so a pass can be repeated or
// interrupted at any point.
//
//	Pending ─▶ WorkerStarting ─▶ Working ─▶ Gate ─▶ Done
//	                 └──────────────┴─────────┴────▶ Failed

import (
	"context"
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
	"k8s.io/apimachinery/pkg/util/intstr"
)

var taskGVR = schema.GroupVersionResource{Group: "idea.dev", Version: "v1alpha1", Resource: "tasks"}

const (
	phasePending  = "Pending"
	phaseStarting = "WorkerStarting"
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
	obj    *unstructured.Unstructured
	name   string
	repo   string
	issue  int64
	title  string
	body   string
	phase  string
	since  time.Time // when the current phase began
	pr     int64
	sha    string
	branch string
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
	if s, _, _ := unstructured.NestedString(u.Object, "status", "phaseSince"); s != "" {
		t.since, _ = time.Parse(time.RFC3339, s)
	}
	if t.since.IsZero() {
		t.since = u.GetCreationTimestamp().Time
	}
	t.branch = fmt.Sprintf("idea/issue-%d", t.issue)
	return t
}

func (t taskView) worker() string { return "w-" + t.name }
func (t taskView) mainJob() string { return "m-" + t.name }
func (t taskView) gateJob() string { return "g-" + t.name }

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
	status["worker"] = t.worker()
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

func (c *Controller) reconcileTasks(ctx context.Context) error {
	list, err := c.dyn.Resource(taskGVR).Namespace(c.cfg.SystemNS).List(ctx, metav1.ListOptions{})
	if err != nil {
		return err
	}
	active := 0
	for i := range list.Items {
		switch viewOf(&list.Items[i]).phase {
		case phaseStarting, phaseWorking, phaseGate:
			active++
		}
	}
	for i := range list.Items {
		t := viewOf(&list.Items[i])
		if t.phase == phasePending {
			if active >= c.cfg.MaxActive {
				continue // wait for a free slot
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
		if err := c.ensureWorker(ctx, t); err != nil {
			return err
		}
		return c.setPhase(ctx, t, phaseStarting, "work VM requested", nil)

	case phaseStarting:
		pod, err := c.kube.CoreV1().Pods(c.cfg.WorkNS).Get(ctx, t.worker(), metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			return c.ensureWorker(ctx, t) // deleted by hand: bring it back
		}
		if err != nil {
			return err
		}
		if !podReady(pod) {
			if time.Since(t.since) > 10*time.Minute {
				return c.fail(ctx, t, "the work VM did not become ready in 10 minutes")
			}
			return nil
		}
		if err := c.ensureMainJob(ctx, t); err != nil {
			return err
		}
		return c.setPhase(ctx, t, phaseWorking, "main agent is delegating to "+t.worker(), nil)

	case phaseWorking:
		job, err := c.kube.BatchV1().Jobs(c.cfg.SystemNS).Get(ctx, t.mainJob(), metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			return c.ensureMainJob(ctx, t)
		}
		if err != nil {
			return err
		}
		if job.Status.Succeeded == 0 && job.Status.Failed == 0 {
			return nil // still running
		}
		// What counts is whether a pull request exists, not what the agent said.
		pr, err := c.fj.FindPR(ctx, t.repo, t.branch)
		if err != nil {
			return err
		}
		if pr == nil {
			return c.fail(ctx, t, "the worker finished without opening a pull request")
		}
		return c.setPhase(ctx, t, phaseGate, fmt.Sprintf("pull request #%d opened; waiting for tests", pr.Number),
			map[string]any{"pullRequest": pr.Number, "headSHA": pr.Head.SHA, "pullRequestURL": pr.URL})

	case phaseGate:
		return c.gate(ctx, t)
	}
	return nil
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

// cleanup removes everything a task created in the cluster.
func (c *Controller) cleanup(ctx context.Context, t taskView) {
	bg := metav1.DeletePropagationBackground
	del := metav1.DeleteOptions{PropagationPolicy: &bg}
	_ = c.kube.CoreV1().Pods(c.cfg.WorkNS).Delete(ctx, t.worker(), del)
	_ = c.kube.CoreV1().Services(c.cfg.WorkNS).Delete(ctx, t.worker(), del)
	_ = c.kube.BatchV1().Jobs(c.cfg.WorkNS).Delete(ctx, t.gateJob(), del)
	_ = c.kube.BatchV1().Jobs(c.cfg.SystemNS).Delete(ctx, t.mainJob(), del)
	_ = c.kube.CoreV1().ConfigMaps(c.cfg.SystemNS).Delete(ctx, t.mainJob(), del)
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

// ------------------------------------------------------------- work VM

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

func secretEnv(name, secret, key string, optional bool) corev1.EnvVar {
	return corev1.EnvVar{Name: name, ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
		LocalObjectReference: corev1.LocalObjectReference{Name: secret}, Key: key, Optional: ptr(optional)}}}
}

// forgejoHost is how pods in the work namespace reach Forgejo.
func (c *Controller) forgejoHost() string {
	return "forgejo-http." + c.cfg.SystemNS + ".svc:3000"
}

func (c *Controller) ensureWorker(ctx context.Context, t taskView) error {
	labels := map[string]string{
		"idea.dev/role":                "worker", // selects the worker network policy
		"idea.dev/task":                t.name,
		"app.kubernetes.io/managed-by": "idea-controller",
	}
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: t.worker(), Labels: labels},
		Spec: corev1.PodSpec{
			RuntimeClassName:             ptr("kata"),
			AutomountServiceAccountToken: ptr(false),
			EnableServiceLinks:           ptr(false),
			RestartPolicy:                corev1.RestartPolicyNever,
			SecurityContext:              restrictedPod(),
			Containers: []corev1.Container{{
				Name:  "desktop",
				Image: c.cfg.WorkerImage,
				Env: []corev1.EnvVar{
					{Name: "IDEA_PATH_PREFIX", Value: "/vm/" + t.worker()},
					secretEnv("DEEPSEEK_API_KEY", "idea-model-keys", "DEEPSEEK_API_KEY", true),
					secretEnv("CLAUDE_CODE_OAUTH_TOKEN", "idea-model-keys", "CLAUDE_CODE_OAUTH_TOKEN", true),
					secretEnv("FORGEJO_TOKEN", workerTokenSecret, "token", false),
					{Name: "FORGEJO_API", Value: "http://" + c.forgejoHost() + "/api/v1"},
					{Name: "IDEA_REPO", Value: t.repo},
					{Name: "IDEA_BRANCH", Value: t.branch},
					// $(FORGEJO_TOKEN) is expanded by Kubernetes inside the pod.
					{Name: "IDEA_REPO_URL", Value: "http://" + workerUser + ":$(FORGEJO_TOKEN)@" + c.forgejoHost() + "/" + t.repo + ".git"},
				},
				Ports: []corev1.ContainerPort{
					{Name: "novnc", ContainerPort: 6080},
					{Name: "ssh", ContainerPort: 2222},
				},
				SecurityContext: restrictedContainer(),
				Resources: corev1.ResourceRequirements{
					Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("500m"), corev1.ResourceMemory: resource.MustParse("2Gi")},
					Limits:   corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("2"), corev1.ResourceMemory: resource.MustParse("2Gi")},
				},
				ReadinessProbe: &corev1.Probe{
					ProbeHandler:  corev1.ProbeHandler{TCPSocket: &corev1.TCPSocketAction{Port: intstr.FromString("ssh")}},
					PeriodSeconds: 3,
				},
				VolumeMounts: []corev1.VolumeMount{
					{Name: "shm", MountPath: "/dev/shm"},
					{Name: "ssh-authorized", MountPath: "/etc/idea/authorized_keys", ReadOnly: true},
				},
			}},
			Volumes: []corev1.Volume{
				{Name: "shm", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{
					Medium: corev1.StorageMediumMemory, SizeLimit: ptr(resource.MustParse("1Gi"))}}},
				{Name: "ssh-authorized", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{
					SecretName: "idea-worker-ssh-pub"}}},
			},
		},
	}
	if _, err := c.kube.CoreV1().Pods(c.cfg.WorkNS).Create(ctx, pod, metav1.CreateOptions{}); ignoreExists(err) != nil {
		return fmt.Errorf("work pod: %w", err)
	}
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: t.worker(), Labels: labels},
		Spec: corev1.ServiceSpec{
			Selector: map[string]string{"idea.dev/task": t.name, "idea.dev/role": "worker"},
			Ports: []corev1.ServicePort{
				{Name: "ssh", Port: 2222, TargetPort: intstr.FromString("ssh")},
				{Name: "novnc", Port: 6080, TargetPort: intstr.FromString("novnc")},
			},
		},
	}
	if _, err := c.kube.CoreV1().Services(c.cfg.WorkNS).Create(ctx, svc, metav1.CreateOptions{}); ignoreExists(err) != nil {
		return fmt.Errorf("work service: %w", err)
	}
	return nil
}

// ---------------------------------------------------------- main agent job

func (c *Controller) workerTask(t taskView) string {
	return fmt.Sprintf(`You are an autonomous software engineer working inside a disposable VM.

Repository: %s
Issue #%d: %s

%s

Do exactly this:
1. Clone the repository: git clone "$IDEA_REPO_URL" ~/work/repo   (the URL in that environment variable already carries credentials; never print it)
2. In ~/work/repo run: git config user.name idea-worker && git config user.email idea-worker@idea.internal
3. Create the branch %s from main.
4. Implement what the issue asks, including tests for it. Follow the issue literally, even if it asks for something that makes a test fail.
5. Run the tests with: npm test
6. Commit your work with a clear message and push the branch: git push -u origin %s
7. Open the pull request by running exactly: idea-pr "%s (#%d)" "Closes #%d"
8. Reply with the pull request URL and whether the tests passed.

Do not change anything outside ~/work/repo. Do not open more than one pull request.`,
		t.repo, t.issue, t.title, t.body, t.branch, t.branch, strings.ReplaceAll(t.title, `"`, `'`), t.issue, t.issue)
}

func (c *Controller) ensureMainJob(ctx context.Context, t taskView) error {
	prompt := fmt.Sprintf(`Use the worker_run tool exactly once, with worker "%s", timeoutSeconds 1500, and the task below passed through unchanged. Do not do the task yourself and do not use any other tool. When the tool returns, reply with a short summary of what the worker reported.

TASK FOR THE WORKER:
%s`, t.worker(), c.workerTask(t))

	labels := map[string]string{
		"idea.dev/role":                "main", // allowed to SSH into work pods
		"idea.dev/task":                t.name,
		"app.kubernetes.io/managed-by": "idea-controller",
	}
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: t.mainJob(), Labels: labels},
		Data:       map[string]string{"prompt.txt": prompt},
	}
	if _, err := c.kube.CoreV1().ConfigMaps(c.cfg.SystemNS).Create(ctx, cm, metav1.CreateOptions{}); ignoreExists(err) != nil {
		return fmt.Errorf("prompt: %w", err)
	}
	job := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{Name: t.mainJob(), Labels: labels},
		Spec: batchv1.JobSpec{
			BackoffLimit:          ptr(int32(0)),
			ActiveDeadlineSeconds: ptr(int64(1800)),
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					RestartPolicy:                corev1.RestartPolicyNever,
					AutomountServiceAccountToken: ptr(false),
					EnableServiceLinks:           ptr(false),
					SecurityContext:              restrictedPod(),
					Containers: []corev1.Container{{
						Name:  "main",
						Image: c.cfg.MainImage,
						// The task is read from a file on stdin, never from the command line.
						Command: []string{"/bin/bash", "-c",
							"cd ~/work && exec dsh headless --json --approval-policy never - < /task/prompt.txt"},
						Env:             []corev1.EnvVar{secretEnv("DEEPSEEK_API_KEY", "idea-model-keys", "DEEPSEEK_API_KEY", false)},
						SecurityContext: restrictedContainer(),
						Resources: corev1.ResourceRequirements{
							Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("100m"), corev1.ResourceMemory: resource.MustParse("256Mi")},
							Limits:   corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("1Gi")},
						},
						VolumeMounts: []corev1.VolumeMount{
							{Name: "ssh", MountPath: "/etc/idea/ssh", ReadOnly: true},
							{Name: "task", MountPath: "/task", ReadOnly: true},
						},
					}},
					Volumes: []corev1.Volume{
						{Name: "ssh", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{
							SecretName: "idea-worker-ssh", DefaultMode: ptr(int32(0o400)),
							Items: []corev1.KeyToPath{{Key: "privateKey", Path: "privateKey"}}}}},
						{Name: "task", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{
							LocalObjectReference: corev1.LocalObjectReference{Name: t.mainJob()}}}},
					},
				},
			},
		},
	}
	if _, err := c.kube.BatchV1().Jobs(c.cfg.SystemNS).Create(ctx, job, metav1.CreateOptions{}); ignoreExists(err) != nil {
		return fmt.Errorf("main job: %w", err)
	}
	return nil
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
