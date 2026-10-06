"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.blankMetrics = exports.stepDetail = void 0;
exports.noteModel = noteModel;
exports.addSubagents = addSubagents;
exports.noteTask = noteTask;
exports.markFirstByte = markFirstByte;
exports.emitKeyedDelta = emitKeyedDelta;
exports.applyServerPart = applyServerPart;
const core_1 = require("./core");
const metrics_1 = require("./metrics");
const stepDetail = (input, fallback) => {
    const agent = typeof input?.subagent_type === "string" ? input.subagent_type : "";
    const description = input?.description;
    if (agent) {
        return description ? `${agent}: ${description}` : agent;
    }
    return (input?.command ??
        input?.filePath ??
        input?.pattern ??
        description ??
        fallback ??
        JSON.stringify(input ?? {}));
};
exports.stepDetail = stepDetail;
const blankMetrics = (sessionId) => ({
    firstByteMs: undefined,
    totalMs: 0,
    timedOut: false,
    steps: [],
    tokens: (0, metrics_1.emptyTokens)(),
    cost: 0,
    hadOutput: false,
    sessionId,
    reasoning: ""
});
exports.blankMetrics = blankMetrics;
function noteModel(ev, metrics) {
    if (ev.type !== "message.updated") {
        return;
    }
    const info = (ev.properties?.info ?? {});
    if (info.role === "assistant" && typeof info.providerID === "string" && typeof info.modelID === "string") {
        metrics.model = `${info.providerID}/${info.modelID}`;
    }
}
function addSubagents(metrics, children, cost) {
    if (!children.length) {
        return;
    }
    metrics.subagents = { count: children.length, cost };
    metrics.cost += cost;
}
function noteTask(part, metrics) {
    if (part.tool !== "task") {
        return;
    }
    const state = part.state;
    const meta = state?.metadata;
    if (state?.status !== "error" && meta?.interrupted !== true) {
        return;
    }
    const input = state?.input;
    const agent = typeof input?.subagent_type === "string" ? input.subagent_type : "";
    if (!agent) {
        return;
    }
    const description = typeof input?.description === "string" ? input.description : "";
    const sessionId = typeof meta?.sessionId === "string" ? meta.sessionId : undefined;
    const list = (metrics.failedTasks ??= []);
    if (!list.some((t) => t.agent === agent && t.description === description)) {
        list.push({ agent, description, sessionId });
    }
}
function markFirstByte(metrics, started) {
    if (metrics.firstByteMs === undefined) {
        metrics.firstByteMs = Date.now() - started;
    }
}
function emitKeyedDelta(kind, text, part, emitted, cursor, index) {
    const rawId = part.id;
    let key = typeof rawId === "string" && rawId ? `${kind}:${rawId}` : undefined;
    if (!key && index !== undefined) {
        key = `${kind}:i${index}`;
        cursor.last[kind] = key;
    }
    if (!key) {
        const last = cursor.last[kind];
        const prev = last ? (emitted.get(last) ?? 0) : 0;
        if (last && text.length >= prev) {
            key = last;
        }
        else {
            cursor.n += 1;
            key = `${kind}:i${cursor.n}`;
            cursor.last[kind] = key;
        }
    }
    else {
        cursor.last[kind] = key;
    }
    const prev = emitted.get(key) ?? 0;
    if (text.length <= prev) {
        return undefined;
    }
    emitted.set(key, text.length);
    return text.slice(prev);
}
function applyServerPart(part, metrics, options, started, emitted, tools, cursor = { n: 0, last: {} }, index) {
    const type = part.type;
    if (type === "reasoning") {
        const text = part.text ?? "";
        if (!text) {
            return;
        }
        const delta = emitKeyedDelta("r", text, part, emitted, cursor, index);
        if (!delta) {
            return;
        }
        markFirstByte(metrics, started);
        metrics.reasoning += (metrics.reasoning && !metrics.reasoning.endsWith("\n") ? "\n" : "") + delta;
        options.onReasoning?.(delta);
        return;
    }
    if (type === "text") {
        const text = part.text ?? "";
        if (!text) {
            return;
        }
        const delta = emitKeyedDelta("t", text, part, emitted, cursor, index);
        if (!delta) {
            return;
        }
        markFirstByte(metrics, started);
        metrics.hadOutput = true;
        options.onText?.(delta);
        return;
    }
    if (type === "tool" || type === "tool_use") {
        const tool = part.tool ?? "tool";
        const state = part.state;
        const input = state?.input;
        const time = state?.time;
        const durationMs = time?.start !== undefined && time?.end !== undefined ? time.end - time.start : undefined;
        const key = String(part.id ?? `${tool}:${JSON.stringify(input ?? {})}`);
        const detail = (0, core_1.truncate)((0, exports.stepDetail)(input));
        markFirstByte(metrics, started);
        const output = (0, metrics_1.stepOutput)(state);
        const filePath = (0, metrics_1.toolFilePath)(input);
        noteTask(part, metrics);
        const existing = tools.get(key);
        if (existing) {
            if (durationMs !== undefined) {
                existing.durationMs = durationMs;
                existing.status = "done";
            }
            if (detail && existing.detail !== detail) {
                existing.detail = detail;
            }
            if (output) {
                existing.output = output;
            }
            existing.filePath = existing.filePath ?? filePath;
            options.onStep?.(existing);
            return;
        }
        const step = {
            tool,
            detail,
            durationMs,
            output: output || undefined,
            status: durationMs !== undefined ? "done" : "running",
            filePath
        };
        tools.set(key, step);
        metrics.steps.push(step);
        options.onStep?.(step);
    }
}
//# sourceMappingURL=run-steps.js.map