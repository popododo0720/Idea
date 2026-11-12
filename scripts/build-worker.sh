#!/usr/bin/env bash
# Build the worker golden image with podman, scan it for secrets, and push it
# to the local registry under a version tag.

. "$(dirname "$0")/lib.sh"
need podman

img="$REGISTRY_ADDR/idea/worker:$WORKER_IMAGE_VERSION"
log "building $img"
podman build \
  --build-arg DEBIAN_TAG="$DEBIAN_TAG" \
  --build-arg NODE_VERSION="$NODE_VERSION" \
  --build-arg NODE_SHA256="$NODE_SHA256" \
  --build-arg CHROME_VERSION="$CHROME_VERSION" \
  --build-arg CHROME_DEB_SHA256="$CHROME_DEB_SHA256" \
  -t "$img" "$REPO_ROOT/images/worker"

"$REPO_ROOT/scripts/check-image.sh" "$img"

log "pushing $img"
podman push "$img"
podman image inspect "$img" --format 'size: {{.Size}} bytes'
