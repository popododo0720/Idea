#!/usr/bin/env bash
# Build the installer ISO: boot a blank machine from it and Talos installs
# itself, configures itself and bootstraps the cluster with nobody typing a
# command (images/talos/setup).
#
#   build-iso.sh                  the public ISO. Carries no secrets: each
#                                 machine generates its own. Images and the
#                                 deploy artifact come from $IMAGE_REPO.
#   build-iso.sh --dev            for this host's network: images and the deploy
#                                 artifact come from the local registry.
#   build-iso.sh --embed-secrets  additionally build one cluster's secrets into
#                                 the ISO, so the builder keeps admin access
#                                 ($IDEA_SECRETS_DIR/iso). Such an ISO is itself
#                                 a secret and stays under $IDEA_DATA_DIR.
#
# Output: $IDEA_DATA_DIR/iso/idea-<version>[-dev][-secrets]-amd64.iso
# The extension and installer images are pushed to the local registry; the
# public ISO needs them published (scripts/publish.sh) before it can install.

. "$(dirname "$0")/lib.sh"
need podman talosctl envsubst yq

DEV=0 EMBED=0
for a in "$@"; do
  case "$a" in
    --dev) DEV=1 ;;
    --embed-secrets) EMBED=1 ;;
    *) die "usage: $0 [--dev] [--embed-secrets]" ;;
  esac
done

tag="$TALOS_VERSION-setup$TALOS_SETUP_VERSION"
[ "$DEV" = 0 ] || tag="$tag-dev"
SETUP_LOCAL="$LOCAL_REPO/idea-talos-setup:$tag"
INSTALLER="idea-installer:$tag"
IMAGER="ghcr.io/siderolabs/imager:$TALOS_VERSION"
B="$IDEA_DATA_DIR/iso/build"
rm -rf "$B"; mkdir -p "$B/ext/patches" "$B/out"

# ---- 1. setup extension: scripts + talosctl + the config patches (no secrets)
cp -r "$REPO_ROOT/images/talos/setup/." "$B/ext/"
mkdir -p "$B/ext/www/design"
cp -r "$REPO_ROOT/console/design/idea.css" "$REPO_ROOT/console/design/fonts" "$B/ext/www/design/"
cp "$REPO_ROOT/images/talos/patches/base.yaml" "$B/ext/patches/10-base.yaml"
if [ "$DEV" = 1 ]; then
  "$REPO_ROOT/scripts/render-bootstrap.sh" dev
  NAMESERVER_LIST="$(for n in $NAMESERVERS; do printf '  - address: %s\n' "$n"; done)"
  export NAMESERVER_LIST
  envsubst '${NAMESERVER_LIST} ${REGISTRY_ADDR}' \
    < "$REPO_ROOT/images/talos/patches/host.yaml.tmpl" > "$B/ext/patches/20-host.yaml"
  cp "$REPO_ROOT/_out/talos/bootstrap.yaml" "$B/ext/patches/30-bootstrap.yaml"
else
  "$REPO_ROOT/scripts/render-bootstrap.sh" public
  cp "$REPO_ROOT/_out/talos/bootstrap-public.yaml" "$B/ext/patches/30-bootstrap.yaml"
fi
cp "$(command -v talosctl)" "$B/ext/talosctl"
[ "$(talosctl version --client --short 2>/dev/null | grep -o 'v[0-9.]*' | head -n 1)" = "$TALOS_VERSION" ] \
  || die "talosctl on this host is not $TALOS_VERSION"
cat > "$B/ext/setup.env" <<ENV
CLUSTER_NAME=$CLUSTER_NAME
KUBERNETES_VERSION=${KUBERNETES_VERSION#v}
INSTALLER_IMAGE=$IMAGE_REPO/$INSTALLER
ENV

log "building $SETUP_LOCAL"
podman build -q --build-arg BUSYBOX_IMAGE="$BUSYBOX_IMAGE" -t "$SETUP_LOCAL" "$B/ext" >/dev/null
podman push -q "$SETUP_LOCAL"

imager() {
  podman run --rm --network host -v "$B/out:/out" "$IMAGER" "$@" \
    --insecure \
    --extra-kernel-arg console=tty0 --extra-kernel-arg console=ttyS0 \
    --system-extension-image "$TALOS_KATA_EXTENSION" \
    --system-extension-image "$TALOS_QEMU_GA_EXTENSION" \
    --system-extension-image "$SETUP_LOCAL"
}

# ---- 2. installer image with the same extensions (what ends up on disk)
log "building $LOCAL_REPO/$INSTALLER"
imager installer >"$B/imager.log" 2>&1 || { tail -n 20 "$B/imager.log" >&2; die "imager failed"; }
podman load -q -i "$B/out/installer-amd64.tar" > "$B/loaded"
loaded="$(sed -n 's/^Loaded image[s]*: //p' "$B/loaded" | head -n 1)"
[ -n "$loaded" ] || die "could not load the installer image"
podman tag "$loaded" "$LOCAL_REPO/$INSTALLER"
podman push -q "$LOCAL_REPO/$INSTALLER"
rm -f "$B/out/installer-amd64.tar"

# ---- 3. the ISO
args=()
name="idea-$IDEA_VERSION"
[ "$DEV" = 0 ] || name="$name-dev"
if [ "$EMBED" = 1 ]; then
  D="$IDEA_SECRETS_DIR/iso"
  install -d -m 700 "$D"
  umask 077
  [ -s "$D/secrets.yaml" ] || talosctl gen secrets -o "$D/secrets.yaml"
  {
    echo 'apiVersion: v1alpha1'
    echo 'kind: ExtensionServiceConfig'
    echo 'name: idea-setup-embedded'
    echo 'configFiles:'
    echo '  - content: |'
    sed 's/^/      /' "$D/secrets.yaml"
    echo '    mountPath: /etc/idea/secrets.yaml'
  } > "$B/out/machine.yaml"
  # Admin access for the builder, from the same secrets.
  talosctl gen config "$CLUSTER_NAME" https://127.0.0.1:6443 --with-secrets "$D/secrets.yaml" \
    --output-types talosconfig --output "$D/talosconfig" --force >/dev/null
  args+=(--embedded-config-path=/out/machine.yaml --extra-kernel-arg idea.secrets=embedded)
  name="$name-secrets"
  log "secrets built in; admin talosconfig: $D/talosconfig"
fi

log "building the ISO"
imager iso "${args[@]}" >"$B/imager.log" 2>&1 || { tail -n 20 "$B/imager.log" >&2; die "imager failed"; }
rm -f "$B/out/machine.yaml"
iso="$IDEA_DATA_DIR/iso/$name-amd64.iso"
mv "$B/out/metal-amd64.iso" "$iso"
[ "$EMBED" = 0 ] || chmod 600 "$iso"
log "wrote $iso ($(du -h "$iso" | cut -f1))"
