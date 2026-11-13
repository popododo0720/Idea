# Stage 7. Full loop

Date: 2026-11-12
Result: **pass**

## Verification

| Item | Result |
| --- | --- |
| A PR is merged with no human action other than creating the issue. Twice in a row | Pass. Issue #1 (multiply function) → PR #2 merged, issue #3 (divide function) → PR #4 merged. About 2 min 20 s and 2 min 8 s each |
| An issue with a deliberately failing test is not merged | Pass. Issue #5 → PR #6 opened, test status `failure`, **not merged**, comment on the issue, `main` unchanged |
| Deleting the controller pod mid-Task still lets the Task finish | Pass. The pod was deleted in the `Working` phase; the new pod took over and PR #8 merged |
| Deleting the webhook by hand in Forgejo gets it recreated by the controller | Pass. Recreated within 20 seconds of deletion |
| Memory table with everything running | Below |
| Every component of `versions.env` in `docs/licenses.md` | Written |
| Converges again from an empty VM (completion criterion) | Pass. `scripts/e2e.sh`: 1,760 seconds from VM deletion to PR merge. The only human action was one run of `apply-secrets.sh` |

## Flow

```
Owner: writes an issue
  │  webhook (HMAC-SHA256 signature verified)
  ▼
Controller ── creates a Task (one per issue: fixed name + Postgres unique key)
  │ Pending ─▶ WorkerStarting   create the worker VM (Kata pod)
  │         ─▶ Working          start the main agent Job → delegate to the worker VM with worker_run
  │                             worker VM: clone → branch → implement and test → push → PR
  │         ─▶ Gate             wait for the PR's test result (Forgejo Actions, Kata runner)
  │         ─▶ Done             pass: merge, comment on the issue, clean up the worker VM
  └         ─▶ Failed           fail: no merge, comment on the issue, clean up the worker VM
```

## Layout

### Platform (`deploy/platform/`, namespace `idea-system`)

- **PostgreSQL 18.6**: one StatefulSet from the official image. Separate databases and roles per consumer (`forgejo`, `idea`).
- **Forgejo 15.0.11**: the official Helm chart (HelmRelease). SSH off, sign-up off, Actions on.
- **Path `/git/`**: Forgejo does not handle a URL prefix itself and Cilium Ingress cannot rewrite paths. A small nginx (`forgejo-subpath`) that strips the prefix sits in front. Pods inside the cluster connect directly to `http://forgejo-http:3000/`.
- **Persistent volumes**: Local Path Provisioner. The VM's second disk (`/dev/vdb`) is set up as a Talos user volume and the provisioner uses it.
- **Passwords**: the 3 Postgres passwords, the Forgejo admin password and the webhook secret are all created once inside the cluster by the External Secrets Operator `Password` generator.

### Controller (`controller/`, Go)

- 3 goroutines: reconcile Forgejo state (30 s), scan open issues (60 s, in case a webhook was missed), advance Tasks (5 s).
- **Keeps the state inside Forgejo as declared**: organization `idea`, repository `hello-calc` (filled from `examples/hello-calc` if empty), the worker account `idea-worker` and its token, the webhook, the Actions runner registration token. Recreated if deleted.
- **Scope of the worker token**: a separate non-admin account `idea-worker` was created and added only as a collaborator (write) on that repository. Forgejo tokens cannot be narrowed to a repository, so the account itself only has access to that repository.
- **The single source of truth for a Task is the `status` of the Task resource.** Postgres only holds the "one per issue" guarantee (`tasks` unique key) and history (`task_events`). There is no in-memory-only state.
- Each phase recomputes what to do from "what is in the cluster now", so it can be repeated any number of times or die halfway.
- Completion is judged by facts, not by what the agent says: does the PR really exist, is the commit status `success`.

### Test gate: Forgejo Actions

- **Forgejo Actions worked.** The fallback (the controller running the tests itself) was not used. The code is kept and can be enabled with `GATE_MODE=controller` (not tried).
- The runner (`deploy/apps/runner/`) is a **Kata pod** in the work namespace. PR tests are untrusted code, so it gets the same network policy as the worker VM.
- Execution mode is the host executor (runs directly inside the runner pod). No Docker needed.
- The workflow (`examples/hello-calc/.forgejo/workflows/test.yml`) clones the repository directly from its in-cluster address, because the runner cannot reach Forgejo's public address (`https://idea.internal/git/`).

## Versions

| Component | Version |
| --- | --- |
| Controller image | 0.1.0 (Go 1.27.4, client-go v0.37.1, pgx v5.13.0) |
| Worker image | 0.5.0 (`idea-pr`, Forgejo Runner added) |
| Main image | 0.1.2 |
| PostgreSQL | 18.6 |
| Forgejo / chart | 15.0.11 / 17.3.2 |
| Forgejo Runner | 13.2.1 |
| Local Path Provisioner | v0.0.37 |
| nginx-unprivileged | 1.31.7 |

## Measured memory (everything running)

With worker pod `w1` (idle) and the runner up, and no Task running.

| Component | Plan estimate | Measured |
| --- | --- | --- |
| Talos + Kubernetes + Cilium/Hubble (`kube-system` pods) | 3GB | 1.1GB (+ Talos itself about 0.5GB) |
| Flux | 0.3GB | 0.13GB |
| cert-manager | 0.2GB | 0.07GB |
| External Secrets Operator | (not in the plan) | 0.13GB |
| Forgejo + Postgres + controller + main + proxy (`idea-system`) | 1–1.5GB (+ main 1GB) | 0.26GB |
| 1 worker VM (idle, 4GB guest cap) | 3–4GB | VMM 0.51GB |
| Actions runner (Kata, 3GB guest cap) | (not in the plan) | VMM 0.36GB |
| **Total node usage** | | **about 3.6GB / 16GB** (11.5GB available) |
| Host available memory | | 12GB |

- While a Task runs, one worker VM (agent + tests, a few hundred MB to 1.5GB) and the main Job (about 0.3GB) are added.
- The plan's estimates were generous overall. In the current setting (1 concurrent Task) a 16GB node has plenty of headroom.

## Timing

| Segment | Time |
| --- | --- |
| Issue created → Task created | 1–6 s |
| Worker VM ready | about 15 s (image cached) |
| Agent work (clone, implement, test, push, PR) | about 1 min 40 s – 2 min |
| Test gate → merge | about 10–15 s |
| **Issue → merge total** | **about 2 min 10 s – 2 min 25 s** |
| Empty VM → everything converged | about 27 min (HDD, about 5GB of images pulled fresh) |

## Problems and fixes

- **Forgejo does not accept the `/git/` prefix** (404). Fixed with the nginx proxy above.
- **The Forgejo pod tripped over Pod Security `restricted`.** Security contexts were given through chart values.
- **Name clash**: our Ingress had the same name as the Ingress the Helm release created, so a release upgrade deleted ours. Renamed.
- **Flux health checks hold things up for a long time**: a layer with `wait: true` applies the next revision only after the health check of the previous revision (up to 15 minutes) finishes. Push a bad revision and the fix waits that long too.
- **etcd timeout during rebuild**: while large images were being pulled the disk fell behind and an etcd write timed out once; the Flux root layer's status stayed "in progress" until the next interval (10 minutes). The actual resources were up and it recovered on its own. About 10 of the 27 minutes of convergence time is this wait.
- **There were no persistent volumes.** A single-node Talos has no StorageClass, so a second disk + user volume + Local Path Provisioner were added.

## Deviations from the plan

- **Postgres is a StatefulSet manifest, not a HelmRelease.** The widely used chart changed its image distribution policy, so using the official image directly has fewer dependencies. Forgejo is a HelmRelease as planned.
- **No Helm chart for the controller (`charts/`) was made.** The manifests sit in `deploy/apps/controller/` as is.
- **Forgejo state is declared in controller settings (environment variables), not a CRD**: one organization name and one repository name. With several repositories this must become a CRD or a config file.
- **Postgres, Forgejo, the controller and main are in one namespace (`idea-system`)**, to avoid machinery for moving generated passwords between namespaces. The trust boundaries are `idea-system` (trusted) and `idea-work` (untrusted).
- **The worker token is "a token of an account that only has access to that repository", not a "repository-scoped token"** (see above).

## Rules kept and broken during operation

- Everything in the cluster is a declaration in `deploy/` reconciled by Flux. Hand-made resources were test-only and deleted.
- **One violation**: while checking the Forgejo API, the admin password was passed once as a command-line argument (`kubectl exec … env FJ_PASS=…`). This breaks 4.6, "do not pass secrets as command-line arguments". The value was visible in this host's process list for a few seconds only and never entered the repository, logs or images; the VM was rebuilt afterwards, so that password is no longer in use. Since then `scripts/forgejo-api.sh`, which passes it on standard input, was made and used.

## Points for the design

- **The review gate (Kodus) slot**: the `Gate` phase only checks "is the commit status `success`". If a review tool adds one more commit status, it becomes a gate without a code change (Forgejo's combined status is `success` only when every status passes). This interface is enough.
- **The main agent's role is thin.** Right now main only "calls worker_run once and summarizes". The controller delegating directly over SSH would give the same result. Main earns its place when it splits tasks or coordinates several worker VMs.
- **Failed Tasks are not retried.** The issue stays open and the Task is `Failed`. A retry method (comment command, Task deletion) must be decided.
- **The worker VM is deleted when the Task ends.** To look at a failure cause, the session record must be moved somewhere before deletion. Right now only the phase history is in Postgres.
- **The runner re-registers on every restart.** Over time dead runner entries pile up in Forgejo. The runner is also a host executor, so files can remain between runs (not a fully clean environment). Consider switching to ephemeral runners.
- **The workflow file contains an in-cluster address.** That cannot be asked of users' repositories. Either let the runner reach Forgejo on its public address (allow via ingress + trust the certificate), or add a setting that rewrites the checkout action's address.
- **Changing the webhook secret leaves existing webhooks on the old secret.** The controller compares only the address. If the secret changes, the webhook must be deleted and recreated.
- **With etcd and image storage on the same HDD, etcd falls behind when large images are pulled.** Probably not an issue on SSD, but shrinking the worker image (2.7GB) or pre-pulling it is better.
- **`wait` and long timeouts on Flux layers** delay recovery from a bad revision. Consider lowering the timeouts of `platform` and `apps`.
- The model key is still inside the worker VM (same note as stage 6).
