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
# From DHCP, or set by hand on this console (Talos keeps that across the
# install by itself).
ip=""; n=0
while :; do
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
  [ -z "$ip" ] || break
  [ $((n % 30)) -ne 0 ] || log "no IPv4 address yet. No DHCP here? Press F3 on this console, set a static address, Save."
  n=$((n + 1)); sleep 2
done

# ---- 3. disks
# Candidates: fixed, writable, 16GB or more. A disk counts as used when it has
# partitions or anything Talos recognises on it.
used() {
  for p in /sys/block/"$1"/"$1"*; do [ ! -e "$p" ] || return 0; done
  sig="$($T get discoveredvolumes "$1" --insecure -n 127.0.0.1 -o yaml 2>/dev/null \
    | sed -n 's/^ *name: *//p' | tr -d '"' | head -n 1)"
  [ -n "$sig" ]
}
: > "$W/disks"
for d in /sys/block/*; do
  name="${d##*/}"
  case "$name" in loop*|ram*|zram*|sr*|dm-*|md*|nbd*|fd*) continue ;; esac
  [ "$(cat "$d/removable" 2>/dev/null || echo 1)" = 0 ] || continue
  [ "$(cat "$d/ro" 2>/dev/null || echo 1)" = 0 ] || continue
  sectors="$(cat "$d/size")"   # 512-byte sectors
  [ "$sectors" -ge 33554432 ] || continue
  u=0; ! used "$name" || u=1
  model="$(cat "$d/device/model" 2>/dev/null | tr -s ' ' | sed 's/^ //; s/ $//' || true)"
  echo "/dev/$name $((sectors / 2097152)) $u $model" >> "$W/disks"
done
count="$(grep -c . "$W/disks" || true)"
[ "$count" -ge 1 ] || { log "no disk of 16GB or more found"; sleep 30; exit 1; }
is_used() { while read -r dev _ u _; do [ "$dev" != "$1" ] || { [ "$u" = 1 ]; return; }; done < "$W/disks"; return 1; }
listed()  { while read -r dev _; do [ "$dev" != "$1" ] || return 0; done < "$W/disks"; return 1; }

sysdisk="$(arg idea.disk)"
datadisk=""
if [ -n "$sysdisk" ]; then
  # Chosen on the kernel command line: no questions.
  listed "$sysdisk" || { log "idea.disk=$sysdisk is not a usable disk"; sleep 30; exit 1; }
elif [ "$count" = 1 ] && ! is_used "$(sed -n 's/ .*//p;q' "$W/disks")"; then
  # One empty disk: nothing to lose and nothing to choose.
  sysdisk="$(sed -n 's/ .*//p;q' "$W/disks")"
else
  # Several disks, or data on one: a person decides, on the install page.
  rm -f "$W/choice"
  httpd -f -p 8080 -h /www &
  hp=$!
  n=0
  while [ ! -s "$W/choice" ]; do
    if [ $((n % 60)) -eq 0 ]; then
      log "=============================================================="
      log "this machine has $count disk(s); choose where to install:"
      log "install page   http://$ip:8080/"
      log "=============================================================="
    fi
    n=$((n + 1)); sleep 2
  done
  sleep 2   # let the page answer the browser
  kill "$hp" 2>/dev/null || true
  sysdisk="$(sed -n 1p "$W/choice")"
  datadisk="$(sed -n 2p "$W/choice")"
  listed "$sysdisk" || { log "invalid choice"; exit 1; }
fi
# A data disk that is not empty has to be wiped before Talos will use it.
if [ -n "$datadisk" ] && is_used "$datadisk"; then
  log "wiping data disk $datadisk"
  $T wipe disk "${datadisk#/dev/}" --insecure -n 127.0.0.1 \
    || { log "could not wipe $datadisk"; sleep 30; exit 1; }
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
