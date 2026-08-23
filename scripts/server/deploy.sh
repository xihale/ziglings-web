#!/usr/bin/env bash
# Server-side deploy job for ziglings.xihale.top — started by scripts/server/webhook.mjs
# (or manually: ssh zzy_hk, then `sudo -u ziglings-ci bash ~/ziglings-web/scripts/server/deploy.sh`).
#
# ziglings-web is a pure consumer (compilers come from zp.xihale.top via
# zp-loader.js at runtime), so a deploy is just:
#   1. shallow-fetch main into the persistent clone
#   2. run the CI gate (catalog integrity, smoke, unit tests, version
#      alignment) — a failing check keeps the old site live
#   3. npm ci + vite build + assemble dist
#   4. rsync to /srv/ziglings-web (Caddy serves it)
#
# The vendor/ziglings-src submodule is NOT needed here: only the maintenance
# script scripts/sync-ziglings.mjs reads it; builds and checks use the
# committed vendor/ziglings tree.
set -Eeuo pipefail
umask 022

REF="${1:-refs/heads/main}"
BRANCH="${REF#refs/heads/}"
REPO=/home/ziglings-ci/ziglings-web
DEST=/srv/ziglings-web
LOCK=/home/ziglings-ci/.deploy.lock
RERUN=/home/ziglings-ci/.deploy-rerun

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { say "FATAL: $*"; exit 1; }

cd "$REPO"

# One deploy at a time; a push that lands mid-deploy queues exactly one rerun
# (latest commit wins — the queued rerun fetches the newest sha anyway).
exec 9>"$LOCK"
if ! flock -n 9; then
  touch "$RERUN"
  say "deploy already running — queued one rerun"
  exit 0
fi

say "=== deploy start (${BRANCH}, sha=${ZL_PUSH_SHA:-unknown}) ==="

git fetch --depth=1 origin "$BRANCH"
git checkout -q -B "$BRANCH" FETCH_HEAD
# untracked caches (node_modules, dist) survive on purpose

# --- CI gate (same checks as .github/workflows/ci.yml) ----------------------
npm ci
npm run check-catalog
npm run smoke-verify
npm test
npm run check-version-alignment

# --- frontend build + publish -----------------------------------------------
npm run build

printf '{"sha":"%s","branch":"%s","deployedAt":"%s"}\n' \
  "$(git rev-parse HEAD)" "$BRANCH" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > dist/deploy-meta.json

rsync -a --delete --delay-updates \
  --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r \
  dist/ "$DEST/"
say "published $(git rev-parse --short HEAD) → $DEST"

say "=== deploy done ==="
if [ -e "$RERUN" ]; then
  rm -f "$RERUN"
  say "a newer push arrived during this deploy — running again"
  exec /bin/bash "$0" "$REF"
fi
