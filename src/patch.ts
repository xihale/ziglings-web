// Minimal unified-diff applier for the "reveal official solution" flow.
// Handles the Ziglings patch shape: standard unified diff with
// `@@ -oldStart,oldLen +newStart,newLen @@` hunk headers, context lines
// prefixed with ` `, removals with `-`, additions with `+`.
//
// Applies hunks in order against the broken source. Sufficient for reveal
// (display-only, never a grade per spec §3.12); not a general patch engine.

interface Hunk {
    oldStart: number; // 1-based line in the old file
    lines: string[]; // lines after the hunk header, with their +/ /- prefix
}

function parseHunks(patch: string): Hunk[] {
    const hunks: Hunk[] = [];
    let current: Hunk | null = null;
    for (const line of patch.split("\n")) {
        const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
        if (m) {
            if (current) hunks.push(current);
            current = { oldStart: parseInt(m[1], 10), lines: [] };
            continue;
        }
        if (current && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))) {
            current.lines.push(line);
        } else if (current && line === "") {
            // Treat a bare blank line inside a hunk as a context line for an
            // empty context row (some diffs emit these).
            current.lines.push(" ");
        }
    }
    if (current) hunks.push(current);
    return hunks;
}

/**
 * Apply a unified patch to source, returning the patched text.
 * Throws if a hunk's context doesn't match (the patch was generated against
 * a different source — shouldn't happen with vendored pairs).
 */
export function applyPatch(source: string, patch: string): string {
    const lines = source.split("\n");
    const hunks = parseHunks(patch);

    // Apply last-first so earlier hunk line numbers stay valid. Hunks are
    // independent regions; reversing avoids index shift across hunks.
    for (let h = hunks.length - 1; h >= 0; h--) {
        const hun = hunks[h];
        let idx = hun.oldStart - 1; // 0-based
        for (const pl of hun.lines) {
            const tag = pl[0];
            const rest = pl.slice(1);
            if (tag === " ") {
                idx++;
            } else if (tag === "-") {
                lines.splice(idx, 1);
            } else if (tag === "+") {
                lines.splice(idx, 0, rest);
                idx++;
            }
        }
    }
    return lines.join("\n");
}
