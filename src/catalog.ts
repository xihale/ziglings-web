// Catalog loading + lookup. The catalog is a committed static artifact at
// /vendor/ziglings/catalog.json (see scripts/sync-ziglings.mjs). Exercise
// sources live alongside it under /vendor/ziglings/.

import type { Exercise } from "./verify";

export interface Catalog {
    version: string;
    zigFloor: string;
    exercises: Exercise[];
}

let _catalog: Catalog | null = null;

/** Fetch and cache the catalog (called once at shell boot). */
export async function loadCatalog(): Promise<Catalog> {
    if (_catalog) return _catalog;
    const res = await fetch(`${import.meta.env.BASE_URL}vendor/ziglings/catalog.json`);
    if (!res.ok) throw new Error(`catalog fetch: HTTP ${res.status}`);
    _catalog = (await res.json()) as Catalog;
    return _catalog;
}

/** Find an exercise by its display number (1-based). Returns undefined if none. */
export function byNumber(catalog: Catalog, n: number): Exercise | undefined {
    return catalog.exercises.find((e) => e.number === n);
}

/**
 * Exercises sorted by number. The catalog is already sorted by sync-ziglings,
 * but enforce here so callers can rely on it.
 */
export function ordered(catalog: Catalog): Exercise[] {
    return [...catalog.exercises].sort((a, b) => a.number - b.number);
}

/** Count of runnable exercises — the denominator for the progress bar. */
export function runnableCount(catalog: Catalog): number {
    return catalog.exercises.filter((e) => e.runnable).length;
}

/** Fetch an exercise source file's text (the broken initial state). */
export async function loadSource(ex: Exercise): Promise<string> {
    const res = await fetch(`${import.meta.env.BASE_URL}vendor/ziglings/${ex.sourcePath}`);
    if (!res.ok) throw new Error(`source fetch ${ex.sourcePath}: HTTP ${res.status}`);
    return res.text();
}

/** Fetch an exercise's official patch (for the reveal-official-solution flow). */
export async function loadPatch(ex: Exercise): Promise<string> {
    const res = await fetch(`${import.meta.env.BASE_URL}vendor/ziglings/${ex.patchPath}`);
    if (!res.ok) throw new Error(`patch fetch ${ex.patchPath}: HTTP ${res.status}`);
    return res.text();
}
