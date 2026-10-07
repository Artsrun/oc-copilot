"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runOpenCode = runOpenCode;
const core_1 = require("./core");
const followups_1 = require("./followups");
const proc_1 = require("./proc");
const net_1 = require("./net");
const metrics_1 = require("./metrics");
const asks_1 = require("./asks");
const run_steps_1 = require("./run-steps");
const server_session_1 = require("./server-session");
const STDERR_CAP = 256 * 1024;
async function runOpenCode(options) {
    if (options.attachUrl && options.sessionId && !options.token?.isCancellationRequested) {
        await (0, server_session_1.applyTurnPermission)(options.attachUrl, options.cwd, options.sessionId, Boolean(options.readOnly));
    }
    return runCli(options);
}
function runCli(options) {
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
        if (options.variant) {
            args.push("--variant", options.variant);
        }
        if (options.sessionId) {
            args.push("--session", (0, server_session_1.safeSessionId)(options.sessionId));
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
            resolve((0, run_steps_1.blankMetrics)(options.sessionId));
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
        const metrics = (0, run_steps_1.blankMetrics)(options.sessionId);
        let buffer = "";
        let settled = false;
        const started = Date.now();
        const runningTools = new Map();
        const toolQuietMs = Math.max(0, options.toolQuietMs ?? 0);
        const partKinds = new Map();
        const streamed = new Map();
        const closedParts = new Set();
        let lastRetry = -1;
        let sse;
        let family;
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
                (0, run_steps_1.notePartKind)(part, partKinds);
                const delta = (0, run_steps_1.partDeltaOf)(ev, mine, partKinds);
                if (delta) {
                    metrics.serverActivity = true;
                    (0, run_steps_1.applyPartDelta)(delta, metrics, options, started, streamed, closedParts);
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
                    const detail = (0, core_1.truncate)((0, run_steps_1.stepDetail)(input, String(state?.title ?? "")), 240);
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
            family = (0, asks_1.watchFamily)(attachUrl, options.cwd, mine, { permissions: false, autoApprove: options.autoApprove }, { onActivity: () => markActive(), onSubagent: options.onSubagent });
        }
        const tools = new Map();
        const wholePart = (kind, part, text) => {
            const id = typeof part?.id === "string" ? part.id : "";
            if (!id) {
                return 0;
            }
            const key = `${kind}:${id}`;
            closedParts.add(key);
            const sent = streamed.get(key) ?? 0;
            return sent <= text.length ? sent : text.length;
        };
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
                    const detail = (0, core_1.truncate)((0, run_steps_1.stepDetail)(input), 240);
                    const output = (0, metrics_1.stepOutput)(state);
                    const filePath = (0, metrics_1.toolFilePath)(input);
                    const status = durationMs !== undefined ? "done" : "running";
                    const key = String(part.id ?? `${tool}:${JSON.stringify(input ?? {})}`);
                    (0, run_steps_1.noteTask)(part, metrics);
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
                    const rest = text.slice(wholePart("r", part, text));
                    if (rest) {
                        metrics.reasoning += (metrics.reasoning && rest === text ? "\n" : "") + rest;
                        options.onReasoning?.(rest);
                    }
                    if (text) {
                        (0, core_1.debugLine)(`${(0, followups_1.mark)("thought")} ${(0, core_1.truncate)(text, 200)}`);
                    }
                    break;
                }
                case "text": {
                    const text = part?.text ?? "";
                    const rest = text.slice(wholePart("t", part, text));
                    if (text) {
                        metrics.hadOutput = true;
                        (0, core_1.debugLine)(`${(0, followups_1.mark)("text")} ${(0, core_1.truncate)(text, 200)}`);
                    }
                    if (rest) {
                        (0, run_steps_1.markFirstByte)(metrics, started);
                        options.onText?.(rest, typeof part?.id === "string" && part.id ? part.id : undefined);
                    }
                    break;
                }
                case "step_finish": {
                    const tokens = part?.tokens;
                    const reason = part?.reason ?? "";
                    if (tokens) {
                        metrics.context = (0, metrics_1.contextOf)(tokens) || metrics.context;
                        metrics.tokens.input += tokens.input ?? 0;
                        metrics.tokens.output += tokens.output ?? 0;
                        metrics.tokens.reasoning += tokens.reasoning ?? 0;
                        metrics.tokens.total += tokens.total ?? 0;
                        metrics.tokens.cache.read += tokens.cache?.read ?? 0;
                        metrics.tokens.cache.write += tokens.cache?.write ?? 0;
                    }
                    metrics.cost += part?.cost ?? 0;
                    if (reason) {
                        metrics.finishReason = reason;
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
            if (family) {
                (0, run_steps_1.addSubagents)(metrics, family.children(), family.childCost());
                family.close();
            }
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
            family?.close();
            reject(err);
        });
        child.on("close", (code) => {
            metrics.exitCode = code ?? undefined;
            if (code !== 0 && code !== null) {
                core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] exit code ${code}`);
            }
            finish(false);
        });
    });
}
//# sourceMappingURL=run-cli.js.map