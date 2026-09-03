/**
 * Compiler asset access for ziglings-web, delegated to the playground's served
 * loader (https://zp.xeed.ink/zp-loader.js). The loader owns the
 * hash-filename / meta.json / Cache-Storage contract; this thin wrapper just
 * fixes the loader origin from versions.json → assetOrigin.
 *
 * Logical names (the loader resolves content-hash filenames from meta.json):
 *   "zig.wasm", "zls.wasm", "libcompiler_rt.a", "zig.tar.gz"
 */

import { untar } from "@andrewbranch/untar.js";
import { ConsoleStdout, Directory, File, wasi as wasi_defs } from "@bjorn3/browser_wasi_shim";
import { loadVersionsManifest } from "./version";

/** Loader URL = <assetOrigin>/zp-loader.js (defaults to the playground). */
function loaderUrl(): string {
    const origin = loadVersionsManifest().assetOrigin;
    if (!origin) throw new Error("versions.json: assetOrigin required (consumer mode)");
    const root = origin.endsWith("/") ? origin : `${origin}/`;
    return `${root}zp-loader.js`;
}

/**
 * SHA-256 of a UTF-8 string as lowercase hex.
 *
 * Must match the Node-side `createHash("sha256").update(s, "utf8").digest("hex")`
 * used by scripts/pin-loader.mjs and scripts/check-version-alignment.mjs — the
 * pin in versions.json is hex, so a base64 encoding here would never match.
 */
export async function sha256Hex(text: string): Promise<string> {
    const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    );
    return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

let loaderPromise: Promise<typeof import("./zp-loader-types")> | null = null;

/**
 * Lazily load the served loader with an integrity pin.
 *
 * The loader is remote code that ends up executing in our same-origin
 * workers (it can read drafts, progress, and the IndexedDB ZIR cache), so we
 * never import the URL directly:
 *   1. fetch the bytes
 *   2. if versions.json pins `loaderSha256`, SHA-256 the bytes and REFUSE
 *      to execute on mismatch — an intentional loader bump is a deliberate
 *      act: re-run `npm run pin-loader -- --write` and commit
 *   3. import via a same-origin blob: URL (verified bytes; no third-party
 *      origin in the execute path)
 * If blob imports are unsupported by the engine, fall back to a direct URL
 * import — when a pin is set, the bytes were hash-verified either way.
 */
function loader(): Promise<typeof import("./zp-loader-types")> {
    if (!loaderPromise) {
        loaderPromise = importServedLoader().catch((err) => {
            loaderPromise = null; // allow a retry after a transient failure
            throw err;
        });
    }
    return loaderPromise;
}

async function importServedLoader(): Promise<typeof import("./zp-loader-types")> {
    const url = loaderUrl();
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`zp-loader fetch ${url}: HTTP ${res.status}`);
    const text = await res.text();

    const pin = loadVersionsManifest().loaderSha256;
    if (pin) {
        const actual = await sha256Hex(text);
        if (actual !== pin.toLowerCase()) {
            throw new Error(
                `zp-loader integrity check FAILED: served SHA-256 ${actual} != pinned ${pin}. ` +
                `Refusing to execute. If the playground loader was intentionally ` +
                `bumped, run \`npm run pin-loader -- --write\` and commit versions.json.`,
            );
        }
    } else {
        console.warn(
            "zp-loader: versions.json has no loaderSha256 pin — executing without " +
            "integrity verification. Run `npm run pin-loader -- --write` to pin.",
        );
    }

    const blobUrl = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
    try {
        return await import(/* @vite-ignore */ blobUrl);
    } catch (blobErr) {
        // Compatibility fallback (engines without blob module imports): the
        // bytes are already hash-verified when a pin is set.
        console.warn("zp-loader: blob import failed, falling back to direct URL import", blobErr);
        return await import(/* @vite-ignore */ url);
    } finally {
        URL.revokeObjectURL(blobUrl);
    }
}

/** Fetch a logical compiler file as bytes (hash resolved from meta.json). */
export async function fetchCompilerFile(
    versionId: string,
    logicalName: string,
): Promise<ArrayBuffer> {
    const mod = await loader();
    return mod.fetchCompilerFile(versionId, logicalName);
}

/** Compile a logical `.wasm` compiler asset (hash resolved from meta.json). */
export async function compileCompilerWasm(
    versionId: string,
    logicalName: string,
): Promise<WebAssembly.Module> {
    const mod = await loader();
    return mod.compileCompilerWasm(versionId, logicalName);
}

/**
 * Load the std-lib tarball (`zig.tar.gz`) as a WASI directory tree.
 *
 * Fetches the raw bytes through the loader (so its meta.json hash-resolution
 * and Cache-Storage layer still apply), but untars + builds the tree with
 * THIS bundle's `Directory`/`File`. The loader's `getZigLibDir` builds the
 * tree with the loader bundle's classes; the worker's WASI shim then trips on
 * `entry instanceof Directory` returning false for nested dirs (e.g. `lib/std`)
 * and the compiler fails with `unable to load 'std.zig': NotDir`. Rebuilding
 * locally keeps every node a single class identity.
 */
export async function getZigArchive(
    versionId: string,
): Promise<import("@bjorn3/browser_wasi_shim").Directory> {
    let arrayBuffer = await fetchCompilerFile(versionId, "zig.tar.gz");

    // The asset is served gzip-compressed (magic 1f 8b); untar needs raw tar.
    const magic = new Uint8Array(arrayBuffer).slice(0, 2);
    if (magic[0] == 0x1f && magic[1] == 0x8b) {
        const ds = new DecompressionStream("gzip");
        arrayBuffer = await new Response(
            new Response(arrayBuffer).body!.pipeThrough(ds),
        ).arrayBuffer();
    }

    const entries = untar(arrayBuffer);

    type TreeNode = Map<string, TreeNode | Uint8Array>;
    const root: TreeNode = new Map();
    for (const e of entries) {
        if (!e.filename.startsWith("lib/")) continue;
        const splitPath = e.filename.slice("lib/".length).split("/");
        let c = root;
        for (const segment of splitPath.slice(0, -1)) {
            if (!c.has(segment)) c.set(segment, new Map());
            c = c.get(segment) as TreeNode;
        }
        c.set(splitPath[splitPath.length - 1], e.fileData);
    }

    const convert = (node: TreeNode): Directory =>
        new Directory(
            [...node.entries()].map(([key, value]) =>
                value instanceof Uint8Array
                    ? [key, new File(value)]
                    : [key, convert(value)],
            ),
        );
    return convert(root);
}

export function stderrOutput(): ConsoleStdout {
    const dec = new TextDecoder("utf-8", { fatal: false });
    const stderr = new ConsoleStdout((buffer) => {
        postMessage({ stderr: dec.decode(buffer, { stream: true }) });
    });
    stderr.fd_pwrite = (data, offset) => {
        return { ret: wasi_defs.ERRNO_SPIPE, nwritten: 0 };
    }
    return stderr;
}
