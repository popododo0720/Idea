package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestForgejoDo(t *testing.T) {
	type out struct {
		Name string `json:"name"`
	}
	cases := []struct {
		name     string
		reply    fjReply
		in       any
		wantErr  bool
		wantCode int // apiError status, when an error is expected
		wantBody string
		wantOut  string
	}{
		{name: "decodes JSON", reply: fjReply{Body: `{"name":"x"}`}, wantOut: "x"},
		{name: "created", reply: fjReply{Status: 201, Body: `{"name":"y"}`}, in: map[string]string{"a": "b"}, wantOut: "y"},
		{name: "no content", reply: fjReply{Status: 204}, wantOut: "keep"},
		{name: "not found", reply: fjReply{Status: 404, Body: `{"message":"nope"}`}, wantErr: true, wantCode: 404, wantBody: `{"message":"nope"}`},
		{name: "redirect is an error", reply: fjReply{Status: 304}, wantErr: true, wantCode: 304},
		{name: "long error body is cut", reply: fjReply{Status: 500, Body: strings.Repeat("z", 400)}, wantErr: true, wantCode: 500, wantBody: strings.Repeat("z", 300)},
		{name: "bad JSON", reply: fjReply{Body: `{"name":`}, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeForgejo(t)
			f.mu.Lock()
			f.routes["PUT /thing"] = tc.reply
			f.mu.Unlock()
			v := out{Name: "keep"}
			err := f.client().do(t.Context(), "PUT", "/thing", tc.in, &v)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v", err)
			}
			if tc.wantCode != 0 {
				var ae *apiError
				if !errors.As(err, &ae) || ae.Status != tc.wantCode || (tc.wantBody != "" && ae.Body != tc.wantBody) {
					t.Fatalf("err = %#v", err)
				}
				if !strings.Contains(err.Error(), fmt.Sprintf("HTTP %d", tc.wantCode)) {
					t.Fatalf("message %q", err.Error())
				}
			}
			if !tc.wantErr && v.Name != tc.wantOut {
				t.Fatalf("out = %q, want %q", v.Name, tc.wantOut)
			}
			calls := f.received()
			if len(calls) != 1 || calls[0].User != "admin" {
				t.Fatalf("calls = %+v", calls)
			}
			wantBody := ""
			if tc.in != nil {
				b, _ := json.Marshal(tc.in)
				wantBody = string(b)
			}
			if calls[0].Body != wantBody {
				t.Fatalf("sent %q, want %q", calls[0].Body, wantBody)
			}
		})
	}
}

func TestForgejoDoUnreachable(t *testing.T) {
	f := newFakeForgejo(t)
	c := f.client()
	f.srv.Close()
	err := c.do(t.Context(), "GET", "/version", nil, nil)
	if err == nil || isStatus(err, 404) {
		t.Fatalf("err = %v", err)
	}
	var ae *apiError
	if errors.As(err, &ae) {
		t.Fatal("a connection error is not an HTTP status")
	}
}

func TestIsStatus(t *testing.T) {
	e404 := &apiError{Status: 404, Body: "x"}
	cases := []struct {
		name string
		err  error
		code int
		want bool
	}{
		{"same", e404, 404, true},
		{"other code", e404, 409, false},
		{"wrapped", fmt.Errorf("repo: %w", e404), 404, true},
		{"wrapped twice", fmt.Errorf("a: %w", fmt.Errorf("b: %w", e404)), 404, true},
		{"joined", errors.Join(errors.New("x"), e404), 404, true},
		{"plain error", errors.New("HTTP 404"), 404, false},
		{"nil", nil, 404, false},
	}
	for _, tc := range cases {
		if got := isStatus(tc.err, tc.code); got != tc.want {
			t.Errorf("%s: isStatus = %v", tc.name, got)
		}
	}
}

func TestEnsureOrg(t *testing.T) {
	cases := []struct {
		name    string
		get     int
		post    int
		wantErr bool
		posts   int
	}{
		{"exists", 200, 0, false, 0},
		{"created on 404", 404, 201, false, 1},
		{"create fails", 404, 422, true, 1},
		{"other error is not a 404", 500, 0, true, 0},
		{"forbidden is not a 404", 403, 0, true, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeForgejo(t)
			f.on("GET /orgs/idea", tc.get, `{}`)
			if tc.post != 0 {
				f.on("POST /orgs", tc.post, `{}`)
			}
			err := f.client().EnsureOrg(t.Context(), "idea")
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v", err)
			}
			posts := f.called("POST /orgs")
			if len(posts) != tc.posts {
				t.Fatalf("POST /orgs %d times", len(posts))
			}
			if tc.posts == 1 && !strings.Contains(posts[0].Body, `"username":"idea"`) {
				t.Fatalf("create body %s", posts[0].Body)
			}
		})
	}
}

func TestEnsureRepo(t *testing.T) {
	cases := []struct {
		name      string
		get       fjReply
		post      fjReply
		wantErr   bool
		wantEmpty bool
		wantPosts int
	}{
		{"exists", fjReply{Body: `{"full_name":"idea/shop","empty":false,"default_branch":"main"}`}, fjReply{}, false, false, 0},
		{"exists empty", fjReply{Body: `{"full_name":"idea/shop","empty":true}`}, fjReply{}, false, true, 0},
		{"created on 404", fjReply{Status: 404}, fjReply{Status: 201, Body: `{"full_name":"idea/shop","empty":false}`}, false, true, 1},
		{"create fails", fjReply{Status: 404}, fjReply{Status: 409, Body: `{"message":"exists"}`}, true, false, 1},
		{"other error", fjReply{Status: 500}, fjReply{}, true, false, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeForgejo(t)
			f.mu.Lock()
			f.routes["GET /repos/idea/shop"] = tc.get
			if tc.post.Status != 0 {
				f.routes["POST /orgs/idea/repos"] = tc.post
			}
			f.mu.Unlock()
			r, err := f.client().EnsureRepo(t.Context(), "idea", "shop")
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v", err)
			}
			posts := f.called("POST /orgs/idea/repos")
			if len(posts) != tc.wantPosts {
				t.Fatalf("POST %d times", len(posts))
			}
			if tc.wantPosts == 1 && (!strings.Contains(posts[0].Body, `"name":"shop"`) || !strings.Contains(posts[0].Body, `"default_branch":"main"`)) {
				t.Fatalf("create body %s", posts[0].Body)
			}
			if err == nil && (r.FullName != "idea/shop" || r.Empty != tc.wantEmpty) {
				t.Fatalf("repo = %+v", r)
			}
		})
	}
}

func TestImportRepo(t *testing.T) {
	t.Run("exists", func(t *testing.T) {
		f := newFakeForgejo(t)
		f.on("GET /repos/idea/shop", 200, `{}`)
		created, err := f.client().ImportRepo(t.Context(), "idea", "shop", "https://example.org/r.git", "d")
		if err != nil || created || len(f.called("POST /repos/migrate")) != 0 {
			t.Fatalf("created=%v err=%v", created, err)
		}
	})
	t.Run("copied with master renamed", func(t *testing.T) {
		f := newFakeForgejo(t)
		// Missing at first, there after the copy.
		f.on("GET /repos/idea/shop", 404, `{}`)
		f.onThen("POST /repos/migrate", fjReply{Status: 201, Body: `{}`},
			"GET /repos/idea/shop", fjReply{Body: `{"empty":false,"default_branch":"master"}`})
		f.on("POST /repos/idea/shop/branches", 201, `{}`)
		f.on("PATCH /repos/idea/shop", 200, `{}`)
		created, err := f.client().ImportRepo(t.Context(), "idea", "shop", "https://example.org/r.git", "desc")
		if err != nil || !created {
			t.Fatalf("created=%v err=%v", created, err)
		}
		m := f.called("POST /repos/migrate")
		if len(m) != 1 || !strings.Contains(m[0].Body, `"clone_addr":"https://example.org/r.git"`) || !strings.Contains(m[0].Body, `"mirror":false`) {
			t.Fatalf("migrate = %+v", m)
		}
		b := f.called("POST /repos/idea/shop/branches")
		if len(b) != 1 || !strings.Contains(b[0].Body, `"old_branch_name":"master"`) || !strings.Contains(b[0].Body, `"new_branch_name":"main"`) {
			t.Fatalf("branch = %+v", b)
		}
		p := f.called("PATCH /repos/idea/shop")
		if len(p) != 1 || !strings.Contains(p[0].Body, `"default_branch":"main"`) {
			t.Fatalf("patch = %+v", p)
		}
	})
	t.Run("copied on main", func(t *testing.T) {
		f := newFakeForgejo(t)
		f.on("GET /repos/idea/shop", 404, `{}`)
		f.onThen("POST /repos/migrate", fjReply{Status: 201, Body: `{}`},
			"GET /repos/idea/shop", fjReply{Body: `{"empty":false,"default_branch":"main"}`})
		created, err := f.client().ImportRepo(t.Context(), "idea", "shop", "https://example.org/r.git", "")
		if err != nil || !created || len(f.called("PATCH /repos/idea/shop")) != 0 {
			t.Fatalf("created=%v err=%v calls=%+v", created, err, f.received())
		}
	})
	t.Run("copy fails", func(t *testing.T) {
		f := newFakeForgejo(t)
		f.on("GET /repos/idea/shop", 404, `{}`)
		f.on("POST /repos/migrate", 422, `{"message":"private address"}`)
		created, err := f.client().ImportRepo(t.Context(), "idea", "shop", "https://example.org/r.git", "")
		if err == nil || created || !isStatus(err, 422) {
			t.Fatalf("created=%v err=%v", created, err)
		}
	})
}

func TestFindPR(t *testing.T) {
	f := newFakeForgejo(t)
	f.on("GET /repos/idea/shop/pulls", 200, `[
		{"number":1,"head":{"ref":"idea/issue-10","sha":"a"}},
		{"number":2,"state":"open","mergeable":true,"html_url":"u","head":{"ref":"idea/issue-1","sha":"b"}}]`)
	fj := f.client()
	pr, err := fj.FindPR(t.Context(), "idea/shop", "idea/issue-1")
	if err != nil || pr == nil || pr.Number != 2 || pr.Head.SHA != "b" || !pr.Mergeable || pr.URL != "u" {
		t.Fatalf("pr = %+v err=%v", pr, err)
	}
	if q := f.received()[0].Query; q != "state=all&limit=50" {
		t.Fatalf("query %q: closed and merged pull requests must be found too", q)
	}
	pr, err = fj.FindPR(t.Context(), "idea/shop", "idea/issue-3")
	if err != nil || pr != nil {
		t.Fatalf("no match: pr=%+v err=%v", pr, err)
	}
	if _, err := fj.FindPR(t.Context(), "idea/gone", "x"); !isStatus(err, 404) {
		t.Fatalf("missing repo: %v", err)
	}
}

func TestForgejoSmallCalls(t *testing.T) {
	f := newFakeForgejo(t)
	f.on("GET /repos/idea/shop/commits/abc/status", 200, `{"state":"success","total_count":2}`)
	f.on("POST /repos/idea/shop/statuses/abc", 201, `{}`)
	f.on("POST /repos/idea/shop/pulls/7/merge", 200, ``)
	f.on("POST /repos/idea/shop/issues/3/comments", 201, `{}`)
	f.on("GET /admin/runners/registration-token", 200, `{"token":"rt"}`)
	f.on("PUT /repos/idea/shop/collaborators/idea-worker", 204, ``)
	f.on("POST /repos/idea/shop/contents", 201, `{}`)
	f.on("GET /version", 200, `{"version":"x"}`)
	fj := f.client()
	ctx := t.Context()

	st, err := fj.Status(ctx, "idea/shop", "abc")
	if err != nil || st.State != "success" || st.TotalCount != 2 {
		t.Fatalf("status = %+v %v", st, err)
	}
	if err := fj.SetStatus(ctx, "idea/shop", "abc", "pending", gateContext, "running"); err != nil {
		t.Fatal(err)
	}
	if b := f.called("POST /repos/idea/shop/statuses/abc")[0].Body; b != `{"context":"idea/tests","description":"running","state":"pending"}` {
		t.Fatalf("status body %s", b)
	}
	if err := fj.Merge(ctx, "idea/shop", 7); err != nil {
		t.Fatal(err)
	}
	var merge map[string]any
	_ = json.Unmarshal([]byte(f.called("POST /repos/idea/shop/pulls/7/merge")[0].Body), &merge)
	// The explicit title keeps the machine's address out of the merge commit.
	if merge["Do"] != "merge" || merge["delete_branch_after_merge"] != true || merge["MergeTitleField"] != "Merge pull request #7" {
		t.Fatalf("merge body %v", merge)
	}
	if err := fj.Comment(ctx, "idea/shop", 3, "hi"); err != nil {
		t.Fatal(err)
	}
	if b := f.called("POST /repos/idea/shop/issues/3/comments")[0].Body; b != `{"body":"hi"}` {
		t.Fatalf("comment body %s", b)
	}
	if tok, err := fj.RunnerToken(ctx); err != nil || tok != "rt" {
		t.Fatalf("runner token %q %v", tok, err)
	}
	if err := fj.EnsureCollaborator(ctx, "idea", "shop", workerUser); err != nil {
		t.Fatal(err)
	}
	if err := fj.Ready(ctx); err != nil {
		t.Fatal(err)
	}
	if err := fj.Seed(ctx, "idea", "shop", []SeedFile{{Path: "a.txt", Content: []byte("hello")}}); err != nil {
		t.Fatal(err)
	}
	var seed struct {
		Files     []struct{ Operation, Path, Content string }
		NewBranch string `json:"new_branch"`
	}
	_ = json.Unmarshal([]byte(f.called("POST /repos/idea/shop/contents")[0].Body), &seed)
	if len(seed.Files) != 1 || seed.Files[0].Operation != "create" || seed.Files[0].Path != "a.txt" ||
		seed.Files[0].Content != base64.StdEncoding.EncodeToString([]byte("hello")) || seed.NewBranch != "main" {
		t.Fatalf("seed body %+v", seed)
	}
	if err := fj.Merge(ctx, "idea/shop", 8); !isStatus(err, 404) {
		t.Fatalf("merge of a missing PR: %v", err)
	}
}

func TestEnsureUser(t *testing.T) {
	t.Run("exists: password reset", func(t *testing.T) {
		f := newFakeForgejo(t)
		f.on("GET /users/idea-worker", 200, `{}`)
		f.on("PATCH /admin/users/idea-worker", 200, `{}`)
		if err := f.client().EnsureUser(t.Context(), "idea-worker", "w@x", "pw2"); err != nil {
			t.Fatal(err)
		}
		p := f.called("PATCH /admin/users/idea-worker")
		if len(p) != 1 || !strings.Contains(p[0].Body, `"password":"pw2"`) || len(f.called("POST /admin/users")) != 0 {
			t.Fatalf("calls %+v", f.received())
		}
	})
	t.Run("missing: created", func(t *testing.T) {
		f := newFakeForgejo(t)
		f.on("POST /admin/users", 201, `{}`)
		if err := f.client().EnsureUser(t.Context(), "idea-worker", "w@x", "pw2"); err != nil {
			t.Fatal(err)
		}
		p := f.called("POST /admin/users")
		if len(p) != 1 || !strings.Contains(p[0].Body, `"username":"idea-worker"`) || !strings.Contains(p[0].Body, `"email":"w@x"`) {
			t.Fatalf("calls %+v", f.received())
		}
	})
	t.Run("error", func(t *testing.T) {
		f := newFakeForgejo(t)
		f.on("GET /users/idea-worker", 500, ``)
		if err := f.client().EnsureUser(t.Context(), "idea-worker", "w@x", "pw"); !isStatus(err, 500) {
			t.Fatalf("err = %v", err)
		}
		if len(f.received()) != 1 {
			t.Fatal("went on after an error")
		}
	})
}

func TestNewToken(t *testing.T) {
	f := newFakeForgejo(t)
	f.on("POST /users/idea-worker/tokens", 201, `{"sha1":"tok"}`)
	worker := f.client().As("idea-worker", "pw")
	tok, err := worker.NewToken(t.Context(), "idea-worker", []string{"write:repository"})
	if err != nil || tok != "tok" {
		t.Fatalf("token %q %v", tok, err)
	}
	calls := f.received()
	// The old token is deleted first (a 404 there is fine), as the worker.
	if len(calls) != 2 || calls[0].Method != http.MethodDelete || calls[0].Path != "/users/idea-worker/tokens/idea-worker" {
		t.Fatalf("calls %+v", calls)
	}
	for _, c := range calls {
		if c.User != "idea-worker" {
			t.Fatalf("call as %q", c.User)
		}
	}
	if !strings.Contains(calls[1].Body, `"scopes":["write:repository"]`) {
		t.Fatalf("body %s", calls[1].Body)
	}

	f.on("POST /users/idea-worker/tokens", 201, `{}`)
	if _, err := worker.NewToken(t.Context(), "idea-worker", nil); err == nil {
		t.Fatal("an empty token must be an error")
	}
}

func TestEnsureWebhook(t *testing.T) {
	const target = "http://ctl/webhook/forgejo"
	cases := []struct {
		name    string
		hooks   string
		created bool
	}{
		{"none", `[]`, true},
		{"present", `[{"id":1,"active":true,"config":{"url":"` + target + `"}}]`, false},
		{"inactive", `[{"id":1,"active":false,"config":{"url":"` + target + `"}}]`, true},
		{"other target", `[{"id":1,"active":true,"config":{"url":"http://elsewhere"}}]`, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeForgejo(t)
			f.on("GET /repos/idea/shop/hooks", 200, tc.hooks)
			f.on("POST /repos/idea/shop/hooks", 201, `{}`)
			created, err := f.client().EnsureWebhook(t.Context(), "idea", "shop", target, "sekrit")
			if err != nil || created != tc.created {
				t.Fatalf("created=%v err=%v", created, err)
			}
			posts := f.called("POST /repos/idea/shop/hooks")
			if tc.created != (len(posts) == 1) {
				t.Fatalf("posts %+v", posts)
			}
			if tc.created && (!strings.Contains(posts[0].Body, `"secret":"sekrit"`) || !strings.Contains(posts[0].Body, `"events":["issues"]`)) {
				t.Fatalf("hook body %s", posts[0].Body)
			}
		})
	}
}

func TestForgejoRaw(t *testing.T) {
	f := newFakeForgejo(t)
	f.onText("GET /repos/idea/shop/pulls/1.diff", 200, "text/plain", "+a\n")
	f.onText("GET /repos/idea/shop/pulls/2.diff", 404, "text/plain", strings.Repeat("n", 400))
	fj := f.client()
	if d, err := fj.Raw(t.Context(), "/repos/idea/shop/pulls/1.diff"); err != nil || d != "+a\n" {
		t.Fatalf("raw %q %v", d, err)
	}
	_, err := fj.Raw(t.Context(), "/repos/idea/shop/pulls/2.diff")
	var ae *apiError
	if !errors.As(err, &ae) || ae.Status != 404 || len(ae.Body) != 300 {
		t.Fatalf("raw error %v", err)
	}
}

func TestForgejoBranchHeadAndCommits(t *testing.T) {
	f := newFakeForgejo(t)
	f.on("GET /repos/idea/shop/branches/main", 200, `{"commit":{"id":"abc"}}`)
	page := make([]string, 50)
	for i := range page {
		page[i] = fmt.Sprintf(`{"sha":"s%d","commit":{"message":"m","author":{"email":"a@x"},"committer":{"email":"c@x"}}}`, i)
	}
	f.on("GET /repos/idea/shop/pulls/4/commits", 200, "["+strings.Join(page, ",")+"]")
	fj := f.client()
	if h, err := fj.BranchHead(t.Context(), "idea/shop", "main"); err != nil || h != "abc" {
		t.Fatalf("head %q %v", h, err)
	}
	if h, err := fj.BranchHead(t.Context(), "idea/shop", "gone"); err != nil || h != "" {
		t.Fatalf("missing branch: %q %v", h, err)
	}
	// Every page is full: more than 500 commits is an error, after 10 pages.
	if _, err := fj.PullCommits(t.Context(), "idea/shop", 4); err == nil || !strings.Contains(err.Error(), "more than 500") {
		t.Fatalf("err = %v", err)
	}
	if n := len(f.called("GET /repos/idea/shop/pulls/4/commits")); n != 10 {
		t.Fatalf("%d pages fetched", n)
	}
	f.on("GET /repos/idea/shop/pulls/5/commits", 200, "["+page[0]+"]")
	cs, err := fj.PullCommits(t.Context(), "idea/shop", 5)
	if err != nil || len(cs) != 1 || cs[0].AuthorEmail != "a@x" || cs[0].CommitterEmail != "c@x" || cs[0].SHA != "s0" {
		t.Fatalf("commits %+v %v", cs, err)
	}
}

func TestPRByNumber(t *testing.T) {
	f := newFakeForgejo(t)
	f.on("GET /repos/idea/shop/pulls/3", 200, `{"number":3,"state":"closed","merged":true,"head":{"ref":"refs/pull/3/head","sha":"a"}}`)
	f.on("GET /repos/idea/shop/pulls/5", 500, `{}`)
	fj := f.client()
	pr, err := fj.PR(t.Context(), "idea/shop", 3)
	if err != nil || pr == nil || pr.Number != 3 || !pr.Merged {
		t.Fatalf("pr = %+v err=%v", pr, err)
	}
	if pr, err := fj.PR(t.Context(), "idea/shop", 4); err != nil || pr != nil {
		t.Fatalf("missing: pr=%+v err=%v", pr, err)
	}
	if _, err := fj.PR(t.Context(), "idea/shop", 5); !isStatus(err, 500) {
		t.Fatalf("server error: %v", err)
	}
}
