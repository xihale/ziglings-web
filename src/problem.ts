// Extract the problem statement from an exercise's leading comments and
// render it as lightweight HTML. Every Ziglings exercise opens with a block
// of `//` teaching comments describing the task; we surface that as the
// "problem body" in the right pane.

/**
 * Pull the leading `//`-comment block off the source. Stops at the first
 * non-comment, non-blank line. Returns the comment text with `//` prefixes
 * stripped (one leading space after // is also stripped).
 */
export function extractProblemBody(source: string): string {
    const out: string[] = [];
    let sawComment = false;
    for (const raw of source.split("\n")) {
        const line = raw;
        // Blank lines inside the leading block are kept (paragraph breaks).
        if (/^\s*$/.test(line)) {
            if (sawComment) {
                out.push("");
                continue;
            }
            continue; // leading blanks before any comment — skip
        }
        const m = /^\s*\/\/(?:\s?(.*))?$/.exec(line);
        if (m) {
            sawComment = true;
            out.push(m[1] ?? "");
            continue;
        }
        // First non-comment, non-blank line ends the body.
        if (sawComment) break;
        // No leading comment at all — leave the body empty.
        break;
    }
    // Trim trailing blank lines accumulated from blank comment lines.
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    return out.join("\n");
}

/**
 * Render problem text to HTML. Deliberately tiny subset (the problem bodies
 * are plain prose, not rich markdown): escape HTML, paragraphs on blank-line
 * breaks, `inline code` for backticked spans, and lines starting with
// bullet-ish markers. Keeps it dependency-free.
 */
export function renderProblem(text: string): string {
    const paras = text.split(/\n{2,}/);
    return paras
        .map((p) => {
            const lines = p.split("\n");
            // Bullet block?
            if (lines.every((l) => /^\s*[-*]\s+/.test(l) || l.trim() === "")) {
                const items = lines
                    .filter((l) => l.trim() !== "")
                    .map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`)
                    .join("");
                return `<ul>${items}</ul>`;
            }
            // Escape first (inline), then introduce <br> for line breaks
            // so the injected markup isn't itself escaped.
            return `<p>${inline(p).replace(/\n/g, "<br>")}</p>`;
        })
        .join("");
}

function inline(s: string): string {
    // Escape first, then re-introduce inline code spans.
    const esc = s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    return esc.replace(/`([^`]+)`/g, "<code>$1</code>");
}
