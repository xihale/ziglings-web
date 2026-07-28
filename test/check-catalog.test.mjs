// Minimal test runner: each test throws on failure. No framework dep.
import { checkCatalog } from "../scripts/check-catalog.mjs";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg ?? "assertion failed"); }

// A tiny in-memory fake filesystem so tests don't touch the real vendor tree.
function fakeFs(files) {
  return (p) => files.has(p);
}

test("empty problems for a well-formed catalog", () => {
  const cat = {
    version: "abc", zigFloor: "0.17.0-dev.607",
    exercises: [{
      number: 1, slug: "001_hello", name: "hello",
      sourcePath: "exercises/001_hello.zig", patchPath: "patches/001_hello.patch",
      output: "Hello world!", checkStdout: false, kind: "exe", linkLibc: false,
      hint: null, skip: false, timestamp: false, runnable: true, notRunnableReason: null,
    }],
  };
  const exists = fakeFs(new Set(["exercises/001_hello.zig", "patches/001_hello.patch"]));
  const problems = checkCatalog(cat, { exists });
  assert(problems.length === 0, `expected no problems, got: ${JSON.stringify(problems)}`);
});

test("flags missing source file", () => {
  const cat = { version: "x", zigFloor: "x", exercises: [{
    number: 1, slug: "001_hello", sourcePath: "exercises/missing.zig", patchPath: "patches/x.patch",
    runnable: true,
  }] };
  const exists = fakeFs(new Set(["patches/x.patch"]));
  const problems = checkCatalog(cat, { exists });
  assert(problems.some((p) => /sourcePath/.test(p)), "expected a sourcePath problem");
});

test("flags duplicate number", () => {
  const cat = { version: "x", zigFloor: "x", exercises: [
    { number: 1, slug: "a", sourcePath: "a.zig", patchPath: "a.patch", runnable: true },
    { number: 1, slug: "b", sourcePath: "b.zig", patchPath: "b.patch", runnable: true },
  ] };
  const exists = fakeFs(new Set(["a.zig","a.patch","b.zig","b.patch"]));
  const problems = checkCatalog(cat, { exists });
  assert(problems.some((p) => /duplicate number/.test(p)), "expected duplicate-number problem");
});

test("flags missing zigFloor", () => {
  const cat = { version: "x", exercises: [] };
  const problems = checkCatalog(cat, { exists: () => true });
  assert(problems.some((p) => /zigFloor/.test(p)), "expected zigFloor problem");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
