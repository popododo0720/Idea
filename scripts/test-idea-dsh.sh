#!/usr/bin/env bash
# The dsh that idea-dsh starts gets the pinned web search provider, and the
# deployment can override it with IDEA_WEB_SEARCH_PROVIDER.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/state/dsh"
printf 'own instructions\n' >"$tmp/state/dsh/AGENTS.md"
cat >"$tmp/bin/dsh" <<'S'
#!/bin/sh
echo "provider=${DSH_WEB_SEARCH_PROVIDER-unset}"
S
chmod +x "$tmp/bin/dsh"

run() {
  env -u DSH_WEB_SEARCH_PROVIDER -u IDEA_WEB_SEARCH_PROVIDER -u IDEA_SUBSCRIPTIONS_PLUGIN_VERSION -u IDEA_PSTACK_PLUGIN_VERSION "$@" \
    HOME="$tmp" PATH="$tmp/bin:$PATH" POD_IP=127.0.0.1 IDEA_STATE="$tmp/state" \
    "$root/images/worker/rootfs/usr/local/bin/idea-dsh"
}

got="$(run)"
[ "$got" = "provider=deepseek-official" ] || {
  echo "FAIL: default: $got" >&2
  exit 1
}
got="$(run IDEA_WEB_SEARCH_PROVIDER=other)"
[ "$got" = "provider=other" ] || {
  echo "FAIL: override: $got" >&2
  exit 1
}
echo "ok: idea-dsh pins the web search provider"
