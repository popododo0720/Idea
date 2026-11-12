# 구성요소와 라이선스

작성일 2026-11-12. 버전은 `versions.env`와 같다. 라이선스는 각 프로젝트 저장소의 표기를 옮긴 것이고, 배포 전에 법적 검토를 대신하지 않는다.

"확인" 열: `저장소` = 저장소 메타데이터나 LICENSE 파일에서 확인, `알려진 값` = 프로젝트가 공개적으로 밝힌 라이선스를 적었고 이번에 파일로 다시 확인하지는 않음.

## 클러스터에 배포되는 것

| 이름 | 버전 | 라이선스 | 출처 | 확인 |
| --- | --- | --- | --- | --- |
| Talos Linux | v1.14.6 | MPL-2.0 | github.com/siderolabs/talos | 저장소 |
| Kubernetes | v1.37.1 | Apache-2.0 | github.com/kubernetes/kubernetes | 저장소 |
| Kata Containers (Talos 확장) | 4.3.1 | Apache-2.0 | github.com/kata-containers/kata-containers | 저장소 |
| Cilium (Hubble, Envoy 포함) | 1.20.4 | Apache-2.0 (일부 eBPF 코드는 GPL-2.0 또는 BSD-2-Clause) | github.com/cilium/cilium | 저장소 |
| Flux (source·kustomize·helm 컨트롤러) | v2.10.0 | Apache-2.0 | github.com/fluxcd/flux2 | 저장소 |
| cert-manager | v1.21.3 | Apache-2.0 | github.com/cert-manager/cert-manager | 저장소 |
| External Secrets Operator | 2.15.0 | Apache-2.0 | github.com/external-secrets/external-secrets | 저장소 |
| Local Path Provisioner | v0.0.37 | Apache-2.0 | github.com/rancher/local-path-provisioner | 저장소 |
| BusyBox (프로비저너 도우미 이미지) | 1.38.0 | GPL-2.0 | busybox.net | 알려진 값 |
| PostgreSQL | 18.6 | PostgreSQL License | postgresql.org | 알려진 값 |
| Forgejo | 15.0.11 | GPL-3.0-or-later | code.forgejo.org/forgejo/forgejo | 알려진 값 |
| Forgejo Helm 차트 | 17.3.2 | MIT | code.forgejo.org/forgejo-helm/forgejo-helm | 저장소 |
| Forgejo Runner | 13.2.1 | GPL-3.0 | code.forgejo.org/forgejo/runner | 저장소 |
| nginx (unprivileged 이미지) | 1.31.7 | BSD-2-Clause (nginx), 이미지 빌드 파일은 Apache-2.0 | github.com/nginxinc/docker-nginx-unprivileged | 저장소 |

## 작업 이미지와 메인 이미지에 들어가는 것

| 이름 | 버전 | 라이선스 | 출처 | 확인 |
| --- | --- | --- | --- | --- |
| Debian (기반 이미지와 패키지) | trixie-20261104-slim | 패키지별로 다름(DFSG 자유 소프트웨어) | debian.org | 알려진 값 |
| XFCE | Debian trixie 패키지 | GPL-2.0-or-later, LGPL-2.0-or-later | xfce.org | 알려진 값 |
| TigerVNC | Debian trixie 패키지 | GPL-2.0 | github.com/TigerVNC/tigervnc | 저장소 |
| noVNC | Debian trixie 패키지 | MPL-2.0 (일부 파일은 다른 라이선스) | github.com/novnc/noVNC | 알려진 값 |
| websockify | Debian trixie 패키지 | LGPL-3.0 | github.com/novnc/websockify | 저장소 |
| OpenSSH | Debian trixie 패키지 | BSD 계열 | openssh.com | 알려진 값 |
| Git | Debian trixie 패키지 | GPL-2.0 | git-scm.com | 알려진 값 |
| bubblewrap | Debian trixie 패키지 | LGPL-2.0-or-later | github.com/containers/bubblewrap | 알려진 값 |
| Supervisor | Debian trixie 패키지 | BSD 계열(Repoze) | github.com/Supervisor/supervisor | 알려진 값 |
| Noto CJK, Liberation 글꼴 | Debian trixie 패키지 | SIL OFL 1.1 | — | 알려진 값 |
| Node.js | v26.13.1 | MIT (묶인 구성요소는 각자 라이선스) | github.com/nodejs/node | 알려진 값 |
| **Google Chrome** | 157.0.8103.78 | **독점 (Google Chrome 서비스 약관). 재배포 불가** | google.com/chrome | 알려진 값 |
| dsh (DeepSeek Harness)와 공식 플러그인 | 0.2.2-rc.1 | MIT | github.com/deepseek-ai/deepseek-harness | 저장소 |
| pnpm | 11.28.5 | MIT | github.com/pnpm/pnpm | 저장소 |
| chrome-devtools-mcp (dsh 브라우저 제공자가 고정) | 1.9.0 | Apache-2.0 | github.com/ChromeDevTools/chrome-devtools-mcp | 저장소 |
| Cua Driver (dsh 데스크톱 제공자가 고정) | 0.28.0 | MIT | github.com/trycua/cua | 저장소 |
| **Claude Agent SDK** (dsh Claude Code 서브에이전트가 고정) | 0.3.263 | **독점 (Anthropic 상용 약관)** | npm `@anthropic-ai/claude-agent-sdk` | 알려진 값 |
| dsh의 나머지 npm 의존성 | `images/worker/dsh/package-lock.json` | 패키지별로 다름(726개, 개별 확인 안 함) | npm | — |

## 우리가 만든 것

| 이름 | 라이선스 | 비고 |
| --- | --- | --- |
| 이 저장소(컨트롤러, 플러그인, 스크립트, 매니페스트) | 아직 정하지 않음 | 공개 전에 LICENSE 파일을 추가해야 한다 |
| 컨트롤러의 Go 의존성: client-go, api, apimachinery v0.37.1 | Apache-2.0 | github.com/kubernetes/client-go |
| 컨트롤러의 Go 의존성: pgx v5.13.0 | MIT | github.com/jackc/pgx |

## 호스트에서 쓰는 도구 (배포물에 들어가지 않음)

| 이름 | 버전 | 라이선스 |
| --- | --- | --- |
| talosctl | v1.14.6 | MPL-2.0 |
| kubectl | v1.37.1 | Apache-2.0 |
| Helm | v4.3.1 | Apache-2.0 |
| flux CLI | v2.10.0 | Apache-2.0 |
| cilium CLI | v0.20.2 | Apache-2.0 |
| gitleaks | v8.30.1 | MIT |
| distribution (레지스트리) | v3.1.2 | Apache-2.0 |
| podman | 4.9.3 | Apache-2.0 |
| Go 툴체인 이미지 | 1.27.4 | BSD-3-Clause |

## 배포 전에 정리해야 할 것

- **Google Chrome**은 재배포할 수 없다. 작업 이미지를 공개 레지스트리에 올리려면 Chromium으로 바꾸거나 사용자가 직접 빌드하게 해야 한다.
- **Claude Agent SDK**는 Anthropic 상용 약관을 따른다. 이미지에 포함해 공개 배포해도 되는지 확인이 필요하고, 안 되면 선택 설치로 뺀다.
- **GPL 구성요소**(Forgejo, Forgejo Runner, BusyBox, TigerVNC, Git, XFCE)는 수정 없이 공식 바이너리·이미지를 그대로 쓴다. 이미지를 배포할 때는 소스 제공 의무를 확인한다.
- dsh의 npm 의존성 726개는 개별 라이선스를 확인하지 않았다. 배포 전에 라이선스 스캐너로 훑는다.
- 이 저장소의 라이선스가 아직 없다.
