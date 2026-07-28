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

## Repo layout

```
scripts/
  sync-ziglings.mjs   one-command content regen
  gen-catalog.zig     parses Ziglings' elrond into catalog.json
  check-catalog.mjs   catalog integrity validator
vendor/
  ziglings-src/       git submodule → Ziglings
  ziglings/           committed artifacts (exercises, patches, catalog.json)
test/                 unit tests (node, no framework)
```
