#!/usr/bin/env node
/**
 * Integrity pin for the served zp-loader.js.
 *
 * The app dynamically imports https://zp.xihale.top/zp-loader.js at runtime
 * (consumer mode — see src/utils.ts). That is remote code executing in our
 * workers; `loaderSha256` in versions.json pins the exact bytes we accept,
 * so an unintentional (or malicious) loader change on the playground fails
 * the hash check instead of silently running.
 *
 * Usage:
 *   node scripts/pin-loader.mjs          # print the served loader's SHA-256
 *   node scripts/pin-loader.mjs --write  # stamp it into versions.json
 *
 * Run --write whenever you intentionally bump the playground's loader, then
 * commit versions.json. CI (check-version-alignment) fails on drift.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(root, "versions.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const origin = manifest.assetOrigin;
if (!origin) {
  console.error("versions.json: assetOrigin required (consumer mode)");
  process.exit(1);
}
const base = origin.endsWith("/") ? origin : `${origin}/`;
const url = `${base}zp-loader.js`;

let text;
try {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  text = await res.text();
} catch (err) {
  console.error(`could not fetch ${url}: ${err}`);
  process.exit(1);
}

const hash = createHash("sha256").update(text, "utf8").digest("hex");

if (process.argv.includes("--write")) {
  const prev = manifest.loaderSha256;
  manifest.loaderSha256 = hash;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const drift = prev !== undefined && prev !== hash ? "  (was a different value — drift detected, now updated)" : "";
  console.log(`versions.json: loaderSha256 = ${hash}${drift}`);
} else {
  console.log(hash);
}
