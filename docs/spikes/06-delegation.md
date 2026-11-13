# Stage 6. How the main agent delegates work to a worker VM

Date: 2026-11-12
Result: **Option A (SSH plugin) passes. Option B (dsh-yawn) was evaluated from docs and source only, not run**

## Verification

| Item | Result |
| --- | --- |
| The results of both options and the reason for the choice are in the report | Present. But B is a docs and source evaluation, not a run result (see "Deviations from the plan" below) |
| "Clone the example repository, run the tests and return the result" passes with the chosen option | Pass (option A) |

## Option A. SSH plugin

### Layout

```
idea-system                              idea-work
┌─────────────────────────┐              ┌──────────────────────────────┐
│ idea-main (regular pod) │   SSH 2222   │ w1 (Kata VM)                  │
│  dsh headless           │ ───────────▶ │  sshd → dsh headless --json   │
│  + worker_run tool      │              │  shell, git, Node.js, Chrome   │
│  private key (Secret)   │              │  public key (Secret)           │
└─────────────────────────┘              └──────────────────────────────┘
```

- **Main agent**: `deploy/apps/main/main.yaml`. A regular pod (not Kata), image `idea/main` (dsh + plugin + SSH client, 1.25GB). dsh headless handles one task and exits, so the pod waits and runs `dsh headless` whenever a task arrives.
- **Plugin**: `plugins/worker-ssh/src/index.ts` (TypeScript). Adds one tool, `worker_run(worker, task)`. It SSHes into the worker pod, runs `dsh headless --json`, reads the events and returns completion status, answer, tool call count and session ID.
  - The task body is sent on standard input (not on the command line).
  - The full event stream of the remote run is kept on the main pod at `/tmp/idea-runs/<worker pod>-<time>.jsonl`.
  - The plugin is loaded from its source path without a build (dsh reads `.ts` directly).
- **SSH keys**: generated inside the cluster (External Secrets Operator `SSHKey` generator, `deploy/apps/main/ssh-key.yaml`).
  - `idea-system/idea-worker-ssh`: private key + public key. The main pod mounts only the private key.
  - `idea-work/idea-worker-ssh-pub`: public key only (`authorized_keys`). The worker pod mounts it.
  - Generated once and kept (`refreshPolicy: CreatedOnce`). Never passes through human hands or the repository.
- **Network policy**: the worker pod additionally accepts only 2222 from main, and additionally reaches only the in-cluster Git server (9418).
- **Example repository**: `examples/hello-calc` (2 functions and `node --test` tests). Forgejo does not exist yet, so the example bundled in the main image is served by a read-only Git server pod (`git-fixture`). Replaced by Forgejo in stage 7.

### Result

On the main pod:

```
dsh headless --json --approval-policy never \
  "Use the worker_run tool to delegate to w1: clone the repository, run npm test, and report the pass/fail counts and the commit hash"
```

- Main calls `worker_run` → the worker VM clones and tests with 7 tool calls → returns "2 passed, 0 failed, HEAD `1b088a55…`" → main reports it as is. The commit hash matches the real HEAD on the Git server.
- Both sides exit code 0, `final.reason.kind = completed`.

### Evaluation by criterion

| Criterion | Option A |
| --- | --- |
| Kata RuntimeClass | Used as is. The worker pod is the pod we declare |
| Desktop image | Used as is. The agent runs inside the VM, so browser and desktop tools work right there |
| Recovery when the session drops | **Partial.** If SSH drops, the agent process in the VM dies, but the running shell command ran to completion (the file was created), and the session record stays in the VM so continuation with `--session-id` worked |
| Where to read logs | `/tmp/idea-runs/*.jsonl` on the main pod (full events), `~/.dsh/sessions/` in the worker VM (session record). Both disappear with the pod |
| Fits our network policy | Yes. Only one line, main → worker 2222, was added. The worker pod needs no new outbound connection |
| Can be kept declarative | All in `deploy/` (pod, key generation, policy). No hand-made resources |

### Weaknesses

- The model key is inside the worker VM (because the agent runs there).
- The worker pod's SSH host key is regenerated at every start and cannot be pinned. The plugin connects with host key checking off. It is in-cluster traffic and the peer is fixed by Cilium policy, but it is not verification.
- The agent dies on disconnect. Reattaching is up to the caller.

## Option B. dsh-yawn's Kubernetes sandbox (not run)

dsh-yawn is not part of the dsh repository but a third-party distribution by an individual (`github.com/zhming0/dsh-yawn`, MIT, commit checked `bc06a36`, 2026-11-08). The following comes from reading its docs and manifests.

### How it works

- A control plane pod runs `dsh web` (the web UI), and **the agent loop runs on the control plane.** Only file and shell tools run in a per-session sandbox pod.
- Sandboxes are created with the kubernetes-sigs agent-sandbox v1.0.2 CRDs (`SandboxTemplate`, `SandboxWarmPool`, a `SandboxClaim` per session).
- A runner (Go) in the sandbox opens a websocket (8081) to the control plane. No inbound connections.

### Evaluation by criterion

| Criterion | Option B | Basis |
| --- | --- | --- |
| Kata RuntimeClass | Configurable, never verified | `runtimeClassName` can go in the template. The docs example is gVisor; Kata is not mentioned |
| Desktop image | **Cannot be used as is** | The runner image must be the same version as the control plane. Using our image means rebuilding it with that runner inside |
| Browser and desktop tools | **The structure does not fit** | The agent runs on the control plane, so dsh's browser plugin starts there too. It cannot control the desktop Chrome in the sandbox |
| Recovery when the session drops | Better than A (per docs) | It says the runner reattaches and survives control plane restarts and image upgrades |
| Where to read logs | Control plane (web UI and session records) | Gathered in one place |
| Fits our network policy | Direction fits | Only sandbox → control plane 8081 needs opening. The template carries its own NetworkPolicy |
| Pod security settings | **Do not fit** | The runner container has `allowPrivilegeEscalation: true`, 10 added capabilities, passwordless sudo. The default template has a `privileged: true` Docker sidecar (removable). Our work namespace is Pod Security `restricted` |
| Can be kept declarative | Possible, but more components | Needs the agent-sandbox controller and CRDs, the dsh-yawn Helm chart and persistent volumes in addition |
| How to submit a task | Web UI | No documented API for submitting a task headlessly was found |
| Where the model key lives | Better than A | The key is only on the control plane and does not enter the sandbox |

## Choice: option A

Reasons:

1. **This project's worker VM is "an agent using a browser inside a VM that has a desktop".** A keeps that structure; B keeps the agent outside and runs only the shell inside, so what was built in stages 4 and 5 (desktop Chrome control) cannot be used.
2. B cannot use our image and Pod Security settings as is, and needs 3 more third-party components (agent-sandbox, the dsh-yawn control plane, the runner). dsh itself is a developer preview, and this would stack a personal project on top of it.
3. A was done with one 150-line plugin using only what already exists (sshd, dsh headless).

The points worth taking from B are noted as improvement items after stage 7 (below).

## Deviations from the plan

- **Option B was not run.** The plan was "compare both options on the same task". Running B would need the agent-sandbox controller, a persistent volume provisioner (not in the cluster now) and the dsh-yawn chart installed in addition, and even then the only way to submit a task is the web UI, so "main delegates the same task" cannot be reproduced. The docs alone already rule it out on the desktop image and Pod Security criteria, so instead of widening the scope to install it, a docs and source evaluation was done. If an actual run comparison is needed, it is done separately.
- **dsh's official SSH packages (`dsh-ssh` and so on) were not used for the SSH link between worker pod and main.** Those packages put "the agent on main, files and processes remote" (the same direction as B), which does not fit for the same reason.
- **External Secrets Operator was added as the secret generator.** This is the plan's "secret generation operator". The Postgres and Forgejo passwords in stage 7 are created the same way (`Password` generator).

## Versions

| Component | Version |
| --- | --- |
| Main image | 0.1.2 |
| Worker image | 0.4.0 (added an environment file for SSH sessions) |
| External Secrets Operator | 2.15.0 |

## Measured memory

| Target | Value |
| --- | --- |
| Node memory used (platform + ESO + main + Git server + 1 worker VM) | about 3.0GB / 16GB, 11.9GB available |
| Host available memory | 13GB |

## Problems and fixes

- **The plugin could not find the dsh package** (`Cannot find package '@deepseek-ai/dsh-tools'`). A plugin loaded from a source path resolves modules from its own location. A link to the `node_modules` of the dsh install was put in the plugin directory.
- **Tool output schema**: objects must declare `additionalProperties` explicitly.
- **If a plugin fails to load, dsh only warns and carries on.** On the first attempt the main agent honestly reported that `worker_run` did not exist and then did the task directly in its own pod. The controller must check "`worker_run` was called and completed", not "the task is done".
- **SSH sessions do not have the pod's environment variables.** The worker image's start script writes the needed values (model key, `DISPLAY`) to a file inside the pod (`/tmp/idea/env`, 0600) and the remote command reads it. It does not go into the image.
- **Node requires `libatomic1`.** Added to the main image (minimal Debian).

## Points for the design

- **To survive disconnects**, start dsh on the worker VM side detached from the SSH session (for example `setsid`) and have main tail an output file. On reattach, find it by session ID. Add a `sessionId` argument to `worker_run` for continuation.
- **Keep logs outside the pod.** Right now both sides disappear with the pod. In stage 7 the controller records the run in Postgres or the Task resource.
- **Keeping the model key out of the worker VM** is B's advantage. Look later at whether an in-cluster model proxy gives the same effect.
- **There is no network policy for the main pod yet.** Main only needs to reach the worker VM, the model API and DNS.
- dsh's shell tool worked for the main agent in a regular pod too. To keep main from doing the task itself, consider turning off the shell and file tools in the main profile.
- `git-fixture` is removed when Forgejo arrives in stage 7.
