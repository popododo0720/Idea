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
# A file that .gitignore hides is in the artifact but not in the repository:
# the cluster works while a clone of the repo does not build.
hidden="$(git ls-files --others --ignored --exclude-standard -- deploy images controller plugins examples scripts)"
[ -z "$hidden" ] || die "needed files are ignored by .gitignore (rename them): $(echo "$hidden" | tr '\n' ' ')"

for d in clusters/dev clusters/public bootstrap/flux infra/controllers infra/config platform apps apps-dev; do
  kubectl kustomize "deploy/$d" >/dev/null || die "deploy/$d does not build"
done

rev="$(git rev-parse --abbrev-ref HEAD)@sha1:$(git rev-parse HEAD)"
[ -z "$(git status --porcelain -- deploy)" ] || rev="$rev-dirty"
url="oci://$LOCAL_REPO/idea-deploy:dev"
# Push a copy whose dev root names LOCAL_REPO, so Flux keeps following this
# registry after it reconciles clusters/dev.
stage="$(mktemp -d)"; trap 'rm -rf "$stage"' EXIT
cp -r "$REPO_ROOT/deploy" "$stage/deploy"
URL="oci://$LOCAL_REPO/idea-deploy" yq -i \
  '(select(.kind == "OCIRepository") | .spec.url) = strenv(URL)' "$stage/deploy/clusters/dev/root.yaml"

log "pushing deploy/ to $url ($rev)"
flux push artifact "$url" \
  --path "$stage/deploy" \
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
