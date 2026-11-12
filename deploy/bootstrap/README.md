# bootstrap

What Talos plants at first boot, as inline manifests in the machine config:

1. Cilium, rendered with `helm template` from the values in
   `../infra/controllers/cilium/helmrelease.yaml`
2. Flux controllers (`flux/gotk-components.yaml`)
3. The root source and Kustomization (`../clusters/dev/root.yaml`)

`scripts/render-bootstrap.sh` builds the machine-config patch from these into
`_out/talos/bootstrap.yaml` (not committed). Talos only creates what is
missing; after bootstrap Flux owns and reconciles all of it.
