#!/usr/bin/env bash
# Build the worker golden image with podman, scan it for secrets, and push it
# to the local registry under a version tag.

. "$(dirname "$0")/lib.sh"
need podman

img="$LOCAL_REPO/idea-worker:$WORKER_IMAGE_VERSION"
log "building $img"
podman build \
  --label "org.opencontainers.image.source=$SOURCE_URL" \
  --build-arg DEBIAN_TAG="$DEBIAN_TAG" \
  --build-arg NODE_VERSION="$NODE_VERSION" \
  --build-arg NODE_SHA256="$NODE_SHA256" \
  --build-arg DSH_VERSION="$DSH_VERSION" \
  --build-arg FORGEJO_RUNNER_VERSION="$FORGEJO_RUNNER_VERSION" \
  --build-arg FORGEJO_RUNNER_SHA256="$FORGEJO_RUNNER_SHA256" \
  -f "$REPO_ROOT/images/worker/Dockerfile" \
  -t "$img" "$REPO_ROOT"

"$REPO_ROOT/scripts/check-image.sh" "$img"

log "pushing $img"
podman push "$img"
podman image inspect "$img" --format 'size: {{.Size}} bytes'
