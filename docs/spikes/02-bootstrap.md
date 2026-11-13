# Stage 2. Bootstrap: Talos seeds Cilium and Flux

Date: 2026-11-12
Result: **pass** (one deviation from the plan in how the ingress is reached, see below)

## Verification

| Item | Result |
| --- | --- |
| Node Ready and all Kustomizations Ready with only `vm-destroy.sh` → `vm-create.sh` → `talos-apply.sh` | Pass. No extra commands |
| HTTPS `/test/` returns 200 from the host | Pass. But it must be reached by **hostname** (`idea.internal`), not by node IP |
| `kubectl delete` of the test Deployment is recreated by Flux | Pass. Restored after 608 seconds (reconcile interval 10 minutes) |
| Removing nginx from `deploy/` and pushing removes it from the cluster | Pass. The namespace was deleted too |

Convergence time (HDD, no image cache):

| Point | Elapsed |
| --- | --- |
| `vm-destroy.sh` starts | 0 |
| `talos-apply.sh` ends (Kubernetes API answers) | about 4 min |
| Flux root Kustomization created | about 4 min 30 s |
| Flux has taken over Cilium and cert-manager is installed | about 7 min 30 s |
| All 6 Kustomizations Ready | under 11 min |

## Layout

Three `KubeInlineManifestConfig` documents go into the Talos machine config (`scripts/render-bootstrap.sh` writes them to `_out/talos/bootstrap.yaml`; 332KB, no secrets).

| Name | Content | Source |
| --- | --- | --- |
| `idea-cilium` | Cilium rendered with `helm template` | `.spec.values` of `deploy/infra/controllers/cilium/helmrelease.yaml` |
| `idea-flux` | The 3 Flux controllers (source, kustomize, helm) | `flux install --export` → `deploy/bootstrap/flux/gotk-components.yaml` |
| `idea-root` | `OCIRepository` and the root `Kustomization` | `deploy/clusters/dev/root.yaml` |

From there Flux takes over.

```
idea-root (./clusters/dev)
 ├─ flux-components    ./bootstrap/flux      Flux manages its own controllers
 ├─ infra-controllers  ./infra/controllers   Cilium, cert-manager (HelmRelease)
 ├─ infra-config       ./infra/config        ClusterIssuer, ingress certificate   (dependsOn infra-controllers)
 ├─ platform           ./platform            (empty)                             (dependsOn infra-config)
 └─ apps               ./apps                (empty)                             (dependsOn platform)
```

- The source is the OCI artifact `oci://192.168.123.1:5000/idea/deploy:dev` in the local registry (`insecure: true`).
- `scripts/push-deploy.sh`: `check-secrets.sh` → build check of each layer → `flux push artifact` → wait for reconcile.
- `talos-apply.sh` fails if the artifact is not in the registry.

## Versions

| Component | Version |
| --- | --- |
| Cilium | 1.20.4 |
| Flux | v2.10.0 (source-controller v1.10.1, kustomize-controller v1.10.1, helm-controller v1.7.1) |
| cert-manager | v1.21.3 |

## Measured memory

| Target | Value |
| --- | --- |
| Node memory used (Talos + Kubernetes + Cilium/Hubble + Flux + cert-manager) | about 1.9GB / 16GB |
| Host available memory | 19GB |

Less than the plan's estimate (Talos+Kubernetes+Cilium 3GB, Flux 0.3GB, cert-manager 0.2GB = 3.5GB).

## What was checked

### How the Flux HelmRelease takes over the Cilium that Talos seeded

- **No special handling was needed.** helm-controller v1.7 takes ownership of existing resources on install (the option to turn that off is `disableTakeOwnership`).
- Neither adding Helm ownership metadata to the rendered manifests nor the fallback of "manage the rendered manifests with a Kustomization" was used.
- So that the bootstrap render and the HelmRelease use **the same values**, the render script reads `.spec.values` from the HelmRelease. It fails if the chart version differs from `versions.env`.

### Keeping keys out of the bootstrap manifests

- The Cilium chart default (`hubble.tls.auto.method: helm`) creates certificates and private keys at render time and puts them in the manifests. That would put keys into the machine config patch.
- Changed to `method: cronJob` so they are created inside the cluster. The render script fails if a `Secret` with data is present.

### Nature of Talos inline manifests

- Talos **only creates resources that do not exist.** It never changes or deletes them. So there is no fight after Flux takes over.
- The whole machine config was about 383KB and applied without problems. The URL method (`KubeExternalManifestConfig`) was not used.

### Binding port 443

- For Envoy to bind a port below 1024 in host network mode, `envoy.securityContext.capabilities.keepCapNetBindService: true` and `NET_BIND_SERVICE` in the `envoy` capability list are needed (the default `NET_ADMIN`, `SYS_ADMIN` stay).
- `ingressController.loadbalancerMode: shared`, `hostNetwork.httpPort: 80`, `httpsPort: 443`.

## Deviations from the plan

### HTTPS must be reached by hostname, not by node IP

- Cilium ingress only creates an HTTPS listener when `spec.tls[].hosts` is set, and only accepts connections that send that name as SNI. `https://<node IP>/` has no SNI, so the connection is dropped. `hosts` cannot be an IP or `*`.
- So the ingress name was set to `idea.internal` (`INGRESS_HOST` in `config.env`). The certificate is issued by cert-manager's self-signed issuer and has this name and the node IP in its SANs.
- Example: `curl -k --resolve idea.internal:443:192.168.123.10 https://idea.internal/test/`
- HTTP (80) also answers on the IP.

### Flux method

- Flux Operator was not used. Seeding the install manifests of the 3 controllers directly is one component fewer, and the plain-HTTP registry setting (`insecure: true`) can be written straight into the `OCIRepository`, which was simpler.

## Blockers

- None (no point failed three times). Only the ingress TLS was settled as above.

## Points for the design

- **If path rewriting becomes necessary, Ingress will not do.** Cilium ingress cannot strip a path prefix. Stage 4's `/vm/<name>/` (noVNC) and stage 7's `/git/` (Forgejo) need either the backing service to handle the prefix itself, or a switch to Gateway API (`URLRewrite` in `HTTPRoute`). A decision is needed in stage 4.
- **Self-healing is as slow as the reconcile interval.** The interval is 10 minutes now, so a deleted resource takes up to 10 minutes to come back. If that must be faster, lower `interval` on the `apps` layer.
- **An access name is needed.** To use it in a browser, the install guide must say how to resolve `idea.internal` to the node IP (hosts file, internal DNS).
- In Cilium tunnel mode, Kata pods do not inherit the path MTU (the Kata limitation in the Cilium docs). Not visible on a single node, but it must be checked when going multi-node.
- Values that differ per environment (registry address, ingress IP) live only in `deploy/clusters/dev/`. Another environment is added as `clusters/<name>/`.
