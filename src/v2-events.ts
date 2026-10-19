// OpenCode 2's events (`GET /api/event`) as the 1.x events the runners read,
// so run-steps, asks and the SSE demux need no second vocabulary. Measured on
// 2.0.29 (scripts/fixtures/wire-v2.json, REFS): every frame is `{id, created,
// type, location?, data, durable?}` and every session event carries
// `data.sessionID`. Event names not seen in a recording (tool failure,
// reasoning, a failed execution) are the ones the 2.0.29 binary declares.
// Stateful per stream: a tool's name, input and start, a step's model. Leaf.

type Frame = Record<string, unknown>;
type Event = { type: string; properties: Record<string, unknown> };

// 2.x renamed the two tools the bridge reads by name (REFS).
const V1_TOOL: Record<string, string> = { shell: "bash", subagent: "task" };
export const v1ToolName = (name: string): string => V1_TOOL[name] ?? name;

const textOf = (content: unknown): string =>
    Array.isArray(content) ? content.map((c) => (c && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("") : "";

// A subagent's result names its session: `<subagent sessionID="ses_…" state="completed">`.
const childOf = (output: string): string | undefined => output.match(/<subagent sessionID="([^"]+)"/)?.[1];

/** A translator for one event stream: each v2 frame → the 1.x events it stands for. */
export function v2Translator(): (frame: Frame) => Event[] {
    const tools = new Map<string, { name: string; input: Record<string, unknown>; start?: number }>();
    const models = new Map<string, { providerID: string; modelID: string }>();
    return (frame) => {
        const type = typeof frame.type === "string" ? frame.type : "";
        const d = (frame.data && typeof frame.data === "object" ? frame.data : {}) as Record<string, unknown>;
        const created = typeof frame.created === "number" ? frame.created : Date.now();
        const sessionID = typeof d.sessionID === "string" ? d.sessionID : undefined;
        const messageID = typeof d.assistantMessageID === "string" ? d.assistantMessageID : undefined;
        const ev = (t: string, properties: Record<string, unknown>): Event => ({ type: t, properties });
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
                const model = d.model as { id?: unknown; providerID?: unknown } | undefined;
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
                    const input = { ...((d.input as Record<string, unknown> | undefined) ?? {}) };
                    // A 1.x task names its agent `subagent_type`; 2.x's subagent says `agent`.
                    if (known.name === "subagent" && typeof input.agent === "string") {
                        input.subagent_type = input.agent;
                    }
                    tools.set(callID, { ...known, input, start: created });
                    return [ev("message.part.updated", { part: { id: callID, callID, sessionID, messageID, type: "tool", tool: v1ToolName(known.name), state: { status: "running", input, time: { start: created } } } })];
                }
                const output = type === "session.tool.success" ? textOf(d.content) : "";
                const error = d.error as { message?: unknown } | string | undefined;
                const child = childOf(output);
                const state = {
                    status: type === "session.tool.success" ? "completed" : "error",
                    input: known.input,
                    ...(output ? { output } : {}),
                    ...(type === "session.tool.failed" ? { error: typeof error === "string" ? error : typeof error?.message === "string" ? error.message : "tool failed" } : {}),
                    metadata: { ...((d.metadata as Record<string, unknown> | undefined) ?? {}), ...(child ? { sessionId: child } : {}) },
                    time: { start: known.start ?? created, end: created }
                };
                tools.delete(callID);
                return [ev("message.part.updated", { part: { id: callID, callID, sessionID, messageID, type: "tool", tool: v1ToolName(known.name), state } })];
            }
            case "session.step.failed":
            case "session.execution.failed": {
                if (!sessionID) {
                    return [];
                }
                const error = (d.error ?? {}) as { type?: unknown; message?: unknown };
                const message = typeof error.message === "string" ? error.message : "OpenCode reported a failure";
                const name = error.type === "aborted" ? "MessageAbortedError" : typeof error.type === "string" ? error.type : "UnknownError";
                const failed = ev("session.error", { sessionID, error: { name, message, data: { message } } });
                return type === "session.execution.failed" ? [failed, ev("session.idle", { sessionID })] : [failed];
            }
            case "session.execution.succeeded":
            case "session.execution.interrupted":
                return sessionID ? [ev("session.idle", { sessionID })] : [];
            case "permission.asked": {
                if (!sessionID || typeof d.id !== "string") {
                    return [];
                }
                const source = (d.source ?? {}) as { messageID?: unknown; id?: unknown };
                return [ev("permission.asked", {
                    id: d.id,
                    sessionID,
                    permission: typeof d.action === "string" ? v1ToolName(d.action) : "?",
                    patterns: Array.isArray(d.resources) ? d.resources : [],
                    always: Array.isArray(d.save) ? d.save : [],
                    tool: { messageID: source.messageID, callID: source.id }
                })];
            }
            // Not 1.x events: what oc-api waits on. A prompt is queued (its inbox
            // id) and its run ends with the session's next execution end; a summary
            // ends with compaction.ended or .failed (2.0.29: failed on the scripted model).
            case "session.inbox.delivered":
                return sessionID ? [ev("v2.delivered", { sessionID, inboxID: d.inboxID })] : [];
            case "session.compaction.ended":
            case "session.compaction.failed":
                return sessionID ? [ev("v2.compaction", { sessionID, ok: type === "session.compaction.ended" })] : [];
            case "permission.replied":
                return sessionID ? [ev("permission.replied", { sessionID, requestID: d.requestID, reply: d.reply })] : [];
            default:
                // Still this session's activity (a tool's progress, a queued
                // prompt): the idle cap must not stop a run that is working.
                return sessionID ? [ev("v2.activity", { sessionID })] : [];
        }
    };
}
