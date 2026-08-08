// One-command, idempotent regen of vendor/ziglings/.
// Run after `git submodule update --remote vendor/ziglings-src`.
//
// Steps:
//   1. Copy exercises/*.zig and patches/patches/*.patch verbatim into vendor/ziglings/.
//   2. Build a throwaway build dir: place a *patched* copy of Ziglings'
//      build.zig (exercises + Kind exposed as `pub`) next to a copy of
//      gen-catalog.zig, then `zig run -Mroot=<dir>/gen-catalog.zig`. The
//      submodule itself is never modified; the patch is a reproducible
//      transform. (build.zig imports test/tests.zig, which is also copied so
//      the import resolves.)
//   3. Stamp the real submodule commit SHA into catalog.version.
//   4. Apply the file-IO heuristic to derive final `runnable` per exercise.
//   5. Serialize with stable formatting and write vendor/ziglings/catalog.json.
//
// Idempotency: identical submodule input -> byte-identical catalog.json and
// byte-identical copied sources.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "vendor/ziglings-src");
const out = resolve(root, "vendor/ziglings");

// --- 0. sanity: submodule present + the file gen-catalog imports exists ---
if (!existsSync(resolve(src, "build.zig"))) {
  console.error("vendor/ziglings-src not populated. Run: git submodule update --init");
  process.exit(1);
}

// --- 1. clean + copy verbatim ---
rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, "exercises"), { recursive: true });
mkdirSync(resolve(out, "patches"), { recursive: true });

for (const f of readdirSync(resolve(src, "exercises"))) {
  if (f.endsWith(".zig")) cpSync(resolve(src, "exercises", f), resolve(out, "exercises", f));
}
// Ziglings stores patches at patches/patches/*.patch
const patchDir = resolve(src, "patches/patches");
for (const f of readdirSync(patchDir)) {
  if (f.endsWith(".patch")) cpSync(resolve(patchDir, f), resolve(out, "patches", f));
}
// Carry the LICENSE for attribution.
cpSync(resolve(src, "LICENSE"), resolve(out, "LICENSE"));

// --- 2. run the Zig generator against a patched throwaway copy of build.zig ---
// build.zig keeps `exercises` and `Kind` file-private; expose them on a copy.
// It also imports test/tests.zig (and that file @import("../build.zig") back),
// so place both into the temp dir for the import to resolve.
const buildDir = join(tmpdir(), "ziglings-web-gencat");
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
mkdirSync(join(buildDir, "test"), { recursive: true });

const buildRaw = readFileSync(resolve(src, "build.zig"), "utf8");
const buildPatched = buildRaw
  .replace(/^const exercises\b/m, "pub const exercises")
  .replace(/^const Kind\b/m, "pub const Kind");
writeFileSync(join(buildDir, "build.zig"), buildPatched, "utf8");
if (existsSync(resolve(src, "test/tests.zig"))) {
  cpSync(resolve(src, "test/tests.zig"), join(buildDir, "test/tests.zig"));
}
cpSync(resolve(root, "scripts/gen-catalog.zig"), join(buildDir, "gen-catalog.zig"));

const raw = execFileSync("zig", ["run", `-Mroot=${join(buildDir, "gen-catalog.zig")}`], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});
const catalog = JSON.parse(raw);

// --- 3. stamp the real submodule commit SHA ---
const sha = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
catalog.version = sha;

// --- 4. file-IO heuristic: refine `runnable` ---
// gen-catalog.zig already cleared runnable for link_libc/skip/timestamp.
// Add a source scan for file-IO / @cImport on top.
for (const ex of catalog.exercises) {
  if (!ex.runnable) continue;
  const code = readFileSync(resolve(out, ex.sourcePath), "utf8");
  if (/\bstd\.fs\b|\bstd\.os\.open\b|@cImport/.test(code)) {
    ex.runnable = false;
    ex.notRunnableReason = "file_io";
  }
}

// --- 5. stable serialization ---
// Sort exercises by number (gen-catalog already emits in array order, but enforce).
catalog.exercises.sort((a, b) => a.number - b.number);
writeFileSync(resolve(out, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n", "utf8");

console.log(`synced ${catalog.exercises.length} exercises from ${sha.slice(0, 10)}`);
console.log(`  runnable: ${catalog.exercises.filter((e) => e.runnable).length}`);
console.log(`  not runnable: ${catalog.exercises.filter((e) => !e.runnable).length}`);
