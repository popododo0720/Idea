# Components and licenses

Written 2026-11-12, revised 2026-11-13 (preparing the public release: Chrome replaced with Chromium, Claude Agent SDK removed from the image). Versions match `versions.env`. The licenses are copied from each project's own notice and are no substitute for a legal review before distribution.

"Checked" column: `repository` = confirmed from repository metadata or the LICENSE file; `known value` = the license the project states publicly, not re-checked against a file this time.

## Deployed in the cluster

| Name | Version | License | Source | Checked |
| --- | --- | --- | --- | --- |
| Talos Linux | v1.14.6 | MPL-2.0 | github.com/siderolabs/talos | repository |
| Kubernetes | v1.37.1 | Apache-2.0 | github.com/kubernetes/kubernetes | repository |
| Kata Containers (Talos extension) | 4.3.1 | Apache-2.0 | github.com/kata-containers/kata-containers | repository |
| QEMU guest agent (Talos extension) | 11.1.1 | GPL-2.0-or-later | github.com/siderolabs/extensions (qemu-guest-agent) | repository |
| Cilium (with Hubble, Envoy) | 1.20.4 | Apache-2.0 (some eBPF code is GPL-2.0 or BSD-2-Clause) | github.com/cilium/cilium | repository |
| Flux (source, kustomize, helm controllers) | v2.10.0 | Apache-2.0 | github.com/fluxcd/flux2 | repository |
| cert-manager | v1.21.3 | Apache-2.0 | github.com/cert-manager/cert-manager | repository |
| External Secrets Operator | 2.15.0 | Apache-2.0 | github.com/external-secrets/external-secrets | repository |
| Local Path Provisioner | v0.0.37 | Apache-2.0 | github.com/rancher/local-path-provisioner | repository |
| BusyBox (provisioner helper image) | 1.38.0 | GPL-2.0 | busybox.net | known value |
| PostgreSQL | 18.6 | PostgreSQL License | postgresql.org | known value |
| Forgejo | 15.0.11 | GPL-3.0-or-later | code.forgejo.org/forgejo/forgejo | known value |
| Forgejo Helm chart | 17.3.2 | MIT | code.forgejo.org/forgejo-helm/forgejo-helm | repository |
| Forgejo Runner | 13.2.1 | GPL-3.0 | code.forgejo.org/forgejo/runner | repository |
| nginx (unprivileged image) | 1.31.7 | BSD-2-Clause (nginx), image build files Apache-2.0 | github.com/nginxinc/docker-nginx-unprivileged | repository |

## Included in the worker image

| Name | Version | License | Source | Checked |
| --- | --- | --- | --- | --- |
| Debian (base image and packages) | trixie-20261104-slim | Varies per package (DFSG free software) | debian.org | known value |
| XFCE | Debian trixie package | GPL-2.0-or-later, LGPL-2.0-or-later | xfce.org | known value |
| TigerVNC | Debian trixie package | GPL-2.0 | github.com/TigerVNC/tigervnc | repository |
| noVNC | Debian trixie package | MPL-2.0 (some files under other licenses) | github.com/novnc/noVNC | known value |
| websockify | Debian trixie package | LGPL-3.0 | github.com/novnc/websockify | repository |
| OpenSSH | Debian trixie package | BSD-style | openssh.com | known value |
| Git | Debian trixie package | GPL-2.0 | git-scm.com | known value |
| bubblewrap | Debian trixie package | LGPL-2.0-or-later | github.com/containers/bubblewrap | known value |
| Supervisor | Debian trixie package | BSD-style (Repoze) | github.com/Supervisor/supervisor | known value |
| Noto CJK, Liberation fonts | Debian trixie package | SIL OFL 1.1 | — | known value |
| Node.js | v26.13.1 | MIT (bundled components under their own licenses) | github.com/nodejs/node | known value |
| Chromium | Debian trixie package | BSD-3-Clause (bundled components under their own licenses) | chromium.org | known value |
| dsh (DeepSeek Harness) and official plugins | 0.2.2-rc.1 | MIT | github.com/deepseek-ai/deepseek-harness | repository |
| pnpm | 11.28.5 | MIT | github.com/pnpm/pnpm | repository |
| chrome-devtools-mcp (pinned by the dsh browser provider) | 1.9.0 | Apache-2.0 | github.com/ChromeDevTools/chrome-devtools-mcp | repository |
| Cua Driver (pinned by the dsh desktop provider) | 0.28.0 | MIT | github.com/trycua/cua | repository |
| Remaining npm dependencies of dsh | `images/worker/dsh/package-lock.json` | Varies per package (726 packages, not checked individually) | npm | — |

## Included in the web UI (`console/design/fonts`)

| Name | Version | License | Source | Checked |
| --- | --- | --- | --- | --- |
| Pretendard (variable, subset to KS X 1001 Hangul) | v1.3.9 | OFL-1.1 | github.com/orioncactus/pretendard | LICENSE.txt in the release |
| Geist Mono (variable) | v1.9.2 | OFL-1.1 | github.com/vercel/geist-font | OFL.txt in the release |

## What we made

| Name | License | Notes |
| --- | --- | --- |
| This repository (controller, plugins, scripts, manifests) | Not decided yet | A LICENSE file must be added before publishing |
| Controller Go dependencies: client-go, api, apimachinery v0.37.1 | Apache-2.0 | github.com/kubernetes/client-go |
| Controller Go dependency: pgx v5.13.0 | MIT | github.com/jackc/pgx |

## Tools used on the host (not part of the deliverables)

| Name | Version | License |
| --- | --- | --- |
| talosctl | v1.14.6 | MPL-2.0 |
| kubectl | v1.37.1 | Apache-2.0 |
| Helm | v4.3.1 | Apache-2.0 |
| flux CLI | v2.10.0 | Apache-2.0 |
| cilium CLI | v0.20.2 | Apache-2.0 |
| gitleaks | v8.30.1 | MIT |
| distribution (registry) | v3.1.2 | Apache-2.0 |
| podman | 4.9.3 | Apache-2.0 |
| Go toolchain image | 1.27.4 | BSD-3-Clause |

## Not included in the images

| Name | License | How it is used |
| --- | --- | --- |
| Google Chrome | Proprietary, not redistributable | Not used. The worker image uses Chromium. |
| Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | Proprietary (Anthropic commercial terms) | Not in the image. Only when the user has provided a Claude token does the worker pod fetch it directly from npm at start (`idea-claude-subagent`). |

## To sort out before distribution

- **GPL components** (Forgejo, Forgejo Runner, BusyBox, TigerVNC, Git, XFCE) are used as unmodified official binaries and images. For those that go into images we publish (Forgejo Runner, TigerVNC, Git, XFCE, BusyBox), check the source-offer obligation.
- The npm dependencies of dsh have not been checked individually. Run a license scanner over them before distribution.
- This repository has no license yet.
- The Talos install ISO and installer image are repackaged and redistributed (Talos is MPL-2.0, the Kata Containers extension is Apache-2.0). Our extension (`images/talos/setup`) contains talosctl (MPL-2.0) and BusyBox (GPL-2.0).
