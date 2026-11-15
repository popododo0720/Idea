package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	k8stesting "k8s.io/client-go/testing"
)

const (
	testDevice = "0123456789ab"
	testSecret = "s3cr3t"
	jsonType   = "application/json"
)

func TestAPIAuth(t *testing.T) {
	devs, tok := deviceSecret()
	cases := []struct {
		name string
		auth string
		want int
	}{
		{"no header", "", 401},
		{"basic scheme", "Basic " + tok, 401},
		{"lowercase scheme", "bearer " + tok, 401},
		{"bare token", tok, 401},
		{"wrong secret", "Bearer idea_" + testDevice + "_wrong", 401},
		{"empty secret", "Bearer idea_" + testDevice + "_", 401},
		{"unknown device", "Bearer idea_bbbbbbbbbbbb_" + testSecret, 401},
		{"wrong prefix", "Bearer xdea_" + testDevice + "_" + testSecret, 401},
		{"extra part", "Bearer " + tok + "_x", 401},
		{"uppercase id", "Bearer idea_" + strings.ToUpper(testDevice) + "_" + testSecret, 401},
		{"short id", "Bearer idea_0123_" + testSecret, 401},
		{"good token", "Bearer " + tok, 200},
	}
	e := newEnv(t, devs)
	h := e.c.apiHandler()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := serve(h, "GET", "/api/v1/devices", tc.auth, "", "")
			if w.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if tc.want == 401 {
				if msg := errorOf(t, w); !strings.Contains(msg, "not paired") {
					t.Fatalf("401 message %q", msg)
				}
				return
			}
			var rows []struct {
				ID   string `json:"id"`
				Name string `json:"name"`
				This bool   `json:"this"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &rows); err != nil {
				t.Fatal(err)
			}
			if len(rows) != 1 || rows[0].ID != testDevice || rows[0].Name != "laptop" || !rows[0].This {
				t.Fatalf("devices = %+v", rows)
			}
		})
	}
}

// Every route behind the token refuses a caller without one, before it does
// anything.
func TestAPIAuthGuardsEveryRoute(t *testing.T) {
	devs, _ := deviceSecret()
	routes := []struct{ method, path string }{
		{"GET", "/api/v1/status"},
		{"GET", "/api/v1/vms"},
		{"GET", "/api/v1/git/repos/search"},
		{"POST", "/api/v1/git/repos/idea/x/pulls/1/merge"},
		{"POST", "/api/v1/projects"},
		{"POST", "/api/v1/tasks"},
		{"GET", "/api/v1/tasks/x-issue-1"},
		{"POST", "/api/v1/tasks/x-issue-1/retry"},
		{"POST", "/api/v1/tasks/x-issue-1/cancel"},
		{"PUT", "/api/v1/keys"},
		{"GET", "/api/v1/dsh"},
		{"GET", "/api/v1/devices"},
		{"POST", "/api/v1/nodes/join-code"},
		{"DELETE", "/api/v1/devices/" + testDevice},
		{"GET", "/api/v1/nothing-here"},
	}
	e := newEnv(t, devs)
	h := e.c.apiHandler()
	for _, rt := range routes {
		w := serve(h, rt.method, rt.path, "Bearer idea_"+testDevice+"_nope", jsonType, `{}`)
		if w.Code != 401 {
			t.Errorf("%s %s without a valid token: %d", rt.method, rt.path, w.Code)
		}
	}
	if n := len(e.fj.received()); n != 0 {
		t.Fatalf("Forgejo was called %d times", n)
	}
	// Nothing was written either: the device is still there, no project.
	s, _ := e.kube.CoreV1().Secrets(testSystemNS).Get(t.Context(), devicesSecret, metav1.GetOptions{})
	if _, ok := s.Data[testDevice]; !ok {
		t.Fatal("the device was removed by an unauthenticated call")
	}
}

func TestAPIAuthWithoutDevices(t *testing.T) {
	_, tok := deviceSecret()
	// No idea-devices Secret at all.
	e := newEnv(t)
	if w := serve(e.c.apiHandler(), "GET", "/api/v1/devices", "Bearer "+tok, "", ""); w.Code != 401 {
		t.Fatalf("no devices: %d", w.Code)
	}
	// The Secret cannot be read.
	devs, _ := deviceSecret()
	e = newEnv(t, devs)
	e.kube.PrependReactor("get", "secrets", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("apiserver down")
	})
	if w := serve(e.c.apiHandler(), "GET", "/api/v1/devices", "Bearer "+tok, "", ""); w.Code != 401 {
		t.Fatalf("unreadable devices: %d", w.Code)
	}
}

func TestAPIUnpair(t *testing.T) {
	devs, tok := deviceSecret()
	other, _ := json.Marshal(device{Name: "phone", Hash: hashSecret("other"), Created: "2026-02-01T00:00:00Z"})
	devs.Data["bbbbbbbbbbbb"] = other
	e := newEnv(t, devs)
	h := e.c.apiHandler()
	auth := "Bearer " + tok

	if w := serve(h, "DELETE", "/api/v1/devices/BAD", auth, "", ""); w.Code != 400 {
		t.Fatalf("bad id: %d", w.Code)
	}
	if w := serve(h, "DELETE", "/api/v1/devices/cccccccccccc", auth, "", ""); w.Code != 204 {
		t.Fatalf("unknown id: %d", w.Code)
	}
	if w := serve(h, "DELETE", "/api/v1/devices/bbbbbbbbbbbb", auth, "", ""); w.Code != 204 {
		t.Fatalf("unpair other: %d", w.Code)
	}
	s, _ := e.kube.CoreV1().Secrets(testSystemNS).Get(t.Context(), devicesSecret, metav1.GetOptions{})
	if _, ok := s.Data["bbbbbbbbbbbb"]; ok || len(s.Data) != 1 {
		t.Fatalf("after unpair: %v", s.Data)
	}
	// A device can revoke itself; its token stops working at once.
	if w := serve(h, "DELETE", "/api/v1/devices/"+testDevice, auth, "", ""); w.Code != 204 {
		t.Fatalf("unpair self: %d", w.Code)
	}
	if w := serve(h, "GET", "/api/v1/devices", auth, "", ""); w.Code != 401 {
		t.Fatalf("revoked token still works: %d", w.Code)
	}
}

func setupCode(code string) *corev1.Secret {
	return secret(setupSecretNS, setupSecretName, map[string]string{"code": code, "talosconfig": "tc"})
}

func TestAPIPair(t *testing.T) {
	cases := []struct {
		name     string
		objs     []runtime.Object
		ctype    string
		body     string
		want     int
		wantErr  string
		wantName string // device name stored on success
	}{
		{name: "no setup code", body: `{"code":"abcd"}`, want: 409, wantErr: "no setup code"},
		{name: "wrong code", objs: []runtime.Object{setupCode("abcd-efgh")}, body: `{"code":"abcd-efgi"}`, want: 401, wantErr: "wrong setup code"},
		{name: "empty code", objs: []runtime.Object{setupCode("abcd-efgh")}, body: `{"code":""}`, want: 401},
		{name: "machine code empty", objs: []runtime.Object{setupCode("  ")}, body: `{"code":""}`, want: 401},
		{name: "right code", objs: []runtime.Object{setupCode("abcd-efgh")}, body: `{"code":"abcd-efgh","device":"phone"}`, want: 200, wantName: "phone"},
		{name: "code normalized", objs: []runtime.Object{setupCode("abcd-efgh\n")}, body: `{"code":" ABCD EFGH ","device":"  tab  "}`, want: 200, wantName: "tab"},
		{name: "no device name", objs: []runtime.Object{setupCode("abcd")}, body: `{"code":"abcd"}`, want: 200, wantName: "dsh"},
		{name: "device name too long", objs: []runtime.Object{setupCode("abcd")}, body: `{"code":"abcd","device":"` + strings.Repeat("x", 65) + `"}`, want: 200, wantName: "dsh"},
		{name: "not JSON", objs: []runtime.Object{setupCode("abcd")}, ctype: "text/plain", body: `{"code":"abcd"}`, want: 400, wantErr: "application/json"},
		{name: "unknown field", objs: []runtime.Object{setupCode("abcd")}, body: `{"code":"abcd","admin":true}`, want: 400, wantErr: "unknown field"},
		{name: "broken JSON", objs: []runtime.Object{setupCode("abcd")}, body: `{"code":`, want: 400},
		{name: "body too large", objs: []runtime.Object{setupCode("abcd")}, body: `{"code":"abcd","device":"` + strings.Repeat("x", 70<<10) + `"}`, want: 400},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t, tc.objs...)
			h := e.c.apiHandler()
			ctype := tc.ctype
			if ctype == "" {
				ctype = jsonType
			}
			w := serve(h, "POST", "/api/v1/pair", "", ctype, tc.body)
			if w.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if tc.want != 200 {
				if msg := errorOf(t, w); !strings.Contains(msg, tc.wantErr) {
					t.Fatalf("error %q, want %q", msg, tc.wantErr)
				}
				if _, err := e.kube.CoreV1().Secrets(testSystemNS).Get(t.Context(), devicesSecret, metav1.GetOptions{}); err == nil {
					t.Fatal("a refused pairing stored a device")
				}
				return
			}
			var out struct{ ID, Token, Host string }
			if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
				t.Fatal(err)
			}
			if out.Host != "idea.test" || !deviceID.MatchString(out.ID) || !strings.HasPrefix(out.Token, "idea_"+out.ID+"_") {
				t.Fatalf("pair answer %+v", out)
			}
			// The token authenticates, as this device, under the stored name.
			w = serve(h, "GET", "/api/v1/devices", "Bearer "+out.Token, "", "")
			if w.Code != 200 {
				t.Fatalf("new token refused: %d", w.Code)
			}
			var rows []struct {
				ID, Name string
				This     bool
			}
			_ = json.Unmarshal(w.Body.Bytes(), &rows)
			if len(rows) != 1 || rows[0].ID != out.ID || rows[0].Name != tc.wantName || !rows[0].This {
				t.Fatalf("devices %+v", rows)
			}
			// Only the hash is stored, never the token.
			s, _ := e.kube.CoreV1().Secrets(testSystemNS).Get(t.Context(), devicesSecret, metav1.GetOptions{})
			secretPart := out.Token[strings.LastIndex(out.Token, "_")+1:]
			if strings.Contains(string(s.Data[out.ID]), secretPart) {
				t.Fatal("the token is stored in clear")
			}
		})
	}
}

func TestAPIPairTwice(t *testing.T) {
	e := newEnv(t, setupCode("abcd"))
	h := e.c.apiHandler()
	var tokens []string
	for range 2 {
		w := serve(h, "POST", "/api/v1/pair", "", jsonType, `{"code":"abcd"}`)
		if w.Code != 200 {
			t.Fatalf("pair: %d %s", w.Code, w.Body.String())
		}
		var out struct{ Token string }
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		tokens = append(tokens, out.Token)
	}
	if tokens[0] == tokens[1] {
		t.Fatal("two pairings got the same token")
	}
	for _, tok := range tokens {
		if w := serve(h, "GET", "/api/v1/devices", "Bearer "+tok, "", ""); w.Code != 200 {
			t.Fatalf("token %d refused", w.Code)
		}
	}
	// A token of one device does not authenticate as the other.
	id0 := strings.Split(tokens[0], "_")[1]
	sec1 := strings.Split(tokens[1], "_")[2]
	if w := serve(h, "GET", "/api/v1/devices", "Bearer idea_"+id0+"_"+sec1, "", ""); w.Code != 401 {
		t.Fatalf("mixed token accepted: %d", w.Code)
	}
}

func TestAPIPairStoreErrors(t *testing.T) {
	// The setup code cannot be read: try again later, not "wrong code".
	e := newEnv(t, setupCode("abcd"))
	e.kube.PrependReactor("get", "secrets", func(a k8stesting.Action) (bool, runtime.Object, error) {
		if a.GetNamespace() == setupSecretNS {
			return true, nil, errors.New("apiserver down")
		}
		return false, nil, nil
	})
	if w := serve(e.c.apiHandler(), "POST", "/api/v1/pair", "", jsonType, `{"code":"abcd"}`); w.Code != 503 {
		t.Fatalf("unreadable setup code: %d", w.Code)
	}
	// The device cannot be stored: no token is handed out.
	e = newEnv(t, setupCode("abcd"))
	e.kube.PrependReactor("create", "secrets", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("quota")
	})
	w := serve(e.c.apiHandler(), "POST", "/api/v1/pair", "", jsonType, `{"code":"abcd"}`)
	if w.Code != 500 || strings.Contains(w.Body.String(), "idea_") {
		t.Fatalf("store failure: %d %s", w.Code, w.Body.String())
	}
}

func TestReadBody(t *testing.T) {
	type in struct {
		Name string `json:"name"`
	}
	cases := []struct {
		name  string
		ctype string
		body  string
		ok    bool
	}{
		{"json", "application/json", `{"name":"a"}`, true},
		{"json with charset", "application/json; charset=utf-8", `{"name":"a"}`, true},
		{"no content type", "", `{"name":"a"}`, false},
		{"form", "application/x-www-form-urlencoded", `name=a`, false},
		{"unknown field", "application/json", `{"name":"a","x":1}`, false},
		{"wrong type", "application/json", `{"name":1}`, false},
		{"empty", "application/json", ``, false},
		{"just under the limit", "application/json", `{"name":"` + strings.Repeat("a", 64<<10-12) + `"}`, true},
		{"over the limit", "application/json", `{"name":"` + strings.Repeat("a", 64<<10) + `"}`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tc.body))
			if tc.ctype != "" {
				r.Header.Set("Content-Type", tc.ctype)
			}
			var v in
			err := readBody(r, &v)
			if (err == nil) != tc.ok {
				t.Fatalf("err = %v, want ok=%v", err, tc.ok)
			}
		})
	}
}

// authedEnv is an environment with one paired device; auth is its header.
func authedEnv(t *testing.T, objs ...runtime.Object) (e *testEnv, h http.Handler, auth string) {
	t.Helper()
	devs, tok := deviceSecret()
	e = newEnv(t, append(objs, devs)...)
	return e, e.c.apiHandler(), "Bearer " + tok
}

func TestAPIStatus(t *testing.T) {
	older := taskObj(1, map[string]any{"phase": phaseDone, "message": "merged"})
	older.SetCreationTimestamp(metav1.NewTime(time.Now().Add(-2 * time.Hour)))
	newer := taskObj(2, map[string]any{"phase": phaseGate, "pullRequest": int64(5), "vm": "idea-worker-0"})
	newer.SetCreationTimestamp(metav1.Now())
	keys := secret(testWorkNS, modelKeysSecret, map[string]string{"DEEPSEEK_API_KEY": "k"})
	_, h, auth := authedEnv(t, projectObj("shop", map[string]any{"description": "A shop"}), older, newer, keys)

	w := serve(h, "GET", "/api/v1/status", auth, "", "")
	if w.Code != 200 {
		t.Fatalf("status: %d %s", w.Code, w.Body.String())
	}
	var out struct {
		Host     string
		Git      string
		Projects []project
		Tasks    []taskRow
		Keys     map[string]bool
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Git != "https://idea.test/git/" || len(out.Projects) != 1 || out.Projects[0].Repo != "idea/shop" {
		t.Fatalf("status = %+v", out)
	}
	if !out.Keys["deepseek"] || out.Keys["claude"] {
		t.Fatalf("keys = %v", out.Keys)
	}
	if len(out.Tasks) != 2 || out.Tasks[0].Issue != 2 || out.Tasks[1].Issue != 1 {
		t.Fatalf("tasks not newest first: %+v", out.Tasks)
	}
	r := out.Tasks[0]
	if r.Project != "shop" || r.Phase != phaseGate || r.PullRequest != 5 || r.VM != "idea-worker-0" ||
		r.IssueURL != "https://idea.test/git/idea/shop/issues/2" {
		t.Fatalf("row = %+v", r)
	}
	if out.Tasks[1].Message != "merged" {
		t.Fatalf("message = %q", out.Tasks[1].Message)
	}
}

func TestAPIProjects(t *testing.T) {
	cases := []struct {
		name, body string
		want       int
		wantName   string
	}{
		{"created", `{"name":"shop","description":"A shop"}`, 201, "shop"},
		{"name normalized", `{"name":"  Blog "}`, 201, "blog"},
		{"duplicate", `{"name":"taken"}`, 409, ""},
		{"bad name", `{"name":"no_underscores"}`, 400, ""},
		{"empty name", `{"name":""}`, 400, ""},
		{"name too long", `{"name":"` + strings.Repeat("a", 41) + `"}`, 400, ""},
		{"description too long", `{"name":"x","description":"` + strings.Repeat("d", 501) + `"}`, 400, ""},
		{"unknown seed", `{"name":"x","seed":"nope"}`, 400, ""},
		{"bad seed", `{"name":"x","seed":"../etc"}`, 400, ""},
		{"unknown field", `{"name":"x","import":"https://example.org/r.git"}`, 400, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e, h, auth := authedEnv(t, projectObj("taken", nil))
			w := serve(h, "POST", "/api/v1/projects", auth, jsonType, tc.body)
			if w.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", w.Code, tc.want, w.Body.String())
			}
			list, _ := e.dyn.Resource(projectGVR).Namespace(testSystemNS).List(t.Context(), metav1.ListOptions{})
			if tc.want != 201 {
				if len(list.Items) != 1 {
					t.Fatalf("a refused request created a project: %d", len(list.Items))
				}
				return
			}
			var p project
			_ = json.Unmarshal(w.Body.Bytes(), &p)
			if p.Name != tc.wantName || p.Repo != "idea/"+tc.wantName {
				t.Fatalf("project = %+v", p)
			}
			if _, err := e.dyn.Resource(projectGVR).Namespace(testSystemNS).Get(t.Context(), tc.wantName, metav1.GetOptions{}); err != nil {
				t.Fatalf("project not stored: %v", err)
			}
		})
	}
}

func TestAPINewTaskValidation(t *testing.T) {
	cases := []struct {
		name, body string
		want       int
	}{
		{"no title", `{"project":"shop","title":"  "}`, 400},
		{"title too long", `{"project":"shop","title":"` + strings.Repeat("t", 201) + `"}`, 400},
		{"body too long", `{"project":"shop","title":"t","body":"` + strings.Repeat("b", 20001) + `"}`, 400},
		{"no such project", `{"project":"nope","title":"t"}`, 404},
		{"project outside the rules", `{"project":"../x","title":"t"}`, 404},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e, h, auth := authedEnv(t, projectObj("shop", nil))
			w := serve(h, "POST", "/api/v1/tasks", auth, jsonType, tc.body)
			if w.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if n := len(e.fj.received()); n != 0 {
				t.Fatalf("an issue was opened for a refused task (%d calls)", n)
			}
		})
	}
}

func TestAPITaskCancel(t *testing.T) {
	cases := []struct {
		phase string
		want  int
	}{
		{phaseGate, 200},
		{phasePending, 200},
		{phaseDone, 409},
		{phaseFailed, 409},
	}
	for _, tc := range cases {
		t.Run(tc.phase, func(t *testing.T) {
			task := taskObj(3, map[string]any{"phase": tc.phase, "message": "before"})
			e, h, auth := authedEnv(t, task)
			w := serve(h, "POST", "/api/v1/tasks/"+task.GetName()+"/cancel", auth, "", "")
			if w.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", w.Code, tc.want, w.Body.String())
			}
			got := e.task(t, task.GetName())
			if tc.want == 200 {
				if got.phase != phaseFailed || got.message() != "cancelled from dsh" {
					t.Fatalf("after cancel: %s %q", got.phase, got.message())
				}
			} else if got.phase != tc.phase || got.message() != "before" {
				t.Fatalf("an ended task was changed: %s %q", got.phase, got.message())
			}
		})
	}
	_, h, auth := authedEnv(t)
	if w := serve(h, "POST", "/api/v1/tasks/nope-issue-1/cancel", auth, "", ""); w.Code != 404 {
		t.Fatalf("unknown task: %d", w.Code)
	}
}

func TestAPITaskRetry(t *testing.T) {
	failed := map[string]any{"phase": phaseFailed, "message": "tests failed", "pullRequest": int64(4), "headSHA": "abc", "pullRequestURL": "u"}

	t.Run("not failed", func(t *testing.T) {
		task := taskObj(3, map[string]any{"phase": phaseGate})
		e, h, auth := authedEnv(t, task)
		if w := serve(h, "POST", "/api/v1/tasks/"+task.GetName()+"/retry", auth, jsonType, `{}`); w.Code != 409 {
			t.Fatalf("status %d", w.Code)
		}
		if e.task(t, task.GetName()).phase != phaseGate {
			t.Fatal("phase changed")
		}
	})
	t.Run("note too long", func(t *testing.T) {
		task := taskObj(3, failed)
		_, h, auth := authedEnv(t, task)
		body := `{"note":"` + strings.Repeat("n", 20001) + `"}`
		if w := serve(h, "POST", "/api/v1/tasks/"+task.GetName()+"/retry", auth, jsonType, body); w.Code != 400 {
			t.Fatalf("status %d", w.Code)
		}
	})
	t.Run("without note", func(t *testing.T) {
		task := taskObj(3, failed)
		e, h, auth := authedEnv(t, task)
		if w := serve(h, "POST", "/api/v1/tasks/"+task.GetName()+"/retry", auth, jsonType, `{}`); w.Code != 200 {
			t.Fatalf("status %d %s", w.Code, w.Body.String())
		}
		got := e.task(t, task.GetName())
		if got.phase != phasePending || got.pr != 0 || got.sha != "" || got.body != "Please." {
			t.Fatalf("after retry: %+v", got)
		}
		if n := len(e.fj.received()); n != 0 {
			t.Fatalf("no note, but %d Forgejo calls", n)
		}
	})
	t.Run("with note", func(t *testing.T) {
		task := taskObj(3, failed)
		e, h, auth := authedEnv(t, task)
		e.fj.on("POST /repos/idea/shop/issues/3/comments", 201, `{}`)
		if w := serve(h, "POST", "/api/v1/tasks/"+task.GetName()+"/retry", auth, jsonType, `{"note":"  use tabs "}`); w.Code != 200 {
			t.Fatalf("status %d %s", w.Code, w.Body.String())
		}
		got := e.task(t, task.GetName())
		if got.phase != phasePending || got.pr != 0 {
			t.Fatalf("after retry: %s pr=%d", got.phase, got.pr)
		}
		if got.body != "Please."+retryMarker+"use tabs" {
			t.Fatalf("body = %q", got.body)
		}
		calls := e.fj.called("POST /repos/idea/shop/issues/3/comments")
		if len(calls) != 1 || !strings.Contains(calls[0].Body, "use tabs") {
			t.Fatalf("comment calls = %+v", calls)
		}
		// The retry prompt carries the note.
		if p := e.c.retryPrompt(got); !strings.Contains(p, "Instruction from the owner:\nuse tabs") {
			t.Fatalf("retry prompt = %q", p)
		}
	})
}

func TestAPIKeys(t *testing.T) {
	t.Run("refused", func(t *testing.T) {
		for _, body := range []string{`{}`, `{"deepseek":"  "}`, `{"claude":"` + strings.Repeat("k", 513) + `"}`, `{"openai":"k"}`} {
			e, h, auth := authedEnv(t)
			if w := serve(h, "PUT", "/api/v1/keys", auth, jsonType, body); w.Code != 400 {
				t.Errorf("%s: status %d", body, w.Code)
			}
			if _, err := e.kube.CoreV1().Secrets(testWorkNS).Get(t.Context(), modelKeysSecret, metav1.GetOptions{}); err == nil {
				t.Errorf("%s: keys were stored", body)
			}
		}
	})
	t.Run("saved and dsh restarted", func(t *testing.T) {
		existing := secret(testWorkNS, modelKeysSecret, map[string]string{"CLAUDE_CODE_OAUTH_TOKEN": "old-claude"})
		dshPod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: testWorkNS, Name: "idea-dsh-0", Labels: map[string]string{"idea.dev/agent": "dsh"}}}
		otherPod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: testWorkNS, Name: "idea-worker-0", Labels: map[string]string{"idea.dev/agent": "worker"}}}
		e, h, auth := authedEnv(t, existing, dshPod, otherPod)
		if w := serve(h, "PUT", "/api/v1/keys", auth, jsonType, `{"deepseek":" new-ds "}`); w.Code != 200 {
			t.Fatalf("status %d %s", w.Code, w.Body.String())
		}
		// The work namespace's Secret keeps the Claude token and gets the new key.
		s, _ := e.kube.CoreV1().Secrets(testWorkNS).Get(t.Context(), modelKeysSecret, metav1.GetOptions{})
		if string(s.Data["DEEPSEEK_API_KEY"]) != "new-ds" || string(s.Data["CLAUDE_CODE_OAUTH_TOKEN"]) != "old-claude" {
			t.Fatalf("work keys = %v", s.Data)
		}
		// The system namespace had none: created with only the given key.
		s, err := e.kube.CoreV1().Secrets(testSystemNS).Get(t.Context(), modelKeysSecret, metav1.GetOptions{})
		if err != nil || s.StringData["DEEPSEEK_API_KEY"] != "new-ds" || len(s.StringData) != 1 {
			t.Fatalf("system keys = %v %v", s, err)
		}
		if _, err := e.kube.CoreV1().Pods(testWorkNS).Get(t.Context(), "idea-dsh-0", metav1.GetOptions{}); err == nil {
			t.Fatal("the agent dsh was not restarted")
		}
		if _, err := e.kube.CoreV1().Pods(testWorkNS).Get(t.Context(), "idea-worker-0", metav1.GetOptions{}); err != nil {
			t.Fatal("a worker VM was restarted too")
		}
	})
}

func TestAPIDshRefusesUnknownVM(t *testing.T) {
	for _, vm := range []string{"idea-worker-x", "kube-apiserver", "idea-worker-01", "../idea-dsh"} {
		_, h, auth := authedEnv(t)
		if w := serve(h, "GET", "/api/v1/dsh?vm="+vm, auth, "", ""); w.Code != 400 {
			t.Errorf("vm %q: status %d", vm, w.Code)
		}
	}
	// A worker VM without its NodePort Service is not reachable yet.
	_, h, auth := authedEnv(t)
	if w := serve(h, "GET", "/api/v1/dsh?vm=idea-worker-1", auth, "", ""); w.Code != 503 {
		t.Errorf("worker without NodePort: %d", w.Code)
	}
}

func TestAPITaskUnknown(t *testing.T) {
	_, h, auth := authedEnv(t)
	for _, p := range []string{"/api/v1/tasks/nope-issue-1", "/api/v1/tasks/nope-issue-1/retry"} {
		method := "GET"
		if strings.HasSuffix(p, "retry") {
			method = "POST"
		}
		if w := serve(h, method, p, auth, jsonType, `{}`); w.Code != 404 {
			t.Errorf("%s %s: %d", method, p, w.Code)
		}
	}
}

func TestRetryResetsPerAttemptCounters(t *testing.T) {
	task := taskObj(3, map[string]any{
		"phase": phaseFailed, "attempt": int64(2), "conflicts": int64(3), "publishFixes": int64(3),
		"reviewRounds": int64(3), "reviewVerdict": verdictChanges, "reviewSHA": "abc", "reviewApproved": "abc",
	})
	e := newEnv(t, task)
	if err := e.c.retryTask(t.Context(), e.task(t, task.GetName()), ""); err != nil {
		t.Fatal(err)
	}
	got := e.task(t, task.GetName())
	if got.attempt != 3 {
		t.Fatalf("attempt = %d, want 3", got.attempt)
	}
	for _, k := range []string{"conflicts", "publishFixes", "reviewRounds"} {
		if n := statusInt(got, k); n != 0 {
			t.Errorf("%s = %d after retry", k, n)
		}
	}
	for _, k := range []string{"reviewVerdict", "reviewSHA", "reviewApproved"} {
		if v := statusString(got, k); v != "" {
			t.Errorf("%s = %q after retry", k, v)
		}
	}
}

func TestRetryFirstAttemptIsOne(t *testing.T) {
	task := taskObj(3, map[string]any{"phase": phaseFailed})
	e := newEnv(t, task)
	v := e.task(t, task.GetName())
	if v.attempt != 1 {
		t.Fatalf("attempt = %d, want 1", v.attempt)
	}
	if err := e.c.retryTask(t.Context(), v, ""); err != nil {
		t.Fatal(err)
	}
	if got := e.task(t, task.GetName()); got.attempt != 2 {
		t.Fatalf("attempt = %d, want 2", got.attempt)
	}
}

func TestRequestIDsNeverRepeatAcrossAttempts(t *testing.T) {
	task := taskObj(3, map[string]any{"phase": phaseFailed})
	e := newEnv(t, task)
	seen := map[string]bool{}
	for range 3 {
		v := e.task(t, task.GetName())
		for _, kind := range []string{"prompt", "conflict", "publish", "review"} {
			for n := int64(1); n <= 3; n++ {
				id := v.requestID(kind, n)
				if seen[id] {
					t.Fatalf("request id %q repeated", id)
				}
				seen[id] = true
			}
		}
		if err := e.c.retryTask(t.Context(), v, ""); err != nil {
			t.Fatal(err)
		}
		// Counters back at zero by hand-reset or retry: the ids still differ.
		e.task(t, task.GetName())
		if err := e.c.setPhase(t.Context(), e.task(t, task.GetName()), phaseFailed, "x", nil); err != nil {
			t.Fatal(err)
		}
	}
}
