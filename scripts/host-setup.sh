#!/usr/bin/env bash
# Prepare the host: packages, pinned CLI tools, the libvirt default network,
# and a local OCI registry bound to the libvirt gateway only.
# Idempotent. Touches nothing that is not named idea-* except:
#   - apt packages
#   - the dedicated libvirt NAT network idea-net (PLAN.md 2.5)
#   - /etc/containers/* for podman (only when not already configured)

. "$(dirname "$0")/lib.sh"

[ "$(id -u)" -eq 0 ] || die "run as root"

DL="$IDEA_DATA_DIR/dl"
BIN=/usr/local/bin
mkdir -p "$IDEA_DATA_DIR"/{vm,iso,registry,build,notes,dl}

# ---------------------------------------------------------------- packages
pkgs=()
for p in qemu-system-x86 libvirt-daemon-system virtinst podman; do
  dpkg -s "$p" >/dev/null 2>&1 || pkgs+=("$p")
done
if [ "${#pkgs[@]}" -gt 0 ]; then
  log "apt install: ${pkgs[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${pkgs[@]}"
fi
need jq yq curl git virsh virt-install podman

# podman keeps images under the data dir, never under /var/lib.
if [ ! -e /etc/containers/storage.conf ]; then
  log "podman storage -> $IDEA_DATA_DIR/build"
  cat > /etc/containers/storage.conf <<EOF
[storage]
driver = "overlay"
graphroot = "$IDEA_DATA_DIR/build"
runroot = "/run/containers/storage"
EOF
fi
mkdir -p /etc/containers/registries.conf.d
cat > /etc/containers/registries.conf.d/idea.conf <<EOF
[[registry]]
location = "$REGISTRY_ADDR"
insecure = true
EOF

# ------------------------------------------------------------ pinned tools
# fetch <name> <version> <url> <checksum-url> : download once, verify sha256.
fetch() {
  local name=$1 ver=$2 url=$3 sumurl=$4 dir file want got
  dir="$DL/$name-$ver"; file="$dir/${url##*/}"
  mkdir -p "$dir"
  if [ ! -s "$file" ]; then
    log "download $name $ver"
    curl -fsSL --retry 3 -o "$file.part" "$url"
    mv "$file.part" "$file"
  fi
  want="$(curl -fsSL --retry 3 "$sumurl" | awk -v f="${url##*/}" '
    { n=$2; sub(/^\*/,"",n); sub(/.*\//,"",n) }
    NF==1 || n==f { print $1; exit }')"
  got="$(sha256sum "$file" | awk '{print $1}')"
  [ -n "$want" ] || die "$name: no checksum found at $sumurl"
  [ "$want" = "$got" ] || die "$name: checksum mismatch"
  echo "$file"
}

installed() { [ "$(cat "$DL/.installed-$1" 2>/dev/null)" = "$2" ] && [ -x "$3" ]; }
mark()      { echo "$2" > "$DL/.installed-$1"; }

# install_tar <name> <version> <url> <checksum-url> <member-in-tar> [target]
install_tar() {
  local name=$1 ver=$2 url=$3 sumurl=$4 member=$5 target=${6:-$BIN/$1} f tmp
  installed "$name" "$ver" "$target" && return 0
  f="$(fetch "$name" "$ver" "$url" "$sumurl")"
  tmp="$(mktemp -d "$DL/x.XXXXXX")"
  tar -xzf "$f" -C "$tmp" "$member"
  install -m 0755 "$tmp/$member" "$target"
  rm -rf "$tmp"
  mark "$name" "$ver"
  log "installed $name $ver"
}

# install_bin <name> <version> <url> <checksum-url>
install_bin() {
  local name=$1 ver=$2 url=$3 sumurl=$4 f
  installed "$name" "$ver" "$BIN/$name" && return 0
  f="$(fetch "$name" "$ver" "$url" "$sumurl")"
  install -m 0755 "$f" "$BIN/$name"
  mark "$name" "$ver"
  log "installed $name $ver"
}

gh=https://github.com
install_bin talosctl "$TALOS_VERSION" \
  "$gh/siderolabs/talos/releases/download/$TALOS_VERSION/talosctl-linux-amd64" \
  "$gh/siderolabs/talos/releases/download/$TALOS_VERSION/sha256sum.txt"

if [ -n "${KUBERNETES_VERSION:-}" ]; then
  install_bin kubectl "$KUBERNETES_VERSION" \
    "https://dl.k8s.io/release/$KUBERNETES_VERSION/bin/linux/amd64/kubectl" \
    "https://dl.k8s.io/release/$KUBERNETES_VERSION/bin/linux/amd64/kubectl.sha256"
else
  log "KUBERNETES_VERSION is empty in versions.env: skipping kubectl"
fi

install_tar helm "$HELM_VERSION" \
  "https://get.helm.sh/helm-$HELM_VERSION-linux-amd64.tar.gz" \
  "https://get.helm.sh/helm-$HELM_VERSION-linux-amd64.tar.gz.sha256sum" \
  linux-amd64/helm

install_tar flux "$FLUX_VERSION" \
  "$gh/fluxcd/flux2/releases/download/$FLUX_VERSION/flux_${FLUX_VERSION#v}_linux_amd64.tar.gz" \
  "$gh/fluxcd/flux2/releases/download/$FLUX_VERSION/flux_${FLUX_VERSION#v}_checksums.txt" \
  flux

install_tar cilium "$CILIUM_CLI_VERSION" \
  "$gh/cilium/cilium-cli/releases/download/$CILIUM_CLI_VERSION/cilium-linux-amd64.tar.gz" \
  "$gh/cilium/cilium-cli/releases/download/$CILIUM_CLI_VERSION/cilium-linux-amd64.tar.gz.sha256sum" \
  cilium

install_tar gitleaks "$GITLEAKS_VERSION" \
  "$gh/gitleaks/gitleaks/releases/download/$GITLEAKS_VERSION/gitleaks_${GITLEAKS_VERSION#v}_linux_x64.tar.gz" \
  "$gh/gitleaks/gitleaks/releases/download/$GITLEAKS_VERSION/gitleaks_${GITLEAKS_VERSION#v}_checksums.txt" \
  gitleaks

install_tar idea-registry "$REGISTRY_VERSION" \
  "$gh/distribution/distribution/releases/download/$REGISTRY_VERSION/registry_${REGISTRY_VERSION#v}_linux_amd64.tar.gz" \
  "$gh/distribution/distribution/releases/download/$REGISTRY_VERSION/registry_${REGISTRY_VERSION#v}_linux_amd64.tar.gz.sha256" \
  registry "$BIN/idea-registry"

# ---------------------------------------------------------- libvirt network
# A dedicated NAT network. DNS is off in its dnsmasq (DHCP only) so it never
# competes for port 53 with a DNS server already running on the host.
# The existing "default" network is left exactly as it is.
require_idea_name "$LIBVIRT_NETWORK"
require_idea_name "$LIBVIRT_BRIDGE"
if ! net_exists "$LIBVIRT_NETWORK"; then
  if [ -n "$(ip -4 route | grep "^${NETWORK_CIDR%.*}\." || true)" ]; then
    die "$NETWORK_CIDR overlaps an existing route on this host"
  fi
  log "defining libvirt network $LIBVIRT_NETWORK ($NETWORK_CIDR)"
  netxml="$(mktemp)"
  cat > "$netxml" <<NETXML
<network>
  <name>$LIBVIRT_NETWORK</name>
  <forward mode='nat'/>
  <bridge name='$LIBVIRT_BRIDGE' stp='on' delay='0'/>
  <dns enable='no'/>
  <ip address='$GATEWAY_IP' netmask='255.255.255.0'>
    <dhcp>
      <range start='$DHCP_RANGE_START' end='$DHCP_RANGE_END'/>
      <host mac='$VM_MAC' name='$VM_NAME' ip='$NODE_IP'/>
    </dhcp>
  </ip>
</network>
NETXML
  virsh net-define "$netxml" >/dev/null
  rm -f "$netxml"
fi
if ! net_active "$LIBVIRT_NETWORK"; then
  log "starting libvirt network $LIBVIRT_NETWORK"
  virsh net-start "$LIBVIRT_NETWORK" >/dev/null
fi
net_autostart "$LIBVIRT_NETWORK" || virsh net-autostart "$LIBVIRT_NETWORK" >/dev/null

gw="$(virsh net-dumpxml "$LIBVIRT_NETWORK" | sed -n "s/.*<ip address='\([0-9.]*\)'.*/\1/p" | head -1)"
[ "$gw" = "$GATEWAY_IP" ] || die "libvirt gateway is $gw but config.env says $GATEWAY_IP"
bridge="$LIBVIRT_BRIDGE"

# ----------------------------------------------------------- local registry
# Plain HTTP, listening on the libvirt gateway address only (never 0.0.0.0).
case "$REGISTRY_ADDR" in
  "$GATEWAY_IP":*) ;;
  *) die "REGISTRY_ADDR must be on the libvirt gateway ($GATEWAY_IP)" ;;
esac

mkdir -p /etc/idea
cat > /etc/idea/registry.yml <<EOF
version: 0.1
log:
  level: info
storage:
  filesystem:
    rootdirectory: $IDEA_DATA_DIR/registry
  delete:
    enabled: true
http:
  addr: $REGISTRY_ADDR
EOF

cat > /etc/systemd/system/idea-registry.service <<EOF
[Unit]
Description=idea local OCI registry (libvirt bridge only)
After=libvirtd.service network-online.target
Wants=libvirtd.service

[Service]
ExecStartPre=/bin/sh -c 'until ip -4 -o addr show dev $bridge 2>/dev/null | grep -q " $GATEWAY_IP/"; do sleep 1; done'
ExecStart=$BIN/idea-registry serve /etc/idea/registry.yml
TimeoutStartSec=180
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$IDEA_DATA_DIR/registry

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable idea-registry.service >/dev/null 2>&1
systemctl restart idea-registry.service

for _ in $(seq 1 20); do
  curl -fsS -m 2 "http://$REGISTRY_ADDR/v2/" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS -m 2 "http://$REGISTRY_ADDR/v2/" >/dev/null || die "registry did not come up on $REGISTRY_ADDR"
log "registry up on http://$REGISTRY_ADDR"
log "host setup done"
