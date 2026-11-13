package main

// Projects: one idea runs work for several repositories. A Project resource
// names a repository in the Forgejo organisation; the controller keeps that
// repository, its webhook and the worker's access in place, and takes issues
// from every project.
//
//	Project "shop" ──▶ Forgejo idea/shop ──issues──▶ Tasks
//
// A project is created from the dsh plugin (POST /api/v1/projects) or as a
// manifest. Deleting the resource stops new tasks; the repository stays.

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

var projectGVR = schema.GroupVersionResource{Group: "idea.dev", Version: "v1alpha1", Resource: "projects"}

// projectName is also the repository name, so it follows both rule sets.
var projectName = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]{0,38}[a-z0-9])?$`)

type project struct {
	obj         *unstructured.Unstructured
	Name        string `json:"name"`
	Repo        string `json:"repo"` // org/name in Forgejo
	Description string `json:"description,omitempty"`
	Seed        string `json:"seed,omitempty"`
	Ready       bool   `json:"ready"`
	Message     string `json:"message,omitempty"`
	URL         string `json:"url"`
}

func (c *Controller) projectOf(u *unstructured.Unstructured) project {
	p := project{obj: u, Name: u.GetName()}
	p.Repo = c.cfg.Org + "/" + p.Name
	p.Description, _, _ = unstructured.NestedString(u.Object, "spec", "description")
	p.Seed, _, _ = unstructured.NestedString(u.Object, "spec", "seed")
	p.Ready, _, _ = unstructured.NestedBool(u.Object, "status", "ready")
	p.Message, _, _ = unstructured.NestedString(u.Object, "status", "message")
	p.URL = "https://" + c.cfg.Host + "/git/" + p.Repo
	return p
}

func (c *Controller) listProjects(ctx context.Context) ([]project, error) {
	list, err := c.dyn.Resource(projectGVR).Namespace(c.cfg.SystemNS).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]project, 0, len(list.Items))
	for i := range list.Items {
		out = append(out, c.projectOf(&list.Items[i]))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// projectForRepo returns the project that owns a Forgejo repository, if any.
func (c *Controller) projectForRepo(ctx context.Context, fullName string) (*project, error) {
	org, name, ok := strings.Cut(fullName, "/")
	if !ok || org != c.cfg.Org || !projectName.MatchString(name) {
		return nil, nil
	}
	u, err := c.dyn.Resource(projectGVR).Namespace(c.cfg.SystemNS).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	p := c.projectOf(u)
	return &p, nil
}

func (c *Controller) createProject(ctx context.Context, name, description string) (project, error) {
	obj := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "idea.dev/v1alpha1",
		"kind":       "Project",
		"metadata":   map[string]any{"name": name, "namespace": c.cfg.SystemNS},
		"spec":       map[string]any{"description": description},
	}}
	u, err := c.dyn.Resource(projectGVR).Namespace(c.cfg.SystemNS).Create(ctx, obj, metav1.CreateOptions{})
	if err != nil {
		return project{}, err
	}
	slog.Info("project created", "project", name)
	return c.projectOf(u), nil
}

// reconcileProject keeps one project's repository as declared: created (and
// seeded once, when the project names an example), the worker as a
// collaborator, the webhook in place.
func (c *Controller) reconcileProject(ctx context.Context, p project) error {
	org, name := c.cfg.Org, p.Name
	repo, err := c.fj.EnsureRepo(ctx, org, name)
	if err != nil {
		return fmt.Errorf("repo: %w", err)
	}
	if repo.Empty && p.Seed != "" {
		dir, err := c.seedDir(p.Seed)
		if err != nil {
			return err
		}
		files, err := readSeed(dir)
		if err != nil {
			return fmt.Errorf("seed files: %w", err)
		}
		if err := c.fj.Seed(ctx, org, name, files); err != nil {
			return fmt.Errorf("seed: %w", err)
		}
		slog.Info("repository seeded", "repo", org+"/"+name, "files", len(files))
	}
	if err := c.fj.EnsureCollaborator(ctx, org, name, workerUser); err != nil {
		return fmt.Errorf("collaborator: %w", err)
	}
	created, err := c.fj.EnsureWebhook(ctx, org, name, c.cfg.WebhookTarget, c.cfg.WebhookSecret)
	if err != nil {
		return fmt.Errorf("webhook: %w", err)
	}
	if created {
		slog.Info("webhook created", "repo", org+"/"+name)
	}
	return nil
}

// seedDir resolves an example name to its directory in the image.
func (c *Controller) seedDir(seed string) (string, error) {
	if !projectName.MatchString(seed) {
		return "", fmt.Errorf("invalid seed %q", seed)
	}
	dir := filepath.Join(c.cfg.ExamplesDir, seed)
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return "", fmt.Errorf("no example named %q", seed)
	}
	return dir, nil
}

// setProjectStatus records the outcome of the last reconcile, writing only on change.
func (c *Controller) setProjectStatus(ctx context.Context, p project, ready bool, message string) {
	if p.Ready == ready && p.Message == message {
		return
	}
	obj := p.obj.DeepCopy()
	_ = unstructured.SetNestedField(obj.Object, ready, "status", "ready")
	_ = unstructured.SetNestedField(obj.Object, message, "status", "message")
	if _, err := c.dyn.Resource(projectGVR).Namespace(c.cfg.SystemNS).UpdateStatus(ctx, obj, metav1.UpdateOptions{}); err != nil {
		slog.Warn("project status", "project", p.Name, "err", err.Error())
	}
}
