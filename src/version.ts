/**
 * Versions manifest for ziglings-web.
 *
 * ziglings-web is a pure consumer: compiler binaries are fetched from the
 * playground (https://zp.xihale.top/) via the served loader (zp-loader.js),
 * never self-built. This module therefore only exposes the bundled manifest;
 * the download/cache/hash contract lives in the loader, not here.
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
   * Absolute origin serving /compilers/<id>/… — the playground, which also
   * publishes zp-loader.js. Compiler assets are fetched cross-origin from here.
   */
  assetOrigin?: string;
  versions: VersionEntry[];
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
