#!/usr/bin/env bash
# Shared helpers for host-side scripts. Source this file; do not execute it.
# Host-side scripts are only for things outside the cluster (PLAN.md 2.4).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
export REPO_ROOT

die() { echo "error: $*" >&2; exit 1; }
log() { echo "==> $*" >&2; }

export IDEA_SECRETS_DIR="${IDEA_SECRETS_DIR:-$HOME/.idea-secrets}"
# The data dir is, in order: the environment, the choice saved by
# `idea install --data-dir` (kept outside the repo), the default.
if [ -z "${IDEA_DATA_DIR:-}" ] && [ -f "$IDEA_SECRETS_DIR/local.env" ]; then
  IDEA_DATA_DIR="$(sed -n 's/^IDEA_DATA_DIR=//p' "$IDEA_SECRETS_DIR/local.env" | tail -n 1)"
fi
export IDEA_DATA_DIR="${IDEA_DATA_DIR:-/DATA/idea}"

# Secrets and bulk data must never live inside the repo.
_abs() { realpath -m -- "$1"; }
case "$(_abs "$IDEA_SECRETS_DIR")/" in
  "$REPO_ROOT"/*) die "IDEA_SECRETS_DIR points inside the repo: refusing to run" ;;
esac
case "$(_abs "$IDEA_DATA_DIR")/" in
  "$REPO_ROOT"/*) die "IDEA_DATA_DIR points inside the repo: refusing to run" ;;
esac

export TALOSCONFIG="${IDEA_TALOSCONFIG:-$IDEA_SECRETS_DIR/talos/talosconfig}"
# IDEA_KUBECONFIG / IDEA_TALOSCONFIG point the scripts at another cluster (for
# example the one installed from a test ISO).
export KUBECONFIG="${IDEA_KUBECONFIG:-$IDEA_SECRETS_DIR/kubeconfig}"

set -a
# shellcheck disable=SC1091
. "$REPO_ROOT/versions.env"
# shellcheck disable=SC1091
. "$REPO_ROOT/config.env"
set +a

need() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "missing command: $c (run ./idea install)"
  done
}

# Only resources named idea-* may be created or removed (PLAN.md 2.5).
require_idea_name() {
  case "$1" in
    idea-*) ;;
    *) die "refusing to touch a resource not named idea-*: $1" ;;
  esac
}

# libvirt network state. Output is captured first: piping virsh straight into
# `grep -q` can fail under pipefail when grep exits early.
net_exists()    { virsh net-info "$1" >/dev/null 2>&1; }
net_active()    { local o; o="$(virsh net-info "$1" 2>/dev/null)" || return 1; grep -q '^Active:.*yes' <<<"$o"; }
net_autostart() { local o; o="$(virsh net-info "$1" 2>/dev/null)" || return 1; grep -q '^Autostart:.*yes' <<<"$o"; }

# collect_secret_values <file>
#   Write "source<TAB>value" for every real secret value found in
#   $IDEA_SECRETS_DIR. The file must live on tmpfs and be removed by the caller.
#   Sources: env (KEY=VALUE, values of 8+ chars) and the string leaves of the
#   Talos/Kubernetes credential files (16+ chars, URLs excluded).
collect_secret_values() {
  local out=$1 envf line k v y f
  : > "$out"
  envf="$IDEA_SECRETS_DIR/env"
  if [ -f "$envf" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in ''|'#'*) continue ;; esac
      k="${line%%=*}"; v="${line#*=}"
      [ "$k" != "$line" ] || continue
      k="${k#export }"
      v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
      [ "${#v}" -ge 8 ] || continue
      printf '%s\t%s\n' "env:$k" "$v" >> "$out"
    done < "$envf"
  fi
  for y in talos/secrets.yaml talos/talosconfig kubeconfig \
           iso/secrets.yaml iso/talosconfig iso/kubeconfig iso/talosconfig-generated; do
    f="$IDEA_SECRETS_DIR/$y"
    [ -f "$f" ] || continue
    yq -o=json '[.. | select(tag == "!!str") | {"k": (path | join(".")), "v": .}]' "$f" |
      jq -r --arg src "$y" '.[] | .k as $k | .v | split("\n")[]
        | select(length >= 16) | select(test("^https?://") | not)
        | "\($src):\($k)\t\(.)"' >> "$out"
  done
}
