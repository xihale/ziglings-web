/**
 * Compiler asset access for ziglings-web, delegated to the playground's served
 * loader (https://zp.xihale.top/zp-loader.js). The loader owns the
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

let loaderPromise: Promise<typeof import("./zp-loader-types")> | null = null;

/**
 * Lazily import the served loader. Bundlers (Vite/Rolldown) leave a remote
 * `https://` import as-is — it loads at runtime in the browser/worker.
 */
function loader(): Promise<typeof import("./zp-loader-types")> {
    if (!loaderPromise) loaderPromise = import(/* @vite-ignore */ loaderUrl());
    return loaderPromise;
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
