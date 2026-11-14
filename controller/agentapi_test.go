package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func agentEnv(t *testing.T) (e *testEnv, h http.Handler) {
	t.Helper()
	e = newEnv(t, secret(testWorkNS, teamSecret, map[string]string{"token": "team-token"}), projectObj("shop", nil))
	mux := http.NewServeMux()
	e.c.agentMux(mux)
	return e, mux
}

func TestAgentAuth(t *testing.T) {
	routes := []struct{ method, path string }{
		{"POST", "/agent/projects"},
		{"POST", "/agent/projects/shop/mirror"},
		{"GET", "/agent/status"},
	}
	for _, auth := range []string{"", "Bearer ", "Bearer wrong", "Bearer team-token2", "Basic team-token"} {
		e, h := agentEnv(t)
		for _, rt := range routes {
			w := serve(h, rt.method, rt.path, auth, jsonType, `{"name":"new","url":""}`)
			if w.Code != 401 {
				t.Errorf("%q %s %s: %d", auth, rt.method, rt.path, w.Code)
			}
		}
		// The mirror was not removed, no project was added.
		list, _ := e.dyn.Resource(projectGVR).Namespace(testSystemNS).List(t.Context(), metav1.ListOptions{})
		if len(list.Items) != 1 {
			t.Fatalf("%q: projects = %d", auth, len(list.Items))
		}
	}
	// Before the machine has a team token, nobody gets in, not even with an empty one.
	e := newEnv(t)
	mux := http.NewServeMux()
	e.c.agentMux(mux)
	if w := serve(mux, "GET", "/agent/status", "Bearer ", "", ""); w.Code != 401 {
		t.Fatalf("no team token: %d", w.Code)
	}
}

func TestAgentProjects(t *testing.T) {
	cases := []struct {
		name, body string
		want       int
		wantImport string
	}{
		{"created", `{"name":"blog","description":"d"}`, 201, ""},
		{"imported", `{"name":"lib","import":" https://github.com/o/lib.git "}`, 201, "https://github.com/o/lib.git"},
		{"duplicate", `{"name":"shop"}`, 409, ""},
		{"bad name", `{"name":"a b"}`, 400, ""},
		{"import over ssh", `{"name":"x","import":"git@github.com:o/r.git"}`, 400, ""},
		{"import with credentials", `{"name":"x","import":"https://user:pw@github.com/o/r.git"}`, 400, ""},
		{"import with query", `{"name":"x","import":"https://github.com/o/r.git?x=1"}`, 400, ""},
		{"import over http", `{"name":"x","import":"http://github.com/o/r.git"}`, 400, ""},
		{"import too long", `{"name":"x","import":"https://github.com/` + strings.Repeat("a", 300) + `"}`, 400, ""},
		{"description too long", `{"name":"x","description":"` + strings.Repeat("d", 501) + `"}`, 400, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e, h := agentEnv(t)
			w := serve(h, "POST", "/agent/projects", "Bearer team-token", jsonType, tc.body)
			if w.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if tc.want != 201 {
				return
			}
			var p project
			_ = json.Unmarshal(w.Body.Bytes(), &p)
			u, err := e.dyn.Resource(projectGVR).Namespace(testSystemNS).Get(t.Context(), p.Name, metav1.GetOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if imp, _, _ := unstructured.NestedString(u.Object, "spec", "import"); imp != tc.wantImport {
				t.Fatalf("import = %q", imp)
			}
		})
	}
}

func TestAgentMirror(t *testing.T) {
	cases := []struct {
		name, project, body string
		want                int
		wantURL             string
		wantEmails          []string
	}{
		{"set", "shop", `{"url":"git@github.com:o/shop.git","allowedEmails":["@example\\.org$"]}`, 200, "git@github.com:o/shop.git", []string{`@example\.org$`}},
		{"removed", "shop", `{"url":""}`, 200, "", nil},
		{"https refused", "shop", `{"url":"https://github.com/o/shop.git"}`, 400, "", nil},
		{"option injection", "shop", `{"url":"-oProxyCommand=x@h:r"}`, 400, "", nil},
		{"bad pattern", "shop", `{"url":"git@github.com:o/shop.git","allowedEmails":["("]}`, 400, "", nil},
		{"too many patterns", "shop", `{"url":"git@h:r","allowedEmails":[` + strings.TrimSuffix(strings.Repeat(`"a",`, 21), ",") + `]}`, 400, "", nil},
		{"pattern too long", "shop", `{"url":"git@h:r","allowedEmails":["` + strings.Repeat("a", 201) + `"]}`, 400, "", nil},
		{"no such project", "nope", `{"url":"git@h:r"}`, 404, "", nil},
		{"bad project name", "Shop", `{"url":"git@h:r"}`, 404, "", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e, h := agentEnv(t)
			w := serve(h, "POST", "/agent/projects/"+tc.project+"/mirror", "Bearer team-token", jsonType, tc.body)
			if w.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if tc.want != 200 {
				return
			}
			u, _ := e.dyn.Resource(projectGVR).Namespace(testSystemNS).Get(t.Context(), "shop", metav1.GetOptions{})
			p := e.c.projectOf(u)
			if p.Mirror != tc.wantURL || strings.Join(p.AllowedEmails, "|") != strings.Join(tc.wantEmails, "|") {
				t.Fatalf("project mirror %q %v", p.Mirror, p.AllowedEmails)
			}
		})
	}
}

func TestAgentStatus(t *testing.T) {
	e, h := agentEnv(t)
	if _, err := e.dyn.Resource(taskGVR).Namespace(testSystemNS).Create(t.Context(),
		taskObj(2, map[string]any{"phase": phaseWorking}), metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	w := serve(h, "GET", "/agent/status", "Bearer team-token", "", "")
	var out struct {
		Projects []project
		Tasks    []taskRow
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || w.Code != 200 {
		t.Fatalf("status %d %v", w.Code, err)
	}
	if len(out.Projects) != 1 || len(out.Tasks) != 1 || out.Tasks[0].Phase != phaseWorking {
		t.Fatalf("status = %+v", out)
	}
}
