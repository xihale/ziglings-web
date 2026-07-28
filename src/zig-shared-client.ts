/**
 * Thin client for the compiler SharedWorker, with a dedicated-worker fallback.
 *
 * Exposes `dispatch` + `onmessage` so editor.ts sees a uniform surface
 * regardless of transport. Prefers SharedWorker (origin-wide reuse of the
 * assembled zig.wasm Module); falls back to the original ZigWorker when
 * SharedWorker is unavailable (older Safari, some in-app browsers).
 *
 * See docs/superpowers/specs/2026-07-26-shared-compiler-worker-design.md.
 */

// @ts-ignore — Vite sharedworker import (symmetric with existing ?worker).
import ZigSharedWorker from "./workers/zig.shared.ts?sharedworker";
// @ts-ignore — Vite worker import; verbatim fallback path.
import ZigWorker from "./workers/zig.ts?worker";
import type { ClientMsg, WorkerMsg } from "./shared-protocol";

export type { ClientMsg, WorkerMsg } from "./shared-protocol";

const sharedAvailable = typeof SharedWorker !== "undefined";

/**
 * Wire an old-style `ZigWorker` (whose onmessage posts legacy-shape objects
 * like { ready, stderr, compiled, failed, error }) into the new protocol.
 *
 * The dedicated fallback keeps its on-wire shape unchanged (zig.ts is frozen
 * as the fallback); this adapter translates at the boundary.
 */
function attachLegacyAdapter(
    worker: Worker,
    onMsg: (m: WorkerMsg) => void,
    versionIdRef: { current: string | null },
    pendingReqId: { current: string | null },
) {
    worker.onmessage = (ev: MessageEvent) => {
        const d = ev.data;
        if (d?.ready === true) {
            onMsg({
                kind: "ready",
                versionId: versionIdRef.current ?? "",
                ok: true,
                zirCache: d.zirCache ?? null,
            });
            return;
        }
        if (d?.ready === false) {
            onMsg({
                kind: "ready",
                versionId: versionIdRef.current ?? "",
                ok: false,
                error: d.error ?? "failed to load compiler",
            });
            return;
        }
        if (d?.stderr) {
            // Legacy worker doesn't carry requestId; route through the pending
            // request id tracked by the caller (see dispatch()).
            onMsg({ kind: "stderr", requestId: pendingReqId.current ?? "", text: d.stderr });
            return;
        }
        if (d?.failed) {
            onMsg({ kind: "failed", requestId: pendingReqId.current ?? "" });
            return;
        }
        if (d?.compiled) {
            onMsg({
                kind: "compiled",
                requestId: pendingReqId.current ?? "",
                wasm: d.compiled,
            });
            return;
        }
    };
}

export class ZigSharedClient {
    private sw: SharedWorker | null = null;
    private dw: Worker | null = null;
    private versionIdRef = { current: null as string | null };
    /** Request id of the in-flight run; stamped onto legacy-shape replies. */
    private pendingReqId = { current: null as string | null };
    /** User-supplied handler; receives normalized WorkerMsg. */
    public onmessage: ((m: WorkerMsg) => void) | null = null;

    constructor() {
        if (sharedAvailable) {
            this.sw = new ZigSharedWorker();
            this.sw.port.onmessage = (ev: MessageEvent) => {
                if (this.onmessage) this.onmessage(ev.data as WorkerMsg);
            };
            this.sw.port.onmessageerror = () => {
                /* swallow; α/timeout logic in editor.ts handles liveness */
            };
            this.sw.port.start();
        } else {
            this.dw = new ZigWorker();
            attachLegacyAdapter(this.dw, (m) => {
                if (this.onmessage) this.onmessage(m);
            }, this.versionIdRef, this.pendingReqId);
        }
    }

    dispatch(msg: ClientMsg) {
        if (msg.kind === "init") {
            this.versionIdRef.current = msg.versionId;
            if (this.sw) this.sw.port.postMessage(msg);
            else this.dw!.postMessage({ init: { versionId: msg.versionId } });
            return;
        }
        // run
        this.pendingReqId.current = msg.requestId;
        if (this.sw) {
            this.sw.port.postMessage(msg);
        } else {
            // Legacy worker takes { run: source, mode } (no requestId).
            this.dw!.postMessage({ run: msg.source, mode: msg.mode ?? "run" });
        }
    }
}
