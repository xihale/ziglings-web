/**
 * Relative line numbers for Vim mode.
 *
 * The caret row reads 0; every other row shows its distance from the caret
 * (1, 2, 3 … above and below) — the standard vim `relativenumber` look that
 * makes `5j` / `3k` motions easy to aim.
 *
 * CodeMirror's built-in lineNumbers() only re-renders its gutter when the
 * document, viewport, or the lineNumberConfig facet changes — NOT on plain
 * cursor movement. So a formatNumber returning relative offsets would go stale
 * the moment you press j/k. This is a custom gutter whose lineMarkerChange
 * fires on selectionSet, forcing the numbers to recompute as the caret moves.
 *
 * Reuses the `cm-lineNumbers` class so it inherits the gutter's width/padding
 * from the theme, and an initialSpacer (9/99/999 by total line count) keeps the
 * column as wide as the absolute gutter — toggling vim never resizes it.
 */
import type { EditorState } from "@codemirror/state";
import { gutter, GutterMarker, type EditorView, type Extension } from "@codemirror/view";

class NumberMarker extends GutterMarker {
  constructor(readonly text: string) {
    super();
  }
  eq(other: NumberMarker): boolean {
    return this.text === other.text;
  }
  toDOM(): Node {
    return document.createTextNode(this.text);
  }
}

/** Widest number that could appear (all 9s, same digit count as line count):
 *  reserves a stable gutter width for both absolute and relative display. */
function widest(lines: number): string {
  let n = 9;
  while (n < lines) n = n * 10 + 9;
  return String(n);
}

/** Line number of the primary selection's head — the reference row. */
function caretLine(state: EditorState): number {
  return state.doc.lineAt(state.selection.main.head).number;
}

export function relativeLineNumbers(): Extension {
  return gutter({
    class: "cm-lineNumbers",
    renderEmptyElements: false,
    lineMarker(view: EditorView, line) {
      const no = view.state.doc.lineAt(line.from).number;
      const caret = caretLine(view.state);
      // The caret row shows its absolute line number; every other row shows
      // its distance from the caret (1, 2, 3 … above and below).
      return new NumberMarker(no === caret ? String(no) : String(Math.abs(no - caret)));
    },
    // Re-render whenever the caret moves (the whole point — without this the
    // built-in gutter skips selection-only updates and numbers go stale).
    lineMarkerChange: (u) => u.selectionSet || u.docChanged || u.viewportChanged,
    initialSpacer: (view) => new NumberMarker(widest(view.state.doc.lines)),
    updateSpacer: (spacer, update) => {
      const max = widest(update.state.doc.lines);
      return spacer instanceof NumberMarker && spacer.text === max
        ? spacer
        : new NumberMarker(max);
    },
  });
}
