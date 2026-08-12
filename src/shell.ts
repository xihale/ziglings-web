// Ziglings — course shell.
//
// Single-page app: exercise list (left) + editor (center) + verdict
// (right) + raw output (bottom). Routes by exercise number (/N/). Reuses the
// forked playground's CodeMirror + ZLS + compile/runner workers, replacing the
// playground's editor.ts entirely.
//
// See docs/superpowers/specs/2026-07-28-ziglings-web-fork-design.md §3-§5.

import { EditorState, Compartment } from "@codemirror/state";
import {
  keymap,
  EditorView,
  lineNumbers,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
} from "@codemirror/view";
import { formatDocument, LSPPlugin } from "@codemirror/lsp-client";
import { history as cmHistory, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
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
import { vim, getCM } from "@replit/codemirror-vim";
import { zigLanguage } from "@ndim/codemirror-lang-zig";
import { editorTheme, highlightStyle } from "./theme.ts";
import { fullLineSelection } from "./full-line-selection.ts";
import {
  highlightActiveLineEmptyOnly,
  highlightActiveLineGutterEmptyOnly,
} from "./active-line.ts";
import { relativeLineNumbers } from "./relative-numbers.ts";
import { lspClient, initZls } from "./lsp.ts";
import { loadVersionsManifest } from "./version.ts";
import { ZigSharedClient } from "./zig-shared-client";
import type { WorkerMsg } from "./shared-protocol";
// @ts-ignore
import RunnerWorker from "./workers/runner.ts?worker";

import {
  loadCatalog, byNumber, ordered, loadSource, loadPatch,
} from "./catalog.ts";
import type { Catalog } from "./catalog.ts";
import type { Exercise } from "./verify.ts";
import { verifyRun, type Verdict, type RunResult } from "./verify.ts";
import { applyPatch } from "./patch.ts";
import {
  loadProgress, loadDrafts, markSolved, markFailed, isSolved, isFailed,
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
// Second editor instance for the official solution (revealed on demand after
// a pass). Hidden until revealSolution() boots it.
let solutionEditor: EditorView | null = null;
let solutionRevealed = false;

// Check-flow guard: idle (no check in flight) or checking.
type CheckState = "idle" | "checking";
let checkState: CheckState = "idle";

// ─── DOM roots ────────────────────────────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const listEl = $("exercise-list");
const sidebarEl = $("sidebar");
const sidebarToggleEl = $("sidebar-toggle") as HTMLButtonElement;
const exerciseSelectEl = $("exercise-select") as HTMLSelectElement;
const settingsToggleEl = $("settings-toggle") as HTMLButtonElement;
const settingsModalEl = $("settings-modal");
const verdictEl = $("verdict");
const outputEl = $("output-pad");
const runBtn = $("run") as HTMLButtonElement;
const solutionEditorEl = $("solution-editor");
const solutionResizerEl = document.querySelector<HTMLElement>('[data-resize="solution"]');
const vimStatusEl = $("vim-status");
const vimCheckboxEl = document.getElementById("vim-toggle") as HTMLInputElement | null;

// Sidebar collapse persists across sessions. Default collapsed — the dot
// column is the primary view; labels are an on-demand expansion.
const SIDEBAR_KEY = "ziglings:sidebar-collapsed";
function loadSidebarCollapsed(): boolean {
  return localStorage.getItem(SIDEBAR_KEY) !== "0";
}
function saveSidebarCollapsed(v: boolean): void {
  localStorage.setItem(SIDEBAR_KEY, v ? "1" : "0");
}

// Vim mode persists across sessions. Opt-in — modal editing breaks input for
// non-vim users, so the default is off.
const VIM_KEY = "ziglings:vim";
function loadVim(): boolean {
  return localStorage.getItem(VIM_KEY) === "1";
}
function saveVim(v: boolean): void {
  localStorage.setItem(VIM_KEY, v ? "1" : "0");
}

// ─── Pane resizers ────────────────────────────────────────────────
// Drag the 1px hairline between panes to resize. pointerdown captures the
// pointer so the drag survives the cursor leaving the hit area; pointermove
// recomputes the width and writes a CSS var on :root. Direction sign:
//   +1 → pane grows as the cursor moves right (sidebar: resizer on its right)
//   −1 → pane grows as the cursor moves left  (context: resizer on its left)

const RESIZE_KEY = "ziglings:pane-widths";
function loadPaneWidths(): { sidebar?: number; context?: number } {
  try { return JSON.parse(localStorage.getItem(RESIZE_KEY) ?? "{}"); }
  catch { return {}; }
}
function savePaneWidths(w: { sidebar?: number; context?: number }): void {
  localStorage.setItem(RESIZE_KEY, JSON.stringify(w));
}
let paneWidths = loadPaneWidths();
// Suppress the pane width transition on first paint: without this, applying a
// saved (narrower) width animates from the CSS default 12rem → saved value,
// so the sidebar visibly shrinks on load. body.resizing kills the transition
// (see .pane-list CSS); we drop it next frame once the width has settled.
if (paneWidths.sidebar || paneWidths.context) document.body.classList.add("resizing");
if (paneWidths.sidebar) document.documentElement.style.setProperty("--sidebar-width", `${paneWidths.sidebar}px`);
if (paneWidths.context) document.documentElement.style.setProperty("--context-width", `${paneWidths.context}px`);
requestAnimationFrame(() => requestAnimationFrame(() =>
  document.body.classList.remove("resizing")));

/** px resizer: writes a px width. `dir` flips which way drag grows the pane. */
function initPxResizer(
  resizer: HTMLElement,
  dir: 1 | -1,
  cssVar: string,
  start: () => number,
  clamp: (v: number) => number,
  onCommit?: (v: number) => void,
): void {
  resizer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add("dragging");
    document.body.classList.add("resizing");   // suppress pane width transition
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const startX = e.clientX;
    const startV = start();
    const onMove = (ev: PointerEvent) => {
      const next = clamp(startV + dir * (ev.clientX - startX));
      document.documentElement.style.setProperty(cssVar, `${next}px`);
    };
    const onUp = () => {
      resizer.releasePointerCapture(e.pointerId);
      resizer.classList.remove("dragging");
      document.body.classList.remove("resizing");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      const final = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(cssVar)) || startV;
      onCommit?.(final);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

// Sidebar resizer: drag right → wider. Inert while collapsed (fixed column).
const sidebarResizer = document.querySelector<HTMLElement>('[data-resize="sidebar"]');
if (sidebarResizer) {
  initPxResizer(
    sidebarResizer, 1, "--sidebar-width",
    () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width")) || 192,
    (v) => Math.max(96, Math.min(320, v)),     // 6rem .. 20rem
    (v) => { paneWidths.sidebar = v; savePaneWidths(paneWidths); },
  );
}

// Context resizer: drag left → wider (resizer sits on the context's left).
const contextResizer = document.querySelector<HTMLElement>('[data-resize="context"]');
if (contextResizer) {
  initPxResizer(
    contextResizer, -1, "--context-width",
    () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--context-width")) || 360,
    (v) => Math.max(260, Math.min(560, v)),    // 260px .. 560px
    (v) => { paneWidths.context = v; savePaneWidths(paneWidths); },
  );
}

// Solution resizer: % split between editor (left) and solution (right)
// inside .pane-editor. Drag right → editor wider.
if (solutionResizerEl) {
  solutionResizerEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    solutionResizerEl.setPointerCapture(e.pointerId);
    solutionResizerEl.classList.add("dragging");
    document.body.classList.add("resizing");
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const parent = solutionResizerEl.parentElement!;
    const parentWidth = parent.getBoundingClientRect().width;
    const startX = e.clientX;
    const editorEl = document.getElementById("editor")!;
    const startPct = (editorEl.getBoundingClientRect().width / parentWidth) * 100;
    const onMove = (ev: PointerEvent) => {
      const next = Math.max(25, Math.min(75, startPct + ((ev.clientX - startX) / parentWidth) * 100));
      editorEl.style.flex = `0 0 ${next}%`;
      (document.getElementById("solution-editor")!).style.flex = `1 1 ${100 - next}%`;
    };
    const onUp = () => {
      solutionResizerEl.releasePointerCapture(e.pointerId);
      solutionResizerEl.classList.remove("dragging");
      document.body.classList.remove("resizing");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

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

// ─── Left list rendering (status dots) ────────────────────────────
// Dot colour: green=solved · red=failed · grey=not-runnable · white=pending.
// The exercise prompt lives in the editor's leading comment now, so the list
// only shows a status dot (+ label when the sidebar is expanded).

function renderList(): void {
  listEl.replaceChildren();
  for (const ex of ordered(catalog)) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "ex-dot";
    if (current && ex.number === current.number) row.classList.add("current");
    if (isSolved(progress, ex.slug)) row.classList.add("solved");
    else if (!ex.runnable) row.classList.add("not-runnable");
    else if (isFailed(progress, ex.slug)) row.classList.add("failed");
    // Native title tooltip — works in both collapsed & expanded, zero JS positioning.
    row.title = `${String(ex.number).padStart(3, "0")} ${ex.name}` +
      (!ex.runnable ? ` (not runnable)` : "");

    const label = document.createElement("span");
    label.className = "ex-label";
    label.textContent = `${String(ex.number).padStart(3, "0")} ${ex.name}`;
    row.append(label);
    row.addEventListener("click", () => openExercise(ex.number));
    listEl.appendChild(row);
  }
  // Keep the current row in view: navigating via the top-bar <select> or
  // browser history can land on an exercise scrolled off the visible list.
  const cur = listEl.querySelector<HTMLElement>(".ex-dot.current");
  cur?.scrollIntoView({ block: "nearest" });
}

// ─── Verdict rendering ────────────────────────────────────────────
// A verdict is a small declarative view: a status class (for colour), a list
// of HTML body parts, an optional follow-up action row, and an optional hint.
// Everything renders through renderVerdict(), so follow-ups (Hint, Reveal,
// Next) always travel together — no innerHTML string-concat that silently
// drops the buttons it just rendered (the bug this replaces had).

type VerdictAction = { label: string; fn: () => void };
type VerdictView = { cls?: string; parts?: string[]; actions?: VerdictAction[]; hint?: string };

// The last view handed to renderVerdict. showHint() re-emits it with a hint
// folded in, so actions (Next, Reveal) survive — no DOM-scraping rebuild.
let lastVerdict: VerdictView = {};

function renderVerdict(v: VerdictView): void {
  lastVerdict = v;
  verdictEl.className = `verdict-box ${v.cls ?? ""}`;
  const frag = document.createDocumentFragment();
  for (const html of v.parts ?? []) {
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    frag.append(...wrap.childNodes);
  }
  if (v.hint) {
    const h = document.createElement("div");
    h.className = "hint";
    h.innerHTML = `<strong>Hint:</strong> ${esc(v.hint)}`;
    frag.append(h);
  }
  if (v.actions && v.actions.length > 0) {
    const row = document.createElement("div");
    row.className = "verdict-actions";
    for (const a of v.actions) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = a.label;
      b.addEventListener("click", a.fn);
      row.append(b);
    }
    frag.append(row);
  }
  verdictEl.replaceChildren(frag);
}

function clearVerdict(): void {
  lastVerdict = {};
  verdictEl.className = "verdict-box";
  verdictEl.replaceChildren();
}

// Run button reflects the check state machine: idle (ready) / busy
// (yellow + spinner) / ok (green) / err (red). A `disabled` runBtn stays
// dimmed for not-runnable exercises regardless of state class.
// On pass, the button flips to "Next" mode (still green) whose verb is
// goNext(); openExercise / a new run flips it back to Run.
type RunState = "idle" | "busy" | "ok" | "err";
let runMode: "run" | "next" = "run";
function setRunState(state: RunState): void {
  runBtn.classList.toggle("busy", state === "busy");
  runBtn.classList.toggle("ok", state === "ok");
  runBtn.classList.toggle("err", state === "err");
  if (state === "busy") runBtn.title = "Running…";
  else if (state === "err") runBtn.title = "Failed";
  else if (runMode === "next") runBtn.title = "Next exercise (F10)";
  else if (state === "ok") runBtn.title = "Passed";
  else runBtn.title = "Run (F10)";
}
/** Flip the top-bar button into "Next" mode after a pass. */
function setRunNext(): void {
  runMode = "next";
  runBtn.replaceChildren(document.createTextNode("Next"));
  runBtn.title = "Next exercise (F10)";
}
/** Restore the button to its normal "Run" verb (called on openExercise).
 *  Rebuilds the spinner span that the busy state animates. */
function resetRunMode(): void {
  if (runMode === "run") return;
  runMode = "run";
  const spinner = document.createElement("span");
  spinner.className = "run-spinner";
  spinner.setAttribute("aria-hidden", "true");
  runBtn.replaceChildren(spinner, document.createTextNode("Run"));
}

/** Expected-output preview for output_mismatch.
 *
 *  The learner's actual output is already in the output pane below (yellow
 *  stdout), so the verdict only shows the expected output here — no duplicate
 *  "Yours" column, no side-by-side table. Just the expected text as a bare
 *  mono block, the same quiet voice as the rest of the verdict. `actual` is
 *  unused; kept on the signature so the caller (and any future caller) reads
 *  naturally. */
function renderExpected(expected: string, _actual?: string): string {
  return `<pre class="expected">${esc(expected)}</pre>`;
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
      renderVerdict({ cls: "err", parts: [`<p class="err">Compiler failed to load: ${esc(msg.error)}</p>`] });
      checkState = "idle";
      runBtn.disabled = current ? !current.runnable : false;
      setRunState("err");
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

/** The pass verdict: just "Passed". The official solution auto-reveals
 *  beside the learner's code (finishCheck calls revealSolution()), so there's
 *  no follow-up button — navigation is via the sidebar / top-bar <select>. */
function renderPassVerdict(): void {
  renderVerdict({
    cls: "pass",
    parts: [`<p class="pass">Passed</p>`],
  });
}

function finishCheck(v: Verdict): void {
  checkState = "idle";
  runBtn.disabled = current ? !current.runnable : false;
  if (v.status === "pass" && current) {
    progress = markSolved(progress, current.slug); // also clears failed
    renderList();
    renderPassVerdict();
    revealSolution();   // auto-show the official solution beside the code
    setRunState("ok");
    setRunNext();       // the Run button becomes "Next"
  } else if (v.status === "fail" && current) {
    progress = markFailed(progress, current.slug); // dot turns red
    renderList();
    if (v.failKind === "compile") {
      renderVerdict({
        cls: "err",
        parts: [
          `<p class="err">Compile error</p>`,
          `<p class="muted">Read the compiler output below — that's the exercise.</p>`,
        ],
        actions: current.hint ? [{ label: "Hint", fn: showHint }] : [],
      });
    } else if (v.failKind === "run") {
      const label = current.kind === "test" ? "Tests failed" : "Run failed";
      renderVerdict({
        cls: "err",
        parts: [`<p class="err">${label} (exit ${v.exitCode ?? "?"})</p>`],
        actions: current.hint ? [{ label: "Hint", fn: showHint }] : [],
      });
    } else if (v.failKind === "output_mismatch" && v.expected !== undefined && v.actual !== undefined) {
      renderVerdict({
        cls: "err",
        parts: [`<p class="err">Output mismatch</p>`, `<p class="muted">Expected:</p>`, renderExpected(v.expected, v.actual)],
        actions: current.hint ? [{ label: "Hint", fn: showHint }] : [],
      });
    }
    setRunState("err");
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
  exerciseSelectEl.value = String(ex.number);
  clearOutput();
  clearVerdict();
  hideSolution();   // new exercise closes any revealed solution
  runBtn.disabled = !ex.runnable;
  // New exercise resets the check state machine to idle and the button
  // back to its "Run" verb (it may have become "Next" on the previous pass).
  checkState = "idle";
  resetRunMode();
  setRunState("idle");

  // Source: draft if any, else the broken initial source.
  let source = getDraft(drafts, ex.slug);
  if (source === undefined) {
    try {
      source = await loadSource(ex);
    } catch (err) {
      renderVerdict({ cls: "err", parts: [`<p class="err">Failed to load source: ${esc(String(err))}</p>`] });
      return;
    }
  }

  replaceDoc(source);

  if (!ex.runnable) {
    renderVerdict({
      cls: "banner",
      parts: [
        `<p class="banner">This exercise needs a local Zig environment` +
        ` (reason: <code>${ex.notRunnableReason ?? "unknown"}</code>).` +
        ` Complete it locally via <code>git clone</code> of Ziglings.</p>`,
      ],
    });
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
  // lineNumbers() is added per-editor (see lineNumberCompartment below) so the
  // main editor can swap absolute ↔ relative when vim toggles; the
  // solution/editor keeps plain absolute numbering.
  highlightActiveLineGutterEmptyOnly(),
  highlightSpecialChars(),
  cmHistory(),
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

// Compartment so vim can be toggled at runtime without rebuilding the editor
// (preserves doc + selection). Reconfigure with vim() or [] to enable/disable.
// The always-on active-line extensions layer on top of the EmptyOnly variant
// in playgroundSetup so the caret row stays highlighted during j/k motion and
// in visual mode (where selections are non-empty and EmptyOnly suppresses).
const vimCompartment = new Compartment();
let vimOn = loadVim();

// Line numbers live in their own compartment so toggling vim swaps the whole
// gutter: relative (caret row = 0, vim-style) when vim is on, plain absolute
// otherwise. Reconfiguring rebuilds the gutter, so the format flips cleanly.
const lineNumberCompartment = new Compartment();
const lineNumberExt = (on: boolean) => on ? relativeLineNumbers() : lineNumbers();

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
          { key: "Mod-s", preventDefault: true, run: formatDocument },
        ]),
        zigLanguage,
        syntaxHighlighting(highlightStyle),
        lspClient.plugin("file:///main.zig"),
        lineNumberCompartment.of(lineNumberExt(vimOn)),
        vimCompartment.of(vimOn ? [vim(), highlightActiveLine(), highlightActiveLineGutter()] : []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) scheduleDraftSave();
        }),
      ],
    }),
  });
  // The LSP plugin starts talking (initialize) the moment it mounts. Boot
  // ZLS now so its worker loads and drains buffered requests before the
  // client's request timeout fires.
  bootZlsOnce();
  applyVim();
}

// ─── Vim mode ─────────────────────────────────────────────────────

// @replit/codemirror-vim emits "vim-mode-change" on the CodeMirror 5 view
// adapter (retrieved via getCM). We render the current mode in a status bar
// under the editor so modal state is visible.
function bindVimStatus(): void {
  const cm = getCM(editor);
  if (!cm) return;
  cm.on("vim-mode-change", (e: { mode: string; subMode?: string }) => {
    const label =
      e.mode === "insert" ? "INSERT" :
      e.mode === "visual" ? "VISUAL" :
      e.mode === "replace" ? "REPLACE" :
      "NORMAL";
    vimStatusEl.textContent = `-- ${label} --`;
  });
}

function toggleVim(on: boolean): void {
  if (on === vimOn) return;
  vimOn = on;
  saveVim(on);
  editor.dispatch({
    effects: [
      vimCompartment.reconfigure(
        on ? [vim(), highlightActiveLine(), highlightActiveLineGutter()] : [],
      ),
      // Swap the gutter alongside the keybindings: relative numbers only make
      // sense with modal motion.
      lineNumberCompartment.reconfigure(lineNumberExt(on)),
    ],
  });
  applyVim();
}

// Sync checkbox state + status-bar visibility with the current vimOn flag.
// Called both at boot (after the editor exists) and after a toggle.
function applyVim(): void {
  vimStatusEl.hidden = !vimOn;
  vimStatusEl.textContent = vimOn ? "-- NORMAL --" : "";
  if (vimCheckboxEl) vimCheckboxEl.checked = vimOn;
  if (vimOn) bindVimStatus();
}

// ─── Check button ─────────────────────────────────────────────────

function startCheck(): void {
  if (!current || !current.runnable) return;
  if (checkState === "checking") return;
  checkState = "checking";
  checkGen += 1;
  clearOutput();
  clearVerdict();
  hideSolution();
  runBtn.disabled = true;
  setRunState("busy");

  if (!workersBooted) bootWorkersOnce();

  if (!compilerReady) {
    renderVerdict({ cls: "loading", parts: [`<p class="muted">Loading compiler…</p>`] });
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
  renderVerdict({ cls: "loading", parts: [`<p class="muted">Checking…</p>`] });
  zigWorker!.dispatch({
    kind: "run",
    requestId: String(checkGen),
    versionId: VERSION_ID,
    source: editorSource(),
    mode: current.kind === "test" ? "test" : "run",
  });
}

// ─── Verdict follow-up actions (hint / reveal / next) ────────────
// These live inside the verdict itself — they only make sense as a
// follow-up to a verdict, not as persistent chrome. renderVerdict()
// wires them as a button row beneath the status line.

/** Re-render the last verdict with the hint folded in. The Hint action
 *  itself is dropped — once the hint is visible the button is pointless,
 *  and re-emitting it produced a second "dead" Hint button that did nothing
 *  when clicked (the view was already in its hint-shown state). Other
 *  follow-up actions (Next, Reveal) are preserved. */
function showHint(): void {
  if (!current?.hint) return;
  const { actions, ...rest } = lastVerdict;
  const keep = (actions ?? []).filter((a) => a.label !== "Hint");
  renderVerdict({ ...rest, hint: current.hint, ...(keep.length ? { actions: keep } : {}) });
}

/** Reveal the official-solution editor beside the learner's code. Loads the
 *  healed source on first reveal; the editor is then kept around (read-only). */
async function revealSolution(): Promise<void> {
  if (!current || solutionRevealed) return;
  let healed: string;
  try {
    const [broken, patch] = await Promise.all([loadSource(current), loadPatch(current)]);
    healed = applyPatch(broken, patch);
  } catch (err) {
    renderVerdict({ cls: "err", parts: [`<p class="err">Failed to load official solution: ${esc(String(err))}</p>`] });
    return;
  }
  if (!solutionEditor) bootSolutionEditor();
  solutionEditor!.dispatch({ changes: { from: 0, to: solutionEditor!.state.doc.length, insert: healed } });
  solutionEditorEl.hidden = false;
  if (solutionResizerEl) solutionResizerEl.hidden = false;
  solutionRevealed = true;
}

/** Hide the solution editor + resizer (used when switching exercises). */
function hideSolution(): void {
  if (solutionEditorEl) solutionEditorEl.hidden = true;
  if (solutionResizerEl) solutionResizerEl.hidden = true;
  solutionRevealed = false;
}

function bootSolutionEditor(): void {
  solutionEditor = new EditorView({
    parent: solutionEditorEl,
    state: EditorState.create({
      doc: "",
      extensions: [
        playgroundSetup,
        lineNumbers(),
        editorTheme,
        indentUnit.of("    "),
        EditorState.readOnly.of(true),
        zigLanguage,
        syntaxHighlighting(highlightStyle),
      ],
    }),
  });
}

// The top-bar verb button: Run by default, but "Next" after a pass.
runBtn.addEventListener("click", () => {
  if (runMode === "next") goNext();
  else startCheck();
});

// F10 = the Run/Next verb button: runs the check, and once an exercise
// passes (the button flips to "Next"), F10 advances to the next exercise.
document.addEventListener("keydown", (e) => {
  if (e.key === "F10") { e.preventDefault(); runBtn.click(); }
});

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
      renderVerdict({ cls: "pass", parts: [`<p class="pass">Imported. A backup of your previous data was downloaded.</p>`] });
    } catch (err) {
      renderVerdict({ cls: "err", parts: [`<p class="err">Import failed: ${esc(String(err))}</p>`] });
    } finally {
      closeSettings();
    }
  });
  input.click();
});

// ─── Exercise dropdown (top bar) + settings menu + sidebar collapse ─

/** Populate the top-bar <select> with every exercise. Called once at boot. */
function populateExerciseSelect(): void {
  exerciseSelectEl.replaceChildren();
  for (const ex of ordered(catalog)) {
    const opt = document.createElement("option");
    opt.value = String(ex.number);
    opt.textContent = `${String(ex.number).padStart(3, "0")} ${ex.name}`;
    exerciseSelectEl.appendChild(opt);
  }
}

exerciseSelectEl.addEventListener("change", () => {
  const n = parseInt(exerciseSelectEl.value, 10);
  if (Number.isFinite(n) && n > 0) openExercise(n);
});

// Settings modal — open from the ⚙ segment, close on ✕ / backdrop click / Escape.
// Focus management: opening moves focus to the close button; closing restores it
// to the toggle so the user returns to where they entered.
function openSettings(): void {
  settingsModalEl.hidden = false;
  (settingsModalEl.querySelector(".modal-close") as HTMLButtonElement | null)?.focus();
}
function closeSettings(): void {
  if (settingsModalEl.hidden) return;
  settingsModalEl.hidden = true;
  settingsToggleEl.focus();
}
settingsToggleEl.addEventListener("click", (e) => {
  e.stopPropagation();
  if (settingsModalEl.hidden) openSettings(); else closeSettings();
});
settingsModalEl.addEventListener("click", (e) => {
  if ((e.target as Element).closest("[data-close]")) closeSettings();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !settingsModalEl.hidden) closeSettings();
});

// Vim mode toggle — persisted, applied live via compartment reconfigure.
vimCheckboxEl?.addEventListener("change", () => {
  toggleVim(vimCheckboxEl.checked);
});

// Sidebar collapse — persisted. Toggle button flips the .collapsed class.
// The toggle shows a direction chevron that points where the list will go:
// ‹ when expanded (click collapses toward the left),
// › when collapsed (click expands toward the right).
function applySidebarCollapsed(): void {
  const collapsed = loadSidebarCollapsed();
  sidebarEl.classList.toggle("collapsed", collapsed);
  // Keep <html> in sync with the inline head script that set the initial
  // state before first paint — both class hooks drive the same CSS rules.
  document.documentElement.classList.toggle("sidebar-collapsed", collapsed);
  sidebarToggleEl.textContent = collapsed ? "›" : "‹";
  sidebarToggleEl.setAttribute(
    "aria-label",
    collapsed ? "Expand exercise list" : "Collapse exercise list",
  );
}
sidebarToggleEl.addEventListener("click", () => {
  const next = !loadSidebarCollapsed();
  saveSidebarCollapsed(next);
  applySidebarCollapsed();
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
    renderVerdict({
      cls: "banner",
      parts: [`<p class="banner">Progress lives only in this browser. Move devices via Export/Import (⚙ menu).</p>`],
    });
  }

  populateExerciseSelect();
  applySidebarCollapsed();

  // Boot editor with a placeholder; real doc loads on openExercise.
  bootEditor("// loading…");

  // Resolve landing exercise from URL, else first-unsolved.
  const routed = routeNumber();
  const n = routed !== null ? routed : landingNumber();
  await openExercise(n);
}

void boot();
