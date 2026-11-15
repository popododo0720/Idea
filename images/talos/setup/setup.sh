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
# shellcheck source=/dev/null # written by the ISO build
. /etc/idea/setup.env
: "${CLUSTER_NAME:?}" "${KUBERNETES_VERSION:?}" "${INSTALLER_IMAGE:?}"

MODE="${1:-generate}" # generate | embedded (see idea-setup-embedded.yaml)
arg() { tr ' ' '\n' </proc/cmdline | sed -n "s/^$1=//p" | tail -n 1; }

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
tls=0
n=0
while :; do
  if out="$($T get machinestatus --insecure -n 127.0.0.1 -o yaml 2>&1)"; then
    case "$out" in *"stage: maintenance"*) break ;; esac
  fi
  case "$out" in
    *certificate* | *tls:*) tls=$((tls + 1)) ;;
  esac
  [ "$tls" -lt 3 ] || {
    log "machine already has a configuration; nothing to do"
    exit 0
  }
  n=$((n + 1))
  [ $((n % 12)) -ne 1 ] || log "waiting for the maintenance API: $(echo "$out" | tail -n 1)"
  [ "$n" -lt 240 ] || {
    log "maintenance API did not answer"
    exit 1
  }
  sleep 5
done
log "blank machine in maintenance mode: configuring it"

# ---- 2. address
# From DHCP, or set by hand on this console (Talos keeps that across the
# install by itself).
ip=""
n=0
while :; do
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
  [ -z "$ip" ] || break
  [ $((n % 30)) -ne 0 ] || log "no IPv4 address yet. No DHCP here? Press F3 on this console, set a static address, Save."
  n=$((n + 1))
  sleep 2
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
: >"$W/disks"
for d in /sys/block/*; do
  name="${d##*/}"
  case "$name" in loop* | ram* | zram* | sr* | dm-* | md* | nbd* | fd*) continue ;; esac
  [ "$(cat "$d/removable" 2>/dev/null || echo 1)" = 0 ] || continue
  [ "$(cat "$d/ro" 2>/dev/null || echo 1)" = 0 ] || continue
  sectors="$(cat "$d/size")" # 512-byte sectors
  [ "$sectors" -ge 33554432 ] || continue
  u=0
  ! used "$name" || u=1
  model="$(cat "$d/device/model" 2>/dev/null | tr -s ' ' | sed 's/^ //; s/ $//' || true)"
  echo "/dev/$name $((sectors / 2097152)) $u $model" >>"$W/disks"
done
count="$(grep -c . "$W/disks" || true)"
[ "$count" -ge 1 ] || {
  log "no disk of 16GB or more found"
  sleep 30
  exit 1
}
is_used() {
  while read -r dev _ u _; do [ "$dev" != "$1" ] || {
    [ "$u" = 1 ]
    return
  }; done <"$W/disks"
  return 1
}
listed() {
  while read -r dev _; do [ "$dev" != "$1" ] || return 0; done <"$W/disks"
  return 1
}

sysdisk="$(arg idea.disk)"
datadisk=""
host="$(arg idea.host)"
# What to do with this machine: a new idea machine, or an extra node of an
# existing one (join). Kernel arguments idea.join=<address[:port]>,
# idea.join-code=<code> and idea.join-fp=<certificate fingerprint> (all
# three are required)
# make the choice without a person; otherwise the install page asks.
role=new
joinaddr="$(arg idea.join)"
joincode="$(arg idea.join-code)"
joinfp="$(arg idea.join-fp)"
[ -z "$joinaddr" ] || role="join"
if [ -n "$sysdisk" ]; then
  # Chosen on the kernel command line: no questions.
  listed "$sysdisk" || {
    log "idea.disk=$sysdisk is not a usable disk"
    sleep 30
    exit 1
  }
elif [ "$role" = join ] && [ "$count" = 1 ] && ! is_used "$(sed -n 's/ .*//p;q' "$W/disks")"; then
  sysdisk="$(sed -n 's/ .*//p;q' "$W/disks")"
else
  # A person decides, on the install page. When there is nothing to choose
  # (one empty disk) the page only waits for a minute: nobody opening it
  # means a new machine, installed unattended.
  auto=0
  if [ "$role" = new ] && [ "$count" = 1 ] && ! is_used "$(sed -n 's/ .*//p;q' "$W/disks")"; then auto=1; fi
  rm -f "$W/choice" "$W/visited"
  httpd -f -p 8080 -h /www &
  hp=$!
  n=0
  while [ ! -s "$W/choice" ]; do
    if [ "$auto" = 1 ] && [ ! -e "$W/visited" ] && [ "$n" -ge 30 ]; then
      break
    fi
    if [ $((n % 60)) -eq 0 ]; then
      log "=============================================================="
      log "this machine has $count disk(s)"
      log "install page   http://$ip:8080/"
      if [ "$auto" = 1 ]; then
        log "open it within a minute to join an existing idea machine;"
        log "otherwise this becomes a new idea machine on the only disk"
      else
        log "choose where to install, or join an existing idea machine"
      fi
      log "=============================================================="
    fi
    n=$((n + 1))
    sleep 2
  done
  if [ -s "$W/choice" ]; then
    sleep 2 # let the page answer the browser
    sysdisk="$(sed -n 1p "$W/choice")"
    datadisk="$(sed -n 2p "$W/choice")"
    host="$(sed -n 3p "$W/choice")"
    role="$(sed -n 4p "$W/choice")"
    joinaddr="$(sed -n 5p "$W/choice")"
    joincode="$(sed -n 6p "$W/choice")"
    joinfp="$(sed -n 7p "$W/choice")"
    listed "$sysdisk" || {
      log "invalid choice"
      exit 1
    }
  else
    sysdisk="$(sed -n 's/ .*//p;q' "$W/disks")"
  fi
  kill "$hp" 2>/dev/null || true
fi
# A data disk that is not empty has to be wiped before Talos will use it.
if [ -n "$datadisk" ] && is_used "$datadisk"; then
  log "wiping data disk $datadisk"
  $T wipe disk "${datadisk#/dev/}" --insecure -n 127.0.0.1 \
    || {
      log "could not wipe $datadisk"
      sleep 30
      exit 1
    }
fi
# The name this machine answers to (install page or kernel arg idea.host).
case "$host" in
  *[!a-z0-9.-]* | .* | *. | *..*)
    log "ignoring invalid name '$host'"
    host=""
    ;;
esac
host="${host:-idea.internal}"
log "address $ip, system disk $sysdisk, data disk ${datadisk:-none (system disk)}, name $host"

# ---- 4. join: the worker configuration of an existing machine
# The existing machine hands it out for a join code (controller/join.go). It
# carries what a Talos worker needs to join and no admin access.
if [ "$role" = join ]; then
  case "$joinaddr" in
    *[!A-Za-z0-9.:-]* | "")
      log "invalid address '$joinaddr'"
      sleep 30
      exit 1
      ;;
  esac
  [ -n "$joinfp" ] || {
    log "joining needs the certificate fingerprint of the existing machine (idea.join-fp, shown in the idea panel next to the join code)"
    sleep 60
    exit 1
  }
  case "$joinaddr" in *:*) ;; *) joinaddr="$joinaddr:30443" ;; esac
  log "joining the idea machine at $joinaddr as an extra node"
  n=0
  until /bin/idea-join "$joinaddr" "$joincode" "$joinfp" >"$W/worker.yaml" 2>"$W/join.err"; do
    n=$((n + 1))
    log "could not get the worker configuration: $(tail -n 1 "$W/join.err")"
    # A refused code will not become valid by waiting; the console shows why.
    [ "$n" -lt 3 ] || {
      log "check the address, the join code (30 minutes, single use) and the network, then restart this machine"
      sleep 60
      exit 1
    }
    sleep 5
  done
  {
    echo 'machine:'
    echo '  install:'
    echo "    disk: $sysdisk"
  } >"$W/install-patch.yaml"
  $T machineconfig patch "$W/worker.yaml" --patch "@$W/install-patch.yaml" -o "$W/worker-patched.yaml"
  mv "$W/worker-patched.yaml" "$W/worker.yaml"
  if [ -n "$datadisk" ]; then
    {
      echo '---'
      echo 'apiVersion: v1alpha1'
      echo 'kind: UserVolumeConfig'
      echo 'name: local-path-provisioner'
      echo 'provisioning:'
      echo '  diskSelector:'
      echo "    match: disk.dev_path == \"$datadisk\""
      echo '  minSize: 20GB'
    } >>"$W/worker.yaml"
  else
    {
      echo '---'
      echo 'apiVersion: v1alpha1'
      echo 'kind: UserVolumeConfig'
      echo 'name: local-path-provisioner'
      echo 'volumeType: directory'
    } >>"$W/worker.yaml"
  fi
  {
    echo '---'
    echo 'apiVersion: v1alpha1'
    echo 'kind: ExtensionServiceConfig'
    echo 'name: idea-bootstrap'
    echo 'configFiles:'
    echo "  - content: $joinaddr"
    echo '    mountPath: /etc/idea/worker'
    echo '---'
    echo 'apiVersion: v1alpha1'
    echo 'kind: ExtensionServiceConfig'
    echo 'name: idea-setup-embedded'
    echo 'environment:'
    echo '  - IDEA_CONFIGURED=1'
  } >>"$W/worker.yaml"
  $T validate --config "$W/worker.yaml" --mode metal >/dev/null
  log "applying the configuration; Talos installs to $sysdisk, restarts and joins the cluster"
  $T apply-config --insecure -n 127.0.0.1 --file "$W/worker.yaml"
  rm -f "$W"/*
  log "done"
  exit 0
fi

# ---- 4. secrets
if [ "$MODE" = embedded ]; then
  [ -s /etc/idea/secrets.yaml ] || {
    log "embedded secrets are not mounted"
    sleep 5
    exit 1
  }
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
} >"$W/volume.yaml"

# Name servers the machine already has from DHCP or the console (F3) win
# over the fallback list a development ISO carries. Talos uses 1.1.1.1 and
# 8.8.8.8 when nobody gave it any.
own_dns() {
  $T get resolvers --insecure -n 127.0.0.1 -o yaml 2>/dev/null \
    | sed -n 's/^ *- *\([0-9.]*[0-9]\)$/\1/p; s/^ *- *\([0-9a-fA-F]*:[0-9a-fA-F:]*\)$/\1/p' \
    | grep -v -x -e 1.1.1.1 -e 8.8.8.8 | grep -q .
}
patches=""
workerpatches=""
for f in /etc/idea/patches/*.yaml; do
  case "$f" in
    *-fallback-resolvers.yaml)
      if own_dns; then
        log "keeping the name servers this machine already has"
        continue
      fi
      ;;
  esac
  patches="$patches --config-patch-control-plane @$f"
  # What a joining node needs of the same patches: not the bootstrap manifests.
  case "$f" in *-bootstrap.yaml) ;; *) workerpatches="$workerpatches --config-patch-worker @$f" ;; esac
done
# shellcheck disable=SC2086
$T gen config "$CLUSTER_NAME" "https://$ip:6443" \
  --with-secrets "$W/secrets.yaml" \
  --kubernetes-version "$KUBERNETES_VERSION" \
  --install-disk "$sysdisk" \
  --install-image "$INSTALLER_IMAGE" \
  $patches $workerpatches \
  --config-patch-control-plane "@$W/volume.yaml" \
  --with-docs=false --with-examples=false \
  --output-types controlplane,worker,talosconfig \
  --output "$W" --force >/dev/null

# Setup code: shown on this machine's console and asked for by the setup page
# (controller/setup.go). Whoever can read the console owns the machine.
code="$(tr -dc 'abcdefghjkmnpqrstuvwxyz23456789' </dev/urandom | head -c 12)"
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
  echo '    workerconfig: |'
  sed 's/^/      /' "$W/worker.yaml"
  echo '---'
  echo 'apiVersion: v1alpha1'
  echo 'kind: KubeInlineManifestConfig'
  echo 'name: idea-settings'
  echo 'manifest: |'
  echo '  # Installation settings, substituted into the manifests by Flux.'
  echo '  apiVersion: v1'
  echo '  kind: ConfigMap'
  echo '  metadata:'
  echo '    name: idea-settings'
  echo '    namespace: flux-system'
  echo '  data:'
  echo "    IDEA_HOST: $host"
  echo '---'
  echo 'apiVersion: v1alpha1'
  echo 'kind: ExtensionServiceConfig'
  echo 'name: idea-setup-embedded'
  echo 'environment:'
  echo '  - IDEA_CONFIGURED=1'
} >>"$W/controlplane.yaml"

$T validate --config "$W/controlplane.yaml" --mode metal >/dev/null
log "applying the configuration; Talos installs to $sysdisk and reboots"
$T apply-config --insecure -n 127.0.0.1 --file "$W/controlplane.yaml"
rm -f "$W"/*
log "done"
