# Stage 0. Host check and tools

Date: 2026-11-12
Result: **pass**

## Verification

| Item | Result |
| --- | --- |
| Nested virtualization | On (`kvm_intel nested=Y`, `vmx`) |
| Staging a fake key rejects the commit | Rejected (see "Secret check trial" below) |
| Registry listens only on the `idea-net` gateway | Only `192.168.123.1:5000` answers. No connection on loopback or other host addresses |
| Commit email is noreply | A commit with another email is rejected |
| Commit with a `private-strings` string rejected | Rejected |
| Registry and build storage under `/DATA/idea` | podman graphroot `/DATA/idea/build`, registry `/DATA/idea/registry` |

## Host

- Ubuntu 24.04, kernel 6.8, 48 threads, 31GB RAM
- Available memory (`free` available column): 25GB before starting, 24GB at the end of the stage
- `/DATA` free space 567GB

The host inventory (existing VMs, networks, and so on) is outside the repository in `/DATA/idea/notes/host-inventory.md`.

## What was actually done

```
scripts/host-setup.sh     # packages, pinned tools, idea-net, local registry
scripts/check-secrets.sh  # secret check (full)
```

What `host-setup.sh` does:

1. Installs podman with apt (qemu, libvirt and virt-install were already there).
2. Points podman storage at `/DATA/idea/build` (`/etc/containers/storage.conf`, a new file).
3. Downloads the tools at the versions in `versions.env`, verifies sha256, and installs them in `/usr/local/bin`.
4. Defines, starts and autostarts the libvirt network `idea-net`.
5. Runs the registry as the systemd service `idea-registry`, bound to `192.168.123.1:5000` only.

## Versions

| Tool | Version |
| --- | --- |
| talosctl | v1.14.6 |
| kubectl | v1.37.1 (the default Kubernetes version of talosctl v1.14.6) |
| helm | v4.3.1 |
| flux | v2.10.0 |
| cilium CLI | v0.20.2 |
| gitleaks | v8.30.1 |
| registry (distribution) | v3.1.2 |
| podman | 4.9.3 (Ubuntu package) |
| libvirt | 10.0.0 (already installed) |

## Problems and fixes

### The libvirt `default` network does not start

- Symptom: `virsh net-start default` fails with `dnsmasq: failed to create listening socket for 192.168.122.1: Address already in use`.
- Cause: a DNS server already running on the host grabs port 53 on every new interface automatically. It gets there before libvirt's dnsmasq, which then dies.
- Fix (decided by the owner): created a dedicated NAT network `idea-net` with its dnsmasq DNS turned off (`<dns enable='no'/>`, DHCP only). `default` and the host DNS server were left alone.
- Effect: this network gives no DNS to guests. In stage 1 the nameservers are written into the Talos machine config directly.

### Container engine

- The host has Docker, but its storage is on the root filesystem. Changing the Docker configuration would affect existing containers, so it was left alone; podman was installed separately and pointed at `/DATA/idea/build`.
- The registry runs as a distribution binary directly under systemd, not as a container, so that no container network rules get added to the host firewall.

## Secret check trial

Tested with a temporary secrets directory (`/dev/shm`); all test files were deleted afterwards.

| Staged | Result |
| --- | --- |
| Fake key in token format | Rejected by gitleaks |
| A value from the secrets directory `env` (a plain sentence gitleaks cannot catch) | Rejected by the value comparison check. Only the key name and file:line are printed |
| A string from `private-strings` | Rejected |
| `kind: Secret` under `deploy/` | Rejected |
| Commit with a non-noreply email | Rejected |
| `IDEA_SECRETS_DIR` pointing inside the repository | The script refuses to run |

## Points for the design

- **If the host already runs a DNS server, the libvirt default network does not come up.** The install docs should make "create a dedicated network with DNS off" the default path.
- **Do not assume the host's existing container engine.** podman with its own storage location plus a binary registry did not conflict with the existing environment.
- When pinning versions, match kubectl to the Kubernetes default that Talos sets (`talosctl gen config --help`). The latest stable Kubernetes (v1.37.2) and the Talos default (1.37.1) can differ.
- The plain-HTTP option of `flux push artifact` is `--insecure-registry` (v2.10.0).
