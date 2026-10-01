"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionRoot = exports.sessionPath = exports.HEADLESS_PERMISSION = void 0;
exports.runOpenCode = runOpenCode;
exports.isMissingSessionError = isMissingSessionError;
exports.sessionBusy = sessionBusy;
exports.abortServerRun = abortServerRun;
exports.createServerSession = createServerSession;
exports.isAttachFailure = isAttachFailure;
exports.isMissingSessionRun = isMissingSessionRun;
exports.restartAfterMissingSession = restartAfterMissingSession;
exports.emitKeyedDelta = emitKeyedDelta;
exports.applyServerPart = applyServerPart;
exports.runOpenCodeServer = runOpenCodeServer;
exports.sessionModel = sessionModel;
exports.compactSession = compactSession;
exports.safeSessionId = safeSessionId;
const core_1 = require("./core");
const followups_1 = require("./followups");
const proc_1 = require("./proc");
const net_1 = require("./net");
const metrics_1 = require("./metrics");
const session_1 = require("./session");
const STDERR_CAP = 256 * 1024;
function runOpenCode(options) {
    return new Promise((resolve, reject) => {
        const args = ["run"];
        if (options.attachUrl) {
            args.push("--attach", options.attachUrl, "--dir", options.cwd);
        }
        if (options.agent) {
            args.push("--agent", options.agent);
        }
        if (options.model) {
            args.push("--model", options.model);
        }
        if (options.sessionId) {
            args.push("--session", safeSessionId(options.sessionId));
        }
        if (options.pure) {
            args.push("--pure");
        }
        if (options.autoApprove) {
            args.push("--auto");
        }
        if (options.json) {
            args.push("--format", "json");
        }
        if (options.thinking) {
            args.push("--thinking");
        }
        args.push(options.task);
        if (options.token?.isCancellationRequested) {
            resolve({
                firstByteMs: undefined,
                totalMs: 0,
                timedOut: false,
                steps: [],
                tokens: (0, metrics_1.emptyTokens)(),
                cost: 0,
                hadOutput: false,
                sessionId: options.sessionId,
                reasoning: ""
            });
            return;
        }
        let child;
        try {
            child = (0, proc_1.spawnOpenCode)(options.executable, args, options.cwd);
        }
        catch (error) {
            reject(error);
            return;
        }
        child.stdin?.end();
        const metrics = {
            firstByteMs: undefined,
            totalMs: 0,
            timedOut: false,
            steps: [],
            tokens: (0, metrics_1.emptyTokens)(),
            cost: 0,
            hadOutput: false,
            sessionId: options.sessionId,
            reasoning: ""
        };
        let buffer = "";
        let settled = false;
        const started = Date.now();
        const runningTools = new Map();
        const toolQuietMs = Math.max(0, options.toolQuietMs ?? 0);
        let sse;
        if (options.attachUrl && options.sessionId) {
            const mine = options.sessionId;
            const attachUrl = options.attachUrl;
            sse = (0, net_1.connectSse)(attachUrl, (ev) => {
                const props = ev.properties ?? ev;
                const part = (props.part ?? ev.part);
                if ((0, net_1.sessionIdFromEvent)(ev) !== mine || settled) {
                    return;
                }
                markActive();
                answerAsk(attachUrl, options.cwd, mine, ev, { permissions: false, autoApprove: options.autoApprove });
                noteModel(ev, metrics);
                if (part && (part.type === "tool" || part.type === "reasoning" || part.type === "text")) {
                    metrics.serverActivity = true;
                }
                if (part?.type !== "tool") {
                    return;
                }
                const id = String(part.id ?? part.callID ?? "");
                const state = part.state;
                const status = state?.status;
                const tool = String(part.tool ?? "tool");
                if (status === "running" || status === "pending") {
                    const input = state?.input;
                    const detail = (0, core_1.truncate)(String(input?.command ?? input?.filePath ?? input?.pattern ?? input?.description ?? state?.title ?? ""), 240);
                    const known = runningTools.get(id);
                    if (!known || (!known.detail && detail)) {
                        runningTools.set(id, { tool, since: known?.since ?? Date.now(), detail });
                        options.onStep?.({ tool, detail: detail ? `${detail} (running)` : "running", durationMs: undefined, status: "running" });
                    }
                }
                else {
                    runningTools.delete(id);
                }
            }, () => undefined, mine);
        }
        const tools = new Map();
        let markActive = () => undefined;
        const handleEvent = (rawEvent) => {
            markActive();
            const props = rawEvent.properties ?? rawEvent;
            const part = (rawEvent.part ?? props.part);
            let type = rawEvent.type;
            if (type === "message.part.updated" && part?.type) {
                type = part.type === "tool" ? "tool_use" : part.type;
            }
            const sessionId = rawEvent.sessionID ??
                props.sessionID;
            if (sessionId) {
                metrics.sessionId = sessionId;
            }
            switch (type) {
                case "step_start":
                    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ▶ step start`);
                    break;
                case "tool_use":
                case "tool": {
                    if (!part) {
                        break;
                    }
                    const tool = part.tool ?? "tool";
                    const state = part.state;
                    const input = state?.input;
                    const time = state?.time;
                    const durationMs = time?.start !== undefined && time?.end !== undefined
                        ? time.end - time.start
                        : undefined;
                    const detail = (0, core_1.truncate)(input?.command ??
                        input?.filePath ??
                        input?.pattern ??
                        input?.description ??
                        JSON.stringify(input ?? {}), 240);
                    const output = (0, metrics_1.stepOutput)(state);
                    const filePath = (0, metrics_1.toolFilePath)(input);
                    const status = durationMs !== undefined ? "done" : "running";
                    const key = String(part.id ?? `${tool}:${JSON.stringify(input ?? {})}`);
                    const prev = tools.get(key);
                    const step = prev ?? { tool, detail, durationMs, output, status, filePath };
                    if (detail && step.detail !== detail) {
                        step.detail = detail;
                    }
                    step.durationMs = durationMs ?? step.durationMs;
                    step.output = output || step.output;
                    step.status = status;
                    step.filePath = step.filePath ?? filePath;
                    if (!prev) {
                        tools.set(key, step);
                        metrics.steps.push(step);
                    }
                    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${(0, followups_1.mark)("tool")} ${tool}` +
                        (durationMs !== undefined ? ` (${durationMs} ms)` : "") +
                        `\n           in: ${detail}` +
                        (output ? `\n           out: ${(0, core_1.truncate)(output, 240)}` : ""));
                    options.onStep?.(step);
                    break;
                }
                case "reasoning": {
                    const text = part?.text ?? "";
                    if (text) {
                        metrics.reasoning += (metrics.reasoning ? "\n" : "") + text;
                        options.onReasoning?.(text);
                        (0, core_1.debugLine)(`${(0, followups_1.mark)("thought")} ${(0, core_1.truncate)(text, 200)}`);
                    }
                    break;
                }
                case "text": {
                    const text = part?.text ?? "";
                    if (text) {
                        metrics.hadOutput = true;
                        options.onText?.(text);
                        (0, core_1.debugLine)(`${(0, followups_1.mark)("text")} ${(0, core_1.truncate)(text, 200)}`);
                    }
                    break;
                }
                case "step_finish": {
                    const tokens = part?.tokens;
                    const reason = part?.reason ?? "";
                    if (tokens) {
                        metrics.tokens.input += tokens.input ?? 0;
                        metrics.tokens.output += tokens.output ?? 0;
                        metrics.tokens.reasoning += tokens.reasoning ?? 0;
                        metrics.tokens.total += tokens.total ?? 0;
                        metrics.tokens.cache.read += tokens.cache?.read ?? 0;
                        metrics.tokens.cache.write += tokens.cache?.write ?? 0;
                    }
                    metrics.cost += part?.cost ?? 0;
                    const anyTokens = (tokens?.input ?? 0) + (tokens?.output ?? 0) + (tokens?.total ?? 0) > 0;
                    if (anyTokens || (part?.cost ?? 0) > 0) {
                        metrics.usageKnown = true;
                    }
                    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${(0, followups_1.mark)("step")} step finish (${reason}) ` +
                        `in=${tokens?.input ?? 0} out=${tokens?.output ?? 0} ` +
                        `cache_read=${tokens?.cache?.read ?? 0}`);
                    break;
                }
                case "error":
                case "session.error":
                case "session_error": {
                    const err = (part ?? rawEvent.error ?? props.error ?? props);
                    const text = typeof err === "string"
                        ? err
                        : err?.message ?? err?.data?.message ?? err?.name ?? JSON.stringify(err ?? {});
                    metrics.error = text;
                    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${(0, followups_1.mark)("fail")} ${type}: ${metrics.error}`);
                    break;
                }
                default:
                    if (type) {
                        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] · ${type}`);
                        if (!metrics.error && /error|fail|abort|denied|invalid/i.test(type)) {
                            const msg = (part?.message ?? part?.error);
                            metrics.error = msg ? `${type}: ${msg}` : type;
                        }
                    }
            }
        };
        const handleLine = (raw) => {
            const line = raw.trim();
            if (!line) {
                return;
            }
            if (options.json && (line.startsWith("{") || line.startsWith("["))) {
                let event;
                try {
                    event = JSON.parse(line);
                }
                catch {
                }
                if (event) {
                    if (settled) {
                        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] late ${String(event.type ?? "event")} after the run stopped — not rendered`);
                        return;
                    }
                    try {
                        handleEvent(event);
                    }
                    catch (error) {
                        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] event handler failed: ${error}`);
                    }
                    return;
                }
            }
            if (options.json) {
                core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${line}`);
                return;
            }
            metrics.hadOutput = true;
            options.onText?.(`${raw}\n`);
        };
        const finish = (timedOut) => {
            if (settled) {
                return;
            }
            if (buffer.trim()) {
                handleLine(buffer);
                buffer = "";
            }
            settled = true;
            clearInterval(timer);
            cancellation?.dispose();
            sse?.close();
            metrics.totalMs = Date.now() - started;
            metrics.timedOut = timedOut;
            if (timedOut && !metrics.stuckTool && runningTools.size > 0) {
                metrics.stuckTool = [...runningTools.values()][0].tool;
            }
            resolve(metrics);
        };
        const idleMs = options.idleTimeoutMs ?? 0;
        metrics.appliedTimeoutMs = options.timeoutMs;
        let lastEventAt = started;
        markActive = () => {
            lastEventAt = Date.now();
        };
        const timer = setInterval(() => {
            const now = Date.now();
            if (options.timeoutMs > 0 && now - started >= options.timeoutMs) {
                (0, proc_1.killTree)(child);
                finish(true);
                return;
            }
            const quietCap = runningTools.size > 0 && toolQuietMs > idleMs ? toolQuietMs : idleMs;
            if (idleMs > 0 && now - lastEventAt >= quietCap) {
                metrics.idleTimeout = true;
                const stuck = [...runningTools.values()][0];
                if (stuck) {
                    metrics.stuckTool = stuck.tool;
                }
                core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${(0, followups_1.mark)("quiet")} no output for ${Math.round((now - lastEventAt) / 1000)}s` +
                    (stuck ? ` (${stuck.tool} running ${(0, core_1.secs)(now - stuck.since)})` : "") +
                    " — stopping");
                (0, proc_1.killTree)(child);
                finish(true);
            }
        }, 1000);
        timer.unref?.();
        const cancellation = options.token?.onCancellationRequested(() => {
            (0, proc_1.killTree)(child);
            finish(false);
        });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            if (metrics.firstByteMs === undefined) {
                metrics.firstByteMs = Date.now() - started;
            }
            markActive();
            buffer += chunk;
            let start = 0;
            let index = buffer.indexOf("\n", start);
            while (index >= 0) {
                handleLine(buffer.slice(start, index));
                start = index + 1;
                index = buffer.indexOf("\n", start);
            }
            buffer = buffer.slice(start);
        });
        child.stderr.on("data", (chunk) => {
            const kept = metrics.stderr ?? "";
            if (kept.length < STDERR_CAP) {
                metrics.stderr = (kept + chunk).slice(0, STDERR_CAP);
                if (metrics.stderr.length >= STDERR_CAP) {
                    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] stderr capped at ${STDERR_CAP} bytes for the run summary — ` +
                        "later output still reaches the stderr lines below, 200 chars per chunk");
                }
            }
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] stderr: ${(0, core_1.truncate)(chunk, 200)}`);
        });
        child.on("error", (err) => {
            if (settled) {
                return;
            }
            settled = true;
            clearInterval(timer);
            cancellation?.dispose();
            sse?.close();
            reject(err);
        });
        child.on("close", (code, signal) => {
            metrics.exitCode = code ?? undefined;
            metrics.signal = signal ?? undefined;
            if (code !== 0 && code !== null) {
                core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] exit code ${code}${signal ? ` (${signal})` : ""}`);
            }
            finish(false);
        });
    });
}
function isMissingSessionError(error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /^HTTP 404\b/.test(message) || /session not found/i.test(message);
}
async function sessionBusy(base, sessionId, cwd) {
    try {
        const all = await (0, net_1.httpGetJson)((0, net_1.withDirectory)(`${base}/session/status`, cwd), 3000);
        const st = all?.[sessionId]?.type;
        return Boolean(st && st !== "idle");
    }
    catch {
        return undefined;
    }
}
async function abortServerRun(base, sessionId, cwd, why) {
    try {
        await (0, net_1.httpRequestJson)("POST", (0, net_1.withDirectory)(`${base}${(0, exports.sessionPath)(sessionId, "abort")}`, cwd), undefined, 5000);
    }
    catch (error) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] abort ${sessionId} failed (${why}): ${error}`);
        return false;
    }
    for (let i = 0; i < 15; i++) {
        if ((await sessionBusy(base, sessionId, cwd)) === false) {
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] aborted server run ${sessionId} (${why})`);
            return true;
        }
        await (0, core_1.delay)(200);
    }
    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] abort ${sessionId} sent but the session still reports busy (${why})`);
    return false;
}
exports.HEADLESS_PERMISSION = [
    { permission: "question", action: "deny", pattern: "*" },
    { permission: "plan_enter", action: "deny", pattern: "*" },
    { permission: "plan_exit", action: "deny", pattern: "*" }
];
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
        url = `/permission/${safeSessionId(id)}/reply`;
        body = opts.autoApprove ? { reply: "once" } : { reply: "reject", message: (0, followups_1.prompt)("READ_ONLY") };
        const patterns = Array.isArray(props.patterns) ? props.patterns.join(", ") : "";
        said = `permission ${String(props.permission ?? "?")} (${(0, core_1.truncate)(patterns, 120)}) → ${opts.autoApprove ? "approved once" : "rejected: read-only turn"}`;
    }
    else if (type === "question.asked") {
        const questions = Array.isArray(props.questions) ? props.questions : [];
        url = `/question/${safeSessionId(id)}/reply`;
        body = { answers: (questions.length ? questions : [undefined]).map(() => [(0, followups_1.prompt)("NO_QUESTIONS")]) };
        said = `question → answered "ask in your reply" (${questions.length} asked)`;
    }
    else {
        return;
    }
    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${(0, followups_1.mark)("warn")} ${said}`);
    void (0, net_1.httpRequestJson)("POST", (0, net_1.withDirectory)(`${base}${url}`, cwd), body, 5000).catch((error) => core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] could not answer ${type} ${id}: ${error}`));
}
function answerFamilyAsks(base, cwd, root, opts) {
    const family = new Set([root]);
    return (0, net_1.connectSse)(base, (ev) => {
        const props = ev.properties ?? {};
        if (ev.type === "session.created") {
            const info = props.info;
            if (typeof info?.id === "string" && typeof info.parentID === "string" && family.has(info.parentID)) {
                family.add(info.id);
            }
            return;
        }
        if (typeof props.sessionID === "string" && family.has(props.sessionID)) {
            answerAsk(base, cwd, props.sessionID, ev, opts);
        }
    }, () => undefined);
}
function noteModel(ev, metrics) {
    if (ev.type !== "message.updated") {
        return;
    }
    const info = (ev.properties?.info ?? {});
    if (info.role === "assistant" && typeof info.providerID === "string" && typeof info.modelID === "string") {
        metrics.model = `${info.providerID}/${info.modelID}`;
    }
}
async function createServerSession(base, cwd, title) {
    const created = await (0, net_1.httpRequestJson)("POST", (0, net_1.withDirectory)(`${base}/session`, cwd), {
        title: (0, core_1.truncate)(title, 60),
        permission: exports.HEADLESS_PERMISSION
    }, 5000);
    return created.id;
}
function isAttachFailure(metrics) {
    if (metrics.exitCode === 0 || metrics.exitCode === undefined || metrics.hadOutput || metrics.steps.length) {
        return false;
    }
    return /ECONNREFUSED|ECONNRESET|fetch failed|unable to connect|socket hang up/i.test(`${metrics.stderr ?? ""}${metrics.error ?? ""}`);
}
function isMissingSessionRun(metrics) {
    if (metrics.exitCode === 0 || metrics.exitCode === undefined) {
        return false;
    }
    return /session not found/i.test(`${metrics.stderr ?? ""}${metrics.error ?? ""}`);
}
async function restartAfterMissingSession(runOpts, serverTransport, beat, response, cwd) {
    const dead = runOpts.sessionId;
    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] session ${dead} no longer exists — starting a fresh one and retrying this turn`);
    beat.phase("Previous session is gone — starting a fresh one");
    response.markdown(`> ${(0, followups_1.mark)("restart")} The previous OpenCode session (\`${dead}\`) no longer exists, so this turn starts a new one. Earlier conversation history is not available.\n\n`);
    await (0, session_1.setActiveSession)(cwd, { turns: 0 });
    runOpts.sessionId = undefined;
    return (serverTransport ? runOpenCodeServer : runOpenCode)(runOpts);
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
        const detail = (0, core_1.truncate)(input?.command ??
            input?.filePath ??
            input?.pattern ??
            input?.description ??
            JSON.stringify(input ?? {}));
        markFirstByte(metrics, started);
        const output = (0, metrics_1.stepOutput)(state);
        const filePath = (0, metrics_1.toolFilePath)(input);
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
async function runOpenCodeServer(options) {
    const started = Date.now();
    const idleMs = options.idleTimeoutMs ?? 0;
    let lastEventAt = Date.now();
    const markServerActive = () => {
        lastEventAt = Date.now();
    };
    const metrics = {
        firstByteMs: undefined,
        totalMs: 0,
        timedOut: false,
        steps: [],
        tokens: (0, metrics_1.emptyTokens)(),
        cost: 0,
        hadOutput: false,
        sessionId: options.sessionId,
        reasoning: ""
    };
    metrics.appliedTimeoutMs = options.timeoutMs;
    const emitted = new Map();
    const tools = new Map();
    const cursor = { n: 0, last: {} };
    let aborting = false;
    const base = options.serverUrl ?? (await (0, net_1.ensureServer)(options.cwd));
    const scoped = (path) => (0, net_1.withDirectory)(`${base}${path}`, options.cwd);
    let sessionId = options.sessionId;
    if (!sessionId) {
        const created = await (0, net_1.httpRequestJson)("POST", scoped("/session"), {
            title: (0, core_1.truncate)(options.task, 60),
            permission: exports.HEADLESS_PERMISSION
        });
        sessionId = created.id;
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
    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] → server ${base}${(0, exports.sessionPath)(sessionId, "message")} ` +
        `(agent=${options.agent ?? "-"} model=${options.model ?? "-"})`);
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
        noteModel(ev, metrics);
        if (type === "session.error" && !aborting) {
            const err = (props.error ?? props.message ?? ev.error);
            const text = typeof err === "string" ? err : err?.message ?? err?.name ?? "unknown session error";
            metrics.error = text;
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${(0, followups_1.mark)("fail")} session.error: ${metrics.error}`);
        }
        if (part && (type === "message.part.updated" || type === undefined || type.startsWith("message"))) {
            applyServerPart(part, metrics, options, started, emitted, tools, cursor);
        }
        if (type === "text" || type === "reasoning" || type === "tool_use" || type === "tool") {
            applyServerPart(part ?? { type, text: ev.text, tool: ev.tool, state: ev.state }, metrics, options, started, emitted, tools, cursor);
        }
    }, (status) => {
        if (status === "connected") {
            attached();
        }
    }, sessionId);
    const asks = answerFamilyAsks(base, options.cwd, mine, { permissions: true, autoApprove: options.autoApprove && !options.readOnly });
    const closeStreams = () => {
        sse.close();
        asks.close();
    };
    await Promise.race([subscribed, (0, core_1.delay)(80)]);
    let resp;
    let idleTimer;
    let idleFired = false;
    try {
        const pending = (0, net_1.httpRequestJson)("POST", scoped((0, exports.sessionPath)(sessionId, "message")), body, options.timeoutMs, options.token);
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
            const abort = (0, net_1.httpRequestJson)("POST", scoped((0, exports.sessionPath)(sessionId, "abort")), undefined, 5000).catch(() => undefined);
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
            metrics.usageKnown = true;
            metrics.tokens.input += tk.input ?? 0;
            metrics.tokens.output += tk.output ?? 0;
            metrics.tokens.reasoning += tk.reasoning ?? 0;
            metrics.tokens.total += tk.total ?? 0;
            metrics.tokens.cache.read += tk.cache?.read ?? 0;
            metrics.tokens.cache.write += tk.cache?.write ?? 0;
        }
        if (resp.info?.cost !== undefined) {
            metrics.usageKnown = true;
            metrics.cost += resp.info.cost ?? 0;
        }
        (resp.parts ?? []).forEach((part, i) => {
            applyServerPart(part, metrics, options, started, emitted, tools, cursor, i + 1);
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
async function sessionModel(base, cwd, sessionId) {
    try {
        const messages = await (0, net_1.httpGetJson)((0, net_1.withDirectory)(`${base}${(0, exports.sessionPath)(sessionId, "message")}?limit=6`, cwd), 5000);
        for (const message of [...(Array.isArray(messages) ? messages : [])].reverse()) {
            const info = message?.info ?? {};
            if (info.role === "assistant" && typeof info.providerID === "string" && typeof info.modelID === "string") {
                return `${info.providerID}/${info.modelID}`;
            }
            const sent = info.model;
            const id = sent?.modelID ?? sent?.id;
            if (info.role === "user" && sent?.providerID && id) {
                return `${sent.providerID}/${id}`;
            }
        }
    }
    catch (error) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] could not read the model of ${sessionId}: ${error}`);
    }
    return undefined;
}
const COMPACT_TIMEOUT_MS = 180000;
async function compactSession(sessionId, cwd, model) {
    try {
        const base = await (0, net_1.ensureServer)(cwd);
        const spec = model ??
            (await sessionModel(base, cwd, sessionId)) ??
            ((0, core_1.config)().get("model", "").trim() || undefined);
        const index = spec?.indexOf("/") ?? -1;
        if (!spec || index <= 0) {
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] compact skipped: the model of ${sessionId} is not known yet`);
            return false;
        }
        const parts = { providerID: spec.slice(0, index), modelID: spec.slice(index + 1) };
        const status = await (0, net_1.httpPostJson)((0, net_1.withDirectory)(`${base}${(0, exports.sessionPath)(sessionId, "summarize")}`, cwd), { providerID: parts.providerID, modelID: parts.modelID, auto: true }, COMPACT_TIMEOUT_MS);
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] summarize ${sessionId} with ${parts.providerID}/${parts.modelID} → HTTP ${status}`);
        return status >= 200 && status < 300;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] compact failed: ${message}`);
        return false;
    }
}
const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
function safeSessionId(sessionId) {
    if (SAFE_ID.test(sessionId)) {
        return sessionId;
    }
    const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[.-]+/, "_").slice(0, 128);
    const safe = cleaned || "session";
    core_1.logChannel?.appendLine(`[${(0, core_1.stamp)()}] unsafe session id ${JSON.stringify(sessionId)} → ${safe}`);
    return safe;
}
const sessionPath = (sessionId, tail) => `/session/${safeSessionId(sessionId)}/${tail}`;
exports.sessionPath = sessionPath;
const sessionRoot = (sessionId) => `/session/${safeSessionId(sessionId)}`;
exports.sessionRoot = sessionRoot;
//# sourceMappingURL=runs.js.map