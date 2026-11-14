package main

import (
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/runtime"
)

const (
	pubBranch = "GET /repos/idea/shop/branches/main"
	pubList   = "GET /repos/idea/shop/commits"
	pubSync   = "POST /repos/idea/shop/push_mirrors-sync"
)

func commitJSON(sha, author, msg string) string {
	return fmt.Sprintf(`{"sha":%q,"commit":{"message":%q,"author":{"email":%q},"committer":{"email":"idea-admin@idea.internal"}}}`, sha, msg, author)
}

// mirroredProject is project shop, mirrored, last published at pub0.
func mirroredProject(published, publish string) project {
	u := projectObj("shop", map[string]any{"mirror": map[string]any{"url": "git@github.com:o/shop.git"}})
	u.Object["status"] = map[string]any{
		"mirrorKey": "ssh-ed25519 AAAA", "mirrorUrl": "git@github.com:o/shop.git",
		"published": published, "publish": publish,
	}
	c := &Controller{cfg: Config{Org: "idea", Host: "idea.test"}}
	return c.projectOf(u)
}

func TestPublishProject(t *testing.T) {
	clean := commitJSON("c1", "idea-worker@idea.internal", "Add x")
	cleanDiff := "diff --git a/x b/x\n+++ b/x\n@@ -0,0 +1 @@\n+fine\n"
	fullPage := "[" + strings.TrimSuffix(strings.Repeat(clean+",", 50), ",") + "]"
	cases := []struct {
		name          string
		published     string
		publish       string
		synced        time.Duration // since the last sync
		private       bool          // the machine has a list of private strings
		branch        fjReply
		commits       fjReply
		diff          string
		sync          fjReply
		wantSync      bool
		wantPublished string
		wantPublish   string // part of status.publish
	}{
		{name: "no main yet", published: "pub0", branch: fjReply{Status: 404}, wantPublished: "pub0"},
		{
			name: "first publish takes main as it is", published: "", branch: fjReply{Body: `{"commit":{"id":"head1"}}`},
			wantSync: true, wantPublished: "head1", wantPublish: "as it was when the mirror was set up",
		},
		{name: "nothing new", published: "head1", publish: "published main at head1", branch: fjReply{Body: `{"commit":{"id":"head1"}}`}, wantPublished: "head1", wantPublish: "published main at head1"},
		{
			name: "failed push is retried", published: "head1", publish: mirrorFailed + "x", synced: time.Hour,
			branch: fjReply{Body: `{"commit":{"id":"head1"}}`}, wantSync: true, wantPublished: "head1", wantPublish: "published main at head1",
		},
		{
			name: "failed push is not retried too soon", published: "head1", publish: mirrorFailed + "x", synced: time.Minute,
			branch: fjReply{Body: `{"commit":{"id":"head1"}}`}, wantPublished: "head1", wantPublish: mirrorFailed,
		},
		{
			name: "clean commits are published", published: "pub0", private: true,
			branch: fjReply{Body: `{"commit":{"id":"head1"}}`}, commits: fjReply{Body: "[" + clean + "]"}, diff: cleanDiff,
			wantSync: true, wantPublished: "head1", wantPublish: "published main at head1 (",
		},
		{
			name: "without a private list only e-mails are checked", published: "pub0",
			branch: fjReply{Body: `{"commit":{"id":"head1"}}`}, commits: fjReply{Body: "[" + clean + "]"}, diff: "+box.lan\n",
			wantSync: true, wantPublished: "head1", wantPublish: "only commit e-mails were checked",
		},
		{
			name: "foreign e-mail holds", published: "pub0", private: true,
			branch: fjReply{Body: `{"commit":{"id":"head1"}}`}, commits: fjReply{Body: "[" + commitJSON("c2", "me@corp.example", "x") + "]"}, diff: cleanDiff,
			wantPublished: "pub0", wantPublish: "not published: the author e-mail of commit c2",
		},
		{
			name: "private string in a message holds", published: "pub0", private: true,
			branch: fjReply{Body: `{"commit":{"id":"head1"}}`}, commits: fjReply{Body: "[" + commitJSON("c3", "idea-worker@idea.internal", "see https://box.lan/x") + "]"}, diff: cleanDiff,
			wantPublished: "pub0", wantPublish: "not published: the message of commit c3",
		},
		{
			name: "private string in a diff holds", published: "pub0", private: true,
			branch: fjReply{Body: `{"commit":{"id":"head1"}}`}, commits: fjReply{Body: "[" + clean + "]"}, diff: "+++ b/conf\n@@ -1 +1 @@\n+host = 10.9.8.7\n",
			wantPublished: "pub0", wantPublish: "not published: conf, line 1 (in commit c1)",
		},
		{
			name: "published commit gone holds", published: "pub0", private: true,
			branch: fjReply{Body: `{"commit":{"id":"head1"}}`}, commits: fjReply{Status: 404, Body: `{"message":"not found"}`},
			wantPublished: "pub0", wantPublish: "not published: could not list the commits since pub0",
		},
		{
			name: "too many commits hold", published: "pub0", private: true,
			branch: fjReply{Body: `{"commit":{"id":"head1"}}`}, commits: fjReply{Body: fullPage}, diff: cleanDiff,
			wantPublished: "pub0", wantPublish: "more than 300 commits",
		},
		{
			name: "push fails", published: "pub0", private: true,
			branch: fjReply{Body: `{"commit":{"id":"head1"}}`}, commits: fjReply{Body: "[" + clean + "]"}, diff: cleanDiff,
			sync: fjReply{Status: 500, Body: "denied"}, wantSync: true, wantPublished: "head1", wantPublish: mirrorFailed + "main at head1 was checked",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := mirroredProject(tc.published, tc.publish)
			objs := []runtime.Object{p.obj}
			if tc.private {
				objs = append(objs, secret(testSystemNS, privateStringsSecret, map[string]string{"strings": "box.lan\n10.9.8.7\n"}))
			}
			e := newEnv(t, objs...)
			e.c.mirrorSynced = map[string]time.Time{"shop": time.Now().Add(-tc.synced)}
			e.fj.mu.Lock()
			e.fj.routes[pubBranch] = tc.branch
			e.fj.routes[pubList] = tc.commits
			e.fj.routes["GET /repos/idea/shop/git/commits/c1.diff"] = fjReply{Type: "text/plain", Body: tc.diff}
			e.fj.routes["GET /repos/idea/shop/git/commits/c2.diff"] = fjReply{Type: "text/plain", Body: tc.diff}
			e.fj.routes["GET /repos/idea/shop/git/commits/c3.diff"] = fjReply{Type: "text/plain", Body: tc.diff}
			e.fj.routes[pubSync] = tc.sync
			e.fj.mu.Unlock()

			if err := e.c.publishProject(t.Context(), p); err != nil {
				t.Fatalf("publishProject: %v", err)
			}
			if n := len(e.fj.called(pubSync)); (n == 1) != tc.wantSync || n > 1 {
				t.Fatalf("mirror syncs: %d", n)
			}
			ps, err := e.c.listProjects(t.Context())
			if err != nil || len(ps) != 1 {
				t.Fatal(err)
			}
			if ps[0].Published != tc.wantPublished || !strings.Contains(ps[0].Publish, tc.wantPublish) {
				t.Fatalf("published %q %q, want %q %q", ps[0].Published, ps[0].Publish, tc.wantPublished, tc.wantPublish)
			}
			if strings.Contains(ps[0].Publish, "box.lan") || strings.Contains(ps[0].Publish, "10.9.8.7") {
				t.Fatalf("the private string leaked: %q", ps[0].Publish)
			}
			if l := e.fj.called(pubList); len(l) > 0 && !strings.HasPrefix(l[0].Query, "sha=head1&not=pub0&") {
				t.Fatalf("commits query %q", l[0].Query)
			}
		})
	}
}

func TestEnsurePushMirror(t *testing.T) {
	const addr = "git@github.com:o/shop.git"
	good := `{"remote_name":"m1","remote_address":"ssh://github.com/o/shop.git","public_key":"k1","sync_on_commit":false,"interval":"0s"}`
	cases := []struct {
		name        string
		list        string
		created     fjReply
		wantErr     bool
		wantKey     string
		wantDeletes []string
		wantCreate  bool
	}{
		{name: "none: created", list: `[]`, created: fjReply{Status: 201, Body: `{"public_key":"k2"}`}, wantKey: "k2", wantCreate: true},
		{name: "kept", list: "[" + good + "]", wantKey: "k1"},
		{
			name: "another mirror is removed", list: "[" + good + `,{"remote_name":"m2","remote_address":"git@evil.example:x/y.git","public_key":"k3"}]`,
			wantKey: "k1", wantDeletes: []string{"m2"},
		},
		{
			name: "one syncing on commit is replaced", list: `[{"remote_name":"m3","remote_address":"` + addr + `","public_key":"k4","sync_on_commit":true}]`,
			created: fjReply{Status: 201, Body: `{"public_key":"k5"}`}, wantKey: "k5", wantDeletes: []string{"m3"}, wantCreate: true,
		},
		{
			name: "one on a timer is replaced", list: `[{"remote_name":"m4","remote_address":"` + addr + `","public_key":"k6","interval":"8h0m0s"}]`,
			created: fjReply{Status: 201, Body: `{"public_key":"k7"}`}, wantKey: "k7", wantDeletes: []string{"m4"}, wantCreate: true,
		},
		{
			name: "a second copy is removed", list: "[" + good + "," + strings.Replace(good, "m1", "m9", 1) + "]",
			wantKey: "k1", wantDeletes: []string{"m9"},
		},
		{name: "created without a key", list: `[]`, created: fjReply{Status: 201, Body: `{}`}, wantErr: true, wantCreate: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeForgejo(t)
			f.on("GET /repos/idea/shop/push_mirrors", 200, tc.list)
			for _, n := range []string{"m1", "m2", "m3", "m4", "m9"} {
				f.on("DELETE /repos/idea/shop/push_mirrors/"+n, 204, ``)
			}
			f.mu.Lock()
			f.routes["POST /repos/idea/shop/push_mirrors"] = tc.created
			f.mu.Unlock()
			m, err := f.client().EnsurePushMirror(t.Context(), "idea/shop", addr)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v", err)
			}
			if err == nil && m.PublicKey != tc.wantKey {
				t.Fatalf("key %q", m.PublicKey)
			}
			var deleted []string
			for _, c := range f.received() {
				if c.Method == http.MethodDelete {
					deleted = append(deleted, c.Path[strings.LastIndex(c.Path, "/")+1:])
				}
			}
			if strings.Join(deleted, ",") != strings.Join(tc.wantDeletes, ",") {
				t.Fatalf("deleted %v, want %v", deleted, tc.wantDeletes)
			}
			posts := f.called("POST /repos/idea/shop/push_mirrors")
			if (len(posts) == 1) != tc.wantCreate {
				t.Fatalf("creates %d", len(posts))
			}
			if tc.wantCreate && (!strings.Contains(posts[0].Body, `"sync_on_commit":false`) || !strings.Contains(posts[0].Body, `"use_ssh":true`)) {
				t.Fatalf("create body %s", posts[0].Body)
			}
		})
	}
}

func TestReconcileProject(t *testing.T) {
	cases := []struct {
		name     string
		spec     map[string]any
		repo     fjReply // GET /repos/idea/shop
		wantErr  string
		wantSeed bool
		wantRepo bool // created
	}{
		{name: "new repository is created and seeded", spec: map[string]any{"seed": "hello"}, repo: fjReply{Status: 404}, wantSeed: true, wantRepo: true},
		{name: "empty repository is seeded", spec: map[string]any{"seed": "hello"}, repo: fjReply{Body: `{"full_name":"idea/shop","empty":true}`}, wantSeed: true},
		{name: "repository with history is not seeded again", spec: map[string]any{"seed": "hello"}, repo: fjReply{Body: `{"full_name":"idea/shop","empty":false}`}},
		{name: "no seed", repo: fjReply{Status: 404}, wantRepo: true},
		{name: "unknown seed", spec: map[string]any{"seed": "nope"}, repo: fjReply{Status: 404}, wantRepo: true, wantErr: `no example named "nope"`},
		{
			name: "cut-off import", spec: map[string]any{"import": "https://example.org/r.git"}, repo: fjReply{Body: `{"full_name":"idea/shop","empty":true}`},
			wantErr: "did not finish",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t, projectObj("shop", tc.spec))
			dir := e.c.cfg.ExamplesDir + "/hello"
			if err := os.MkdirAll(dir+"/node_modules/x", 0o750); err != nil {
				t.Fatal(err)
			}
			_ = os.WriteFile(dir+"/README.md", []byte("hi"), 0o600)
			_ = os.WriteFile(dir+"/node_modules/x/i.js", []byte("no"), 0o600)
			e.c.cfg.WebhookTarget, e.c.cfg.WebhookSecret = "http://ctl/webhook", "s"
			e.c.imports = map[string]string{"idea/shop": ""} // a copy that finished
			e.fj.mu.Lock()
			e.fj.routes["GET /repos/idea/shop"] = tc.repo
			e.fj.mu.Unlock()
			e.fj.on("POST /orgs/idea/repos", 201, `{"full_name":"idea/shop"}`)
			e.fj.on("POST /repos/idea/shop/contents", 201, `{}`)
			e.fj.on("PUT /repos/idea/shop/collaborators/idea-worker", 204, ``)
			e.fj.on("GET /repos/idea/shop/hooks", 200, `[]`)
			e.fj.on("POST /repos/idea/shop/hooks", 201, `{}`)
			ps, _ := e.c.listProjects(t.Context())
			err := e.c.reconcileProject(t.Context(), &ps[0])
			if tc.wantErr == "" && err != nil {
				t.Fatal(err)
			}
			if tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
				t.Fatalf("err = %v, want %q", err, tc.wantErr)
			}
			if n := len(e.fj.called("POST /orgs/idea/repos")); (n == 1) != tc.wantRepo {
				t.Fatalf("repo creates %d", n)
			}
			seeds := e.fj.called("POST /repos/idea/shop/contents")
			if (len(seeds) == 1) != tc.wantSeed {
				t.Fatalf("seeds %d", len(seeds))
			}
			if tc.wantSeed && (!strings.Contains(seeds[0].Body, `"path":"README.md"`) || strings.Contains(seeds[0].Body, "node_modules")) {
				t.Fatalf("seed body %s", seeds[0].Body)
			}
			if tc.wantErr == "" && (len(e.fj.called("PUT /repos/idea/shop/collaborators/idea-worker")) != 1 || len(e.fj.called("POST /repos/idea/shop/hooks")) != 1) {
				t.Fatalf("collaborator or webhook missing: %+v", e.fj.received())
			}
		})
	}
}
