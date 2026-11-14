package main

import (
	"net/url"
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
