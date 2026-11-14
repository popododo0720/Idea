package main

// The API the dsh "idea" plugin talks to (plugins/idea). It is served next to
// the setup page, over HTTPS on the setup port, under /api/v1/.
//
// Pairing: the owner enters this machine's address and the setup code (from
// the console) in the plugin once. POST /api/v1/pair answers with a device
// token; every other call carries it as "Authorization: Bearer <token>".
// The plugin pins this server's certificate on that first call, so the
// certificate is kept in a Secret and survives restarts.
//
// Tokens are stored hashed in the Secret idea-devices, one entry per paired
// device, and can be revoked from the plugin.

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

const devicesSecret = "idea-devices"

type device struct {
	Name    string `json:"name"`
	Hash    string `json:"hash"` // sha256 of the token's secret part, hex
	Created string `json:"created"`
}

var deviceID = regexp.MustCompile(`^[0-9a-f]{12}$`)

func hashSecret(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func (c *Controller) devices(ctx context.Context) (*corev1.Secret, map[string]device, error) {
	s, err := c.kube.CoreV1().Secrets(c.cfg.SystemNS).Get(ctx, devicesSecret, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil, map[string]device{}, nil
	}
	if err != nil {
		return nil, nil, err
	}
	out := map[string]device{}
	for id, raw := range s.Data {
		var d device
		if json.Unmarshal(raw, &d) == nil && deviceID.MatchString(id) {
			out[id] = d
		}
	}
	return s, out, nil
}

// pairDevice issues a token for a new device: "idea_<id>_<secret>".
func (c *Controller) pairDevice(ctx context.Context, name string) (id, token string, err error) {
	id, secret := randomHex(6), randomHex(32)
	d, _ := json.Marshal(device{Name: name, Hash: hashSecret(secret), Created: time.Now().UTC().Format(time.RFC3339)})
	api := c.kube.CoreV1().Secrets(c.cfg.SystemNS)
	s, _, err := c.devices(ctx)
	if err != nil {
		return "", "", err
	}
	if s == nil {
		_, err = api.Create(ctx, &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: devicesSecret, Labels: managedLabels()},
			Data:       map[string][]byte{id: d},
		}, metav1.CreateOptions{})
	} else {
		if s.Data == nil {
			s.Data = map[string][]byte{}
		}
		s.Data[id] = d
		_, err = api.Update(ctx, s, metav1.UpdateOptions{})
	}
	if err != nil {
		return "", "", err
	}
	return id, "idea_" + id + "_" + secret, nil
}

func (c *Controller) unpairDevice(ctx context.Context, id string) error {
	s, _, err := c.devices(ctx)
	if err != nil || s == nil {
		return err
	}
	if _, ok := s.Data[id]; !ok {
		return nil
	}
	delete(s.Data, id)
	_, err = c.kube.CoreV1().Secrets(c.cfg.SystemNS).Update(ctx, s, metav1.UpdateOptions{})
	return err
}

// authDevice checks the bearer token and returns the device id.
func (c *Controller) authDevice(r *http.Request) (string, bool) {
	tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return "", false
	}
	parts := strings.Split(tok, "_")
	if len(parts) != 3 || parts[0] != "idea" || !deviceID.MatchString(parts[1]) {
		return "", false
	}
	_, devs, err := c.devices(r.Context())
	if err != nil {
		slog.Warn("devices", "err", err.Error())
		return "", false
	}
	d, found := devs[parts[1]]
	want := d.Hash
	if !found {
		want = strings.Repeat("0", 64)
	}
	if subtle.ConstantTimeCompare([]byte(hashSecret(parts[2])), []byte(want)) != 1 || !found {
		return "", false
	}
	return parts[1], true
}

// ------------------------------------------------------------------ views

type taskRow struct {
	Name        string `json:"name"`
	Project     string `json:"project"`
	Issue       int64  `json:"issue"`
	Title       string `json:"title"`
	Phase       string `json:"phase"`
	Message     string `json:"message,omitempty"`
	PullRequest int64  `json:"pullRequest,omitempty"`
	PRURL       string `json:"pullRequestURL,omitempty"`
	IssueURL    string `json:"issueURL"`
	Created     string `json:"created"`
	Since       string `json:"since"`
	VM          string `json:"vm,omitempty"` // worker VM of its session
}

func (c *Controller) taskRows(ctx context.Context) ([]taskRow, error) {
	list, err := c.dyn.Resource(taskGVR).Namespace(c.cfg.SystemNS).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	rows := make([]taskRow, 0, len(list.Items))
	for i := range list.Items {
		t := viewOf(&list.Items[i])
		msg, _, _ := unstructured.NestedString(t.obj.Object, "status", "message")
		prURL, _, _ := unstructured.NestedString(t.obj.Object, "status", "pullRequestURL")
		_, name, _ := strings.Cut(t.repo, "/")
		rows = append(rows, taskRow{
			Name: t.name, Project: name, Issue: t.issue, Title: t.title, Phase: t.phase,
			Message: msg, PullRequest: t.pr, PRURL: prURL,
			IssueURL: fmt.Sprintf("https://%s/git/%s/issues/%d", c.cfg.Host, t.repo, t.issue),
			Created:  t.obj.GetCreationTimestamp().UTC().Format(time.RFC3339),
			Since:    t.since.UTC().Format(time.RFC3339),
			VM:       t.vm,
		})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Created > rows[j].Created })
	return rows, nil
}

// --------------------------------------------------------------- handlers

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func readBody(r *http.Request, v any) error {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		return errors.New("content type must be application/json")
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, 64<<10))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func (c *Controller) apiHandler() http.Handler {
	mux := http.NewServeMux()

	// Pairing is the one call without a token: the setup code stands in.
	mux.HandleFunc("POST /api/v1/pair", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Code   string `json:"code"`
			Device string `json:"device"`
		}
		if err := readBody(r, &in); err != nil {
			writeError(w, 400, err.Error())
			return
		}
		_, ok, err := c.checkCode(r.Context(), in.Code)
		switch {
		case apierrors.IsNotFound(err):
			writeError(w, 409, "this machine has no setup code (not installed from the ISO)")
			return
		case err != nil:
			writeError(w, 503, "could not read the setup code; try again")
			return
		case !ok:
			writeError(w, 401, "wrong setup code")
			return
		}
		name := strings.TrimSpace(in.Device)
		if name == "" || len(name) > 64 {
			name = "dsh"
		}
		id, token, err := c.pairDevice(r.Context(), name)
		if err != nil {
			slog.Warn("pair", "err", err.Error())
			writeError(w, 500, "could not store the device")
			return
		}
		slog.Info("device paired", "device", id, "name", name)
		writeJSON(w, 200, map[string]string{"id": id, "token": token, "host": c.cfg.Host})
	})

	authed := http.NewServeMux()

	authed.HandleFunc("GET /api/v1/status", func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		projects, err := c.listProjects(ctx)
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		tasks, err := c.taskRows(ctx)
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		keys := map[string]bool{"deepseek": false, "claude": false}
		if s, err := c.kube.CoreV1().Secrets(c.cfg.WorkNS).Get(ctx, modelKeysSecret, metav1.GetOptions{}); err == nil {
			keys["deepseek"] = len(s.Data["DEEPSEEK_API_KEY"]) > 0
			keys["claude"] = len(s.Data["CLAUDE_CODE_OAUTH_TOKEN"]) > 0
		}
		writeJSON(w, 200, map[string]any{
			"host": c.cfg.Host, "git": "https://" + c.cfg.Host + "/git/",
			"projects": projects, "tasks": tasks, "keys": keys, "maxActive": c.cfg.MaxActive,
			"workerSlots": c.cfg.WorkerSlots, "maxWorkers": c.cfg.MaxWorkers,
		})
	})

	// The machine's VMs, for the plugin's VM switcher: the agent dsh (where
	// work is planned) and the worker VMs (where tasks run), with the tasks
	// working on each.
	authed.HandleFunc("GET /api/v1/vms", func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		vms, _, err := c.workers.list(ctx)
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		tasks, err := c.taskRows(ctx)
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		ports := c.workers.nodePorts(ctx)
		for i := range vms {
			vms[i].NodePort = ports[vms[i].Name]
			for _, t := range tasks {
				if t.VM == vms[i].Name && t.Phase == phaseWorking {
					vms[i].Active++
				}
			}
		}
		_, err = c.dsh.readyPod(ctx)
		writeJSON(w, 200, map[string]any{
			"main":    map[string]any{"name": "idea-dsh", "ready": err == nil, "nodePort": dshNodePort},
			"workers": vms, "workerSlots": c.cfg.WorkerSlots, "maxWorkers": c.cfg.MaxWorkers,
			"note": c.workers.note,
		})
	})

	authed.HandleFunc("POST /api/v1/projects", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			// Seed names an example repository the project starts from
			// (images/controller examples); tests use it, installs ship none.
			Seed string `json:"seed"`
		}
		if err := readBody(r, &in); err != nil {
			writeError(w, 400, err.Error())
			return
		}
		if in.Seed != "" {
			if _, err := c.seedDir(in.Seed); err != nil {
				writeError(w, 400, "seed: "+err.Error())
				return
			}
		}
		in.Name = strings.ToLower(strings.TrimSpace(in.Name))
		if !projectName.MatchString(in.Name) {
			writeError(w, 400, "name: lowercase letters, digits and '-', up to 40 characters")
			return
		}
		if len(in.Description) > 500 {
			writeError(w, 400, "description is too long")
			return
		}
		p, err := c.createProject(r.Context(), in.Name, strings.TrimSpace(in.Description), in.Seed)
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

	// A new task is an issue in the project's repository: Git stays the record,
	// and the webhook turns it into a Task like any other issue.
	authed.HandleFunc("POST /api/v1/tasks", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Project string `json:"project"`
			Title   string `json:"title"`
			Body    string `json:"body"`
		}
		if err := readBody(r, &in); err != nil {
			writeError(w, 400, err.Error())
			return
		}
		in.Title = strings.TrimSpace(in.Title)
		if in.Title == "" || len(in.Title) > 200 || len(in.Body) > 20000 {
			writeError(w, 400, "title is required (up to 200 characters), body up to 20000")
			return
		}
		p, err := c.projectForRepo(r.Context(), c.cfg.Org+"/"+in.Project)
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		if p == nil {
			writeError(w, 404, "no such project")
			return
		}
		var issue struct {
			Number int64 `json:"number"`
		}
		if err := c.fj.do(r.Context(), "POST", "/repos/"+p.Repo+"/issues",
			map[string]string{"title": in.Title, "body": in.Body}, &issue); err != nil {
			writeError(w, 502, "forgejo: "+err.Error())
			return
		}
		// Do not wait for the webhook: the task shows up in the next listing.
		if err := c.createTask(r.Context(), p.Repo, issue.Number, in.Title, in.Body, "dsh"); err != nil {
			slog.Warn("create task from api", "err", err.Error())
		}
		writeJSON(w, 201, map[string]any{"project": p.Name, "issue": issue.Number, "task": taskName(p.Repo, issue.Number)})
	})

	authed.HandleFunc("GET /api/v1/tasks/{name}", func(w http.ResponseWriter, r *http.Request) {
		t, ok := c.apiTask(w, r)
		if !ok {
			return
		}
		events, err := c.store.Events(r.Context(), t.name, 200)
		if err != nil {
			slog.Warn("task events", "err", err.Error())
		}
		rows, _ := c.taskRows(r.Context())
		var row *taskRow
		for i := range rows {
			if rows[i].Name == t.name {
				row = &rows[i]
			}
		}
		writeJSON(w, 200, map[string]any{"task": row, "body": t.body, "events": events, "session": t.session})
	})

	// Retry a failed task, optionally with an extra instruction. The note is
	// also posted on the issue, so the history stays in Git.
	authed.HandleFunc("POST /api/v1/tasks/{name}/retry", func(w http.ResponseWriter, r *http.Request) {
		t, ok := c.apiTask(w, r)
		if !ok {
			return
		}
		var in struct {
			Note string `json:"note"`
		}
		if err := readBody(r, &in); err != nil {
			writeError(w, 400, err.Error())
			return
		}
		if t.phase != phaseFailed {
			writeError(w, 409, "only a failed task can be retried")
			return
		}
		if len(in.Note) > 20000 {
			writeError(w, 400, "note is too long")
			return
		}
		if err := c.retryTask(r.Context(), t, strings.TrimSpace(in.Note)); err != nil {
			writeError(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]string{"task": t.name, "phase": phasePending})
	})

	authed.HandleFunc("POST /api/v1/tasks/{name}/cancel", func(w http.ResponseWriter, r *http.Request) {
		t, ok := c.apiTask(w, r)
		if !ok {
			return
		}
		switch t.phase {
		case phaseDone, phaseFailed:
			writeError(w, 409, "the task has already ended")
			return
		}
		if err := c.fail(r.Context(), t, "cancelled from dsh"); err != nil {
			writeError(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]string{"task": t.name, "phase": phaseFailed})
	})

	authed.HandleFunc("PUT /api/v1/keys", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			DeepSeek string `json:"deepseek"`
			Claude   string `json:"claude"`
		}
		if err := readBody(r, &in); err != nil {
			writeError(w, 400, err.Error())
			return
		}
		in.DeepSeek, in.Claude = strings.TrimSpace(in.DeepSeek), strings.TrimSpace(in.Claude)
		if in.DeepSeek == "" && in.Claude == "" {
			writeError(w, 400, "nothing to save")
			return
		}
		if len(in.DeepSeek) > 512 || len(in.Claude) > 512 {
			writeError(w, 400, "key is too long")
			return
		}
		if err := c.saveModelKeys(r.Context(), in.DeepSeek, in.Claude); err != nil {
			writeError(w, 500, "could not save the keys")
			return
		}
		slog.Info("model keys saved from dsh")
		// The agent dsh reads the key at start: restart it to pick it up.
		if err := c.restartDsh(r.Context()); err != nil {
			slog.Warn("restart agent dsh", "err", err.Error())
		}
		writeJSON(w, 200, map[string]bool{"saved": true})
	})

	// A dsh for the plugin's view, the agent dsh or a worker VM (?vm=): where
	// it listens (a NodePort on this machine's address), the Host it answers
	// to, and its current login.
	authed.HandleFunc("GET /api/v1/dsh", func(w http.ResponseWriter, r *http.Request) {
		vm := r.URL.Query().Get("vm")
		if vm != "" && vm != "idea-dsh" && !isWorkerVM(vm) {
			writeError(w, 400, "unknown VM")
			return
		}
		if vm == "idea-dsh" {
			vm = ""
		}
		port, authority := int32(dshNodePort), dshAuthority
		if vm != "" {
			port = c.workers.nodePorts(r.Context())[vm]
			if port == 0 {
				writeError(w, 503, "that worker VM is not reachable yet")
				return
			}
			authority = workerAuthority(vm, c.cfg.WorkNS)
		}
		token, err := c.workers.client(vm).login(r.Context())
		if errors.Is(err, errDshNotReady) {
			writeError(w, 503, "the agent dsh is not running yet")
			return
		}
		if err != nil {
			slog.Warn("dsh login", "err", err.Error())
			writeError(w, 502, "could not read the agent dsh login")
			return
		}
		writeJSON(w, 200, map[string]any{
			"port": port, "authority": authority, "login": "/?token=" + token,
		})
	})

	authed.HandleFunc("GET /api/v1/devices", func(w http.ResponseWriter, r *http.Request) {
		_, devs, err := c.devices(r.Context())
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		type row struct {
			ID      string `json:"id"`
			Name    string `json:"name"`
			Created string `json:"created"`
			This    bool   `json:"this"`
		}
		self := r.Header.Get("X-Idea-Device")
		out := []row{}
		for id, d := range devs {
			out = append(out, row{ID: id, Name: d.Name, Created: d.Created, This: id == self})
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Created < out[j].Created })
		writeJSON(w, 200, out)
	})

	authed.HandleFunc("DELETE /api/v1/devices/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !deviceID.MatchString(id) {
			writeError(w, 400, "bad device id")
			return
		}
		if err := c.unpairDevice(r.Context(), id); err != nil {
			writeError(w, 500, err.Error())
			return
		}
		slog.Info("device unpaired", "device", id)
		w.WriteHeader(http.StatusNoContent)
	})

	mux.HandleFunc("/api/v1/", func(w http.ResponseWriter, r *http.Request) {
		id, ok := c.authDevice(r)
		if !ok {
			time.Sleep(200 * time.Millisecond)
			writeError(w, 401, "not paired, or the pairing was revoked")
			return
		}
		r.Header.Set("X-Idea-Device", id)
		authed.ServeHTTP(w, r)
	})
	return mux
}

// apiTask loads the task named in the path.
func (c *Controller) apiTask(w http.ResponseWriter, r *http.Request) (taskView, bool) {
	u, err := c.dyn.Resource(taskGVR).Namespace(c.cfg.SystemNS).Get(r.Context(), r.PathValue("name"), metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		writeError(w, 404, "no such task")
		return taskView{}, false
	}
	if err != nil {
		writeError(w, 500, err.Error())
		return taskView{}, false
	}
	return viewOf(u), true
}

// retryTask starts a failed task again from the beginning: everything it ran
// is removed, the note is added to its instructions, the phase goes back to
// Pending.
func (c *Controller) retryTask(ctx context.Context, t taskView, note string) error {
	c.cleanup(ctx, t)
	if note != "" {
		body := t.body + retryMarker + note
		obj := t.obj.DeepCopy()
		_ = unstructured.SetNestedField(obj.Object, body, "spec", "body")
		u, err := c.dyn.Resource(taskGVR).Namespace(c.cfg.SystemNS).Update(ctx, obj, metav1.UpdateOptions{})
		if err != nil {
			return err
		}
		t = viewOf(u)
		if err := c.fj.Comment(ctx, t.repo, t.issue, "Follow-up instruction (retry from dsh):\n\n"+note); err != nil {
			slog.Warn("retry comment", "err", err.Error())
		}
	}
	for _, k := range []string{"pullRequest", "pullRequestURL", "headSHA"} {
		unstructured.RemoveNestedField(t.obj.Object, "status", k)
	}
	return c.setPhase(ctx, t, phasePending, "retry requested from dsh", nil)
}
