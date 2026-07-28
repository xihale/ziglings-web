// Runs compiled Zig code

import { WASI, PreopenDirectory, OpenFile, File, ConsoleStdout } from "@bjorn3/browser_wasi_shim";
import { wasi as wasi_defs } from "@bjorn3/browser_wasi_shim";

/** Console fd that posts its bytes under `key` (stdout or stderr) separately. */
function consoleOutput(key: "stdout" | "stderr"): ConsoleStdout {
    const dec = new TextDecoder("utf-8", { fatal: false });
    const out = new ConsoleStdout((buffer) => {
        postMessage({ [key]: dec.decode(buffer, { stream: true }) });
    });
    // @ts-ignore — stub pwrite on a console-type fd (matches utils.ts shape).
    out.fd_pwrite = (_data, _offset) => {
        return { ret: wasi_defs.ERRNO_SPIPE, nwritten: 0 };
    };
    return out;
}

async function run(wasmData: BufferSource) {
    const args = ["main.wasm"];
    const env: string[] = [];
    const fds = [
        new OpenFile(new File([])), // stdin
        consoleOutput("stdout"), // stdout (fd1)
        consoleOutput("stderr"), // stderr (fd2)
        new PreopenDirectory(".", new Map([])),
    ];
    const wasi = new WASI(args, env, fds);

    const { instance } = await WebAssembly.instantiate(wasmData, {
        "wasi_snapshot_preview1": wasi.wasiImport,
    });;

    try {
        // @ts-ignore
        const exitCode = wasi.start(instance);
        // Exit code is surfaced as its own message so the UI can render it
        // as a badge above the tab bar instead of as a textual trailer in
        // the output stream.
        postMessage({ exitCode });
    } catch (err) {
        postMessage({ stderr: `${err}` });
        postMessage({ exitCode: 1, crashed: true });
    }

    postMessage({
        done: true,
    });
}

onmessage = (event) => {
    if (event.data.run) {
        run(event.data.run);
    }
}
