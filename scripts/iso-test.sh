#!/usr/bin/env bash
# Development: boot a blank VM from an ISO built by build-iso.sh and watch it
# install itself. Nothing is sent to the VM; the serial console is logged.
# The disks use cache=unsafe: this VM is thrown away, and on a slow host disk
# etcd otherwise misses its deadlines while images are being pulled.
# ISO_TEST_DISKS=1 gives it a single disk; ISO_TEST_MEMORY_MB sets its memory;
# ISO_TEST_UEFI=1 boots it with UEFI firmware. The screen is a local VNC
# display (for `virsh screenshot`). ISO_TEST_NETWORK=idea-static attaches it to
# a network without DHCP (created on demand) to try static addressing.
# ISO_TEST_USED_DISK=1 puts a partition table and a file system on the first
# disk beforehand.
#
#   iso-test.sh create <iso>    create idea-iso-1 (blank disks) and boot the ISO
#   iso-test.sh destroy         remove it
#   iso-test.sh ip              print the address it got from DHCP

. "$(dirname "$0")/lib.sh"
need virsh virt-install

NAME=idea-iso-1
NET="${ISO_TEST_NETWORK:-$LIBVIRT_NETWORK}"
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
    if [ "$NET" = idea-static ] && ! net_exists idea-static; then
      # NAT to the outside, but no DHCP server: 192.168.124.0/24, gateway .1
      x="$(mktemp)"
      cat > "$x" <<NETXML
<network>
  <name>idea-static</name>
  <forward mode='nat'/>
  <bridge name='idea-br1' stp='on' delay='0'/>
  <dns enable='no'/>
  <ip address='192.168.124.1' netmask='255.255.255.0'/>
</network>
NETXML
      virsh net-define "$x" >/dev/null; rm -f "$x"
    fi
    net_active "$NET" || virsh net-start "$NET" >/dev/null
    sysopt="size=${ISO_TEST_DISK_GB:-60},"
    if [ "${ISO_TEST_USED_DISK:-0}" = 1 ]; then
      # A first disk that already holds something: a partition table and a
      # file system, as a machine that was in use would have.
      raw="$(mktemp "$D/$NAME.XXXXXX.raw")"
      truncate -s "${ISO_TEST_DISK_GB:-60}G" "$raw"
      printf 'label: gpt\n,1GiB,L\n' | sfdisk -q "$raw"
      mkfs.ext4 -q -F -E offset=1048576 "$raw" 1000000k
      qemu-img convert -q -f raw -O qcow2 "$raw" "$D/$NAME.qcow2"
      rm -f "$raw"
      sysopt=""
    fi
    boot=hd,cdrom
    [ "${ISO_TEST_UEFI:-0}" = 0 ] || boot=uefi,hd,cdrom
    data=()
    [ "${ISO_TEST_DISKS:-2}" = 1 ] || data=(--disk "path=$D/$NAME-data.qcow2,size=24,bus=virtio,format=qcow2,discard=unmap,cache=unsafe")
    virt-install \
      --virt-type kvm --name "$NAME" \
      --memory "${ISO_TEST_MEMORY_MB:-16384}" --vcpus "${ISO_TEST_VCPUS:-8}" --cpu host-passthrough \
      --disk "path=$D/$NAME.qcow2,${sysopt}bus=virtio,format=qcow2,discard=unmap,cache=unsafe" \
      "${data[@]}" \
      --cdrom "$iso" --boot "$boot" --os-variant generic \
      --network "network=$NET,model=virtio,mac=$MAC" \
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
