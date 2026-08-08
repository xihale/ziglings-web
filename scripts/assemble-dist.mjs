#!/usr/bin/env node
/**
 * After `vite build`, finish the Pages tree:
 * - copy versions.json to dist/
 * - write dist/<id>/index.html and dist/404.html (same SPA shell)
 *
 * This is a pure consumer: compiler binaries are fetched at runtime from the
 * playground via zp-loader.js (versions.json → assetOrigin), never self-built
 * or copied into dist/.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");

if (!existsSync(join(dist, "index.html"))) {
  console.error("dist/index.html missing — run vite build first");
  process.exit(1);
}

const versions = JSON.parse(readFileSync(join(root, "versions.json"), "utf8"));
writeFileSync(join(dist, "versions.json"), JSON.stringify(versions, null, 2) + "\n");

const indexHtml = readFileSync(join(dist, "index.html"), "utf8");
// SPA fallback: GitHub Pages serves 404.html for unknown paths, so /N/ routes
// resolve to the app shell which then reads the exercise number client-side.
copyFileSync(join(dist, "index.html"), join(dist, "404.html"));

// Per-version index.html shells (harmless for single-version; kept for parity
// with the multi-version playground layout this project forked from).
for (const v of versions.versions) {
  const dir = join(dist, v.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), indexHtml);
}

const where = versions.assetOrigin
  ? `served from ${versions.assetOrigin} (zp-loader.js)`
  : "MISSING assetOrigin — consumer mode requires it";
console.log(`assemble-dist: default=${versions.default}, compilers ${where}`);
