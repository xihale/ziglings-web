/**
 * Local type declaration for the served loader (https://zp.xihale.top/zp-loader.js).
 *
 * The loader is imported remotely at runtime (see src/utils.ts), so TypeScript
 * has no types for it. This module mirrors its public surface for type-safety;
 * it carries no runtime code and is never imported at runtime — it only types
 * the `typeof import("./zp-loader-types")` reference in utils.ts.
 */

import type { Directory } from "@bjorn3/browser_wasi_shim";

export type CompilerMeta = {
    id: string;
    builtAt: string;
    files: Record<string, { size: number; sha256: string; name: string }>;
};

export type LoaderVersions = {
    default: string;
    versions: { id: string; label: string }[];
};

export declare function configure(opts: { origin?: string }): void;
export declare function origin(): string;
export declare function fetchCompilerFile(
    versionId: string,
    logicalName: string,
): Promise<ArrayBuffer>;
export declare function compileCompilerWasm(
    versionId: string,
    logicalName: string,
): Promise<WebAssembly.Module>;
export declare function getZigLibDir(versionId: string): Promise<Directory>;
export declare function listVersions(): Promise<LoaderVersions>;
export declare function metaJson(versionId: string): Promise<CompilerMeta | null>;
export declare function fetchRaw(url: URL | string): Promise<Response>;
