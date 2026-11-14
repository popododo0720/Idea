package main

// Agent teams across VMs (plugins/team). A team lead's dsh asks here where to
// start a teammate; the answer is a worker VM with a free slot, the same slots
// tasks use. That is all the controller does for teams: the lead's dsh then
// opens the teammate's session on that VM itself, and teammates send their
// messages to each other's VMs directly.
//
// POST /team/placement (in-cluster port, the machine's team token as bearer)
//   200 {"vm": "idea-worker-1"}
//   503 {"wait": "why"}  (a VM is being added, or there is no room)
//
// Every worker VM reports its team members at GET /idea-team/load; the pool
// counts the working ones against the VM's slots, like working tasks.

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	// Shared token the VMs' team plugins present to each other and here.
	teamSecret = "idea-team"
	// A placement holds a slot until the VM's own report includes the new
	// teammate (the next report after this long), or at most reserveMax.
	reserveSettle = 30 * time.Second
	reserveMax    = 2 * time.Minute
	// At most this many placements wait for their teammate at once.
	maxReserved = 8
)

type reservation struct {
	vm   string
	when time.Time
}

// teamBusy is the slots team members use on each VM, including placements
// whose teammate is not reported yet.
func (p *workerPool) teamBusy() map[string]int {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := map[string]int{}
	for vm, n := range p.teamLoad {
		out[vm] += n
	}
	for _, r := range p.reserved {
		if time.Since(r.when) < reserveMax {
			out[r.vm]++
		}
	}
	return out
}

// reserve holds a slot on vm for a teammate being started; false when too
// many placements are outstanding.
func (p *workerPool) reserve(vm string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := 0
	for _, r := range p.reserved {
		if time.Since(r.when) < reserveMax {
			n++
		}
	}
	if n >= maxReserved {
		return false
	}
	p.reserved = append(p.reserved, reservation{vm: vm, when: time.Now()})
	return true
}

// refreshTeamLoad asks every ready worker VM how many of its team members are
// working. A VM that does not answer keeps its last count.
func (p *workerPool) refreshTeamLoad(ctx context.Context, vms []workerVM) {
	token, err := p.c.teamToken(ctx)
	if err != nil || token == "" {
		return
	}
	load := map[string]int{}
	failed := map[string]bool{}
	for _, vm := range vms {
		if !vm.Ready {
			continue
		}
		n, err := p.memberCount(ctx, vm.Name, token)
		if err != nil {
			slog.Debug("team load", "vm", vm.Name, "err", err.Error())
			failed[vm.Name] = true
			continue
		}
		load[vm.Name] = n
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for vm := range failed {
		if n, ok := p.teamLoad[vm]; ok {
			load[vm] = n
		}
	}
	p.teamLoad = load
	kept := p.reserved[:0]
	for _, r := range p.reserved {
		if time.Since(r.when) < reserveSettle {
			kept = append(kept, r)
		}
	}
	p.reserved = kept
}

func (p *workerPool) memberCount(ctx context.Context, vm, token string) (int, error) {
	hc, err := p.client(vm).httpClient(ctx)
	if err != nil {
		return 0, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+workerAuthority(vm, p.c.cfg.WorkNS)+"/idea-team/load", nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := hc.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	var out struct {
		Members []struct {
			Running bool `json:"running"`
		} `json:"members"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out); err != nil {
		return 0, err
	}
	// A teammate takes a slot while it works; an idle one waits for messages.
	n := 0
	for _, m := range out.Members {
		if m.Running {
			n++
		}
	}
	return n, nil
}

// teamToken reads the machine's team token ("" before it exists).
func (c *Controller) teamToken(ctx context.Context) (string, error) {
	s, err := c.kube.CoreV1().Secrets(c.cfg.WorkNS).Get(ctx, teamSecret, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return string(s.Data["token"]), nil
}

// taskBusy is the working task sessions on each worker VM.
func (c *Controller) taskBusy(ctx context.Context) (map[string]int, error) {
	list, err := c.dyn.Resource(taskGVR).Namespace(c.cfg.SystemNS).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := map[string]int{}
	for i := range list.Items {
		t := viewOf(&list.Items[i])
		if t.phase == phaseWorking && t.vm != "" {
			out[t.vm]++
		}
	}
	return out, nil
}

func (c *Controller) handleTeamPlacement(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	ctx := r.Context()
	want, err := c.teamToken(ctx)
	if err != nil {
		writeError(w, 500, "team token unavailable")
		return
	}
	got, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	a, b := sha256.Sum256([]byte(got)), sha256.Sum256([]byte(want))
	if want == "" || got == "" || subtle.ConstantTimeCompare(a[:], b[:]) != 1 {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	vms, replicas, err := c.workers.list(ctx)
	if err != nil {
		writeError(w, 500, "worker VMs: "+err.Error())
		return
	}
	busy, err := c.taskBusy(ctx)
	if err != nil {
		writeError(w, 500, "tasks: "+err.Error())
		return
	}
	for vm, n := range c.workers.teamBusy() {
		busy[vm] += n
	}
	vm := c.workers.pick(vms, busy)
	if vm == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"wait": c.workers.grow(ctx, vms, replicas)})
		return
	}
	if !c.workers.reserve(vm) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"wait": "too many teammates are starting at once"})
		return
	}
	slog.Info("teammate placed", "vm", vm)
	writeJSON(w, 200, map[string]string{"vm": vm})
}

// ensureTokenSecret creates a random shared token Secret once.
func (c *Controller) ensureTokenSecret(ctx context.Context, name string) error {
	api := c.kube.CoreV1().Secrets(c.cfg.WorkNS)
	_, err := api.Get(ctx, name, metav1.GetOptions{})
	if err == nil || !apierrors.IsNotFound(err) {
		return err
	}
	_, err = api.Create(ctx, &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: name, Labels: managedLabels()},
		Data:       map[string][]byte{"token": []byte(randomHex(32))},
	}, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		return nil
	}
	return err
}
