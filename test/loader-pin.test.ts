// Regression tests for the loader integrity pin's hash encoding (audit fix):
// versions.json → loaderSha256 is lowercase hex — scripts/pin-loader.mjs and
// scripts/check-version-alignment.mjs compute it with
// createHash("sha256").update(s, "utf8").digest("hex") — so the runtime
// comparison in src/utils.ts must produce the same lowercase hex. The original
// code used btoa (base64), which never matched a 64-hex-char pin, so the site
// refused to boot whenever a pin was set.
// Same no-framework runner shape as the other tests.
import { createHash } from "node:crypto";
import { sha256Hex } from "../src/utils.ts";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}: ${(e as Error).message}`); }
}
function eq(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error((msg ?? "mismatch") + `: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

// sha256Hex is async (WebCrypto) while the runner is sync — resolve the
// digests at top level, assert inside the sync test() callbacks below.
const samples: Array<[string, string]> = [
  ["abc", "abc"],
  ["empty string", ""],
  ["multi-line unicode", "line one\nline two\nhéllo 世界 — ünïcode ✓\n"],
];
const webHashes = await Promise.all(samples.map(([, s]) => sha256Hex(s)));

test("known vector: sha256Hex(\"abc\")", () => {
  eq(webHashes[0], "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "NIST test vector");
});

test("encoding contract: matches Node createHash('sha256').digest('hex')", () => {
  for (let i = 0; i < samples.length; i++) {
    const [label, s] = samples[i];
    eq(webHashes[i], createHash("sha256").update(s, "utf8").digest("hex"), label);
  }
});

test("output is 64 lowercase hex chars (the versions.json pin format)", () => {
  for (const actual of webHashes) {
    if (!/^[0-9a-f]{64}$/.test(actual)) throw new Error(`bad pin format: ${actual}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
