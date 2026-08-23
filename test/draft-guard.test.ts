// Regression tests for the draft-poisoning bug:
//   - the boot placeholder ("// loading…") must never load back as a draft
//     (a keystroke on the placeholder after a failed source fetch used to
//     persist it, leaving the exercise stuck on "loading…" forever);
//   - import must sanitize too, or a poisoned blob rides along on device sync.
// Same no-framework runner shape as the other tests.
import {
    BOOT_PLACEHOLDER,
    loadDrafts,
    saveDrafts,
    setDraft,
    getDraft,
    buildExport,
    importBundle,
    type Drafts,
    type Progress,
} from "../src/storage.ts";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}: ${(e as Error).message}`); }
}
function eq(a: unknown, b: unknown, msg?: string): void {
  if (a !== b) throw new Error((msg ?? "mismatch") + `: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

// localStorage shim for node (storage.ts reads/writes it at module scope on use).
const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
};
function reset(): void {
    store.clear();
}

// ─── loadDrafts sanitization ──────────────────────────────────────

test("loadDrafts drops placeholder-equal drafts, keeps real ones", () => {
    reset();
    const poisoned: Drafts = {
        version: 1,
        drafts: {
            "015_for": BOOT_PLACEHOLDER,          // the bug's fingerprint
            "001_hello": "const std = @import(\"std\");\n",
        },
    };
    saveDrafts(poisoned);
    const d = loadDrafts();
    eq(getDraft(d, "015_for"), undefined, "placeholder draft must be dropped");
    eq(getDraft(d, "001_hello"), "const std = @import(\"std\");\n", "real draft must survive");
});

test("loadDrafts tolerates missing drafts field (old/partial blob)", () => {
    reset();
    store.set("ziglings:drafts", JSON.stringify({ version: 1 }));
    const d = loadDrafts();
    eq(getDraft(d, "anything"), undefined);
});

test("placeholder-exact string only — near-miss text is kept", () => {
    reset();
    saveDrafts({ version: 1, drafts: { "015_for": BOOT_PLACEHOLDER + " " } });
    const d = loadDrafts();
    eq(getDraft(d, "015_for"), BOOT_PLACEHOLDER + " ");
});

// ─── import sanitization ──────────────────────────────────────────

test("importBundle strips placeholder drafts from the incoming blob", () => {
    reset();
    const progress: Progress = { version: 2, ziglingsCommit: "", solved: {}, failed: {} };
    const bundle = buildExport(progress, {
        version: 1,
        drafts: { "015_for": BOOT_PLACEHOLDER, "002_std": "fn foo" },
    });
    const { drafts } = importBundle(bundle, progress, loadDrafts());
    eq(getDraft(drafts, "015_for"), undefined, "imported placeholder must be dropped");
    eq(getDraft(drafts, "002_std"), "fn foo");
});

// ─── normal drafts unaffected ─────────────────────────────────────

test("setDraft roundtrips ordinary edits", () => {
    reset();
    let d = loadDrafts();
    d = setDraft(d, "015_for", "for (story) |scene| {");
    eq(getDraft(loadDrafts(), "015_for"), "for (story) |scene| {");
});

console.log(failed === 0 ? `\nAll ${passed} draft-guard tests passed.` : `\n${failed} FAILED, ${passed} passed.`);
process.exit(failed === 0 ? 0 : 1);
