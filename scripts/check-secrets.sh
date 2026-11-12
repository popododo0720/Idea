#!/usr/bin/env bash
# Fail if anything that must stay out of the public repo got in.
#
#   check-secrets.sh            working tree + full history
#   check-secrets.sh --staged   staged changes only (used by the pre-commit hook)
#
# Checks (PLAN.md 4.5, 4.7):
#   1. gitleaks
#   2. no "kind: Secret" manifest under deploy/
#   3. no real value from $IDEA_SECRETS_DIR appears in the repo
#   4. no string from $IDEA_SECRETS_DIR/private-strings appears in the repo
#   5. commit author/committer e-mails are GitHub noreply addresses
#
# Values are never printed: only file paths, key names, line numbers, commits.

. "$(dirname "$0")/lib.sh"
need gitleaks git jq yq

MODE=full
case "${1:-}" in
  "") ;;
  --staged) MODE=staged ;;
  *) die "usage: $0 [--staged]" ;;
esac

cd "$REPO_ROOT"
fail=0
bad() { echo "FAIL: $*" >&2; fail=1; }
ok()  { echo "ok:   $*" >&2; }

has_commits() { git rev-parse --verify -q HEAD >/dev/null; }

# Scratch space for pattern files lives in RAM and is removed on exit.
TMP="$(mktemp -d /dev/shm/idea-check.XXXXXX)"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

MARK='@@idea-commit '

# Text streams to search, one per mode.
tree_files() { git ls-files -co --exclude-standard -z; }
staged_added() { git diff --cached -U0 --no-color --diff-filter=ACMR | grep -E '^\+' | grep -vE '^\+\+\+ ' || true; }
history() { has_commits && git log --all -p --no-color --format="$MARK%h" || true; }

# search <patterns-file> <label>
#   Prints where any pattern occurs. Returns 0 if something was found.
search() {
  local pats=$1 label=$2 found=1 out
  [ -s "$pats" ] || return 1
  if [ "$MODE" = staged ]; then
    if staged_added | grep -qFf "$pats"; then
      echo "      $label: in staged changes:" >&2
      git diff --cached --name-only --diff-filter=ACMR -z |
        while IFS= read -r -d '' f; do
          git show ":$f" 2>/dev/null | grep -nFf "$pats" | cut -d: -f1 |
            sed "s|^|        $f:|" >&2 || true
        done
      found=0
    fi
    return $found
  fi
  out="$(tree_files | xargs -0 -r grep -nIFf "$pats" -- 2>/dev/null | cut -d: -f1,2 || true)"
  if [ -n "$out" ]; then
    echo "      $label: in working tree:" >&2
    echo "$out" | sed 's/^/        /' >&2
    found=0
  fi
  out="$(history | grep -Ff "$pats" -e "$MARK" |
    awk -v m="$MARK" 'index($0,m)==1 {c=substr($0,length(m)+1); next} c!=last {print c; last=c}' || true)"
  if [ -n "$out" ]; then
    echo "      $label: in history, commits:" >&2
    echo "$out" | sort -u | sed 's/^/        /' >&2
    found=0
  fi
  return $found
}

# ------------------------------------------------------------- 1. gitleaks
if [ "$MODE" = staged ]; then
  gitleaks git --staged --pre-commit --no-banner --redact --log-level=error . \
    && ok "gitleaks (staged)" || bad "gitleaks found a secret in staged changes"
else
  gitleaks dir --no-banner --redact --log-level=error . \
    && ok "gitleaks (working tree)" || bad "gitleaks found a secret in the working tree"
  if has_commits; then
    gitleaks git --no-banner --redact --log-level=error --log-opts=--all . \
      && ok "gitleaks (history)" || bad "gitleaks found a secret in history"
  fi
fi

# ------------------------------------------- 2. no Secret manifests in deploy/
secret_re='^[[:space:]]*kind:[[:space:]]*["'"'"']?Secret["'"'"']?[[:space:]]*$'
if [ "$MODE" = staged ]; then
  hits="$(git diff --cached --name-only --diff-filter=ACMR -z -- deploy |
    while IFS= read -r -d '' f; do
      git show ":$f" | grep -qE "$secret_re" && echo "$f"
    done || true)"
else
  hits="$(grep -rlE "$secret_re" deploy 2>/dev/null || true)"
fi
if [ -n "$hits" ]; then
  bad "kind: Secret under deploy/:"; echo "$hits" | sed 's/^/        /' >&2
else
  ok "no Secret manifests under deploy/"
fi

# ------------------------------------------------ 3. real secret values
# Collect "source<TAB>value" pairs; values stay in $TMP and in memory only.
pairs="$TMP/pairs"; : > "$pairs"

envf="$IDEA_SECRETS_DIR/env"
if [ -f "$envf" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    k="${line%%=*}"; v="${line#*=}"
    [ "$k" != "$line" ] || continue
    k="${k#export }"
    v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
    [ "${#v}" -ge 8 ] || continue
    printf '%s\t%s\n' "env:$k" "$v" >> "$pairs"
  done < "$envf"
fi

for y in talos/secrets.yaml talos/talosconfig kubeconfig; do
  f="$IDEA_SECRETS_DIR/$y"
  [ -f "$f" ] || continue
  yq -o=json '[.. | select(tag == "!!str") | {"k": (path | join(".")), "v": .}]' "$f" |
    jq -r --arg src "$y" '.[] | .k as $k | .v | split("\n")[]
      | select(length >= 16) | select(test("^https?://") | not)
      | "\($src):\($k)\t\(.)"' >> "$pairs"
done

if [ -s "$pairs" ]; then
  cut -f2- "$pairs" > "$TMP/all"
  if search "$TMP/all" "secret value" 2>/dev/null; then
    bad "a value from $IDEA_SECRETS_DIR is in the repo. Stop, report, and rotate it."
    # Name the offending keys (never the values).
    while IFS=$'\t' read -r src v; do
      printf '%s\n' "$v" > "$TMP/one"
      search "$TMP/one" "$src" || true
    done < "$pairs"
  else
    ok "no value from the secrets dir is in the repo ($(wc -l < "$pairs") values checked)"
  fi
else
  ok "secrets dir has no values to compare yet"
fi

# ------------------------------------------------ 4. private strings
priv="$IDEA_SECRETS_DIR/private-strings"
if [ -f "$priv" ]; then
  grep -vE '^[[:space:]]*(#|$)' "$priv" > "$TMP/priv" || true
  if [ -s "$TMP/priv" ]; then
    if search "$TMP/priv" "private string"; then
      bad "a string from private-strings is in the repo"
    else
      ok "no private string in the repo ($(wc -l < "$TMP/priv") strings checked)"
    fi
  else
    echo "warn: $priv is empty" >&2
  fi
else
  echo "warn: $priv does not exist: private-string check skipped" >&2
fi

# ------------------------------------------------ 5. commit e-mails
noreply='@users\.noreply\.github\.com$'
if [ "$MODE" = staged ]; then
  mails="$(git var GIT_AUTHOR_IDENT; git var GIT_COMMITTER_IDENT)"
  mails="$(echo "$mails" | sed -E 's/.*<([^>]*)>.*/\1/' | sort -u)"
else
  mails="$(has_commits && git log --all --format='%ae%n%ce' | sort -u || true)"
fi
if [ -n "$mails" ] && echo "$mails" | grep -qvE "$noreply"; then
  bad "a commit e-mail is not a GitHub noreply address (set git config user.email in this repo)"
else
  ok "commit e-mails are noreply addresses"
fi

if [ "$fail" -ne 0 ]; then
  echo "check-secrets: FAILED" >&2
  exit 1
fi
echo "check-secrets: passed ($MODE)" >&2
