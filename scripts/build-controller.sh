#!/usr/bin/env bash
# Build the controller image, scan it for secrets, push it to the local registry.
#   build-controller.sh --tidy   only refresh controller/go.sum (go mod tidy in a container)

. "$(dirname "$0")/lib.sh"
need podman

if [ "${1:-}" = "--tidy" ]; then
  log "go mod tidy"
  podman run --rm -v "$REPO_ROOT/controller:/src:Z" -w /src \
    -e GOFLAGS=-mod=mod "$GO_IMAGE" go mod tidy
  exit 0
fi

img="$REGISTRY_ADDR/idea/controller:$CONTROLLER_IMAGE_VERSION"
log "building $img"
podman build \
  --build-arg GO_IMAGE="$GO_IMAGE" \
  --build-arg DEBIAN_TAG="$DEBIAN_TAG" \
  -f "$REPO_ROOT/controller/Dockerfile" \
  -t "$img" "$REPO_ROOT"

"$REPO_ROOT/scripts/check-image.sh" "$img"

log "pushing $img"
podman push "$img"
podman image inspect "$img" --format 'size: {{.Size}} bytes'
