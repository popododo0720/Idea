# Stage 8: Install ISO

Written 2026-11-13. A stage that was not in the plan. In stages 0–7, host scripts created the VM and fed the configuration with `talosctl` to stand up the cluster. The real goal is different: **boot from an ISO and the machine goes all the way by itself**. That path was built and the host-script path was removed.

## Conclusion

Booting an empty machine from the ISO completes the Talos install, the cluster bootstrap and the full stack configuration without a single command from a human. The only human action is entering the setup page with the setup code shown on the machine screen and providing the model keys.

## How it works

Talos has no "generate your own configuration on first boot" feature. The configuration must contain the cluster certificates, and someone has to call the API once to bootstrap etcd. A Talos system extension was made to do both inside the machine (`images/talos/setup`).

| When | Extension service | What it does |
| --- | --- | --- |
| Boot from ISO (no config, maintenance mode) | `idea-setup` | Finds the address and disks, generates new certificates, generates the machine config and applies it to its own maintenance API. Talos installs to disk and reboots. |
| First boot of the installed system | `idea-bootstrap` | Calls the etcd bootstrap with the admin credentials carried inside the config. |
| Every boot | `idea-bootstrap` | Prints the setup page address and the setup code on the console every 10 minutes. |

Facts confirmed:

- Extension services run in maintenance mode too. The docs do not say so; it was confirmed by running it.
- The maintenance API (`--insecure`) can be called at `127.0.0.1` from inside the machine.
- Applying the config starts the unattended install without a reboot, and Talos reboots by itself when the install finishes.
- The `ExtensionServiceConfig` from the partial config embedded in the ISO (`--embedded-config-path`) is mounted into the service in maintenance mode too. The service must declare `depends: configuration: true` though.

Values in the config that differ per machine:

- **Cluster address**: the address received by DHCP at boot.
- **Install disk**: if there is exactly one fixed disk of 16GB or more and it is empty, it installs there without asking. With several disks, or anything on them, it waits for a human to choose on the install page (`http://<machine address>:8080/`). The kernel argument `idea.disk=/dev/xxx` skips the question.
- **Persistent volume location**: if a separate data disk is chosen on the install page, that disk; otherwise a directory on the system disk (`volumeType: directory`).
- **Address**: from DHCP, or without DHCP, entered in the Talos network settings on the console (F3). It waits until an address exists.
- **Certificates and setup code**: generated on the machine. Not in the ISO.

## How a human gets in after the install

On a machine installed from the public ISO, the admin credentials are created inside the machine, so there is no way to use `kubectl` from outside. So a setup page was added to the controller (`controller/setup.go`).

- The address is `https://<machine address>:30443/` (NodePort, self-signed certificate created at start). The ingress only answers to the hostname, so it cannot serve the first visit where only the address is known.
- It opens only with the setup code printed on the machine console. The model is: whoever can see the console is the owner. A wrong code is refused after a 1 second delay.
- Once open, the model keys can be saved, the Forgejo admin account is shown, and `talosconfig` can be downloaded.
- The setup code and `talosconfig` are read from the Secret (`kube-system/idea-setup`) that the extension planted at install time as an inline manifest in the machine config.

## Changes for the public release

- **Image names**: the manifests point at `ghcr.io/popododo0720/idea-*`. The node on the dev host mirrors `ghcr.io` to the local registry first, so local builds are pulled under the same name.
- **Deployment bundle**: `deploy/clusters/public` follows `oci://ghcr.io/popododo0720/idea-deploy:stable`. `clusters/dev` follows the local registry and adds the development pods (w1, idea-main). The rest is shared as `clusters/base`.
- **Chrome → Chromium**: Google Chrome cannot be redistributed. Worker image 0.6.0 uses Debian's Chromium. dsh browser control was confirmed to work unchanged.
- **Claude Agent SDK**: removed from the image. Only a worker pod that has a Claude token fetches the plugin from npm at start (measured 37 seconds).
- **Ingress certificate**: the IP SAN was removed. HTTPS by IP never worked anyway, and the machine address cannot be known in advance.

## Problems found along the way

- **`.gitignore` was hiding 4 needed manifests.** Files caught by the `worker.yaml`, `secrets.yaml` and `*-secret.yaml` patterns went into the local deployment bundle but not into git, so the GitHub repository pushed on 2026-11-13 did not build as is. They were definition files with no values. They were renamed, and `push-deploy.sh` now stops if a hidden file exists.
- **An extension service that never finishes holds up the boot.** If a service that can never receive its configuration stays `Waiting`, the Talos boot sequence does not complete. On the installed system a marker makes that service exit immediately.
- **Searching service state by string led to a wrong call.** "Running pre state" in the `talosctl service etcd` output was read as running, and the bootstrap was skipped. Only the `STATE` line is read now.
- **Two VMs running together on HDD make etcd time out.** The test VM attaches its disk with `cache=unsafe`. Under these conditions, ISO boot to full configuration takes about 10 minutes.

## Test

`scripts/iso-e2e.sh` tests the way an owner would. It uses neither `talosctl` nor `kubectl`, only what the machine shows and serves.

Run on 2026-11-13. Test VM with 16GB memory, one disk (60GB), UEFI boot. The ISO is the build that generates certificates on the machine (`build-iso.sh --dev`: only images and the deployment bundle come from the local registry).

| Elapsed | What happened |
| --- | --- |
| 11 s after boot | The extension generated and applied the config (console: `generated new cluster secrets on this machine`, system disk `/dev/vda`, no data disk) |
| 20 s after boot | Disk install complete, reboot |
| 7 s after reboot | etcd bootstrap, setup page address and setup code on the console |
| About 4 min 30 s later | Setup page answers (controller is up) |
| +1 s | Wrong setup code refused, model keys entered on the setup page, `talosconfig` download confirmed |
| +6 s | Forgejo login with the account shown on the setup page, issue #1 created |
| +4 min 14 s | PR #2 merged |

From reading the setup code to the merge is 534 seconds. These numbers are with images pulled from the local registry on the same host; pulling from the internet takes longer.

Checked separately on the same day:

- The build with certificates embedded in the ISO (`--embed-secrets`), two disks, BIOS boot: 605 seconds from boot to all 7 Flux bundles ready, issue → merge 183 seconds.
- The setup page address and setup code are visible in the log pane of the Talos dashboard on the machine screen (VGA) (confirmed with `virsh screenshot`).
- In the worker pod switched to Chromium, dsh opened the browser and read back the page title and UA.

Checked after publishing (same day): downloaded `idea-0.1.0-amd64.iso` from the GitHub release v0.1.0 (checksum matches) and ran the same test. This build has no local registry mirror, and the console log shows 0 connections to the local registry. All images came from the internet (ghcr.io and so on).

| Elapsed | What happened |
| --- | --- |
| 147 s | Install and reboot done, setup page address and setup code on the console (installer image pulled from ghcr.io) |
| 508 s | Setup page answers |
| 509 s | Wrong code refused, model keys entered, `talosconfig` downloaded |
| 516 s | Forgejo login, issue #1 created |
| 849 s | PR #2 merged |

From empty VM boot to merge is about 14 minutes (one disk, UEFI, 16GB memory, disk cache `unsafe`).

Not checked:

- Real hardware. Everything was done on KVM virtual machines (virtio disk and network).
- Behaviour after a reboot, and the case where the DHCP address changes.

## Static address and disk choice (v0.2.0)

**Talos already handles static addresses.** On a network without DHCP (`idea-static`), the v0.1.0 ISO was booted as is; on the console, F3 (Network Config) was used to enter DNS, interface, Static, address and gateway, then Save.

- The address came up right after saving, and the extension that was waiting for an address generated the config and started the install.
- Talos keeps that network setting in META and writes it to the META partition on the disk at install (console: `META: saved 2 keys`). After a reboot it came up with the same address.
- On that machine, the setup page, model key entry and issue → merge all passed (setup page answered at 306 s, merge at 635 s).

So nothing of ours was built for addresses. The extension only waits for an address and prints a hint on the console to press F3. The boot option `ip=` is not used, since Talos states that it disappears after the install.

**Disk choice was built because Talos has no screen for it.** It is BusyBox `httpd` inside the extension plus one shell CGI (`images/talos/setup/www`).

- It only appears before the install, on a machine with no config. It closes once a choice is made.
- Whether a disk is empty is judged by the presence of partitions and the signatures Talos recognized (`discoveredvolumes`).
- Submitted values are compared literally with the candidate list. Values not in the list, and submissions without the confirmation check, are refused.
- If the disk chosen for data has content, it is wiped with the maintenance API's `wipe disk` before use (only confirmed that the API works in maintenance mode; the path of choosing a disk with content as the data disk was not exercised).

Test: a VM with 2 disks (GPT and ext4 on the first, the second empty). The install page address appeared on the console and it waited. The page showed `/dev/vda · 60 GB · has data` and `/dev/vdb · 24 GB · empty`. Submitting without confirmation, a non-existent disk, and a value with a command mixed in were refused. Choosing vda as system and vdb as data started the install.

On that machine, the setup page answered (306 s), model key entry, issue creation and PR merge all passed.

## Points for the design

- The install page and the maintenance API have no authentication. Before the install, anyone on the same network can start an install (that is how Talos maintenance mode works).
- If a disk already has Talos installed, the ISO halts (`talos.halt_if_installed`). To reinstall, wipe the disk first.
- If the machine address changes through DHCP, it no longer matches the address in the certificate. In environments where the address must be fixed, enter it with F3 on the console.
- The setup code never changes. If it leaks, the only way to change it is a reinstall.
- Installed machines follow the `stable` tag, so a bad release spreads to every machine. Pre-release testing and a rollback procedure are needed.
- Single-machine layout only. No path for adding nodes was built.
