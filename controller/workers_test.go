package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	autoscalingv1 "k8s.io/api/autoscaling/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	k8stesting "k8s.io/client-go/testing"
)

func TestIsWorkerVM(t *testing.T) {
	for name, want := range map[string]bool{
		"idea-worker-0":   true,
		"idea-worker-12":  true,
		"idea-worker-01":  false,
		"idea-worker--1":  false,
		"idea-worker-":    false,
		"idea-worker-1a":  false,
		"idea-worker-+1":  false,
		"idea-dsh":        false,
		"x-idea-worker-1": false,
		"":                false,
	} {
		if got := isWorkerVM(name); got != want {
			t.Errorf("isWorkerVM(%q) = %v", name, got)
		}
	}
}

func TestPick(t *testing.T) {
	p := &workerPool{c: &Controller{cfg: Config{WorkerSlots: 2}}}
	vms := []workerVM{{Name: "w0", Ready: true}, {Name: "w1", Ready: true}, {Name: "w2", Ready: false}}
	cases := []struct {
		name   string
		vms    []workerVM
		active map[string]int
		want   string
	}{
		{"first when equal", vms, map[string]int{}, "w0"},
		{"least busy", vms, map[string]int{"w0": 1}, "w1"},
		{"full VM skipped", vms, map[string]int{"w0": 2, "w1": 1}, "w1"},
		{"not ready skipped", vms, map[string]int{"w0": 2, "w1": 2}, ""},
		{"over the slots", vms, map[string]int{"w0": 5, "w1": 3}, ""},
		{"no VMs", nil, nil, ""},
	}
	for _, tc := range cases {
		if got := p.pick(tc.vms, tc.active); got != tc.want {
			t.Errorf("%s: pick = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func rl(cpu, mem string) corev1.ResourceList {
	out := corev1.ResourceList{}
	if cpu != "" {
		out[corev1.ResourceCPU] = resource.MustParse(cpu)
	}
	if mem != "" {
		out[corev1.ResourceMemory] = resource.MustParse(mem)
	}
	return out
}

func TestPodRequests(t *testing.T) {
	spec := &corev1.PodSpec{
		Containers: []corev1.Container{
			{Resources: corev1.ResourceRequirements{Requests: rl("500m", "1Gi")}},
			{Resources: corev1.ResourceRequirements{Requests: rl("250m", "")}},
		},
		InitContainers: []corev1.Container{
			{Resources: corev1.ResourceRequirements{Requests: rl("100m", "4Gi")}}, // larger memory wins
		},
		Overhead: rl("100m", "256Mi"),
	}
	got := podRequests(spec)
	if got.Cpu().MilliValue() != 850 {
		t.Errorf("cpu = %s", got.Cpu())
	}
	if got.Memory().Value() != 4<<30+256<<20 {
		t.Errorf("memory = %s", got.Memory())
	}
	if len(podRequests(&corev1.PodSpec{})) != 0 {
		t.Error("an empty pod requests nothing")
	}
}

func TestRoomFor(t *testing.T) {
	alloc := rl("4", "8Gi")
	cases := []struct {
		name string
		used corev1.ResourceList
		want corev1.ResourceList
		ok   bool
	}{
		{"empty node", nil, rl("2", "4Gi"), true},
		{"exactly full", rl("2", "4Gi"), rl("2", "4Gi"), true},
		{"cpu short", rl("3", "1Gi"), rl("2", "1Gi"), false},
		{"memory short", rl("1", "7Gi"), rl("1", "2Gi"), false},
		{"nothing wanted", rl("4", "8Gi"), corev1.ResourceList{}, true},
	}
	for _, tc := range cases {
		if got := roomFor(alloc, tc.used, tc.want); got != tc.ok {
			t.Errorf("%s: roomFor = %v", tc.name, got)
		}
	}
	// roomFor must not change what it is given.
	if alloc.Cpu().String() != "4" {
		t.Errorf("allocatable changed: %s", alloc.Cpu())
	}
}

func TestAddTo(t *testing.T) {
	m := map[string]corev1.ResourceList{}
	addTo(m, "n1", rl("1", "1Gi"))
	addTo(m, "n1", rl("500m", ""))
	n1 := m["n1"]
	if n1.Cpu().MilliValue() != 1500 || n1.Memory().Value() != 1<<30 {
		t.Fatalf("sum = %v", m["n1"])
	}
}

func readyNode(name string) *corev1.Node {
	return &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Status: corev1.NodeStatus{
			Allocatable: rl("4", "8Gi"),
			Conditions:  []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}},
		},
	}
}

func TestNodeUsable(t *testing.T) {
	notReady := readyNode("a")
	notReady.Status.Conditions[0].Status = corev1.ConditionFalse
	cordoned := readyNode("b")
	cordoned.Spec.Unschedulable = true
	tainted := readyNode("c")
	tainted.Spec.Taints = []corev1.Taint{{Key: "k", Effect: corev1.TaintEffectNoSchedule}}
	draining := readyNode("d")
	draining.Spec.Taints = []corev1.Taint{{Key: "k", Effect: corev1.TaintEffectNoExecute}}
	preferred := readyNode("e")
	preferred.Spec.Taints = []corev1.Taint{{Key: "k", Effect: corev1.TaintEffectPreferNoSchedule}}
	noConditions := readyNode("f")
	noConditions.Status.Conditions = nil
	for _, tc := range []struct {
		n    *corev1.Node
		want bool
	}{
		{readyNode("ok"), true}, {notReady, false}, {cordoned, false}, {tainted, false},
		{draining, false}, {preferred, true}, {noConditions, false},
	} {
		if got := nodeUsable(tc.n); got != tc.want {
			t.Errorf("node %s: usable = %v", tc.n.Name, got)
		}
	}
}

func TestUnschedulable(t *testing.T) {
	p := &corev1.Pod{Status: corev1.PodStatus{Conditions: []corev1.PodCondition{
		{Type: corev1.PodScheduled, Status: corev1.ConditionFalse, Reason: corev1.PodReasonUnschedulable},
	}}}
	if unschedulable(p) == "" {
		t.Error("unschedulable pod not reported")
	}
	p.Status.Conditions[0].Reason = "SchedulingGated"
	if unschedulable(p) != "" {
		t.Error("only Unschedulable counts")
	}
	if unschedulable(&corev1.Pod{}) != "" {
		t.Error("a pod without conditions")
	}
}

func TestReserveAndTeamBusy(t *testing.T) {
	p := newWorkerPool(&Controller{})
	p.teamLoad = map[string]int{"w0": 2}
	for range maxReserved {
		if !p.reserve("w1") {
			t.Fatal("reserve refused below the limit")
		}
	}
	if p.reserve("w1") {
		t.Fatal("reserve allowed above the limit")
	}
	busy := p.teamBusy()
	if busy["w0"] != 2 || busy["w1"] != maxReserved {
		t.Fatalf("teamBusy = %v", busy)
	}
	// Expired placements no longer hold a slot, nor count against the limit.
	for i := range p.reserved {
		p.reserved[i].when = time.Now().Add(-reserveMax - time.Second)
	}
	if busy := p.teamBusy(); busy["w1"] != 0 {
		t.Fatalf("expired reservations still counted: %v", busy)
	}
	if !p.reserve("w1") {
		t.Fatal("expired reservations still block")
	}
}

func TestNodePorts(t *testing.T) {
	svc := func(name string, port int32) *corev1.Service {
		s := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: testWorkNS, Name: name}}
		if port != 0 {
			s.Spec.Ports = []corev1.ServicePort{{NodePort: port}}
		}
		return s
	}
	e := newEnv(t, svc("idea-worker-0-external", 30001), svc("idea-worker-1-external", 30002),
		svc("idea-dsh-external", 30000), svc("idea-worker-2", 30003), svc("idea-worker-3-external", 0))
	got := e.c.workers.nodePorts(t.Context())
	if len(got) != 2 || got["idea-worker-0"] != 30001 || got["idea-worker-1"] != 30002 {
		t.Fatalf("nodePorts = %v", got)
	}
}

func TestTaskNameAndView(t *testing.T) {
	if got := taskName("idea/Shop", 12); got != "shop-issue-12" {
		t.Errorf("taskName = %q", got)
	}
	created := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	u := taskObj(5, nil)
	u.SetCreationTimestamp(metav1.NewTime(created))
	v := viewOf(u)
	if v.phase != phasePending || v.branch != "idea/issue-5" || !v.since.Equal(created) || v.project() != "shop" || v.gateJob() != "g-shop-issue-5" {
		t.Errorf("fresh view = %+v", v)
	}
	if v.message() != "no reason recorded" {
		t.Errorf("message = %q", v.message())
	}
	_ = unstructured.SetNestedField(u.Object, phaseStarting, "status", "phase")
	_ = unstructured.SetNestedField(u.Object, "2026-03-01T00:00:00Z", "status", "phaseSince")
	v = viewOf(u)
	if v.phase != phasePending || v.since.Format(time.RFC3339) != "2026-03-01T00:00:00Z" {
		t.Errorf("older phase name: %+v", v)
	}
}

func TestNormalizeCode(t *testing.T) {
	for in, want := range map[string]string{
		" ABCD-efgh ": "abcdefgh",
		"ab cd-ef":    "abcdef",
		"\tabc\n":     "abc",
		"":            "",
	} {
		if got := normalizeCode(in); got != want {
			t.Errorf("normalizeCode(%q) = %q", in, got)
		}
	}
}

// workerEnv is a machine with two ready worker VMs on one node with room.
func workerEnv(t *testing.T, objs ...runtime.Object) (e *testEnv, scaled *int32) {
	t.Helper()
	podOf := func(name string) *corev1.Pod {
		return &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Namespace: testWorkNS, Name: name, Labels: map[string]string{"idea.dev/agent": "worker"}},
			Status:     corev1.PodStatus{Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}},
		}
	}
	set := &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Namespace: testWorkNS, Name: workerSet},
		Spec: appsv1.StatefulSetSpec{Template: corev1.PodTemplateSpec{Spec: corev1.PodSpec{
			Containers: []corev1.Container{{Resources: corev1.ResourceRequirements{Requests: rl("1", "2Gi")}}},
		}}},
	}
	team := secret(testWorkNS, teamSecret, map[string]string{"token": "team-token"})
	e = newEnv(t, append(objs, podOf("idea-worker-0"), podOf("idea-worker-1"), set, readyNode("n1"), team)...)
	replicas := int32(2)
	scaled = new(int32)
	// The fake clientset has no scale subresource.
	e.kube.PrependReactor("get", "statefulsets", func(a k8stesting.Action) (bool, runtime.Object, error) {
		if a.GetSubresource() != "scale" {
			return false, nil, nil
		}
		return true, &autoscalingv1.Scale{Spec: autoscalingv1.ScaleSpec{Replicas: replicas}}, nil
	})
	e.kube.PrependReactor("update", "statefulsets", func(a k8stesting.Action) (bool, runtime.Object, error) {
		if a.GetSubresource() != "scale" {
			return false, nil, nil
		}
		s := a.(k8stesting.UpdateAction).GetObject().(*autoscalingv1.Scale)
		*scaled = s.Spec.Replicas
		return true, s, nil
	})
	return e, scaled
}

func TestTeamPlacement(t *testing.T) {
	working := taskObj(1, map[string]any{"phase": phaseWorking, "vm": "idea-worker-0", "session": "s"})
	e, scaled := workerEnv(t, working)
	place := func(auth string) (int, map[string]string) {
		w := serve(http.HandlerFunc(e.c.handleTeamPlacement), "POST", "/team/placement", auth, "", "")
		var out map[string]string
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	if code, _ := place(""); code != 401 {
		t.Fatalf("no token: %d", code)
	}
	if code, _ := place("Bearer wrong"); code != 401 {
		t.Fatalf("wrong token: %d", code)
	}
	if w := serve(http.HandlerFunc(e.c.handleTeamPlacement), "GET", "/team/placement", "Bearer team-token", "", ""); w.Code != 405 {
		t.Fatalf("GET: %d", w.Code)
	}
	// Two slots per VM; idea-worker-0 has a working task.
	var got []string
	for range 3 {
		code, out := place("Bearer team-token")
		if code != 200 {
			t.Fatalf("placement: %d %v", code, out)
		}
		got = append(got, out["vm"])
	}
	if strings.Join(got, ",") != "idea-worker-1,idea-worker-0,idea-worker-1" {
		t.Fatalf("placements = %v", got)
	}
	// Every slot is taken: a VM is added, since the node has room for one.
	code, out := place("Bearer team-token")
	if code != 503 || out["wait"] != "starting worker VM idea-worker-2" || *scaled != 3 {
		t.Fatalf("full: %d %v scaled=%d", code, out, *scaled)
	}
	// Right after adding one, the pool waits before adding another.
	if code, out := place("Bearer team-token"); code != 503 || out["wait"] != "waiting for a worker VM" {
		t.Fatalf("again: %d %v", code, out)
	}
}

func TestGrowWithoutRoom(t *testing.T) {
	e, scaled := workerEnv(t)
	// The node is full.
	hog := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: "other", Name: "hog"},
		Spec: corev1.PodSpec{NodeName: "n1", Containers: []corev1.Container{
			{Resources: corev1.ResourceRequirements{Requests: rl("3500m", "1Gi")}},
		}},
	}
	if _, err := e.kube.CoreV1().Pods("other").Create(t.Context(), hog, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	vms, replicas, err := e.c.workers.list(t.Context())
	if err != nil || len(vms) != 2 || replicas != 2 || !vms[0].Ready || vms[0].Phase != "Running" {
		t.Fatalf("list = %+v %d %v", vms, replicas, err)
	}
	msg := e.c.workers.grow(t.Context(), vms, replicas)
	if !strings.HasPrefix(msg, "waiting for a free worker VM: no node has 1 CPU") || *scaled != 0 {
		t.Fatalf("grow = %q scaled=%d", msg, *scaled)
	}
	if e.c.workers.Note() == "" {
		t.Fatal("the reason is not kept for the status page")
	}
	// At the most VMs, nothing is added either.
	e.c.cfg.MaxWorkers = 2
	if msg := e.c.workers.grow(t.Context(), vms, replicas); !strings.Contains(msg, "all 2 worker VMs are busy") {
		t.Fatalf("grow at max = %q", msg)
	}
	// A VM that is not up yet is waited for.
	vms[1] = workerVM{Name: "idea-worker-1", Phase: "Starting"}
	if msg := e.c.workers.grow(t.Context(), vms, replicas); msg != "waiting for worker VM idea-worker-1 to start" {
		t.Fatalf("grow starting = %q", msg)
	}
}
