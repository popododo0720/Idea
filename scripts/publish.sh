#!/usr/bin/env bash
# Publish a release: what the public ISO downloads while it installs, and the
# ISO itself.
#
#   publish.sh --list    show exactly what would be published; nothing leaves
#                        this host
#   publish.sh           publish it
#
# Published:
#   $IMAGE_REPO/idea-worker, idea-main, idea-controller   container images
#   $IMAGE_REPO/idea-installer                            Talos installer with our extensions
#   $IMAGE_REPO/idea-deploy:<version> and :stable         the deploy/ tree (Flux OCI artifact)
#   GitHub release v<version>                             the ISO
#
# Before anything is sent: the repository check, an image scan of every image,
# and the git tree must be clean and pushed (the artifact names its commit).
# Needs a GitHub login that may write packages:
#   gh auth refresh -s write:packages
# A package pushed for the first time is private; make it public once on
# github.com (package settings), or the ISO cannot pull it.

. "$(dirname "$0")/lib.sh"
need podman flux gh git sha256sum

LIST=0
case "${1:-}" in
  "") ;;
  --list) LIST=1 ;;
  *) die "usage: $0 [--list]" ;;
esac

cd "$REPO_ROOT"
installer_tag="$TALOS_VERSION-setup$TALOS_SETUP_VERSION"
images=(
  "idea-worker:$WORKER_IMAGE_VERSION"
  "idea-main:$MAIN_IMAGE_VERSION"
  "idea-controller:$CONTROLLER_IMAGE_VERSION"
  "idea-installer:$installer_tag"
)
iso="$IDEA_DATA_DIR/iso/idea-$IDEA_VERSION-amd64.iso"
rev="$(git rev-parse --abbrev-ref HEAD)@sha1:$(git rev-parse HEAD)"

# ---- what is about to leave
echo "release v$IDEA_VERSION  (commit $(git rev-parse --short HEAD))"
echo
echo "container images -> $IMAGE_REPO"
for i in "${images[@]}"; do
  podman image exists "$LOCAL_REPO/$i" || die "$LOCAL_REPO/$i is not built"
  printf '  %-42s %6s MB  %s\n' "$i" \
    "$(( $(podman image inspect "$LOCAL_REPO/$i" --format '{{.Size}}') / 1000000 ))" \
    "$(podman image inspect "$LOCAL_REPO/$i" --format '{{.Id}}' | cut -c1-12)"
done
echo
echo "deploy artifact  -> $IMAGE_REPO/idea-deploy:$IDEA_VERSION and :stable"
echo "  deploy/ at $rev ($(git ls-files deploy | wc -l) files)"
echo
echo "ISO              -> GitHub release v$IDEA_VERSION of ${SOURCE_URL#https://github.com/}"
[ -s "$iso" ] || die "$iso is not built (scripts/build-iso.sh)"
printf '  %s  %s MB\n  sha256 %s\n' "$(basename "$iso")" \
  "$(( $(stat -c %s "$iso") / 1000000 ))" "$(sha256sum "$iso" | cut -d' ' -f1)"
echo

# ---- gates
if [ -n "$(git status --porcelain)" ]; then
  [ "$LIST" = 1 ] && echo "note: the git tree has uncommitted changes" || die "the git tree has uncommitted changes"
fi
git fetch -q origin
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main 2>/dev/null)" ]; then
  [ "$LIST" = 1 ] && echo "note: HEAD is not on origin/main yet; push the commits before publishing" \
    || die "HEAD is not what origin/main has: push the commits first"
fi
"$REPO_ROOT/scripts/check-secrets.sh"
for i in "${images[@]:0:3}"; do
  "$REPO_ROOT/scripts/check-image.sh" "$LOCAL_REPO/$i" >/dev/null || die "image scan failed: $i"
  echo "ok:   image scan $i"
done
# The installer and the ISO carry our setup extension: it must hold no secrets
# (an ISO built with --embed-secrets has another file name and is never sent).
"$REPO_ROOT/scripts/check-image.sh" "$LOCAL_REPO/idea-talos-setup:$installer_tag" >/dev/null \
  || die "image scan failed: idea-talos-setup"
echo "ok:   image scan idea-talos-setup:$installer_tag"
case "$(basename "$iso")" in *secrets*|*dev*) die "refusing to publish a development ISO" ;; esac

[ "$LIST" = 0 ] || { echo; echo "nothing was published (--list)"; exit 0; }

# ---- publish
owner="${IMAGE_REPO#ghcr.io/}"
auth="$IDEA_SECRETS_DIR/docker"
install -d -m 700 "$auth"
gh auth status 2>&1 | grep -q "write:packages" \
  || die "the GitHub login may not write packages: run  gh auth refresh -s write:packages"
gh auth token | podman login ghcr.io -u "$owner" --password-stdin --authfile "$auth/config.json" >/dev/null
chmod 600 "$auth/config.json"

for i in "${images[@]}"; do
  log "pushing $IMAGE_REPO/$i"
  podman push -q --authfile "$auth/config.json" "$LOCAL_REPO/$i" "docker://$IMAGE_REPO/$i"
done

log "pushing the deploy artifact"
DOCKER_CONFIG="$auth" flux push artifact "oci://$IMAGE_REPO/idea-deploy:$IDEA_VERSION" \
  --path "$REPO_ROOT/deploy" --source "$SOURCE_URL" --revision "$rev" >/dev/null
DOCKER_CONFIG="$auth" flux tag artifact "oci://$IMAGE_REPO/idea-deploy:$IDEA_VERSION" --tag stable >/dev/null

log "creating GitHub release v$IDEA_VERSION"
sha256sum "$iso" | sed "s#  .*#  $(basename "$iso")#" > "$iso.sha256"
gh release create "v$IDEA_VERSION" "$iso" "$iso.sha256" \
  --repo "${SOURCE_URL#https://github.com/}" --title "idea $IDEA_VERSION" \
  --notes "Installer ISO. Booting a machine from it erases its first disk and installs idea on it."

# ---- can a machine without a login pull it?
echo
for i in "${images[@]}"; do
  if podman manifest inspect "docker://$IMAGE_REPO/$i" --authfile /dev/null >/dev/null 2>&1; then
    echo "ok:   $IMAGE_REPO/$i is public"
  else
    echo "TODO: $IMAGE_REPO/$i is not public yet (github.com -> Packages -> ${i%%:*} -> Package settings -> Change visibility)"
  fi
done
log "published v$IDEA_VERSION"
