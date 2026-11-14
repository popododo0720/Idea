package main

// Worker VMs (deploy/apps/workers): more agent dsh instances, each a Kata VM
// with its own volume. Tasks run on them as sessions, up to WorkerSlots at
// once per VM. While a task waits for a slot, the pool adds a VM when the
// cluster has room for one (its pod requests fit on a schedulable node) and
// MaxWorkers is not reached. Adding nodes to the cluster therefore adds room
// without any setting. VMs are not taken down when idle: they keep their
// checkouts and take the next tasks.
//
// The agent dsh (idea-dsh) itself takes no new tasks: it is where the owner
// (or an agent working for the owner) plans work and files it as issues.

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	autoscalingv1 "k8s.io/api/autoscaling/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
)

const (
	workerSet     = "idea-worker"
	workerService = "idea-worker"
	// Shared token the worker VMs present to idea-dsh to pull the models.
	syncSecret = "idea-sync"
	// Wait at least this long between two added VMs, so the scheduler and
	// the node's numbers catch up with the last one.
	growPause = 30 * time.Second
)

func workerAuthority(vm, ns string) string {
	return vm + "." + workerService + "." + ns + ".svc:4443"
}

// workerExternal is the NodePort Service of one VM, for the owner's dsh.
func workerExternal(vm string) string { return vm + "-external" }

type workerPool struct {
	c       *Controller
	mu      sync.Mutex
	clients map[string]*dshClient
	grown   time.Time
	note    string // why no VM was added last time, for the status page
	// Team members on each VM (team.go), from the VMs' own reports.
	teamLoad map[string]int
	reserved []reservation
	placeMu  sync.Mutex // serializes team placements (team.go)
}

func newWorkerPool(c *Controller) *workerPool {
	return &workerPool{c: c, clients: map[string]*dshClient{}}
}

// client returns the dsh client of a VM ("" is the agent dsh).
func (p *workerPool) client(vm string) *dshClient {
	if vm == "" {
		return p.c.dsh
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	d, ok := p.clients[vm]
	if !ok {
		d = p.c.newDshClient(vm)
		p.clients[vm] = d
	}
	return d
}

type workerVM struct {
	Name     string `json:"name"`
	Ready    bool   `json:"ready"`
	Phase    string `json:"phase"` // Running, Starting, or why it cannot start
	Active   int    `json:"active"`
	NodePort int32  `json:"nodePort,omitempty"`
}

// list returns the worker VMs the StatefulSet should be running, in order.
func (p *workerPool) list(ctx context.Context) ([]workerVM, int32, error) {
	ns := p.c.cfg.WorkNS
	sc, err := p.c.kube.AppsV1().StatefulSets(ns).GetScale(ctx, workerSet, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil, 0, nil // not deployed (yet)
	}
	if err != nil {
		return nil, 0, err
	}
	pods, err := p.c.kube.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{LabelSelector: "idea.dev/agent=worker"})
	if err != nil {
		return nil, 0, err
	}
	byName := map[string]*corev1.Pod{}
	for i := range pods.Items {
		byName[pods.Items[i].Name] = &pods.Items[i]
	}
	var out []workerVM
	for i := int32(0); i < sc.Spec.Replicas; i++ {
		vm := workerVM{Name: fmt.Sprintf("%s-%d", workerSet, i), Phase: "Starting"}
		if pod := byName[vm.Name]; pod != nil && pod.DeletionTimestamp == nil {
			vm.Ready = podReady(pod)
			if vm.Ready {
				vm.Phase = "Running"
			} else if why := unschedulable(pod); why != "" {
				vm.Phase = why
			}
		}
		out = append(out, vm)
	}
	return out, sc.Spec.Replicas, nil
}

// unschedulable reports why a pod has no node, or "".
func unschedulable(p *corev1.Pod) string {
	for _, c := range p.Status.Conditions {
		if c.Type == corev1.PodScheduled && c.Status == corev1.ConditionFalse && c.Reason == corev1.PodReasonUnschedulable {
			return "no room on the nodes"
		}
	}
	return ""
}

// pick returns a ready VM with a free slot (the least busy), or "".
func (p *workerPool) pick(vms []workerVM, active map[string]int) string {
	best, bestN := "", 0
	for _, vm := range vms {
		n := active[vm.Name]
		if !vm.Ready || n >= p.c.cfg.WorkerSlots {
			continue
		}
		if best == "" || n < bestN {
			best, bestN = vm.Name, n
		}
	}
	return best
}

// grow adds one VM when there is room for it. It returns what a waiting task
// is waiting for.
func (p *workerPool) grow(ctx context.Context, vms []workerVM, replicas int32) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, vm := range vms {
		if !vm.Ready {
			if vm.Phase == "Starting" {
				return "waiting for worker VM " + vm.Name + " to start"
			}
			return "worker VM " + vm.Name + ": " + vm.Phase
		}
	}
	if int(replicas) >= p.c.cfg.MaxWorkers {
		p.note = fmt.Sprintf("all %d worker VMs are busy (the most this machine runs)", replicas)
		return p.note
	}
	if time.Since(p.grown) < growPause {
		return "waiting for a worker VM"
	}
	fits, why, err := p.fits(ctx)
	if err != nil {
		slog.Warn("worker capacity", "err", err.Error())
		return "waiting for a worker VM"
	}
	if !fits {
		p.note = why
		return "waiting for a free worker VM: " + why
	}
	_, err = p.c.kube.AppsV1().StatefulSets(p.c.cfg.WorkNS).UpdateScale(ctx, workerSet, &autoscalingv1.Scale{
		ObjectMeta: metav1.ObjectMeta{Name: workerSet, Namespace: p.c.cfg.WorkNS},
		Spec:       autoscalingv1.ScaleSpec{Replicas: replicas + 1},
	}, metav1.UpdateOptions{})
	if err != nil {
		slog.Warn("add worker VM", "err", err.Error())
		return "waiting for a worker VM"
	}
	p.grown, p.note = time.Now(), ""
	name := fmt.Sprintf("%s-%d", workerSet, replicas)
	slog.Info("worker VM added", "vm", name)
	return "starting worker VM " + name
}

// fits reports whether one more worker VM fits on a schedulable node: its
// requests (CPU, memory) against the node's allocatable minus what the pods
// already there request.
func (p *workerPool) fits(ctx context.Context) (bool, string, error) {
	set, err := p.c.kube.AppsV1().StatefulSets(p.c.cfg.WorkNS).Get(ctx, workerSet, metav1.GetOptions{})
	if err != nil {
		return false, "", err
	}
	want := podRequests(&set.Spec.Template.Spec)
	// The VM's own overhead is added to the pod when it is created; count it now.
	if rc := set.Spec.Template.Spec.RuntimeClassName; rc != nil {
		cls, err := p.c.kube.NodeV1().RuntimeClasses().Get(ctx, *rc, metav1.GetOptions{})
		if err != nil {
			return false, "", err
		}
		if cls.Overhead != nil {
			for r, q := range cls.Overhead.PodFixed {
				v := want[r]
				v.Add(q)
				want[r] = v
			}
		}
	}
	nodes, err := p.c.kube.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return false, "", err
	}
	pods, err := p.c.kube.CoreV1().Pods("").List(ctx, metav1.ListOptions{
		FieldSelector: "status.phase!=Succeeded,status.phase!=Failed",
	})
	if err != nil {
		return false, "", err
	}
	used := map[string]corev1.ResourceList{}
	for i := range pods.Items {
		pod := &pods.Items[i]
		if pod.Spec.NodeName == "" {
			continue
		}
		addTo(used, pod.Spec.NodeName, podRequests(&pod.Spec))
	}
	for i := range nodes.Items {
		n := &nodes.Items[i]
		if !nodeUsable(n) {
			continue
		}
		if roomFor(n.Status.Allocatable, used[n.Name], want) {
			return true, "", nil
		}
	}
	return false, fmt.Sprintf("no node has %s CPU and %s memory free for another worker VM",
		want.Cpu().String(), want.Memory().String()), nil
}

// podRequests is what the scheduler counts for a pod: the sum of its
// containers' requests (or each init container's, if larger) plus overhead.
func podRequests(spec *corev1.PodSpec) corev1.ResourceList {
	sum := corev1.ResourceList{}
	for _, c := range spec.Containers {
		for _, r := range []corev1.ResourceName{corev1.ResourceCPU, corev1.ResourceMemory} {
			if q, ok := c.Resources.Requests[r]; ok {
				v := sum[r]
				v.Add(q)
				sum[r] = v
			}
		}
	}
	for _, c := range spec.InitContainers {
		for _, r := range []corev1.ResourceName{corev1.ResourceCPU, corev1.ResourceMemory} {
			if q, ok := c.Resources.Requests[r]; ok && q.Cmp(sum[r]) > 0 {
				sum[r] = q.DeepCopy()
			}
		}
	}
	for r, q := range spec.Overhead {
		v := sum[r]
		v.Add(q)
		sum[r] = v
	}
	return sum
}

func addTo(m map[string]corev1.ResourceList, node string, r corev1.ResourceList) {
	cur := m[node]
	if cur == nil {
		cur = corev1.ResourceList{}
	}
	for k, q := range r {
		v := cur[k]
		v.Add(q)
		cur[k] = v
	}
	m[node] = cur
}

func roomFor(alloc, used, want corev1.ResourceList) bool {
	for _, r := range []corev1.ResourceName{corev1.ResourceCPU, corev1.ResourceMemory} {
		free := alloc[r].DeepCopy()
		u := used[r]
		free.Sub(u)
		if free.Cmp(want[r]) < 0 {
			return false
		}
	}
	return true
}

// nodeUsable: Ready, schedulable, and no taint that keeps pods off.
func nodeUsable(n *corev1.Node) bool {
	if n.Spec.Unschedulable {
		return false
	}
	ready := false
	for _, c := range n.Status.Conditions {
		if c.Type == corev1.NodeReady && c.Status == corev1.ConditionTrue {
			ready = true
		}
	}
	if !ready {
		return false
	}
	for _, t := range n.Spec.Taints {
		if t.Effect == corev1.TaintEffectNoSchedule || t.Effect == corev1.TaintEffectNoExecute {
			return false
		}
	}
	return true
}

// reconcile keeps the per-VM NodePort Services (for the owner's dsh) and
// the shared model sync and team tokens in place, and counts team members.
func (p *workerPool) reconcile(ctx context.Context) error {
	if err := p.c.ensureTokenSecret(ctx, syncSecret); err != nil {
		return fmt.Errorf("sync token: %w", err)
	}
	if err := p.c.ensureTokenSecret(ctx, teamSecret); err != nil {
		return fmt.Errorf("team token: %w", err)
	}
	vms, _, err := p.list(ctx)
	if err != nil {
		return err
	}
	p.refreshTeamLoad(ctx, vms)
	svcs := p.c.kube.CoreV1().Services(p.c.cfg.WorkNS)
	for _, vm := range vms {
		_, err := svcs.Get(ctx, workerExternal(vm.Name), metav1.GetOptions{})
		if err == nil {
			continue
		}
		if !apierrors.IsNotFound(err) {
			return err
		}
		_, err = svcs.Create(ctx, &corev1.Service{
			ObjectMeta: metav1.ObjectMeta{Name: workerExternal(vm.Name), Labels: managedLabels()},
			Spec: corev1.ServiceSpec{
				Type:     corev1.ServiceTypeNodePort,
				Selector: map[string]string{appsv1.StatefulSetPodNameLabel: vm.Name},
				Ports: []corev1.ServicePort{{
					Name: "dsh", Port: 4443, TargetPort: intstr.FromString("dsh"),
				}},
			},
		}, metav1.CreateOptions{})
		if err != nil && !apierrors.IsAlreadyExists(err) {
			return fmt.Errorf("NodePort for %s: %w", vm.Name, err)
		}
	}
	return nil
}

// nodePorts returns the NodePort of each VM's external Service.
func (p *workerPool) nodePorts(ctx context.Context) map[string]int32 {
	out := map[string]int32{}
	list, err := p.c.kube.CoreV1().Services(p.c.cfg.WorkNS).List(ctx, metav1.ListOptions{})
	if err != nil {
		return out
	}
	for _, s := range list.Items {
		vm, ok := strings.CutSuffix(s.Name, "-external")
		if !ok || !strings.HasPrefix(vm, workerSet+"-") || len(s.Spec.Ports) == 0 {
			continue
		}
		out[vm] = s.Spec.Ports[0].NodePort
	}
	return out
}

// isWorkerVM reports whether name is one of the pool's VM names.
func isWorkerVM(name string) bool {
	n, ok := strings.CutPrefix(name, workerSet+"-")
	if !ok {
		return false
	}
	i, err := strconv.Atoi(n)
	return err == nil && i >= 0 && strconv.Itoa(i) == n
}
