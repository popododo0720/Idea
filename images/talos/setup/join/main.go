// idea-join: ask an existing idea machine for the Talos worker configuration
// (POST /api/v1/nodes/join) and print it. Used by setup.sh on a machine that
// joins as an extra node.
//
//	idea-join <address:port> <join code> [certificate fingerprint]
//
// A just-installed machine has a self-signed certificate that nothing can
// vouch for. With a fingerprint (shown next to the join code in the idea
// panel) the connection is only used when the machine presents exactly that
// certificate. Without one the join code alone protects the exchange, and the
// fingerprint seen is printed to stderr.
package main

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
	os.Exit(1)
}

func normalize(fp string) string {
	return strings.ToLower(strings.NewReplacer(":", "", " ", "").Replace(fp))
}

func main() {
	if len(os.Args) < 3 {
		fail("usage: idea-join <address:port> <join code> [fingerprint]")
	}
	addr, code := os.Args[1], os.Args[2]
	want := ""
	if len(os.Args) > 3 {
		want = normalize(os.Args[3])
	}
	seen := ""
	client := &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{
			MinVersion:         tls.VersionTLS12,
			InsecureSkipVerify: true, //nolint:gosec // pinned below, or trusted on first use with the join code
			VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
				if len(raw) == 0 {
					return fmt.Errorf("the machine presented no certificate")
				}
				sum := sha256.Sum256(raw[0])
				seen = fmt.Sprintf("%x", sum)
				if want != "" && seen != want {
					return fmt.Errorf("the machine presented a different certificate than the fingerprint given")
				}
				return nil
			},
		}},
	}
	body, _ := json.Marshal(map[string]string{"code": code})
	resp, err := client.Post("https://"+addr+"/api/v1/nodes/join", "application/json", bytes.NewReader(body))
	if err != nil {
		fail("%v", err)
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		fail("%v", err)
	}
	if resp.StatusCode != http.StatusOK {
		var e struct{ Error string }
		_ = json.Unmarshal(out, &e)
		if e.Error == "" {
			e.Error = resp.Status
		}
		fail("%s", e.Error)
	}
	if want == "" {
		fmt.Fprintf(os.Stderr, "certificate fingerprint of the machine: %s\n", seen)
	}
	if !bytes.Contains(out, []byte("machine:")) {
		fail("the answer is not a Talos machine configuration")
	}
	_, _ = os.Stdout.Write(out)
}
