// Setup page: how the owner of a machine installed from the ISO hands over
// the model keys and gets the logins, without kubectl.
//
// The machine generates a setup code when it configures itself (see
// images/talos/setup) and shows it on its own console. Whoever can read the
// console owns the machine; the code is what this page asks for. The page is
// served over HTTPS with a certificate made at start, on a NodePort, because
// the ingress only answers to its host name.
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"html/template"
	"log/slog"
	"math/big"
	"net/http"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	setupSecretNS   = "kube-system"
	setupSecretName = "idea-setup"
	modelKeysSecret = "idea-model-keys"
)

// setupSecret reads what the machine planted for us: the setup code and the
// Talos admin configuration. Missing on clusters that were not installed
// from the ISO.
func (c *Controller) setupSecret(ctx context.Context) (code, talosconfig string, err error) {
	s, err := c.kube.CoreV1().Secrets(setupSecretNS).Get(ctx, setupSecretName, metav1.GetOptions{})
	if err != nil {
		return "", "", err
	}
	return strings.TrimSpace(string(s.Data["code"])), string(s.Data["talosconfig"]), nil
}

func normalizeCode(s string) string {
	return strings.ToLower(strings.NewReplacer("-", "", " ", "").Replace(strings.TrimSpace(s)))
}

// checkCode reports whether the submitted code is the machine's. A wrong
// code costs the caller a second, which is enough against guessing.
func (c *Controller) checkCode(ctx context.Context, given string) (talosconfig string, ok bool, err error) {
	want, tc, err := c.setupSecret(ctx)
	if err != nil {
		return "", false, err
	}
	a, b := normalizeCode(given), normalizeCode(want)
	if b == "" || subtle.ConstantTimeCompare([]byte(a), []byte(b)) != 1 {
		time.Sleep(time.Second)
		return "", false, nil
	}
	return tc, true, nil
}

func (c *Controller) hasModelKey(ctx context.Context) bool {
	s, err := c.kube.CoreV1().Secrets(c.cfg.WorkNS).Get(ctx, modelKeysSecret, metav1.GetOptions{})
	return err == nil && len(s.Data["DEEPSEEK_API_KEY"]) > 0
}

// saveModelKeys writes the keys to both namespaces that use them. An empty
// value leaves what is already stored alone.
func (c *Controller) saveModelKeys(ctx context.Context, deepseek, claude string) error {
	for _, ns := range []string{c.cfg.WorkNS, c.cfg.SystemNS} {
		api := c.kube.CoreV1().Secrets(ns)
		cur, err := api.Get(ctx, modelKeysSecret, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			data := map[string]string{}
			if deepseek != "" {
				data["DEEPSEEK_API_KEY"] = deepseek
			}
			if claude != "" {
				data["CLAUDE_CODE_OAUTH_TOKEN"] = claude
			}
			_, err = api.Create(ctx, &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{Name: modelKeysSecret, Labels: managedLabels()},
				StringData: data,
			}, metav1.CreateOptions{})
			if err != nil {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		if cur.Data == nil {
			cur.Data = map[string][]byte{}
		}
		if deepseek != "" {
			cur.Data["DEEPSEEK_API_KEY"] = []byte(deepseek)
		}
		if claude != "" {
			cur.Data["CLAUDE_CODE_OAUTH_TOKEN"] = []byte(claude)
		}
		if _, err := api.Update(ctx, cur, metav1.UpdateOptions{}); err != nil {
			return err
		}
	}
	return nil
}

type setupView struct {
	Available bool   // the machine planted a setup code
	Unlocked  bool   // a correct code was submitted with this request
	Code      string // echoed back into the forms of an unlocked page
	Error     string
	Notice    string
	HasKey    bool
	AdminUser string
	AdminPass string
	Host      string // address the browser used, without the port
	Repo      string
	HasTalos  bool
}

var setupPage = template.Must(template.New("setup").Parse(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>idea 설정</title>
<style>
:root { color-scheme: light dark; --fg:#1b1f24; --bg:#f6f7f9; --card:#fff; --line:#d5d9df; --accent:#1f6feb; --bad:#b42318; --ok:#1a7f37; }
@media (prefers-color-scheme: dark) { :root { --fg:#e6e8eb; --bg:#111418; --card:#1a1e24; --line:#30363d; --accent:#58a6ff; --bad:#ff7b72; --ok:#3fb950; } }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.6 system-ui, sans-serif; }
main { max-width:640px; margin:0 auto; padding:32px 16px 64px; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:17px; margin:0 0 12px; }
section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:20px; margin-top:16px; }
label { display:block; font-weight:600; margin-top:12px; } .hint { color:#6b7280; font-size:14px; margin:2px 0 0; }
input { width:100%; box-sizing:border-box; padding:10px; margin-top:6px; border:1px solid var(--line); border-radius:6px; background:transparent; color:inherit; font:inherit; }
button { margin-top:16px; padding:10px 18px; border:0; border-radius:6px; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
code, .mono { font-family:ui-monospace, monospace; word-break:break-all; }
.err { color:var(--bad); font-weight:600; } .ok { color:var(--ok); font-weight:600; }
dl { display:grid; grid-template-columns:max-content 1fr; gap:6px 16px; margin:0; } dt { color:#6b7280; } dd { margin:0; }
</style></head><body><main>
<h1>idea 설정</h1>
<p class="hint">이슈를 쓰면 에이전트가 코드를 고쳐 PR을 올리고, 테스트를 통과하면 머지합니다.</p>
{{if .Error}}<p class="err">{{.Error}}</p>{{end}}
{{if .Notice}}<p class="ok">{{.Notice}}</p>{{end}}

{{if not .Available}}
<section><h2>설정 코드가 없습니다</h2>
<p>이 클러스터는 설치 ISO로 만들어지지 않아 설정 코드가 없습니다. 모델 키는 클러스터 관리자가 <code>idea-model-keys</code> Secret으로 넣어야 합니다.</p></section>
{{else if not .Unlocked}}
<section><h2>설정 코드 입력</h2>
<p>설치한 기기의 화면(콘솔)에 표시된 설정 코드를 입력하세요.</p>
<form method="post" action="/">
<label for="code">설정 코드</label>
<input id="code" name="code" autocomplete="off" autofocus required>
<button type="submit">확인</button>
</form></section>
{{else}}
<section><h2>모델 키</h2>
<p>상태: {{if .HasKey}}<span class="ok">DeepSeek 키가 들어 있습니다</span>{{else}}<span class="err">DeepSeek 키가 없습니다. 넣어야 에이전트가 일합니다.</span>{{end}}</p>
<form method="post" action="/keys">
<input type="hidden" name="code" value="{{.Code}}">
<label for="deepseek">DeepSeek API 키</label>
<input id="deepseek" name="deepseek" type="password" autocomplete="off">
<label for="claude">Claude Code 토큰 (선택)</label>
<input id="claude" name="claude" type="password" autocomplete="off">
<p class="hint">비워 둔 칸은 지금 값을 그대로 둡니다. 키는 이 기기 안에만 저장됩니다.</p>
<button type="submit">저장</button>
</form></section>

<section><h2>사용하기</h2>
<dl>
<dt>주소</dt><dd><code>https://idea.internal/git/</code></dd>
<dt>계정</dt><dd class="mono">{{.AdminUser}}</dd>
<dt>비밀번호</dt><dd class="mono">{{.AdminPass}}</dd>
<dt>저장소</dt><dd class="mono">{{.Repo}}</dd>
</dl>
<p class="hint">접속하는 PC의 hosts 파일에 <code>{{.Host}} idea.internal</code> 한 줄을 넣어야 합니다. 인증서는 자체 서명이라 브라우저 경고가 뜹니다. 저장소에 이슈를 쓰면 작업이 시작됩니다.</p>
</section>

{{if .HasTalos}}
<section><h2>관리자 접근</h2>
<p>기기(Talos)와 Kubernetes를 직접 다루려면 관리자 설정 파일을 받으세요. 이 파일은 기기의 모든 권한입니다.</p>
<form method="post" action="/talosconfig">
<input type="hidden" name="code" value="{{.Code}}">
<button type="submit">talosconfig 내려받기</button>
</form>
<p class="hint"><code>talosctl --talosconfig talosconfig -e {{.Host}} -n {{.Host}} kubeconfig</code></p>
</section>
{{end}}
{{end}}
</main></body></html>`))

func (c *Controller) renderSetup(w http.ResponseWriter, r *http.Request, v setupView) {
	host := r.Host
	if i := strings.LastIndex(host, ":"); i > 0 {
		host = host[:i]
	}
	v.Host = host
	v.Repo = c.cfg.Org + "/" + c.cfg.Repo
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if err := setupPage.Execute(w, v); err != nil {
		slog.Warn("setup page", "err", err.Error())
	}
}

// unlock checks the code in the request and fills in what an owner may see.
func (c *Controller) unlock(w http.ResponseWriter, r *http.Request) (setupView, string, bool) {
	ctx := r.Context()
	v := setupView{Available: true}
	code := r.PostFormValue("code")
	tc, ok, err := c.checkCode(ctx, code)
	switch {
	case apierrors.IsNotFound(err):
		c.renderSetup(w, r, setupView{})
		return v, "", false
	case err != nil:
		slog.Warn("setup secret", "err", err.Error())
		v.Error = "설정 코드를 확인하지 못했습니다. 잠시 뒤 다시 시도하세요."
		c.renderSetup(w, r, v)
		return v, "", false
	case !ok:
		v.Error = "설정 코드가 맞지 않습니다."
		c.renderSetup(w, r, v)
		return v, "", false
	}
	v.Unlocked = true
	v.Code = code
	v.AdminUser, v.AdminPass = c.cfg.AdminUser, c.cfg.AdminPass
	v.HasTalos = tc != ""
	v.HasKey = c.hasModelKey(ctx)
	return v, tc, true
}

func (c *Controller) setupHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodPost {
			_, _, err := c.setupSecret(r.Context())
			c.renderSetup(w, r, setupView{Available: !apierrors.IsNotFound(err)})
			return
		}
		if v, _, ok := c.unlock(w, r); ok {
			c.renderSetup(w, r, v)
		}
	})
	mux.HandleFunc("/keys", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		v, _, ok := c.unlock(w, r)
		if !ok {
			return
		}
		deepseek := strings.TrimSpace(r.PostFormValue("deepseek"))
		claude := strings.TrimSpace(r.PostFormValue("claude"))
		if deepseek == "" && claude == "" {
			v.Error = "저장할 값이 없습니다."
		} else if err := c.saveModelKeys(r.Context(), deepseek, claude); err != nil {
			slog.Warn("save model keys", "err", err.Error())
			v.Error = "키를 저장하지 못했습니다."
		} else {
			slog.Info("model keys saved from the setup page")
			v.Notice = "저장했습니다. 다음 작업부터 적용됩니다."
			v.HasKey = c.hasModelKey(r.Context())
		}
		c.renderSetup(w, r, v)
	})
	mux.HandleFunc("/talosconfig", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		_, tc, ok := c.unlock(w, r)
		if !ok {
			return
		}
		w.Header().Set("Content-Type", "application/yaml")
		w.Header().Set("Content-Disposition", `attachment; filename="talosconfig"`)
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte(tc))
	})
	return http.MaxBytesHandler(mux, 64<<10)
}

// selfSignedCert makes a certificate for the setup page. Nothing can vouch
// for a machine that was just installed, so the browser will warn; the
// connection is still encrypted, which is what the keys need.
func selfSignedCert() (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	if err != nil {
		return tls.Certificate{}, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "idea setup"},
		DNSNames:              []string{"idea.internal"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(5, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}

func (c *Controller) setupServer() (*http.Server, error) {
	cert, err := selfSignedCert()
	if err != nil {
		return nil, err
	}
	return &http.Server{
		Addr:              ":8443",
		Handler:           c.setupHandler(),
		ReadHeaderTimeout: 10 * time.Second,
		TLSConfig:         &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12},
	}, nil
}
