# idea 1단계 구축 계획 (Claude Code 작업 지시서)

작성일 2026-11-12 (v2: Flux 리컨사일 방식으로 변경. v3: 데이터 경로 `/DATA/idea`, 호스트 점검 결과 반영). 이 파일은 Claude Code가 Ubuntu 서버에서 읽고 그대로 수행하는 문서다.
사람이 읽는 설계 원문은 `docs/design.md`에 있다(없으면 아래 요약만으로 진행한다).

## 0. 무엇을 만드는가

**idea**: 이슈를 받으면 에이전트가 격리된 작업 VM에서 코드를 고치고, PR과 관문을 거쳐 머지까지 가는 "에이전트 팩토리"를 어디든 붙일 수 있는 오픈소스로 만든다.

- 배포 단위: Talos Linux 이미지 하나. 그 위에 Cilium, Kata Containers.
- **배포 방식: Flux가 리컨사일한다.** Talos 머신 설정이 Cilium과 Flux를 심고, 그 뒤로는 Flux가 선언된 상태로 클러스터를 스스로 맞춘다. 설치 스크립트를 순서대로 돌리는 방식이 아니다.
- 작업 VM: Kata 런타임 포드(포드마다 경량 VM). Debian + XFCE + noVNC + Chrome + dsh.
- 에이전트 하네스: dsh(DeepSeek Harness)와 플러그인.
- 접속: Cilium 인그레스, 포트 443 하나, 경로로 라우팅. 이름은 `idea.internal`(HTTPS는 이 이름으로만 받는다).
- Git: 클러스터 안 Forgejo.

**이번 단계의 범위**: 단일 노드에서 "예제 이슈 하나가 PR을 거쳐 머지"되는 한 바퀴까지.

**이번 단계에서 하지 않는 것**: Kodus, Infisical, 웹 콘솔, 웜 풀(0~1개만), 다중 노드, 백업, 윈도우 VM, 업스트림 기여, Talos OS 자체의 자동 업그레이드. KubeVirt는 쓰지 않는다.

## 1. 환경과 제약

| 항목 | 값 |
| --- | --- |
| 호스트 | Ubuntu 서버, RAM 32GB |
| Talos VM | 1대, RAM 16GB, 이름 `idea-talos-1` |
| 동시에 뜨는 것 | 메인 에이전트 1 + 작업 VM 1~2 |
| 레포 | `/root/Idea` (대문자 I. 이 문서에서 "레포"는 이 경로다) |
| 원격 | `https://github.com/popododo0720/Idea` (**공개 저장소**. 커밋한 것은 전부 공개된다고 보고 4.7을 지킨다) |
| 시크릿 | `~/.idea-secrets` (레포 밖, 권한 700) |
| 데이터 | `/DATA/idea` (`IDEA_DATA_DIR`). VM 디스크, ISO, 로컬 레지스트리 저장소, 이미지 빌드 저장소는 전부 여기에 둔다. 루트 파일시스템(`/`)에 큰 파일을 두지 않는다 |

`/DATA/idea` 아래 구성:

```
/DATA/idea/
  vm/          idea-talos-1.qcow2
  iso/         Talos ISO
  registry/    로컬 레지스트리 데이터
  build/       podman/docker 빌드 저장소 (graphroot)
  notes/       레포에 넣지 않는 기록: 호스트 조회 결과, 스크린샷 (4.7)
```

`/DATA`의 다른 디렉터리와 기존 libvirt 풀은 건드리지 않는다.

메모리 예산(추정치, 단계마다 실측해서 기록한다):

| 구성 | 예상 |
| --- | --- |
| Talos + 쿠버 + Cilium·Hubble | 3GB |
| Flux (source, kustomize, helm 컨트롤러만) | 0.3GB |
| cert-manager | 0.2GB |
| Forgejo + Postgres + 컨트롤러 | 1~1.5GB |
| 메인(dsh headless) | 1GB |
| 작업 VM 1개 | 3~4GB |

## 2. 작업 규칙

1. **단계 순서를 지킨다.** 각 단계의 "검증"이 통과해야 다음으로 간다.
2. **버전은 실행 시점에 공식 문서로 확인하고 `versions.env`에 고정한다.** 이 문서의 명령은 예시다. 문서와 다르면 문서를 따르고 차이를 기록한다. `latest` 태그는 쓰지 않는다.
3. **단계가 끝날 때마다 `docs/spikes/NN-이름.md`를 쓴다.** 결과(통과/실패), 실제로 쓴 명령, 버전, 메모리 실측, 막힌 점과 해결, 설계에 반영할 점.
4. **클러스터 안의 모든 것은 선언으로 둔다.**
   - 클러스터 상태는 `deploy/`의 매니페스트가 정하고 Flux가 맞춘다. `kubectl apply`, `helm install`로 직접 설치하지 않는다.
   - 디버깅하느라 손으로 만든 리소스는 매니페스트로 옮긴 뒤 지운다. `flux suspend`를 켠 채로 단계를 끝내지 않는다.
   - 순서가 필요하면 스크립트가 아니라 Flux의 `dependsOn`과 헬스 체크로 표현한다.
   - 쿠버 리소스가 아닌 상태(Forgejo의 조직, 저장소, 웹훅, 토큰)도 한 번 돌리는 스크립트가 아니라 컨트롤러나 멱등한 Job이 맞춘다.
   - 스크립트가 허용되는 곳은 클러스터 **밖**뿐이다: 호스트에 VM 만들기, Talos 설정 생성·적용, 사람이 주는 시크릿 넣기, 배포 아티팩트 push.
5. **호스트를 건드리는 범위를 지킨다.**
   - 이름이 `idea-`로 시작하는 리소스만 만들고 지운다. 다른 VM, 네트워크, 디스크는 건드리지 않는다.
   - 호스트에 쓰는 큰 파일은 `/DATA/idea` 안에만 둔다. 그 밖의 `/DATA` 내용은 읽지도 고치지도 않는다.
   - 호스트 네트워크 설정(브리지, 방화벽, netplan)은 바꾸지 않는다. 필요하면 멈추고 묻는다.
   - 예외: 전용 libvirt NAT 네트워크 `idea-net`(브리지 `idea-br0`, 192.168.123.0/24, DNS 끔, DHCP만)을 만들고 자동 시작을 거는 것은 허용한다. 기존 `default` 네트워크와 호스트의 DNS 서버는 건드리지 않는다. (이 호스트는 DNS 서버가 새 브리지의 53번 포트를 먼저 잡아서 `default`가 뜨지 않는다. 2026-11-12 결정.)
   - 패키지 설치는 허용. 서비스 재시작이 다른 VM에 영향을 주면 멈추고 묻는다.
6. **같은 지점에서 세 번 실패하면 멈추고 보고한다.** 우회하려고 범위를 넓히지 않는다.
7. **4장의 시크릿 규칙은 다른 모든 규칙보다 우선한다.**

### 멈추고 사람에게 물어야 하는 경우

- 중첩 가상화가 꺼져 있거나 호스트 가용 메모리가 18GB 미만일 때 (`free`의 `available` 열 기준. `free` 열은 캐시를 빼지 않으므로 쓰지 않는다)
- 호스트 네트워크 변경, `idea-` 접두사가 아닌 리소스의 삭제·수정이 필요할 때
- 시크릿이 커밋, 배포 아티팩트, 이미지에 들어간 것을 발견했을 때
- 로그인(Claude, Codex 등 OAuth)이나 계정 생성, 결제가 필요할 때
- 원격 Git 저장소나 공개 레지스트리로 push 하려 할 때
- 설계와 다른 선택을 해야 할 때(예: Kata가 아닌 런타임)

## 3. 사람이 미리 해 둘 것

- [ ] Claude Code를 실행하는 계정이 `sudo`와 `libvirt` 그룹 권한을 가진다.
- [ ] `~/.idea-secrets/env`를 만들고 값을 채운다(형식은 레포의 `.env.example`).
  - `DEEPSEEK_API_KEY=` (5단계에서 필요)
- [ ] (선택) 설계 문서를 Markdown으로 내보내 `/root/Idea/docs/design.md`에 둔다. 공개돼도 되는 내용인지 먼저 확인한다.
- [ ] `~/.idea-secrets/private-strings`에 레포에 들어가면 안 되는 문자열(호스트 이름, 실제 이메일, 공인 IP 등)을 한 줄에 하나씩 적는다.
- [ ] Claude 구독 연결(5단계 후반)은 사람이 직접 로그인해야 한다. 그 지점에서 Claude Code가 멈추고 알린다.

## 4. 시크릿 규칙

**원칙: 시크릿은 레포에도, Flux가 읽는 배포 아티팩트에도 존재하지 않는다. 암호화한 형태(SOPS 등)로도 넣지 않는다.** `.gitignore`는 이중 방어일 뿐이다.

### 4.1 무엇이 시크릿인가

- Talos: `secrets.yaml`, `controlplane.yaml`, `worker.yaml`, `talosconfig` (클러스터 CA와 토큰이 들어 있다)
- `kubeconfig`
- 모델 API 키, Claude·Codex 로그인 자격 증명과 토큰
- Forgejo 관리자 비밀번호, 액세스 토큰, 웹훅 시크릿
- Postgres 비밀번호
- SSH 개인 키, TLS 개인 키

### 4.2 시크릿의 두 종류와 넣는 방법

| 종류 | 예 | 방법 |
| --- | --- | --- |
| 만들어 낼 수 있는 것 | Postgres·Forgejo 관리자 비밀번호, 웹훅 시크릿, 작업 VM SSH 키, 인그레스 TLS 키 | **클러스터 안에서 생성한다.** 없으면 만들고 있으면 그대로 두는 생성기를 매니페스트로 둔다. 사람 손도, 레포도 거치지 않는다 |
| 사람이 줘야 하는 것 | 모델 API 키, Claude·Codex 자격 증명 | `scripts/apply-secrets.sh`가 `~/.idea-secrets`에서 읽어 클러스터에 넣는다. 부트스트랩 뒤 한 번. 이 값이 없어도 나머지는 정상적으로 떠 있어야 한다 |

- 생성기는 **시크릿 생성 오퍼레이터를 먼저** 쓴다. Job으로 할 수밖에 없으면, Job은 필드가 불변이라 매니페스트를 고치면 Flux 리컨사일이 실패한다는 점을 처리한다(`kustomize.toolkit.fluxcd.io/force: enabled` 어노테이션). 다시 돌아도 기존 값을 덮어쓰지 않는지 시험한다.
- 인그레스 TLS 인증서는 cert-manager의 자체 서명 발급자(`selfSigned` ClusterIssuer)로 만든다. `deploy/infra/`에 둔다. 공인 인증서는 이번 범위 밖이다.
- 매니페스트와 Helm values는 Secret의 **이름만** 참조한다(`existingSecret`, `secretKeyRef`).
- Flux가 관리하는 경로에 `kind: Secret` 매니페스트를 두지 않는다. Flux의 prune이 사람이 넣은 Secret을 지우지 않는지 확인한다.

### 4.3 호스트에서 어디에 두는가

```
~/.idea-secrets/            # chmod 700, 파일은 600
  env                       # 사람이 채우는 값
  private-strings           # 레포에 들어가면 안 되는 문자열 목록 (4.7)
  talos/                    # secrets.yaml, controlplane.yaml, talosconfig
  kubeconfig
```

- `TALOSCONFIG`와 `KUBECONFIG` 환경변수는 이 디렉터리를 가리킨다. 레포 안이나 `~/.kube/config`에 복사하지 않는다.
- 경로는 `IDEA_SECRETS_DIR` 환경변수로 바꿀 수 있게 하고, 스크립트는 이 변수가 레포 안을 가리키면 실패한다.
- Talos 설정은 `talosctl gen secrets`로 시크릿을 먼저 만들고, `gen config --with-secrets`에 레포의 패치를 적용해 **시크릿 디렉터리에** 생성한다. 레포에는 스키매틱과 패치만 둔다.
- **컨테이너 이미지에 시크릿을 굽지 않는다.** 골든 이미지에는 키, 토큰, 로그인된 상태가 없어야 한다. Dockerfile에서 `ARG`/`ENV`로 시크릿을 넘기지 않는다.

### 4.4 `.gitignore` (첫 커밋 전에 만든다)

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

### 4.5 검사

- `gitleaks`를 설치하고 `.githooks/pre-commit`에서 스테이징된 변경을 검사한다. `git config core.hooksPath .githooks`로 건다. (명령은 설치된 버전의 `gitleaks --help`로 확인한다.)
- `scripts/check-secrets.sh`를 만든다.
  1. gitleaks로 작업 트리와 전체 히스토리를 검사한다.
  2. `deploy/` 아래에 `kind: Secret`이 있으면 실패한다.
  3. `~/.idea-secrets` 안의 실제 값이 레포 작업 트리와 히스토리에 있는지 대조한다. **값은 출력하지 않고** 파일 경로와 키 이름만 출력한다.
- 이 스크립트는 **매 단계 끝**, **배포 아티팩트 push 전**, **Git push 전**에 돌린다. 실패하면 진행하지 않는다.
- 빌드한 이미지도 검사한다(레이어 히스토리, 이미지 안의 키·토큰 파일).

### 4.6 다루는 방식

- 시크릿 파일을 `cat` 하지 않는다. 값이 필요하면 스크립트 안에서 `source` 한다. `set -x`를 켠 채로 시크릿을 다루지 않는다.
- 명령줄 인자로 시크릿을 넘기지 않는다. 파일이나 표준 입력, 환경변수로 넘긴다.
- `kubectl get secret -o yaml`의 출력을 보고서나 로그에 남기지 않는다.
- `docs/spikes/` 보고서, 커밋 메시지, 이슈 본문에 값을 적지 않는다.
- **사람이 시키기 전에는 원격으로 push 하지 않는다.** 평소엔 로컬 커밋과 호스트의 로컬 레지스트리만 쓴다. push 할 때는 직전에 `check-secrets.sh`가 통과해야 하고, 올라갈 커밋 범위(`git log origin/main..HEAD --stat`)를 사람에게 보여 준 뒤 한다. `--force` push는 하지 않는다.
- 시크릿이 새어 들어갔으면: 즉시 멈추고 보고한다. 히스토리를 고치는 것으로 끝내지 않고 그 값은 **폐기하고 새로 발급**한다. 이미 push 된 뒤라면 공개된 것으로 보고 폐기를 먼저 한다.

### 4.7 공개 저장소 규칙

원격이 공개 저장소이므로, 시크릿이 아니어도 아래는 레포에 넣지 않는다.

- **이 호스트에 대한 정보**: 다른 VM·네트워크·스토리지 풀의 이름과 목록, 호스트 이름, 공인 IP, 사내 대역, 계정 이름, `/DATA`의 다른 디렉터리 이름. 단계 0의 호스트 조회 결과는 `docs/spikes/`가 아니라 `/DATA/idea/notes/host-inventory.md`(레포 밖)에 적는다.
  - 예외: `idea-net` 대역의 주소(게이트웨이, 노드 IP), `idea-`로 시작하는 리소스 이름, `/root/Idea`와 `/DATA/idea` 경로는 적어도 된다.
- **개인 정보**: 실제 이메일 주소, 이름. 커밋 작성자 이메일은 GitHub의 noreply 주소로 레포 로컬 설정(`git config user.email`)에 건다. 전역 설정은 바꾸지 않는다.
- **날것의 출력**: 명령 출력이나 로그를 통째로 붙이지 않는다. 보고서에는 필요한 줄만 옮기고, 토큰·쿠키·인증 헤더·내부 주소가 섞여 있지 않은지 읽어 보고 넣는다.
- **스크린샷과 녹화**: 5b의 브라우저 스크린샷은 `/DATA/idea/notes/`에 두고 커밋하지 않는다. 보고서에는 결과만 글로 적는다.
- `check-secrets.sh`에 네 번째 검사를 둔다: `~/.idea-secrets/private-strings`(한 줄에 하나, 사람이 채우는 금지 문자열 목록: 호스트 이름, 이메일, 공인 IP 등)의 문자열이 작업 트리와 히스토리에 있으면 실패한다. 값은 출력하지 않고 파일 경로와 줄 번호만 출력한다.

## 5. 저장소 구성

```
deploy/                  Flux가 읽는 선언 (시크릿 없음)
  clusters/dev/          진입점: Kustomization들과 dependsOn 순서
  infra/                 Cilium, RuntimeClass, 네트워크 정책, 시크릿 생성기, cert-manager와 발급자
  platform/              Postgres, Forgejo
  apps/                  컨트롤러, 메인 에이전트, CRD
  bootstrap/             Talos가 처음 심는 것: Cilium, Flux, 루트 소스
charts/                  우리가 만드는 Helm 차트 (컨트롤러 등)
controller/              컨트롤러 (Go). CRD와 Postgres
plugins/                 idea 플러그인, 작업 VM 연결 플러그인 (TypeScript)
images/worker/           작업 VM 골든 이미지
images/talos/            schematic.yaml, patches/*.yaml
console/                 (이번 단계에서는 비워 둔다)
examples/                예제 저장소와 끝까지 도는 시험 이슈
scripts/                 vm-create.sh, vm-destroy.sh, talos-apply.sh, apply-secrets.sh, push-deploy.sh, check-secrets.sh
docs/spikes/             단계별 보고서
versions.env             모든 구성요소 버전 (시크릿 없음)
```

원칙
- `deploy/`와 `charts/`는 "Cilium과 `kata` RuntimeClass가 있는 쿠버"만 전제로 한다. Talos 전용 설정은 `images/talos/`와 `deploy/bootstrap/`에만 둔다.
- Flux 계층은 `infra → platform → apps` 순서로 `dependsOn`을 건다.

### Flux 소스

- Flux의 소스는 Git이 아니라 **OCI 아티팩트**(`OCIRepository`)로 한다. Forgejo가 클러스터 안에 있어서 Git을 소스로 삼으면 닭과 달걀 문제가 생긴다.
- 개발 중: 호스트의 로컬 레지스트리에 `flux push artifact`로 `deploy/`를 올리고, 클러스터는 그 태그를 따라간다. `scripts/push-deploy.sh`가 `check-secrets.sh` 통과 후 push 한다.
- 로컬 레지스트리는 HTTP다. `OCIRepository`에 `insecure: true`를 주고, `flux push artifact`에도 해당 버전의 평문 HTTP 옵션을 준다(옵션 이름은 `flux push artifact --help`로 확인한다).
- **배포 아티팩트는 클러스터보다 먼저 있어야 한다.** VM을 새로 만들기 전에 `push-deploy.sh`가 한 번은 돌아서 레지스트리에 태그가 있어야 Flux가 따라갈 것이 있다. `talos-apply.sh`는 그 태그가 없으면 실패한다.
- 공개 후(이번 범위 밖): 릴리스마다 공개 레지스트리에 버전 태그로 올리고, 설치된 클러스터는 버전 범위를 따라가며 스스로 업데이트된다.

## 6. 단계

### 단계 0. 호스트 점검과 도구

할 일
- CPU 가상화 플래그(`vmx`/`svm`), 중첩 가상화(`/sys/module/kvm_intel/parameters/nested` 또는 `kvm_amd`), 여유 메모리, `/DATA`의 디스크 여유(최소 150GB)를 확인한다.
- `/DATA/idea`와 하위 디렉터리를 만든다. libvirt(qemu) 사용자가 `vm/`과 `iso/`를 읽고 쓸 수 있는지 확인한다.
- 이미 있는 libvirt VM과 네트워크를 조회해 `/DATA/idea/notes/host-inventory.md`에 기록한다(건드리지 않는다. 레포에 넣지 않는다, 4.7).
- `git init` 후 `origin`을 공개 저장소로 걸고, 커밋 작성자 이메일을 GitHub noreply 주소로 레포 로컬 설정에 건다. push는 하지 않는다.
- 설치(`scripts/host-setup.sh`): `qemu-kvm`, `libvirt-daemon-system`, `virtinst`, `talosctl`, `kubectl`, `helm`, `flux` CLI, `cilium` CLI, `gitleaks`, 이미지 빌드 도구(podman 또는 docker), `jq`, `yq`.
- 호스트에 로컬 레지스트리를 띄운다. **`idea-net` 게이트웨이 IP에만 바인드**한다(0.0.0.0 금지). 작업 VM 이미지와 Flux 배포 아티팩트를 여기에 둔다. 레지스트리 데이터는 `/DATA/idea/registry`에, 이미지 빌드 저장소는 `/DATA/idea/build`에 둔다(기본 위치인 `/var/lib` 아래를 쓰지 않는다).
- 레포를 만들고 5장의 뼈대, `.gitignore`, pre-commit 훅, `check-secrets.sh`를 **첫 커밋 전에** 넣는다.

검증
- 중첩 가상화가 켜져 있다.
- 일부러 가짜 키가 든 파일을 스테이징하면 커밋이 거부된다(확인 후 파일 삭제).
- 레지스트리가 `idea-net` 게이트웨이 주소에서만 열려 있다.
- `git log --format=%ae`에 noreply 주소만 나온다. `private-strings`에 넣은 시험 문자열을 스테이징하면 커밋이 거부된다.
- 레지스트리 데이터와 빌드 저장소가 `/DATA/idea` 아래에 쌓인다(`/` 사용량이 늘지 않는다).

### 단계 1. Talos VM

할 일
- `images/talos/schematic.yaml`에 `siderolabs/kata-containers` 확장을 적고 Image Factory에 제출해 스키매틱 ID를 받는다. ID는 `versions.env`에 적는다.
- 같은 스키매틱의 `metal-amd64.iso`를 `/DATA/idea/iso/`에 내려받는다.
- 전용 NAT 네트워크 `idea-net`을 쓴다(`scripts/host-setup.sh`가 만든다). VM의 MAC을 고정하고 DHCP 예약으로 노드 IP를 고정한다. 이 네트워크는 DNS를 주지 않으므로 Talos 머신 설정에 네임서버를 적는다. 주소와 이름은 `config.env`에 둔다.
- VM 생성 예시(`scripts/vm-create.sh`):

```
virt-install --name idea-talos-1 --memory 16384 --vcpus <호스트 코어의 절반, 최소 4> \
  --cpu host-passthrough \
  --disk path=/DATA/idea/vm/idea-talos-1.qcow2,size=100,bus=virtio,format=qcow2 \
  --cdrom <ISO 경로> --boot hd,cdrom \
  --network network=idea-net,model=virtio,mac=<고정 MAC> \
  --graphics none --noautoconsole
```

- 머신 설정 패치(`images/talos/patches/base.yaml`). Talos v1.14부터 머신 설정이 문서 여러 개로 나뉘어서, 예전의 `cluster.network.cni`, `cluster.proxy`, `allowSchedulingOnControlPlanes`, `machine.install` 키는 쓰지 않는다:

```yaml
apiVersion: v1alpha1
kind: KubeFlannelCNIConfig      # 기본 CNI를 뺀다 (Cilium을 쓴다)
$patch: delete
---
apiVersion: v1alpha1
kind: KubeProxyConfig           # kube-proxy를 끈다
enabled: false
---
apiVersion: v1alpha1
kind: KubeNodeConfig            # 단일 노드: 컨트롤 플레인에 워크로드를 올린다
taints:
  node-role.kubernetes.io/control-plane:
    $patch: delete
```

- 설치 디스크와 설치 이미지는 패치가 아니라 `talosctl gen config`의 `--install-disk`, `--install-image`로 준다.
- 네임서버(`ResolverConfig`)와 로컬 레지스트리(`RegistryMirrorConfig`)는 `images/talos/patches/host.yaml.tmpl`에 두고 `config.env` 값으로 렌더한다.
- 생성과 적용(`scripts/talos-apply.sh`, 출력은 전부 시크릿 디렉터리로):

```
talosctl gen secrets -o $IDEA_SECRETS_DIR/talos/secrets.yaml
talosctl gen config idea https://<노드 IP>:6443 \
  --with-secrets $IDEA_SECRETS_DIR/talos/secrets.yaml \
  --install-disk /dev/vda \
  --install-image factory.talos.dev/metal-installer/<스키매틱 ID>:<Talos 버전> \
  --config-patch-control-plane @images/talos/patches/base.yaml \
  --config-patch @_out/talos/host.yaml \
  --output $IDEA_SECRETS_DIR/talos/
talosctl apply-config --insecure -n <노드 IP> --file $IDEA_SECRETS_DIR/talos/controlplane.yaml
talosctl bootstrap -n <노드 IP> -e <노드 IP>
talosctl kubeconfig $IDEA_SECRETS_DIR/kubeconfig -n <노드 IP> -e <노드 IP>
```

확인할 것
- 설치 이미지 경로, 레지스트리 설정, 설정 문서 형식은 Talos 버전에 따라 다르다. 해당 버전 문서와 대조한다.

검증
- `talosctl get extensions`에 kata-containers가 보인다.
- 노드 안에 `/dev/kvm`이 있다.
- `kubectl get nodes`에 노드가 보인다(CNI가 없어 NotReady인 것은 정상).

### 단계 2. 부트스트랩: Cilium과 Flux를 Talos가 심는다

목표: **Talos 설정을 적용하는 것 말고는 아무 명령도 치지 않아도** Cilium과 Flux가 뜨고, Flux가 `deploy/`를 따라가기 시작한다.

할 일
- `deploy/bootstrap/`에 처음 심을 것을 둔다.
  1. Cilium: `helm template`으로 렌더한 매니페스트. values는 아래와 같다.
  2. Flux: 설치 매니페스트(source, kustomize, helm 컨트롤러만. notification과 image automation은 뺀다). Flux Operator 방식이 더 단순하면 그쪽을 쓰고 이유를 기록한다.
  3. 루트 소스: 로컬 레지스트리의 배포 아티팩트를 가리키는 `OCIRepository`와 `deploy/clusters/dev`를 가리키는 `Kustomization`.
- 이것들을 Talos 머신 설정의 `cluster.inlineManifests` 또는 `cluster.extraManifests`로 넣는다. 설정 크기 제한에 걸리면 `extraManifests`(URL)로 한다. 이 패치는 생성물이므로 `_out/`에 만들고 커밋하지 않는다(시크릿은 없다).
- Cilium values(Talos용):

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
  hostNamespaceOnly: true     # Kata 포드에서 서비스 접속이 되려면 필요
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

- 부트스트랩 뒤에는 Flux가 Cilium도 관리한다(`deploy/infra/`).
- 인그레스를 **노드 IP의 443**으로 받는다. 순서대로 시도한다: (1) 인그레스 host network 모드, (2) LB IPAM + L2 announcement로 libvirt 대역의 IP 하나.
- `scripts/push-deploy.sh`: `check-secrets.sh` → `flux push artifact` → 리컨사일 대기.
- 시험용 nginx와 인그레스 경로 `/test/`를 `deploy/`에 넣어 push 한다.

확인할 것
- Talos가 심은 Cilium을 Flux의 HelmRelease가 넘겨받는 방법(Helm 소유 메타데이터). 깔끔하게 안 되면 Cilium은 렌더한 매니페스트를 Kustomization으로 관리한다.
- Talos의 inline/extra 매니페스트는 부트스트랩 때만 적용된다는 점. 그 뒤의 변경은 전부 Flux 쪽에서 한다.
- Cilium 문서 "Kata Containers with Cilium"의 제약(소켓 LB, MTU).
- 인그레스 host network 모드에서 Envoy가 443(1024 미만 포트)을 잡는 데 필요한 권한 설정(`NET_BIND_SERVICE` 관련 values). 해당 Cilium 버전 문서로 확인한다.

검증
- (전제: 배포 아티팩트가 레지스트리에 이미 있다.) `scripts/vm-destroy.sh` → `vm-create.sh` → `talos-apply.sh`만 실행한 뒤, **추가 명령 없이** 노드가 Ready가 되고 `flux get kustomizations`가 전부 Ready가 된다.
- 호스트에서 HTTPS로 `/test/`가 200을 준다. Cilium 인그레스는 SNI가 있어야 하므로 노드 IP가 아니라 인그레스 이름으로 접속한다: `curl -k --resolve idea.internal:443:<노드 IP> https://idea.internal/test/`. 인증서는 cert-manager가 발급한 자체 서명 인증서다(발급자 확인).
- 시험용 nginx Deployment를 `kubectl delete`로 지우면 Flux가 다시 만든다.
- `deploy/`에서 nginx를 빼고 push 하면 클러스터에서도 사라진다(prune).

### 단계 3. Kata 포드

할 일
- 확장이 등록한 containerd 핸들러 이름을 확인하고(`kata`, `kata-qemu` 등) RuntimeClass를 `deploy/infra/`에 넣는다.
- 시험 포드를 띄운다. 메모리 limit을 4Gi로 준 포드도 띄워서 게스트 VM 메모리가 limit을 따라가는지 본다. (일회성 시험 포드는 직접 만들어도 된다. 끝나면 지운다.)

검증
- 포드 안 `uname -r`이 노드 커널과 다르다.
- 포드에서 클러스터 서비스(DNS, 시험용 서비스)에 접속된다.
- limit 4Gi 포드 안에서 `free -m`이 그에 맞게 나온다.
- 포드 하나가 차지하는 호스트 쪽 메모리 오버헤드를 실측해 기록한다.

### 단계 4. 작업 VM 골든 이미지와 데스크톱

할 일
- `images/worker/`: Debian + XFCE + VNC 서버 + noVNC(websockify) + Chrome + Node.js + sshd. 비루트 사용자로 실행한다. 이미지에 시크릿 없음. 로컬 레지스트리에 버전 태그로 올린다.
- 작업 포드 템플릿과 인그레스 경로 `/vm/<이름>/`(noVNC)를 선언으로 둔다.
- 작업 포드용 Cilium 네트워크 정책(`deploy/infra/`):
  - 허용: DNS, 인터넷(공인 대역), 클러스터 안 Forgejo와 패키지 캐시.
  - 차단: 사설 대역(10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10), 노드, kube-apiserver.
- Chrome 샌드박스가 Kata 게스트 안에서 그대로 도는지 본다. 안 되면 원인과 선택지를 기록하고 멈춘다(`--no-sandbox`를 조용히 켜지 않는다).

검증
- 호스트에서 `/vm/<이름>/`이 noVNC 페이지를 돌려주고 웹소켓이 101로 연결된다.
- 포드 안에서 `curl https://example.com`은 되고, 노드 IP:6443과 libvirt 게이트웨이로의 접속은 막힌다. Hubble에 기록이 남는다.
- 유휴 상태와 Chrome 탭 3개를 연 상태의 메모리를 실측한다.
- 이미지 검사에서 시크릿이 나오지 않는다.

### 단계 5. dsh와 브라우저 조작

할 일
- 골든 이미지에 dsh를 넣는다. 설치 방법은 공식 저장소(github.com/deepseek-ai/deepseek-harness)의 README를 따른다. **패키지 이름과 명령을 추측하지 않는다.** dsh와 플러그인은 버전이나 커밋을 `versions.env`에 고정한다.
- 5a. DeepSeek API 키로 headless 프로파일을 띄운다. 키는 `apply-secrets.sh`로 넣은 Secret을 참조한다.
- 5b. 브라우저 조작 플러그인(리눅스+Chrome을 명시한 것부터)을 붙여, 데스크톱의 Chrome으로 페이지를 열고 제목을 읽고 스크린샷을 저장하게 한다.
- 5c. 리눅스 데스크톱 조작 플러그인이 XFCE에서 도는지 시험한다. 안 되면 그대로 기록한다(대안 구현은 이번 범위 밖).
- 5d. **(사람 필요)** Claude 구독 연결. 공식 Agent SDK로 로그인된 Claude Code를 구동하는 플러그인을 쓴다. Claude Code 식별 헤더를 흉내 내는 방식의 플러그인은 쓰지 않는다. 로그인은 사람이 하고, 자격 증명은 Secret으로 주입한다. 작업 포드 2개가 한 계정을 동시에 쓸 때 토큰 갱신이 충돌하는지 본다.
- dsh의 훅(도구 호출 전후 이벤트) API가 있는지 문서와 코드로 확인한다.
- 모델 키와 Claude 자격 증명은 이 서버 안(`~/.idea-secrets`, 클러스터의 Secret, 실행 중인 포드)에는 있어도 된다. 레포, 배포 아티팩트, 골든 이미지에만 들어가지 않으면 된다(4장).

검증
- 5a, 5b가 재현 가능하게 통과한다.
- 5c, 5d, 훅은 결과(됨/안 됨/조건부)가 보고서에 있다.
- API 키 Secret이 없는 상태에서도 Flux의 다른 Kustomization은 Ready다.

### 단계 6. 메인이 작업 VM에 일을 맡기는 방식

할 일
- 메인 에이전트를 dsh headless 포드로 띄운다(Kata 아님, 일반 포드). `deploy/apps/`에 선언한다.
- 두 방식을 같은 작업("예제 저장소를 클론해 테스트를 돌리고 결과를 돌려준다")으로 비교한다.
  - A. 직접 짠 SSH 플러그인(`plugins/`): 메인이 작업 포드에 SSH로 명령을 보낸다. 키는 클러스터 안에서 생성한다(4.2).
  - B. dsh-yawn의 Kubernetes 샌드박스.
- 비교 기준: Kata RuntimeClass와 데스크톱 이미지를 쓸 수 있는가, 세션이 끊겼을 때 복구, 로그를 어디서 읽는가, 우리 네트워크 정책과 맞는가, 선언형으로 둘 수 있는가.

검증
- 두 방식의 결과와 선택 이유가 보고서에 있다. 선택한 방식으로 위 작업이 통과한다.

### 단계 7. 한 바퀴

할 일
- Postgres와 Forgejo를 `deploy/platform/`에 HelmRelease로 넣는다. 비밀번호는 클러스터 안에서 생성된 Secret을 `existingSecret`으로 참조한다. Forgejo는 인그레스 경로 `/git/` 아래에서 뜨는지 확인한다(서브패스 설정).
- Forgejo 안의 상태는 컨트롤러가 맞춘다: 조직, 예제 저장소, 웹훅, 작업 VM용 토큰(그 저장소 범위로만). 선언은 CRD나 설정으로 두고, 지워지면 다시 만든다.
- `examples/`의 예제 저장소(작은 함수와 테스트)와 시험 이슈 하나("함수 X 추가, 테스트 포함")를 정의한다.
- 최소 컨트롤러(`controller/`, `deploy/apps/`로 배포):
  1. Forgejo 웹훅으로 이슈를 받는다(웹훅 시크릿 검증).
  2. Task 리소스를 만들고 Postgres에 상태를 기록한다. 같은 이슈를 두 번 잡지 않는다.
  3. 작업 포드를 띄우고 6단계에서 고른 방식으로 메인이 일을 맡긴다.
  4. 작업 VM이 브랜치와 PR을 만든다.
  5. 관문: 테스트 통과. Forgejo Actions 러너를 먼저 시도하고, 하루 안에 안 되면 컨트롤러가 깨끗한 Kata 포드에서 테스트를 다시 돌려 커밋 상태로 기록하는 방식으로 대체한 뒤 그 사실을 보고서에 적는다.
  6. 통과하면 머지하고, 이슈에 댓글로 알린다. 작업 포드를 정리한다.
- 컨트롤러는 재시작돼도 진행 중인 Task를 이어 간다. **진행 상태의 기준은 Task CRD의 status 하나다.** Postgres는 중복 방지(이슈 ID의 유일 키)와 이력 기록에만 쓰고, 둘이 어긋나면 CRD를 따른다. 메모리에만 있는 상태는 없다.
- 배포에 포함된 구성요소의 라이선스 목록을 `docs/licenses.md`에 쓴다(이름, 버전, 라이선스, 출처). `versions.env`와 항목이 일치해야 한다.
- 리뷰 관문(Kodus) 자리는 인터페이스만 비워 둔다.

검증
- 사람이 이슈를 만드는 것 말고는 손대지 않고 PR이 머지된다. 두 번 연속 성공한다.
- 일부러 실패하는 테스트를 넣은 이슈는 머지되지 않는다.
- Task 진행 중에 컨트롤러 포드를 지워도 Task가 끝까지 간다.
- Forgejo에서 웹훅을 손으로 지우면 컨트롤러가 다시 만든다.
- 전체가 떠 있을 때의 메모리 표를 실측치로 채운다.
- `docs/licenses.md`에 `versions.env`의 모든 구성요소가 있다.

## 7. 완료 기준

- [x] **빈 VM에 Talos 설정을 적용하면, 추가 명령 없이 단계 2~7의 상태로 수렴한다.** 사람이 하는 일은 `apply-secrets.sh` 한 번과 5d의 로그인뿐이다.
- [x] 클러스터 안의 리소스를 손으로 지우거나 바꿔도 선언된 상태로 돌아온다(Flux 관리 대상, Forgejo 웹훅).
- [x] `deploy/`를 바꿔 push 하면 클러스터가 따라간다. 뺀 것은 지워진다.
- [x] 예제 이슈가 두 번 연속 머지까지 간다.
- [x] `docs/spikes/00~07`이 모두 있고, 메모리 실측 표와 "설계에 반영할 점" 목록이 있다.
- [x] `scripts/check-secrets.sh`가 작업 트리, 전체 히스토리, 배포 아티팩트, 이미지에서 통과한다.
- [x] `versions.env`에 모든 구성요소의 버전이 고정돼 있다.
- [x] 배포에 포함된 구성요소의 라이선스 목록이 `docs/licenses.md`에 있다(이름, 버전, 라이선스, 출처).

위 항목은 2026-11-12에 모두 확인했다. 근거는 `docs/spikes/00~07`과 `scripts/e2e.sh`의 실행 결과다. 계획과 다르게 한 것은 각 단계 보고서의 "계획과 다르게 한 것"에 있다.

## 8. 참고 문서 (실행 시점에 해당 버전으로 확인)

- Talos Boot Assets / Image Factory: https://docs.siderolabs.com/talos/v1.13/platform-specific-installations/boot-assets.md
- Talos에 Cilium 설치: https://docs.siderolabs.com/kubernetes-guides/cni/deploying-cilium
- Cilium과 Kata: https://docs.cilium.io/en/stable/network/kubernetes/kata/
- Talos 확장 목록: https://github.com/siderolabs/extensions
- Flux 문서(OCIRepository, Kustomization, HelmRelease): https://fluxcd.io/flux/
- dsh: https://github.com/deepseek-ai/deepseek-harness
