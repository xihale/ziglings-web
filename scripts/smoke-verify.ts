// Spec §6.4 Check 2: verification-pipeline smoke test.
//
// Without a browser we cannot compile/run wasm here. Instead this script guards
// the pure-logic core of the pipeline that the spec calls out: trimLines, the
// patch applier, and verifyRun's two-kind branching. It runs them against the
// REAL vendored content (catalog + a sample of exercises + their patches), so
// a regression in any of these — or a malformed patch/source pair — goes red.
//
// Coverage:
//   - Every runnable exercise's source file exists and parses (no catalog drift).
//   - Every exercise with a patch: applyPatch(source, patch) succeeds and yields
//     a non-empty healed program (catches patch/source format rot).
//   - verifyRun + trimLines: assert known verdicts over synthetic RunResults
//     spanning exe-pass / exe-mismatch / exe-run-fail / test-pass / test-fail.
//
// Run: node --import tsx scripts/smoke-verify.mjs

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatch } from "../src/patch.ts";
import { trimLines, verifyRun, type Exercise } from "../src/verify.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = resolve(root, "vendor/ziglings");
const catalog = JSON.parse(readFileSync(resolve(vendorDir, "catalog.json"), "utf8"));

let failures = 0;
function fail(msg) {
    failures++;
    console.error("  FAIL " + msg);
}
function ok(msg) {
    console.log("  ok   " + msg);
}

console.log("=== catalog + source/patch integrity ===");
for (const ex of catalog.exercises) {
    const srcPath = resolve(vendorDir, ex.sourcePath);
    if (!existsSync(srcPath)) {
        fail(`${ex.slug}: source missing at ${ex.sourcePath}`);
        continue;
    }
    const patchPath = resolve(vendorDir, ex.patchPath);
    if (!existsSync(patchPath)) {
        fail(`${ex.slug}: patch missing at ${ex.patchPath}`);
        continue;
    }
    // Apply the official patch to the broken source; it must heal cleanly.
    try {
        const source = readFileSync(srcPath, "utf8");
        const patch = readFileSync(patchPath, "utf8");
        const healed = applyPatch(source, patch);
        if (!healed || healed.split("\n").length < 2) {
            fail(`${ex.slug}: patch produced empty/trivial output`);
            continue;
        }
    } catch (err) {
        fail(`${ex.slug}: applyPatch threw — ${err}`);
    }
}
ok(`${catalog.exercises.length} exercises checked for source+patch integrity`);

console.log("\n=== trimLines regression ===");
const cases = [
    ["Hello world!\n", "Hello world!"],
    ["a   \nb   ", "a\nb"],
    ["   indented\n", "   indented"],
    ["a\r\nb\r\n", "a\nb"],
    ["a\n\n\n", "a"],
    ["", ""],
];
let trimFail = 0;
for (const [input, want] of cases) {
    const got = trimLines(input);
    if (got !== want) { fail(`trimLines(${JSON.stringify(input)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); trimFail++; }
}
if (trimFail === 0) ok("trimLines boundary cases");

console.log("\n=== verifyRun verdict branching ===");
const baseEx = (over = {}) => ({
    number: 1, slug: "t", name: "t", sourcePath: "", patchPath: "",
    output: "Hello world!", checkStdout: false, kind: "exe", linkLibc: false,
    hint: null, skip: false, timestamp: false, runnable: true, notRunnableReason: null,
    ...over,
});
function expect(name, ex, run, wantStatus, wantKind) {
    const v = verifyRun(ex, run);
    if (v.status !== wantStatus || v.failKind !== wantKind) {
        fail(`${name}: verdict=${v.status}/${v.failKind}, want ${wantStatus}/${wantKind ?? "-"}`);
    } else {
        ok(name);
    }
}
expect("exe pass (stderr)", baseEx(), { stdout: "", stderr: "Hello world!\n", exitCode: 0 }, "pass", undefined);
expect("exe output_mismatch", baseEx(), { stdout: "", stderr: "Goodbye\n", exitCode: 0 }, "fail", "output_mismatch");
expect("exe run-fail (nonzero exit)", baseEx(), { stdout: "", stderr: "panic\n", exitCode: 1 }, "fail", "run");
expect("exe reads stdout when checkStdout", baseEx({ checkStdout: true, output: "X" }), { stdout: "X\n", stderr: "wrong", exitCode: 0 }, "pass", undefined);
expect("test pass (exit 0, no compare)", baseEx({ kind: "test" }), { stdout: "", stderr: "", exitCode: 0 }, "pass", undefined);
expect("test fail (exit 1)", baseEx({ kind: "test" }), { stdout: "", stderr: "FAIL\n", exitCode: 1 }, "fail", "run");

console.log(`\n${failures === 0 ? "smoke-verify: OK" : `smoke-verify: ${failures} failure(s)`}`);
if (failures > 0) process.exit(1);
