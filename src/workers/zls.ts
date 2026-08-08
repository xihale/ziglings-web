import { WASI, PreopenDirectory, Fd, ConsoleStdout } from "@bjorn3/browser_wasi_shim";
import { compileCompilerWasm, getZigArchive } from "../utils";

class Stdio extends Fd {
    constructor() {
        super();
    }

    fd_write(slice: Uint8Array): { ret: number; nwritten: number } {
        throw new Error("Cannot write");
    }

    fd_read(size: number): { ret: number; data: Uint8Array; } {
        throw new Error("Cannot read");
    }
}

let instance: WebAssembly.Instance | null = null;
let bufferedMessages: string[] = [];
let bootStarted = false;

type ZigPtr = number;

interface ZlsWasmExports {
    memory: WebAssembly.Memory,

    createServer(): void,
    allocMessage(len: number): ZigPtr,
    call(): void,
    outputMessageCount(): number,
    outputMessagePtr(index: number): ZigPtr,
    outputMessageLen(index: number): number,
}

function sendMessage(message: string) {
    if (!instance) {
        bufferedMessages.push(message);
        return;
    }
    const inputMessageBuffer = new TextEncoder().encode(message);
    const exports = instance.exports as unknown as ZlsWasmExports;
    const ptr = exports.allocMessage(inputMessageBuffer.length);
    new Uint8Array(exports.memory.buffer).set(inputMessageBuffer, ptr);
    exports.call();

    const outputMessageCount = exports.outputMessageCount();
    for (let i = 0; i < outputMessageCount; i++) {
        const start = exports.outputMessagePtr(i);
        const end = start + exports.outputMessageLen(i);
        const outputMessageBuffer = new Uint8Array(exports.memory.buffer).slice(start, end);
        postMessage(new TextDecoder().decode(outputMessageBuffer));
    }
}

async function boot(versionId: string) {
    if (bootStarted) return;
    bootStarted = true;

    try {
        const libDirectory = await getZigArchive(versionId);

        const args = ["zls.wasm"];
        const env: string[] = [];
        const fds = [
            new Stdio(), // stdin
            new Stdio(), // stdout
            ConsoleStdout.lineBuffered((line) => postMessage(JSON.stringify({ stderr: line }))), // stderr
            new PreopenDirectory(".", new Map([])),
            new PreopenDirectory("/lib", libDirectory.contents),
            new PreopenDirectory("/cache", new Map()),
        ];
        const wasi = new WASI(args, env, fds, { debug: false });

        const zlsModule = await compileCompilerWasm(versionId, "zls.wasm");
        const localInstance = await WebAssembly.instantiate(zlsModule, {
            "wasi_snapshot_preview1": wasi.wasiImport,
        });

        // @ts-ignore
        wasi.inst = localInstance;

        // @ts-ignore
        localInstance.exports.createServer();

        instance = localInstance;

        for (const bufferedMessage of bufferedMessages) {
            sendMessage(bufferedMessage);
        }
        bufferedMessages = [];
        postMessage(JSON.stringify({ ready: true, versionId }));
    } catch (err) {
        postMessage(JSON.stringify({ ready: false, error: `${err}` }));
    }
}

onmessage = (event) => {
    if (event.data && typeof event.data === "object" && event.data.init?.versionId) {
        boot(event.data.init.versionId as string);
        return;
    }
    // LSP JSON-RPC strings
    if (typeof event.data === "string") {
        sendMessage(event.data);
    }
};
