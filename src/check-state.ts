/**
 * Generation-based invalidation for the compile → run → verdict pipeline.
 *
 * A check spans two workers (compiler, then runner) and can take seconds.
 * During that window the user may switch exercises; every in-flight reply
 * must then be dropped — it must not grade the exercise we left or persist
 * progress for the wrong exercise. The rule is one line:
 *
 *   a reply is actionable iff its requestId equals the current generation,
 *   and BOTH starting a new check AND leaving the exercise bump it.
 *
 * Pure (no DOM, no workers) so the invariant is unit-testable in
 * test/check-state.test.ts. The shell is the only consumer; it must route
 * every state change through this class (never keep a parallel counter).
 */

export type CheckPhase = "idle" | "checking";

export class CheckTracker {
    private gen = 0;
    private phase: CheckPhase = "idle";

    get phase(): CheckPhase {
        return this.phase;
    }

    /** Request id of the in-flight (or most recent) check. */
    get requestId(): string {
        return String(this.gen);
    }

    /** Begin a check. Returns the requestId to stamp on the worker request. */
    start(): string {
        this.gen += 1;
        this.phase = "checking";
        return this.requestId;
    }

    /** A reply (from either worker) is only actionable for the live check. */
    isCurrent(requestId: string): boolean {
        return requestId === this.requestId;
    }

    /**
     * Leave the exercise mid-check: bump the generation so every in-flight
     * reply is stale, and end the checking phase.
     */
    invalidate(): void {
        this.gen += 1;
        this.phase = "idle";
    }

    /** The check reached its terminal verdict (pass / fail / compile error). */
    finish(): void {
        this.phase = "idle";
    }
}
