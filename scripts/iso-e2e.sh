#!/usr/bin/env bash
# Acceptance test for the installer ISO, done the way an owner would do it:
# no talosctl, no kubectl. Only what the machine shows and serves.
#
#   1. boot a blank VM from the ISO (iso-test.sh), send it nothing
#   2. read the setup code off its console
#   3. enter the model keys on the setup page
#   4. log in to Forgejo with the account the page shows, open an issue
#   5. wait for the pull request to be merged
#
#   iso-e2e.sh <iso>          boot a fresh VM first
#   iso-e2e.sh --running      use the VM that is already up
#
# VM shape: ISO_TEST_DISKS, ISO_TEST_UEFI, ISO_TEST_MEMORY_MB (iso-test.sh).

. "$(dirname "$0")/lib.sh"
need curl jq python3

S="$REPO_ROOT/scripts"
CONSOLE="$IDEA_DATA_DIR/logs/idea-iso-1-console.log"
t0=$(date +%s)
mark() { printf '%5ds  %s\n' "$(( $(date +%s) - t0 ))" "$*"; }
wait_for() { # wait_for <seconds> <description> <command...>
  local limit=$1 what=$2; shift 2
  local end=$(( $(date +%s) + limit ))
  until "$@" >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$end" ] || die "timed out waiting for: $what"
    sleep 5
  done
  mark "$what"
}

case "${1:-}" in
  --running) ;;
  "") die "usage: $0 <iso> | --running" ;;
  *) "$S/iso-test.sh" create "$1" >/dev/null 2>&1 || die "could not start the test VM"
     mark "blank VM booted from $(basename "$1"); nothing else is sent to it" ;;
esac

# Everything secret stays in RAM and is removed on exit.
T="$(mktemp -d /dev/shm/idea-iso-e2e.XXXXXX)"; chmod 700 "$T"
trap 'rm -rf "$T"' EXIT

console() { sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' "$CONSOLE" | tr -d '\r'; }
# (Captured first: `grep -q` on a pipe ends early and, under pipefail, turns a
# match into a failure.)
seen() { local o; o="$(console)"; grep -q "$1" <<<"$o"; }
announced() { seen 'idea: setup code'; }
wait_for 600 "machine installed itself and shows the setup page address" announced
console | sed -n 's/.*idea: setup code  *//p' | tail -n 1 | tr -d '\n' > "$T/code"
url="$(console | sed -n 's/.*idea: setup page  *//p' | tail -n 1)"
ip="$(sed -E 's#https://([0-9.]+):.*#\1#' <<<"$url")"
[ -s "$T/code" ] && [ -n "$ip" ] || die "could not read the setup page address and code from the console"
seen 'generated new cluster secrets' && mark "secrets were generated on the machine" \
  || mark "secrets came with the ISO (--embed-secrets build)"

page() { curl -sk -m 20 "$@"; }
wait_for 2700 "setup page answers at $url" page -o /dev/null -f "$url"

# A wrong code must not open the page.
page --data-urlencode "code=wrong-code-0000" "$url" | grep -c '맞지 않습니다' >/dev/null \
  || die "the setup page accepted a wrong code"
mark "wrong setup code rejected"

# Model keys, from the file a human keeps on this host; never on a command line.
envf="$IDEA_SECRETS_DIR/env"
sed -n 's/^DEEPSEEK_API_KEY=//p' "$envf" | tr -d '\n' > "$T/deepseek"
sed -n 's/^CLAUDE_CODE_OAUTH_TOKEN=//p' "$envf" | tr -d '\n' > "$T/claude"
[ -s "$T/deepseek" ] || die "$envf has no DEEPSEEK_API_KEY"
page --data-urlencode "code@$T/code" --data-urlencode "deepseek@$T/deepseek" \
     --data-urlencode "claude@$T/claude" "${url}keys" > "$T/page.html"
grep -q '저장했습니다' "$T/page.html" || die "the setup page did not save the keys"
mark "model keys entered on the setup page"

# The account the page shows.
python3 -I - "$T" <<'PY'
import html, re, sys, os
t = sys.argv[1]
page = open(os.path.join(t, "page.html"), encoding="utf-8").read()
def field(label):
    m = re.search(r"<dt>%s</dt><dd class=\"mono\">(.*?)</dd>" % label, page, re.S)
    return html.unescape(m.group(1)) if m else ""
user, password = field("계정"), field("비밀번호")
if not user or not password:
    sys.exit("no account on the setup page")
with open(os.open(os.path.join(t, "curlrc"), os.O_WRONLY | os.O_CREAT, 0o600), "w") as f:
    f.write('user = "%s:%s"\n' % (user.replace('"', '\\"'), password.replace('"', '\\"')))
PY

# Admin access for the owner is offered as well.
page --data-urlencode "code@$T/code" "${url}talosconfig" > "$T/talosconfig"
grep -q '^contexts:' "$T/talosconfig" || die "the setup page did not hand out a talosconfig"
if [ "${KEEP_TALOSCONFIG:-0}" = 1 ]; then
  install -d -m 700 "$IDEA_SECRETS_DIR/iso"
  install -m 600 "$T/talosconfig" "$IDEA_SECRETS_DIR/iso/talosconfig-generated"
fi
mark "talosconfig offered by the setup page"

# Forgejo, by its name, as a browser would reach it.
fj() { # fj METHOD PATH [JSON]
  local method=$1 path=$2 body=${3:-}
  curl -sk -m 30 -K "$T/curlrc" --resolve "$INGRESS_HOST:443:$ip" -X "$method" \
    ${body:+-H 'Content-Type: application/json' --data "$body"} \
    "https://$INGRESS_HOST/git/api/v1$path"
}
repo_ready() { fj GET /repos/idea/hello-calc/hooks | jq -e 'length >= 1'; }
wait_for 1800 "Forgejo is up and the repository is prepared" repo_ready

issue="$(fj POST /repos/idea/hello-calc/issues "$(jq -n \
  --arg t "Add a negate function" \
  --arg b 'Add a function `negate(n)` to `src/calc.js` that returns -n, export it, and add tests for it.' \
  '{title: $t, body: $b}')" | jq -r .number)"
[ -n "$issue" ] && [ "$issue" != null ] || die "could not open the issue"
mark "issue #$issue opened in the Forgejo of the new machine"

merged() { fj GET "/repos/idea/hello-calc/pulls?state=closed" | jq -e 'map(select(.merged)) | length >= 1'; }
wait_for 1800 "pull request merged" merged
fj GET "/repos/idea/hello-calc/pulls?state=closed" \
  | jq -r '.[] | select(.merged) | "pull request #\(.number) merged: \(.title)"'
mark "PASS"
