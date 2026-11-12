#!/usr/bin/env bash
# Publish deploy/ as an OCI artifact to the local registry. The cluster's
# root OCIRepository follows the tag and Flux reconciles from there.
#
#   push-deploy.sh            push, then wait for the cluster to converge
#   push-deploy.sh --no-wait  push only (e.g. before the cluster exists)

. "$(dirname "$0")/lib.sh"
need flux git kubectl

WAIT=1
case "${1:-}" in
  "") ;;
  --no-wait) WAIT=0 ;;
  *) die "usage: $0 [--no-wait]" ;;
esac

# Nothing leaves the repo without passing the secret check.
"$REPO_ROOT/scripts/check-secrets.sh"

cd "$REPO_ROOT"
for d in clusters/dev bootstrap/flux infra/controllers infra/config platform apps; do
  kubectl kustomize "deploy/$d" >/dev/null || die "deploy/$d does not build"
done

rev="$(git rev-parse --abbrev-ref HEAD)@sha1:$(git rev-parse HEAD)"
[ -z "$(git status --porcelain -- deploy)" ] || rev="$rev-dirty"
url="oci://$REGISTRY_ADDR/idea/deploy:dev"

log "pushing deploy/ to $url ($rev)"
flux push artifact "$url" \
  --path "$REPO_ROOT/deploy" \
  --source "$(git config --get remote.origin.url)" \
  --revision "$rev" \
  --insecure-registry

[ "$WAIT" = 1 ] || exit 0

log "asking Flux to pick up the new artifact"
flux reconcile source oci idea-deploy --timeout 2m >/dev/null
flux reconcile kustomization idea-root --timeout 5m >/dev/null
log "waiting for all Kustomizations to be Ready"
kubectl -n flux-system wait kustomization --all --for=condition=Ready --timeout=20m
flux get kustomizations
