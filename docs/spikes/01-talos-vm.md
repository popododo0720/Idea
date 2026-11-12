# 단계 1. Talos VM

날짜: 2026-11-12
결과: **통과**

## 검증

| 항목 | 결과 |
| --- | --- |
| `talosctl get extensions`에 kata-containers | 있음 (`kata-containers`, `schematic`) |
| 노드 안에 `/dev/kvm` | 있음 (`/dev/kvm`, `/dev/vhost-net`, `/dev/vhost-vsock`) |
| `kubectl get nodes`에 노드 | `idea-talos-1`, NotReady (CNI 없음, 정상) |

부가 확인:

- 디스크에 설치됨(system disk `vda`), 머신 단계 `running`.
- 호스트 이름은 DHCP 예약의 이름(`idea-talos-1`)을 받았다.
- 네임서버 1.1.1.1, 8.8.8.8 적용됨.
- 로컬 레지스트리 미러 설정이 containerd에 들어갔다(`http://192.168.123.1:5000`).
- 컨트롤 플레인 테인트가 없다(남은 것은 `not-ready`뿐).

## 실제로 한 것

```
scripts/vm-create.sh     # 스키매틱 ID 확인, ISO 내려받기, VM 생성
scripts/talos-apply.sh   # 시크릿·머신 설정 생성(시크릿 디렉터리), 적용, 부트스트랩, kubeconfig
scripts/vm-destroy.sh    # VM과 디스크 삭제 (시크릿은 남긴다. --wipe-secrets로 함께 삭제)
```

- VM: 16GB, 24 vCPU(호스트 스레드의 절반), 100GB qcow2(`/DATA/idea/vm`), `--cpu host-passthrough`, 네트워크 `idea-net`, MAC 고정.
- ISO와 설치 이미지 모두 같은 스키매틱 ID로 Image Factory에서 받는다.
- 머신 설정, `talosconfig`, `kubeconfig`는 `~/.idea-secrets`에만 있다. 렌더한 호스트 패치(`_out/talos/host.yaml`)에는 시크릿이 없고 커밋하지 않는다.

## 버전

| 구성 | 버전 |
| --- | --- |
| Talos | v1.14.6 (커널 6.18.63, containerd 2.3.7) |
| Kubernetes | v1.37.1 |
| kata-containers 확장 | 4.3.1 |
| 스키매틱 ID | `3da7f440f279…` (`versions.env`) |

## 메모리 실측

| 대상 | 값 |
| --- | --- |
| Talos + 쿠버 컨트롤 플레인 (CNI 전) | 노드 안 사용 약 0.86GB / 16GB |
| 호스트 가용 메모리 | 22GB (VM 생성 전 24GB) |

## 막힌 점과 해결

### Talos v1.14의 머신 설정 형식이 계획서 예시와 다름

- 계획서의 패치(`cluster.network.cni.name: none`, `cluster.proxy.disabled`, `allowSchedulingOnControlPlanes`, `machine.install`)는 v1.13까지의 형식이다. v1.14는 설정이 종류별 문서로 나뉜다.
- 바꾼 것:
  - CNI 없음 → `KubeFlannelCNIConfig`에 `$patch: delete`
  - kube-proxy 끔 → `KubeProxyConfig`의 `enabled: false`
  - 컨트롤 플레인에 워크로드 → `KubeNodeConfig`의 테인트에 `$patch: delete`
  - 설치 디스크·이미지 → `talosctl gen config --install-disk --install-image` (결과는 `UnattendedInstallConfig`)
  - 네임서버 → `ResolverConfig`, 레지스트리 → `RegistryMirrorConfig`
- 계획서 단계 1의 예시를 이 형식으로 고쳤다.

### 테인트 삭제 패치는 컨트롤 플레인 전용으로 줘야 함

- `--config-patch`는 워커 설정에도 적용되는데, 워커에는 지울 테인트가 없어서 `lookup failed`로 생성이 실패한다.
- `--config-patch-control-plane`으로 바꿨다.

### 스크립트의 `pipefail` 함정

- `virsh ... | grep -q ...`는 grep이 먼저 끝나면 앞 명령이 SIGPIPE로 죽어서, `pipefail`에서는 "찾았는데 실패"가 된다.
- 같은 형태가 `check-secrets.sh`에도 있었다. 그대로였다면 큰 변경에서 시크릿을 **놓칠 수** 있었다. `grep -c >/dev/null`과 변수 캡처로 바꿨다.

## 설계에 반영할 점

- **Talos 마이너 버전이 바뀌면 머신 설정 형식이 바뀐다.** 패치는 버전별로 관리하고, `talosctl validate`를 생성 직후에 돌린다(스크립트에 넣었다).
- 호스트 이름은 DHCP 예약으로 주면 Talos 설정에 넣지 않아도 된다.
- 설정을 적용하면 재부팅 없이 설치와 기동이 이어진다("Applied configuration without a reboot"). 적용부터 쿠버 API 응답까지 2분 안쪽이었다(HDD 기준).
- Talos 시크릿을 VM 재생성과 분리해 두면(`vm-destroy.sh`가 남긴다) 다시 만들어도 `talosconfig`와 클러스터 CA가 유지된다.
