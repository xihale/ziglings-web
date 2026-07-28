// Ziglings Web — course shell.
//
// Single-page app: exercise list (left) + editor (center) + problem & verdict
// (right) + raw output (bottom). Routes by exercise number (/N/). Reuses the
// forked playground's CodeMirror + ZLS + compile/runner workers, replacing the
// playground's editor.ts entirely.
//
// See docs/superpowers/specs/2026-07-28-ziglings-web-fork-design.md §3-§5.

import { EditorState } from "@codemirror/state";
import {
  keymap,
  EditorView,
  lineNumbers,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import { formatDocument, LSPPlugin } from "@codemirror/lsp-client";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  indentUnit,
  syntaxHighlighting,
  defaultHighlightStyle,
  foldGutter,
  indentOnInput,
  bracketMatching,
  foldKeymap,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
  closeBrackets,
  autocompletion,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { lintKeymap } from "@codemirror/lint";
import { zigLanguage } from "@ndim/codemirror-lang-zig";
import { editorTheme, highlightStyle } from "./theme.ts";
import { fullLineSelection } from "./full-line-selection.ts";
import {
  highlightActiveLineEmptyOnly,
  highlightActiveLineGutterEmptyOnly,
} from "./active-line.ts";
import { lspClient, initZls } from "./lsp.ts";
import { loadVersionsManifest } from "./version.ts";
import { ZigSharedClient } from "./zig-shared-client";
import type { WorkerMsg } from "./shared-protocol";
// @ts-ignore
import RunnerWorker from "./workers/runner.ts?worker";

import {
  loadCatalog, byNumber, ordered, runnableCount, loadSource, loadPatch,
} from "./catalog.ts";
import type { Catalog } from "./catalog.ts";
import type { Exercise } from "./verify.ts";
import { verifyRun, type Verdict, type RunResult } from "./verify.ts";
import { extractProblemBody, renderProblem } from "./problem.ts";
import { applyPatch } from "./patch.ts";
import {
  loadProgress, loadDrafts, markSolved, isSolved, solvedCount,
  getDraft, setDraft, buildExport, exportFilename, importBundle,
  type Progress, type Drafts,
} from "./storage.ts";

// ─── Version ──────────────────────────────────────────────────────
// Single version (master). The shell never shows a version dropdown; the id
// is used only to point the workers at the right compiler asset tree.
const manifest = loadVersionsManifest();
const VERSION_ID = manifest.default;

// ─── App state ────────────────────────────────────────────────────
let catalog: Catalog;
let progress: Progress;
let drafts: Drafts;
let current: Exercise | null = null;
let editor: EditorView;

// Check-flow state machine: idle → checking → verdict → idle.
type CheckState = "idle" | "checking" | "verdict";
let checkState: CheckState = "idle";

// ─── DOM roots ────────────────────────────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const listEl = $("exercise-list");
const progressCountEl = $("progress-count");
const progressFillEl = $("progress-fill");
const problemBodyEl = $("problem-body");
const metaEl = $("exercise-meta");
const verdictEl = $("verdict");
const outputEl = $("output-pad");
const checkBtn = $("check") as HTMLButtonElement;
const nextBtn = $("next") as HTMLButtonElement;
const hintBtn = $("hint") as HTMLButtonElement;
const revealBtn = $("reveal") as HTMLButtonElement;
const currentLabelEl = $("current-exercise");

// ─── Routing: /N/ ─────────────────────────────────────────────────

function routeNumber(): number | null {
  const seg = (location.pathname.replace(/\/+$/, "").split("/").pop() ?? "");
  const n = parseInt(seg, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function setRoute(n: number): void {
  const base = import.meta.env.BASE_URL || "/";
  const root = base.endsWith("/") ? base : `${base}/`;
  history.pushState(null, "", `${root}${n}/`);
}

/** Pick the landing exercise: first unsolved runnable, else 1. */
function landingNumber(): number {
  const ord = ordered(catalog);
  const firstUnsolved = ord.find((e) => e.runnable && !isSolved(progress, e.slug));
  return firstUnsolved?.number ?? ord[0]?.number ?? 1;
}

// ─── Left list rendering ──────────────────────────────────────────

function statusMarker(ex: Exercise): string {
  if (!ex.runnable) return "⊘";
  if (isSolved(progress, ex.slug)) return "✓";
  if (current && ex.number === current.number) return "▶";
  return "·";
}

function renderList(): void {
  listEl.replaceChildren();
  const total = runnableCount(catalog);
  const done = ordered(catalog).filter((e) => e.runnable && isSolved(progress, e.slug)).length;
  progressCountEl.textContent = `${done}/${total}`;
  progressFillEl.style.width = `${total === 0 ? 0 : (done / total) * 100}%`;

  for (const ex of ordered(catalog)) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "ex-row";
    if (current && ex.number === current.number) row.classList.add("current");
    if (isSolved(progress, ex.slug)) row.classList.add("solved");
    if (!ex.runnable) {
      row.classList.add("not-runnable");
      row.title = `Not runnable in-browser: ${ex.notRunnableReason ?? "unknown"}`;
    }
    const mark = document.createElement("span");
    mark.className = "ex-mark";
    mark.textContent = statusMarker(ex);
    const label = document.createElement("span");
    label.className = "ex-label";
    label.textContent = `${String(ex.number).padStart(3, "0")} ${ex.name}`;
    row.append(mark, label);
    row.addEventListener("click", () => openExercise(ex.number));
    listEl.appendChild(row);
  }
}

// ─── Problem + verdict rendering ──────────────────────────────────

function renderProblem(ex: Exercise, source: string): void {
  const body = extractProblemBody(source);
  problemBodyEl.innerHTML = body ? renderProblem(body) : '<p class="muted">(This exercise has no leading comment body.)</p>';
  const kindLabel = ex.kind === "test" ? "test" : "exe";
  const streamLabel = ex.checkStdout ? "stdout" : "stderr";
  metaEl.innerHTML =
    `kind: <code>${kindLabel}</code> · expected on <code>${streamLabel}</code>` +
    (ex.runnable ? "" : ` · <strong class="warn">not runnable</strong>`);
}

function setVerdict(html: string, cls = ""): void {
  verdictEl.className = `verdict-box ${cls}`;
  verdictEl.innerHTML = html;
}

function clearVerdict(): void {
  verdictEl.className = "verdict-box";
  verdictEl.innerHTML = "";
}

/** Line-by-line diff for output_mismatch. */
function renderDiff(expected: string, actual: string): string {
  const expLines = expected.split("\n");
  const actLines = actual.split("\n");
  const rows: string[] = [];
  const n = Math.max(expLines.length, actLines.length);
  rows.push('<table class="diff"><thead><tr><th>Expected</th><th>Yours</th></tr></thead><tbody>');
  for (let i = 0; i < n; i++) {
    const e = expLines[i] ?? "";
    const a = actLines[i] ?? "";
    const diff = e !== a;
    rows.push(
      `<tr class="${diff ? "diff-row" : ""}"><td><pre>${esc(e)}</pre></td><td><pre>${esc(a)}</pre></td></tr>`,
    );
  }
  rows.push("</tbody></table>");
  return rows.join("");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Compile/run pipeline (verdict) ───────────────────────────────

let zigWorker: ZigSharedClient | null = null;
let compilerReady = false;
let workersBooted = false;
let zlsBooted = false;

// In-flight check state.
let checkGen = 0;
let pendingRunResult: Partial<RunResult> = {};
let lastWasm: ArrayBuffer | null = null;

function bootZlsOnce(): void {
  if (zlsBooted) return;
  zlsBooted = true;
  initZls(VERSION_ID);
}

function bootWorkersOnce(): void {
  if (workersBooted) return;
  workersBooted = true;
  zigWorker = new ZigSharedClient();
  zigWorker.onmessage = onZigWorkerMessage;
  zigWorker.dispatch({ kind: "init", versionId: VERSION_ID });
  bootZlsOnce();
}

function onZigWorkerMessage(msg: WorkerMsg): void {
  if (msg.kind === "ready") {
    if (msg.ok) {
      compilerReady = true;
    } else {
      setVerdict(`<p class="err">Compiler failed to load: ${esc(msg.error)}</p>`, "err");
      checkState = "idle";
      checkBtn.disabled = false;
    }
    return;
  }

  const gen = checkGen;

  // Compile-stage stderr (diagnostics) — stream into the output panel.
  if (msg.kind === "stderr") {
    if (msg.requestId !== String(gen)) return;
    appendOutput(msg.text);
    return;
  }
  if (msg.kind === "stdout") {
    if (msg.requestId !== String(gen)) return;
    appendOutput(msg.text, "stdout");
    return;
  }

  if (msg.kind === "failed") {
    if (msg.requestId !== String(gen)) return;
    finishCheck({
      status: "fail",
      failKind: "compile",
      rawOutput: outputEl.textContent ?? "",
    });
    return;
  }

  if (msg.kind === "compiled") {
    if (msg.requestId !== String(gen)) return;
    lastWasm = msg.wasm;
    runCompiled(msg.wasm, gen);
    return;
  }
}

function runCompiled(wasm: ArrayBuffer, gen: number): void {
  const runner = new RunnerWorker();
  runner.postMessage({ run: wasm }, [wasm]);
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let crashed = false;

  runner.onmessage = (rev: MessageEvent) => {
    if (gen !== checkGen) {
      runner.terminate();
      return;
    }
    const d = rev.data;
    if (d.stdout !== undefined) {
      stdout += d.stdout;
      appendOutput(d.stdout, "stdout");
    } else if (d.stderr !== undefined) {
      stderr += d.stderr;
      appendOutput(d.stderr, "stderr");
    } else if (d.exitCode !== undefined) {
      exitCode = d.exitCode;
      crashed = !!d.crashed;
    } else if (d.done) {
      runner.terminate();
      if (crashed) {
        finishCheck({
          status: "fail",
          failKind: "run",
          rawOutput: stderr || stdout,
          exitCode,
        });
        return;
      }
      const result: RunResult = { stdout, stderr, exitCode };
      if (!current) return;
      const v = verifyRun(current, result);
      finishCheck(v);
    }
  };
}

function finishCheck(v: Verdict): void {
  checkState = "verdict";
  checkBtn.disabled = false;
  if (v.status === "pass" && current) {
    progress = markSolved(progress, current.slug);
    renderList();
    setVerdict(
      `<p class="pass">✓ Passed</p>` +
      `<div class="verdict-actions"><button id="next-action">Next →</button></div>`,
      "pass",
    );
    $("next-action").addEventListener("click", goNext);
    nextBtn.hidden = false;
  } else if (v.failKind === "compile") {
    setVerdict(`<p class="err">✗ Compile error</p><p class="muted">Read the compiler output above — that's the exercise.</p>`, "err");
  } else if (v.failKind === "run") {
    const label = current?.kind === "test" ? "Tests failed" : "Run failed";
    setVerdict(`<p class="err">✗ ${label} (exit ${v.exitCode ?? "?"})</p>`, "err");
  } else if (v.failKind === "output_mismatch" && v.expected !== undefined && v.actual !== undefined) {
    setVerdict(
      `<p class="err">✗ Output mismatch</p>` +
      renderDiff(v.expected, v.actual),
      "err",
    );
  }
}

// ─── Output panel ─────────────────────────────────────────────────

function clearOutput(): void {
  outputEl.replaceChildren();
}

function appendOutput(text: string, cls = "stderr"): void {
  let block = outputEl.querySelector<HTMLElement>(`[data-stream="${cls}"]`);
  if (!block) {
    block = document.createElement("div");
    block.className = `output-block ${cls}`;
    block.dataset.stream = cls;
    outputEl.appendChild(block);
  }
  block.textContent += text;
  outputEl.scrollTop = outputEl.scrollHeight;
}

// ─── Opening an exercise ──────────────────────────────────────────

async function openExercise(n: number): void {
  const ex = byNumber(catalog, n);
  if (!ex) return;
  current = ex;
  setRoute(n);
  currentLabelEl.textContent = `${String(ex.number).padStart(3, "0")} ${ex.name}`;
  clearOutput();
  clearVerdict();
  nextBtn.hidden = true;
  hintBtn.hidden = !ex.hint;
  revealBtn.hidden = true;
  checkBtn.disabled = !ex.runnable;

  // Source: draft if any, else the broken initial source.
  let source = getDraft(drafts, ex.slug);
  if (source === undefined) {
    try {
      source = await loadSource(ex);
    } catch (err) {
      setVerdict(`<p class="err">Failed to load source: ${esc(String(err))}</p>`, "err");
      return;
    }
  }

  renderProblem(ex, source);
  replaceDoc(source);

  if (!ex.runnable) {
    setVerdict(
      `<p class="banner">This exercise needs a local Zig environment` +
      ` (reason: <code>${ex.notRunnableReason ?? "unknown"}</code>).` +
      ` Complete it locally via <code>git clone</code> of Ziglings.</p>`,
      "banner",
    );
  }

  renderList();
}

function goNext(): void {
  if (!current) return;
  const ord = ordered(catalog);
  const idx = ord.findIndex((e) => e.number === current!.number);
  for (let i = idx + 1; i < ord.length; i++) {
    if (ord[i].runnable) {
      openExercise(ord[i].number);
      return;
    }
  }
  // No next runnable — stay.
}

// ─── Editor ───────────────────────────────────────────────────────

const playgroundSetup = [
  lineNumbers(),
  highlightActiveLineGutterEmptyOnly(),
  highlightSpecialChars(),
  history(),
  foldGutter({
    markerDOM(open) {
      const span = document.createElement("span");
      span.className = open ? "cm-fold-open" : "cm-fold-closed";
      span.textContent = open ? "⌄" : "›";
      return span;
    },
  }),
  drawSelection(),
  fullLineSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLineEmptyOnly(),
  highlightSelectionMatches(),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...completionKeymap,
    ...lintKeymap,
  ]),
];

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleDraftSave(): void {
  if (!current) return;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!current) return;
    drafts = setDraft(drafts, current.slug, editorSource());
  }, 300);
}

function editorSource(): string {
  return editor.state.doc.toString();
}

function replaceDoc(text: string): void {
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
}

function bootEditor(initialDoc: string): void {
  editor = new EditorView({
    parent: $("editor"),
    state: EditorState.create({
      doc: initialDoc,
      extensions: [
        playgroundSetup,
        editorTheme,
        indentUnit.of("    "),
        keymap.of([
          indentWithTab,
          { key: "Mod-s", preventDefault: true, run: (v) => { formatDocument(v); return true; } },
          { key: "Mod-Enter", run: () => { startCheck(); return true; } },
        ]),
        zigLanguage,
        syntaxHighlighting(highlightStyle),
        lspClient.plugin("file:///main.zig"),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) scheduleDraftSave();
        }),
      ],
    }),
  });
}

// ─── Check button ─────────────────────────────────────────────────

function startCheck(): void {
  if (!current || !current.runnable) return;
  if (checkState === "checking") return;
  checkState = "checking";
  checkGen += 1;
  pendingRunResult = {};
  clearOutput();
  clearVerdict();
  nextBtn.hidden = true;
  hintBtn.hidden = !current.hint;
  revealBtn.hidden = true;
  checkBtn.disabled = true;

  if (!workersBooted) bootWorkersOnce();

  if (!compilerReady) {
    setVerdict(`<p class="muted">Loading compiler…</p>`, "loading");
    // Queue: retry once ready.
    const wait = setInterval(() => {
      if (compilerReady) {
        clearInterval(wait);
        dispatchCompile();
      }
    }, 100);
    return;
  }
  dispatchCompile();
}

function dispatchCompile(): void {
  if (!current) return;
  setVerdict(`<p class="muted">Checking…</p>`, "loading");
  zigWorker!.dispatch({
    kind: "run",
    requestId: String(checkGen),
    versionId: VERSION_ID,
    source: editorSource(),
    mode: current.kind === "test" ? "test" : "run",
  });
}

// ─── Hint / reveal ────────────────────────────────────────────────

hintBtn.addEventListener("click", () => {
  if (!current?.hint) return;
  setVerdict(
    (verdictEl.innerHTML ? verdictEl.innerHTML + "<hr>" : "") +
    `<div class="hint"><strong>Hint:</strong> ${esc(current.hint)}</div>`,
  );
});

revealBtn.addEventListener("click", async () => {
  if (!current) return;
  try {
    const [broken, patch] = await Promise.all([loadSource(current), loadPatch(current)]);
    const healed = applyPatch(broken, patch);
    setVerdict(
      `<p class="muted">Official solution (revealed — you already passed):</p>` +
      `<pre class="healed">${esc(healed)}</pre>`,
    );
  } catch (err) {
    setVerdict(`<p class="err">Failed to load official solution: ${esc(String(err))}</p>`, "err");
  }
});

nextBtn.addEventListener("click", goNext);
checkBtn.addEventListener("click", startCheck);

// ─── Export / Import ──────────────────────────────────────────────

function downloadJSON(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

$("export").addEventListener("click", () => {
  downloadJSON(exportFilename(), buildExport(progress, drafts));
});

$("import").addEventListener("click", () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const { progress: np, drafts: nd, backup } = importBundle(bundle, progress, drafts);
      progress = np;
      drafts = nd;
      // Auto-backup so the replace is recoverable.
      downloadJSON(`ziglings-backup-${new Date().toISOString().slice(0, 10)}.json`, backup);
      renderList();
      if (current) openExercise(current.number);
      setVerdict(`<p class="pass">Imported. A backup of your previous data was downloaded.</p>`, "pass");
    } catch (err) {
      setVerdict(`<p class="err">Import failed: ${esc(String(err))}</p>`, "err");
    }
  });
  input.click();
});

// ─── Navigation events ────────────────────────────────────────────

window.addEventListener("popstate", () => {
  const n = routeNumber();
  if (n !== null) openExercise(n);
});

// ─── Boot ─────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  try {
    catalog = await loadCatalog();
  } catch (err) {
    document.body.innerHTML = `<p class="err">Failed to load catalog: ${esc(String(err))}</p>`;
    return;
  }
  progress = loadProgress();
  drafts = loadDrafts();

  // First-visit banner (spec §5.7).
  if (!localStorage.getItem("ziglings:visited")) {
    localStorage.setItem("ziglings:visited", "1");
    setVerdict(
      `<p class="banner">Progress is stored in this browser only. To move devices, use Export/Import (top right).</p>`,
      "banner",
    );
  }

  // Boot editor with a placeholder; real doc loads on openExercise.
  bootEditor("// loading…");

  // Resolve landing exercise from URL, else first-unsolved.
  const routed = routeNumber();
  const n = routed !== null ? routed : landingNumber();
  await openExercise(n);
}

void boot();
