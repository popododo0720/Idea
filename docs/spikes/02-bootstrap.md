# 단계 2. 부트스트랩: Cilium과 Flux를 Talos가 심는다

날짜: 2026-11-12
결과: **통과** (인그레스 접속 방식에 계획과 다른 점 1건, 아래 참고)

## 검증

| 항목 | 결과 |
| --- | --- |
| `vm-destroy.sh` → `vm-create.sh` → `talos-apply.sh`만으로 노드 Ready, Kustomization 전부 Ready | 통과. 추가 명령 없음 |
| 호스트에서 HTTPS로 `/test/`가 200 | 통과. 단, 노드 IP가 아니라 **호스트 이름**(`idea.internal`)으로 접속해야 한다 |
| 시험용 Deployment를 `kubectl delete` 하면 Flux가 다시 만든다 | 통과. 608초 뒤 복구(리컨사일 주기 10분) |
| `deploy/`에서 nginx를 빼고 push 하면 클러스터에서도 사라진다 | 통과. 네임스페이스까지 삭제됨 |

수렴 시간(HDD, 이미지 캐시 없음):

| 시점 | 경과 |
| --- | --- |
| `vm-destroy.sh` 시작 | 0 |
| `talos-apply.sh` 종료(쿠버 API 응답) | 약 4분 |
| Flux 루트 Kustomization 생성 | 약 4분 30초 |
| Flux가 Cilium을 넘겨받고 cert-manager 설치 완료 | 약 7분 30초 |
| Kustomization 6개 모두 Ready | 11분 이내 |

## 구성

Talos 머신 설정에 `KubeInlineManifestConfig` 문서 3개를 넣는다(`scripts/render-bootstrap.sh`가 `_out/talos/bootstrap.yaml`로 만든다. 332KB, 시크릿 없음).

| 이름 | 내용 | 출처 |
| --- | --- | --- |
| `idea-cilium` | `helm template`으로 렌더한 Cilium | `deploy/infra/controllers/cilium/helmrelease.yaml`의 `.spec.values` |
| `idea-flux` | Flux 컨트롤러 3개(source, kustomize, helm) | `flux install --export` → `deploy/bootstrap/flux/gotk-components.yaml` |
| `idea-root` | `OCIRepository`와 루트 `Kustomization` | `deploy/clusters/dev/root.yaml` |

그 뒤는 Flux가 맞춘다.

```
idea-root (./clusters/dev)
 ├─ flux-components    ./bootstrap/flux      Flux가 자기 컨트롤러를 관리
 ├─ infra-controllers  ./infra/controllers   Cilium, cert-manager (HelmRelease)
 ├─ infra-config       ./infra/config        ClusterIssuer, 인그레스 인증서   (dependsOn infra-controllers)
 ├─ platform           ./platform            (비어 있음)                     (dependsOn infra-config)
 └─ apps               ./apps                (비어 있음)                     (dependsOn platform)
```

- 소스는 로컬 레지스트리의 OCI 아티팩트 `oci://192.168.123.1:5000/idea/deploy:dev`(`insecure: true`).
- `scripts/push-deploy.sh`: `check-secrets.sh` → 각 계층 빌드 확인 → `flux push artifact` → 리컨사일 대기.
- `talos-apply.sh`는 레지스트리에 아티팩트가 없으면 실패한다.

## 버전

| 구성 | 버전 |
| --- | --- |
| Cilium | 1.20.4 |
| Flux | v2.10.0 (source-controller v1.10.1, kustomize-controller v1.10.1, helm-controller v1.7.1) |
| cert-manager | v1.21.3 |

## 메모리 실측

| 대상 | 값 |
| --- | --- |
| 노드 사용 메모리 (Talos + 쿠버 + Cilium·Hubble + Flux + cert-manager) | 약 1.9GB / 16GB |
| 호스트 가용 메모리 | 19GB |

계획의 추정(Talos+쿠버+Cilium 3GB, Flux 0.3GB, cert-manager 0.2GB = 3.5GB)보다 적다.

## 확인한 것

### Talos가 심은 Cilium을 Flux HelmRelease가 넘겨받는 방법

- **별도 처리가 필요 없었다.** helm-controller v1.7은 설치할 때 이미 있는 리소스의 소유권을 가져간다(끄는 옵션이 `disableTakeOwnership`).
- 렌더한 매니페스트에 Helm 소유 메타데이터를 넣는 작업도, "렌더한 매니페스트를 Kustomization으로 관리"하는 대안도 쓰지 않았다.
- 부트스트랩 렌더와 HelmRelease가 **같은 values**를 쓰도록, 렌더 스크립트가 HelmRelease의 `.spec.values`를 읽는다. 차트 버전이 `versions.env`와 다르면 실패한다.

### 부트스트랩 매니페스트에 키가 들어가지 않게

- Cilium 차트의 기본값(`hubble.tls.auto.method: helm`)은 렌더 시점에 인증서와 개인 키를 만들어 매니페스트에 넣는다. 그러면 머신 설정 패치에 키가 들어간다.
- `method: cronJob`으로 바꿔 클러스터 안에서 만들게 했다. 렌더 스크립트는 데이터가 든 `Secret`이 있으면 실패한다.

### Talos 인라인 매니페스트의 성질

- Talos는 **없는 리소스만 만든다.** 바꾸거나 지우지 않는다. 그래서 Flux가 넘겨받은 뒤 서로 싸우지 않는다.
- 머신 설정 전체 크기는 약 383KB였고 적용에 문제 없었다. URL 방식(`KubeExternalManifestConfig`)은 쓰지 않았다.

### 443 포트 바인드

- host network 모드에서 Envoy가 1024 미만 포트를 잡으려면 `envoy.securityContext.capabilities.keepCapNetBindService: true`와 `envoy` 권한 목록에 `NET_BIND_SERVICE` 추가가 필요하다(기본 목록 `NET_ADMIN`, `SYS_ADMIN`은 유지).
- `ingressController.loadbalancerMode: shared`, `hostNetwork.httpPort: 80`, `httpsPort: 443`.

## 계획과 다른 점

### HTTPS는 노드 IP가 아니라 호스트 이름으로 접속해야 한다

- Cilium 인그레스는 `spec.tls[].hosts`가 있어야 HTTPS 리스너를 만들고, 그 이름을 SNI로 보낸 연결만 받는다. `https://<노드 IP>/`는 SNI가 없어서 연결이 끊긴다. `hosts`에 IP나 `*`는 쓸 수 없다.
- 그래서 인그레스 이름을 `idea.internal`로 정했다(`config.env`의 `INGRESS_HOST`). 인증서는 cert-manager의 자체 서명 발급자가 만들고 SAN에 이 이름과 노드 IP가 들어 있다.
- 접속 예: `curl -k --resolve idea.internal:443:192.168.123.10 https://idea.internal/test/`
- HTTP(80)는 IP로도 응답한다.

### Flux 방식

- Flux Operator는 쓰지 않았다. 컨트롤러 3개의 설치 매니페스트를 그대로 심는 쪽이 구성요소가 하나 적고, 평문 HTTP 레지스트리(`insecure: true`) 설정을 `OCIRepository`에 직접 적을 수 있어서 단순했다.

## 막힌 점

- 없음(세 번 실패한 지점 없음). 인그레스 TLS만 위 방식으로 정리했다.

## 설계에 반영할 점

- **경로 재작성이 필요해지면 Ingress로는 안 된다.** Cilium 인그레스는 경로 접두사를 떼어 주는 기능이 없다. 단계 4의 `/vm/<이름>/`(noVNC)와 단계 7의 `/git/`(Forgejo)은 뒤쪽 서비스가 접두사를 직접 처리하거나, Gateway API(`HTTPRoute`의 `URLRewrite`)로 바꿔야 한다. 단계 4에서 결정이 필요하다.
- **자가 복구는 리컨사일 주기만큼 늦다.** 지금 주기는 10분이라 지운 리소스가 돌아오는 데 최대 10분 걸린다. 더 빨라야 하면 `apps` 계층의 `interval`을 줄인다.
- **접속 이름이 필요하다.** 브라우저로 쓰려면 `idea.internal`을 노드 IP로 풀어 줄 방법(hosts 파일, 내부 DNS)이 설치 안내에 있어야 한다.
- Cilium 터널 모드에서 Kata 포드는 경로 MTU를 물려받지 못한다(Cilium 문서의 Kata 제약). 단일 노드에서는 드러나지 않지만 다중 노드로 갈 때 확인해야 한다.
- 환경마다 다른 값(레지스트리 주소, 인그레스 IP)은 `deploy/clusters/dev/`에만 두었다. 다른 환경은 `clusters/<이름>/`을 추가하면 된다.
