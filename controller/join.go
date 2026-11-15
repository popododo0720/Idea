package main

// Join codes: how a second machine booted from the installer ISO becomes an
// extra node of this one.
//
// The owner asks for a code in the idea panel (POST /api/v1/nodes/join-code,
// paired devices only). The code is good for 30 minutes and for one use. The
// joining machine presents it (POST /api/v1/nodes/join, the one call besides
// pairing that carries no device token) and gets back the Talos worker
// machine configuration. That configuration was generated on this machine at
// install time, from its own secrets, and planted in the Secret idea-setup
// (key workerconfig). A Talos worker needs the cluster CA certificate and its
// join tokens and nothing else: the admin talosconfig and every private key
// stay here. Only the hash of the code is stored.

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	joinSecret   = "idea-join"
	joinValidity = 30 * time.Minute
	joinAlphabet = "abcdefghjkmnpqrstuvwxyz23456789"
)

// joinNow is the clock of join codes (tests replace it).
var joinNow = time.Now

// newJoinCode draws 12 characters uniformly from joinAlphabet. Bytes at or
// above the largest multiple of the alphabet size are dropped, so no
// character is more likely than another.
func newJoinCode() (string, error) {
	return joinCodeFrom(rand.Reader)
}

func joinCodeFrom(r io.Reader) (string, error) {
	const limit = 256 - 256%len(joinAlphabet)
	code := make([]byte, 0, 12)
	buf := make([]byte, 16)
	for len(code) < 12 {
		if _, err := io.ReadFull(r, buf); err != nil {
			return "", err
		}
		for _, b := range buf {
			if int(b) < limit && len(code) < 12 {
				code = append(code, joinAlphabet[int(b)%len(joinAlphabet)])
			}
		}
	}
	s := string(code)
	return s[:4] + "-" + s[4:8] + "-" + s[8:], nil
}

// workerConfig is the worker machine configuration the install planted.
func (c *Controller) workerConfig(ctx context.Context) (string, error) {
	s, err := c.kube.CoreV1().Secrets(setupSecretNS).Get(ctx, setupSecretName, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	return string(s.Data["workerconfig"]), nil
}

// issueJoinCode makes a new code; it replaces any code issued before.
func (c *Controller) issueJoinCode(ctx context.Context) (code string, expires time.Time, err error) {
	code, err = newJoinCode()
	if err != nil {
		return "", time.Time{}, err
	}
	expires = joinNow().Add(joinValidity).UTC()
	data := map[string][]byte{
		"hash":    []byte(hashSecret(normalizeCode(code))),
		"expires": []byte(expires.Format(time.RFC3339)),
	}
	c.joinMu.Lock()
	defer c.joinMu.Unlock()
	api := c.kube.CoreV1().Secrets(c.cfg.SystemNS)
	cur, err := api.Get(ctx, joinSecret, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		_, err = api.Create(ctx, &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: joinSecret, Labels: managedLabels()},
			Data:       data,
		}, metav1.CreateOptions{})
		return code, expires, err
	}
	if err != nil {
		return "", time.Time{}, err
	}
	cur.Data = data
	_, err = api.Update(ctx, cur, metav1.UpdateOptions{})
	return code, expires, err
}

type joinResult int

const (
	joinOK joinResult = iota
	joinRefused
	joinError
)

// redeemJoinCode checks the code and, if it is the live one, uses it up and
// returns the worker configuration. A refused code costs the caller
// wrongCodeDelay, and the delay is served while holding the lock, so guessing
// is limited to one try per delay for everybody together.
func (c *Controller) redeemJoinCode(ctx context.Context, given string) (string, joinResult) {
	c.joinMu.Lock()
	defer c.joinMu.Unlock()
	refuse := func() (string, joinResult) {
		time.Sleep(wrongCodeDelay)
		return "", joinRefused
	}
	api := c.kube.CoreV1().Secrets(c.cfg.SystemNS)
	s, err := api.Get(ctx, joinSecret, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return refuse()
	}
	if err != nil {
		slog.Warn("join secret", "err", err.Error())
		return "", joinError
	}
	hash := string(s.Data["hash"])
	exp, perr := time.Parse(time.RFC3339, string(s.Data["expires"]))
	want := hashSecret(normalizeCode(given))
	if hash == "" || perr != nil || subtle.ConstantTimeCompare([]byte(hash), []byte(want)) != 1 || !joinNow().Before(exp) {
		return refuse()
	}
	cfg, err := c.workerConfig(ctx)
	if err != nil || strings.TrimSpace(cfg) == "" {
		return "", joinError
	}
	s.Data = map[string][]byte{}
	if _, err := api.Update(ctx, s, metav1.UpdateOptions{}); err != nil {
		slog.Warn("join code not used up", "err", err.Error())
		return "", joinError
	}
	return cfg, joinOK
}

func (c *Controller) registerJoinRoutes(open, authed *http.ServeMux) {
	open.HandleFunc("POST /api/v1/nodes/join", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Code string `json:"code"`
		}
		if err := readBody(r, &in); err != nil {
			writeError(w, 400, err.Error())
			return
		}
		cfg, res := c.redeemJoinCode(r.Context(), in.Code)
		switch res {
		case joinRefused:
			writeError(w, 401, "wrong, used or expired join code")
		case joinError:
			writeError(w, 503, "could not use the join code; try again")
		default:
			slog.Info("node join code used")
			w.Header().Set("Content-Type", "application/yaml")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write([]byte(cfg))
		}
	})

	authed.HandleFunc("POST /api/v1/nodes/join-code", func(w http.ResponseWriter, r *http.Request) {
		cfg, err := c.workerConfig(r.Context())
		if apierrors.IsNotFound(err) || (err == nil && strings.TrimSpace(cfg) == "") {
			writeError(w, 409, "this machine has no worker configuration (it was installed before nodes could join); reinstall it from a current ISO")
			return
		}
		if err != nil {
			writeError(w, 503, "could not read the worker configuration; try again")
			return
		}
		code, exp, err := c.issueJoinCode(r.Context())
		if err != nil {
			slog.Warn("join code", "err", err.Error())
			writeError(w, 500, "could not store the join code")
			return
		}
		slog.Info("node join code issued", "device", r.Header.Get("X-Idea-Device"))
		writeJSON(w, 200, map[string]any{"code": code, "expiresAt": exp.Format(time.RFC3339), "validMinutes": int(joinValidity.Minutes())})
	})
}
