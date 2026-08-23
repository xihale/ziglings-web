// Progress + draft persistence in localStorage. Two keys (spec §5.1):
//   ziglings:progress  → { version, ziglingsCommit, solved: { [slug]: ISO }, failed: { [slug]: ISO } }
//   ziglings:drafts    → { version, drafts: { [slug]: sourceString } }
//
// Solved/failed flags are keyed by slug (stable cross-version) so a Ziglings
// bump needs no migration table (§5.6). Drafts are plain strings; only edited
// exercises get an entry (lazy).
//
// version 2 added `failed` (additive — loadProgress backfills it to {} for old
// blobs, so existing users see no change).

const PROGRESS_KEY = "ziglings:progress";
const DRAFTS_KEY = "ziglings:drafts";

export interface Progress {
    version: 2;
    ziglingsCommit: string;
    solved: Record<string, string>; // slug → ISO timestamp
    failed: Record<string, string>; // slug → ISO timestamp (last attempt failed)
}

export interface Drafts {
    version: 1;
    drafts: Record<string, string>; // slug → source
}

/**
 * Doc the editor boots with before the first exercise loads (shell.ts
 * bootEditor). It must never survive as a draft: if the source fetch fails,
 * a keystroke on the placeholder would otherwise persist it for that slug,
 * and the exercise would open on "// loading…" forever after.
 */
export const BOOT_PLACEHOLDER = "// loading…";

/** Drop placeholder-equal drafts (repairs already-poisoned localStorage). */
function sanitizeDrafts(d: Partial<Drafts> | undefined): Drafts {
    const drafts: Record<string, string> = {};
    for (const [slug, src] of Object.entries(d?.drafts ?? {})) {
        if (src !== BOOT_PLACEHOLDER) drafts[slug] = src as string;
    }
    return { version: 1, drafts };
}

const EMPTY_PROGRESS: Progress = { version: 2, ziglingsCommit: "", solved: {}, failed: {} };
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

/** Load + additive migrate: backfill `failed` for v1 blobs. */
export function loadProgress(): Progress {
    const raw = readJSON<Partial<Progress>>(PROGRESS_KEY, EMPTY_PROGRESS);
    return {
        version: 2,
        ziglingsCommit: raw.ziglingsCommit ?? "",
        solved: raw.solved ?? {},
        failed: raw.failed ?? {},
    };
}

export function saveProgress(p: Progress): void {
    writeJSON(PROGRESS_KEY, p);
}

export function isSolved(p: Progress, slug: string): boolean {
    return Object.prototype.hasOwnProperty.call(p.solved, slug);
}

export function isFailed(p: Progress, slug: string): boolean {
    return Object.prototype.hasOwnProperty.call(p.failed, slug);
}

/** Mark a slug solved; also clears any prior failed flag (solved wins). */
export function markSolved(p: Progress, slug: string): Progress {
    if (isSolved(p, slug) && !isFailed(p, slug)) return p;
    const { [slug]: _drop, ...restFailed } = p.failed;
    const next: Progress = {
        ...p,
        solved: { ...p.solved, [slug]: new Date().toISOString() },
        failed: restFailed,
    };
    saveProgress(next);
    return next;
}

/** Mark a slug failed (idempotent — timestamp updates each failed attempt). */
export function markFailed(p: Progress, slug: string): Progress {
    const next: Progress = {
        ...p,
        failed: { ...p.failed, [slug]: new Date().toISOString() },
    };
    saveProgress(next);
    return next;
}

export function solvedCount(p: Progress): number {
    return Object.keys(p.solved).length;
}

// ─── Drafts ───────────────────────────────────────────────────────

export function loadDrafts(): Drafts {
    return sanitizeDrafts(readJSON<Partial<Drafts>>(DRAFTS_KEY, EMPTY_DRAFTS));
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
    // Accept v1 (no failed) and v2 blobs alike — additive migration.
    const progress: Progress =
        b.progress
            ? {
                  version: 2,
                  ziglingsCommit: b.progress.ziglingsCommit ?? "",
                  solved: b.progress.solved ?? {},
                  failed: b.progress.failed ?? {},
              }
            : EMPTY_PROGRESS;
    const drafts: Drafts =
        b.drafts && b.drafts.version === 1
            ? sanitizeDrafts(b.drafts)
            : EMPTY_DRAFTS;
    saveProgress(progress);
    saveDrafts(drafts);
    return { progress, drafts, backup };
}
