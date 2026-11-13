#!/usr/bin/env bash
# Scan a built container image for secrets before it is pushed (PLAN.md 4.5).
#
#   check-image.sh <image>
#
# 1. layer history and image config (ARG/ENV/labels): gitleaks + real values
# 2. files that must never be in an image: SSH host keys, private keys,
#    tool credentials, logged-in state
# 3. gitleaks over the parts of the filesystem we author (third-party
#    package trees excluded, see scripts/gitleaks-image.toml)
# 4. real values from $IDEA_SECRETS_DIR anywhere in the filesystem
#
# Values are never printed.

. "$(dirname "$0")/lib.sh"
need podman gitleaks jq yq

img="${1:-}"
[ -n "$img" ] || die "usage: $0 <image>"

fail=0
bad() { echo "FAIL: $*" >&2; fail=1; }
ok()  { echo "ok:   $*" >&2; }

WORK="$(mktemp -d "$IDEA_DATA_DIR/build/scan.XXXXXX")"
PAT="$(mktemp -d /dev/shm/idea-img.XXXXXX)"; chmod 700 "$PAT"
trap 'rm -rf "$WORK" "$PAT"' EXIT

collect_secret_values "$PAT/pairs"
cut -f2- "$PAT/pairs" > "$PAT/all"

# ---- 1. history and config
mkdir -p "$WORK/meta"
podman history --no-trunc --format '{{.CreatedBy}}' "$img" > "$WORK/meta/history.txt"
podman image inspect "$img" --format '{{json .Config}}' > "$WORK/meta/config.json"
gitleaks dir --no-banner --redact --log-level=error "$WORK/meta" \
  && ok "gitleaks (history, config)" || bad "gitleaks found a secret in image history or config"
if [ -s "$PAT/all" ] && [ "$(cat "$WORK"/meta/* | grep -cFf "$PAT/all")" -gt 0 ]; then
  bad "a value from the secrets dir is in image history or config"
else
  ok "no secret value in history or config"
fi

# ---- export the filesystem
mkdir -p "$WORK/fs"
cid="$(podman create "$img")"
podman export "$cid" | tar -x -C "$WORK/fs" --no-same-owner \
  --exclude='dev/*' --exclude='proc/*' --exclude='sys/*' 2>/dev/null || true
podman rm "$cid" >/dev/null
cd "$WORK/fs"

# ---- 2. files that must not exist
hits="$(
  { find etc/ssh -maxdepth 1 -name 'ssh_host_*' 2>/dev/null
    find . -xdev \( -name 'id_rsa' -o -name 'id_ed25519' -o -name 'id_ecdsa' -o -name 'id_dsa' \
      -o -name '.netrc' -o -name '.git-credentials' -o -name '.pypirc' \
      -o -name 'authorized_keys' -o -name 'known_hosts' -o -name 'credentials.json' \
      -o -name '.credentials.json' -o -name 'kubeconfig' -o -name 'talosconfig' \) -type f 2>/dev/null
    find home root -mindepth 2 \( -path '*/.docker/config.json' -o -path '*/.aws/*' \
      -o -path '*/.config/gh/*' -o -path '*/.claude*' -o -path '*/.codex/*' \
      -o -path '*/.config/google-chrome/*' -o -path '*/.config/chromium/*' -o -path '*/.kube/*' \) 2>/dev/null
    # .npmrc is fine as plain configuration (npm ships one); not with credentials.
    find . -xdev -name '.npmrc' -type f -exec grep -lE '_auth|_password|:username' {} + 2>/dev/null || true
  } | sort -u)"
if [ -n "$hits" ]; then
  bad "credential or key files in the image:"; echo "$hits" | sed 's/^/        /' >&2
else
  ok "no key or credential files"
fi

# Private key material anywhere. Known public test fixtures can be allowed in
# images/<name>/private-key-allowlist (one path regex per line).
allow="$REPO_ROOT/images/worker/private-key-allowlist"
# A header alone is not a key (docs and parsers mention it); require a body.
keys="$(grep -rlIPzo -- '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----\s*\n[A-Za-z0-9+/=]{40,}' . 2>/dev/null | sed 's|^\./||' | sort || true)"
if [ -n "$keys" ] && [ -s "$allow" ]; then
  keys="$(echo "$keys" | grep -vEf <(grep -vE '^\s*(#|$)' "$allow") || true)"
fi
if [ -n "$keys" ]; then
  bad "private key material in the image:"; echo "$keys" | sed 's/^/        /' >&2
else
  ok "no private key material"
fi

# ---- 3. gitleaks over what we author
scan=()
for d in home root etc/idea etc/ssh usr/local/bin tmp; do [ -e "$d" ] && scan+=("$d"); done
leak=0
for d in "${scan[@]}"; do
  gitleaks dir --no-banner --redact --log-level=error \
    --config "$REPO_ROOT/scripts/gitleaks-image.toml" "$d" || leak=1
done
[ "$leak" = 0 ] && ok "gitleaks (image files)" || bad "gitleaks found a secret in image files"

# ---- 4. real values anywhere in the filesystem
if [ -s "$PAT/all" ]; then
  found="$(grep -rlFf "$PAT/all" . 2>/dev/null | sed 's|^\./||' | head -20 || true)"
  if [ -n "$found" ]; then
    bad "a value from the secrets dir is inside the image:"; echo "$found" | sed 's/^/        /' >&2
  else
    ok "no secret value in the image filesystem ($(wc -l < "$PAT/all") values checked)"
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "check-image: FAILED ($img)" >&2
  exit 1
fi
echo "check-image: passed ($img)" >&2
