"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.answerAsk = answerAsk;
exports.watchFamily = watchFamily;
const core_1 = require("./core");
const followups_1 = require("./followups");
const net_1 = require("./net");
const server_session_1 = require("./server-session");
const run_steps_1 = require("./run-steps");
const AGENT_IN_TITLE = /\(@([\w./-]+) subagent\)\s*$/;
function answerAsk(base, cwd, sessionId, ev, opts) {
    const type = ev.type;
    const props = ev.properties ?? {};
    const id = typeof props.id === "string" ? props.id : "";
    if (!id || props.sessionID !== sessionId) {
        return;
    }
    let url;
    let body;
    let said;
    if (type === "permission.asked" && opts.permissions) {
        url = `/permission/${(0, server_session_1.safeSessionId)(id)}/reply`;
        body = opts.autoApprove ? { reply: "once" } : { reply: "reject", message: (0, followups_1.prompt)("READ_ONLY") };
        const patterns = Array.isArray(props.patterns) ? props.patterns.join(", ") : "";
        said = `permission ${String(props.permission ?? "?")} (${(0, core_1.truncate)(patterns, 120)}) → ${opts.autoApprove ? "approved once" : "rejected: read-only turn"}`;
    }
    else if (type === "question.asked") {
        const questions = Array.isArray(props.questions) ? props.questions : [];
        url = `/question/${(0, server_session_1.safeSessionId)(id)}/reply`;
        body = { answers: (questions.length ? questions : [undefined]).map(() => [(0, followups_1.prompt)("NO_QUESTIONS")]) };
        said = `question → answered "ask in your reply" (${questions.length} asked)`;
    }
    else {
        return;
    }
    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${(0, followups_1.mark)("warn")} ${said}`);
    void (0, net_1.httpRequestJson)("POST", (0, net_1.withDirectory)(`${base}${url}`, cwd), body, 5000).catch((error) => core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] could not answer ${type} ${id}: ${error}`));
}
function watchFamily(base, cwd, root, opts, hooks = {}) {
    const family = new Set([root]);
    const costs = new Map();
    const agents = new Map();
    const sse = (0, net_1.connectSse)(base, (ev) => {
        const props = ev.properties ?? {};
        if (ev.type === "session.created" || ev.type === "session.updated") {
            const info = props.info;
            if (typeof info?.id === "string" && typeof info.parentID === "string" && family.has(info.parentID)) {
                family.add(info.id);
                const named = typeof info.title === "string" ? info.title.match(AGENT_IN_TITLE)?.[1] : undefined;
                if (named && !agents.has(info.id)) {
                    agents.set(info.id, named);
                }
            }
            return;
        }
        const part = props.part;
        const partSession = typeof part?.sessionID === "string" ? part.sessionID : undefined;
        if (part && partSession && family.has(partSession)) {
            const state = part.state;
            const input = state?.input;
            const child = state?.metadata?.sessionId;
            if (part.tool === "task" && typeof child === "string" && typeof input?.subagent_type === "string") {
                agents.set(child, input.subagent_type);
            }
            if (partSession !== root) {
                hooks.onActivity?.();
                if (part.type === "tool" && state?.status === "running" && hooks.onSubagent) {
                    const tool = String(part.tool ?? "tool");
                    const detail = (0, core_1.truncate)((0, run_steps_1.stepDetail)(input, ""), 60);
                    hooks.onSubagent(`${agents.get(partSession) ?? "subagent"} › ${tool}${detail && detail !== "{}" ? ` ${detail}` : ""}`);
                }
            }
        }
        if (ev.type === "message.updated") {
            const info = props.info;
            if (info?.role === "assistant" &&
                typeof info.id === "string" &&
                typeof info.sessionID === "string" &&
                info.sessionID !== root &&
                family.has(info.sessionID) &&
                typeof info.cost === "number") {
                costs.set(info.id, info.cost);
            }
            return;
        }
        if (typeof props.sessionID === "string" && family.has(props.sessionID)) {
            answerAsk(base, cwd, props.sessionID, ev, opts);
        }
    }, () => undefined);
    return {
        close: sse.close,
        children: () => [...family].filter((id) => id !== root),
        childCost: () => [...costs.values()].reduce((n, c) => n + c, 0)
    };
}
//# sourceMappingURL=asks.js.map