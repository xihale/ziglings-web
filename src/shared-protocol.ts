/**
 * Wire protocol between ZigSharedClient and the compiler SharedWorker.
 *
 * Run-scoped messages carry `requestId` (client-generated monotonic string).
 * The SharedWorker applies the α policy: a new `run` from a port overwrites
 * that port's currentRequestId, after which any older-requestId reply is
 * dropped before being posted.
 *
 * See docs/superpowers/specs/2026-07-26-shared-compiler-worker-design.md.
 */

export type ZirCacheInfo = { files: number; bytes: number };

/** Client → SharedWorker. */
export type ClientMsg =
  | { kind: "init"; versionId: string }
  | {
        kind: "run";
        requestId: string;
        versionId: string;
        source: string;
        /** "run" = build-exe (default). "test" = zig test --test-no-exec. */
        mode?: "run" | "test";
    };

/** SharedWorker → Client. */
export type WorkerMsg =
  | { kind: "ready"; versionId: string; ok: true; zirCache: ZirCacheInfo | null }
  | { kind: "ready"; versionId: string; ok: false; error: string }
  | { kind: "stdout"; requestId: string; text: string }
  | { kind: "stderr"; requestId: string; text: string }
  | { kind: "compiled"; requestId: string; wasm: ArrayBuffer }
  | { kind: "failed"; requestId: string };
