#!/bin/sh
# idea-setup: turn a blank machine booted from the ISO into a configured one.
#
# Nothing here is specific to one installation. Secrets are generated on the
# machine unless the ISO was built with its own (kernel arg idea.secrets=embedded,
# used for development so the builder keeps admin access).
set -eu

log() { echo "idea-setup: $*"; }
T=/bin/talosctl
W=/work
. /etc/idea/setup.env   # CLUSTER_NAME KUBERNETES_VERSION INSTALLER_IMAGE

MODE="${1:-generate}"   # generate | embedded (see idea-setup-embedded.yaml)
arg() { tr ' ' '\n' < /proc/cmdline | sed -n "s/^$1=//p" | tail -n 1; }

# On a configured machine the embedded-mode service is started with this
# marker (see the end of this script) so that it finishes instead of waiting
# for a configuration forever, which would hold up the boot sequence.
if [ "${IDEA_CONFIGURED:-}" = 1 ]; then
  log "machine already has a configuration; nothing to do"
  exit 0
fi

if [ "$MODE" = generate ] && [ "$(arg idea.secrets)" = embedded ]; then
  log "this ISO carries its own secrets; idea-setup-embedded takes over"
  exit 0
fi

# ---- 1. only act in maintenance mode
tls=0; n=0
while :; do
  if out="$($T get machinestatus --insecure -n 127.0.0.1 -o yaml 2>&1)"; then
    case "$out" in *"stage: maintenance"*) break ;; esac
  fi
  case "$out" in
    *certificate*|*tls:*) tls=$((tls + 1)) ;;
  esac
  [ "$tls" -lt 3 ] || { log "machine already has a configuration; nothing to do"; exit 0; }
  n=$((n + 1))
  [ $((n % 12)) -ne 1 ] || log "waiting for the maintenance API: $(echo "$out" | tail -n 1)"
  [ "$n" -lt 240 ] || { log "maintenance API did not answer"; exit 1; }
  sleep 5
done
log "blank machine in maintenance mode: configuring it"

# ---- 2. address
ip=""
for _ in $(seq 1 60); do
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
  [ -z "$ip" ] || break
  sleep 2
done
[ -n "$ip" ] || { log "no IPv4 address (is there DHCP on this network?)"; exit 1; }

# ---- 3. disks: first fixed disk of 16GB or more is the system disk, the next
#         one (if any) holds persistent volumes. Override: idea.disk=/dev/xxx
disks=""
for d in /sys/block/*; do
  name="${d##*/}"
  case "$name" in loop*|ram*|zram*|sr*|dm-*|md*|nbd*|fd*) continue ;; esac
  [ "$(cat "$d/removable" 2>/dev/null || echo 1)" = 0 ] || continue
  [ "$(cat "$d/ro" 2>/dev/null || echo 1)" = 0 ] || continue
  [ "$(cat "$d/size")" -ge 33554432 ] || continue   # 512-byte sectors
  disks="$disks /dev/$name"
done
set -- $disks
sysdisk="$(arg idea.disk)"
datadisk=""
if [ -z "$sysdisk" ]; then
  [ "$#" -ge 1 ] || { log "no disk of 16GB or more found"; exit 1; }
  sysdisk="$1"; datadisk="${2:-}"
else
  for d in "$@"; do [ "$d" = "$sysdisk" ] || { datadisk="$d"; break; }; done
fi
log "address $ip, system disk $sysdisk, data disk ${datadisk:-none (system disk)}"

# ---- 4. secrets
if [ "$MODE" = embedded ]; then
  [ -s /etc/idea/secrets.yaml ] || { log "embedded secrets are not mounted"; sleep 5; exit 1; }
  cp /etc/idea/secrets.yaml "$W/secrets.yaml"
  log "using the secrets built into this ISO"
else
  $T gen secrets -o "$W/secrets.yaml" >/dev/null
  log "generated new cluster secrets on this machine"
fi

# ---- 5. machine configuration
# Persistent volumes: a second disk if there is one, otherwise a directory on
# the system disk (Talos mounts either at /var/mnt/local-path-provisioner).
{
  echo 'apiVersion: v1alpha1'
  echo 'kind: UserVolumeConfig'
  echo 'name: local-path-provisioner'
  if [ -n "$datadisk" ]; then
    echo 'provisioning:'
    echo '  diskSelector:'
    echo "    match: disk.dev_path == \"$datadisk\""
    echo '  minSize: 20GB'
  else
    echo 'volumeType: directory'
  fi
} > "$W/volume.yaml"

patches=""
for f in /etc/idea/patches/*.yaml; do patches="$patches --config-patch-control-plane @$f"; done
# shellcheck disable=SC2086
$T gen config "$CLUSTER_NAME" "https://$ip:6443" \
  --with-secrets "$W/secrets.yaml" \
  --kubernetes-version "$KUBERNETES_VERSION" \
  --install-disk "$sysdisk" \
  --install-image "$INSTALLER_IMAGE" \
  $patches \
  --config-patch-control-plane "@$W/volume.yaml" \
  --with-docs=false --with-examples=false \
  --output-types controlplane,talosconfig \
  --output "$W" --force >/dev/null

# Setup code: shown on this machine's console and asked for by the setup page
# (controller/setup.go). Whoever can read the console owns the machine.
code="$(tr -dc 'abcdefghjkmnpqrstuvwxyz23456789' < /dev/urandom | head -c 12)"
code="$(echo "$code" | sed 's/^\(....\)\(....\)\(....\)$/\1-\2-\3/')"

# The installed system needs admin access to its own API once, to bootstrap
# etcd. It travels inside the machine configuration, next to the CA it was
# signed with. The same file and the setup code are planted in the cluster as
# a Secret for the setup page.
{
  echo '---'
  echo 'apiVersion: v1alpha1'
  echo 'kind: ExtensionServiceConfig'
  echo 'name: idea-bootstrap'
  echo 'configFiles:'
  echo '  - content: |'
  sed 's/^/      /' "$W/talosconfig"
  echo '    mountPath: /etc/idea/talosconfig'
  echo "  - content: $code"
  echo '    mountPath: /etc/idea/setup-code'
  echo '---'
  echo 'apiVersion: v1alpha1'
  echo 'kind: KubeInlineManifestConfig'
  echo 'name: idea-setup'
  echo 'manifest: |'
  echo '  apiVersion: v1'
  echo '  kind: Secret'
  echo '  metadata:'
  echo '    name: idea-setup'
  echo '    namespace: kube-system'
  echo '  type: Opaque'
  echo '  stringData:'
  echo "    code: $code"
  echo '    talosconfig: |'
  sed 's/^/      /' "$W/talosconfig"
  echo '---'
  echo 'apiVersion: v1alpha1'
  echo 'kind: ExtensionServiceConfig'
  echo 'name: idea-setup-embedded'
  echo 'environment:'
  echo '  - IDEA_CONFIGURED=1'
} >> "$W/controlplane.yaml"

$T validate --config "$W/controlplane.yaml" --mode metal >/dev/null
log "applying the configuration; Talos installs to $sysdisk and reboots"
$T apply-config --insecure -n 127.0.0.1 --file "$W/controlplane.yaml"
rm -f "$W"/*
log "done"
