#!/usr/bin/env bash
# Development: boot a blank VM from an ISO built by build-iso.sh and watch it
# install itself. Nothing is sent to the VM; the serial console is logged.
# The disks use cache=unsafe: this VM is thrown away, and on a slow host disk
# etcd otherwise misses its deadlines while images are being pulled.
# ISO_TEST_DISKS=1 gives it a single disk; ISO_TEST_MEMORY_MB sets its memory;
# ISO_TEST_UEFI=1 boots it with UEFI firmware. The screen is a local VNC
# display (for `virsh screenshot`).
#
#   iso-test.sh create <iso>    create idea-iso-1 (blank disks) and boot the ISO
#   iso-test.sh destroy         remove it
#   iso-test.sh ip              print the address it got from DHCP

. "$(dirname "$0")/lib.sh"
need virsh virt-install

NAME=idea-iso-1
MAC=52:54:00:1d:ea:21
require_idea_name "$NAME"
D="$IDEA_DATA_DIR/vm"
LOGF="$IDEA_DATA_DIR/logs/$NAME-console.log"

destroy() {
  if virsh dominfo "$NAME" >/dev/null 2>&1; then
    [ "$(virsh domstate "$NAME" 2>/dev/null)" != running ] || virsh destroy "$NAME" >/dev/null
    virsh undefine "$NAME" --remove-all-storage --nvram >/dev/null 2>&1 \
      || virsh undefine "$NAME" --remove-all-storage >/dev/null
  fi
  rm -f -- "$D/$NAME.qcow2" "$D/$NAME-data.qcow2"
}

case "${1:-}" in
  create)
    iso="${2:?usage: iso-test.sh create <iso>}"
    [ -s "$iso" ] || die "no such ISO: $iso"
    destroy
    mkdir -p "$(dirname "$LOGF")"; : > "$LOGF"
    boot=hd,cdrom
    [ "${ISO_TEST_UEFI:-0}" = 0 ] || boot=uefi,hd,cdrom
    data=()
    [ "${ISO_TEST_DISKS:-2}" = 1 ] || data=(--disk "path=$D/$NAME-data.qcow2,size=24,bus=virtio,format=qcow2,discard=unmap,cache=unsafe")
    virt-install \
      --virt-type kvm --name "$NAME" \
      --memory "${ISO_TEST_MEMORY_MB:-16384}" --vcpus "${ISO_TEST_VCPUS:-8}" --cpu host-passthrough \
      --disk "path=$D/$NAME.qcow2,size=${ISO_TEST_DISK_GB:-60},bus=virtio,format=qcow2,discard=unmap,cache=unsafe" \
      "${data[@]}" \
      --cdrom "$iso" --boot "$boot" --os-variant generic \
      --network "network=$LIBVIRT_NETWORK,model=virtio,mac=$MAC" \
      --graphics vnc,listen=127.0.0.1 --video virtio \
      --serial "file,path=$LOGF" --noautoconsole >/dev/null
    log "$NAME started; console log: $LOGF"
    ;;
  destroy) destroy; log "$NAME removed" ;;
  ip)
    o="$(virsh net-dhcp-leases "$LIBVIRT_NETWORK" 2>/dev/null)" || exit 1
    awk -v m="$MAC" '$3 == m {sub(/\/.*/, "", $5); print $5}' <<<"$o" | tail -n 1
    ;;
  *) die "usage: $0 create <iso> | destroy | ip" ;;
esac
