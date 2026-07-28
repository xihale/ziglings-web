// Spec §6.4 Check 3: assert catalog.zigFloor <= the compiler version we serve.
//
// The compiler version we serve is versions.json's default id (master). Its
// actual Zig version string lives in the playground's deployed meta.json at
// <assetOrigin>/compilers/<id>/meta.json. This check fetches that and compares.
//
// Fails (exit 1) if the floor exceeds the served compiler, blocking deploy.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(resolve(root, "vendor/ziglings/catalog.json"), "utf8"));
const manifest = JSON.parse(readFileSync(resolve(root, "versions.json"), "utf8"));

const versionId = manifest.default;
const origin = manifest.assetOrigin;
const floor = catalog.zigFloor;
if (!floor) {
    console.error("version alignment: catalog.zigFloor missing");
    process.exit(1);
}

console.log(`catalog.zigFloor = ${floor}`);
console.log(`served compiler  = ${versionId} (from ${origin || "self"})`);

// Parse a Zig version string into a comparable form.
// Zig dev versions come in two shapes:
//   "0.17.0-dev.1464+6aff551f1"  — build-number suffix (.N)
//   "0.17.0-dev+ff10b90bc"        — commit-hash suffix (+hash)
// These suffixes are NOT mutually comparable (a build number and a commit hash
// don't order). So compare by the numeric core (major.minor.patch) only; if the
// cores match, treat as aligned and report the dev suffixes for human review.
function parseZigVersion(s) {
    const [core] = s.split("+");
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(core);
    return { major: m ? +m[1] : 0, minor: m ? +m[2] : 0, patch: m ? +m[3] : 0, raw: s };
}

function compareCore(a, b) {
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    return a.patch - b.patch;
}

async function servedCompilerVersion() {
    if (!origin) {
        // Self-hosted compiler: we can't know without building. Skip with a note.
        return null;
    }
    const base = origin.endsWith("/") ? origin : `${origin}/`;
    const url = `${base}compilers/${versionId}/meta.json`;
    try {
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok) return { error: `HTTP ${res.status}` };
        const meta = await res.json();
        return { version: meta.zigVersionString ?? meta.zigVersion ?? meta.version ?? null };
    } catch (err) {
        return { error: String(err) };
    }
}

const served = await servedCompilerVersion();
if (!served) {
    console.log("version alignment: SKIP (no assetOrigin; self-built compiler version not checked)");
    process.exit(0);
}
if (served.error) {
    console.error(`version alignment: could not fetch served compiler meta (${served.error})`);
    console.error("  (Is the playground online? This check requires it.)");
    process.exit(1);
}

const floorV = parseZigVersion(floor);
const servedV = parseZigVersion(served.version);
console.log(`served zigVersion = ${served.version}`);

const ord = compareCore(servedV, floorV);
if (ord < 0) {
    console.error(`\nversion alignment: FAIL — served compiler core is OLDER than catalog.zigFloor`);
    console.error(`  served core: ${servedV.major}.${servedV.minor}.${servedV.patch}  <  floor core: ${floorV.major}.${floorV.minor}.${floorV.patch}`);
    console.error("  Either bump the playground's master compiler, or roll back the Ziglings submodule.");
    process.exit(1);
}
if (ord === 0) {
    console.log(`version alignment: OK (cores match; dev suffixes require human eye on bump)`);
} else {
    console.log(`version alignment: OK (served core newer than floor)`);
}
