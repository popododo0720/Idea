# Stage 3. Kata pods

Date: 2026-11-12
Result: **pass**

## Verification

| Item | Result |
| --- | --- |
| `uname -r` in the pod differs from the node kernel | Pod `6.18.56`, node `6.18.63-talos` |
| Cluster services reachable from the pod | Cluster DNS resolves, the API server answers (401) on its ClusterIP, a service port in another namespace is open |
| Internet reachable from the pod | `https://example.com` received |
| `free -m` in a pod with limit 4Gi | Total 6079MB = default 2048MB + limit 4096MB. The container cgroup cap is exactly 4Gi |
| Measured host-side overhead of one pod | Table below |

## What was actually done

- Checked the containerd handlers the extension registers on the node (`/etc/cri/conf.d/`).

| Handler | Hypervisor | Config file |
| --- | --- | --- |
| `kata` | Cloud Hypervisor | `configuration.toml` |
| `kata-qemu` | QEMU (q35) | `configuration-qemu.toml` |

- Put the `RuntimeClass` `kata` (handler `kata`) in `deploy/infra/config/runtimeclass.yaml` and deployed it with Flux.
- Test pods were created by hand in the `idea-probe` namespace and the whole namespace was deleted afterwards. The `kata-qemu` RuntimeClass briefly created for comparison was deleted too.

## Versions

| Component | Version |
| --- | --- |
| kata-containers extension | 4.3.1 |
| Guest kernel | 6.18.56 |
| Test image | `docker.io/library/alpine:3.24.4` |

## Measured memory

The guest default for both handlers is 2048MB memory and 1 vCPU. A limit is added on top (limit 4Gi, CPU 2 → guest 6GB, 3 vCPUs).

Memory one idle pod takes on the node (outside the guest):

| Process | `kata` (Cloud Hypervisor) | `kata-qemu` |
| --- | --- | --- |
| VMM (guest 2GB) | 179MB | not measured |
| VMM (guest 6GB) | 242MB | 360MB |
| shim | 34MB | similar |
| virtiofsd | about 10MB | similar |
| **Total** | **about 225–290MB** | about 400MB |

- With 2 Kata pods and 1 regular pod running, node available memory dropped by 475MB.
- Start time (image cached): Cloud Hypervisor 7 s, QEMU 9 s.
- Guest memory is not preallocated. Node memory grows with what the guest actually uses, so the idle measurement is a lower bound.

## What was checked

- **Cilium and Kata work together as is.** With `socketLB.hostNamespaceOnly: true` in place, ClusterIP access from Kata pods worked.
- The MTU of `eth0` in the pod is 1500. No problem on a single node (in multi-node tunnel mode the MTU limitation in the Cilium docs must be checked).
- There is no `/dev/kvm` inside the guest (no further virtualization inside the guest).

## Blockers

- None.

## Points for the design

- **The default runtime is `kata` (Cloud Hypervisor).** Its idle overhead is lower than QEMU and it starts slightly faster. If the desktop image (stage 4) has problems, `kata-qemu` is the alternative.
- **Worker VM memory must be computed as "default 2GB + limit".** To meet the plan's "one worker VM 3–4GB", the container limit must be around 2Gi so the guest ends up at 4GB.
  - The annotation to change the 2GB default per pod (`default_memory`) is not on the allow list in this extension's containerd configuration (allowed: `enable_iommu`, `kernel_params`, `kernel_verity_params`).
- **Guest memory is not counted in the pod cgroup.** Because the VMM runs outside the pod cgroup (`sandbox_cgroup_only = false`), the pod usage Kubernetes sees is only a few MB. The scheduler only looks at requests, so worker pod requests must be set close to the real guest size or the node overflows.
- Measured values (memory 300Mi, CPU 250m) were put in `overhead.podFixed` of the `RuntimeClass`.
- This calculation is used when the controller decides how many worker pods to run at once: on a 16GB node, after about 2GB for the platform, 3 worker VMs with 4GB guests is the limit.
