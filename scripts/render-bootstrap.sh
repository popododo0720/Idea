#!/usr/bin/env bash
# Build the Talos machine-config patch that plants Cilium, Flux and the root
# source at first boot (KubeInlineManifestConfig documents).
#
#   render-bootstrap.sh [dev|public]   which entry point the cluster follows
#
# Output: _out/talos/bootstrap.yaml (dev) or bootstrap-public.yaml
#         (generated, not committed, no secrets)
# Also refreshes deploy/bootstrap/flux/gotk-components.yaml for FLUX_VERSION.

. "$(dirname "$0")/lib.sh"
need helm flux yq

CLUSTER="${1:-dev}"
case "$CLUSTER" in dev|public) ;; *) die "usage: $0 [dev|public]" ;; esac

OUT="$REPO_ROOT/_out/talos"
mkdir -p "$OUT"
D="$REPO_ROOT/deploy"

# ---- Flux controllers (source, kustomize, helm only)
flux install --export \
  --version "$FLUX_VERSION" \
  --components source-controller,kustomize-controller,helm-controller \
  > "$D/bootstrap/flux/gotk-components.yaml" 2>/dev/null

# ---- Cilium, rendered from the same values Flux will use afterwards
hr="$D/infra/controllers/cilium/helmrelease.yaml"
chart_version="$(yq '.spec.chart.spec.version' "$hr")"
[ "$chart_version" = "$CILIUM_VERSION" ] \
  || die "Cilium version differs: HelmRelease $chart_version, versions.env $CILIUM_VERSION"
repo="$(yq '.spec.url' "$D/infra/controllers/cilium/helmrepository.yaml")"
yq '.spec.values' "$hr" > "$OUT/cilium-values.yaml"
helm template "$(yq '.spec.releaseName' "$hr")" cilium \
  --repo "$repo" --version "$chart_version" \
  --namespace "$(yq '.metadata.namespace' "$hr")" \
  --kube-version "${KUBERNETES_VERSION#v}" \
  -f "$OUT/cilium-values.yaml" > "$OUT/cilium.yaml"

# The bootstrap manifest ends up in the machine config; it must not carry keys.
if [ -n "$(yq -N 'select(.kind == "Secret" and ((.data // {}) | length > 0 or (.stringData // {}) | length > 0)) | .metadata.name' "$OUT/cilium.yaml")" ]; then
  die "rendered Cilium manifest contains a Secret with data"
fi

# ---- compose the patch
patch="$OUT/bootstrap.yaml"
[ "$CLUSTER" = dev ] || patch="$OUT/bootstrap-$CLUSTER.yaml"
: > "$patch"
add() { # add <name> <file>
  {
    [ -s "$patch" ] && echo '---'
    NAME="$1" FILE="$2" yq -n '
      .apiVersion = "v1alpha1" |
      .kind = "KubeInlineManifestConfig" |
      .name = strenv(NAME) |
      .manifest = load_str(strenv(FILE))'
  } >> "$patch"
}
add idea-cilium "$OUT/cilium.yaml"
add idea-flux   "$D/bootstrap/flux/gotk-components.yaml"
add idea-root   "$D/clusters/$CLUSTER/root.yaml"

log "wrote $patch ($(du -h "$patch" | cut -f1))"
