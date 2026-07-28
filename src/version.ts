/**
 * Multi-version compiler routing.
 *
 * Path rules (see docs/superpowers/specs/2026-07-26-multi-version-compilers-design.md):
 *   /              → versions.default (currently 0.16.0)
 *   /0.16.0/       → id "0.16.0"
 *   /0.15.2/       → id "0.15.2"
 *   /master/       → id "master"
 *
 * Compiler binaries live at /compilers/<id>/… (never git).
 */

import manifestJson from "../versions.json";

export type VersionEntry = {
  id: string;
  label: string;
  schedule?: string;
};

export type VersionsManifest = {
  default: string;
  /**
   * Optional absolute origin serving /compilers/<id>/… If present, compiler
   * assets are fetched cross-origin from here (spec §6.3: reuse the
   * playground's deployed compiler assets rather than self-building wasm).
   */
  assetOrigin?: string;
  versions: VersionEntry[];
};

export type ResolvedVersion = {
  id: string;
  entry: VersionEntry;
  /** True when URL had no version segment and we used `default`. */
  fromDefault: boolean;
  manifest: VersionsManifest;
};

function validateManifest(data: VersionsManifest): VersionsManifest {
  if (!data?.default || !Array.isArray(data.versions) || data.versions.length === 0) {
    throw new Error("versions.json: missing default/versions");
  }
  const ids = new Set(data.versions.map((v) => v.id));
  if (!ids.has(data.default)) {
    throw new Error(`versions.json: default "${data.default}" not in versions`);
  }
  return data;
}

const bundledManifest = validateManifest(manifestJson as VersionsManifest);

/** Sync access to the shipped manifest (bundled at build time). */
export function loadVersionsManifest(): VersionsManifest {
  return bundledManifest;
}

/** Strip Vite deploy base (usually `/`; subpath only if VITE_BASE is set) so the first remaining segment can be a version id. */
function pathAfterBase(pathname: string): string {
  const base = import.meta.env.BASE_URL || "/";
  if (base === "/") return pathname;
  const prefix = base.replace(/\/$/, "");
  if (pathname === prefix || pathname.startsWith(prefix + "/")) {
    const rest = pathname.slice(prefix.length);
    return rest.startsWith("/") ? rest : `/${rest}`;
  }
  return pathname;
}

/** First non-empty path segment after the deploy base. */
export function pathVersionSegment(pathname: string = location.pathname): string | null {
  const parts = pathAfterBase(pathname).split("/").filter(Boolean);
  return parts[0] ?? null;
}

export function resolveVersion(
  manifest: VersionsManifest,
  pathname: string = location.pathname,
): ResolvedVersion {
  const segment = pathVersionSegment(pathname);
  const byId = new Map(manifest.versions.map((v) => [v.id, v]));

  if (segment && byId.has(segment)) {
    const entry = byId.get(segment)!;
    return { id: entry.id, entry, fromDefault: false, manifest };
  }

  const entry = byId.get(manifest.default)!;
  return { id: entry.id, entry, fromDefault: true, manifest };
}

/** Canonical path for a version id (respects Vite `base` / project Pages). */
export function pathForVersion(id: string, manifest: VersionsManifest): string {
  const base = import.meta.env.BASE_URL || "/";
  const root = base.endsWith("/") ? base : `${base}/`;
  if (id === manifest.default) return root;
  return `${root}${id}/`;
}

/** Absolute URL prefix for compiler assets of a version. */
export function compilerAssetBase(versionId: string): string {
  // Prefer the cross-origin asset origin (spec §6.3) when the manifest
  // declares one; otherwise fall back to this site's own /compilers/<id>/.
  const manifest = loadVersionsManifest();
  const origin = manifest.assetOrigin;
  if (origin) {
    const root = origin.endsWith("/") ? origin : `${origin}/`;
    return `${root}compilers/${versionId}/`;
  }
  const base = import.meta.env.BASE_URL || "/";
  const root = base.endsWith("/") ? base : `${base}/`;
  return `${root}compilers/${versionId}/`;
}

export function compilerAssetUrl(versionId: string, file: string): string {
  return `${compilerAssetBase(versionId)}${file}`;
}

/**
 * HTTP Cache-Control for `/compilers/<id>/*` (vite preview / hosts that honor it).
 *
 * Client Cache Storage (`compiler-cache.ts`) keys large assets by `meta.builtAt`.
 * Meta is re-probed on a timer — for rolling trees, half of `schedule` (master
 * `3d` → recheck every ~1.5d), not on every page load.
 *
 * - Stable pins (no `schedule`): long-lived + immutable
 * - Rolling ids (`schedule: "3d"`): a few days, not immutable (same path rebuilds)
 */
export type CompilerCachePolicy =
  | { kind: "immutable"; maxAgeSeconds: number }
  | { kind: "max-age"; maxAgeSeconds: number };

const STABLE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60; // 1y ≈ permanent for release trees
const DEFAULT_ROLLING_SECONDS = 3 * 24 * 60 * 60; // 3d

/** Parse `versions.json` schedule strings like `3d`, `12h`, `90m`. */
export function parseScheduleSeconds(schedule: string): number {
  const m = /^(\d+)\s*([dhms])$/i.exec(schedule.trim());
  if (!m) return DEFAULT_ROLLING_SECONDS;
  const n = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case "d":
      return n * 86400;
    case "h":
      return n * 3600;
    case "m":
      return n * 60;
    case "s":
      return n;
    default:
      return DEFAULT_ROLLING_SECONDS;
  }
}

export function compilerCachePolicy(versionId: string): CompilerCachePolicy {
  const entry = loadVersionsManifest().versions.find((v) => v.id === versionId);
  if (entry?.schedule) {
    return { kind: "max-age", maxAgeSeconds: parseScheduleSeconds(entry.schedule) };
  }
  return { kind: "immutable", maxAgeSeconds: STABLE_MAX_AGE_SECONDS };
}

/**
 * How often to re-fetch `meta.json` for a version id.
 * Rolling: half the rebuild schedule (catch updates mid-cycle without every visit).
 * Stable: same as long max-age (repackage of a pin is rare).
 *
 * Only runs when this path's version assets are fetched (e.g. never for master
 * while the user stays on `/` or `/0.15.2/`).
 */
export function metaRevalidateSeconds(versionId: string): number {
  const entry = loadVersionsManifest().versions.find((v) => v.id === versionId);
  if (entry?.schedule) {
    return Math.max(60, Math.floor(parseScheduleSeconds(entry.schedule) / 2));
  }
  return STABLE_MAX_AGE_SECONDS;
}

/** `Cache-Control` value for a compiler tree (preview server / future hosts that honor it). */
export function compilerCacheControlHeader(versionId: string): string {
  const p = compilerCachePolicy(versionId);
  if (p.kind === "immutable") {
    return `public, max-age=${p.maxAgeSeconds}, immutable`;
  }
  // Rolling trees rewrite the same URL — do not mark immutable.
  return `public, max-age=${p.maxAgeSeconds}`;
}

/** Extract version id from `/compilers/<id>/…` (absolute or site-relative). */
export function compilerIdFromAssetUrl(href: string): string | null {
  try {
    const path = href.includes("://")
      ? new URL(href).pathname
      : href.split("?")[0] ?? href;
    const m = path.match(/\/compilers\/([^/]+)\//);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}
