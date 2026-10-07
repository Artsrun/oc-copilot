"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REPLY_CONFIRM_MS = void 0;
exports.answerAsk = answerAsk;
exports.setReplyConfirmWait = setReplyConfirmWait;
exports.watchFamily = watchFamily;
const core_1 = require("./core");
const followups_1 = require("./followups");
const net_1 = require("./net");
const server_session_1 = require("./server-session");
const run_steps_1 = require("./run-steps");
const metrics_1 = require("./metrics");
const AGENT_IN_TITLE = /\(@([\w./-]+) subagent\)\s*$/;
function answerAsk(base, cwd, sessionId, ev, opts, sent) {
    const type = ev.type;
    const props = ev.properties ?? {};
    const id = typeof props.id === "string" ? props.id : "";
    if (!id || props.sessionID !== sessionId) {
        return;
    }
    let url;
    let body;
    let said;
    let permission = false;
    if ((type === "permission.asked" || type === "permission.updated") && opts.permissions) {
        const legacy = type === "permission.updated";
        url = legacy ? (0, server_session_1.sessionPath)(sessionId, `permissions/${(0, server_session_1.safeSessionId)(id)}`) : `/permission/${(0, server_session_1.safeSessionId)(id)}/reply`;
        body = legacy
            ? { response: opts.autoApprove ? "once" : "reject" }
            : opts.autoApprove ? { reply: "once" } : { reply: "reject", message: (0, followups_1.prompt)("READ_ONLY") };
        const patterns = [props.patterns, props.pattern].flat().filter((p) => typeof p === "string").join(", ");
        said = `permission ${String(props.permission ?? props.type ?? "?")} (${(0, core_1.truncate)(patterns, 120)}) → ${opts.autoApprove ? "approved once" : "rejected: read-only turn"}${legacy ? " [pre-1.1 event]" : ""}`;
        permission = true;
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
    const post = () => void (0, net_1.httpRequestJson)("POST", (0, net_1.withDirectory)(`${base}${url}`, cwd), body, 5000).catch((error) => core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] could not answer ${type} ${id}: ${error}`));
    post();
    if (permission) {
        sent?.(id, post);
    }
}
exports.REPLY_CONFIRM_MS = 3000;
let replyConfirmMs = exports.REPLY_CONFIRM_MS;
function setReplyConfirmWait(ms) {
    replyConfirmMs = ms ?? exports.REPLY_CONFIRM_MS;
}
function watchFamily(base, cwd, root, opts, hooks = {}) {
    const family = new Set([root]);
    const costs = new Map();
    const agents = new Map();
    const tasks = new Map();
    const answered = new Set();
    const awaiting = new Map();
    const confirm = (id, again) => {
        let resent = false;
        const wait = () => {
            const timer = setTimeout(() => {
                if (resent) {
                    awaiting.delete(id);
                    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] permission ${id}: still no permission.replied; the run may be waiting on it`);
                    return;
                }
                resent = true;
                core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${(0, followups_1.mark)("warn")} permission ${id}: no permission.replied after ${Math.round(replyConfirmMs / 100) / 10}s — replying once more`);
                again();
                wait();
            }, replyConfirmMs);
            timer.unref?.();
            awaiting.set(id, timer);
        };
        wait();
    };
    const sse = (0, net_1.connectSse)(base, (ev) => {
        const props = ev.properties ?? {};
        const evSession = (0, net_1.sessionIdFromEvent)(ev);
        if (evSession && evSession !== root && family.has(evSession)) {
            hooks.onActivity?.();
        }
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
                tasks.set(child, (0, core_1.truncate)((0, run_steps_1.stepDetail)(input)));
            }
            if (partSession !== root && part.type === "tool" && hooks.onSubagent) {
                const time = state?.time;
                const durationMs = typeof time?.start === "number" && typeof time.end === "number" ? time.end - time.start : undefined;
                const done = durationMs !== undefined || state?.status === "completed" || state?.status === "error";
                hooks.onSubagent({
                    agent: agents.get(partSession) ?? "subagent",
                    task: tasks.get(partSession),
                    step: {
                        tool: String(part.tool ?? "tool"),
                        detail: (0, core_1.truncate)((0, run_steps_1.stepDetail)(input, "")),
                        durationMs,
                        status: done ? "done" : "running",
                        filePath: (0, metrics_1.toolFilePath)(input)
                    }
                });
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
            if (ev.type === "permission.replied") {
                const replied = typeof props.requestID === "string" ? props.requestID : typeof props.permissionID === "string" ? props.permissionID : "";
                clearTimeout(awaiting.get(replied));
                awaiting.delete(replied);
                return;
            }
            const permissionAsk = ev.type === "permission.asked" || ev.type === "permission.updated";
            if (permissionAsk && typeof props.id === "string" && answered.has(props.id)) {
                return;
            }
            answerAsk(base, cwd, props.sessionID, ev, opts, (id, again) => {
                answered.add(id);
                confirm(id, again);
            });
        }
    }, () => undefined);
    return {
        close: () => {
            for (const timer of awaiting.values()) {
                clearTimeout(timer);
            }
            awaiting.clear();
            sse.close();
        },
        children: () => [...family].filter((id) => id !== root),
        childCost: () => [...costs.values()].reduce((n, c) => n + c, 0)
    };
}
//# sourceMappingURL=asks.js.map