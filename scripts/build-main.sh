#!/usr/bin/env bash
# Build the main agent image, scan it for secrets, and push it to the local
# registry under a version tag.

. "$(dirname "$0")/lib.sh"
need podman

img="$LOCAL_REPO/idea-main:$MAIN_IMAGE_VERSION"
log "building $img"
podman build \
  --label "org.opencontainers.image.source=$SOURCE_URL" \
  --build-arg DEBIAN_TAG="$DEBIAN_TAG" \
  --build-arg NODE_VERSION="$NODE_VERSION" \
  --build-arg NODE_SHA256="$NODE_SHA256" \
  -f "$REPO_ROOT/images/main/Dockerfile" \
  -t "$img" "$REPO_ROOT"

"$REPO_ROOT/scripts/check-image.sh" "$img"

log "pushing $img"
podman push "$img"
podman image inspect "$img" --format 'size: {{.Size}} bytes'
