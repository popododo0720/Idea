#!/usr/bin/env bash
# Checks for a pull request. The machine's runner runs every step
# (.forgejo/workflows/test.yml) in a clean Kata VM with the worker image;
# run the same thing locally with the same commands.
#
#   scripts/ci.sh              every step
#   scripts/ci.sh go js        only these steps
#
# Steps:
#   setup      download the pinned tools (versions.env, SHA-256 checked) and
#              the Node tools (package-lock.json)
#   go         controller: format, golangci-lint (incl. vet), tests with coverage
#   js         dsh plugins: ESLint, TypeScript type check, unit tests with
#              coverage, every plugin module loads with dsh's packages
#   shell      shellcheck and shfmt on every shell script
#   workflows  actionlint on .forgejo/workflows
#   manifests  kubeconform on deploy/ (Kubernetes schemas, strict)
#   docker     hadolint on every Dockerfile
#   secrets    gitleaks on the tree and the branch's history
#
# The private-string and e-mail checks of check-secrets.sh are not run here:
# the controller runs them before merging and before publishing
# (controller/publish.go), with a list this VM never sees.
set -euo pipefail
cd "$(dirname "$0")/.."
. ./versions.env

ALL=(setup go js shell workflows manifests docker secrets)
TOOLS="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/idea-ci-tools"
# Coverage floors (this one and those in run_js): raise them when tests are
# added, never lower them to make a change pass.
GO_COVERAGE_FLOOR=55
export PATH="$TOOLS/go/bin:$TOOLS/bin:$PWD/node_modules/.bin:$PATH"
export GOPATH="$TOOLS/gopath" GOCACHE="$TOOLS/gocache" GOLANGCI_LINT_CACHE="$TOOLS/golangci-cache"
# -modcacherw: the runner deletes the job's temp dir afterwards, and Go makes
# its module cache read-only by default. GOMEMLIMIT keeps the Go tools inside
# the runner's 1 GiB.
export GOFLAGS="-mod=mod -modcacherw" GOMEMLIMIT="${GOMEMLIMIT:-768MiB}"

step() { printf '\n== %s\n' "$*"; }
die() {
  echo "ci: $*" >&2
  exit 1
}

# fetch <url> <sha256> <file>
fetch() {
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c --quiet -
}

# Shell scripts: *.sh plus the worker image's scripts without an extension.
shell_files() {
  git ls-files '*.sh'
  git ls-files images/worker/rootfs/usr/local/bin | while read -r f; do
    case "$(head -n1 "$f")" in '#!'*sh*) echo "$f" ;; esac
  done
}

run_setup() {
  step "setup: tools in $TOOLS"
  mkdir -p "$TOOLS/bin"
  local t="$TOOLS/dl"
  mkdir -p "$t"
  if [ "$(go version 2>/dev/null)" != "go version go${GO_VERSION} linux/amd64" ]; then
    rm -rf "$TOOLS/go"
    fetch "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" "$GO_SHA256" "$t/go.tgz"
    tar -C "$TOOLS" -xzf "$t/go.tgz"
  fi
  if ! golangci-lint version 2>/dev/null | grep -q " ${GOLANGCI_LINT_VERSION} "; then
    fetch "https://github.com/golangci/golangci-lint/releases/download/v${GOLANGCI_LINT_VERSION}/golangci-lint-${GOLANGCI_LINT_VERSION}-linux-amd64.tar.gz" \
      "$GOLANGCI_LINT_SHA256" "$t/golangci-lint.tgz"
    tar -C "$TOOLS/bin" -xzf "$t/golangci-lint.tgz" --strip-components=1 "golangci-lint-${GOLANGCI_LINT_VERSION}-linux-amd64/golangci-lint"
  fi
  if ! gitleaks version 2>/dev/null | grep -qx "${GITLEAKS_VERSION#v}"; then
    fetch "https://github.com/gitleaks/gitleaks/releases/download/${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION#v}_linux_x64.tar.gz" \
      "$GITLEAKS_SHA256" "$t/gitleaks.tgz"
    tar -C "$TOOLS/bin" -xzf "$t/gitleaks.tgz" gitleaks
  fi
  if ! shellcheck --version 2>/dev/null | grep -qx "version: ${SHELLCHECK_VERSION#v}"; then
    fetch "https://github.com/koalaman/shellcheck/releases/download/${SHELLCHECK_VERSION}/shellcheck-${SHELLCHECK_VERSION}.linux.x86_64.tar.xz" \
      "$SHELLCHECK_SHA256" "$t/shellcheck.txz"
    tar -C "$TOOLS/bin" -xJf "$t/shellcheck.txz" --strip-components=1 "shellcheck-${SHELLCHECK_VERSION}/shellcheck"
  fi
  if [ "$(shfmt --version 2>/dev/null)" != "$SHFMT_VERSION" ]; then
    fetch "https://github.com/mvdan/sh/releases/download/${SHFMT_VERSION}/shfmt_${SHFMT_VERSION}_linux_amd64" "$SHFMT_SHA256" "$t/shfmt"
    install -m 0755 "$t/shfmt" "$TOOLS/bin/shfmt"
  fi
  if ! actionlint -version 2>/dev/null | grep -qx "$ACTIONLINT_VERSION"; then
    fetch "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz" \
      "$ACTIONLINT_SHA256" "$t/actionlint.tgz"
    tar -C "$TOOLS/bin" -xzf "$t/actionlint.tgz" actionlint
  fi
  if [ "$(kubeconform -v 2>/dev/null)" != "$KUBECONFORM_VERSION" ]; then
    fetch "https://github.com/yannh/kubeconform/releases/download/${KUBECONFORM_VERSION}/kubeconform-linux-amd64.tar.gz" \
      "$KUBECONFORM_SHA256" "$t/kubeconform.tgz"
    tar -C "$TOOLS/bin" -xzf "$t/kubeconform.tgz" kubeconform
  fi
  if ! hadolint --version 2>/dev/null | grep -q " ${HADOLINT_VERSION#v}"; then
    fetch "https://github.com/hadolint/hadolint/releases/download/${HADOLINT_VERSION}/hadolint-linux-x86_64" "$HADOLINT_SHA256" "$t/hadolint"
    install -m 0755 "$t/hadolint" "$TOOLS/bin/hadolint"
  fi
  rm -rf "$t"
  NPM_CONFIG_UPDATE_NOTIFIER=false npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
}

run_go() {
  step "go: controller"
  (
    cd controller
    # The setup page's design system, as the image build copies it (go:embed).
    rm -rf design && mkdir -p design
    trap 'rm -rf design' EXIT
    cp ../console/design/idea.css design/ && cp -r ../console/design/fonts design/
    out="$(golangci-lint fmt --diff ./...)" || true
    [ -z "$out" ] || {
      echo "$out"
      die "Go files are not formatted: run golangci-lint fmt in controller/"
    }
    golangci-lint run ./...
    go test -count=1 -shuffle=on -coverprofile="$TOOLS/go-cover.out" ./...
    total="$(go tool cover -func="$TOOLS/go-cover.out" | awk '/^total:/ { sub(/%/, "", $3); print $3 }')"
    echo "Go coverage: ${total}% (floor ${GO_COVERAGE_FLOOR}%)"
    awk -v t="$total" -v f="$GO_COVERAGE_FLOOR" 'BEGIN { exit !(t >= f) }' \
      || die "Go coverage ${total}% is below ${GO_COVERAGE_FLOOR}%: add tests"
  )
}

run_js() {
  step "js: dsh plugins"
  # Plugins import dsh's packages; in the image they resolve through
  # /opt/dsh/node_modules. Give the checkout the same link.
  local dsh="${DSH_NODE_MODULES:-/opt/dsh/node_modules}"
  [ -d "$dsh" ] || die "dsh's packages are not at $dsh (set DSH_NODE_MODULES)"
  ln -sfn "$dsh" plugins/node_modules
  trap 'rm -f plugins/node_modules' RETURN
  eslint --max-warnings=0 .
  tsc -p tsconfig.json
  node --test --experimental-test-coverage --test-coverage-include='plugins/**/lib/**' \
    --test-coverage-lines=95 --test-coverage-branches=85 --test-coverage-functions=85 \
    plugins/idea/test/
  for f in plugins/*/src/index.ts plugins/idea/lib/index.js; do
    node --input-type=module -e "await import('$PWD/$f')" || die "does not load: $f"
    echo "loads: $f"
  done
}

run_shell() {
  step "shell: shellcheck, shfmt"
  mapfile -t files < <(shell_files)
  shellcheck "${files[@]}"
  shfmt -d "${files[@]}"
  echo "${#files[@]} scripts"
  scripts/test-idea-dsh.sh
  scripts/test-check-images.sh
}

run_workflows() {
  step "workflows: actionlint"
  actionlint -config-file .forgejo/actionlint.yaml .forgejo/workflows/*.yml
}

run_manifests() {
  step "manifests: kubeconform"
  # Custom resources (Flux, cert-manager, ...) have no bundled schema; their
  # controllers validate them on apply.
  kubeconform -strict -summary -ignore-missing-schemas \
    -kubernetes-version "${KUBERNETES_VERSION#v}" deploy
}

run_docker() {
  step "docker: hadolint"
  mapfile -t files < <(git ls-files '*Dockerfile')
  hadolint "${files[@]}"
}

run_secrets() {
  step "secrets: gitleaks"
  # --verbose prints each finding (file, line, rule) with the secret redacted.
  # Only the history of the checked-out commit: a clone also holds other
  # pull requests' branches, which are checked in their own runs.
  gitleaks dir --no-banner --redact --verbose --log-level=error .
  gitleaks git --no-banner --redact --verbose --log-level=error --log-opts=HEAD .
}

steps=("$@")
[ "${#steps[@]}" -gt 0 ] || steps=("${ALL[@]}")
for s in "${steps[@]}"; do
  case " ${ALL[*]} " in
    *" $s "*) "run_$s" ;;
    *) die "unknown step: $s (steps: ${ALL[*]})" ;;
  esac
done
echo
echo "ci: passed (${steps[*]})"
