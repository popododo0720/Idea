package main

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The API server drops status fields that a CRD does not declare, so a field
// the controller writes but the schema lacks is silently lost on every update
// (the review gate then never saw its own progress). Every status field the
// controller reads or writes must be in deploy/apps/controller/crd.yaml.

var (
	statusRead  = regexp.MustCompile(`(?:statusString|statusInt)\(t, "([A-Za-z]+)"\)|"status", "([A-Za-z]+)"`)
	setPhaseMap = regexp.MustCompile(`(?s)setPhase\([^;]*?map\[string\]any\{(.*?)\}\)`)
	mapKey      = regexp.MustCompile(`"([A-Za-z]+)":`)
	crdField    = regexp.MustCompile(`^ {16}([A-Za-z]+):\s*$`)
)

// projectFiles handle Project objects; every other file handles Tasks.
var projectFiles = map[string]bool{"projects.go": true, "publish.go": true}

// controllerStatusFields lists the status fields that the non-test Go files
// use for Projects (project true) or for Tasks.
func controllerStatusFields(t *testing.T, project bool) []string {
	t.Helper()
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") || projectFiles[f] != project {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range statusRead.FindAllStringSubmatch(string(b), -1) {
			seen[m[1]+m[2]] = true
		}
		for _, m := range setPhaseMap.FindAllStringSubmatch(string(b), -1) {
			for _, k := range mapKey.FindAllStringSubmatch(m[1], -1) {
				seen[k[1]] = true
			}
		}
	}
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// crdStatusFields reads the status properties of the CRD of a kind.
func crdStatusFields(t *testing.T, kind string) map[string]bool {
	t.Helper()
	b, err := os.ReadFile("../deploy/apps/controller/crd.yaml")
	if err != nil {
		t.Fatal(err)
	}
	fields := map[string]bool{}
	for _, doc := range strings.Split(string(b), "\n---\n") {
		if !strings.Contains(doc, "\n    kind: "+kind+"\n") {
			continue
		}
		in := false
		for _, line := range strings.Split(doc, "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" || strings.HasPrefix(trimmed, "#") {
				continue
			}
			indent := len(line) - len(strings.TrimLeft(line, " "))
			switch {
			case indent == 12 && trimmed == "status:":
				in = true
			case indent <= 12:
				in = false
			case in:
				if m := crdField.FindStringSubmatch(line); m != nil {
					fields[m[1]] = true
				}
			}
		}
	}
	return fields
}

func TestCRDsDeclareStatusFields(t *testing.T) {
	for _, kind := range []string{"Task", "Project"} {
		t.Run(kind, func(t *testing.T) {
			declared := crdStatusFields(t, kind)
			if len(declared) == 0 {
				t.Fatalf("no status properties found in the %s CRD", kind)
			}
			used := controllerStatusFields(t, kind == "Project")
			if len(used) == 0 {
				t.Fatalf("no %s status fields found in the controller", kind)
			}
			for _, f := range used {
				if !declared[f] {
					t.Errorf("status.%s is used by the controller but not declared in the %s CRD", f, kind)
				}
			}
		})
	}
}
