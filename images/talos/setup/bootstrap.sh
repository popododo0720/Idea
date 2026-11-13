#!/bin/sh
# idea-bootstrap: bootstrap etcd on the installed single node (first boot
# only), then keep the way in on the console: the setup page address and the
# setup code.
set -eu

log() { echo "idea: $*"; }
t() { /bin/talosctl --talosconfig /etc/idea/talosconfig -e 127.0.0.1 -n 127.0.0.1 "$@"; }

[ -s /etc/idea/talosconfig ] || { log "talosconfig not mounted yet"; sleep 5; exit 1; }

n=0
while :; do
  # On later boots etcd comes up by itself.
  # (The STATE line, not the event text: "Running pre state" is not running.)
  state="$(t service etcd 2>/dev/null | sed -n 's/^STATE  *//p' || true)"
  if [ "$state" = Running ]; then log "etcd is running"; break; fi
  if out="$(t bootstrap 2>&1)"; then log "etcd bootstrapped"; break; fi
  case "$out" in
    *AlreadyExists*) log "etcd was bootstrapped before"; break ;;
  esac
  n=$((n + 1))
  [ $((n % 6)) -ne 1 ] || log "not ready yet: $(echo "$out" | tail -n 1)"
  sleep 5
done

# Repeated so that it is on the screen whenever somebody looks.
while :; do
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
  log "=============================================================="
  log "setup page   https://${ip:-<this machine>}:30443/"
  log "setup code   $(cat /etc/idea/setup-code 2>/dev/null || echo '(not available)')"
  log "=============================================================="
  sleep 600
done
