package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	kubefake "k8s.io/client-go/kubernetes/fake"
)

func TestMain(m *testing.M) {
	// The delays against guessing only slow the tests down.
	authFailDelay, wrongCodeDelay = 0, 0
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	os.Exit(m.Run())
}

const (
	testSystemNS = "idea-system"
	testWorkNS   = "idea-work"
)

// fjCall is one request the fake Forgejo received.
type fjCall struct {
	Method string
	Path   string // without /api/v1
	Query  string
	Body   string
	User   string
}

// fjReply is what the fake Forgejo answers for one route.
type fjReply struct {
	Status int
	Type   string // Content-Type; application/json when empty
	Body   string
}

// fakeForgejo answers the routes it was given ("GET /repos/idea/x") and 404
// for everything else, and records every request.
type fakeForgejo struct {
	srv    *httptest.Server
	mu     sync.Mutex
	routes map[string]fjReply
	calls  []fjCall
	// then: once the key route was called, another route answers differently.
	then map[string]fjThen
}

type fjThen struct {
	route string
	reply fjReply
}

func newFakeForgejo(t *testing.T) *fakeForgejo {
	t.Helper()
	f := &fakeForgejo{routes: map[string]fjReply{}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		user, _, _ := r.BasicAuth()
		path := strings.TrimPrefix(r.URL.Path, "/api/v1")
		f.mu.Lock()
		f.calls = append(f.calls, fjCall{Method: r.Method, Path: path, Query: r.URL.RawQuery, Body: string(body), User: user})
		rep, ok := f.routes[r.Method+" "+path]
		if next, found := f.then[r.Method+" "+path]; found {
			f.routes[next.route] = next.reply
		}
		f.mu.Unlock()
		if !ok {
			rep = fjReply{Status: 404, Body: `{"message":"not found"}`}
		}
		if rep.Type == "" {
			rep.Type = "application/json"
		}
		w.Header().Set("Content-Type", rep.Type)
		if rep.Status == 0 {
			rep.Status = 200
		}
		w.WriteHeader(rep.Status)
		_, _ = io.WriteString(w, rep.Body)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeForgejo) on(route string, status int, body string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.routes[route] = fjReply{Status: status, Body: body}
}

func (f *fakeForgejo) onText(route string, status int, ctype, body string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.routes[route] = fjReply{Status: status, Type: ctype, Body: body}
}

// onThen sets route to reply; once route was called, thenRoute answers thenReply.
func (f *fakeForgejo) onThen(route string, reply fjReply, thenRoute string, thenReply fjReply) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.routes[route] = reply
	if f.then == nil {
		f.then = map[string]fjThen{}
	}
	f.then[route] = fjThen{thenRoute, thenReply}
}

func (f *fakeForgejo) client() *Forgejo { return NewForgejo(f.srv.URL+"/", "admin", "pw") }

func (f *fakeForgejo) received() []fjCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fjCall(nil), f.calls...)
}

// called returns the requests made to one route ("POST /orgs").
func (f *fakeForgejo) called(route string) []fjCall {
	var out []fjCall
	for _, c := range f.received() {
		if c.Method+" "+c.Path == route {
			out = append(out, c)
		}
	}
	return out
}

type testEnv struct {
	c    *Controller
	kube *kubefake.Clientset
	dyn  *dynamicfake.FakeDynamicClient
	fj   *fakeForgejo
}

// newEnv builds a controller on fake Kubernetes clients and a fake Forgejo.
// Objects are sorted by type: typed ones go to the clientset, unstructured
// ones (Tasks, Projects) to the dynamic client.
func newEnv(t *testing.T, objs ...runtime.Object) *testEnv {
	t.Helper()
	var typed, dyn []runtime.Object
	for _, o := range objs {
		if _, ok := o.(*unstructured.Unstructured); ok {
			dyn = append(dyn, o)
		} else {
			typed = append(typed, o)
		}
	}
	e := &testEnv{
		kube: kubefake.NewClientset(typed...),
		dyn: dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
			map[schema.GroupVersionResource]string{taskGVR: "TaskList", projectGVR: "ProjectList"}, dyn...),
		fj: newFakeForgejo(t),
	}
	e.c = &Controller{
		cfg: Config{
			Org: "idea", Host: "idea.test", SystemNS: testSystemNS, WorkNS: testWorkNS,
			GateMode: "actions", WorkerSlots: 2, MaxWorkers: 4, ExamplesDir: t.TempDir(),
		},
		kube: e.kube,
		dyn:  e.dyn,
		fj:   e.fj.client(),
	}
	e.c.dsh = e.c.newDshClient("")
	e.c.workers = newWorkerPool(e.c)
	return e
}

func secret(ns, name string, data map[string]string) *corev1.Secret {
	s := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name}, Data: map[string][]byte{}}
	for k, v := range data {
		s.Data[k] = []byte(v)
	}
	return s
}

// deviceSecret is the idea-devices Secret with one paired device
// (testDevice, named "laptop"); the returned token authenticates as it.
func deviceSecret() (*corev1.Secret, string) {
	d, _ := json.Marshal(device{Name: "laptop", Hash: hashSecret(testSecret), Created: "2026-01-02T03:04:05Z"})
	s := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Namespace: testSystemNS, Name: devicesSecret},
		Data:       map[string][]byte{testDevice: d},
	}
	return s, "idea_" + testDevice + "_" + testSecret
}

// taskObj is a Task in the system namespace for repository idea/shop.
func taskObj(issue int64, status map[string]any) *unstructured.Unstructured {
	const project = "shop"
	u := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "idea.dev/v1alpha1",
		"kind":       "Task",
		"metadata": map[string]any{
			"name": taskName("idea/"+project, issue), "namespace": testSystemNS,
			"creationTimestamp": time.Now().UTC().Add(-time.Hour).Format(time.RFC3339),
		},
		"spec": map[string]any{"repo": "idea/" + project, "issue": issue, "title": "Do it", "body": "Please."},
	}}
	if status != nil {
		u.Object["status"] = status
	}
	return u
}

func projectObj(name string, spec map[string]any) *unstructured.Unstructured {
	if spec == nil {
		spec = map[string]any{}
	}
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "idea.dev/v1alpha1",
		"kind":       "Project",
		"metadata":   map[string]any{"name": name, "namespace": testSystemNS},
		"spec":       spec,
	}}
}

// task reads a Task back from the fake cluster.
func (e *testEnv) task(t *testing.T, name string) taskView {
	t.Helper()
	u, err := e.dyn.Resource(taskGVR).Namespace(testSystemNS).Get(t.Context(), name, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get task %s: %v", name, err)
	}
	return viewOf(u)
}

// serve sends one request to h and returns the recorder. auth is the whole
// Authorization header ("" for none).
func serve(h http.Handler, method, path, auth, ctype, body string) *httptest.ResponseRecorder {
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	r := httptest.NewRequest(method, path, rd)
	if auth != "" {
		r.Header.Set("Authorization", auth)
	}
	if ctype != "" {
		r.Header.Set("Content-Type", ctype)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

// errorOf decodes {"error": ...}.
func errorOf(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var e struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &e); err != nil {
		t.Fatalf("not a JSON error: %q", w.Body.String())
	}
	return e.Error
}
