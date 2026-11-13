# Stage 1. Talos VM

Date: 2026-11-12
Result: **pass**

## Verification

| Item | Result |
| --- | --- |
| kata-containers in `talosctl get extensions` | Present (`kata-containers`, `schematic`) |
| `/dev/kvm` inside the node | Present (`/dev/kvm`, `/dev/vhost-net`, `/dev/vhost-vsock`) |
| Node in `kubectl get nodes` | `idea-talos-1`, NotReady (no CNI, expected) |

Additional checks:

- Installed to disk (system disk `vda`), machine stage `running`.
- The hostname came from the DHCP reservation (`idea-talos-1`).
- Nameservers 1.1.1.1 and 8.8.8.8 applied.
- The local registry mirror is in the containerd configuration (`http://192.168.123.1:5000`).
- No control-plane taint (only `not-ready` remains).

## What was actually done

```
scripts/vm-create.sh     # look up the schematic ID, download the ISO, create the VM
scripts/talos-apply.sh   # generate secrets and machine config (in the secrets directory), apply, bootstrap, kubeconfig
scripts/vm-destroy.sh    # delete the VM and disk (secrets are kept; --wipe-secrets deletes them too)
```

- VM: 16GB, 24 vCPUs (half the host threads), 100GB qcow2 (`/DATA/idea/vm`), `--cpu host-passthrough`, network `idea-net`, fixed MAC.
- The ISO and the installer image both come from Image Factory with the same schematic ID.
- The machine config, `talosconfig` and `kubeconfig` exist only in `~/.idea-secrets`. The rendered host patch (`_out/talos/host.yaml`) contains no secrets and is not committed.

## Versions

| Component | Version |
| --- | --- |
| Talos | v1.14.6 (kernel 6.18.63, containerd 2.3.7) |
| Kubernetes | v1.37.1 |
| kata-containers extension | 4.3.1 |
| Schematic ID | `3da7f440f279…` (`versions.env`) |

## Measured memory

| Target | Value |
| --- | --- |
| Talos + Kubernetes control plane (before CNI) | about 0.86GB / 16GB used inside the node |
| Host available memory | 22GB (24GB before creating the VM) |

## Problems and fixes

### The Talos v1.14 machine config format differs from the plan's example

- The plan's patch (`cluster.network.cni.name: none`, `cluster.proxy.disabled`, `allowSchedulingOnControlPlanes`, `machine.install`) is the format up to v1.13. v1.14 splits the config into documents by kind.
- Changes:
  - No CNI → `$patch: delete` on `KubeFlannelCNIConfig`
  - kube-proxy off → `enabled: false` in `KubeProxyConfig`
  - Workloads on the control plane → `$patch: delete` on the taint in `KubeNodeConfig`
  - Install disk and image → `talosctl gen config --install-disk --install-image` (results in `UnattendedInstallConfig`)
  - Nameservers → `ResolverConfig`, registry → `RegistryMirrorConfig`
- The stage 1 example in the plan was updated to this format.

### The taint-delete patch must be given to the control plane only

- `--config-patch` also applies to the worker config, where there is no taint to delete, so generation fails with `lookup failed`.
- Switched to `--config-patch-control-plane`.

### The `pipefail` trap in scripts

- With `virsh ... | grep -q ...`, when grep exits first the preceding command dies with SIGPIPE, which under `pipefail` turns "found" into a failure.
- The same pattern was in `check-secrets.sh`. Left as it was, it **could have missed** a secret in a large change. Replaced with `grep -c >/dev/null` and variable capture.

## Points for the design

- **A Talos minor version change changes the machine config format.** Keep patches per version and run `talosctl validate` right after generation (added to the script).
- If the hostname comes from the DHCP reservation, it does not need to be in the Talos config.
- Applying the config continues straight into install and startup without a reboot ("Applied configuration without a reboot"). From apply to a responding Kubernetes API took under 2 minutes (on HDD).
- Keeping the Talos secrets separate from VM recreation (`vm-destroy.sh` leaves them) preserves `talosconfig` and the cluster CA across rebuilds.
