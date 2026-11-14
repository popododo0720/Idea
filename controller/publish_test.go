package main

import (
	"strings"
	"testing"
)

var testPrivate = []string{"box.lan", "10.9.8.7"}

func TestAllowedMail(t *testing.T) {
	rules, err := mailRules(nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range []string{
		"idea-worker@idea.internal",
		"idea-admin@idea.internal",
		"12345+someone@users.noreply.github.com",
		"someone@users.noreply.github.com",
	} {
		if !mailAllowed(rules, m) {
			t.Errorf("%s should be allowed", m)
		}
	}
	for _, m := range []string{
		"me@example.com",
		"idea-worker@idea.internal.evil.com",
		"x@users.noreply.github.com.evil",
		"",
	} {
		if mailAllowed(rules, m) {
			t.Errorf("%q should not be allowed", m)
		}
	}
}

func TestCustomMail(t *testing.T) {
	rules, err := mailRules([]string{`@example\.org$`})
	if err != nil {
		t.Fatal(err)
	}
	if !mailAllowed(rules, "dev@example.org") || !mailAllowed(rules, "idea-worker@idea.internal") {
		t.Fatal("custom pattern and bot must be allowed")
	}
	if mailAllowed(rules, "x@users.noreply.github.com") {
		t.Fatal("a custom list replaces the GitHub default")
	}
	if _, err := mailRules([]string{"("}); err == nil {
		t.Fatal("bad pattern must fail")
	}
}

func TestCheckCommits(t *testing.T) {
	rules, _ := mailRules(nil)
	ok := CommitInfo{SHA: "aaaaaaaaaaaa", Message: "Add a thing", AuthorEmail: "idea-worker@idea.internal", CommitterEmail: "idea-worker@idea.internal"}
	if p := checkCommits([]CommitInfo{ok}, rules, testPrivate); p != "" {
		t.Fatalf("clean commit flagged: %s", p)
	}
	bad := ok
	bad.AuthorEmail = "me@example.com"
	if p := checkCommits([]CommitInfo{ok, bad}, rules, testPrivate); !strings.Contains(p, "author e-mail") {
		t.Fatalf("author e-mail not flagged: %q", p)
	}
	msg := ok
	msg.Message = "Merge\n\nReviewed-on: https://box.lan/git/idea/idea/pulls/3"
	p := checkCommits([]CommitInfo{msg}, rules, testPrivate)
	if !strings.Contains(p, "message") {
		t.Fatalf("private string in message not flagged: %q", p)
	}
	if strings.Contains(p, "box.lan") {
		t.Fatalf("the finding must not name the string: %q", p)
	}
}

func TestCheckDiff(t *testing.T) {
	diff := `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,3 @@
 keep
-host = 10.9.8.7
+host = example
+other = fine
`
	if p := checkDiff(diff, "commit x", testPrivate); p != "" {
		t.Fatalf("a removed private string must not block: %s", p)
	}
	added := `diff --git a/b.go b/b.go
--- a/b.go
+++ b/b.go
@@ -10,3 +10,4 @@ func x() {
 a
 b
+	url := "https://box.lan/api"
 c
`
	p := checkDiff(added, "commit x", testPrivate)
	if !strings.Contains(p, "b.go, line 12") {
		t.Fatalf("want file and line, got %q", p)
	}
	if strings.Contains(p, "box.lan") {
		t.Fatalf("the finding must not name the string: %q", p)
	}
	name := `diff --git a/docs/box.lan.md b/docs/box.lan.md
new file mode 100644
--- /dev/null
+++ b/docs/box.lan.md
@@ -0,0 +1 @@
+hello
`
	if p := checkDiff(name, "commit x", testPrivate); !strings.Contains(p, "file name") || strings.Contains(p, "box.lan") {
		t.Fatalf("private file name: got %q", p)
	}
}

func TestMirrorURL(t *testing.T) {
	for _, u := range []string{
		"git@github.com:owner/repo.git",
		"ssh://git@git.example.org:2222/team/repo.git",
	} {
		if !mirrorURL.MatchString(u) {
			t.Errorf("%s should be accepted", u)
		}
	}
	for _, u := range []string{
		"https://github.com/owner/repo.git",
		"git@github.com:owner/repo.git --upload-pack=x",
		"git@github.com:owner/repo.git?x",
		"-oProxyCommand=x@h:r",
		"-ox@h:r",
		"git@-oh:r",
		"git@h:-r",
	} {
		if mirrorURL.MatchString(u) {
			t.Errorf("%q should be refused", u)
		}
	}
}

func TestClip(t *testing.T) {
	if got := clip("가나다", 4); got != "가…" {
		t.Fatalf("clip split a character: %q", got)
	}
}

func TestSameRemote(t *testing.T) {
	same := [][2]string{
		{"git@github.com:owner/repo.git", "ssh://github.com/owner/repo.git"},
		{"git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo.git"},
		{"ssh://git@git.example.org:2222/team/repo.git", "ssh://git.example.org:2222/team/repo.git"},
	}
	for _, p := range same {
		if !sameRemote(p[0], p[1]) {
			t.Errorf("%s and %s are the same remote", p[0], p[1])
		}
	}
	if sameRemote("git@github.com:owner/repo.git", "ssh://github.com/owner/other.git") {
		t.Error("different repositories")
	}
	if sameRemote("ssh://git@git.example.org:2222/r.git", "ssh://git.example.org/r.git") {
		t.Error("different ports")
	}
}
