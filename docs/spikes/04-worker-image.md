# Stage 4. Worker VM golden image and desktop

Date: 2026-11-12
Result: **pass**

## Verification

| Item | Result |
| --- | --- |
| `/vm/<name>/` serves the noVNC page from the host | `https://idea.internal/vm/w1/` 200, `vnc.html` 200 |
| The websocket connects with 101 | `101 Switching Protocols` on `/vm/w1/websockify`, followed by the VNC greeting `RFB 003.008` |
| `curl https://example.com` works inside the pod | 200 |
| Access to node IP:6443 is blocked | Timeout (blocked) |
| Access to the host gateway is blocked | Timeout (blocked) |
| Hubble records it | `Policy denied DROPPED`, `EGRESS DENIED` entries confirmed |
| Measured memory idle and with 3 Chrome tabs | Table below |
| The image check finds no secrets | `check-image.sh` passes |

Also confirmed blocked: the `kubernetes.default` service, pods in other namespaces, `169.254.169.254`.

## Layout

### Image (`images/worker/`)

- Debian trixie-slim + XFCE + TigerVNC (Xvnc) + noVNC (websockify) + Google Chrome + Node.js + sshd.
- Everything runs as the non-root user `idea` (uid 1000). Process management by supervisord.
- Not in the image: SSH host keys (generated at container start), `authorized_keys` (to be mounted from a Secret), login state.
- With `IDEA_PATH_PREFIX` (for example `/vm/w1`) noVNC is served under that path. **This works as is even behind an ingress that cannot rewrite paths.**
- Build: `scripts/build-worker.sh` (podman build → `check-image.sh` → push to the local registry). Size 1.58GB.

### Worker pod (`deploy/apps/worker-test/`)

- Test worker pod `w1`: `runtimeClassName: kata`, namespace `idea-work` (Pod Security `restricted`).
- Privileges: non-root, `allowPrivilegeEscalation: false`, all capabilities dropped, no service account token mounted.
- Resources: memory limit 2Gi → guest VM 4GB (Kata default 2GB + 2Gi). `/dev/shm` is memory-backed, 1Gi.
- Ingress path `/vm/w1/` → service `w1:6080`.

### Network policy (`deploy/infra/config/worker-network-policy.yaml`)

A `CiliumClusterwideNetworkPolicy` applied to every pod labelled `idea.dev/role=worker`.

| Direction | Allowed |
| --- | --- |
| Ingress | Ingress controller → 6080 |
| Egress | Cluster DNS, public ranges (excluding private 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10) |

Forgejo, the package cache and SSH from the main agent are added in the stages where they appear.

## Versions

| Component | Version |
| --- | --- |
| Worker image | 0.1.1 |
| Debian | trixie-20261104-slim |
| Google Chrome | 157.0.8103.78 (deb sha256 pinned) |
| Node.js | v26.13.1 (sha256 pinned) |

## Measured memory

With a 4GB guest (limit 2Gi).

| State | Used inside the guest | VMM resident memory on the node |
| --- | --- | --- |
| Idle (XFCE desktop only) | 276MB | 510MB |
| 3 Chrome tabs | 601MB | 1.3GB |

- Total node usage shows about 2.06GB idle and about 2.07GB with 3 tabs, but VMM memory is counted as shared memory and does not fully appear in that number. Node available memory went from 13.0GB to 12.2GB.
- Host available memory: 16GB.
- The plan's "one worker VM 3–4GB" holds as an upper bound; light work sits around 1–1.5GB.

## Chrome sandbox

**Works as is, without `--no-sandbox`.**

- Unprivileged user namespaces can be created inside the Kata guest (`unshare -U` succeeds), so Chrome uses its namespace sandbox.
- Checked: of 15 Chrome processes, 9 are in seccomp filter mode (2) and in separate user and PID namespaces. No process carries the `--no-sandbox` flag.
- The pod stays at Pod Security `restricted` (no setuid sandbox or extra privileges needed).
- The log shows `Failed to adjust OOM score of renderer`, with no effect on operation.

## Problems and fixes

### The desktop session stopped halfway

- Symptom: only `xfce4-session` is present, no window manager or panel. The log says `unable to connect to D-Bus`.
- Cause: `dbus-launch --exit-with-session` ends the bus immediately when there is no terminal.
- Fix: switched to `dbus-run-session -- startxfce4` (image 0.1.1).

### False positives in the image check

- The empty `.npmrc` shipped by npm and the string `BEGIN PRIVATE KEY` in docs and sources were flagged. The check was narrowed to "`.npmrc` containing credentials" and "keys with a body".
- A built-in self-test key in the GnuTLS library was flagged. It is identical in every Debian package, so it was added to the allow list (`images/worker/private-key-allowlist`) with a reason.
- Image 0.1.0 was pushed to the registry in a failed-check state through a mistake of mine (the check output was piped to `tail`, which hid the exit code). Only the false positives above were flagged, so nothing leaked. Inside `build-worker.sh` a failed check never pushes.

## Points for the design

- **It works without path rewriting.** The worker image handles the prefix itself, so Cilium Ingress was enough. No reason to switch to Gateway API at this stage (Forgejo is checked again in stage 7).
- **VNC has no authentication.** Right now anyone who can reach the ingress sees the desktop at `/vm/<name>/`. Fine for development inside NAT, but authentication in front of the ingress is needed before publishing.
- **The pod seccomp profile is not applied inside the Kata guest** (Seccomp is 0 for processes in the guest). Isolation is the VM boundary. This is also why the Chrome sandbox works.
- **Google Chrome's license does not allow redistribution.** For now it stays only in the local registry. To distribute the image publicly, switch to Chromium or have users build it themselves.
- The pinned Chrome deb disappears from the Google repository over time. To keep the build reproducible, keep the deb locally or look at Chrome for Testing (permanent per-version URLs).
- `/etc/machine-id` is fixed in the image, so every worker pod uses the same value. Not a secret, but if it must differ per pod, generate it at start.
- The first image pull took 53 seconds (1.58GB, HDD). Without a warm pool, the first task starts that much later.
