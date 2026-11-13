// idea controller: turns a Forgejo issue into a merged pull request.
//
//	issue opened ──webhook──▶ Task ──▶ work VM ──▶ main agent delegates
//	                                   ──▶ pull request ──▶ tests ──▶ merge
//
// Everything it needs to remember is in the Task resource's status (and, for
// "one task per issue" and history, in PostgreSQL). Nothing is kept in
// memory, so the controller can be restarted at any point.
package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

type Config struct {
	ForgejoURL    string // in-cluster base URL of Forgejo
	AdminUser     string
	AdminPass     string
	WebhookSecret string
	WebhookTarget string // URL Forgejo calls for issue events
	Org           string // Forgejo organisation holding every project's repository
	ExamplesDir   string // example repositories a project can be seeded from
	Host          string // name the machine answers to (install page, IDEA_HOST)
	PluginSource  string // how dsh installs the idea plugin (shown on the setup page)
	SystemNS      string
	WorkNS        string
	WorkerImage   string
	MainImage     string
	GateMode      string // "actions": wait for a Forgejo Actions status; "controller": run the tests ourselves
	MaxActive     int
	DatabaseURL   string
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		slog.Error("missing environment variable", "name", key)
		os.Exit(1)
	}
	return v
}

func loadConfig() Config {
	max, _ := strconv.Atoi(env("MAX_ACTIVE_TASKS", "1"))
	if max < 1 {
		max = 1
	}
	db := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(env("DB_USER", "idea"), mustEnv("DB_PASSWORD")),
		Host:   env("DB_HOST", "idea-postgres:5432"),
		Path:   "/" + env("DB_NAME", "idea"),
	}
	return Config{
		ForgejoURL:    env("FORGEJO_URL", "http://forgejo-http:3000"),
		AdminUser:     mustEnv("FORGEJO_ADMIN_USER"),
		AdminPass:     mustEnv("FORGEJO_ADMIN_PASSWORD"),
		WebhookSecret: mustEnv("WEBHOOK_SECRET"),
		WebhookTarget: env("WEBHOOK_TARGET", "http://idea-controller.idea-system.svc:8080/webhook/forgejo"),
		Org:           env("FORGEJO_ORG", "idea"),
		ExamplesDir:   env("EXAMPLES_DIR", "/opt/idea/examples"),
		Host:          env("IDEA_HOST", "idea.internal"),
		PluginSource:  env("PLUGIN_SOURCE", "github:popododo0720/Idea#path:/plugins/idea"),
		SystemNS:      env("SYSTEM_NAMESPACE", "idea-system"),
		WorkNS:        env("WORK_NAMESPACE", "idea-work"),
		WorkerImage:   mustEnv("WORKER_IMAGE"),
		MainImage:     mustEnv("MAIN_IMAGE"),
		GateMode:      env("GATE_MODE", "actions"),
		MaxActive:     max,
		DatabaseURL:   db.String() + "?sslmode=disable",
	}
}

type Controller struct {
	cfg   Config
	kube  kubernetes.Interface
	dyn   dynamic.Interface
	fj    *Forgejo
	store *Store
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, nil)))
	cfg := loadConfig()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	rc, err := rest.InClusterConfig()
	if err != nil {
		slog.Error("kubernetes config", "err", err)
		os.Exit(1)
	}
	c := &Controller{
		cfg:  cfg,
		kube: kubernetes.NewForConfigOrDie(rc),
		dyn:  dynamic.NewForConfigOrDie(rc),
		fj:   NewForgejo(cfg.ForgejoURL, cfg.AdminUser, cfg.AdminPass),
	}

	// PostgreSQL may still be starting: keep trying.
	for {
		c.store, err = NewStore(ctx, cfg.DatabaseURL)
		if err == nil {
			break
		}
		slog.Warn("database not ready", "err", err.Error())
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
	mux.HandleFunc("/webhook/forgejo", c.handleWebhook)
	srv := &http.Server{Addr: ":8080", Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("http server", "err", err)
			os.Exit(1)
		}
	}()

	// Setup page for the owner (HTTPS, NodePort): see setup.go.
	setup, err := c.setupServer(ctx)
	if err != nil {
		slog.Error("setup server", "err", err)
		os.Exit(1)
	}
	go func() {
		if err := setup.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
			slog.Error("setup server", "err", err)
			os.Exit(1)
		}
	}()

	go c.loop(ctx, "forgejo-state", 30*time.Second, c.reconcileForgejo)
	go c.loop(ctx, "issue-sweep", 60*time.Second, c.sweepIssues)
	go c.loop(ctx, "tasks", 5*time.Second, c.reconcileTasks)

	slog.Info("controller started", "org", cfg.Org, "host", cfg.Host, "gate", cfg.GateMode)
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdown)
	_ = setup.Shutdown(shutdown)
}

func (c *Controller) loop(ctx context.Context, name string, every time.Duration, fn func(context.Context) error) {
	for {
		if err := fn(ctx); err != nil && ctx.Err() == nil {
			slog.Warn("loop error", "loop", name, "err", err.Error())
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
	}
}

// ---------------------------------------------------------------- webhook

type issueEvent struct {
	Action string `json:"action"`
	Issue  struct {
		Number int64  `json:"number"`
		Title  string `json:"title"`
		Body   string `json:"body"`
	} `json:"issue"`
	Repository struct {
		FullName string `json:"full_name"`
	} `json:"repository"`
}

func (c *Controller) handleWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	if err != nil {
		http.Error(w, "read error", http.StatusBadRequest)
		return
	}
	// The body must be signed with the shared secret (HMAC-SHA256, hex).
	sig := r.Header.Get("X-Forgejo-Signature")
	if sig == "" {
		sig = r.Header.Get("X-Gitea-Signature")
	}
	mac := hmac.New(sha256.New, []byte(c.cfg.WebhookSecret))
	mac.Write(body)
	want := hex.EncodeToString(mac.Sum(nil))
	if sig == "" || !hmac.Equal([]byte(sig), []byte(want)) {
		slog.Warn("webhook rejected: bad signature")
		http.Error(w, "bad signature", http.StatusUnauthorized)
		return
	}
	event := r.Header.Get("X-Forgejo-Event")
	if event == "" {
		event = r.Header.Get("X-Gitea-Event")
	}
	if event != "issues" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var ev issueEvent
	if err := json.Unmarshal(body, &ev); err != nil {
		http.Error(w, "bad payload", http.StatusBadRequest)
		return
	}
	if ev.Action != "opened" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	p, err := c.projectForRepo(r.Context(), ev.Repository.FullName)
	if err != nil {
		slog.Error("webhook project lookup", "err", err)
		http.Error(w, "try again", http.StatusServiceUnavailable)
		return
	}
	if p == nil {
		w.WriteHeader(http.StatusNoContent) // not a project's repository
		return
	}
	if err := c.createTask(r.Context(), ev.Repository.FullName, ev.Issue.Number, ev.Issue.Title, ev.Issue.Body, "webhook"); err != nil {
		slog.Error("create task", "err", err)
		http.Error(w, "could not create task", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

// sweepIssues picks up open issues that have no Task yet (for example because
// the webhook fired while the controller was down).
func (c *Controller) sweepIssues(ctx context.Context) error {
	projects, err := c.listProjects(ctx)
	if err != nil {
		return err
	}
	for _, p := range projects {
		var issues []struct {
			Number int64  `json:"number"`
			Title  string `json:"title"`
			Body   string `json:"body"`
		}
		if err := c.fj.do(ctx, "GET", "/repos/"+p.Repo+"/issues?state=open&type=issues&limit=50", nil, &issues); err != nil {
			if isStatus(err, 404) {
				continue // repository not created yet
			}
			return err
		}
		for _, is := range issues {
			if err := c.createTask(ctx, p.Repo, is.Number, is.Title, is.Body, "sweep"); err != nil {
				return err
			}
		}
	}
	return nil
}

// ---------------------------------------------------------- forgejo state

const (
	workerUser        = "idea-worker"
	workerTokenSecret = "idea-worker-forgejo"
	runnerTokenSecret = "idea-runner-registration"
)

// reconcileForgejo keeps the state inside Forgejo as declared: organisation,
// the worker's account and token, the Actions runner registration token, and
// for every project its repository, webhook and the worker's access.
// Anything deleted by hand comes back.
func (c *Controller) reconcileForgejo(ctx context.Context) error {
	if err := c.fj.Ready(ctx); err != nil {
		return fmt.Errorf("forgejo not ready: %w", err)
	}
	org := c.cfg.Org
	if err := c.fj.EnsureOrg(ctx, org); err != nil {
		return fmt.Errorf("org: %w", err)
	}

	// Worker account and its token. The token cannot be read back from
	// Forgejo, so the Secret is the source: when it is missing, mint a new one.
	secrets := c.kube.CoreV1().Secrets(c.cfg.WorkNS)
	if _, err := secrets.Get(ctx, workerTokenSecret, metav1.GetOptions{}); apierrors.IsNotFound(err) {
		pass := randomHex(24)
		if err := c.fj.EnsureUser(ctx, workerUser, workerUser+"@idea.internal", pass); err != nil {
			return fmt.Errorf("worker user: %w", err)
		}
		token, err := c.fj.As(workerUser, pass).NewToken(ctx, "idea-worker",
			[]string{"write:repository", "write:issue", "read:user"})
		if err != nil {
			return fmt.Errorf("worker token: %w", err)
		}
		_, err = secrets.Create(ctx, &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: workerTokenSecret, Labels: managedLabels()},
			StringData: map[string]string{"token": token},
		}, metav1.CreateOptions{})
		if err != nil {
			return fmt.Errorf("worker token secret: %w", err)
		}
		slog.Info("worker token issued")
	} else if err != nil {
		return err
	}
	if c.cfg.GateMode == "actions" {
		if _, err := secrets.Get(ctx, runnerTokenSecret, metav1.GetOptions{}); apierrors.IsNotFound(err) {
			token, err := c.fj.RunnerToken(ctx)
			if err != nil {
				return fmt.Errorf("runner token: %w", err)
			}
			_, err = secrets.Create(ctx, &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{Name: runnerTokenSecret, Labels: managedLabels()},
				StringData: map[string]string{"token": token},
			}, metav1.CreateOptions{})
			if err != nil {
				return fmt.Errorf("runner token secret: %w", err)
			}
			slog.Info("runner registration token issued")
		}
	}

	projects, err := c.listProjects(ctx)
	if err != nil {
		return fmt.Errorf("projects: %w", err)
	}
	for _, p := range projects {
		if err := c.reconcileProject(ctx, p); err != nil {
			slog.Warn("project", "project", p.Name, "err", err.Error())
			c.setProjectStatus(ctx, p, false, err.Error())
			continue
		}
		c.setProjectStatus(ctx, p, true, "")
	}
	return nil
}

func managedLabels() map[string]string {
	return map[string]string{"app.kubernetes.io/managed-by": "idea-controller"}
}

// readSeed loads every file under dir (paths relative to dir).
func readSeed(dir string) ([]SeedFile, error) {
	var out []SeedFile
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		if strings.HasPrefix(rel, "node_modules/") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		out = append(out, SeedFile{Path: filepath.ToSlash(rel), Content: data})
		return nil
	})
	return out, err
}
