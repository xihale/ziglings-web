# Ziglings Web

A browser-based Zig learning platform that hosts the [Ziglings](https://codeberg.org/ziglings/exercises)
exercise set with zero-install editing, automatic verification, and progress tracking.

> **Status:** early development. Content pipeline (this repo's first milestone) is in place;
> the in-browser editor/verifier is forthcoming.

## What this is (and isn't)

- A third-party web rendering of Ziglings content — **not** the official Ziglings project.
- Faithful to Ziglings' exercises; this project's job is making them *easier to learn* in a browser.
- No backend, no accounts — progress lives in your browser's localStorage.

## Content attribution

All exercise content is © Ziglings contributors, sourced from
[Codeberg `ziglings/exercises`](https://codeberg.org/ziglings/exercises), vendored under
`vendor/ziglings/`. See `vendor/ziglings/LICENSE`.

## Updating the content (bump flow)

When Ziglings publishes new exercises:

```bash
# 1. Pull the latest Ziglings into the submodule
git submodule update --remote vendor/ziglings-src

# 2. Regenerate the vendored artifacts (idempotent)
npm run sync-ziglings

# 3. Review what changed
git diff vendor/ziglings/catalog.json
git diff vendor/ziglings/exercises/

# 4. If zigFloor changed and exceeds the compiler we ship, STOP and resolve that first.

# 5. Commit
git add vendor/ziglings-src vendor/ziglings/
git commit -m "bump ziglings"
```

The sync is idempotent — identical submodule input produces byte-identical `catalog.json`, so `git diff`
shows only real content changes.

## Loader integrity pinning

This site is a pure consumer: at runtime its workers execute the playground's
`zp-loader.js` (fetched from `assetOrigin` in `versions.json`) to download the
compiler assets. That is remote code running in the site's origin, so it is
**pinned**: `versions.json → loaderSha256` must match the served bytes, or the
site refuses to load the loader (see `src/utils.ts`).

```bash
# Print the SHA-256 of the currently served loader
npm run pin-loader

# After an intentional loader bump on the playground, refresh the pin and commit
npm run pin-loader -- --write
git add versions.json && git commit -m "pin zp-loader"
```

CI (Check 3) fails if the served loader drifts from the pin, so a mismatch
surfaces at deploy time instead of on the user's machine.

## Deployment

**Site:** https://zlg.xeed.ink/ — served by Caddy on gx from
`/srv/ziglings-web`. A push to `main` triggers a server-side deploy (GitHub
webhook → socket-activated receiver → `scripts/server/deploy.sh`: fetch, run
the CI gate, build, rsync). GitHub Actions here is PR feedback only and never
touches the server. See `scripts/server/README.md`.

## Repo layout

```
scripts/
  sync-ziglings.mjs   one-command content regen
  gen-catalog.zig     parses Ziglings' elrond into catalog.json
  check-catalog.mjs   catalog integrity validator
  pin-loader.mjs      print/refresh the zp-loader.js SHA-256 pin
vendor/
  ziglings-src/       git submodule → Ziglings
  ziglings/           committed artifacts (exercises, patches, catalog.json)
test/                 unit tests (node, no framework)
```
