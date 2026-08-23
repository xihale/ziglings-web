// Regression tests for the check-generation invariant (audit fixes #1/#2):
//   - an in-flight worker reply must be dropped after the user switches
//     exercises, or it would grade (and persist progress for) the WRONG
//     exercise;
//   - a pending "wait for compiler ready" retry must be re-validated at fire
//     time, or it would auto-run a check the user never requested.
// Same no-framework runner shape as the other tests.
import { CheckTracker } from "../src/check-state";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}: ${(e as Error).message}`); }
}
function assert(cond: boolean, msg?: string): void {
  if (!cond) throw new Error(msg ?? "assertion failed");
}

test("reply for the live check is current", () => {
  const t = new CheckTracker();
  const id = t.start();
  assert(t.phase === "checking", "phase is checking after start");
  assert(t.isCurrent(id), "own requestId is current");
});

test("starting a second check invalidates the first requestId", () => {
  const t = new CheckTracker();
  const old = t.start();
  t.start();
  assert(!t.isCurrent(old), "stale reply must be dropped");
});

test("exercise switch drops the in-flight reply and ends checking", () => {
  const t = new CheckTracker();
  const id = t.start();
  assert(t.phase === "checking");
  t.invalidate(); // user clicked another exercise
  assert(t.phase === "idle", "phase back to idle");
  assert(!t.isCurrent(id), "in-flight reply must not grade the left exercise");
});

test("after a switch, only the NEW check's replies are current", () => {
  const t = new CheckTracker();
  const old = t.start();
  t.invalidate();
  const fresh = t.start();
  assert(!t.isCurrent(old), "old gen stale");
  assert(t.isCurrent(fresh), "new gen live");
});

test("finish ends checking without invalidating the consumed generation", () => {
  const t = new CheckTracker();
  const id = t.start();
  t.finish();
  assert(t.phase === "idle", "phase back to idle");
  assert(t.isCurrent(id), "no bump on finish — that reply already drove finish");
});

test("generations are monotonic (requestIds never collide across checks)", () => {
  const t = new CheckTracker();
  const a = t.start();
  t.invalidate();
  const b = t.start();
  t.invalidate();
  const c = t.start();
  assert(Number(a) < Number(b) && Number(b) < Number(c), "strictly increasing");
});

test("replies carrying a never-issued requestId are not current", () => {
  const t = new CheckTracker();
  t.start(); // issues "1"
  assert(t.isCurrent("1"), "issued id is current");
  assert(!t.isCurrent("2"), "a future generation is not current");
  assert(!t.isCurrent("999"), "an unknown generation is not current");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
