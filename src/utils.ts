/**
 * Compiler asset access for ziglings-web, delegated to the playground's served
 * loader (https://zp.xihale.top/zp-loader.js). The loader owns the
 * hash-filename / meta.json / Cache-Storage contract; this thin wrapper just
 * fixes the loader origin from versions.json → assetOrigin.
 *
 * Logical names (the loader resolves content-hash filenames from meta.json):
 *   "zig.wasm", "zls.wasm", "libcompiler_rt.a", "zig.tar.gz"
 */

import { ConsoleStdout, wasi as wasi_defs } from "@bjorn3/browser_wasi_shim";
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

/** Load the std-lib tarball (`zig.tar.gz`) as a WASI directory tree. */
export async function getZigArchive(versionId: string): Promise<import("@bjorn3/browser_wasi_shim").Directory> {
    const mod = await loader();
    return mod.getZigLibDir(versionId);
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
