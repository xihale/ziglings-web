// Progress + draft persistence in localStorage. Two keys (spec §5.1):
//   ziglings:progress  → { version, ziglingsCommit, solved: { [slug]: ISO } }
//   ziglings:drafts    → { version, drafts: { [slug]: sourceString } }
//
// Solved-flag is keyed by slug (stable cross-version) so a Ziglings bump needs
// no migration table (§5.6). Drafts are plain strings; only edited exercises
// get an entry (lazy).

const PROGRESS_KEY = "ziglings:progress";
const DRAFTS_KEY = "ziglings:drafts";

export interface Progress {
    version: 1;
    ziglingsCommit: string;
    solved: Record<string, string>; // slug → ISO timestamp
}

export interface Drafts {
    version: 1;
    drafts: Record<string, string>; // slug → source
}

const EMPTY_PROGRESS: Progress = { version: 1, ziglingsCommit: "", solved: {} };
const EMPTY_DRAFTS: Drafts = { version: 1, drafts: {} };

function readJSON<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

function writeJSON(key: string, value: unknown): void {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Private mode / quota — ignore; in-memory state still works this session.
    }
}

// ─── Progress ─────────────────────────────────────────────────────

export function loadProgress(): Progress {
    return readJSON<Progress>(PROGRESS_KEY, EMPTY_PROGRESS);
}

export function saveProgress(p: Progress): void {
    writeJSON(PROGRESS_KEY, p);
}

export function isSolved(p: Progress, slug: string): boolean {
    return Object.prototype.hasOwnProperty.call(p.solved, slug);
}

/** Mark a slug solved (idempotent — timestamp updates only if not already solved). */
export function markSolved(p: Progress, slug: string): Progress {
    if (isSolved(p, slug)) return p;
    const next: Progress = {
        ...p,
        solved: { ...p.solved, [slug]: new Date().toISOString() },
    };
    saveProgress(next);
    return next;
}

export function solvedCount(p: Progress): number {
    return Object.keys(p.solved).length;
}

// ─── Drafts ───────────────────────────────────────────────────────

export function loadDrafts(): Drafts {
    return readJSON<Drafts>(DRAFTS_KEY, EMPTY_DRAFTS);
}

export function saveDrafts(d: Drafts): void {
    writeJSON(DRAFTS_KEY, d);
}

export function getDraft(d: Drafts, slug: string): string | undefined {
    return d.drafts[slug];
}

/** Write a draft for one slug (lazy — creates the entry only on edit). */
export function setDraft(d: Drafts, slug: string, source: string): Drafts {
    const next: Drafts = { ...d, drafts: { ...d.drafts, [slug]: source } };
    saveDrafts(next);
    return next;
}

// ─── Export / Import (manual sync, §5.5) ──────────────────────────

export interface ExportBundle {
    format: "ziglings-progress";
    formatVersion: 1;
    exportedAt: string;
    progress: Progress;
    drafts: Drafts;
}

export function buildExport(progress: Progress, drafts: Drafts): ExportBundle {
    return {
        format: "ziglings-progress",
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        progress,
        drafts,
    };
}

export function exportFilename(): string {
    const d = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return `ziglings-progress-${d}.json`;
}

/**
 * Full-replace import. Before replacing, snapshot the current local data into
 * a downloadable backup so the replace is recoverable (§5.5).
 *
 * Returns the new { progress, drafts } to install + a backup blob for download.
 */
export function importBundle(
    bundle: unknown,
    currentProgress: Progress,
    currentDrafts: Drafts,
): { progress: Progress; drafts: Drafts; backup: ExportBundle } {
    const b = bundle as Partial<ExportBundle>;
    if (!b || b.format !== "ziglings-progress" || b.formatVersion !== 1) {
        throw new Error("not a ziglings-progress export (format mismatch)");
    }
    const backup = buildExport(currentProgress, currentDrafts);
    const progress: Progress =
        b.progress && b.progress.version === 1
            ? { version: 1, ziglingsCommit: b.progress.ziglingsCommit ?? "", solved: b.progress.solved ?? {} }
            : EMPTY_PROGRESS;
    const drafts: Drafts =
        b.drafts && b.drafts.version === 1
            ? { version: 1, drafts: b.drafts.drafts ?? {} }
            : EMPTY_DRAFTS;
    saveProgress(progress);
    saveDrafts(drafts);
    return { progress, drafts, backup };
}
