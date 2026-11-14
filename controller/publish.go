package main

// Publishing: a project with spec.mirror publishes main to another Git server
// (for example a public GitHub repository). The controller keeps a Forgejo
// push mirror for it with automatic syncing off and an SSH key Forgejo makes;
// the owner adds the public key (status.mirrorKey) to the other server as a
// deploy key with write access, so nothing is published before a person
// allows it. Main as it is when the mirror is set up is published as it is;
// after that, the controller syncs the mirror only after checking every new
// commit on main:
//
//   - author and committer e-mails match spec.mirror.allowedEmails (default:
//     GitHub noreply addresses) or are the machine's own bots (its agents and
//     the user that merges),
//   - no commit message, added line or file name contains a private string:
//     names and addresses of the network the machine runs in, listed in the
//     Secret idea-private-strings (key "strings", one per line), which only
//     the controller reads. Without that list, this part is skipped and the
//     project's publish status says so.
//
// The same check runs on a pull request before it is merged, so its agent can
// fix the branch. Findings name the commit, file and line, never the string.
//
// status.published is the last main commit synced. When a project becomes
// mirrored, its main at that moment counts as published already.

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

const (
	privateStringsSecret = "idea-private-strings"
	// More new commits than this at once are not checked one by one: the
	// project is held back and someone looks at it.
	maxPublishCommits = 300
	// How often a task's agent is asked to fix a pull request that could not
	// be published.
	maxPublishFixes = 3
)

// botMail: the agents' identity and the Forgejo user that merges pull
// requests; always publishable.
var botMail = regexp.MustCompile(`^(idea-worker|idea-admin)@idea\.internal$`)

// defaultAllowedEmails: GitHub noreply addresses.
var defaultAllowedEmails = []string{`^([0-9]+\+)?[A-Za-z0-9-]+@users\.noreply\.github\.com$`}

// mailRules compiles a project's allowed e-mail patterns.
func mailRules(patterns []string) ([]*regexp.Regexp, error) {
	if len(patterns) == 0 {
		patterns = defaultAllowedEmails
	}
	out := []*regexp.Regexp{botMail}
	for _, p := range patterns {
		re, err := regexp.Compile(p)
		if err != nil {
			return nil, fmt.Errorf("allowedEmails: %q: %w", p, err)
		}
		out = append(out, re)
	}
	return out, nil
}

func mailAllowed(rules []*regexp.Regexp, mail string) bool {
	for _, re := range rules {
		if re.MatchString(mail) {
			return true
		}
	}
	return false
}

// privateStrings reads the list of strings that must not be published.
// It returns nil (and no error) when the machine has no such list, or an
// empty one; publishing then notes that only e-mails were checked.
func (c *Controller) privateStrings(ctx context.Context) ([]string, error) {
	s, err := c.kube.CoreV1().Secrets(c.cfg.SystemNS).Get(ctx, privateStringsSecret, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []string
	sc := bufio.NewScanner(strings.NewReader(string(s.Data["strings"])))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		out = append(out, line)
	}
	return out, nil
}

func containsAny(s string, list []string) bool {
	for _, p := range list {
		if strings.Contains(s, p) {
			return true
		}
	}
	return false
}

func short(sha string) string {
	if len(sha) > 10 {
		return sha[:10]
	}
	return sha
}

// checkCommits returns what keeps these commits from being published, or "".
func checkCommits(commits []CommitInfo, mails []*regexp.Regexp, private []string) string {
	for _, cm := range commits {
		if !mailAllowed(mails, cm.AuthorEmail) {
			return fmt.Sprintf("the author e-mail of commit %s is not one the mirror allows (spec.mirror.allowedEmails, or the machine's bot)", short(cm.SHA))
		}
		if !mailAllowed(mails, cm.CommitterEmail) {
			return fmt.Sprintf("the committer e-mail of commit %s is not one the mirror allows (spec.mirror.allowedEmails, or the machine's bot)", short(cm.SHA))
		}
		if containsAny(cm.Message, private) {
			return fmt.Sprintf("the message of commit %s contains a private name or address", short(cm.SHA))
		}
	}
	return ""
}

var hunk = regexp.MustCompile(`^@@ -[0-9,]+ \+([0-9]+)`)

// checkDiff returns what keeps this diff from being published, or "": an
// added line or a file name with a private string.
func checkDiff(diff, where string, private []string) string {
	file, line := "", 0
	sc := bufio.NewScanner(strings.NewReader(diff))
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for sc.Scan() {
		l := sc.Text()
		switch {
		case strings.HasPrefix(l, "+++ "):
			file = strings.TrimPrefix(strings.TrimPrefix(l, "+++ "), "b/")
			if containsAny(file, private) {
				return "a file name in " + where + " contains a private name or address"
			}
		case strings.HasPrefix(l, "--- "), strings.HasPrefix(l, "diff --git "):
			if strings.HasPrefix(l, "diff --git ") && containsAny(l, private) {
				return "a file name in " + where + " contains a private name or address"
			}
		case strings.HasPrefix(l, "@@"):
			if m := hunk.FindStringSubmatch(l); m != nil {
				line, _ = strconv.Atoi(m[1])
			}
		case strings.HasPrefix(l, "+"):
			if containsAny(l[1:], private) {
				return fmt.Sprintf("%s, line %d (in %s) contains a private name or address", file, line, where)
			}
			line++
		case strings.HasPrefix(l, " "):
			line++
		}
	}
	return ""
}

// pullRequestProblem checks a pull request of a mirrored project before merging.
func (c *Controller) pullRequestProblem(ctx context.Context, p project, number int64) (string, error) {
	repo := p.Repo
	mails, err := mailRules(p.AllowedEmails)
	if err != nil {
		return "", err
	}
	private, err := c.privateStrings(ctx)
	if err != nil {
		return "", err
	}
	commits, err := c.fj.PullCommits(ctx, repo, number)
	if err != nil {
		return "", err
	}
	if p := checkCommits(commits, mails, private); p != "" {
		return p, nil
	}
	diff, err := c.fj.Raw(ctx, fmt.Sprintf("/repos/%s/pulls/%d.diff", repo, number))
	if err != nil {
		return "", err
	}
	return checkDiff(diff, fmt.Sprintf("pull request #%d", number), private), nil
}

// reconcileMirror keeps the project's push mirror and records its key. A new
// mirror address starts over: what main has then counts as published.
func (c *Controller) reconcileMirror(ctx context.Context, p *project) error {
	m, err := c.fj.EnsurePushMirror(ctx, p.Repo, p.Mirror)
	if err != nil {
		return err
	}
	if m.PublicKey == p.MirrorKey && p.mirrorURL == p.Mirror {
		return nil
	}
	obj := p.obj.DeepCopy()
	_ = unstructured.SetNestedField(obj.Object, m.PublicKey, "status", "mirrorKey")
	_ = unstructured.SetNestedField(obj.Object, p.Mirror, "status", "mirrorUrl")
	if p.mirrorURL != p.Mirror {
		_ = unstructured.SetNestedField(obj.Object, "", "status", "published")
		_ = unstructured.SetNestedField(obj.Object, "", "status", "publish")
	}
	u, err := c.dyn.Resource(projectGVR).Namespace(c.cfg.SystemNS).UpdateStatus(ctx, obj, metav1.UpdateOptions{})
	if err != nil {
		return err
	}
	*p = c.projectOf(u)
	slog.Info("push mirror ready", "project", p.Name, "mirror", p.Mirror)
	return nil
}

// publishProject syncs the push mirror of a project once its new commits pass
// the check.
func (c *Controller) publishProject(ctx context.Context, p project) error {
	head, err := c.fj.BranchHead(ctx, p.Repo, "main")
	if err != nil || head == "" {
		return err // no main yet
	}
	if p.Published == "" {
		// Mirrored just now: main as it is then is published as it is.
		return c.push(ctx, p, head, "main at "+short(head)+" is published as it was when the mirror was set up; later commits are checked first")
	}
	if head == p.Published {
		// A push that failed (most often: the deploy key is not added yet)
		// is tried again now and then.
		if !strings.HasPrefix(p.Publish, mirrorFailed) && p.mirrorError == "" {
			return nil
		}
		if time.Since(c.mirrorSynced[p.Name]) < mirrorRetry {
			return nil
		}
		return c.push(ctx, p, head, "published main at "+short(head))
	}
	hold := func(why string) error {
		msg := "not published: " + why
		if p.Publish != msg {
			slog.Warn("project not published", "project", p.Name, "why", why)
		}
		return c.setPublishStatus(ctx, p, p.Published, msg)
	}
	mails, err := mailRules(p.AllowedEmails)
	if err != nil {
		return hold(err.Error())
	}
	private, err := c.privateStrings(ctx)
	if err != nil {
		return hold(err.Error())
	}
	commits, found, err := c.fj.CommitsSince(ctx, p.Repo, head, p.Published, maxPublishCommits)
	if err != nil {
		// Also when the last published commit is gone from the repository.
		return hold(fmt.Sprintf("could not list the commits since %s: %v", short(p.Published), err))
	}
	if !found {
		return hold(fmt.Sprintf("more than %d commits are new since %s; publish them in smaller steps", maxPublishCommits, short(p.Published)))
	}
	if why := checkCommits(commits, mails, private); why != "" {
		return hold(why)
	}
	for _, cm := range commits {
		diff, err := c.fj.Raw(ctx, "/repos/"+p.Repo+"/git/commits/"+url.PathEscape(cm.SHA)+".diff")
		if err != nil {
			return err
		}
		if why := checkDiff(diff, "commit "+short(cm.SHA), private); why != "" {
			return hold(why)
		}
	}
	slog.Info("project checked", "project", p.Name, "commit", short(head), "commits", len(commits))
	note := ""
	if private == nil {
		note = "; this machine has no list of private strings, so only commit e-mails were checked"
	}
	return c.push(ctx, p, head, fmt.Sprintf("published main at %s (%s)%s", short(head), time.Now().UTC().Format(time.RFC3339), note))
}

// push syncs the mirror once head has passed the check (or is where the
// mirror started). head counts as published either way: a failed push is
// recorded and tried again every mirrorRetry, without checking again.
func (c *Controller) push(ctx context.Context, p project, head, ok string) error {
	c.mirrorSynced[p.Name] = time.Now()
	if err := c.fj.SyncPushMirrors(ctx, p.Repo); err != nil {
		why := p.mirrorError
		if why == "" {
			why = clip(err.Error(), 300)
		}
		msg := mirrorFailed + "main at " + short(head) + " was checked, but Forgejo could not push it to the mirror: " + why +
			" (is the deploy key added there with write access? Tried again every few minutes.)"
		if p.Publish != msg {
			slog.Warn("mirror push", "project", p.Name, "err", why)
		}
		return c.setPublishStatus(ctx, p, head, msg)
	}
	slog.Info("project published", "project", p.Name, "commit", short(head))
	return c.setPublishStatus(ctx, p, head, ok)
}

func (c *Controller) setPublishStatus(ctx context.Context, p project, published, message string) error {
	if p.Published == published && p.Publish == message {
		return nil
	}
	obj := p.obj.DeepCopy()
	_ = unstructured.SetNestedField(obj.Object, published, "status", "published")
	_ = unstructured.SetNestedField(obj.Object, message, "status", "publish")
	_, err := c.dyn.Resource(projectGVR).Namespace(c.cfg.SystemNS).UpdateStatus(ctx, obj, metav1.UpdateOptions{})
	return err
}

const (
	mirrorFailed = "not pushed yet: "
	mirrorRetry  = 5 * time.Minute
)

// publishAll runs publishProject for every mirrored project. Only its loop
// uses c.mirrorSynced.
func (c *Controller) publishAll(ctx context.Context) error {
	projects, err := c.listProjects(ctx)
	if err != nil {
		return err
	}
	if c.mirrorSynced == nil {
		c.mirrorSynced = map[string]time.Time{}
	}
	for _, p := range projects {
		if p.Mirror == "" || p.MirrorKey == "" || p.mirrorURL != p.Mirror {
			continue // reconcileMirror has not set it up yet
		}
		if m, err := c.fj.PushMirror(ctx, p.Repo, p.Mirror); err == nil && m != nil {
			p.mirrorError = clip(m.LastError, 300)
		}
		if err := c.publishProject(ctx, p); err != nil {
			slog.Warn("publish", "project", p.Name, "err", err.Error())
		}
	}
	return nil
}

// clip shortens s to at most n bytes without splitting a character.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n] + "…"
}

// ------------------------------------------------------------ Forgejo calls

// CommitInfo is what the publish check reads of a commit.
type CommitInfo struct {
	SHA            string
	Message        string
	AuthorEmail    string
	CommitterEmail string
}

type apiCommit struct {
	SHA    string `json:"sha"`
	Commit struct {
		Message string `json:"message"`
		Author  struct {
			Email string `json:"email"`
		} `json:"author"`
		Committer struct {
			Email string `json:"email"`
		} `json:"committer"`
	} `json:"commit"`
}

func (a apiCommit) info() CommitInfo {
	return CommitInfo{SHA: a.SHA, Message: a.Commit.Message, AuthorEmail: a.Commit.Author.Email, CommitterEmail: a.Commit.Committer.Email}
}

// BranchHead returns the commit a branch points to ("" when it does not exist).
func (f *Forgejo) BranchHead(ctx context.Context, repo, branch string) (string, error) {
	var b struct {
		Commit struct {
			ID string `json:"id"`
		} `json:"commit"`
	}
	err := f.do(ctx, "GET", "/repos/"+repo+"/branches/"+url.PathEscape(branch), nil, &b)
	if isStatus(err, 404) {
		return "", nil
	}
	return b.Commit.ID, err
}

// CommitsSince lists the commits reachable from head but not from stop
// (git log head ^stop), so commits that come in through a merge are listed
// even when they are older than stop. It reports false when there are more
// than max.
func (f *Forgejo) CommitsSince(ctx context.Context, repo, head, stop string, max int) ([]CommitInfo, bool, error) {
	var out []CommitInfo
	for page := 1; ; page++ {
		var list []apiCommit
		path := fmt.Sprintf("/repos/%s/commits?sha=%s&not=%s&limit=50&page=%d&stat=false&files=false&verification=false",
			repo, url.QueryEscape(head), url.QueryEscape(stop), page)
		if err := f.do(ctx, "GET", path, nil, &list); err != nil {
			return nil, false, err
		}
		for _, a := range list {
			out = append(out, a.info())
		}
		if len(out) > max {
			return nil, false, nil
		}
		if len(list) < 50 {
			return out, true, nil
		}
	}
}

// PullCommits lists the commits of a pull request.
func (f *Forgejo) PullCommits(ctx context.Context, repo string, number int64) ([]CommitInfo, error) {
	var out []CommitInfo
	for page := 1; page <= 10; page++ {
		var list []apiCommit
		path := fmt.Sprintf("/repos/%s/pulls/%d/commits?limit=50&page=%d&stat=false&files=false&verification=false", repo, number, page)
		if err := f.do(ctx, "GET", path, nil, &list); err != nil {
			return nil, err
		}
		for _, a := range list {
			out = append(out, a.info())
		}
		if len(list) < 50 {
			return out, nil
		}
	}
	return nil, fmt.Errorf("pull request #%d has more than 500 commits", number)
}

// remoteID is an SSH address without its user, in one form: Forgejo shows
// git@host:owner/repo.git as ssh://host/owner/repo.git.
func remoteID(addr string) string {
	if rest, ok := strings.CutPrefix(addr, "ssh://"); ok {
		slash := strings.IndexByte(rest+"/", '/')
		if at := strings.IndexByte(rest[:slash], '@'); at >= 0 {
			rest = rest[at+1:]
		}
		return rest
	}
	if at := strings.IndexByte(addr, '@'); at >= 0 {
		addr = addr[at+1:]
	}
	host, path, _ := strings.Cut(addr, ":")
	return host + "/" + strings.TrimPrefix(path, "/")
}

func sameRemote(a, b string) bool { return remoteID(a) == remoteID(b) }

// PushMirrorInfo is a Forgejo push mirror.
type PushMirrorInfo struct {
	RemoteName    string `json:"remote_name"`
	RemoteAddress string `json:"remote_address"`
	PublicKey     string `json:"public_key"`
	SyncOnCommit  bool   `json:"sync_on_commit"`
	Interval      string `json:"interval"`
	LastError     string `json:"last_error"`
}

func (f *Forgejo) pushMirrors(ctx context.Context, repo string) ([]PushMirrorInfo, error) {
	var list []PushMirrorInfo
	err := f.do(ctx, "GET", "/repos/"+repo+"/push_mirrors?limit=50", nil, &list)
	return list, err
}

// PushMirror returns the push mirror to url, or nil.
func (f *Forgejo) PushMirror(ctx context.Context, repo, addr string) (*PushMirrorInfo, error) {
	list, err := f.pushMirrors(ctx, repo)
	if err != nil {
		return nil, err
	}
	for i := range list {
		if sameRemote(list[i].RemoteAddress, addr) {
			return &list[i], nil
		}
	}
	return nil, nil
}

// EnsurePushMirror keeps exactly one push mirror, to addr (SSH with a key
// Forgejo makes, no automatic syncing). Any other push mirror would publish
// unchecked commits, so it is removed.
func (f *Forgejo) EnsurePushMirror(ctx context.Context, repo, addr string) (*PushMirrorInfo, error) {
	list, err := f.pushMirrors(ctx, repo)
	if err != nil {
		return nil, err
	}
	var keep *PushMirrorInfo
	for i := range list {
		m := &list[i]
		if keep == nil && sameRemote(m.RemoteAddress, addr) && m.PublicKey != "" && !m.SyncOnCommit && (m.Interval == "" || m.Interval == "0s" || m.Interval == "0") {
			keep = m
			continue
		}
		if err := f.do(ctx, "DELETE", "/repos/"+repo+"/push_mirrors/"+url.PathEscape(m.RemoteName), nil, nil); err != nil {
			return nil, fmt.Errorf("remove push mirror %s: %w", m.RemoteAddress, err)
		}
		slog.Info("push mirror removed", "repo", repo, "mirror", m.RemoteAddress)
	}
	if keep != nil {
		return keep, nil
	}
	var m PushMirrorInfo
	err = f.do(ctx, "POST", "/repos/"+repo+"/push_mirrors", map[string]any{
		"remote_address": addr, "use_ssh": true, "sync_on_commit": false, "interval": "0",
	}, &m)
	if err != nil {
		return nil, err
	}
	if m.PublicKey == "" {
		return nil, errors.New("Forgejo made the mirror without an SSH key")
	}
	slog.Info("push mirror created", "repo", repo, "mirror", addr)
	return &m, nil
}

// SyncPushMirrors pushes the repository to its push mirrors now.
func (f *Forgejo) SyncPushMirrors(ctx context.Context, repo string) error {
	return f.do(ctx, "POST", "/repos/"+repo+"/push_mirrors-sync", nil, nil)
}

// Raw returns a text response (a diff) of the API.
func (f *Forgejo) Raw(ctx context.Context, path string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", f.base+"/api/v1"+path, nil)
	if err != nil {
		return "", err
	}
	req.SetBasicAuth(f.user, f.pass)
	res, err := f.http.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var b strings.Builder
	if _, err := io.Copy(&b, io.LimitReader(res.Body, 32<<20)); err != nil {
		return "", err
	}
	if res.StatusCode >= 300 {
		msg := b.String()
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return "", &apiError{Status: res.StatusCode, Body: msg}
	}
	return b.String(), nil
}
