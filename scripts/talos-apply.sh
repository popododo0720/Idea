#!/usr/bin/env bash
# Generate the Talos machine config into the secrets directory, apply it to
# the freshly booted VM, bootstrap the cluster and fetch kubeconfig.
# Nothing this script writes goes into the repo.

. "$(dirname "$0")/lib.sh"
need talosctl kubectl envsubst curl

S="$IDEA_SECRETS_DIR/talos"
install -d -m 700 "$IDEA_SECRETS_DIR" "$S"
umask 077

retry() { # retry <tries> <sleep> <cmd...>
  local n=$1 s=$2 i; shift 2
  for i in $(seq 1 "$n"); do
    "$@" >/dev/null 2>&1 && return 0
    sleep "$s"
  done
  return 1
}

# ---- 1. secrets (kept across VM rebuilds)
if [ ! -s "$S/secrets.yaml" ]; then
  log "generating Talos secrets"
  talosctl gen secrets -o "$S/secrets.yaml"
fi

# ---- 2. render host patch (no secrets) and any extra generated patches
OUT="$REPO_ROOT/_out/talos"
mkdir -p "$OUT"
NAMESERVER_LIST="$(for n in $NAMESERVERS; do printf '  - address: %s\n' "$n"; done)"
export NAMESERVER_LIST
envsubst '${NAMESERVER_LIST} ${REGISTRY_ADDR}' \
  < "$REPO_ROOT/images/talos/patches/host.yaml.tmpl" > "$OUT/host.yaml"

# base.yaml removes the control-plane taint, which only exists on control-plane
# configs, so it must be a control-plane patch.
patches=(--config-patch-control-plane "@$REPO_ROOT/images/talos/patches/base.yaml"
         --config-patch "@$OUT/host.yaml")
# Bootstrap manifests: Cilium, Flux and the root source, planted by Talos.
"$REPO_ROOT/scripts/render-bootstrap.sh"
patches+=(--config-patch-control-plane "@$OUT/bootstrap.yaml")

# Flux needs something to follow: the deploy artifact must already be in the
# registry before the cluster comes up.
curl -fsS -o /dev/null -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
  "http://$REGISTRY_ADDR/v2/idea/deploy/manifests/dev" \
  || die "deploy artifact not found in the registry: run scripts/push-deploy.sh --no-wait first"

# ---- 3. machine config
log "generating machine config for $CLUSTER_NAME"
talosctl gen config "$CLUSTER_NAME" "https://$NODE_IP:6443" \
  --with-secrets "$S/secrets.yaml" \
  --kubernetes-version "${KUBERNETES_VERSION#v}" \
  --install-disk /dev/vda \
  --install-image "factory.talos.dev/metal-installer/$TALOS_SCHEMATIC_ID:$TALOS_VERSION" \
  "${patches[@]}" \
  --with-docs=false --with-examples=false \
  --output-types controlplane,talosconfig \
  --output "$S" --force >/dev/null
chmod 600 "$S"/*
talosctl config endpoint "$NODE_IP" >/dev/null
talosctl config node "$NODE_IP" >/dev/null
talosctl validate --config "$S/controlplane.yaml" --mode metal >/dev/null

# ---- 4. apply to the node in maintenance mode
log "waiting for $NODE_IP to accept configuration (maintenance mode)"
retry 90 5 talosctl get disks --insecure -n "$NODE_IP" \
  || die "node did not come up in maintenance mode at $NODE_IP"
log "applying machine config"
talosctl apply-config --insecure -n "$NODE_IP" --file "$S/controlplane.yaml"

# ---- 5. bootstrap etcd once the installed system is up
log "waiting for the installed system, then bootstrapping"
bootstrap() {
  local out
  out="$(talosctl bootstrap -n "$NODE_IP" -e "$NODE_IP" 2>&1)" && return 0
  grep -qi 'AlreadyExists' <<<"$out" && return 0
  return 1
}
ok=0
for _ in $(seq 1 120); do
  if bootstrap; then ok=1; break; fi
  sleep 5
done
[ "$ok" = 1 ] || die "bootstrap did not succeed"

# ---- 6. kubeconfig
log "fetching kubeconfig"
retry 60 5 talosctl kubeconfig "$KUBECONFIG" -n "$NODE_IP" -e "$NODE_IP" --force \
  || die "could not fetch kubeconfig"
chmod 600 "$KUBECONFIG"

log "waiting for the Kubernetes API"
retry 120 5 kubectl get nodes || die "Kubernetes API did not answer"
kubectl get nodes -o wide
log "done: Talos plants Cilium and Flux; Flux takes it from here"
