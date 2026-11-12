#!/usr/bin/env bash
# End-to-end acceptance test: from nothing to a merged pull request.
#
#   e2e.sh             rebuild the VM from scratch, then run one issue through
#   e2e.sh --no-rebuild   keep the running cluster, only run one issue through
#
# After the Talos config is applied, the only command sent to the cluster is
# apply-secrets.sh (the human-provided keys). Everything else must converge on
# its own. Prints a timeline and exits non-zero if any step times out.

. "$(dirname "$0")/lib.sh"
need kubectl flux jq

REBUILD=1
[ "${1:-}" = "--no-rebuild" ] && REBUILD=0
S="$REPO_ROOT/scripts"
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

all_kustomizations_ready() {
  local out
  out="$(kubectl -n flux-system get kustomization --no-headers 2>/dev/null)" || return 1
  [ "$(wc -l <<<"$out")" -ge 6 ] && ! awk '$3 != "True"' <<<"$out" | grep -q .
}
namespaces_exist() { local n; for n in $SECRET_NAMESPACES; do kubectl get namespace "$n" || return 1; done; }
repo_ready() { "$S/forgejo-api.sh" GET "/repos/idea/hello-calc/hooks" | jq -e 'length >= 1'; }
runner_ready() { kubectl -n idea-work logs deploy/idea-runner --tail=50 | grep -q 'declared successfully'; }

if [ "$REBUILD" = 1 ]; then
  mark "rebuilding $VM_NAME from scratch"
  "$S/push-deploy.sh" --no-wait >/dev/null 2>&1 || die "push-deploy failed"
  "$S/vm-destroy.sh" >/dev/null 2>&1
  "$S/vm-create.sh" >/dev/null 2>&1 || die "vm-create failed"
  "$S/talos-apply.sh" >/dev/null 2>&1 || die "talos-apply failed"
  mark "Talos config applied; from here the cluster converges on its own"
  wait_for 1500 "namespaces for the human-provided keys exist" namespaces_exist
  "$S/apply-secrets.sh" >/dev/null 2>&1 || die "apply-secrets failed"
  mark "apply-secrets.sh run (the one manual step)"
fi

wait_for 2400 "all Flux Kustomizations Ready" all_kustomizations_ready
wait_for 600 "controller has set up Forgejo (repository, webhook)" repo_ready
wait_for 600 "Actions runner registered" runner_ready

title="Add a negate function"
body='Add a function `negate(n)` to `src/calc.js` that returns -n, export it, and add tests for it.'
issue="$("$S/forgejo-api.sh" POST /repos/idea/hello-calc/issues \
  "$(jq -n --arg t "$title" --arg b "$body" '{title: $t, body: $b}')" | jq -r .number)"
[ -n "$issue" ] && [ "$issue" != null ] || die "could not open the issue"
task="hello-calc-issue-$issue"
mark "issue #$issue opened (the human's part)"

phase() { kubectl -n idea-system get task "$task" -o jsonpath='{.status.phase}' 2>/dev/null; }
last=""
end=$(( $(date +%s) + 1500 ))
while :; do
  p="$(phase || true)"
  if [ -n "$p" ] && [ "$p" != "$last" ]; then mark "task $task: $p"; last="$p"; fi
  case "$p" in Done) break ;; Failed) die "task failed: $(kubectl -n idea-system get task "$task" -o jsonpath='{.status.message}')" ;; esac
  [ "$(date +%s)" -lt "$end" ] || die "timed out waiting for the task"
  sleep 5
done
kubectl -n idea-system get task "$task" -o jsonpath='{.status.message}{"\n"}'
mark "PASS"
