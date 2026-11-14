package main

// The Git tab's machine half: the plugin reads the machine's Forgejo
// repositories (branches, commits, pull requests and their diffs) and merges
// pull requests. Only the calls listed here reach Forgejo, as the admin user.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

const (
	gitSeg     = `[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}`
	maxGitBody = 8 << 20
)

var (
	gitReads = []*regexp.Regexp{
		regexp.MustCompile(`^repos/search$`),
		regexp.MustCompile(`^repos/` + gitSeg + `/` + gitSeg + `/(branches|commits|pulls)$`),
		regexp.MustCompile(`^repos/` + gitSeg + `/` + gitSeg + `/git/commits/[0-9a-f]{7,64}\.diff$`),
		regexp.MustCompile(`^repos/` + gitSeg + `/` + gitSeg + `/pulls/[0-9]{1,9}\.diff$`),
	}
	gitMerge  = regexp.MustCompile(`^repos/` + gitSeg + `/` + gitSeg + `/pulls/[0-9]{1,9}/merge$`)
	gitParams = map[string]bool{"sha": true, "limit": true, "page": true, "state": true, "q": true,
		"stat": true, "verification": true, "files": true, "sort": true}
)

// gitAllowed says whether the plugin may make this Forgejo call.
func gitAllowed(method, path string) bool {
	if strings.Contains(path, "..") {
		return false
	}
	switch method {
	case "GET":
		for _, re := range gitReads {
			if re.MatchString(path) {
				return true
			}
		}
	case "POST":
		return gitMerge.MatchString(path)
	}
	return false
}

// gitQuery keeps the query parameters Forgejo's list calls need.
func gitQuery(q url.Values) string {
	out := url.Values{}
	for k, v := range q {
		if gitParams[k] && len(v) > 0 && len(v[0]) <= 200 {
			out.Set(k, v[0])
		}
	}
	if len(out) == 0 {
		return ""
	}
	return "?" + out.Encode()
}

// raw sends one request and returns Forgejo's reply as it is.
func (f *Forgejo) raw(ctx context.Context, method, path string, in any) (int, string, []byte, bool, error) {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return 0, "", nil, false, err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, f.base+"/api/v1"+path, body)
	if err != nil {
		return 0, "", nil, false, err
	}
	req.SetBasicAuth(f.user, f.pass)
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := f.http.Do(req)
	if err != nil {
		return 0, "", nil, false, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, maxGitBody+1))
	if err != nil {
		return 0, "", nil, false, err
	}
	clipped := len(data) > maxGitBody
	if clipped {
		data = data[:maxGitBody]
	}
	return res.StatusCode, res.Header.Get("Content-Type"), data, clipped, nil
}

func (c *Controller) handleGit(w http.ResponseWriter, r *http.Request) {
	path := r.PathValue("rest")
	if !gitAllowed(r.Method, path) {
		writeError(w, 404, "unknown git call")
		return
	}
	var in any
	if r.Method == "POST" {
		var m struct {
			Do                     string `json:"Do"`
			DeleteBranchAfterMerge bool   `json:"delete_branch_after_merge"`
		}
		if err := readBody(r, &m); err != nil {
			writeError(w, 400, err.Error())
			return
		}
		if m.Do != "merge" && m.Do != "squash" && m.Do != "rebase" {
			writeError(w, 400, "Do: merge, squash or rebase")
			return
		}
		in = map[string]any{"Do": m.Do, "delete_branch_after_merge": m.DeleteBranchAfterMerge}
	}
	status, ctype, data, clipped, err := c.fj.raw(r.Context(), r.Method, "/"+path+gitQuery(r.URL.Query()), in)
	if err != nil {
		writeError(w, 502, "forgejo: "+err.Error())
		return
	}
	if status >= 300 {
		msg := strings.TrimSpace(string(data))
		var e struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(data, &e) == nil && e.Message != "" {
			msg = e.Message
		}
		if len(msg) > 300 {
			msg = msg[:300]
		}
		writeError(w, status, "forgejo: "+msg)
		return
	}
	// Diffs are text; hand them over as JSON like everything else.
	if strings.HasSuffix(path, ".diff") || !strings.Contains(ctype, "json") {
		writeJSON(w, 200, map[string]any{"diff": string(data), "clipped": clipped})
		return
	}
	if clipped {
		writeError(w, 502, "forgejo: the answer is too large")
		return
	}
	if len(data) == 0 {
		writeJSON(w, 200, map[string]bool{"ok": true})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(200)
	_, _ = w.Write(data)
}
