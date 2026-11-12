#!/usr/bin/env bash
# Create the Talos VM (idea-talos-1) on idea-net, booting the Talos ISO built
# for our schematic. Creates only resources named idea-*.

. "$(dirname "$0")/lib.sh"
need virsh virt-install curl jq

require_idea_name "$VM_NAME"
[ -n "${TALOS_SCHEMATIC_ID:-}" ] || die "TALOS_SCHEMATIC_ID is empty in versions.env"

if virsh dominfo "$VM_NAME" >/dev/null 2>&1; then
  die "$VM_NAME already exists (run scripts/vm-destroy.sh first)"
fi
net_active "$LIBVIRT_NETWORK" \
  || die "libvirt network $LIBVIRT_NETWORK is not active (run scripts/host-setup.sh)"

# Stop conditions from PLAN.md: nested virtualization and available memory.
nested="$(cat /sys/module/kvm_intel/parameters/nested 2>/dev/null || cat /sys/module/kvm_amd/parameters/nested 2>/dev/null || echo N)"
case "$nested" in Y|1) ;; *) die "nested virtualization is off: stop and ask" ;; esac
avail_gb="$(awk '/^MemAvailable:/ {printf "%d", $2/1024/1024}' /proc/meminfo)"
[ "$avail_gb" -ge 18 ] || die "only ${avail_gb}GB memory available (need 18GB): stop and ask"

# The pinned schematic ID must be what the schematic file produces.
got="$(curl -fsS --retry 3 -X POST --data-binary @"$REPO_ROOT/images/talos/schematic.yaml" \
  https://factory.talos.dev/schematics | jq -r .id)"
[ "$got" = "$TALOS_SCHEMATIC_ID" ] \
  || die "schematic.yaml gives ID $got but versions.env pins $TALOS_SCHEMATIC_ID"

iso="$IDEA_DATA_DIR/iso/talos-$TALOS_VERSION-${TALOS_SCHEMATIC_ID:0:12}-metal-amd64.iso"
if [ ! -s "$iso" ]; then
  log "downloading Talos $TALOS_VERSION ISO"
  curl -fL --retry 3 -o "$iso.part" \
    "https://factory.talos.dev/image/$TALOS_SCHEMATIC_ID/$TALOS_VERSION/metal-amd64.iso"
  mv "$iso.part" "$iso"
fi

vcpus="${VM_VCPUS:-$(( $(nproc) / 2 ))}"
[ "$vcpus" -ge 4 ] || vcpus=4
disk="$IDEA_DATA_DIR/vm/$VM_NAME.qcow2"
[ ! -e "$disk" ] || die "$disk already exists (run scripts/vm-destroy.sh first)"

log "creating $VM_NAME: ${VM_MEMORY_MB}MB, $vcpus vCPU, ${VM_DISK_GB}GB disk"
virt-install \
  --virt-type kvm \
  --name "$VM_NAME" \
  --memory "$VM_MEMORY_MB" \
  --vcpus "$vcpus" \
  --cpu host-passthrough \
  --disk "path=$disk,size=$VM_DISK_GB,bus=virtio,format=qcow2,discard=unmap" \
  --cdrom "$iso" \
  --boot hd,cdrom \
  --os-variant generic \
  --network "network=$LIBVIRT_NETWORK,model=virtio,mac=$VM_MAC" \
  --graphics none \
  --console pty,target_type=serial \
  --noautoconsole

log "$VM_NAME started; it should get $NODE_IP from DHCP"
