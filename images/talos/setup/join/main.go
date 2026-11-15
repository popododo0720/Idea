// idea-join: ask an existing idea machine for the Talos worker configuration
// (POST /api/v1/nodes/join) and print it. Used by setup.sh on a machine that
// joins as an extra node.
//
//	idea-join <address:port> <join code> <certificate fingerprint>
//
// A just-installed machine has a self-signed certificate that nothing can
// vouch for. The fingerprint (shown next to the join code in the idea panel)
// is required: the connection is only used when the machine presents exactly
// that certificate. There is no trust on first use.
package main

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
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

var fingerprintPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func main() {
	if len(os.Args) != 4 {
		fail("usage: idea-join <address:port> <join code> <certificate fingerprint>")
	}
	out, err := join(os.Args[1], os.Args[2], os.Args[3])
	if err != nil {
		fail("%v", err)
	}
	_, _ = os.Stdout.Write(out)
}

// join fetches the worker configuration from addr, trusting only the
// certificate whose SHA-256 fingerprint is fp.
func join(addr, code, fp string) ([]byte, error) {
	want := normalize(fp)
	if !fingerprintPattern.MatchString(want) {
		return nil, fmt.Errorf("a certificate fingerprint (64 hex digits, shown in the idea panel) is required")
	}
	client := &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{
			MinVersion:         tls.VersionTLS12,
			InsecureSkipVerify: true, //nolint:gosec // pinned to the required fingerprint below
			VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
				if len(raw) == 0 {
					return fmt.Errorf("the machine presented no certificate")
				}
				sum := sha256.Sum256(raw[0])
				if fmt.Sprintf("%x", sum) != want {
					return fmt.Errorf("the machine presented a different certificate than the fingerprint given")
				}
				return nil
			},
		}},
	}
	body, _ := json.Marshal(map[string]string{"code": code})
	resp, err := client.Post("https://"+addr+"/api/v1/nodes/join", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		var e struct{ Error string }
		_ = json.Unmarshal(out, &e)
		if e.Error == "" {
			e.Error = resp.Status
		}
		return nil, errors.New(e.Error)
	}
	if !bytes.Contains(out, []byte("machine:")) {
		return nil, errors.New("the answer is not a Talos machine configuration")
	}
	return out, nil
}
