package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	k8stesting "k8s.io/client-go/testing"
)

func sign(secret, body string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(body))
	return hex.EncodeToString(m.Sum(nil))
}

func TestWebhook(t *testing.T) {
	const key = "hook-secret"
	opened := `{"action":"opened","issue":{"number":4,"title":"T","body":"B"},"repository":{"full_name":"other/repo"}}`
	cases := []struct {
		name    string
		body    string
		sig     string // X-Forgejo-Signature
		gitea   string // X-Gitea-Signature
		event   string
		failGet bool // the project lookup fails
		want    int
	}{
		{name: "no signature", body: opened, event: "issues", want: 401},
		{name: "wrong signature", body: opened, sig: sign("other", opened), event: "issues", want: 401},
		{name: "signature of another body", body: opened, sig: sign(key, opened+" "), event: "issues", want: 401},
		{name: "signature uppercase hex", body: opened, sig: strings.ToUpper(sign(key, opened)), event: "issues", want: 401},
		{name: "other event", body: `{}`, sig: sign(key, `{}`), event: "push", want: 204},
		{name: "gitea headers", body: `{"action":"closed"}`, gitea: sign(key, `{"action":"closed"}`), event: "issues", want: 204},
		{name: "bad payload", body: `{"action":`, sig: sign(key, `{"action":`), event: "issues", want: 400},
		{name: "issue closed", body: `{"action":"closed"}`, sig: sign(key, `{"action":"closed"}`), event: "issues", want: 204},
		{name: "repository outside the organisation", body: opened, sig: sign(key, opened), event: "issues", want: 204},
		{
			name: "repository without a project", event: "issues", want: 204,
			body: strings.Replace(opened, "other/repo", "idea/nope", 1), sig: sign(key, strings.Replace(opened, "other/repo", "idea/nope", 1)),
		},
		{
			name: "project lookup fails", event: "issues", want: 503, failGet: true,
			body: strings.Replace(opened, "other/repo", "idea/shop", 1), sig: sign(key, strings.Replace(opened, "other/repo", "idea/shop", 1)),
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			e.c.cfg.WebhookSecret = key
			if tc.failGet {
				e.dyn.PrependReactor("get", "projects", func(k8stesting.Action) (bool, runtime.Object, error) {
					return true, nil, errors.New("apiserver down")
				})
			}
			r := httptest.NewRequest(http.MethodPost, "/webhook/forgejo", strings.NewReader(tc.body))
			if tc.sig != "" {
				r.Header.Set("X-Forgejo-Signature", tc.sig)
				r.Header.Set("X-Forgejo-Event", tc.event)
			}
			if tc.gitea != "" {
				r.Header.Set("X-Gitea-Signature", tc.gitea)
				r.Header.Set("X-Gitea-Event", tc.event)
			}
			if tc.sig == "" && tc.gitea == "" {
				r.Header.Set("X-Forgejo-Event", tc.event)
			}
			w := httptest.NewRecorder()
			e.c.handleWebhook(w, r)
			if w.Code != tc.want {
				t.Fatalf("status %d, want %d", w.Code, tc.want)
			}
			list, _ := e.dyn.Resource(taskGVR).Namespace(testSystemNS).List(t.Context(), metav1.ListOptions{})
			if len(list.Items) != 0 {
				t.Fatalf("a task was created: %v", list.Items[0].GetName())
			}
		})
	}
}
