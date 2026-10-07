// The CLI transport: `opencode run --format json`, cold or attached to the
// warm server (`--attach`). Kill on silence, bounded stderr, the attached run's
// liveness and its subagents' asks from the server's stream.
import { ChildProcessWithoutNullStreams } from "node:child_process";
import { debugLine, logChannel, secs, stamp, truncate } from "./core";
import { mark } from "./followups";
import { killTree, spawnOpenCode } from "./proc";
import { connectSse, sessionIdFromEvent } from "./net";
import { RunMetrics, RunOptions, StepRecord, TokenUsage, contextOf, stepOutput, toolFilePath } from "./metrics";
import { FamilyWatch, watchFamily } from "./asks";
import { addSubagents, applyPartDelta, blankMetrics, markFirstByte, noteModel, notePartKind, noteTask, partDeltaOf, providerRetryOf, stepDetail } from "./run-steps";
import { applyTurnPermission, safeSessionId } from "./server-session";

// Enough for any real stack trace or OpenCode error dump; small enough that a
// process stuck printing cannot grow this string without limit.
const STDERR_CAP = 256 * 1024;

// An attached run gets this turn's permission rules first (read-only turns:
// read-only subagents only); a cold run has no server to set them on.
export async function runOpenCode(options: RunOptions): Promise<RunMetrics> {
    if (options.attachUrl && options.sessionId && !options.token?.isCancellationRequested) {
        await applyTurnPermission(options.attachUrl, options.cwd, options.sessionId, Boolean(options.readOnly));
    }
    return runCli(options);
}

function runCli(options: RunOptions): Promise<RunMetrics> {
    return new Promise((resolve, reject) => {
        const args = ["run"];
        // Attach to the warm server instead of booting OpenCode per turn; same
        // --auto/--agent/JSON behaviour (1.18.32). --dir is the CLI's ?directory=.
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
        // Continue an existing session so a model handoff keeps the prior context
        // (the timed-out run's plan) instead of starting from scratch.
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

        // Stop pressed before the run began: spawn nothing.
        if (options.token?.isCancellationRequested) {
            resolve(blankMetrics(options.sessionId));
            return;
        }
        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawnOpenCode(options.executable, args, options.cwd);
        } catch (error) {
            reject(error);
            return;
        }
        // No interactive stdin is available, so close it immediately. This makes
        // OpenCode fail fast instead of blocking on a permission prompt.
        child.stdin?.end();

        const metrics: RunMetrics = blankMetrics(options.sessionId);

        let buffer = "";
        let settled = false;
        const started = Date.now();

        // An attached CLI prints a tool only when it completes: liveness comes
        // from the session's SSE, rendering from stdout (1.18.32).
        const runningTools = new Map<string, { tool: string; since: number; detail: string }>();
        const toolQuietMs = Math.max(0, options.toolQuietMs ?? 0);
        // The attached CLI prints a text or reasoning part only when it ENDS
        // (1.18.32 run.ts: `part.time?.end`); the same server streams it as
        // deltas. Deltas go out as they come, counted per part, and stdout's
        // whole part then adds only the rest; a delta after that is late.
        const partKinds = new Map<string, string>();
        const streamed = new Map<string, number>();
        const closedParts = new Set<string>();
        let lastRetry = -1;
        let sse: { close: () => void } | undefined;
        let family: FamilyWatch | undefined;
        if (options.attachUrl && options.sessionId) {
            const mine = options.sessionId;
            const attachUrl = options.attachUrl;
            sse = connectSse(
                attachUrl,
                (ev) => {
                    const props = (ev.properties as Record<string, unknown> | undefined) ?? ev;
                    const part = (props.part ?? ev.part) as Record<string, unknown> | undefined;
                    // Only this session's events prove the task moves (not server.heartbeat).
                    if (sessionIdFromEvent(ev) !== mine || settled) {
                        return;
                    }
                    markActive();
                    notePartKind(part, partKinds);
                    const delta = partDeltaOf(ev, mine, partKinds);
                    if (delta) {
                        metrics.serverActivity = true;
                        applyPartDelta(delta, metrics, options, started, streamed, closedParts);
                        return;
                    }
                    const retry = providerRetryOf(ev, mine);
                    if (retry) {
                        if (retry.attempt !== lastRetry) {
                            lastRetry = retry.attempt;
                            logChannel.appendLine(`[${stamp()}] ${mark("quiet")} provider retry ${retry.attempt}: ${retry.message || "no reason given"}`);
                        }
                        options.onRetry?.(retry);
                        return;
                    }
                    noteModel(ev, metrics);
                    if (part && (part.type === "tool" || part.type === "reasoning" || part.type === "text")) {
                        metrics.serverActivity = true;
                    }
                    if (part?.type !== "tool") {
                        return;
                    }
                    const id = String(part.id ?? part.callID ?? "");
                    const state = part.state as Record<string, unknown> | undefined;
                    const status = state?.status as string | undefined;
                    const tool = String(part.tool ?? "tool");
                    if (status === "running" || status === "pending") {
                        const input = state?.input as Record<string, unknown> | undefined;
                        // Same precedence as the completed tool_use: one call, one label.
                        const detail = truncate(stepDetail(input, String(state?.title ?? "")), 240);
                        const known = runningTools.get(id);
                        // "pending" arrives before the input: name it once the input is known.
                        if (!known || (!known.detail && detail)) {
                            runningTools.set(id, { tool, since: known?.since ?? Date.now(), detail });
                            options.onStep?.({ tool, detail: detail ? `${detail} (running)` : "running", durationMs: undefined, status: "running" });
                        }
                    } else {
                        runningTools.delete(id);
                    }
                },
                () => undefined,
                mine
            );
            // The attached CLI answers permission asks (1.18.20: its subagents'
            // too), never questions: we do, for the session and its subagents.
            family = watchFamily(
                attachUrl,
                options.cwd,
                mine,
                { permissions: false, autoApprove: options.autoApprove },
                { onActivity: () => markActive(), onSubagent: options.onSubagent }
            );
        }
        // Keyed as the server runner keys it: both transports give identical steps,
        // and two genuine `read x` calls stay two.
        const tools = new Map<string, StepRecord>();

        // How much of a whole part the deltas already sent; its key takes no
        // more deltas after this.
        const wholePart = (kind: "t" | "r", part: Record<string, unknown> | undefined, text: string): number => {
            const id = typeof part?.id === "string" ? part.id : "";
            if (!id) {
                return 0;
            }
            const key = `${kind}:${id}`;
            closedParts.add(key);
            const sent = streamed.get(key) ?? 0;
            return sent <= text.length ? sent : text.length;
        };

        let markActive: () => void = () => undefined;
        const handleEvent = (rawEvent: Record<string, unknown>): void => {
            markActive();
            const props = (rawEvent.properties as Record<string, unknown> | undefined) ?? rawEvent;
            const part = (rawEvent.part ?? props.part) as Record<string, unknown> | undefined;
            let type = rawEvent.type as string | undefined;
            if (type === "message.part.updated" && part?.type) {
                type = part.type === "tool" ? "tool_use" : (part.type as string);
            }
            const sessionId =
                (rawEvent.sessionID as string | undefined) ??
                (props.sessionID as string | undefined);
            if (sessionId) {
                metrics.sessionId = sessionId;
            }
            switch (type) {
                case "step_start":
                    logChannel.appendLine(`[${stamp()}] ▶ step start`);
                    break;
                case "tool_use":
                case "tool": {
                    if (!part) {
                        break;
                    }
                    const tool = (part.tool as string) ?? "tool";
                    const state = part.state as Record<string, unknown> | undefined;
                    const input = state?.input as Record<string, unknown> | undefined;
                    const time = state?.time as { start?: number; end?: number } | undefined;
                    const durationMs =
                        time?.start !== undefined && time?.end !== undefined
                            ? time.end - time.start
                            : undefined;
                    const detail = truncate(stepDetail(input), 240);
                    const output = stepOutput(state);
                    const filePath = toolFilePath(input);
                    const status: StepRecord["status"] = durationMs !== undefined ? "done" : "running";
                    const key = String(part.id ?? `${tool}:${JSON.stringify(input ?? {})}`);
                    noteTask(part, metrics);
                    const prev = tools.get(key);
                    const step: StepRecord = prev ?? { tool, detail, durationMs, output, status, filePath };
                    // Parity with applyServerPart: a tool's first event often
                    // carries a partial input, so the later detail is the better one.
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
                    logChannel.appendLine(
                        `[${stamp()}] ${mark("tool")} ${tool}` +
                        (durationMs !== undefined ? ` (${durationMs} ms)` : "") +
                        `\n           in: ${detail}` +
                        (output ? `\n           out: ${truncate(output, 240)}` : "")
                    );
                    options.onStep?.(step);
                    break;
                }
                case "reasoning": {
                    const text = (part?.text as string) ?? "";
                    const rest = text.slice(wholePart("r", part, text));
                    if (rest) {
                        metrics.reasoning += (metrics.reasoning && rest === text ? "\n" : "") + rest;
                        options.onReasoning?.(rest);
                    }
                    if (text) {
                        debugLine(`${mark("thought")} ${truncate(text, 200)}`);
                    }
                    break;
                }
                case "text": {
                    const text = (part?.text as string) ?? "";
                    const rest = text.slice(wholePart("t", part, text));
                    if (text) {
                        metrics.hadOutput = true;
                        debugLine(`${mark("text")} ${truncate(text, 200)}`);
                    }
                    if (rest) {
                        markFirstByte(metrics, started);
                        options.onText?.(rest, typeof part?.id === "string" && part.id ? part.id : undefined);
                    }
                    break;
                }
                case "step_finish": {
                    const tokens = part?.tokens as TokenUsage | undefined;
                    const reason = (part?.reason as string) ?? "";
                    if (tokens) {
                        metrics.context = contextOf(tokens) || metrics.context;
                        metrics.tokens.input += tokens.input ?? 0;
                        metrics.tokens.output += tokens.output ?? 0;
                        metrics.tokens.reasoning += tokens.reasoning ?? 0;
                        metrics.tokens.total += tokens.total ?? 0;
                        metrics.tokens.cache.read += tokens.cache?.read ?? 0;
                        metrics.tokens.cache.write += tokens.cache?.write ?? 0;
                    }
                    metrics.cost += (part?.cost as number) ?? 0;
                    if (reason) {
                        metrics.finishReason = reason;
                    }
                    logChannel.appendLine(
                        `[${stamp()}] ${mark("step")} step finish (${reason}) ` +
                        `in=${tokens?.input ?? 0} out=${tokens?.output ?? 0} ` +
                        `cache_read=${tokens?.cache?.read ?? 0}`
                    );
                    break;
                }
                // The CLI stream carries errors too, under three different names.
                // Unhandled, a failed run renders as an empty chat reply.
                case "error":
                case "session.error":
                case "session_error": {
                    const err = (part ?? rawEvent.error ?? props.error ?? props) as
                        | { message?: string; name?: string; data?: { message?: string } }
                        | string
                        | undefined;
                    const text =
                        typeof err === "string"
                            ? err
                            : err?.message ?? err?.data?.message ?? err?.name ?? JSON.stringify(err ?? {});
                    metrics.error = text;
                    logChannel.appendLine(`[${stamp()}] ${mark("fail")} ${type}: ${metrics.error}`);
                    break;
                }
                default:
                    if (type) {
                        logChannel.appendLine(`[${stamp()}] · ${type}`);
                        // Anything with a message-shaped payload is worth keeping as
                        // a last-resort diagnostic rather than discarding outright.
                        if (!metrics.error && /error|fail|abort|denied|invalid/i.test(type)) {
                            const msg = (part?.message ?? part?.error) as string | undefined;
                            metrics.error = msg ? `${type}: ${msg}` : type;
                        }
                    }
            }
        };

        const handleLine = (raw: string): void => {
            const line = raw.trim();
            if (!line) {
                return;
            }
            if (options.json && (line.startsWith("{") || line.startsWith("["))) {
                let event: Record<string, unknown> | undefined;
                try {
                    event = JSON.parse(line) as Record<string, unknown>;
                } catch {
                    // not JSON after all — fall through and treat as raw text
                }
                if (event) {
                    // A throw inside the handler is not "not JSON": parse and handle apart.
                    if (settled) {
                        logChannel.appendLine(
                            `[${stamp()}] late ${String(event.type ?? "event")} after the run stopped — not rendered`
                        );
                        return;
                    }
                    try {
                        handleEvent(event);
                    } catch (error) {
                        logChannel.appendLine(`[${stamp()}] event handler failed: ${error}`);
                    }
                    return;
                }
            }
            if (options.json) {
                logChannel.appendLine(`[${stamp()}] ${line}`);
                return;
            }
            // Plain mode: forward text straight through.
            metrics.hadOutput = true;
            options.onText?.(`${raw}\n`);
        };

        const finish = (timedOut: boolean): void => {
            if (settled) {
                return;
            }
            // Flush BEFORE marking settled: the tail of stdout is still this
            // run's output, not a late event.
            if (buffer.trim()) {
                handleLine(buffer);
                buffer = "";
            }
            settled = true;
            clearInterval(timer);
            cancellation?.dispose();
            sse?.close();
            if (family) {
                addSubagents(metrics, family.children(), family.childCost());
                family.close();
            }
            metrics.totalMs = Date.now() - started;
            metrics.timedOut = timedOut;
            // Any stop (idle, tool-quiet, wall clock) while the server still
            // reported a tool running names it: that decides handoff vs not.
            if (timedOut && !metrics.stuckTool && runningTools.size > 0) {
                metrics.stuckTool = [...runningTools.values()][0].tool;
            }
            resolve(metrics);
        };

        // A single wall-clock cap forces one number to mean two things: "how long
        // may a working run take" and "how long may a hung run hang". So: kill on
        // silence, subject to an optional hard ceiling.
        const idleMs = options.idleTimeoutMs ?? 0;
        metrics.appliedTimeoutMs = options.timeoutMs;
        let lastEventAt = started;
        markActive = () => {
            lastEventAt = Date.now();
        };
        const timer = setInterval(() => {
            const now = Date.now();
            // 0 = no wall clock: a run is killed for going silent, not for being long.
            if (options.timeoutMs > 0 && now - started >= options.timeoutMs) {
                killTree(child);
                finish(true);
                return;
            }
            // A tool the server reports as running earns toolQuietMs of silence;
            // a stall with nothing running still ends at idleMs.
            const quietCap = runningTools.size > 0 && toolQuietMs > idleMs ? toolQuietMs : idleMs;
            if (idleMs > 0 && now - lastEventAt >= quietCap) {
                metrics.idleTimeout = true;
                const stuck = [...runningTools.values()][0];
                if (stuck) {
                    metrics.stuckTool = stuck.tool;
                }
                logChannel.appendLine(
                    `[${stamp()}] ${mark("quiet")} no output for ${Math.round((now - lastEventAt) / 1000)}s` +
                    (stuck ? ` (${stuck.tool} running ${secs(now - stuck.since)})` : "") +
                    " — stopping"
                );
                killTree(child);
                finish(true);
            }
        }, 1000);
        timer.unref?.();

        const cancellation = options.token?.onCancellationRequested(() => {
            killTree(child);
            finish(false);
        });

        // utf8 decoding belongs on the stream, not on each chunk: OpenCode emits
        // box-drawing and emoji, and a character split across two chunks decodes
        // to U+FFFD when every Buffer is stringified in isolation.
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            if (metrics.firstByteMs === undefined) {
                metrics.firstByteMs = Date.now() - started;
            }
            markActive();
            buffer += chunk;
            // Same offset walk as the SSE framing in net.ts: reslicing the buffer
            // per line made a chunk carrying N JSONL lines O(N^2) to split.
            let start = 0;
            let index = buffer.indexOf("\n", start);
            while (index >= 0) {
                handleLine(buffer.slice(start, index));
                start = index + 1;
                index = buffer.indexOf("\n", start);
            }
            buffer = buffer.slice(start);
        });
        child.stderr.on("data", (chunk: string) => {
            // Keep the HEAD, not a tail: when a run produces no assistant text
            // this is usually the only evidence of why, and the cause is named
            // first. Bounded, so a tool stuck in a retry loop cannot grow one
            // string without limit; the full stream is in the output channel.
            const kept = metrics.stderr ?? "";
            if (kept.length < STDERR_CAP) {
                metrics.stderr = (kept + chunk).slice(0, STDERR_CAP);
                if (metrics.stderr.length >= STDERR_CAP) {
                    // Say it once, at the moment the cap is reached. Silent
                    // truncation is the thing that wastes an hour later.
                    logChannel.appendLine(
                        `[${stamp()}] stderr capped at ${STDERR_CAP} bytes for the run summary — ` +
                        "later output still reaches the stderr lines below, 200 chars per chunk"
                    );
                }
            }
            logChannel.appendLine(`[${stamp()}] stderr: ${truncate(chunk, 200)}`);
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
                logChannel.appendLine(`[${stamp()}] exit code ${code}`);
            }
            finish(false);
        });
    });
}
