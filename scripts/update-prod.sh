#!/usr/bin/env bash
#
# Update a deploy host to the newest release tag, then drop the images it no
# longer needs. Runs ON the host, in its clone of this repo, with only git and
# docker — no Bun, which is why this is bash and not a package.json script.
#
#   scripts/update-prod.sh            fetch, show the newest tag, ask, deploy
#   scripts/update-prod.sh <tag>      deploy that tag instead (rollback included)
#   scripts/update-prod.sh -y [<tag>] skip the confirmation
#
# What it does, in order:
#   1. `git fetch --tags`, pick the highest `v*-letta_*` tag, and refuse a tag
#      that is not on origin/main (releases tag the merge commit there).
#   2. Show what changes (merges since the running tag) and ask.
#   3. Check out the tag detached — the checkout decides the release, because
#      compose.yml's LETTA_IMAGE_TAG default IS the tag — and `compose pull`.
#      A failed pull (publish run missing) puts the old checkout back.
#   4. `compose up -d --wait`, unscoped: app-server is never recreated alone,
#      since its network namespace holds bff and channel-gateway.
#   5. Remove old tags of the images this stack uses, keeping the ones it runs
#      now and the ones it ran before (the rollback set), then dangling layers.
#
# An app-server recreate (new LETTA_CODE_VERSION or compose config) kills every
# in-flight turn with no drain, including cron and Telegram turns the UI never
# shows. bff alone drains — up to SHUTDOWN_DRAIN_TIMEOUT_SECONDS — so `up` can
# sit for minutes while a turn finishes. That is the drain working.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/docker/.env"
COMPOSE=(docker compose -f "$ROOT/docker/compose.yml")

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
env_value() { [ -f "$ENV_FILE" ] && sed -nE "s/^$1=(.*)$/\1/p" "$ENV_FILE" | tail -1; }

YES=0
TAG=""
for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=1 ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) fail "unknown option: $arg" ;;
    *) TAG="$arg" ;;
  esac
done

cd "$ROOT"

# ── Preconditions ────────────────────────────────────────────────────────────
# docker/.env and secrets are gitignored, so a dirty tracked tree means someone
# hand-edited the checkout — a checkout would carry or clobber that.
git diff --quiet && git diff --cached --quiet \
  || fail "the checkout has local changes to tracked files — resolve them first"

[ -n "${LETTA_IMAGE_NS:-$(env_value LETTA_IMAGE_NS)}" ] \
  || warn "LETTA_IMAGE_NS is unset: nothing will be pulled and Compose builds every image from source."
[ -z "$(env_value LETTA_IMAGE_TAG)" ] \
  || fail "docker/.env sets LETTA_IMAGE_TAG — it outranks the checkout and pins the old release. Remove it."
[ -z "$(env_value LETTA_CODE_VERSION)" ] \
  || fail "docker/.env sets LETTA_CODE_VERSION — it outranks compose.yml's pin. Remove it."

# ── 1. Fetch and pick the tag ────────────────────────────────────────────────
say "Fetching origin"
git fetch --quiet --tags origin

CURRENT="$(git describe --tags --exact-match HEAD 2>/dev/null || git rev-parse --short HEAD)"
PREV_REF="$(git rev-parse HEAD)"
LATEST="$(git tag -l 'v*-letta_*' --sort=-v:refname | sed -n 1p)"
TAG="${TAG:-$LATEST}"
[ -n "$TAG" ] || fail "no v*-letta_* release tag found"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || fail "no such tag: $TAG"
git merge-base --is-ancestor "$TAG^{commit}" origin/main \
  || fail "$TAG is not on origin/main — a release tags a merge commit there"

printf '  running: %s\n  target:  %s%s\n' "$CURRENT" "$TAG" \
  "$([ "$TAG" = "$LATEST" ] || printf '   (newest is %s)' "$LATEST")"

if [ "$(git rev-parse "$TAG^{commit}")" = "$PREV_REF" ]; then
  say "Already at $TAG — nothing to deploy."
  exit 0
fi

# ── 2. Show and confirm ──────────────────────────────────────────────────────
if git merge-base --is-ancestor HEAD "$TAG^{commit}"; then
  say "Merged since $CURRENT"
  git --no-pager log --merges --max-count=30 --format='  %s' "HEAD..$TAG"
else
  warn "$TAG is not ahead of $CURRENT — this is a rollback."
fi
if ! git diff --quiet "HEAD" "$TAG" -- docker/compose.yml; then
  warn "docker/compose.yml changes: app-server may be recreated, killing in-flight turns (crons, Telegram included)."
fi

if [ "$YES" != 1 ]; then
  printf '\nDeploy %s? [y/N] ' "$TAG"
  read -r answer
  [[ "$answer" =~ ^[Yy] ]] || fail "aborted"
fi

# What runs now is the rollback set the cleanup keeps.
mapfile -t OLD_IMAGES < <("${COMPOSE[@]}" ps -a --format '{{.Image}}' 2>/dev/null | sort -u)

# ── 3. Check out and pull ────────────────────────────────────────────────────
say "Checking out $TAG"
git -c advice.detachedHead=false checkout --quiet --detach "$TAG"

say "Pulling images"
# Every lettuce service keeps `build:` as a fallback, so --ignore-buildable
# would skip exactly the images that matter. Without a namespace our names
# cannot be pulled at all; tolerate that and let `up` build them.
PULL=(pull)
[ -n "${LETTA_IMAGE_NS:-$(env_value LETTA_IMAGE_NS)}" ] || PULL+=(--ignore-pull-failures)
if ! "${COMPOSE[@]}" "${PULL[@]}"; then
  warn "pull failed — putting $CURRENT back; nothing was restarted"
  git -c advice.detachedHead=false checkout --quiet --detach "$PREV_REF"
  exit 1
fi

# ── 4. Up ────────────────────────────────────────────────────────────────────
say "Starting the stack (bff drains in-flight turns first; this can take minutes)"
"${COMPOSE[@]}" up -d --wait --wait-timeout 900
"${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'

# ── 5. Clean up ──────────────────────────────────────────────────────────────
say "Removing old images"
mapfile -t NEW_IMAGES < <("${COMPOSE[@]}" config --images | sort -u)
declare -A KEEP=() REPOS=()
for img in "${NEW_IMAGES[@]}" "${OLD_IMAGES[@]}"; do
  KEEP["$img"]=1
  REPOS["${img%:*}"]=1
done

removed=0
while read -r ref; do
  repo="${ref%:*}"
  [ -n "${REPOS[$repo]:-}" ] && [ -z "${KEEP[$ref]:-}" ] || continue
  # No -f: an image some container still uses stays, and that is correct.
  if docker image rm "$ref" >/dev/null 2>&1; then
    printf '  removed %s\n' "$ref"
    removed=$((removed + 1))
  fi
done < <(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -v ':<none>$')
docker image prune -f >/dev/null
printf '  %d tagged image(s) removed, dangling layers pruned\n' "$removed"

say "Deployed $TAG"
