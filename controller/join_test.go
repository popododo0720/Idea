package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

var testWorkerConfig = "version: v1alpha1\nmachine:\n  type: worker\n  token: " + strings.Join([]string{"fake", "join", "token"}, "-") + "\n  ca:\n    crt: Q0E=\n"

func joinSetup() *corev1.Secret {
	return secret(setupSecretNS, setupSecretName, map[string]string{
		"code": "abcd-efgh-jkmn", "talosconfig": "ADMIN-TALOSCONFIG-SECRET", "workerconfig": testWorkerConfig,
	})
}

func joinEnv(t *testing.T, objs ...runtime.Object) (*testEnv, http.Handler, string) {
	t.Helper()
	devs, tok := deviceSecret()
	e := newEnv(t, append(objs, devs)...)
	return e, e.c.apiHandler(), "Bearer " + tok
}

func issue(t *testing.T, h http.Handler, auth string) string {
	t.Helper()
	w := serve(h, "POST", "/api/v1/nodes/join-code", auth, jsonType, `{}`)
	if w.Code != 200 {
		t.Fatalf("issue: %d %s", w.Code, w.Body.String())
	}
	var out struct {
		Code         string `json:"code"`
		ExpiresAt    string `json:"expiresAt"`
		ValidMinutes int    `json:"validMinutes"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$`).MatchString(out.Code) || out.ValidMinutes != 30 {
		t.Fatalf("answer %+v", out)
	}
	return out.Code
}

func redeem(h http.Handler, code string) *httptest.ResponseRecorder {
	return serve(h, "POST", "/api/v1/nodes/join", "", jsonType, `{"code":"`+code+`"}`)
}

func TestJoinIssueNeedsDevice(t *testing.T) {
	e, h, _ := joinEnv(t, joinSetup())
	if w := serve(h, "POST", "/api/v1/nodes/join-code", "", jsonType, `{}`); w.Code != 401 {
		t.Fatalf("no token: %d", w.Code)
	}
	if w := serve(h, "POST", "/api/v1/nodes/join-code", "Bearer idea_"+testDevice+"_nope", jsonType, `{}`); w.Code != 401 {
		t.Fatalf("bad token: %d", w.Code)
	}
	if _, err := e.kube.CoreV1().Secrets(testSystemNS).Get(t.Context(), joinSecret, metav1.GetOptions{}); err == nil {
		t.Fatal("a code was stored for an unauthenticated call")
	}
}

func TestJoinIssueNoWorkerConfig(t *testing.T) {
	old := secret(setupSecretNS, setupSecretName, map[string]string{"code": "abcd", "talosconfig": "tc"})
	_, h, auth := joinEnv(t, old)
	if w := serve(h, "POST", "/api/v1/nodes/join-code", auth, jsonType, `{}`); w.Code != 409 {
		t.Fatalf("old install: %d", w.Code)
	}
	_, h, auth = joinEnv(t)
	if w := serve(h, "POST", "/api/v1/nodes/join-code", auth, jsonType, `{}`); w.Code != 409 {
		t.Fatalf("no install secret: %d", w.Code)
	}
}

func TestJoinSingleUse(t *testing.T) {
	e, h, auth := joinEnv(t, joinSetup())
	code := issue(t, h, auth)
	// Stored hashed only.
	s, _ := e.kube.CoreV1().Secrets(testSystemNS).Get(t.Context(), joinSecret, metav1.GetOptions{})
	if strings.Contains(string(s.Data["hash"]), strings.ReplaceAll(code, "-", "")) || len(s.Data["hash"]) == 0 {
		t.Fatal("the code is stored in clear")
	}
	w := redeem(h, strings.ToUpper(code))
	if w.Code != 200 || w.Body.String() != testWorkerConfig {
		t.Fatalf("redeem: %d %q", w.Code, w.Body.String())
	}
	if w.Header().Get("Content-Type") != "application/yaml" {
		t.Fatalf("content type %q", w.Header().Get("Content-Type"))
	}
	if w := redeem(h, code); w.Code != 401 {
		t.Fatalf("second use: %d", w.Code)
	}
}

func TestJoinReissueReplacesOldCode(t *testing.T) {
	_, h, auth := joinEnv(t, joinSetup())
	first := issue(t, h, auth)
	second := issue(t, h, auth)
	if w := redeem(h, first); w.Code != 401 {
		t.Fatalf("old code: %d", w.Code)
	}
	if w := redeem(h, second); w.Code != 200 {
		t.Fatalf("new code: %d", w.Code)
	}
}

func TestJoinExpiry(t *testing.T) {
	_, h, auth := joinEnv(t, joinSetup())
	base := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	joinNow = func() time.Time { return base }
	t.Cleanup(func() { joinNow = time.Now })
	code := issue(t, h, auth)
	joinNow = func() time.Time { return base.Add(30*time.Minute + time.Second) }
	if w := redeem(h, code); w.Code != 401 {
		t.Fatalf("expired: %d", w.Code)
	}
	code = issue(t, h, auth)
	joinNow = func() time.Time { return base.Add(30*time.Minute + time.Second + 29*time.Minute) }
	if w := redeem(h, code); w.Code != 200 {
		t.Fatalf("just before expiry: %d", w.Code)
	}
}

func TestJoinWrongCode(t *testing.T) {
	e, h, auth := joinEnv(t, joinSetup())
	for _, body := range []string{`{"code":"wrong-code-0000"}`, `{"code":""}`, `{"code":"abcd-efgh-jkmn"}`} {
		if w := serve(h, "POST", "/api/v1/nodes/join", "", jsonType, body); w.Code != 401 {
			t.Fatalf("no code issued, %s: %d", body, w.Code)
		}
	}
	code := issue(t, h, auth)
	for _, body := range []string{`{"code":"wrong-code-0000"}`, `{"code":""}`} {
		if w := serve(h, "POST", "/api/v1/nodes/join", "", jsonType, body); w.Code != 401 || strings.Contains(w.Body.String(), "machine:") {
			t.Fatalf("%s: %d", body, w.Code)
		}
	}
	// The setup code does not open the join endpoint.
	if w := redeem(h, "abcd-efgh-jkmn"); w.Code != 401 {
		t.Fatalf("setup code: %d", w.Code)
	}
	// Wrong tries did not use the real code up.
	if w := redeem(h, code); w.Code != 200 {
		t.Fatalf("real code after wrong tries: %d", w.Code)
	}
	if w := serve(h, "POST", "/api/v1/nodes/join", "", "text/plain", `x`); w.Code != 400 {
		t.Fatalf("not JSON: %d", w.Code)
	}
	_ = e
}

func TestJoinWrongCodeIsSlowed(t *testing.T) {
	_, h, _ := joinEnv(t, joinSetup())
	wrongCodeDelay = 60 * time.Millisecond
	t.Cleanup(func() { wrongCodeDelay = 0 })
	start := time.Now()
	for range 3 {
		if w := redeem(h, "nope-nope-nope"); w.Code != 401 {
			t.Fatalf("status %d", w.Code)
		}
	}
	if d := time.Since(start); d < 150*time.Millisecond {
		t.Fatalf("three wrong codes took only %v", d)
	}
}

func TestJoinRateLimitIsShared(t *testing.T) {
	_, h, auth := joinEnv(t, joinSetup())
	issue(t, h, auth)
	wrongCodeDelay = 80 * time.Millisecond
	t.Cleanup(func() { wrongCodeDelay = 0 })
	start := time.Now()
	done := make(chan struct{})
	for range 4 {
		go func() {
			redeem(h, "nope-nope-nope")
			done <- struct{}{}
		}()
	}
	for range 4 {
		<-done
	}
	if d := time.Since(start); d < 300*time.Millisecond {
		t.Fatalf("parallel guesses took only %v: not serialized", d)
	}
}

func TestJoinConfigHasNoAdminSecrets(t *testing.T) {
	_, h, auth := joinEnv(t, joinSetup())
	code := issue(t, h, auth)
	w := redeem(h, code)
	body := w.Body.String()
	for _, secretText := range []string{"ADMIN-TALOSCONFIG-SECRET", "abcd-efgh-jkmn", "talosconfig", "idea-bootstrap"} {
		if strings.Contains(body, secretText) {
			t.Fatalf("the answer carries %q", secretText)
		}
	}
	if !strings.Contains(body, "type: worker") {
		t.Fatal("not a worker configuration")
	}
}

type fixedReader struct {
	b []byte
	i int
}

func (f *fixedReader) Read(p []byte) (int, error) {
	if f.i >= len(f.b) {
		return 0, io.EOF
	}
	n := copy(p, f.b[f.i:])
	f.i += n
	return n, nil
}

func TestJoinCodeRejectsBiasedBytes(t *testing.T) {
	// 248 is the first byte of the biased tail (256 - 256%31); it must be dropped.
	in := []byte{248, 255, 250, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14}
	code, err := joinCodeFrom(&fixedReader{b: append(in, make([]byte, 32)...)})
	if err != nil {
		t.Fatal(err)
	}
	want := ""
	for _, b := range append(in[3:], 0) {
		want += string(joinAlphabet[int(b)%len(joinAlphabet)])
	}
	want = want[:12]
	if strings.ReplaceAll(code, "-", "") != want {
		t.Fatalf("code %q, want letters %q", code, want)
	}
}

func TestJoinCodeReadError(t *testing.T) {
	if _, err := joinCodeFrom(&fixedReader{b: []byte{1, 2}}); err == nil {
		t.Fatal("a short random source must fail")
	}
}

func TestJoinCodeUniform(t *testing.T) {
	counts := map[rune]int{}
	const codes = 20000
	for range codes {
		c, err := newJoinCode()
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range strings.ReplaceAll(c, "-", "") {
			counts[r]++
		}
	}
	if len(counts) != len(joinAlphabet) {
		t.Fatalf("%d distinct characters, want %d", len(counts), len(joinAlphabet))
	}
	exp := float64(codes*12) / float64(len(joinAlphabet))
	for r, n := range counts {
		if d := float64(n) - exp; d > exp*0.1 || d < -exp*0.1 {
			t.Fatalf("character %q seen %d times, expected about %.0f", r, n, exp)
		}
	}
}
