#!/usr/bin/env bash
# Tests for a pull request, run by the machine's own runner
# (.forgejo/workflows/test.yml) in a clean Kata VM with the worker image.
#
#   - controller: gofmt, go vet, go test
#   - dsh plugins: every plugin module loads in the image's Node with dsh's
#     packages; the panel plugin's files parse
#   - gitleaks on the tree and the branch's history
#
# Go and gitleaks are downloaded at the versions in versions.env and checked
# against the pinned SHA-256. The private-string and e-mail checks of
# check-secrets.sh are not run here: the controller runs them before merging
# and before publishing (controller/publish.go), with a list this VM never
# sees.
set -euo pipefail
cd "$(dirname "$0")/.."
. ./versions.env

tools="${RUNNER_TEMP:-/tmp}/idea-ci-tools"
mkdir -p "$tools"

fetch() { # url sha256 file
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c --quiet -
}

if [ ! -x "$tools/go/bin/go" ]; then
  fetch "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" "$GO_SHA256" "$tools/go.tgz"
  tar -C "$tools" -xzf "$tools/go.tgz" && rm "$tools/go.tgz"
fi
if [ ! -x "$tools/gitleaks" ]; then
  fetch "https://github.com/gitleaks/gitleaks/releases/download/${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION#v}_linux_x64.tar.gz" \
    "$GITLEAKS_SHA256" "$tools/gitleaks.tgz"
  tar -C "$tools" -xzf "$tools/gitleaks.tgz" gitleaks && rm "$tools/gitleaks.tgz"
fi
export PATH="$tools/go/bin:$tools:$PATH" GOPATH="$tools/gopath" GOCACHE="$tools/gocache" GOFLAGS=-mod=mod

echo "== controller"
(
  cd controller
  # The setup page's design system, as the image build copies it.
  rm -rf design && mkdir -p design && cp ../console/design/idea.css design/ && cp -r ../console/design/fonts design/
  out="$(gofmt -l .)"
  [ -z "$out" ] || { echo "gofmt: not formatted:"; echo "$out"; exit 1; }
  go vet ./...
  go test ./...
  rm -rf design
)

echo "== dsh plugins"
# Plugins import dsh's packages; in the image they resolve through
# /opt/idea/plugins/node_modules. Give the checkout the same link.
ln -sfn /opt/dsh/node_modules plugins/node_modules
trap 'rm -f plugins/node_modules' EXIT
for f in plugins/*/src/index.ts; do
  node --input-type=module -e "await import('$PWD/$f')" || { echo "does not load: $f"; exit 1; }
  echo "ok: $f"
done
for f in plugins/idea/lib/*.js; do
  node --check "$f" || { echo "does not parse: $f"; exit 1; }
done
echo "ok: plugins/idea/lib"
node --test plugins/idea/test/

echo "== gitleaks"
gitleaks dir --no-banner --redact --log-level=error .
gitleaks git --no-banner --redact --log-level=error .
echo "ci: passed"
