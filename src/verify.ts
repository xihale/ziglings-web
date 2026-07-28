// Verification logic — pure, no DOM, no CodeMirror.
//
// Replicates Ziglings' output-compare tolerance (trimLines) and the two-kind
// verdict branching (exe / test). Unit-tested in test/trim-lines.test.mjs.
// The shell wires compile/execute results into verifyRun(); this module only
// turns (exercise metadata + execution result) into a Verdict.

/** Ziglings catalog exercise (subset consumed by verification). */
export interface Exercise {
    number: number;
    slug: string;
    name: string;
    sourcePath: string;
    patchPath: string;
    output: string;
    checkStdout: boolean;
    kind: "exe" | "test";
    linkLibc: boolean;
    hint: string | null;
    skip: boolean;
    timestamp: boolean;
    runnable: boolean;
    notRunnableReason: string | null;
}

/** Result of executing the compiled wasm in the runner worker. */
export interface RunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export interface Verdict {
    status: "pass" | "fail";
    failKind?: "compile" | "run" | "output_mismatch";
    /** trimLines'd expected — output_mismatch only. */
    expected?: string;
    /** trimLines'd actual — output_mismatch only. */
    actual?: string;
    /** Raw output (compile/run failures). */
    rawOutput?: string;
    /** Exit code from the run (for display). */
    exitCode?: number;
}

/**
 * Ziglings trimLines: the output-compare tolerance boundary.
 *   - split into lines
 *   - trimEnd each line (strip trailing spaces and \r)
 *   - drop trailing empty lines
 *   - do NOT trim leading spaces; do NOT alter internal whitespace
 *
 * Exact replication is load-bearing: naive `===` fails on correct solutions
 * across line-ending / trailing-newline differences.
 */
export function trimLines(s: string): string {
    if (s === "") return "";
    // Split on \n. A trailing \n yields a final "" element; that's fine — it
    // gets dropped by the trailing-empty collapse below.
    const lines = s.split("\n");
    // trimEnd each line: removes trailing spaces AND \r (so \r\n normalizes).
    for (let i = 0; i < lines.length; i++) {
        lines[i] = lines[i].replace(/\s+$/u, "");
    }
    // Drop trailing empty lines (but keep internal blanks).
    while (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
    }
    return lines.join("\n");
}

/**
 * Produce a verdict from an execution result. Compile failure is handled by
 * the caller (it never reaches a RunResult); this covers run + output compare.
 *
 * exe:  exit!=0 → run-fail; else compare trimmed (checkStdout?stdout:stderr) vs output.
 * test: exit!=0 → run-fail (test-runner output); exit==0 → pass (no compare).
 */
export function verifyRun(ex: Exercise, run: RunResult): Verdict {
    if (run.exitCode !== 0) {
        return {
            status: "fail",
            failKind: "run",
            rawOutput: run.exitCode !== 0 ? run.stderr || run.stdout : undefined,
            exitCode: run.exitCode,
        };
    }

    if (ex.kind === "test") {
        // zig test passing (exit 0) means correct — no output comparison.
        return { status: "pass", exitCode: run.exitCode };
    }

    // exe: compare the selected stream, after trimLines on both sides.
    const stream = ex.checkStdout ? run.stdout : run.stderr;
    const actual = trimLines(stream);
    const expected = trimLines(ex.output);
    if (actual === expected) {
        return { status: "pass", exitCode: run.exitCode };
    }
    return {
        status: "fail",
        failKind: "output_mismatch",
        expected,
        actual,
        exitCode: run.exitCode,
    };
}
