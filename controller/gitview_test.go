package main

import (
	"encoding/json"
	"net/url"
	"strings"
	"testing"
)

func TestGitAllowed(t *testing.T) {
	ok := []struct{ m, p string }{
		{"GET", "repos/search"},
		{"GET", "repos/idea/hello/branches"},
		{"GET", "repos/idea/hello/commits"},
		{"GET", "repos/idea/hello/pulls"},
		{"GET", "repos/idea/hello.js/git/commits/0123abcd.diff"},
		{"GET", "repos/idea/hello/pulls/12.diff"},
		{"POST", "repos/idea/hello/pulls/12/merge"},
	}
	for _, c := range ok {
		if !gitAllowed(c.m, c.p) {
			t.Errorf("%s %s should be allowed", c.m, c.p)
		}
	}
	bad := []struct{ m, p string }{
		{"POST", "repos/search"},
		{"GET", "repos/idea/hello/pulls/12/merge"},
		{"DELETE", "repos/idea/hello"},
		{"GET", "repos/idea/hello"},
		{"GET", "repos/../admin/users/branches"},
		{"GET", "repos/.x/hello/branches"},
		{"GET", "admin/users"},
		{"GET", "repos/idea/hello/git/commits/HEAD.diff"},
		{"GET", "repos/idea/hello/contents/secret"},
		{"POST", "repos/idea/hello/pulls/12/merge/x"},
	}
	for _, c := range bad {
		if gitAllowed(c.m, c.p) {
			t.Errorf("%s %s should be refused", c.m, c.p)
		}
	}
}

func TestGitQuery(t *testing.T) {
	q := url.Values{"sha": {"main"}, "limit": {"50"}, "token": {"x"}}
	if got := gitQuery(q); got != "?limit=50&sha=main" {
		t.Errorf("gitQuery = %q", got)
	}
	if got := gitQuery(url.Values{}); got != "" {
		t.Errorf("empty gitQuery = %q", got)
	}
}

func TestHandleGit(t *testing.T) {
	cases := []struct {
		name      string
		method    string
		path      string // under /api/v1/git/
		body      string
		route     string // fake Forgejo route that answers
		reply     fjReply
		want      int
		wantBody  string // exact body, when set
		wantErr   string // part of the error, when set
		wantCall  string // the request Forgejo must see: "METHOD path?query"
		wantInput string // the JSON Forgejo must receive
	}{
		{
			name: "list passes allowed query parameters only", method: "GET",
			path:  "repos/idea/shop/commits?sha=main&limit=5&token=x&access_token=y",
			route: "GET /repos/idea/shop/commits", reply: fjReply{Body: `[{"sha":"abc"}]`},
			want: 200, wantBody: `[{"sha":"abc"}]`, wantCall: "GET /repos/idea/shop/commits?limit=5&sha=main",
		},
		{
			name: "search without query", method: "GET", path: "repos/search",
			route: "GET /repos/search", reply: fjReply{Body: `{"data":[]}`},
			want: 200, wantBody: `{"data":[]}`, wantCall: "GET /repos/search?",
		},
		{
			name: "pull request diff as JSON", method: "GET", path: "repos/idea/shop/pulls/3.diff",
			route: "GET /repos/idea/shop/pulls/3.diff", reply: fjReply{Type: "text/plain", Body: "diff --git a/x b/x\n"},
			want: 200, wantBody: `{"clipped":false,"diff":"diff --git a/x b/x\n"}` + "\n", wantCall: "GET /repos/idea/shop/pulls/3.diff?",
		},
		{
			name: "commit diff as JSON", method: "GET", path: "repos/idea/shop/git/commits/abcdef1.diff",
			route: "GET /repos/idea/shop/git/commits/abcdef1.diff", reply: fjReply{Type: "text/plain", Body: "+x"},
			want: 200, wantBody: `{"clipped":false,"diff":"+x"}` + "\n",
		},
		{
			name: "Forgejo 404 with its message", method: "GET", path: "repos/idea/gone/branches",
			route: "GET /repos/idea/gone/branches", reply: fjReply{Status: 404, Body: `{"message":"The target couldn't be found."}`},
			want: 404, wantErr: "forgejo: The target couldn't be found.",
		},
		{
			name: "Forgejo error as text", method: "GET", path: "repos/idea/shop/pulls",
			route: "GET /repos/idea/shop/pulls", reply: fjReply{Status: 500, Type: "text/plain", Body: "  boom \n"},
			want: 500, wantErr: "forgejo: boom",
		},
		{
			name: "long Forgejo error is cut", method: "GET", path: "repos/idea/shop/pulls",
			route: "GET /repos/idea/shop/pulls", reply: fjReply{Status: 502, Type: "text/plain", Body: strings.Repeat("e", 1000)},
			want: 502, wantErr: "forgejo: " + strings.Repeat("e", 300),
		},
		{
			name: "merge", method: "POST", path: "repos/idea/shop/pulls/3/merge",
			body:  `{"Do":"squash","delete_branch_after_merge":true}`,
			route: "POST /repos/idea/shop/pulls/3/merge", reply: fjReply{Status: 200},
			want: 200, wantBody: `{"ok":true}` + "\n", wantCall: "POST /repos/idea/shop/pulls/3/merge?",
			wantInput: `{"Do":"squash","delete_branch_after_merge":true}`,
		},
		{
			name: "merge refused by Forgejo", method: "POST", path: "repos/idea/shop/pulls/3/merge",
			body:  `{"Do":"rebase"}`,
			route: "POST /repos/idea/shop/pulls/3/merge", reply: fjReply{Status: 405, Body: `{"message":"not mergeable"}`},
			want: 405, wantErr: "forgejo: not mergeable",
			wantInput: `{"Do":"rebase","delete_branch_after_merge":false}`,
		},
		// Refused before Forgejo.
		{name: "merge style unknown", method: "POST", path: "repos/idea/shop/pulls/3/merge", body: `{"Do":"fast-forward"}`, want: 400, wantErr: "Do:"},
		{name: "merge style missing", method: "POST", path: "repos/idea/shop/pulls/3/merge", body: `{}`, want: 400},
		{name: "merge extra field", method: "POST", path: "repos/idea/shop/pulls/3/merge", body: `{"Do":"merge","MergeTitleField":"x"}`, want: 400},
		{name: "merge not JSON", method: "POST", path: "repos/idea/shop/pulls/3/merge", body: `Do=merge`, want: 400},
		{name: "repository contents", method: "GET", path: "repos/idea/shop/contents/secret", want: 404, wantErr: "unknown git call"},
		{name: "admin call", method: "GET", path: "admin/users", want: 404, wantErr: "unknown git call"},
		{name: "POST to a read", method: "POST", path: "repos/search", body: `{"Do":"merge"}`, want: 404, wantErr: "unknown git call"},
		{name: "GET a merge", method: "GET", path: "repos/idea/shop/pulls/3/merge", want: 404, wantErr: "unknown git call"},
		{name: "escaped traversal", method: "GET", path: "repos/idea/..%2F..%2Fadmin/branches", want: 404},
		{name: "DELETE", method: "DELETE", path: "repos/idea/shop", want: 405},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e, h, auth := authedEnv(t)
			if tc.route != "" {
				e.fj.mu.Lock()
				e.fj.routes[tc.route] = tc.reply
				e.fj.mu.Unlock()
			}
			ctype := ""
			if tc.method == "POST" {
				ctype = jsonType
				if strings.HasPrefix(tc.body, "Do=") {
					ctype = "application/x-www-form-urlencoded"
				}
			}
			w := serve(h, tc.method, "/api/v1/git/"+tc.path, auth, ctype, tc.body)
			if w.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if tc.wantBody != "" && w.Body.String() != tc.wantBody {
				t.Fatalf("body %q, want %q", w.Body.String(), tc.wantBody)
			}
			if tc.wantErr != "" {
				if msg := errorOf(t, w); msg != tc.wantErr && !strings.Contains(msg, tc.wantErr) {
					t.Fatalf("error %q, want %q", msg, tc.wantErr)
				}
			}
			calls := e.fj.received()
			if tc.route == "" {
				if len(calls) != 0 {
					t.Fatalf("a refused call reached Forgejo: %+v", calls)
				}
				return
			}
			if len(calls) != 1 {
				t.Fatalf("Forgejo calls = %+v", calls)
			}
			if calls[0].User != "admin" {
				t.Fatalf("Forgejo call as %q", calls[0].User)
			}
			if tc.wantCall != "" {
				if got := calls[0].Method + " " + calls[0].Path + "?" + calls[0].Query; got != tc.wantCall {
					t.Fatalf("Forgejo saw %q, want %q", got, tc.wantCall)
				}
			}
			if tc.wantInput != "" && calls[0].Body != tc.wantInput {
				t.Fatalf("Forgejo got %s, want %s", calls[0].Body, tc.wantInput)
			}
			if tc.want == 200 && w.Header().Get("Content-Type") != "application/json" {
				t.Fatalf("content type %q", w.Header().Get("Content-Type"))
			}
		})
	}
}

func TestHandleGitJSONHeaders(t *testing.T) {
	e, h, auth := authedEnv(t)
	e.fj.on("GET /repos/idea/shop/branches", 200, `[{"name":"main"}]`)
	w := serve(h, "GET", "/api/v1/git/repos/idea/shop/branches", auth, "", "")
	if w.Code != 200 || w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status %d headers %v", w.Code, w.Header())
	}
}

func TestHandleGitLargeAnswers(t *testing.T) {
	e, h, auth := authedEnv(t)
	big := strings.Repeat("x", maxGitBody+10)
	e.fj.on("GET /repos/idea/shop/commits", 200, `["`+big+`"]`)
	e.fj.onText("GET /repos/idea/shop/pulls/1.diff", 200, "text/plain", big)

	// JSON that does not fit is refused rather than cut into invalid JSON.
	w := serve(h, "GET", "/api/v1/git/repos/idea/shop/commits", auth, "", "")
	if w.Code != 502 || !strings.Contains(errorOf(t, w), "too large") {
		t.Fatalf("large JSON: %d", w.Code)
	}
	// A diff is cut and marked.
	w = serve(h, "GET", "/api/v1/git/repos/idea/shop/pulls/1.diff", auth, "", "")
	var out struct {
		Diff    string `json:"diff"`
		Clipped bool   `json:"clipped"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || w.Code != 200 {
		t.Fatalf("large diff: %d %v", w.Code, err)
	}
	if !out.Clipped || len(out.Diff) != maxGitBody {
		t.Fatalf("clipped=%v len=%d", out.Clipped, len(out.Diff))
	}
}

func TestHandleGitForgejoDown(t *testing.T) {
	e, h, auth := authedEnv(t)
	e.fj.srv.Close()
	w := serve(h, "GET", "/api/v1/git/repos/search", auth, "", "")
	if w.Code != 502 || !strings.HasPrefix(errorOf(t, w), "forgejo: ") {
		t.Fatalf("Forgejo down: %d %s", w.Code, w.Body.String())
	}
}

func TestGitQueryDropsLongValues(t *testing.T) {
	q := url.Values{"q": {strings.Repeat("a", 201)}, "page": {"2", "3"}, "state": {}}
	if got := gitQuery(q); got != "?page=2" {
		t.Errorf("gitQuery = %q", got)
	}
}
