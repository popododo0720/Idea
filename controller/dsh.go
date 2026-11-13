package main

// The machine's agent dsh (deploy/apps/dsh): projects are its workspaces,
// tasks are sessions in them. The controller drives it over dsh's Remote API
// (POST /api/<namespace>/<method>), signed in as an API operator.
//
// dsh has no configured credential: every process prints a fresh launch
// token in its startup line. The controller reads that line from the pod log
// (pods/log in the work namespace), exchanges it at /connect for a session
// cookie, and does it again whenever the pod changes or the cookie stops
// working. The same login URL is handed to paired devices (GET /api/v1/dsh),
// so the owner's dsh shows this one through the idea plugin.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	dshSelector  = "idea.dev/agent=dsh"
	dshTLSSecret = "idea-dsh-tls"
	// The authority every client sends (dsh's --trusted-host).
	dshAuthority = "idea-dsh.idea-work.svc:4443"
	// Where projects live inside the agent dsh (its persistent volume).
	dshProjects = "/home/idea/state/projects"
	// NodePort of the agent dsh (deploy/apps/dsh).
	dshNodePort = 30444
)

var launchToken = regexp.MustCompile(`[?&]token=([A-Za-z0-9_-]{20,})`)

type dshClient struct {
	c      *Controller
	mu     sync.Mutex
	pod    string // pod the token was read from
	token  string
	cookie string
}

// errDshNotReady means the agent dsh is not running (yet); callers wait.
var errDshNotReady = errors.New("the agent dsh is not running yet")

// remoteError is a failure dsh reported for one call.
type remoteError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *remoteError) Error() string { return "dsh: " + e.Code + ": " + e.Message }

func isRemote(err error, code string) bool {
	var re *remoteError
	return errors.As(err, &re) && re.Code == code
}

// httpClient trusts exactly the machine's API certificate, which the agent
// dsh serves as well (the controller copies it to the work namespace).
func (d *dshClient) httpClient(ctx context.Context) (*http.Client, error) {
	cert, err := d.c.apiCertificate(ctx)
	if err != nil {
		return nil, err
	}
	if len(cert.Certificate) == 0 {
		return nil, errors.New("no API certificate")
	}
	want := cert.Certificate[0]
	return &http.Client{
		Timeout: 60 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				MinVersion:         tls.VersionTLS12,
				InsecureSkipVerify: true, // replaced by the exact-certificate check below
				VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
					if len(raw) == 0 || !bytes.Equal(raw[0], want) {
						return errors.New("agent dsh presented an unexpected certificate")
					}
					return nil
				},
			},
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}, nil
}

// readyPod returns the running, ready agent dsh pod.
func (d *dshClient) readyPod(ctx context.Context) (*corev1.Pod, error) {
	pods, err := d.c.kube.CoreV1().Pods(d.c.cfg.WorkNS).List(ctx, metav1.ListOptions{LabelSelector: dshSelector})
	if err != nil {
		return nil, err
	}
	sort.Slice(pods.Items, func(i, j int) bool {
		return pods.Items[i].CreationTimestamp.After(pods.Items[j].CreationTimestamp.Time)
	})
	for i := range pods.Items {
		p := &pods.Items[i]
		if p.DeletionTimestamp == nil && podReady(p) {
			return p, nil
		}
	}
	return nil, errDshNotReady
}

// loginToken reads the launch token from the current pod's log.
func (d *dshClient) loginToken(ctx context.Context) (pod, token string, err error) {
	p, err := d.readyPod(ctx)
	if err != nil {
		return "", "", err
	}
	limit := int64(1 << 20)
	rc, err := d.c.kube.CoreV1().Pods(d.c.cfg.WorkNS).GetLogs(p.Name,
		&corev1.PodLogOptions{Container: "dsh", LimitBytes: &limit}).Stream(ctx)
	if err != nil {
		return "", "", err
	}
	defer rc.Close()
	sc := bufio.NewScanner(rc)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		if m := launchToken.FindStringSubmatch(sc.Text()); m != nil {
			token = m[1] // the last one printed wins
		}
	}
	if token == "" {
		return "", "", errDshNotReady
	}
	return p.Name, token, nil
}

// session returns a valid API cookie, signing in again when needed.
func (d *dshClient) session(ctx context.Context, fresh bool) (string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !fresh && d.cookie != "" {
		return d.cookie, nil
	}
	pod, token, err := d.loginToken(ctx)
	if err != nil {
		return "", err
	}
	hc, err := d.httpClient(ctx)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, "GET",
		"https://"+dshAuthority+"/connect?token="+token+"&interactions=none", nil)
	if err != nil {
		return "", err
	}
	res, err := hc.Do(req)
	if err != nil {
		return "", fmt.Errorf("agent dsh: %w", err)
	}
	res.Body.Close()
	var cookie string
	for _, ck := range res.Cookies() {
		cookie = ck.Name + "=" + ck.Value
	}
	if res.StatusCode != http.StatusFound || cookie == "" {
		return "", fmt.Errorf("agent dsh sign-in failed (HTTP %d)", res.StatusCode)
	}
	d.pod, d.token, d.cookie = pod, token, cookie
	return cookie, nil
}

// login returns the current launch token, for a paired device.
func (d *dshClient) login(ctx context.Context) (string, error) {
	_, token, err := d.loginToken(ctx)
	return token, err
}

// call runs one Remote method; request is passed as the method's single
// "request" argument and the result value is decoded into out.
func (d *dshClient) call(ctx context.Context, method string, request, out any) error {
	return d.callArgs(ctx, method, map[string]any{"request": request}, out)
}

func (d *dshClient) callArgs(ctx context.Context, method string, args map[string]any, out any) error {
	body, err := json.Marshal(map[string]any{
		"type": "client-request", "rpcId": "idea-" + randomHex(8), "method": method,
		"payload": map[string]any{"args": args},
	})
	if err != nil {
		return err
	}
	for attempt := 0; ; attempt++ {
		cookie, err := d.session(ctx, attempt > 0)
		if err != nil {
			return err
		}
		hc, err := d.httpClient(ctx)
		if err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, "POST", "https://"+dshAuthority+"/api/"+method, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Cookie", cookie)
		res, err := hc.Do(req)
		if err != nil {
			return fmt.Errorf("agent dsh: %w", err)
		}
		data, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
		res.Body.Close()
		if res.StatusCode == http.StatusUnauthorized && attempt == 0 {
			continue // the pod restarted or the cookie expired: sign in again
		}
		if res.StatusCode != http.StatusOK {
			return fmt.Errorf("agent dsh %s: HTTP %d: %s", method, res.StatusCode, strings.TrimSpace(string(data[:min(len(data), 300)])))
		}
		var env struct {
			Result struct {
				OK    bool            `json:"ok"`
				Value json.RawMessage `json:"value"`
				Error *remoteError    `json:"error"`
			} `json:"result"`
		}
		if err := json.Unmarshal(data, &env); err != nil {
			return fmt.Errorf("agent dsh %s: bad response: %w", method, err)
		}
		if !env.Result.OK {
			if env.Result.Error == nil {
				env.Result.Error = &remoteError{Code: "unknown", Message: "call failed"}
			}
			return env.Result.Error
		}
		if out != nil && len(env.Result.Value) > 0 {
			return json.Unmarshal(env.Result.Value, out)
		}
		return nil
	}
}

// --------------------------------------------------------------- workspace

// ensureWorkspace makes the project's directory a dsh workspace and returns
// its id. The directory starts empty; the agent clones the repository into
// it on its first task.
func (d *dshClient) ensureWorkspace(ctx context.Context, project string) (string, error) {
	path := dshProjects + "/" + project
	var out struct {
		Workspace struct {
			ID string `json:"workspaceId"`
		} `json:"workspace"`
	}
	err := d.call(ctx, "workspace/create", map[string]string{"path": path}, &out)
	if isRemote(err, "workspace/invalid-path") {
		var created string
		err := d.callArgs(ctx, "directoryPicker/createDirectory",
			map[string]any{"path": dshProjects, "name": project}, &created)
		if err != nil && !isRemote(err, "directory-picker/exists") {
			return "", fmt.Errorf("project directory: %w", err)
		}
		err = d.call(ctx, "workspace/create", map[string]string{"path": path}, &out)
	}
	if err != nil {
		return "", err
	}
	return out.Workspace.ID, nil
}

// ----------------------------------------------------------------- session

type dshState struct {
	Cursor       int64             `json:"cursor"`
	Active       bool              `json:"active"`
	Running      bool              `json:"running"`
	Queue        []json.RawMessage `json:"queue"`
	PendingInput []json.RawMessage `json:"pendingInput"`
}

// busy reports whether the agent is working or has work queued.
func (s dshState) busy() bool { return s.Running || len(s.Queue) > 0 }

func (d *dshClient) createSession(ctx context.Context, workspaceID, sessionID, title string) (string, error) {
	var out struct {
		SessionID string `json:"sessionId"`
	}
	if err := d.call(ctx, "session/create", map[string]string{"workspaceId": workspaceID, "sessionId": sessionID}, &out); err != nil {
		return "", err
	}
	if err := d.call(ctx, "session/rename", map[string]string{"sessionId": out.SessionID, "title": title}, nil); err != nil {
		return "", err
	}
	return out.SessionID, nil
}

func (d *dshClient) prompt(ctx context.Context, sessionID, requestID, text string) error {
	return d.call(ctx, "session/prompt", map[string]any{
		"requestId": requestID, "sessionId": sessionID, "mode": "queue",
		"content": []map[string]string{{"type": "text", "text": text}},
	}, nil)
}

func (d *dshClient) state(ctx context.Context, sessionID string) (dshState, error) {
	var s dshState
	err := d.call(ctx, "session/state", map[string]string{"sessionId": sessionID}, &s)
	return s, err
}

func (d *dshClient) cancel(ctx context.Context, sessionID string) error {
	return d.call(ctx, "session/cancel", map[string]string{"sessionId": sessionID}, nil)
}

// restartDsh deletes the agent dsh pod; its Deployment starts a new one.
func (c *Controller) restartDsh(ctx context.Context) error {
	pods := c.kube.CoreV1().Pods(c.cfg.WorkNS)
	list, err := pods.List(ctx, metav1.ListOptions{LabelSelector: dshSelector})
	if err != nil {
		return err
	}
	for _, p := range list.Items {
		if err := pods.Delete(ctx, p.Name, metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	return nil
}

// --------------------------------------------------------------------- TLS

// syncTLS copies the machine's API certificate to the work namespace, where
// the agent dsh serves it: the plugin pins one certificate for both.
func (c *Controller) syncDshTLS(ctx context.Context) error {
	if _, err := c.apiCertificate(ctx); err != nil {
		return err
	}
	src, err := c.kube.CoreV1().Secrets(c.cfg.SystemNS).Get(ctx, apiCertSecret, metav1.GetOptions{})
	if err != nil {
		return err
	}
	api := c.kube.CoreV1().Secrets(c.cfg.WorkNS)
	dst, err := api.Get(ctx, dshTLSSecret, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		_, err = api.Create(ctx, &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: dshTLSSecret, Labels: managedLabels()},
			Type:       corev1.SecretTypeTLS,
			Data:       src.Data,
		}, metav1.CreateOptions{})
		return err
	}
	if err != nil {
		return err
	}
	if bytes.Equal(dst.Data[corev1.TLSCertKey], src.Data[corev1.TLSCertKey]) &&
		bytes.Equal(dst.Data[corev1.TLSPrivateKeyKey], src.Data[corev1.TLSPrivateKeyKey]) {
		return nil
	}
	dst.Data = src.Data
	_, err = api.Update(ctx, dst, metav1.UpdateOptions{})
	return err
}
