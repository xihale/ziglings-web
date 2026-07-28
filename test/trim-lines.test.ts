// Unit tests for trimLines (Ziglings' output-compare tolerance) and the
// Verifier verdict logic. No framework dep — same runner shape as check-catalog.test.mjs.
import { trimLines } from "../src/verify.ts";
import { verifyRun, type Exercise } from "../src/verify.ts";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg ?? "assertion failed"); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg ?? "mismatch") + `: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

// ─── trimLines ────────────────────────────────────────────────────

test("trimLines: empty string", () => {
  eq(trimLines(""), "");
});

test("trimLines: no trailing whitespace passes through", () => {
  eq(trimLines("Hello world!"), "Hello world!");
});

test("trimLines: trailing newline dropped", () => {
  eq(trimLines("Hello world!\n"), "Hello world!");
});

test("trimLines: trailing spaces on each line trimmed (right only)", () => {
  eq(trimLines("a   \nb   "), "a\nb");
});

test("trimLines: leading spaces preserved (NOT trimmed)", () => {
  eq(trimLines("   indented\n"), "   indented");
});

test("trimLines: \\r\\n normalized (\\r is trailing, dropped)", () => {
  eq(trimLines("a\r\nb\r\n"), "a\nb");
});

test("trimLines: trailing blank lines collapsed", () => {
  eq(trimLines("a\n\n\n"), "a");
});

test("trimLines: internal blank lines preserved", () => {
  eq(trimLines("a\n\nb\n"), "a\n\nb");
});

test("trimLines: newline-only input → empty", () => {
  eq(trimLines("\n\n\n"), "");
});

// ─── Verifier ─────────────────────────────────────────────────────

const exeExercise = (over: Partial<Exercise> = {}): Exercise => ({
  number: 1, slug: "001_hello", name: "hello",
  sourcePath: "", patchPath: "",
  output: "Hello world!",
  checkStdout: false, kind: "exe", linkLibc: false,
  hint: null, skip: false, timestamp: false, runnable: true, notRunnableReason: null,
  ...over,
});

test("verify: exe PASS when stderr (default) matches after trimLines", () => {
  const ex = exeExercise({ checkStdout: false, output: "Hello world!" });
  const v = verifyRun(ex, { stdout: "", stderr: "Hello world!\n", exitCode: 0 });
  eq(v.status, "pass");
});

test("verify: exe FAIL on nonzero exit (failKind=run)", () => {
  const ex = exeExercise();
  const v = verifyRun(ex, { stdout: "", stderr: "panic!\n", exitCode: 1 });
  eq(v.status, "fail");
  eq(v.failKind, "run");
});

test("verify: exe FAIL output_mismatch with diff detail", () => {
  const ex = exeExercise({ output: "Hello world!" });
  const v = verifyRun(ex, { stdout: "", stderr: "Hello unwrap!\n", exitCode: 0 });
  eq(v.status, "fail");
  eq(v.failKind, "output_mismatch");
  assert(v.expected === "Hello world!", "expected carried");
  assert(v.actual === "Hello unwrap!", "actual carried");
});

test("verify: exe reads stdout when checkStdout=true", () => {
  const ex = exeExercise({ checkStdout: true, output: "out" });
  // stderr has the WRONG value; stdout has the right one.
  const v = verifyRun(ex, { stdout: "out\n", stderr: "wrong", exitCode: 0 });
  eq(v.status, "pass");
});

test("verify: exe ignores stdout when checkStdout=false (std.debug.print → stderr)", () => {
  const ex = exeExercise({ checkStdout: false, output: "err" });
  const v = verifyRun(ex, { stdout: "wrong", stderr: "err\n", exitCode: 0 });
  eq(v.status, "pass");
});

test("verify: test-kind PASS on exit 0 (no output compare)", () => {
  const ex = exeExercise({ kind: "test", output: "" });
  const v = verifyRun(ex, { stdout: "all tests passed\n", stderr: "", exitCode: 0 });
  eq(v.status, "pass");
  assert(v.failKind === undefined, "no failKind on pass");
});

test("verify: test-kind FAIL on nonzero exit (failKind=run)", () => {
  const ex = exeExercise({ kind: "test" });
  const v = verifyRun(ex, { stdout: "", stderr: "1/1 t.test.x...FAIL\n", exitCode: 1 });
  eq(v.status, "fail");
  eq(v.failKind, "run");
});

test("verify: tolerance — trailing spaces + \\r\\n don't break a correct solution", () => {
  const ex = exeExercise({ output: "Line one\nLine two" });
  const v = verifyRun(ex, { stderr: "Line one   \r\nLine two\r\n", exitCode: 0 });
  eq(v.status, "pass");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
