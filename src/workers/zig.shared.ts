/**
 * SharedWorker hosting lazily-loaded Zig compiler instances.
 * See docs/superpowers/specs/2026-07-26-shared-compiler-worker-design.md.
 */

import {
    WASI,
    PreopenDirectory,
    Fd,
    File,
    OpenFile,
    Inode,
    Directory,
    ConsoleStdout,
} from "@bjorn3/browser_wasi_shim";
import { wasi as wasi_defs } from "@bjorn3/browser_wasi_shim";
import { compileWasmAsset, fetchAssetBuffer, getZigArchive } from "../utils";
import {
    type FlatEntry,
    loadZirCacheEntries,
    saveZirCacheEntries,
} from "../zir-cache";
import { compilerAssetUrl } from "../version";
import type { ClientMsg, WorkerMsg, ZirCacheInfo } from "../shared-protocol";

/**
 * Per-compile stderr sink that routes writes to the owning port.
 * Mirrors utils.ts stderrOutput() shape but with a custom emit target,
 * preserving the { stream: true } decode so multi-write concatenation works.
 */
function portStderr(emit: (text: string) => void): ConsoleStdout {
    const dec = new TextDecoder("utf-8", { fatal: false });
    const out = new ConsoleStdout((buffer) => {
        emit(dec.decode(buffer, { stream: true }));
    });
    // @ts-ignore — match utils.ts: stub pwrite on a console-type fd.
    out.fd_pwrite = (_data, _offset) => {
        return { ret: wasi_defs.ERRNO_SPIPE, nwritten: 0 };
    };
    return out;
}

type Ready = {
    libDirectory: Directory;
    compilerRt: ArrayBuffer;
    zigModule: WebAssembly.Module;
    zirCache: ZirCacheInfo | null;
    versionId: string;
};

type Compiler = {
    versionId: string;
    ready: Promise<Ready> | null;
    cacheContents: Map<string, Inode>;
    lastSavedBytes: number;
    persistChain: Promise<void>;
    compileChain: Promise<void>;
    refCount: number;
};

const compilers = new Map<string, Compiler>();

type PortState = {
    versionId: string | null;
    currentRequestId: string | null;
};
const ports = new Map<MessagePort, PortState>();

// ─── Cache (de)serialization helpers — lifted from zig.ts:30-64 ─────────

function flattenCache(map: Map<string, Inode>, prefix = ""): FlatEntry[] {
    const out: FlatEntry[] = [];
    for (const [name, node] of map.entries()) {
        const p = prefix ? `${prefix}/${name}` : name;
        const any = node as File | Directory;
        if (
            any instanceof File ||
            (any && "data" in any && (any as File).data != null && !("contents" in any))
        ) {
            const d = (any as File).data;
            out.push({
                path: p,
                data: d instanceof Uint8Array ? d : new Uint8Array(d as ArrayBuffer),
            });
        } else if (
            any instanceof Directory ||
            (any && (any as Directory).contents instanceof Map)
        ) {
            out.push(...flattenCache((any as Directory).contents, p));
        }
    }
    return out;
}

function hydrateCache(root: Map<string, Inode>, entries: FlatEntry[]): void {
    root.clear();
    for (const { path, data } of entries) {
        const parts = path.split("/");
        let cur = root;
        for (let i = 0; i < parts.length - 1; i++) {
            let next = cur.get(parts[i]);
            if (!(next instanceof Directory)) {
                next = new Directory(new Map());
                cur.set(parts[i], next);
            }
            cur = next.contents;
        }
        cur.set(parts[parts.length - 1], new File(data));
    }
}

// ─── Compiler lifecycle ────────────────────────────────────────────────

function newCompiler(versionId: string): Compiler {
    return {
        versionId,
        ready: null,
        cacheContents: new Map(),
        lastSavedBytes: 0,
        persistChain: Promise.resolve(),
        compileChain: Promise.resolve(),
        refCount: 0,
    };
}

function schedulePersistCache(c: Compiler) {
    c.persistChain = c.persistChain
        .then(async () => {
            const entries = flattenCache(c.cacheContents);
            const bytes = entries.reduce((s, e) => s + e.data.byteLength, 0);
            if (bytes === 0 || bytes === c.lastSavedBytes) return;
            const saved = await saveZirCacheEntries(entries, c.versionId);
            if (saved) c.lastSavedBytes = saved.bytes;
        })
        .catch(() => {
            /* ignore — memory cache still works this session */
        });
}

/**
 * Lazily assemble a version. Dedups concurrent inits via `c.ready`.
 * Body lifted from src/workers/zig.ts:90-107.
 */
function ensureCompiler(versionId: string): Promise<Ready> {
    let c = compilers.get(versionId);
    if (!c) {
        c = newCompiler(versionId);
        compilers.set(versionId, c);
    }
    if (!c.ready) {
        c.ready = (async (): Promise<Ready> => {
            const [zirHit, libDirectory, compilerRt, zigModule] = await Promise.all([
                loadZirCacheEntries(versionId),
                getZigArchive(versionId),
                fetchAssetBuffer(compilerAssetUrl(versionId, "libcompiler_rt.a")),
                compileWasmAsset(compilerAssetUrl(versionId, "zig.wasm")),
            ]);

            let zirCache: ZirCacheInfo | null = null;
            if (zirHit) {
                hydrateCache(c!.cacheContents, zirHit.entries);
                c!.lastSavedBytes = zirHit.bytes;
                zirCache = { files: zirHit.files, bytes: zirHit.bytes };
            }
            return { libDirectory, compilerRt, zigModule, zirCache, versionId };
        })();
    }
    return c.ready;
}

function postToPort(port: MessagePort, msg: WorkerMsg) {
    try {
        port.postMessage(msg);
    } catch {
        /* port closed mid-flight — swallow */
    }
}

// ─── Connection handling ───────────────────────────────────────────────

function handleInit(port: MessagePort, st: PortState, versionId: string) {
    // No-op if the port already holds this version (no double-count).
    if (st.versionId === versionId) {
        // Still (re)confirm readiness for this port.
        const c = compilers.get(versionId);
        if (c?.ready) {
            c.ready
                .then((r) =>
                    postToPort(port, {
                        kind: "ready",
                        versionId,
                        ok: true,
                        zirCache: r.zirCache,
                    }),
                )
                .catch((err) =>
                    postToPort(port, {
                        kind: "ready",
                        versionId,
                        ok: false,
                        error: `${err}`,
                    }),
                );
        }
        return;
    }
    // Release the previous version this port held.
    if (st.versionId !== null) releaseVersion(st.versionId);
    st.versionId = versionId;

    const c = ensureCompiler(versionId);
    compilers.get(versionId)!.refCount++;
    c.then((r) =>
        postToPort(port, {
            kind: "ready",
            versionId,
            ok: true,
            zirCache: r.zirCache,
        }),
    ).catch((err) =>
        postToPort(port, { kind: "ready", versionId, ok: false, error: `${err}` }),
    );
}

function releaseVersion(versionId: string) {
    const c = compilers.get(versionId);
    if (!c) return;
    c.refCount = Math.max(0, c.refCount - 1);
    if (c.refCount === 0) {
        compilers.delete(versionId);
    }
}

/**
 * Compile one source against an assembled compiler. Body lifted from
 * src/workers/zig.ts:120-180; postMessage → port.postMessage with protocol.
 *
 * α policy: before every reply, re-check that this port's currentRequestId
 * still equals `requestId`. If a newer run superseded it, stop emitting.
 */
async function doOneCompile(
    port: MessagePort,
    st: PortState,
    requestId: string,
    versionId: string,
    source: string,
    mode: "run" | "test",
) {
    try {
        const c = compilers.get(versionId);
        if (!c || !c.ready) return; // version evicted before this run started.
        const { libDirectory, compilerRt, zigModule } = await c.ready;

        // If superseded while waiting on assembly, drop silently.
        if (st.currentRequestId !== requestId) return;

        // test mode: `zig test --test-no-exec -femit-bin=main.wasm` emits a
        // WASI test-runner binary at the same path build-exe writes main.wasm,
        // so the downstream runner reads it unchanged. Drop -fno-entry (the
        // synthesized test runner needs _start).
        const args =
            mode === "test"
                ? [
                      "zig.wasm",
                      "test",
                      "main.zig",
                      "libcompiler_rt.a",
                      "-fno-compiler-rt",
                      "--test-no-exec",
                      "-femit-bin=main.wasm",
                  ]
                : [
                      "zig.wasm",
                      "build-exe",
                      "main.zig",
                      "libcompiler_rt.a",
                      "-fno-compiler-rt",
                      "-fno-entry",
                  ];
        const env: string[] = [];
        const fds = [
            new OpenFile(new File([])),
            portStderr((text) => {
                if (st.currentRequestId === requestId) {
                    postToPort(port, { kind: "stderr", requestId, text });
                }
            }),
            portStderr((text) => {
                if (st.currentRequestId === requestId) {
                    postToPort(port, { kind: "stderr", requestId, text });
                }
            }),
            new PreopenDirectory(".", new Map<string, Inode>([
                ["main.zig", new File(new TextEncoder().encode(source))],
                ["libcompiler_rt.a", new File(new Uint8Array(compilerRt))],
            ])),
            new PreopenDirectory("/lib", libDirectory.contents),
            new PreopenDirectory("/cache", c.cacheContents),
        ] satisfies Fd[];
        const wasi = new WASI(args, env, fds, { debug: false });

        const instance = await WebAssembly.instantiate(zigModule, {
            wasi_snapshot_preview1: wasi.wasiImport,
        });

        // @ts-ignore
        const exitCode = wasi.start(instance);

        if (st.currentRequestId !== requestId) return; // superseded mid-run

        if (exitCode == 0) {
            const cwd = wasi.fds[3] as PreopenDirectory;
            const mainWasm = cwd.dir.contents.get("main.wasm") as File | undefined;
            if (mainWasm) {
                postToPort(port, {
                    kind: "compiled",
                    requestId,
                    wasm: mainWasm.data.buffer as ArrayBuffer,
                });
                schedulePersistCache(c);
            } else {
                postToPort(port, { kind: "failed", requestId });
            }
        } else {
            postToPort(port, { kind: "failed", requestId });
        }
    } catch (err) {
        if (st.currentRequestId === requestId) {
            postToPort(port, {
                kind: "stderr",
                requestId,
                text: `${err}\n`,
            });
            postToPort(port, { kind: "failed", requestId });
        }
    }
}

onconnect = (ev: MessageEvent) => {
    const port: MessagePort = ev.ports[0];
    const st: PortState = { versionId: null, currentRequestId: null };
    ports.set(port, st);

    port.onmessage = (e: MessageEvent) => {
        const msg = e.data as ClientMsg;
        if (!msg || typeof msg !== "object") return;
        if (msg.kind === "init") {
            handleInit(port, st, msg.versionId);
            return;
        }
        if (msg.kind === "run") {
            const { requestId, versionId, source, mode } = msg;
            st.currentRequestId = requestId; // α: supersede any prior run.
            const c = compilers.get(versionId);
            if (!c) {
                // Version never init'd on this port; cannot compile.
                postToPort(port, {
                    kind: "stderr",
                    requestId,
                    text: `version ${versionId} not initialized\n`,
                });
                postToPort(port, { kind: "failed", requestId });
                return;
            }
            c.compileChain = c.compileChain.then(() =>
                doOneCompile(port, st, requestId, versionId, source, mode ?? "run"),
            );
            return;
        }
    };

    port.onmessageerror = () => {
        cleanupPort(port);
    };
    // Note: SharedWorker ports do not emit a close event; cleanup is best-effort
    // on disconnect signals. Refcount leak risk is bounded — a stale compiler
    // entry is memory only, never re-fetched (Cache Storage still backs it).
    port.start();
};

/**
 * Best-effort port cleanup. SharedWorker MessagePorts do not reliably emit a
 * close event when a tab unloads, so refcount may undercount on abrupt
 * disconnects. Impact is bounded: a stale Compiler entry holds memory only;
 * re-assembly is still Cache-Storage-backed. `onmessageerror` covers the
 * detectable cases.
 */
function cleanupPort(port: MessagePort) {
    const st = ports.get(port);
    if (!st) return;
    if (st.versionId !== null) releaseVersion(st.versionId);
    ports.delete(port);
}
