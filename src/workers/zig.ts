import { WASI, PreopenDirectory, Fd, File, OpenFile, Inode, Directory } from "@bjorn3/browser_wasi_shim";
import {
    compileCompilerWasm,
    fetchCompilerFile,
    getZigArchive,
    stderrOutput,
} from "../utils";
import {
    type FlatEntry,
    loadZirCacheEntries,
    saveZirCacheEntries,
} from "../zir-cache";

type Ready = {
    libDirectory: Directory;
    compilerRt: ArrayBuffer;
    zigModule: WebAssembly.Module;
    zirCache: { files: number; bytes: number } | null;
    versionId: string;
};

/** Shared across compiles: Zig's global cache (/cache) for ZIR of std, etc. */
const cacheContents = new Map<string, Inode>();

/** Active compiler version — set by main-thread init message. */
let versionId: string | null = null;

/** Last successfully persisted size — skip redundant IDB writes. */
let lastSavedBytes = 0;
/** Serialize IDB writes; never block compile on disk. */
let persistChain: Promise<void> = Promise.resolve();

/** Duck-type walk — avoids fragile instanceof across bundler copies. */
function flattenCache(map: Map<string, Inode>, prefix = ""): FlatEntry[] {
    const out: FlatEntry[] = [];
    for (const [name, node] of map.entries()) {
        const p = prefix ? `${prefix}/${name}` : name;
        const any = node as File | Directory;
        if (any instanceof File || (any && "data" in any && (any as File).data != null && !("contents" in any))) {
            const d = (any as File).data;
            out.push({
                path: p,
                data: d instanceof Uint8Array ? d : new Uint8Array(d as ArrayBuffer),
            });
        } else if (any instanceof Directory || (any && (any as Directory).contents instanceof Map)) {
            out.push(...flattenCache((any as Directory).contents, p));
        }
    }
    return out;
}

/** Build tree with THIS module's File/Directory (same as PreopenDirectory). */
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

function schedulePersistCache() {
    if (!versionId) return;
    const id = versionId;
    persistChain = persistChain
        .then(async () => {
            const entries = flattenCache(cacheContents);
            const bytes = entries.reduce((s, e) => s + e.data.byteLength, 0);
            if (bytes === 0 || bytes === lastSavedBytes) return;
            const saved = await saveZirCacheEntries(entries, id);
            if (saved) lastSavedBytes = saved.bytes;
        })
        .catch(() => {
            /* ignore — memory cache still works this session */
        });
}

let readyPromise: Promise<Ready> | null = null;

function ensureReady(): Promise<Ready> {
    if (!versionId) {
        return Promise.reject(new Error("zig worker: missing init.versionId"));
    }
    const id = versionId;
    if (!readyPromise) {
        readyPromise = (async (): Promise<Ready> => {
            // Load ZIR cache in parallel with compiler assets (wall time ≈ max of both).
            const [zirHit, libDirectory, compilerRt, zigModule] = await Promise.all([
                loadZirCacheEntries(id),
                getZigArchive(id),
                fetchCompilerFile(id, "libcompiler_rt.a"),
                compileCompilerWasm(id, "zig.wasm"),
            ]);

            let zirCache: Ready["zirCache"] = null;
            if (zirHit) {
                hydrateCache(cacheContents, zirHit.entries);
                lastSavedBytes = zirHit.bytes;
                zirCache = { files: zirHit.files, bytes: zirHit.bytes };
            }

            return { libDirectory, compilerRt, zigModule, zirCache, versionId: id };
        })();
    }
    return readyPromise;
}

function startWarm() {
    ensureReady()
        .then((r) => postMessage({ ready: true, zirCache: r.zirCache, versionId: r.versionId }))
        .catch((err) => postMessage({ ready: false, error: `${err}` }));
}

let currentlyRunning = false;

async function run(source: string, mode: "run" | "test") {
    if (currentlyRunning) return;

    currentlyRunning = true;

    try {
        // Caller should wait for { ready: true }; ensureReady is still the gate.
        const { libDirectory, compilerRt, zigModule } = await ensureReady();

        // test mode emits a WASI test-runner binary at the same main.wasm path
        // (see zig.shared.ts doOneCompile for rationale).
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
                      "-fno-compiler-rt", // manually linked because the self hosted webassembly backend cannot compile it by itself
                      "-fno-entry", // prevent the native webassembly backend from adding a start function to the module
                  ];
        const env: string[] = [];
        const fds = [
            new OpenFile(new File([])), // stdin
            stderrOutput(), // stdout
            stderrOutput(), // stderr
            new PreopenDirectory(".", new Map<string, Inode>([
                ["main.zig", new File(new TextEncoder().encode(source))],
                // Fresh File each run; buffer is shared read-only.
                ["libcompiler_rt.a", new File(new Uint8Array(compilerRt))],
            ])),
            new PreopenDirectory("/lib", libDirectory.contents),
            new PreopenDirectory("/cache", cacheContents),
        ] satisfies Fd[];
        const wasi = new WASI(args, env, fds, { debug: false });

        const instance = await WebAssembly.instantiate(zigModule, {
            "wasi_snapshot_preview1": wasi.wasiImport,
        });

        // @ts-ignore
        const exitCode = wasi.start(instance);

        if (exitCode == 0) {
            const cwd = wasi.fds[3] as PreopenDirectory;
            const mainWasm = cwd.dir.contents.get("main.wasm") as File | undefined;
            if (mainWasm) {
                // Send the underlying ArrayBuffer (not the Uint8Array view):
                // downstream transfers the wasm bytes via postMessage's
                // transfer list, which only accepts transferable objects
                // (ArrayBuffer), not typed-array views.
                postMessage({ compiled: mainWasm.data.buffer });
                // First cold compile (or grown cache) → async IDB write.
                schedulePersistCache();
            } else {
                postMessage({ failed: true });
            }
        } else {
            postMessage({ failed: true });
        }
    } catch (err) {
        postMessage({
            stderr: `${err}`,
        });
        postMessage({ failed: true });
    } finally {
        currentlyRunning = false;
    }
}

onmessage = (event) => {
    if (event.data?.init?.versionId) {
        versionId = event.data.init.versionId as string;
        cacheContents.clear();
        lastSavedBytes = 0;
        readyPromise = null;
        // Warm only the active path version (other ids never fetched this session).
        startWarm();
        return;
    }
    if (event.data.run) {
        run(event.data.run, event.data.mode === "test" ? "test" : "run");
    }
};
