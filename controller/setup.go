// Setup page: the first page the owner of a machine installed from the ISO
// opens. It tells how to connect DeepSeek Harness (the idea plugin, where all
// the work is done) and hands out the logins, without kubectl.
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
	"embed"
	"encoding/pem"
	"html/template"
	"io/fs"
	"log/slog"
	"math/big"
	"net"
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
	apiCertSecret   = "idea-api-tls"
)

// The design system (console/design), copied next to the sources by the
// Dockerfile.
//
//go:embed design
var designFS embed.FS

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
	AdminUser string
	AdminPass string
	Addr      string // address the browser used, with the port
	Host      string // name the machine answers to (IDEA_HOST)
	IP        string // address the browser used, without the port
	HasTalos  bool
	Plugin    string // what to give `dsh plugin add`
}

var setupPage = template.Must(template.New("setup").Parse(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>idea 설정</title>
<link rel="stylesheet" href="/design/idea.css">
</head><body>
<main class="page-narrow" style="max-width:560px">
<div class="brand" style="margin-bottom:32px"><span class="brand-mark">i</span>idea</div>
<div class="stack">
{{if .Error}}<div class="alert alert-bad"><div>{{.Error}}</div></div>{{end}}
{{if not .Available}}
<div class="stack-sm"><h1>설정 코드가 없습니다</h1>
<p class="muted">이 기기는 설치 ISO로 만들어지지 않았습니다. 클러스터 관리자가 직접 설정해야 합니다.</p></div>
{{else if not .Unlocked}}
<div class="stack-sm"><h1>설정 코드 입력</h1>
<p class="muted">기기 콘솔 화면의 <span class="mono">setup code</span> 줄에 있는 12자리 코드입니다.</p></div>
<form class="stack" method="post" action="/">
<div class="field"><label class="label" for="code">설정 코드</label>
<input class="input code-input" id="code" name="code" placeholder="xxxx-xxxx-xxxx" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" autofocus required></div>
<button class="btn btn-primary btn-block" type="submit">계속</button>
</form>
{{else}}
<div class="stack-sm"><h1>dsh에 연결하기</h1>
<p class="muted">작업, 세션, 프로젝트, 모델 키는 모두 DeepSeek Harness의 idea 패널에서 다룹니다. 쓰는 PC마다 한 번 연결하면 됩니다.</p></div>
<ol class="steps">
<li class="now"><div class="stack-sm"><strong>플러그인 설치</strong>
<div class="copy"><span class="mono">dsh plugin add {{.Plugin}}</span></div></div></li>
<li class="todo"><div class="stack-sm"><strong>idea 패널에서 이 기기 연결</strong>
<dl class="kv"><dt>주소</dt><dd class="mono">https://{{.Addr}}</dd><dt>설정 코드</dt><dd class="mono">{{.Code}}</dd></dl></div></li>
</ol>

<div class="card"><div class="card-head"><h2>Git (Forgejo)</h2></div><div class="card-body">
<dl class="kv">
<dt>주소</dt><dd class="mono">https://{{.Host}}/git/</dd>
<dt>계정</dt><dd class="mono">{{.AdminUser}}</dd>
<dt>비밀번호</dt><dd class="mono">{{.AdminPass}}</dd>
</dl>
<p class="hint">DNS나 hosts 파일에서 <span class="mono">{{.Host}}</span>을 <span class="mono">{{.IP}}</span>로 연결하세요. 인증서는 이 기기가 직접 만든 것이라 브라우저가 경고합니다.</p>
</div></div>

{{if .HasTalos}}
<div class="card"><div class="card-head"><h2>관리자 접근</h2></div><div class="card-body stack-sm">
<p class="small muted">기기(Talos)와 Kubernetes를 직접 다루는 설정 파일입니다. 이 파일은 기기의 모든 권한입니다.</p>
<form method="post" action="/talosconfig"><input type="hidden" name="code" value="{{.Code}}">
<button class="btn" type="submit">talosconfig 내려받기</button></form>
<p class="xs subtle mono">talosctl --talosconfig talosconfig -e {{.IP}} -n {{.IP}} kubeconfig</p>
</div></div>
{{end}}
{{end}}
</div>
</main></body></html>`))

func (c *Controller) renderSetup(w http.ResponseWriter, r *http.Request, v setupView) {
	v.Addr = r.Host
	v.IP = r.Host
	if h, _, err := net.SplitHostPort(r.Host); err == nil {
		v.IP = h
	}
	v.Host = c.cfg.Host
	v.Plugin = c.cfg.PluginSource
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'")
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
	v.Code = strings.TrimSpace(code)
	v.AdminUser, v.AdminPass = c.cfg.AdminUser, c.cfg.AdminPass
	v.HasTalos = tc != ""
	return v, tc, true
}

func (c *Controller) setupHandler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/api/v1/", c.apiHandler())
	design, _ := fs.Sub(designFS, "design")
	mux.Handle("GET /design/", http.StripPrefix("/design/", http.FileServerFS(design)))
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

// apiCertificate returns the certificate of the setup page and the API. It
// is made once and kept in a Secret: the dsh plugin pins it when pairing, so
// it must not change when the controller restarts. Nothing can vouch for a
// machine that was just installed, so browsers warn; the connection is still
// encrypted, and the plugin checks it is talking to the machine it paired with.
func (c *Controller) apiCertificate(ctx context.Context) (tls.Certificate, error) {
	api := c.kube.CoreV1().Secrets(c.cfg.SystemNS)
	s, err := api.Get(ctx, apiCertSecret, metav1.GetOptions{})
	if err == nil {
		return tls.X509KeyPair(s.Data[corev1.TLSCertKey], s.Data[corev1.TLSPrivateKeyKey])
	}
	if !apierrors.IsNotFound(err) {
		return tls.Certificate{}, err
	}
	certPEM, keyPEM, err := selfSignedCert(c.cfg.Host)
	if err != nil {
		return tls.Certificate{}, err
	}
	_, err = api.Create(ctx, &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: apiCertSecret, Labels: managedLabels()},
		Type:       corev1.SecretTypeTLS,
		Data:       map[string][]byte{corev1.TLSCertKey: certPEM, corev1.TLSPrivateKeyKey: keyPEM},
	}, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		return c.apiCertificate(ctx) // another replica made it first
	}
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.X509KeyPair(certPEM, keyPEM)
}

func selfSignedCert(host string) (certPEM, keyPEM []byte, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	if err != nil {
		return nil, nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "idea"},
		DNSNames:              []string{host},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, err
	}
	kd, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kd}), nil
}

func (c *Controller) setupServer(ctx context.Context) (*http.Server, error) {
	cert, err := c.apiCertificate(ctx)
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
