#!/usr/bin/env bash
# check-images.sh against a temporary deploy tree and a fake registry listing.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/deploy/a"
cat >"$tmp/deploy/a/x.yaml" <<'YAML'
image: ghcr.io/popododo0720/idea-worker:1.0.0
HOST: idea-postgres:5432
image: code.forgejo.org/forgejo/nginx:9
YAML
cat >"$tmp/deploy/a/y.yaml" <<'YAML'
image: ghcr.io/popododo0720/idea-controller:2.0.0
YAML
mkdir -p "$tmp/reg/v2/popododo0720/idea-worker/tags" "$tmp/reg/v2/popododo0720/idea-controller/tags"
echo '{"name":"x","tags":["0.9.0", "1.0.0"]}' >"$tmp/reg/v2/popododo0720/idea-worker/tags/list"
echo '{"name":"x","tags":null}' >"$tmp/reg/v2/popododo0720/idea-controller/tags/list"

check() { IDEA_REGISTRY_URL="file://$tmp/reg" "$root/scripts/check-images.sh" "$tmp/deploy" 2>&1; }

if out="$(check)"; then
  echo "FAIL: missing controller tag was accepted" >&2
  exit 1
fi
grep -q 'y.yaml references idea-controller:2.0.0' <<<"$out" || {
  echo "FAIL: no manifest/tag report: $out" >&2
  exit 1
}
grep -q 'scripts/build-controller.sh' <<<"$out" || {
  echo "FAIL: no build hint: $out" >&2
  exit 1
}
if grep -q 'idea-worker\|postgres\|nginx' <<<"$out"; then
  echo "FAIL: reported a built or third-party image: $out" >&2
  exit 1
fi

echo '{"tags":["2.0.0"]}' >"$tmp/reg/v2/popododo0720/idea-controller/tags/list"
check >/dev/null || {
  echo "FAIL: complete registry rejected" >&2
  exit 1
}
echo "check-images: ok"
