# 단계 0. 호스트 점검과 도구

날짜: 2026-11-12
결과: **통과**

## 검증

| 항목 | 결과 |
| --- | --- |
| 중첩 가상화 | 켜짐 (`kvm_intel nested=Y`, `vmx`) |
| 가짜 키를 스테이징하면 커밋 거부 | 거부됨 (아래 "시크릿 검사 시험") |
| 레지스트리가 `idea-net` 게이트웨이에서만 열림 | `192.168.123.1:5000`만 응답. 루프백과 다른 호스트 주소에서는 연결 안 됨 |
| 커밋 이메일이 noreply | 다른 이메일로 커밋하면 거부됨 |
| `private-strings` 문자열 커밋 거부 | 거부됨 |
| 레지스트리·빌드 저장소가 `/DATA/idea` 아래 | podman graphroot `/DATA/idea/build`, 레지스트리 `/DATA/idea/registry` |

## 호스트

- Ubuntu 24.04, 커널 6.8, 48 스레드, RAM 31GB
- 가용 메모리(`free`의 available): 시작 전 25GB, 단계 종료 시 24GB
- `/DATA` 여유 567GB

기존 VM·네트워크 등 호스트 조회 결과는 레포 밖 `/DATA/idea/notes/host-inventory.md`에 있다.

## 실제로 한 것

```
scripts/host-setup.sh     # 패키지, 고정 버전 도구, idea-net, 로컬 레지스트리
scripts/check-secrets.sh  # 시크릿 검사 (전체)
```

`host-setup.sh`가 하는 일:

1. apt로 podman 설치(qemu, libvirt, virt-install은 이미 있었다).
2. podman 저장소를 `/DATA/idea/build`로 지정(`/etc/containers/storage.conf`, 새로 만든 파일).
3. `versions.env`의 버전으로 도구를 내려받아 sha256을 확인하고 `/usr/local/bin`에 설치.
4. libvirt 네트워크 `idea-net` 정의, 시작, 자동 시작.
5. 레지스트리를 systemd 서비스 `idea-registry`로 실행. `192.168.123.1:5000`에만 바인드.

## 버전

| 도구 | 버전 |
| --- | --- |
| talosctl | v1.14.6 |
| kubectl | v1.37.1 (talosctl v1.14.6의 기본 쿠버네티스 버전) |
| helm | v4.3.1 |
| flux | v2.10.0 |
| cilium CLI | v0.20.2 |
| gitleaks | v8.30.1 |
| registry (distribution) | v3.1.2 |
| podman | 4.9.3 (Ubuntu 패키지) |
| libvirt | 10.0.0 (이미 설치돼 있던 것) |

## 막힌 점과 해결

### libvirt `default` 네트워크가 뜨지 않음

- 증상: `virsh net-start default`가 `dnsmasq: failed to create listening socket for 192.168.122.1: Address already in use`로 실패.
- 원인: 호스트에서 이미 돌고 있는 DNS 서버가 새로 생기는 인터페이스마다 53번 포트를 자동으로 잡는다. libvirt의 dnsmasq보다 먼저 잡아서 dnsmasq가 죽는다.
- 해결(사람이 결정): 전용 NAT 네트워크 `idea-net`을 새로 만들고 그 dnsmasq의 DNS를 껐다(`<dns enable='no'/>`, DHCP만). `default`와 호스트 DNS 서버는 건드리지 않았다.
- 영향: 이 네트워크는 게스트에게 DNS를 주지 않는다. 단계 1에서 Talos 머신 설정에 네임서버를 직접 적는다.

### 컨테이너 엔진

- 호스트에 Docker가 있지만 저장소가 루트 파일시스템에 있다. Docker 설정을 바꾸면 기존 컨테이너에 영향이 가므로 건드리지 않고, podman을 따로 설치해 `/DATA/idea/build`를 쓰게 했다.
- 레지스트리는 컨테이너가 아니라 배포판 바이너리를 systemd로 직접 띄웠다. 컨테이너 네트워크 규칙을 호스트 방화벽에 추가하지 않기 위해서다.

## 시크릿 검사 시험

임시 시크릿 디렉터리(`/dev/shm`)를 만들어 시험했고, 시험 파일은 모두 지웠다.

| 스테이징한 것 | 결과 |
| --- | --- |
| 토큰 형식의 가짜 키 | gitleaks가 거부 |
| 시크릿 디렉터리 `env`의 값(gitleaks가 못 잡는 평범한 문장) | 값 대조 검사가 거부. 키 이름과 파일:줄만 출력 |
| `private-strings`의 문자열 | 거부 |
| `deploy/` 아래 `kind: Secret` | 거부 |
| noreply가 아닌 이메일로 커밋 | 거부 |
| `IDEA_SECRETS_DIR`가 레포 안을 가리킴 | 스크립트가 실행을 거부 |

## 설계에 반영할 점

- **호스트에 DNS 서버가 이미 있으면 libvirt 기본 네트워크가 안 뜬다.** 설치 문서에 "DNS를 끈 전용 네트워크를 만든다"를 기본 경로로 적는 편이 낫다.
- **호스트의 기존 컨테이너 엔진을 전제로 하지 않는다.** 저장소 위치를 따로 잡은 podman과 바이너리 레지스트리 조합이 기존 환경과 충돌하지 않았다.
- 버전 고정 시 Talos가 정하는 쿠버네티스 기본 버전(`talosctl gen config --help`)을 기준으로 kubectl을 맞춘다. 쿠버네티스 최신 안정판(v1.37.2)과 Talos 기본값(1.37.1)이 다를 수 있다.
- `flux push artifact`의 평문 HTTP 옵션은 `--insecure-registry`다(v2.10.0).
