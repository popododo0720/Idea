# 단계 3. Kata 포드

날짜: 2026-11-12
결과: **통과**

## 검증

| 항목 | 결과 |
| --- | --- |
| 포드 안 `uname -r`이 노드 커널과 다르다 | 포드 `6.18.56`, 노드 `6.18.63-talos` |
| 포드에서 클러스터 서비스에 접속 | 클러스터 DNS 조회 됨, ClusterIP로 API 서버 응답(401) 받음, 다른 네임스페이스 서비스 포트 열림 |
| 포드에서 인터넷 접속 | `https://example.com` 받음 |
| limit 4Gi 포드의 `free -m` | 전체 6079MB = 기본 2048MB + limit 4096MB. 컨테이너 cgroup 상한은 정확히 4Gi |
| 포드 하나의 호스트 쪽 오버헤드 실측 | 아래 표 |

## 실제로 한 것

- 확장이 등록한 containerd 핸들러를 노드에서 확인했다(`/etc/cri/conf.d/`).

| 핸들러 | 하이퍼바이저 | 설정 파일 |
| --- | --- | --- |
| `kata` | Cloud Hypervisor | `configuration.toml` |
| `kata-qemu` | QEMU (q35) | `configuration-qemu.toml` |

- `RuntimeClass` `kata`(핸들러 `kata`)를 `deploy/infra/config/runtimeclass.yaml`에 넣고 Flux로 배포했다.
- 시험 포드는 `idea-probe` 네임스페이스에 손으로 만들었고 끝난 뒤 네임스페이스째 지웠다. 비교용으로 잠깐 만든 `kata-qemu` RuntimeClass도 지웠다.

## 버전

| 구성 | 버전 |
| --- | --- |
| kata-containers 확장 | 4.3.1 |
| 게스트 커널 | 6.18.56 |
| 시험 이미지 | `docker.io/library/alpine:3.24.4` |

## 메모리 실측

게스트 기본값은 두 핸들러 모두 메모리 2048MB, vCPU 1개다. limit을 주면 그만큼 더해진다(limit 4Gi, CPU 2 → 게스트 6GB, vCPU 3).

유휴 포드 하나가 노드에서 차지하는 메모리(게스트 밖):

| 프로세스 | `kata` (Cloud Hypervisor) | `kata-qemu` |
| --- | --- | --- |
| VMM (게스트 2GB) | 179MB | 재지 않음 |
| VMM (게스트 6GB) | 242MB | 360MB |
| shim | 34MB | 비슷 |
| virtiofsd | 약 10MB | 비슷 |
| **합계** | **약 225~290MB** | 약 400MB |

- Kata 포드 2개와 일반 포드 1개를 띄웠을 때 노드 가용 메모리는 475MB 줄었다.
- 시작 시간(이미지가 캐시된 상태): Cloud Hypervisor 7초, QEMU 9초.
- 게스트 메모리는 미리 잡지 않는다. 게스트가 실제로 쓴 만큼 노드 메모리가 늘어나므로, 유휴 실측은 하한이다.

## 확인한 것

- **Cilium과 Kata 조합이 그대로 동작한다.** `socketLB.hostNamespaceOnly: true`가 들어가 있어서 Kata 포드에서 ClusterIP 접속이 됐다.
- 포드 안 `eth0`의 MTU는 1500이다. 단일 노드라 문제는 없었다(다중 노드 터널 모드에서는 Cilium 문서의 MTU 제약을 확인해야 한다).
- 게스트 안에는 `/dev/kvm`이 없다(게스트에서 또 가상화를 쓸 수는 없다).

## 막힌 점

- 없음.

## 설계에 반영할 점

- **기본 런타임은 `kata`(Cloud Hypervisor)로 한다.** 유휴 오버헤드가 QEMU보다 작고 시작도 조금 빠르다. 데스크톱 이미지(단계 4)에서 문제가 생기면 `kata-qemu`가 대안이다.
- **작업 VM 메모리는 "기본 2GB + limit"으로 계산해야 한다.** 계획의 "작업 VM 1개 3~4GB"를 맞추려면 컨테이너 limit을 2Gi 근처로 줘야 게스트가 4GB가 된다.
  - 기본 2GB를 포드별로 바꾸는 어노테이션(`default_memory`)은 이 확장의 containerd 설정에서 허용 목록에 없다(허용: `enable_iommu`, `kernel_params`, `kernel_verity_params`).
- **게스트 메모리는 포드 cgroup에 잡히지 않는다.** VMM이 포드 cgroup 밖에서 돌기 때문에(`sandbox_cgroup_only = false`), 쿠버네티스가 보는 포드 사용량은 수 MB뿐이다. 스케줄러는 requests만 보므로 작업 포드의 requests를 실제 게스트 크기에 가깝게 줘야 노드가 넘치지 않는다.
- `RuntimeClass`의 `overhead.podFixed`에 실측치(메모리 300Mi, CPU 250m)를 넣었다.
- 컨트롤러가 동시에 띄우는 작업 포드 수를 정할 때 이 계산을 쓴다: 16GB 노드에서 플랫폼 약 2GB를 빼면, 게스트 4GB짜리 작업 VM은 3개까지가 한계다.
