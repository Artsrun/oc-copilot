"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.v1ToolName = void 0;
exports.v2Translator = v2Translator;
const V1_TOOL = { shell: "bash", subagent: "task" };
const v1ToolName = (name) => V1_TOOL[name] ?? name;
exports.v1ToolName = v1ToolName;
const textOf = (content) => Array.isArray(content) ? content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("") : "";
const childOf = (output) => output.match(/<subagent sessionID="([^"]+)"/)?.[1];
function v2Translator() {
    const tools = new Map();
    const models = new Map();
    return (frame) => {
        const type = typeof frame.type === "string" ? frame.type : "";
        const d = (frame.data && typeof frame.data === "object" ? frame.data : {});
        const created = typeof frame.created === "number" ? frame.created : Date.now();
        const sessionID = typeof d.sessionID === "string" ? d.sessionID : undefined;
        const messageID = typeof d.assistantMessageID === "string" ? d.assistantMessageID : undefined;
        const ev = (t, properties) => ({ type: t, properties });
        const kind = type.match(/^session\.(text|reasoning)\.(started|delta|ended)$/);
        if (kind && sessionID && messageID) {
            const partType = kind[1];
            const id = `${messageID}:${partType[0]}${String(d.ordinal ?? 0)}`;
            if (kind[2] === "delta") {
                return typeof d.delta === "string" ? [ev("message.part.delta", { sessionID, messageID, partID: id, field: "text", delta: d.delta })] : [];
            }
            const text = kind[2] === "ended" && typeof d.text === "string" ? d.text : "";
            return [ev("message.part.updated", { part: { id, sessionID, messageID, type: partType, text } })];
        }
        switch (type) {
            case "server.connected":
                return [ev("server.connected", {})];
            case "session.created":
                return sessionID ? [ev("session.created", { info: { id: sessionID, parentID: d.parentID, title: d.title } })] : [];
            case "session.step.started": {
                const model = d.model;
                if (!sessionID || !messageID || typeof model?.id !== "string" || typeof model.providerID !== "string") {
                    return [];
                }
                const m = { providerID: model.providerID, modelID: model.id };
                models.set(messageID, m);
                return [ev("message.updated", { info: { id: messageID, sessionID, role: "assistant", ...m } })];
            }
            case "session.step.ended": {
                if (!sessionID || !messageID) {
                    return [];
                }
                const usage = { ...(typeof d.cost === "number" ? { cost: d.cost } : {}), ...(d.tokens ? { tokens: d.tokens } : {}) };
                return [
                    ev("message.updated", { info: { id: messageID, sessionID, role: "assistant", ...models.get(messageID), ...usage } }),
                    ev("message.part.updated", { part: { id: `${messageID}:finish`, sessionID, messageID, type: "step-finish", reason: d.finish, ...usage } })
                ];
            }
            case "session.tool.input.started":
                if (typeof d.id === "string" && typeof d.name === "string") {
                    tools.set(d.id, { name: d.name, input: {} });
                }
                return sessionID ? [ev("v2.activity", { sessionID })] : [];
            case "session.tool.called":
            case "session.tool.success":
            case "session.tool.failed": {
                const callID = typeof d.id === "string" ? d.id : "";
                if (!sessionID || !callID) {
                    return [];
                }
                const known = tools.get(callID) ?? { name: "tool", input: {} };
                if (type === "session.tool.called") {
                    const input = { ...(d.input ?? {}) };
                    if (known.name === "subagent" && typeof input.agent === "string") {
                        input.subagent_type = input.agent;
                    }
                    tools.set(callID, { ...known, input, start: created });
                    return [ev("message.part.updated", { part: { id: callID, callID, sessionID, messageID, type: "tool", tool: (0, exports.v1ToolName)(known.name), state: { status: "running", input, time: { start: created } } } })];
                }
                const output = type === "session.tool.success" ? textOf(d.content) : "";
                const error = d.error;
                const child = childOf(output);
                const state = {
                    status: type === "session.tool.success" ? "completed" : "error",
                    input: known.input,
                    ...(output ? { output } : {}),
                    ...(type === "session.tool.failed" ? { error: typeof error === "string" ? error : typeof error?.message === "string" ? error.message : "tool failed" } : {}),
                    metadata: { ...(d.metadata ?? {}), ...(child ? { sessionId: child } : {}) },
                    time: { start: known.start ?? created, end: created }
                };
                tools.delete(callID);
                return [ev("message.part.updated", { part: { id: callID, callID, sessionID, messageID, type: "tool", tool: (0, exports.v1ToolName)(known.name), state } })];
            }
            case "session.step.failed":
            case "session.execution.failed": {
                if (!sessionID) {
                    return [];
                }
                const error = (d.error ?? {});
                const message = typeof error.message === "string" ? error.message : "OpenCode reported a failure";
                const name = error.type === "aborted" ? "MessageAbortedError" : typeof error.type === "string" ? error.type : "UnknownError";
                const failed = ev("session.error", { sessionID, error: { name, message, data: { message } } });
                return type === "session.execution.failed" ? [failed, ev("session.idle", { sessionID })] : [failed];
            }
            case "session.retry.scheduled": {
                const error = (d.error ?? {});
                return sessionID
                    ? [ev("session.status", { sessionID, status: { type: "retry", attempt: d.attempt, message: typeof error.message === "string" ? error.message : "", next: d.at } })]
                    : [];
            }
            case "session.execution.succeeded":
            case "session.execution.interrupted":
                return sessionID ? [ev("session.idle", { sessionID })] : [];
            case "permission.asked": {
                if (!sessionID || typeof d.id !== "string") {
                    return [];
                }
                const source = (d.source ?? {});
                return [ev("permission.asked", {
                        id: d.id,
                        sessionID,
                        permission: typeof d.action === "string" ? (0, exports.v1ToolName)(d.action) : "?",
                        patterns: Array.isArray(d.resources) ? d.resources : [],
                        always: Array.isArray(d.save) ? d.save : [],
                        tool: { messageID: source.messageID, callID: source.id }
                    })];
            }
            case "session.inbox.delivered":
                return sessionID ? [ev("v2.delivered", { sessionID, inboxID: d.inboxID })] : [];
            case "session.compaction.ended":
            case "session.compaction.failed":
                return sessionID ? [ev("v2.compaction", { sessionID, ok: type === "session.compaction.ended" })] : [];
            case "permission.replied":
                return sessionID ? [ev("permission.replied", { sessionID, requestID: d.requestID, reply: d.reply })] : [];
            default:
                return sessionID ? [ev("v2.activity", { sessionID })] : [];
        }
    };
}
//# sourceMappingURL=v2-events.js.map