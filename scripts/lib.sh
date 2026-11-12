#!/usr/bin/env bash
# Shared helpers for host-side scripts. Source this file; do not execute it.
# Host-side scripts are only for things outside the cluster (PLAN.md 2.4).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
export REPO_ROOT

die() { echo "error: $*" >&2; exit 1; }
log() { echo "==> $*" >&2; }

export IDEA_SECRETS_DIR="${IDEA_SECRETS_DIR:-$HOME/.idea-secrets}"
export IDEA_DATA_DIR="${IDEA_DATA_DIR:-/DATA/idea}"

# Secrets and bulk data must never live inside the repo.
_abs() { realpath -m -- "$1"; }
case "$(_abs "$IDEA_SECRETS_DIR")/" in
  "$REPO_ROOT"/*) die "IDEA_SECRETS_DIR points inside the repo: refusing to run" ;;
esac
case "$(_abs "$IDEA_DATA_DIR")/" in
  "$REPO_ROOT"/*) die "IDEA_DATA_DIR points inside the repo: refusing to run" ;;
esac

export TALOSCONFIG="$IDEA_SECRETS_DIR/talos/talosconfig"
export KUBECONFIG="$IDEA_SECRETS_DIR/kubeconfig"

set -a
# shellcheck disable=SC1091
. "$REPO_ROOT/versions.env"
# shellcheck disable=SC1091
. "$REPO_ROOT/config.env"
set +a

need() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "missing command: $c (run scripts/host-setup.sh)"
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
