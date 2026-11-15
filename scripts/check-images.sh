#!/usr/bin/env bash
# Refuse to deploy manifests that reference idea-* images nobody built.
#
#   check-images.sh [DEPLOY_DIR]
#
# Every image reference "<host>/<path>/idea-<name>:<tag>" under DEPLOY_DIR
# (default deploy/) must exist as a tag of LOCAL_REPO/idea-<name> in the
# registry push-deploy.sh pushes to. Third-party images are not checked.
# IDEA_REGISTRY_URL overrides the registry's base URL (default
# http://$REGISTRY_ADDR); tests point it at a file:// tree.

. "$(dirname "$0")/lib.sh"
need curl

dir="${1:-$REPO_ROOT/deploy}"
base="${IDEA_REGISTRY_URL:-http://$REGISTRY_ADDR}"
prefix="${LOCAL_REPO#*/}"

refs="$(grep -rnoE --include='*.yaml' --include='*.yml' '/idea-[a-z0-9-]+:[A-Za-z0-9._-]+' "$dir" || true)"

missing=0
declare -A tags_of
while IFS= read -r line; do
  [ -n "$line" ] || continue
  file="${line%%:*}"
  rest="${line#*:}"
  rest="${rest#*:}"
  ref="${rest#/}"
  name="${ref%%:*}"
  tag="${ref#*:}"
  if [ -z "${tags_of[$name]+x}" ]; then
    tags_of[$name]="$(curl -fsS "$base/v2/$prefix/$name/tags/list" 2>/dev/null | tr -d ' \n' | sed -n 's/.*"tags":\[\([^]]*\)\].*/\1/p' | tr ',' '\n' | tr -d '"' || true)"
  fi
  if ! grep -qxF -- "$tag" <<<"${tags_of[$name]}"; then
    echo "error: ${file#"$REPO_ROOT"/} references $name:$tag, which is not in $LOCAL_REPO" >&2
    build="scripts/build-${name#idea-}.sh"
    [ -f "$REPO_ROOT/$build" ] || build="the matching scripts/build-*.sh"
    echo "       build it first: $build" >&2
    missing=1
  fi
done <<<"$refs"

[ "$missing" = 0 ] || die "unbuilt images referenced under deploy/; nothing was pushed"
