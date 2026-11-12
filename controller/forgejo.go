package main

// A small client for the parts of the Forgejo API the controller needs.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Forgejo struct {
	base string // e.g. http://forgejo-http:3000
	user string
	pass string
	http *http.Client
}

func NewForgejo(base, user, pass string) *Forgejo {
	return &Forgejo{base: strings.TrimRight(base, "/"), user: user, pass: pass,
		http: &http.Client{Timeout: 30 * time.Second}}
}

// As returns a client that authenticates as another user.
func (f *Forgejo) As(user, pass string) *Forgejo {
	c := *f
	c.user, c.pass = user, pass
	return &c
}

type apiError struct {
	Status int
	Body   string
}

func (e *apiError) Error() string { return fmt.Sprintf("forgejo: HTTP %d: %s", e.Status, e.Body) }

func isStatus(err error, code int) bool {
	if e, ok := err.(*apiError); ok {
		return e.Status == code
	}
	return false
}

// do sends a request and decodes a JSON reply into out (if not nil).
func (f *Forgejo) do(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, f.base+"/api/v1"+path, body)
	if err != nil {
		return err
	}
	req.SetBasicAuth(f.user, f.pass)
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := f.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode >= 300 {
		msg := string(data)
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return &apiError{Status: res.StatusCode, Body: msg}
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

func (f *Forgejo) Ready(ctx context.Context) error {
	return f.do(ctx, "GET", "/version", nil, nil)
}

// ---- organisations and repositories

func (f *Forgejo) EnsureOrg(ctx context.Context, org string) error {
	err := f.do(ctx, "GET", "/orgs/"+url.PathEscape(org), nil, nil)
	if err == nil || !isStatus(err, 404) {
		return err
	}
	return f.do(ctx, "POST", "/orgs", map[string]any{"username": org, "visibility": "public"}, nil)
}

type Repo struct {
	FullName string `json:"full_name"`
	Empty    bool   `json:"empty"`
}

// EnsureRepo returns the repository, creating it when missing.
func (f *Forgejo) EnsureRepo(ctx context.Context, org, name string) (*Repo, error) {
	var r Repo
	err := f.do(ctx, "GET", "/repos/"+org+"/"+name, nil, &r)
	if err == nil {
		return &r, nil
	}
	if !isStatus(err, 404) {
		return nil, err
	}
	err = f.do(ctx, "POST", "/orgs/"+org+"/repos", map[string]any{
		"name": name, "default_branch": "main", "auto_init": false, "private": false,
	}, &r)
	if err != nil {
		return nil, err
	}
	r.Empty = true
	return &r, nil
}

type SeedFile struct {
	Path    string
	Content []byte
}

// Seed puts the initial files into an empty repository in one commit.
func (f *Forgejo) Seed(ctx context.Context, org, name string, files []SeedFile) error {
	type op struct {
		Operation string `json:"operation"`
		Path      string `json:"path"`
		Content   string `json:"content"`
	}
	ops := make([]op, 0, len(files))
	for _, s := range files {
		ops = append(ops, op{"create", s.Path, b64(s.Content)})
	}
	return f.do(ctx, "POST", "/repos/"+org+"/"+name+"/contents", map[string]any{
		"files": ops, "message": "Initial example", "new_branch": "main",
		"author":    map[string]string{"name": "idea", "email": "idea@idea.internal"},
		"committer": map[string]string{"name": "idea", "email": "idea@idea.internal"},
	}, nil)
}

// ---- the worker's account

func (f *Forgejo) EnsureUser(ctx context.Context, name, email, pass string) error {
	err := f.do(ctx, "GET", "/users/"+name, nil, nil)
	if err == nil {
		// Existing account: set a password we know so that a token can be minted.
		return f.do(ctx, "PATCH", "/admin/users/"+name, map[string]any{
			"login_name": name, "source_id": 0, "password": pass, "must_change_password": false,
		}, nil)
	}
	if !isStatus(err, 404) {
		return err
	}
	return f.do(ctx, "POST", "/admin/users", map[string]any{
		"username": name, "email": email, "password": pass, "must_change_password": false,
	}, nil)
}

func (f *Forgejo) EnsureCollaborator(ctx context.Context, org, repo, user string) error {
	return f.do(ctx, "PUT", "/repos/"+org+"/"+repo+"/collaborators/"+user,
		map[string]string{"permission": "write"}, nil)
}

// NewToken replaces the named access token of the authenticated user.
func (f *Forgejo) NewToken(ctx context.Context, tokenName string, scopes []string) (string, error) {
	_ = f.do(ctx, "DELETE", "/users/"+f.user+"/tokens/"+tokenName, nil, nil)
	var out struct {
		SHA1 string `json:"sha1"`
	}
	err := f.do(ctx, "POST", "/users/"+f.user+"/tokens",
		map[string]any{"name": tokenName, "scopes": scopes}, &out)
	if err != nil {
		return "", err
	}
	if out.SHA1 == "" {
		return "", fmt.Errorf("forgejo returned an empty token")
	}
	return out.SHA1, nil
}

// ---- webhooks

type hook struct {
	ID     int64             `json:"id"`
	Config map[string]string `json:"config"`
	Active bool              `json:"active"`
}

// EnsureWebhook makes sure the repository delivers issue events to target.
// It reports whether it had to create the hook.
func (f *Forgejo) EnsureWebhook(ctx context.Context, org, repo, target, secret string) (bool, error) {
	var hooks []hook
	if err := f.do(ctx, "GET", "/repos/"+org+"/"+repo+"/hooks", nil, &hooks); err != nil {
		return false, err
	}
	for _, h := range hooks {
		if h.Config["url"] == target && h.Active {
			return false, nil
		}
	}
	err := f.do(ctx, "POST", "/repos/"+org+"/"+repo+"/hooks", map[string]any{
		"type":   "forgejo",
		"active": true,
		"events": []string{"issues"},
		"config": map[string]string{"url": target, "content_type": "json", "secret": secret},
	}, nil)
	return err == nil, err
}

// ---- pull requests, statuses, merging

type PullRequest struct {
	Number int64  `json:"number"`
	State  string `json:"state"`
	Merged bool   `json:"merged"`
	URL    string `json:"html_url"`
	Head   struct {
		Ref string `json:"ref"`
		SHA string `json:"sha"`
	} `json:"head"`
}

// FindPR returns the pull request whose head branch is branch, or nil.
func (f *Forgejo) FindPR(ctx context.Context, repo, branch string) (*PullRequest, error) {
	var prs []PullRequest
	if err := f.do(ctx, "GET", "/repos/"+repo+"/pulls?state=all&limit=50", nil, &prs); err != nil {
		return nil, err
	}
	for i := range prs {
		if prs[i].Head.Ref == branch {
			return &prs[i], nil
		}
	}
	return nil, nil
}

type CombinedStatus struct {
	State      string `json:"state"`
	TotalCount int    `json:"total_count"`
}

func (f *Forgejo) Status(ctx context.Context, repo, sha string) (*CombinedStatus, error) {
	var s CombinedStatus
	err := f.do(ctx, "GET", "/repos/"+repo+"/commits/"+sha+"/status", nil, &s)
	return &s, err
}

func (f *Forgejo) SetStatus(ctx context.Context, repo, sha, state, name, description string) error {
	return f.do(ctx, "POST", "/repos/"+repo+"/statuses/"+sha, map[string]string{
		"state": state, "context": name, "description": description,
	}, nil)
}

func (f *Forgejo) Merge(ctx context.Context, repo string, number int64) error {
	return f.do(ctx, "POST", fmt.Sprintf("/repos/%s/pulls/%d/merge", repo, number), map[string]any{
		"Do": "merge", "delete_branch_after_merge": true,
	}, nil)
}

func (f *Forgejo) Comment(ctx context.Context, repo string, issue int64, body string) error {
	return f.do(ctx, "POST", fmt.Sprintf("/repos/%s/issues/%d/comments", repo, issue),
		map[string]string{"body": body}, nil)
}

// RunnerToken returns a registration token for Forgejo Actions runners.
func (f *Forgejo) RunnerToken(ctx context.Context) (string, error) {
	var out struct {
		Token string `json:"token"`
	}
	err := f.do(ctx, "GET", "/admin/runners/registration-token", nil, &out)
	return out.Token, err
}
