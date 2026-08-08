import { defineConfig } from "vite";
import { cpSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Site root (default). Custom domain: zp.xihale.top
// Subpath deploys only: set VITE_BASE=/your-prefix/ in CI.
const base = process.env.VITE_BASE || "/";

const versions = JSON.parse(
  readFileSync(resolve("versions.json"), "utf8"),
);

/** @param {string} schedule e.g. "3d" */
function parseScheduleSeconds(schedule) {
  const m = /^(\d+)\s*([dhms])$/i.exec(String(schedule).trim());
  if (!m) return 3 * 86400;
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
      return 3 * 86400;
  }
}

const STABLE_MAX_AGE = 365 * 24 * 60 * 60; // 1y
const HASHED_ASSET_MAX_AGE = STABLE_MAX_AGE;

/** Cache-Control for the preview server. (Consumer mode: compilers live on the
 *  playground under content-hashed names, served immutable there; this only
 *  governs this site's own shell / versions.json / Vite UI chunks.) */
function cacheControlForPath(path) {
  if (
    path === "/" ||
    path.endsWith(".html") ||
    path.endsWith("versions.json") ||
    path.endsWith("/meta.json")
  ) {
    // Shell + manifest must revalidate so clients pick up new asset hashes / builds.
    return "no-cache";
  }

  const m = path.match(/\/compilers\/([^/]+)\//);
  if (m) {
    const id = m[1];
    const entry = versions.versions.find((v) => v.id === id);
    if (entry?.schedule) {
      // Rolling (master): a few days, not immutable — same URL gets rebuilt.
      return `public, max-age=${parseScheduleSeconds(entry.schedule)}`;
    }
    // Fixed release trees: permanent for practical purposes.
    return `public, max-age=${STABLE_MAX_AGE}, immutable`;
  }

  // Vite content-hashed UI chunks under /assets/
  if (/\.(?:js|css|wasm|a|gz|svg|png|woff2?)$/i.test(path)) {
    return `public, max-age=${HASHED_ASSET_MAX_AGE}, immutable`;
  }

  return null;
}

// Note: GitHub Pages ignores custom Cache-Control (always max-age=600).
// Production longevity for compilers is handled by the served loader
// (zp-loader.js), which caches fetched assets in Cache Storage on the
// playground's origin. These headers apply to `vite preview` and any host that honors them.
export default defineConfig({
  base,
  publicDir: "public",
  plugins: [
    {
      name: "vendor-ziglings-to-dist",
      // The catalog + exercise sources/patches are committed under
      // vendor/ziglings/ (not public/) and fetched at runtime as static
      // assets. Vite only copies public/, so mirror them into dist/ here.
      closeBundle() {
        const src = resolve("vendor/ziglings");
        if (!existsSync(src)) return;
        cpSync(src, resolve("dist/vendor/ziglings"), { recursive: true });
      },
    },
    {
      name: "cache-control-headers",
      configurePreviewServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = req.url?.split("?")[0] ?? "";
          const cc = cacheControlForPath(path);
          if (cc) res.setHeader("Cache-Control", cc);
          next();
        });
      },
      configureServer(server) {
        // Dev: SPA fallback for /master/, /0.15.2/ so path routing works.
        server.middlewares.use((req, res, next) => {
          const path = req.url?.split("?")[0] ?? "";
          if (
            path !== "/" &&
            !path.includes(".") &&
            !path.startsWith("/src") &&
            !path.startsWith("/@") &&
            !path.startsWith("/node_modules") &&
            !path.includes("/compilers")
          ) {
            req.url = "/index.html";
          }
          next();
        });
      },
    },
  ],
  build: {
    // Keep multi-MB wasm/tar as separate files (never inlined).
    assetsInlineLimit: 0,
  },
  root: resolve("."),
});
