"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.tracesUrl = void 0;
exports.traced = traced;
exports.traceHeader = traceHeader;
exports.endRun = endRun;
const node_async_hooks_1 = require("node:async_hooks");
const node_crypto_1 = require("node:crypto");
const http = __importStar(require("node:http"));
const https = __importStar(require("node:https"));
const core_1 = require("./core");
const proc_1 = require("./proc");
const current = new node_async_hooks_1.AsyncLocalStorage();
const hex = (bytes) => (0, node_crypto_1.randomBytes)(bytes).toString("hex");
function traced(fn) {
    const run = { traceId: hex(16), spanId: hex(8), startedAt: Date.now() };
    return current.run(run, () => fn(run));
}
function traceHeader() {
    const run = current.getStore();
    return run ? { traceparent: `00-${run.traceId}-${run.spanId}-01` } : {};
}
const str = (key, value) => ({ key, value: { stringValue: value } });
const ns = (ms) => `${BigInt(ms) * 1000000n}`;
const warned = new Set();
const tracesUrl = (endpoint) => `${endpoint.replace(/\/+$/, "")}/v1/traces`;
exports.tracesUrl = tracesUrl;
function endRun(run, end) {
    let endpoint;
    try {
        endpoint = (0, proc_1.otlpEndpoint)().endpoint;
        if (endpoint) {
            exportSpan(endpoint, run, end);
        }
    }
    catch (error) {
        warnOnce(endpoint ?? "otlpEndpoint", error instanceof Error ? error.message : String(error));
    }
}
function exportSpan(endpoint, run, end) {
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
    let url;
    try {
        url = new URL((0, exports.tracesUrl)(endpoint));
    }
    catch {
        return warnOnce(endpoint, "not a URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return warnOnce(endpoint, `unsupported protocol ${url.protocol}`);
    }
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
function warnOnce(endpoint, why) {
    if (!warned.has(endpoint)) {
        warned.add(endpoint);
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] trace export to ${(0, core_1.truncate)(endpoint, 80)} failed: ${why} (said once)`);
    }
}
//# sourceMappingURL=trace.js.map