"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runOpenCodeServer = runOpenCodeServer;
const core_1 = require("./core");
const followups_1 = require("./followups");
const net_1 = require("./net");
const metrics_1 = require("./metrics");
const asks_1 = require("./asks");
const run_steps_1 = require("./run-steps");
const server_session_1 = require("./server-session");
async function runOpenCodeServer(options) {
    const started = Date.now();
    const idleMs = options.idleTimeoutMs ?? 0;
    let lastEventAt = Date.now();
    const markServerActive = () => {
        lastEventAt = Date.now();
    };
    const metrics = (0, run_steps_1.blankMetrics)(options.sessionId);
    metrics.appliedTimeoutMs = options.timeoutMs;
    const emitted = new Map();
    const tools = new Map();
    const cursor = { n: 0, last: {} };
    const partKinds = new Map();
    let lastRetry = -1;
    let aborting = false;
    const base = options.serverUrl ?? (await (0, net_1.ensureServer)(options.cwd));
    const scoped = (path) => (0, net_1.withDirectory)(`${base}${path}`, options.cwd);
    const readOnly = Boolean(options.readOnly);
    let sessionId = options.sessionId;
    if (!sessionId) {
        const created = await (0, net_1.httpRequestJson)("POST", scoped("/session"), {
            title: (0, core_1.truncate)(options.task, 60),
            permission: (0, server_session_1.turnPermission)(readOnly)
        });
        sessionId = created.id;
        (0, server_session_1.noteTurnPermission)(base, sessionId, readOnly);
    }
    else {
        await (0, server_session_1.applyTurnPermission)(base, options.cwd, sessionId, readOnly);
    }
    metrics.sessionId = sessionId;
    const mine = sessionId;
    const body = { parts: [{ type: "text", text: options.task }] };
    if (options.agent) {
        body.agent = options.agent;
    }
    if (options.model) {
        const i = options.model.indexOf("/");
        if (i > 0) {
            body.model = { providerID: options.model.slice(0, i), modelID: options.model.slice(i + 1) };
        }
    }
    if (options.variant) {
        body.variant = options.variant;
    }
    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] → server ${base}${(0, server_session_1.sessionPath)(sessionId, "message")} ` +
        `(agent=${options.agent ?? "-"} model=${options.model ?? "-"}${options.variant ? ` variant=${options.variant}` : ""})`);
    let attached = () => undefined;
    const subscribed = new Promise((resolve) => {
        attached = resolve;
    });
    const sse = (0, net_1.connectSse)(base, (ev) => {
        if ((0, net_1.sessionIdFromEvent)(ev) === mine) {
            markServerActive();
        }
        const props = ev.properties ?? ev;
        const part = (props.part ?? ev.part);
        const type = ev.type;
        (0, run_steps_1.notePartKind)(part, partKinds);
        const delta = (0, run_steps_1.partDeltaOf)(ev, mine, partKinds);
        if (delta) {
            (0, run_steps_1.applyPartDelta)(delta, metrics, options, started, emitted);
            return;
        }
        const retry = (0, run_steps_1.providerRetryOf)(ev, mine);
        if (retry) {
            if (retry.attempt !== lastRetry) {
                lastRetry = retry.attempt;
                core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${(0, followups_1.mark)("quiet")} provider retry ${retry.attempt}: ${retry.message || "no reason given"}`);
            }
            options.onRetry?.(retry);
            return;
        }
        (0, run_steps_1.noteModel)(ev, metrics);
        if (type === "session.error" && !aborting) {
            const err = (props.error ?? props.message ?? ev.error);
            const text = typeof err === "string" ? err : err?.message ?? err?.name ?? "unknown session error";
            metrics.error = text;
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${(0, followups_1.mark)("fail")} session.error: ${metrics.error}`);
        }
        if (part && (type === "message.part.updated" || type === undefined || type.startsWith("message"))) {
            (0, run_steps_1.applyServerPart)(part, metrics, options, started, emitted, tools, cursor);
        }
        if (type === "text" || type === "reasoning" || type === "tool_use" || type === "tool") {
            (0, run_steps_1.applyServerPart)(part ?? { type, text: ev.text, tool: ev.tool, state: ev.state }, metrics, options, started, emitted, tools, cursor);
        }
    }, (status) => {
        if (status === "connected") {
            attached();
        }
    }, sessionId);
    const family = (0, asks_1.watchFamily)(base, options.cwd, mine, { permissions: true, autoApprove: options.autoApprove && !readOnly }, { onActivity: markServerActive, onSubagent: options.onSubagent });
    let closed = false;
    const closeStreams = () => {
        if (closed) {
            return;
        }
        closed = true;
        sse.close();
        (0, run_steps_1.addSubagents)(metrics, family.children(), family.childCost());
        family.close();
    };
    await Promise.race([subscribed, (0, core_1.delay)(80)]);
    let resp;
    let idleTimer;
    let idleFired = false;
    try {
        const pending = (0, net_1.httpRequestJson)("POST", scoped((0, server_session_1.sessionPath)(sessionId, "message")), body, options.timeoutMs, options.token);
        if (idleMs > 0) {
            const toolQuietMs = Math.max(0, options.toolQuietMs ?? 0);
            const watchdog = new Promise((_, reject) => {
                idleTimer = setInterval(() => {
                    const quietFor = Date.now() - lastEventAt;
                    const running = [...tools.values()].find((s) => s.status === "running");
                    const cap = running && toolQuietMs > idleMs ? toolQuietMs : idleMs;
                    if (quietFor >= cap) {
                        idleFired = true;
                        if (running) {
                            metrics.stuckTool = running.tool;
                        }
                        const err = new Error(`no output for ${Math.round(quietFor / 1000)}s`);
                        err.code = "ETIMEDOUT_BRIDGE";
                        reject(err);
                    }
                }, 1000);
                idleTimer.unref?.();
            });
            resp = await Promise.race([pending, watchdog]);
        }
        else {
            resp = await pending;
        }
    }
    catch (error) {
        const code = error.code;
        if (code === "ETIMEDOUT_BRIDGE" || code === "ECANCELLED_BRIDGE") {
            metrics.timedOut = code === "ETIMEDOUT_BRIDGE";
            if (idleFired) {
                metrics.idleTimeout = true;
                core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${(0, followups_1.mark)("quiet")} ${error.message} — aborting the server run`);
            }
            aborting = true;
            const abort = (0, net_1.httpRequestJson)("POST", scoped((0, server_session_1.sessionPath)(sessionId, "abort")), undefined, 5000).catch(() => undefined);
            void (0, server_session_1.abortChildren)(base, sessionId, options.cwd, family.children());
            if (code !== "ECANCELLED_BRIDGE") {
                await abort;
            }
            metrics.totalMs = Date.now() - started;
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] server run ${metrics.timedOut ? "timed out" : "cancelled"}`);
            closeStreams();
            return metrics;
        }
        closeStreams();
        throw error;
    }
    finally {
        if (idleTimer) {
            clearInterval(idleTimer);
        }
    }
    try {
        if (resp.info?.providerID && resp.info.modelID) {
            metrics.model = `${resp.info.providerID}/${resp.info.modelID}`;
        }
        const tk = resp.info?.tokens;
        if (tk) {
            metrics.context = (0, metrics_1.contextOf)(tk) || metrics.context;
            metrics.tokens.input += tk.input ?? 0;
            metrics.tokens.output += tk.output ?? 0;
            metrics.tokens.reasoning += tk.reasoning ?? 0;
            metrics.tokens.total += tk.total ?? 0;
            metrics.tokens.cache.read += tk.cache?.read ?? 0;
            metrics.tokens.cache.write += tk.cache?.write ?? 0;
        }
        if (resp.info?.cost !== undefined) {
            metrics.cost += resp.info.cost ?? 0;
        }
        (resp.parts ?? []).forEach((part, i) => {
            (0, run_steps_1.applyServerPart)(part, metrics, options, started, emitted, tools, cursor, i + 1);
        });
        if (metrics.firstByteMs === undefined && (metrics.hadOutput || metrics.reasoning || metrics.steps.length)) {
            metrics.firstByteMs = Date.now() - started;
        }
        metrics.totalMs = Date.now() - started;
        return metrics;
    }
    finally {
        closeStreams();
    }
}
//# sourceMappingURL=run-server.js.map