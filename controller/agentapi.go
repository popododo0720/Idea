package main

// The machine's own API for its agents: the orchestrator in the agent dsh
// (plugins/orchestrator) creates projects and reads the machine's state here.
// It is served on the in-cluster port, takes the machine's team token as
// bearer (Secret idea-team, which only the machine's VMs mount), and only the
// agent dsh may reach this port (deploy/apps/dsh network policy).
//
//	POST /agent/projects  {"name", "description", "import"}  -> project
//	GET  /agent/status    -> projects, worker VMs, tasks

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
)

// agentAuthorized checks the team token; it answers 401 itself when not.
func (c *Controller) agentAuthorized(w http.ResponseWriter, r *http.Request) bool {
	want, err := c.teamToken(r.Context())
	if err != nil {
		writeError(w, 500, "team token unavailable")
		return false
	}
	got, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	a, b := sha256.Sum256([]byte(got)), sha256.Sum256([]byte(want))
	if want == "" || got == "" || subtle.ConstantTimeCompare(a[:], b[:]) != 1 {
		w.WriteHeader(http.StatusUnauthorized)
		return false
	}
	return true
}

func (c *Controller) agentMux(mux *http.ServeMux) {
	mux.HandleFunc("POST /agent/projects", func(w http.ResponseWriter, r *http.Request) {
		if !c.agentAuthorized(w, r) {
			return
		}
		var in struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Import      string `json:"import"`
		}
		if err := readBody(r, &in); err != nil {
			writeError(w, 400, err.Error())
			return
		}
		in.Name = strings.ToLower(strings.TrimSpace(in.Name))
		in.Import = strings.TrimSpace(in.Import)
		if !projectName.MatchString(in.Name) {
			writeError(w, 400, "name: lowercase letters, digits and '-', up to 40 characters")
			return
		}
		if len(in.Description) > 500 {
			writeError(w, 400, "description is too long")
			return
		}
		if in.Import != "" && (len(in.Import) > 300 || !importURL.MatchString(in.Import)) {
			writeError(w, 400, "import: a public https Git URL without credentials, e.g. https://github.com/owner/repo.git")
			return
		}
		p, err := c.createProject(r.Context(), in.Name, strings.TrimSpace(in.Description), "", in.Import)
		if apierrors.IsAlreadyExists(err) {
			writeError(w, 409, "a project with that name exists")
			return
		}
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		writeJSON(w, 201, p)
	})

	mux.HandleFunc("GET /agent/status", func(w http.ResponseWriter, r *http.Request) {
		if !c.agentAuthorized(w, r) {
			return
		}
		ctx := r.Context()
		projects, err := c.listProjects(ctx)
		if err != nil {
			writeError(w, 500, "projects: "+err.Error())
			return
		}
		tasks, err := c.taskRows(ctx)
		if err != nil {
			writeError(w, 500, "tasks: "+err.Error())
			return
		}
		vms, _, err := c.workers.list(ctx)
		if err != nil {
			writeError(w, 500, "worker VMs: "+err.Error())
			return
		}
		team := c.workers.teamBusy()
		for i := range vms {
			vms[i].Active = team[vms[i].Name]
			for _, t := range tasks {
				if t.VM == vms[i].Name && t.Phase == phaseWorking {
					vms[i].Active++
				}
			}
		}
		writeJSON(w, 200, map[string]any{
			"projects": projects, "tasks": tasks, "workers": vms,
			"workerSlots": c.cfg.WorkerSlots, "maxWorkers": c.cfg.MaxWorkers, "note": c.workers.note,
		})
	})
}
