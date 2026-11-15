package main

import (
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const workerYAML = "version: v1alpha1\nmachine:\n  type: worker\n"

func tlsServer(t *testing.T, hits *int) (addr, fp string) {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		*hits++
		_, _ = w.Write([]byte(workerYAML))
	}))
	t.Cleanup(srv.Close)
	sum := sha256.Sum256(srv.Certificate().Raw)
	return strings.TrimPrefix(srv.URL, "https://"), fmt.Sprintf("%x", sum)
}

func TestJoinWithFingerprint(t *testing.T) {
	hits := 0
	addr, fp := tlsServer(t, &hits)
	out, err := join(addr, "abcd-efgh-jkmn", strings.ToUpper(fp))
	if err != nil || string(out) != workerYAML {
		t.Fatalf("out %q err %v", out, err)
	}
}

func TestJoinRefusesWithoutFingerprint(t *testing.T) {
	hits := 0
	addr, _ := tlsServer(t, &hits)
	for _, fp := range []string{"", "  ", "abc", strings.Repeat("g", 64)} {
		if _, err := join(addr, "abcd-efgh-jkmn", fp); err == nil {
			t.Fatalf("fingerprint %q accepted", fp)
		}
	}
	if hits != 0 {
		t.Fatalf("the code was sent %d times without a valid fingerprint", hits)
	}
}

func TestJoinRefusesOtherCertificate(t *testing.T) {
	hits := 0
	addr, _ := tlsServer(t, &hits)
	if _, err := join(addr, "abcd-efgh-jkmn", strings.Repeat("0", 64)); err == nil {
		t.Fatal("a different certificate was trusted")
	}
	if hits != 0 {
		t.Fatal("the request reached the server")
	}
}

func TestJoinErrors(t *testing.T) {
	bad := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Plain") != "" {
			_, _ = w.Write([]byte("hello"))
			return
		}
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"error":"wrong, used or expired join code"}`))
	}))
	defer bad.Close()
	sum := sha256.Sum256(bad.Certificate().Raw)
	fp := fmt.Sprintf("%x", sum)
	_, err := join(strings.TrimPrefix(bad.URL, "https://"), "x", fp)
	if err == nil || !strings.Contains(err.Error(), "expired join code") {
		t.Fatalf("err %v", err)
	}
}
