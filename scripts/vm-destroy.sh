#!/usr/bin/env bash
# Remove the Talos VM and its disk. Only touches resources named idea-*.
# Talos secrets in $IDEA_SECRETS_DIR are kept so the cluster identity is
# stable across rebuilds; pass --wipe-secrets to remove them as well.

. "$(dirname "$0")/lib.sh"
need virsh

require_idea_name "$VM_NAME"

if virsh dominfo "$VM_NAME" >/dev/null 2>&1; then
  if [ "$(virsh domstate "$VM_NAME" 2>/dev/null)" = running ]; then
    log "stopping $VM_NAME"
    virsh destroy "$VM_NAME" >/dev/null
  fi
  log "removing $VM_NAME and its storage"
  virsh undefine "$VM_NAME" --remove-all-storage --nvram >/dev/null 2>&1 \
    || virsh undefine "$VM_NAME" --remove-all-storage >/dev/null
else
  log "$VM_NAME does not exist"
fi

for disk in "$IDEA_DATA_DIR/vm/$VM_NAME.qcow2" "$IDEA_DATA_DIR/vm/$VM_NAME-data.qcow2"; do
  [ ! -e "$disk" ] || rm -f -- "$disk"
done

if [ "${1:-}" = "--wipe-secrets" ]; then
  log "removing Talos secrets and kubeconfig"
  rm -f -- "$IDEA_SECRETS_DIR"/talos/{secrets.yaml,controlplane.yaml,worker.yaml,talosconfig} \
           "$IDEA_SECRETS_DIR/kubeconfig"
fi
