# 단계 4. 작업 VM 골든 이미지와 데스크톱

날짜: 2026-11-12
결과: **통과**

## 검증

| 항목 | 결과 |
| --- | --- |
| 호스트에서 `/vm/<이름>/`이 noVNC 페이지를 돌려준다 | `https://idea.internal/vm/w1/` 200, `vnc.html` 200 |
| 웹소켓이 101로 연결된다 | `/vm/w1/websockify`에서 `101 Switching Protocols`, 이어서 VNC 인사말 `RFB 003.008` 수신 |
| 포드 안에서 `curl https://example.com`이 된다 | 200 |
| 노드 IP:6443 접속이 막힌다 | 시간 초과(차단) |
| 호스트 게이트웨이 접속이 막힌다 | 시간 초과(차단) |
| Hubble에 기록이 남는다 | `Policy denied DROPPED`, `EGRESS DENIED` 기록 확인 |
| 유휴·Chrome 탭 3개 메모리 실측 | 아래 표 |
| 이미지 검사에서 시크릿이 나오지 않는다 | `check-image.sh` 통과 |

추가로 막힌 것을 확인한 대상: `kubernetes.default` 서비스, 다른 네임스페이스의 포드, `169.254.169.254`.

## 구성

### 이미지 (`images/worker/`)

- Debian trixie-slim + XFCE + TigerVNC(Xvnc) + noVNC(websockify) + Google Chrome + Node.js + sshd.
- 비루트 사용자 `idea`(uid 1000)로 전부 실행한다. 프로세스 관리는 supervisord.
- 이미지에 넣지 않는 것: SSH 호스트 키(컨테이너 시작 때 생성), `authorized_keys`(Secret으로 마운트 예정), 로그인 상태.
- `IDEA_PATH_PREFIX`(예: `/vm/w1`)를 주면 noVNC를 그 경로 아래에서 서비스한다. **경로를 고쳐 쓰지 못하는 인그레스에서도 그대로 동작한다.**
- 빌드: `scripts/build-worker.sh`(podman 빌드 → `check-image.sh` → 로컬 레지스트리 push). 크기 1.58GB.

### 작업 포드 (`deploy/apps/worker-test/`)

- 시험용 작업 포드 `w1`: `runtimeClassName: kata`, 네임스페이스 `idea-work`(Pod Security `restricted`).
- 권한: 비루트, `allowPrivilegeEscalation: false`, capability 전부 제거, 서비스 어카운트 토큰 마운트 안 함.
- 자원: 메모리 limit 2Gi → 게스트 VM 4GB(Kata 기본 2GB + 2Gi). `/dev/shm`은 메모리 기반 1Gi.
- 인그레스 경로 `/vm/w1/` → 서비스 `w1:6080`.

### 네트워크 정책 (`deploy/infra/config/worker-network-policy.yaml`)

`idea.dev/role=worker` 라벨이 붙은 모든 포드에 적용되는 `CiliumClusterwideNetworkPolicy`.

| 방향 | 허용 |
| --- | --- |
| 들어오는 것 | 인그레스 → 6080 |
| 나가는 것 | 클러스터 DNS, 공인 대역(사설 10/8·172.16/12·192.168/16, 169.254/16, 100.64/10 제외) |

Forgejo, 패키지 캐시, 메인 에이전트의 SSH는 그것들이 생기는 단계에서 추가한다.

## 버전

| 구성 | 버전 |
| --- | --- |
| 작업 이미지 | 0.1.1 |
| Debian | trixie-20261104-slim |
| Google Chrome | 157.0.8103.78 (deb의 sha256 고정) |
| Node.js | v26.13.1 (sha256 고정) |

## 메모리 실측

게스트 4GB(limit 2Gi) 기준.

| 상태 | 게스트 안 사용량 | 노드 쪽 VMM 상주 메모리 |
| --- | --- | --- |
| 유휴(XFCE 데스크톱만) | 276MB | 510MB |
| Chrome 탭 3개 | 601MB | 1.3GB |

- 노드 전체 사용량은 유휴 때 약 2.06GB, 탭 3개 때 약 2.07GB로 표시되지만, VMM 메모리는 공유 메모리로 잡혀 이 숫자에 다 들어가지 않는다. 노드 가용 메모리는 13.0GB → 12.2GB로 줄었다.
- 호스트 가용 메모리: 16GB.
- 계획의 "작업 VM 1개 3~4GB"는 상한으로는 맞고, 가벼운 작업에서는 1~1.5GB 수준이다.

## Chrome 샌드박스

**`--no-sandbox` 없이 그대로 동작한다.**

- Kata 게스트 안에서 비특권 사용자 네임스페이스를 만들 수 있어서(`unshare -U` 성공) Chrome이 네임스페이스 샌드박스를 쓴다.
- 확인: Chrome 프로세스 15개 중 9개가 seccomp 필터 모드(2)이고 별도 사용자·PID 네임스페이스에 있다. `--no-sandbox` 플래그를 가진 프로세스는 없다.
- 포드는 Pod Security `restricted` 그대로다(setuid 샌드박스나 추가 권한이 필요 없다).
- 로그에 `Failed to adjust OOM score of renderer`가 남지만 동작에는 영향이 없다.

## 막힌 점과 해결

### 데스크톱 세션이 뜨다 말았다

- 증상: `xfce4-session`만 있고 창 관리자와 패널이 없다. 로그에 `unable to connect to D-Bus`.
- 원인: `dbus-launch --exit-with-session`은 터미널이 없으면 곧바로 버스를 끝낸다.
- 해결: `dbus-run-session -- startxfce4`로 바꿨다(이미지 0.1.1).

### 이미지 검사 오탐

- npm이 들고 있는 빈 `.npmrc`, 문서·소스에 적힌 `BEGIN PRIVATE KEY` 문자열이 잡혔다. 검사를 "자격 증명이 든 `.npmrc`"와 "본문이 있는 키"로 좁혔다.
- GnuTLS 라이브러리에 내장된 자체 시험용 키가 잡혔다. 모든 Debian 패키지에 똑같이 들어 있는 값이라 사유를 적어 허용 목록(`images/worker/private-key-allowlist`)에 넣었다.
- 0.1.0 이미지는 검사 실패 상태에서 내 명령 실수로 레지스트리에 올라갔다(검사 결과를 `tail`로 넘겨 종료 코드가 가려졌다). 잡힌 것이 위 오탐뿐이어서 유출은 없었다. `build-worker.sh` 안에서는 검사 실패 시 push 하지 않는다.

## 설계에 반영할 점

- **경로 재작성 없이 된다.** 작업 이미지가 접두사를 직접 처리하므로 Cilium Ingress로 충분했다. Gateway API로 바꿀 이유가 이 단계에서는 없다(Forgejo는 단계 7에서 다시 확인).
- **VNC에 인증이 없다.** 지금은 인그레스에 닿을 수 있는 누구나 `/vm/<이름>/`으로 데스크톱을 본다. NAT 안이라 개발에는 괜찮지만, 공개 전에 인그레스 앞단 인증이 필요하다.
- **포드의 seccomp 프로파일은 Kata 게스트 안에 적용되지 않는다**(게스트 안 프로세스의 Seccomp가 0). 격리는 VM 경계가 맡는다. Chrome 샌드박스가 되는 것도 이 때문이다.
- **Google Chrome은 재배포할 수 없는 라이선스다.** 지금은 로컬 레지스트리에만 둔다. 이미지를 공개 배포하려면 Chromium으로 바꾸거나 사용자가 직접 빌드하게 해야 한다.
- Chrome의 고정 버전 deb는 구글 저장소에서 시간이 지나면 사라진다. 다시 빌드할 수 있게 하려면 deb를 로컬에 보관하거나 Chrome for Testing(버전별 영구 주소)을 검토한다.
- `/etc/machine-id`가 이미지에 고정돼 있어 모든 작업 포드가 같은 값을 쓴다. 시크릿은 아니지만 포드별로 달라야 하면 시작 때 만들도록 바꾼다.
- 이미지를 처음 받는 데 53초 걸렸다(1.58GB, HDD). 웜 풀이 없으면 첫 작업 시작이 그만큼 늦다.
