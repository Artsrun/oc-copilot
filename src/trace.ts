// W3C trace context for a run, and the run's own span (0.0.247). OpenCode 2's
// request spans join an incoming `traceparent`; its model work runs in a trace of
// its own that carries `session.id` (2.3.2, REFS 0.0.244). So the bridge sends one
// traceparent on every API request of a run, and with an OTLP endpoint exports the
// span those requests name as parent, with the session id the model work shares.
// The context rides AsyncLocalStorage, as OpenTelemetry's own Node context does:
// nothing is threaded through call sites, and two runs at once never mix.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";

import { logChannel, stamp, truncate } from "./core";
import { otlpEndpoint, otlpUnpostable } from "./proc";

export interface RunTrace {
    traceId: string;
    spanId: string;
    startedAt: number;
    /** Set once the run has a session: the span's `session.id`. */
    sessionId?: string;
}

const current = new AsyncLocalStorage<RunTrace>();
const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

/** `fn` and everything it starts, timers and callbacks included, run in a trace of their own. */
export function traced<T>(fn: (run: RunTrace) => Promise<T>): Promise<T> {
    const run: RunTrace = { traceId: hex(16), spanId: hex(8), startedAt: Date.now() };
    return current.run(run, () => fn(run));
}

/** The header a request made now carries, if a run made it. */
export function traceHeader(): Record<string, string> {
    const run = current.getStore();
    return run ? { traceparent: `00-${run.traceId}-${run.spanId}-01` } : {};
}

export interface RunEnd {
    agent?: string;
    model?: string;
    readOnly: boolean;
    outcome: "done" | "timeout" | "cancelled" | "error";
}

// OTLP/HTTP JSON: ids are hex, times are nanosecond strings, attributes typed.
const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
const ns = (ms: number): string => `${BigInt(ms) * 1_000_000n}`;
const warned = new Set<string>();

/** The signal URL of an OTLP base endpoint (the spec's per-signal path, appended once). */
export const tracesUrl = (endpoint: string): string => `${endpoint.replace(/\/+$/, "")}/v1/traces`;

/** Exports the run's span when an endpoint is in force. Never awaited, never throws:
 * it runs after a finished run, and a throw here reported that run failed, so the
 * server-failed fallback posted its prompt again (0.0.247, `localhost:4318`). A
 * collector that is down, or an endpoint it cannot post to, costs one log line. */
export function endRun(run: RunTrace, end: RunEnd): void {
    let endpoint: string | undefined;
    try {
        endpoint = otlpEndpoint().endpoint;
        if (endpoint) {
            exportSpan(endpoint, run, end);
        }
    } catch (error) {
        warnOnce(endpoint ?? "otlpEndpoint", error instanceof Error ? error.message : String(error));
    }
}

function exportSpan(endpoint: string, run: RunTrace, end: RunEnd): void {
    const agent = end.agent ?? "build";
    const attributes = [
        str("gen_ai.operation.name", "invoke_agent"),
        str("gen_ai.agent.name", agent),
        ...(run.sessionId ? [str("session.id", run.sessionId), str("gen_ai.conversation.id", run.sessionId)] : []),
        ...(end.model ? [str("gen_ai.request.model", end.model)] : []),
        { key: "opencode.bridge.read_only", value: { boolValue: end.readOnly } },
        str("opencode.bridge.outcome", end.outcome)
    ];
    const body = JSON.stringify({
        resourceSpans: [{
            resource: { attributes: [str("service.name", "opencode-copilot-bridge")] },
            scopeSpans: [{
                scope: { name: "opencode-copilot-bridge" },
                spans: [{
                    traceId: run.traceId,
                    spanId: run.spanId,
                    name: `invoke_agent ${agent}`,
                    kind: 3,
                    startTimeUnixNano: ns(run.startedAt),
                    endTimeUnixNano: ns(Math.max(Date.now(), run.startedAt + 1)),
                    attributes,
                    status: { code: end.outcome === "error" ? 2 : end.outcome === "done" ? 1 : 0 }
                }]
            }]
        }]
    });
    const unpostable = otlpUnpostable(endpoint);
    if (unpostable) {
        return warnOnce(endpoint, unpostable);
    }
    const url = new URL(tracesUrl(endpoint));
    const send = url.protocol === "https:" ? https.request : http.request;
    const req = send(url, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
        res.resume();
        if ((res.statusCode ?? 0) >= 300) {
            warnOnce(endpoint, `HTTP ${res.statusCode}`);
        }
    });
    req.setTimeout(3000, () => req.destroy(new Error("timed out after 3 s")));
    req.on("error", (error) => warnOnce(endpoint, error.message));
    req.end(body);
}

function warnOnce(endpoint: string, why: string): void {
    if (!warned.has(endpoint)) {
        warned.add(endpoint);
        logChannel.appendLine(`[${stamp()}] trace export to ${truncate(endpoint, 80)} failed: ${why} (said once)`);
    }
}
