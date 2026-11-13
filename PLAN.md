# idea stage 1 build plan (work instructions for Claude Code)

Written 2026-11-12 (v2: switched to Flux reconciliation. v3: data path `/DATA/idea`, host check results applied). This file is the document Claude Code reads on the Ubuntu server and carries out as written.
The human-readable design text is in `docs/design.md` (if it is missing, proceed with the summary below only).

## 0. What we are building

**idea**: an "agent factory" that can be attached anywhere, as open source. Given an issue, an agent fixes the code in an isolated worker VM and takes it through a PR and gates to merge.

- Deployment unit: one Talos Linux image. On top of it Cilium and Kata Containers.
- **Deployment method: Flux reconciles.** The Talos machine config seeds Cilium and Flux; from then on Flux brings the cluster to the declared state by itself. It is not a sequence of install scripts.
- Worker VM: a Kata runtime pod (a lightweight VM per pod). Debian + XFCE + noVNC + Chrome + dsh.
- Agent harness: dsh (DeepSeek Harness) and plugins.
- Access: Cilium ingress, a single port 443, routed by path. The name is `idea.internal` (HTTPS is served only under this name).
- Git: Forgejo inside the cluster.

**Scope of this stage**: one full loop on a single node, "one example issue goes through a PR to merge".

**Not in this stage**: Kodus, Infisical, web console, warm pool (0–1 only), multi-node, backups, Windows VMs, upstream contributions, automatic upgrades of Talos OS itself. KubeVirt is not used.

## 1. Environment and constraints

| Item | Value |
| --- | --- |
| Host | Ubuntu server, 32GB RAM |
| Talos VM | 1, 16GB RAM, named `idea-talos-1` |
| Running at once | 1 main agent + 1–2 worker VMs |
| Repository | `/root/Idea` (capital I. "the repository" in this document means this path) |
| Remote | `https://github.com/popododo0720/Idea` (**public repository**. Treat everything committed as public and follow 4.7) |
| Secrets | `~/.idea-secrets` (outside the repository, mode 700) |
| Data | `/DATA/idea` (`IDEA_DATA_DIR`). VM disks, ISOs, local registry storage and image build storage all go here. No large files on the root filesystem (`/`) |

Layout under `/DATA/idea`:

```
/DATA/idea/
  vm/          idea-talos-1.qcow2
  iso/         Talos ISO
  registry/    local registry data
  build/       podman/docker build storage (graphroot)
  notes/       records that do not go into the repository: host inventory results, screenshots (4.7)
```

Other directories under `/DATA` and existing libvirt pools are not touched.

Memory budget (estimates; measure and record at each stage):

| Component | Estimate |
| --- | --- |
| Talos + Kubernetes + Cilium/Hubble | 3GB |
| Flux (source, kustomize, helm controllers only) | 0.3GB |
| cert-manager | 0.2GB |
| Forgejo + Postgres + controller | 1–1.5GB |
| Main (dsh headless) | 1GB |
| 1 worker VM | 3–4GB |

## 2. Working rules

1. **Follow the stage order.** The "Verification" of each stage must pass before moving on.
2. **Check versions against the official docs at execution time and pin them in `versions.env`.** The commands in this document are examples. If the docs differ, follow the docs and record the difference. The `latest` tag is never used.
3. **Write `docs/spikes/NN-name.md` at the end of every stage.** Result (pass/fail), the commands actually used, versions, measured memory, blockers and fixes, points for the design.
4. **Everything in the cluster is declared.**
   - The cluster state is defined by the manifests in `deploy/` and reconciled by Flux. Nothing is installed directly with `kubectl apply` or `helm install`.
   - Resources made by hand while debugging are moved into manifests and then deleted. A stage never ends with `flux suspend` in effect.
   - Where ordering is needed, express it with Flux `dependsOn` and health checks, not scripts.
   - State that is not a Kubernetes resource (Forgejo organizations, repositories, webhooks, tokens) is also reconciled by a controller or an idempotent Job, not a run-once script.
   - Scripts are allowed only **outside** the cluster: creating the VM on the host, generating and applying the Talos config, loading human-provided secrets, pushing deployment artifacts.
5. **Stay within the host footprint.**
   - Only create and delete resources whose names start with `idea-`. Do not touch other VMs, networks or disks.
   - Large files written on the host go only under `/DATA/idea`. Nothing else under `/DATA` is read or modified.
   - Host network settings (bridges, firewall, netplan) are not changed. If needed, stop and ask.
   - Exception: creating the dedicated libvirt NAT network `idea-net` (bridge `idea-br0`, 192.168.123.0/24, DNS off, DHCP only) and setting it to autostart is allowed. The existing `default` network and the host DNS server are not touched. (On this host the DNS server grabs port 53 on the new bridge first, so `default` does not come up. Decided 2026-11-12.)
   - Package installation is allowed. If a service restart would affect other VMs, stop and ask.
6. **After three failures at the same point, stop and report.** Do not widen the scope to work around it.
7. **The secret rules in chapter 4 take precedence over every other rule.**

### When to stop and ask a human

- Nested virtualization is off, or host available memory is under 18GB (by the `available` column of `free`; the `free` column does not subtract cache, so it is not used)
- A host network change, or deleting or modifying a resource without the `idea-` prefix, is needed
- A secret is found in a commit, deployment artifact or image
- A login (Claude, Codex or other OAuth), account creation or payment is needed
- About to push to a remote Git repository or a public registry
- A choice that differs from the design is needed (for example a runtime other than Kata)

## 3. What the human prepares in advance

- [ ] The account running Claude Code has `sudo` and `libvirt` group membership.
- [ ] Create `~/.idea-secrets/env` and fill in the values (format in the repository's `.env.example`).
  - `DEEPSEEK_API_KEY=` (needed in stage 5)
- [ ] (Optional) Export the design document as Markdown to `/root/Idea/docs/design.md`. Check first that its content may be public.
- [ ] In `~/.idea-secrets/private-strings`, list strings that must never enter the repository (hostnames, real email addresses, public IPs and so on), one per line.
- [ ] Connecting the Claude subscription (late in stage 5) requires the human to log in. Claude Code stops and notifies at that point.

## 4. Secret rules

**Principle: secrets exist neither in the repository nor in the deployment artifacts Flux reads. Not even in encrypted form (SOPS and so on).** `.gitignore` is only a second line of defense.

### 4.1 What counts as a secret

- Talos: `secrets.yaml`, `controlplane.yaml`, `worker.yaml`, `talosconfig` (they contain the cluster CA and tokens)
- `kubeconfig`
- Model API keys, Claude and Codex login credentials and tokens
- Forgejo admin password, access tokens, webhook secrets
- Postgres passwords
- SSH private keys, TLS private keys

### 4.2 Two kinds of secrets and how they get in

| Kind | Examples | Method |
| --- | --- | --- |
| Can be generated | Postgres and Forgejo admin passwords, webhook secrets, worker VM SSH keys, ingress TLS keys | **Generated inside the cluster.** A generator in the manifests creates them if missing and leaves them alone if present. Never passes through human hands or the repository |
| Must come from a human | Model API keys, Claude and Codex credentials | `scripts/apply-secrets.sh` reads them from `~/.idea-secrets` and loads them into the cluster. Once, after bootstrap. Everything else must be up and healthy even without these values |

- The generator should **prefer a secret generation operator**. If a Job is the only option, handle the fact that Job fields are immutable, so changing the manifest makes the Flux reconcile fail (the `kustomize.toolkit.fluxcd.io/force: enabled` annotation). Test that a rerun does not overwrite existing values.
- The ingress TLS certificate is made with cert-manager's self-signed issuer (`selfSigned` ClusterIssuer). It lives in `deploy/infra/`. Public certificates are out of scope.
- Manifests and Helm values reference Secrets **by name only** (`existingSecret`, `secretKeyRef`).
- No `kind: Secret` manifests under paths Flux manages. Check that Flux prune does not delete Secrets loaded by a human.

### 4.3 Where they live on the host

```
~/.idea-secrets/            # chmod 700, files 600
  env                       # values filled in by the human
  private-strings           # strings that must never enter the repository (4.7)
  talos/                    # secrets.yaml, controlplane.yaml, talosconfig
  kubeconfig
```

- The `TALOSCONFIG` and `KUBECONFIG` environment variables point into this directory. Nothing is copied into the repository or `~/.kube/config`.
- The path can be changed with the `IDEA_SECRETS_DIR` environment variable, and scripts fail if it points inside the repository.
- Talos config: first create the secrets with `talosctl gen secrets`, then apply the repository's patches with `gen config --with-secrets` and generate **into the secrets directory**. The repository holds only the schematic and patches.
- **No secrets baked into container images.** Golden images must contain no keys, tokens or logged-in state. Secrets are never passed with `ARG`/`ENV` in a Dockerfile.

### 4.4 `.gitignore` (created before the first commit)

```
.env
.env.*
!.env.example
kubeconfig*
talosconfig*
controlplane.yaml
worker.yaml
secrets.yaml
*.secret.yaml
*-secret.yaml
**/secrets/
*.key
*.pem
*.p12
id_rsa*
id_ed25519*
_out/
*.iso
*.qcow2
*.raw
```

### 4.5 Checks

- Install `gitleaks` and check staged changes in `.githooks/pre-commit`. Hook it up with `git config core.hooksPath .githooks`. (Check the command against `gitleaks --help` of the installed version.)
- Create `scripts/check-secrets.sh`.
  1. Check the working tree and the full history with gitleaks.
  2. Fail if there is a `kind: Secret` under `deploy/`.
  3. Compare the real values in `~/.idea-secrets` against the repository working tree and history. **Never print the values**; print only the file path and key name.
- This script runs **at the end of every stage**, **before pushing deployment artifacts**, and **before every Git push**. If it fails, do not proceed.
- Built images are checked too (layer history, key and token files inside the image).

### 4.6 Handling

- Never `cat` a secret file. If a value is needed, `source` it inside a script. Never handle secrets with `set -x` on.
- Never pass secrets as command-line arguments. Pass them through files, standard input or environment variables.
- Never put the output of `kubectl get secret -o yaml` in a report or log.
- Never write values in `docs/spikes/` reports, commit messages or issue bodies.
- **Never push to the remote until a human says so.** Normally only local commits and the host's local registry are used. Before a push, `check-secrets.sh` must have passed just before, and the commit range to be pushed (`git log origin/main..HEAD --stat`) is shown to the human first. No `--force` push.
- If a secret has leaked in: stop immediately and report. Do not stop at fixing history; **revoke the value and issue a new one**. If it was already pushed, treat it as public and revoke first.

### 4.7 Public repository rules

The remote is a public repository, so the following does not go into the repository even though it is not a secret.

- **Information about this host**: names and lists of other VMs, networks and storage pools, hostnames, public IPs, internal ranges, account names, names of other directories under `/DATA`. The host inventory from stage 0 is written to `/DATA/idea/notes/host-inventory.md` (outside the repository), not `docs/spikes/`.
  - Exceptions: addresses in the `idea-net` range (gateway, node IP), resource names starting with `idea-`, and the paths `/root/Idea` and `/DATA/idea` may be written.
- **Personal information**: real email addresses, names. The commit author email is set to the GitHub noreply address in the repository-local config (`git config user.email`). The global config is not changed.
- **Raw output**: never paste command output or logs wholesale. Copy only the needed lines into reports, and read them first to make sure no tokens, cookies, auth headers or internal addresses are mixed in.
- **Screenshots and recordings**: the browser screenshots of 5b go in `/DATA/idea/notes/` and are not committed. Reports describe only the result in words.
- Add a fourth check to `check-secrets.sh`: fail if any string from `~/.idea-secrets/private-strings` (one per line, a human-maintained list of forbidden strings: hostnames, emails, public IPs and so on) appears in the working tree or history. Print only the file path and line number, not the value.

## 5. Repository layout

```
deploy/                  Declarations Flux reads (no secrets)
  clusters/dev/          Entry point: Kustomizations and dependsOn ordering
  infra/                 Cilium, RuntimeClass, network policies, secret generators, cert-manager and issuers
  platform/              Postgres, Forgejo
  apps/                  Controller, main agent, CRDs
  bootstrap/             What Talos seeds first: Cilium, Flux, root source
charts/                  Helm charts we make (controller and so on)
controller/              Controller (Go). CRDs and Postgres
plugins/                 idea plugin, worker VM connection plugin (TypeScript)
images/worker/           Worker VM golden image
images/talos/            schematic.yaml, patches/*.yaml
console/                 (left empty in this stage)
examples/                Example repository and the end-to-end test issue
scripts/                 vm-create.sh, vm-destroy.sh, talos-apply.sh, apply-secrets.sh, push-deploy.sh, check-secrets.sh
docs/spikes/             Per-stage reports
versions.env             Versions of every component (no secrets)
```

Principles
- `deploy/` and `charts/` assume only "Kubernetes with Cilium and a `kata` RuntimeClass". Talos-specific settings live only in `images/talos/` and `deploy/bootstrap/`.
- Flux layers are chained with `dependsOn` in the order `infra → platform → apps`.

### Flux source

- The Flux source is an **OCI artifact** (`OCIRepository`), not Git. Forgejo lives inside the cluster, so using Git as the source would be a chicken-and-egg problem.
- During development: `deploy/` is pushed to the host's local registry with `flux push artifact`, and the cluster follows that tag. `scripts/push-deploy.sh` pushes after `check-secrets.sh` passes.
- The local registry is HTTP. Give `OCIRepository` `insecure: true`, and give `flux push artifact` that version's plain-HTTP option (check the option name with `flux push artifact --help`).
- **The deployment artifact must exist before the cluster.** `push-deploy.sh` must have run at least once, so that the registry has the tag, before a new VM is created; otherwise Flux has nothing to follow. `talos-apply.sh` fails if the tag is missing.
- After publishing (out of scope): each release is pushed to a public registry with a version tag, and installed clusters follow a version range and update themselves.

## 6. Stages

### Stage 0. Host check and tools

To do
- Check the CPU virtualization flags (`vmx`/`svm`), nested virtualization (`/sys/module/kvm_intel/parameters/nested` or `kvm_amd`), free memory, and free disk on `/DATA` (at least 150GB).
- Create `/DATA/idea` and its subdirectories. Check that the libvirt (qemu) user can read and write `vm/` and `iso/`.
- Inventory the existing libvirt VMs and networks and record them in `/DATA/idea/notes/host-inventory.md` (do not touch them; not in the repository, 4.7).
- `git init`, set `origin` to the public repository, and set the commit author email to the GitHub noreply address in the repository-local config. Do not push.
- Install (`scripts/host-setup.sh`): `qemu-kvm`, `libvirt-daemon-system`, `virtinst`, `talosctl`, `kubectl`, `helm`, `flux` CLI, `cilium` CLI, `gitleaks`, an image build tool (podman or docker), `jq`, `yq`.
- Start a local registry on the host. **Bind it only to the `idea-net` gateway IP** (never 0.0.0.0). Worker VM images and Flux deployment artifacts go here. Registry data goes in `/DATA/idea/registry` and image build storage in `/DATA/idea/build` (do not use the default location under `/var/lib`).
- Create the repository and add the skeleton from chapter 5, `.gitignore`, the pre-commit hook and `check-secrets.sh` **before the first commit**.

Verification
- Nested virtualization is on.
- Deliberately staging a file with a fake key gets the commit rejected (delete the file after checking).
- The registry is open only on the `idea-net` gateway address.
- `git log --format=%ae` shows only the noreply address. Staging a test string from `private-strings` gets the commit rejected.
- Registry data and build storage accumulate under `/DATA/idea` (usage of `/` does not grow).

### Stage 1. Talos VM

To do
- Put the `siderolabs/kata-containers` extension in `images/talos/schematic.yaml`, submit it to Image Factory and get the schematic ID. Record the ID in `versions.env`.
- Download `metal-amd64.iso` of the same schematic to `/DATA/idea/iso/`.
- Use the dedicated NAT network `idea-net` (created by `scripts/host-setup.sh`). Fix the VM's MAC and pin the node IP with a DHCP reservation. This network gives no DNS, so nameservers are written into the Talos machine config. Addresses and names go in `config.env`.
- VM creation example (`scripts/vm-create.sh`):

```
virt-install --name idea-talos-1 --memory 16384 --vcpus <half the host cores, at least 4> \
  --cpu host-passthrough \
  --disk path=/DATA/idea/vm/idea-talos-1.qcow2,size=100,bus=virtio,format=qcow2 \
  --cdrom <ISO path> --boot hd,cdrom \
  --network network=idea-net,model=virtio,mac=<fixed MAC> \
  --graphics none --noautoconsole
```

- Machine config patch (`images/talos/patches/base.yaml`). From Talos v1.14 the machine config is split into several documents, so the old keys `cluster.network.cni`, `cluster.proxy`, `allowSchedulingOnControlPlanes` and `machine.install` are not used:

```yaml
apiVersion: v1alpha1
kind: KubeFlannelCNIConfig      # remove the default CNI (Cilium is used)
$patch: delete
---
apiVersion: v1alpha1
kind: KubeProxyConfig           # turn off kube-proxy
enabled: false
---
apiVersion: v1alpha1
kind: KubeNodeConfig            # single node: schedule workloads on the control plane
taints:
  node-role.kubernetes.io/control-plane:
    $patch: delete
```

- The install disk and install image are given with `--install-disk` and `--install-image` of `talosctl gen config`, not with a patch.
- Nameservers (`ResolverConfig`) and the local registry (`RegistryMirrorConfig`) go in `images/talos/patches/host.yaml.tmpl`, rendered with values from `config.env`.
- Generation and apply (`scripts/talos-apply.sh`; all output goes to the secrets directory):

```
talosctl gen secrets -o $IDEA_SECRETS_DIR/talos/secrets.yaml
talosctl gen config idea https://<node IP>:6443 \
  --with-secrets $IDEA_SECRETS_DIR/talos/secrets.yaml \
  --install-disk /dev/vda \
  --install-image factory.talos.dev/metal-installer/<schematic ID>:<Talos version> \
  --config-patch-control-plane @images/talos/patches/base.yaml \
  --config-patch @_out/talos/host.yaml \
  --output $IDEA_SECRETS_DIR/talos/
talosctl apply-config --insecure -n <node IP> --file $IDEA_SECRETS_DIR/talos/controlplane.yaml
talosctl bootstrap -n <node IP> -e <node IP>
talosctl kubeconfig $IDEA_SECRETS_DIR/kubeconfig -n <node IP> -e <node IP>
```

Things to check
- The install image path, registry settings and config document format depend on the Talos version. Compare with the docs for that version.

Verification
- kata-containers appears in `talosctl get extensions`.
- `/dev/kvm` exists inside the node.
- The node appears in `kubectl get nodes` (NotReady because there is no CNI is expected).

### Stage 2. Bootstrap: Talos seeds Cilium and Flux

Goal: **with no command other than applying the Talos config**, Cilium and Flux come up and Flux starts following `deploy/`.

To do
- Put the initial seed in `deploy/bootstrap/`.
  1. Cilium: manifests rendered with `helm template`. Values as below.
  2. Flux: install manifests (source, kustomize and helm controllers only; no notification or image automation). If the Flux Operator approach is simpler, use it and record why.
  3. Root source: an `OCIRepository` pointing at the deployment artifact in the local registry, and a `Kustomization` pointing at `deploy/clusters/dev`.
- Put these into the Talos machine config as `cluster.inlineManifests` or `cluster.extraManifests`. If the config size limit is hit, use `extraManifests` (URL). This patch is a build product: generate it in `_out/` and do not commit it (it has no secrets).
- Cilium values (for Talos):

```yaml
ipam:
  mode: kubernetes
kubeProxyReplacement: true
k8sServiceHost: localhost
k8sServicePort: 7445
cgroup:
  autoMount:
    enabled: false
  hostRoot: /sys/fs/cgroup
socketLB:
  hostNamespaceOnly: true     # needed for service access from Kata pods
securityContext:
  capabilities:
    ciliumAgent: [CHOWN, KILL, NET_ADMIN, NET_RAW, IPC_LOCK, SYS_ADMIN, SYS_RESOURCE, DAC_OVERRIDE, FOWNER, SETGID, SETUID]
    cleanCiliumState: [NET_ADMIN, SYS_ADMIN, SYS_RESOURCE]
hubble:
  enabled: true
  relay:
    enabled: true
ingressController:
  enabled: true
```

- After bootstrap, Flux manages Cilium too (`deploy/infra/`).
- Serve the ingress on **port 443 of the node IP**. Try in order: (1) ingress host network mode, (2) LB IPAM + L2 announcement with one IP from the libvirt range.
- `scripts/push-deploy.sh`: `check-secrets.sh` → `flux push artifact` → wait for reconcile.
- Put a test nginx and the ingress path `/test/` in `deploy/` and push.

Things to check
- How the Flux HelmRelease takes over the Cilium that Talos seeded (Helm ownership metadata). If it is not clean, manage Cilium as rendered manifests with a Kustomization.
- Talos inline/extra manifests are applied only at bootstrap. Every change after that is done on the Flux side.
- The limitations in the Cilium docs "Kata Containers with Cilium" (socket LB, MTU).
- The privilege settings Envoy needs to bind 443 (a port below 1024) in ingress host network mode (`NET_BIND_SERVICE` related values). Check the docs for that Cilium version.

Verification
- (Precondition: the deployment artifact is already in the registry.) After running only `scripts/vm-destroy.sh` → `vm-create.sh` → `talos-apply.sh`, **with no further command**, the node becomes Ready and `flux get kustomizations` is all Ready.
- HTTPS `/test/` returns 200 from the host. Cilium ingress needs SNI, so connect by the ingress name, not the node IP: `curl -k --resolve idea.internal:443:<node IP> https://idea.internal/test/`. The certificate is the self-signed one issued by cert-manager (check the issuer).
- Deleting the test nginx Deployment with `kubectl delete` gets it recreated by Flux.
- Removing nginx from `deploy/` and pushing removes it from the cluster too (prune).

### Stage 3. Kata pods

To do
- Find the containerd handler name the extension registered (`kata`, `kata-qemu` and so on) and put a RuntimeClass in `deploy/infra/`.
- Start a test pod. Also start one with a memory limit of 4Gi and see whether the guest VM memory follows the limit. (One-off test pods may be created by hand. Delete them when done.)

Verification
- `uname -r` in the pod differs from the node kernel.
- Cluster services (DNS, a test service) are reachable from the pod.
- `free -m` inside the pod with limit 4Gi reflects it.
- Measure and record the host-side memory overhead of one pod.

### Stage 4. Worker VM golden image and desktop

To do
- `images/worker/`: Debian + XFCE + VNC server + noVNC (websockify) + Chrome + Node.js + sshd. Runs as a non-root user. No secrets in the image. Pushed to the local registry with a version tag.
- Declare the worker pod template and the ingress path `/vm/<name>/` (noVNC).
- Cilium network policy for worker pods (`deploy/infra/`):
  - Allow: DNS, the internet (public ranges), Forgejo and the package cache inside the cluster.
  - Block: private ranges (10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10), the node, the kube-apiserver.
- See whether the Chrome sandbox runs as is inside the Kata guest. If not, record the cause and the options and stop (never quietly enable `--no-sandbox`).

Verification
- From the host, `/vm/<name>/` serves the noVNC page and the websocket connects with 101.
- Inside the pod `curl https://example.com` works, while connections to node IP:6443 and the libvirt gateway are blocked. Hubble records it.
- Measure memory idle and with 3 Chrome tabs open.
- The image check finds no secrets.

### Stage 5. dsh and browser control

To do
- Put dsh in the golden image. Follow the README of the official repository (github.com/deepseek-ai/deepseek-harness) for the install method. **Never guess package names or commands.** Pin dsh and the plugins to a version or commit in `versions.env`.
- 5a. Run the headless profile with the DeepSeek API key. The key references the Secret loaded by `apply-secrets.sh`.
- 5b. Attach a browser control plugin (starting with ones that explicitly name Linux+Chrome) and have it open a page in the desktop Chrome, read the title and save a screenshot.
- 5c. Test whether a Linux desktop control plugin runs on XFCE. If not, record it as is (an alternative implementation is out of scope).
- 5d. **(Human needed)** Connect the Claude subscription. Use a plugin that drives a logged-in Claude Code through the official Agent SDK. Do not use plugins that mimic Claude Code's identification headers. The human logs in, and the credentials are injected as a Secret. See whether token refresh conflicts when 2 worker pods use one account at the same time.
- Check in the docs and code whether dsh has a hook (before/after tool call events) API.
- Model keys and Claude credentials may exist inside this server (`~/.idea-secrets`, cluster Secrets, running pods). They just must not enter the repository, deployment artifacts or golden images (chapter 4).

Verification
- 5a and 5b pass reproducibly.
- 5c, 5d and hooks have a result (works / does not / conditional) in the report.
- The other Flux Kustomizations are Ready even without the API key Secret.

### Stage 6. How the main agent delegates work to a worker VM

To do
- Run the main agent as a dsh headless pod (not Kata, a regular pod). Declare it in `deploy/apps/`.
- Compare two options on the same task ("clone the example repository, run the tests and return the result").
  - A. A hand-written SSH plugin (`plugins/`): main sends commands to the worker pod over SSH. Keys are generated inside the cluster (4.2).
  - B. dsh-yawn's Kubernetes sandbox.
- Criteria: can it use the Kata RuntimeClass and the desktop image, recovery when the session drops, where logs are read, fit with our network policy, can it be kept declarative.

Verification
- The results of both options and the reason for the choice are in the report. The task above passes with the chosen option.

### Stage 7. Full loop

To do
- Put Postgres and Forgejo in `deploy/platform/` as HelmReleases. Passwords reference Secrets generated inside the cluster via `existingSecret`. Check that Forgejo comes up under the ingress path `/git/` (sub-path setting).
- The controller reconciles the state inside Forgejo: organization, example repository, webhook, a token for the worker VM (scoped to that repository only). The declaration lives in a CRD or settings, and is recreated if deleted.
- Define the example repository in `examples/` (a small function and tests) and one test issue ("add function X, with tests").
- Minimal controller (`controller/`, deployed via `deploy/apps/`):
  1. Receives issues through the Forgejo webhook (webhook secret verified).
  2. Creates a Task resource and records state in Postgres. Never picks up the same issue twice.
  3. Starts a worker pod and has main delegate the work with the option chosen in stage 6.
  4. The worker VM creates a branch and a PR.
  5. Gate: tests pass. Try a Forgejo Actions runner first; if it does not work within a day, fall back to the controller re-running the tests in a clean Kata pod and recording a commit status, and note that in the report.
  6. On pass, merge and comment on the issue. Clean up the worker pod.
- The controller continues in-progress Tasks after a restart. **The single source of truth for progress is the Task CRD status.** Postgres is used only for deduplication (unique key on the issue ID) and history; when the two disagree, the CRD wins. There is no in-memory-only state.
- Write the license list of the deployed components to `docs/licenses.md` (name, version, license, source). Entries must match `versions.env`.
- Leave only the interface for the review gate (Kodus) slot.

Verification
- A PR is merged with no human action other than creating the issue. Twice in a row.
- An issue with a deliberately failing test is not merged.
- Deleting the controller pod mid-Task still lets the Task finish.
- Deleting the webhook by hand in Forgejo gets it recreated by the controller.
- Fill the memory table with measured values for everything running.
- `docs/licenses.md` lists every component of `versions.env`.

## 7. Completion criteria

- [x] **Applying the Talos config to an empty VM converges to the state of stages 2–7 with no further commands.** The only human actions are one run of `apply-secrets.sh` and the login of 5d.
- [x] Deleting or changing resources in the cluster by hand returns them to the declared state (Flux-managed resources, the Forgejo webhook).
- [x] Changing `deploy/` and pushing makes the cluster follow. What is removed gets deleted.
- [x] The example issue goes to merge twice in a row.
- [x] `docs/spikes/00~07` all exist, with the measured memory table and the "points for the design" list.
- [x] `scripts/check-secrets.sh` passes on the working tree, the full history, deployment artifacts and images.
- [x] Every component version is pinned in `versions.env`.
- [x] The license list of the deployed components is in `docs/licenses.md` (name, version, license, source).

All items above were confirmed on 2026-11-12. The evidence is `docs/spikes/00~07` and the run results of `scripts/e2e.sh`. Deviations from the plan are in the "Deviations from the plan" section of each stage report.

## 8. Reference docs (check the matching version at execution time)

- Talos Boot Assets / Image Factory: https://docs.siderolabs.com/talos/v1.13/platform-specific-installations/boot-assets.md
- Installing Cilium on Talos: https://docs.siderolabs.com/kubernetes-guides/cni/deploying-cilium
- Cilium and Kata: https://docs.cilium.io/en/stable/network/kubernetes/kata/
- Talos extension list: https://github.com/siderolabs/extensions
- Flux docs (OCIRepository, Kustomization, HelmRelease): https://fluxcd.io/flux/
- dsh: https://github.com/deepseek-ai/deepseek-harness
