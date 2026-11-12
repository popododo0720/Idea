#!/usr/bin/env bash
# Put the secrets only a human can provide into the cluster (PLAN.md 4.2).
#
# Reads $IDEA_SECRETS_DIR/env (KEY=VALUE, see .env.example) and creates or
# updates the Secret "idea-model-keys" in every namespace listed in
# SECRET_NAMESPACES (config.env). Run once after bootstrap and again whenever
# a value changes. Everything else in the cluster must work without it.
#
# Values never appear on a command line or in output: kubectl reads the file
# itself, and only key names are printed.

. "$(dirname "$0")/lib.sh"
need kubectl

envf="$IDEA_SECRETS_DIR/env"
[ -f "$envf" ] || die "$envf does not exist (copy .env.example there and fill it in)"
[ "$(stat -c %a "$envf")" = 600 ] || die "$envf must have mode 600"

# Keep only assignments that have a value.
tmp="$(mktemp -d /dev/shm/idea-secrets.XXXXXX)"; chmod 700 "$tmp"
trap 'rm -rf "$tmp"' EXIT
grep -E '^[A-Za-z_][A-Za-z0-9_]*=.+' "$envf" > "$tmp/env" || true
[ -s "$tmp/env" ] || die "$envf has no filled-in values"
keys="$(cut -d= -f1 "$tmp/env" | tr '\n' ' ')"

name=idea-model-keys
for ns in $SECRET_NAMESPACES; do
  if ! kubectl get namespace "$ns" >/dev/null 2>&1; then
    log "namespace $ns does not exist yet: skipped"
    continue
  fi
  kubectl -n "$ns" create secret generic "$name" \
      --from-env-file="$tmp/env" --dry-run=client -o yaml \
    | kubectl label --local -f - -o yaml \
        app.kubernetes.io/managed-by=apply-secrets \
    | kubectl apply -f - >/dev/null
  log "secret $ns/$name updated (keys: $keys)"
done
