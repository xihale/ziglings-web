// Unit tests for the pure-logic support modules: patch application, problem
// extraction, and storage round-trips. Same no-framework runner shape.
import { applyPatch } from "../src/patch.ts";
import { extractProblemBody, renderProblem } from "../src/problem.ts";
import {
    loadProgress, saveProgress, markSolved, isSolved, solvedCount,
    loadDrafts, setDraft, getDraft,
    buildExport, importBundle,
    type Progress, type Drafts,
} from "../src/storage.ts";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}: ${(e as Error).message}`); }
}
function eq(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error((msg ?? "mismatch") + `: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

// localStorage shim for node (storage.ts reads/writes it at module scope on use).
const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
};

// ─── patch ────────────────────────────────────────────────────────

test("patch: single hunk add/remove", () => {
    const src = "a\nb\nc\n";
    const patch = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";
    eq(applyPatch(src, patch), "a\nB\nc\n");
});

test("patch: real Ziglings 001_hello shape (pub fn)", () => {
    const src = "const std = @import(\"std\");\n\nfn main() void {\n    print;\n}\n";
    const patch = "--- a\n+++ b\n@@ -3,1 +3,1 @@\n-fn main() void {\n+pub fn main() void {\n";
    eq(applyPatch(src, patch), "const std = @import(\"std\");\n\npub fn main() void {\n    print;\n}\n");
});

test("patch: addition-only hunk (insert lines)", () => {
    const src = "x\n";
    const patch = "@@ -1,1 +1,2 @@\n x\n+y\n";
    eq(applyPatch(src, patch), "x\ny\n");
});

test("patch: multiple hunks applied in correct order (reverse)", () => {
    const src = "1\n2\n3\n4\n5\n";
    const patch =
        "@@ -1,1 +1,1 @@\n-1\n+A\n" +
        "@@ -5,1 +5,1 @@\n-5\n+E\n";
    eq(applyPatch(src, patch), "A\n2\n3\n4\nE\n");
});

// ─── problem ──────────────────────────────────────────────────────

test("problem: extracts leading // block, strips prefix", () => {
    const src = "// First line of guidance.\n// Second line.\n\nconst std = ...\n";
    eq(extractProblemBody(src), "First line of guidance.\nSecond line.");
});

test("problem: stops at first non-comment line", () => {
    const src = "// Intro.\nconst std = @import(\"std\");\n// not included\n";
    eq(extractProblemBody(src), "Intro.");
});

test("problem: renders paragraphs and inline code", () => {
    const html = renderProblem("Use `std.debug.print` to print.\n\nSecond paragraph.");
    if (!html.includes("<code>std.debug.print</code>")) throw new Error("missing inline code");
    if (!html.includes("<p>") || !html.includes("Second paragraph.")) throw new Error("missing paragraph");
});

test("problem: line breaks within a paragraph become <br>, not escaped", () => {
    const html = renderProblem("Line one.\nLine two with `code`.");
    // The literal <br> must survive (must not be escaped to &lt;br&gt;).
    if (!html.includes("<br>")) throw new Error("missing <br>");
    if (html.includes("&lt;br&gt;")) throw new Error("<br> was escaped");
    // Inline code still works on multi-line paragraphs.
    if (!html.includes("<code>code</code>")) throw new Error("missing inline code");
});

test("problem: renders bullet list", () => {
    const html = renderProblem("- one\n- two\n- three");
    if (!html.includes("<ul>") || !html.includes("<li>one</li>")) throw new Error("bullet list not rendered");
});

// ─── storage ──────────────────────────────────────────────────────

function reset() {
    store.clear();
}

test("storage: progress round-trips and solved flags", () => {
    reset();
    let p = loadProgress();
    eq(solvedCount(p), 0);
    eq(isSolved(p, "001_hello"), false);
    p = markSolved(p, "001_hello");
    eq(isSolved(p, "001_hello"), true);
    eq(solvedCount(p), 1);
    // Reload from storage — persists.
    const reloaded = loadProgress();
    eq(isSolved(reloaded, "001_hello"), true);
});

test("storage: markSolved is idempotent (no double count)", () => {
    reset();
    let p = loadProgress();
    p = markSolved(p, "x");
    p = markSolved(p, "x");
    eq(solvedCount(p), 1);
});

test("storage: drafts lazy + get/set", () => {
    reset();
    let d = loadDrafts();
    eq(getDraft(d, "001_hello"), undefined);
    d = setDraft(d, "001_hello", "source-here");
    eq(getDraft(d, "001_hello"), "source-here");
    // Reload from storage.
    eq(getDraft(loadDrafts(), "001_hello"), "source-here");
});

test("storage: export/import full-replace with backup", () => {
    reset();
    let p = loadProgress();
    let d = loadDrafts();
    p = markSolved(p, "001_hello");
    d = setDraft(d, "001_hello", "draft-source");
    const bundle = buildExport(p, d);
    eq(bundle.format, "ziglings-progress");
    eq(bundle.formatVersion, 1);

    // Now simulate importing a DIFFERENT bundle (e.g. from another device).
    const incoming = {
        format: "ziglings-progress", formatVersion: 1, exportedAt: "x",
        progress: { version: 1, ziglingsCommit: "abc", solved: { "002_std": "2026-01-01T00:00:00Z" } },
        drafts: { version: 1, drafts: { "002_std": "newdevice-source" } },
    };
    const { progress, drafts, backup } = importBundle(incoming, p, d);
    eq(isSolved(progress, "002_std"), true);
    eq(isSolved(progress, "001_hello"), false); // full replace — old solved gone
    eq(getDraft(drafts, "002_std"), "newdevice-source");
    // Backup captured pre-import state.
    eq(isSolved(backup.progress, "001_hello"), true);
});

test("storage: import rejects wrong format", () => {
    reset();
    let threw = false;
    try { importBundle({ format: "something-else" }, loadProgress(), loadDrafts()); }
    catch { threw = true; }
    if (!threw) throw new Error("expected format-mismatch throw");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
