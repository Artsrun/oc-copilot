import * as vscode from "vscode";
import { ChildProcessWithoutNullStreams } from "node:child_process";
import { config, debugLine, delay, logChannel, secs, stamp, truncate } from "./core";
import { mark, prompt as promptText } from "./followups";
import { killTree, spawnOpenCode } from "./proc";
import { connectSse, ensureServer, httpGetJson, httpPostJson, httpRequestJson, sessionIdFromEvent, withDirectory } from "./net";
import { RunMetrics, RunOptions, StepRecord, TokenUsage, emptyTokens, stepOutput, toolFilePath } from "./metrics";
import { setActiveSession } from "./session";

// Enough for any real stack trace or OpenCode error dump; small enough that a
// process stuck printing cannot grow this string without limit.
const STDERR_CAP = 256 * 1024;

export function runOpenCode(options: RunOptions): Promise<RunMetrics> {
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
            resolve({
                firstByteMs: undefined,
                totalMs: 0,
                timedOut: false,
                steps: [],
                tokens: emptyTokens(),
                cost: 0,
                hadOutput: false,
                sessionId: options.sessionId,
                reasoning: ""
            });
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

        const metrics: RunMetrics = {
            firstByteMs: undefined,
            totalMs: 0,
            timedOut: false,
            steps: [],
            tokens: emptyTokens(),
            cost: 0,
            hadOutput: false,
            sessionId: options.sessionId,
            reasoning: ""
        };

        let buffer = "";
        let settled = false;
        const started = Date.now();

        // An attached CLI prints a tool only when it completes: liveness comes
        // from the session's SSE, rendering from stdout (1.18.32).
        const runningTools = new Map<string, { tool: string; since: number; detail: string }>();
        const toolQuietMs = Math.max(0, options.toolQuietMs ?? 0);
        let sse: { close: () => void } | undefined;
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
                    // The attached CLI answers permission asks, never questions: we do.
                    answerAsk(attachUrl, options.cwd, mine, ev, { permissions: false, autoApprove: options.autoApprove });
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
                        const detail = truncate(
                            String(input?.command ?? input?.filePath ?? input?.pattern ?? input?.description ?? state?.title ?? ""),
                            240
                        );
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
        }
        // Keyed as the server runner keys it: both transports give identical steps,
        // and two genuine `read x` calls stay two.
        const tools = new Map<string, StepRecord>();

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
                    const detail = truncate(
                        (input?.command as string) ??
                        (input?.filePath as string) ??
                        (input?.pattern as string) ??
                        (input?.description as string) ??
                        JSON.stringify(input ?? {}),
                        240
                    );
                    const output = stepOutput(state);
                    const filePath = toolFilePath(input);
                    const status: StepRecord["status"] = durationMs !== undefined ? "done" : "running";
                    const key = String(part.id ?? `${tool}:${JSON.stringify(input ?? {})}`);
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
                    if (text) {
                        metrics.reasoning += (metrics.reasoning ? "\n" : "") + text;
                        options.onReasoning?.(text);
                        debugLine(`${mark("thought")} ${truncate(text, 200)}`);
                    }
                    break;
                }
                case "text": {
                    const text = (part?.text as string) ?? "";
                    if (text) {
                        metrics.hadOutput = true;
                        options.onText?.(text);
                        debugLine(`${mark("text")} ${truncate(text, 200)}`);
                    }
                    break;
                }
                case "step_finish": {
                    const tokens = part?.tokens as TokenUsage | undefined;
                    const reason = (part?.reason as string) ?? "";
                    if (tokens) {
                        metrics.tokens.input += tokens.input ?? 0;
                        metrics.tokens.output += tokens.output ?? 0;
                        metrics.tokens.reasoning += tokens.reasoning ?? 0;
                        metrics.tokens.total += tokens.total ?? 0;
                        metrics.tokens.cache.read += tokens.cache?.read ?? 0;
                        metrics.tokens.cache.write += tokens.cache?.write ?? 0;
                    }
                    metrics.cost += (part?.cost as number) ?? 0;
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

// ---------------------------------------------------------------------------
// stale session recovery
// ---------------------------------------------------------------------------
//
// A session id outlives OpenCode's own storage — deleted from the TUI, cleared
// on reinstall, carried to another machine by settings sync. A stale id is fatal
// on BOTH transports and repeats every turn until something clears it.
//
// Measured against opencode 1.18.27:
//   server  POST /session/<stale>/message  → HTTP 404
//   cli     opencode run --session <stale> → exit 1, stderr "Error: Session not found"
export function isMissingSessionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /^HTTP 404\b/.test(message) || /session not found/i.test(message);
}

// ---------------------------------------------------------------------------
// server-side run control
// ---------------------------------------------------------------------------
//
// Measured on 1.18.32: killing a `run --attach` client does not stop the run,
// and a later prompt to that session is queued behind it. So every stop aborts
// on the server, and every send checks the session is not busy.

export async function sessionBusy(base: string, sessionId: string, cwd: string): Promise<boolean | undefined> {
    try {
        const all = await httpGetJson<Record<string, { type?: string }>>(withDirectory(`${base}/session/status`, cwd), 3000);
        const st = all?.[sessionId]?.type;
        return Boolean(st && st !== "idle");
    } catch {
        return undefined;
    }
}

export async function abortServerRun(base: string, sessionId: string, cwd: string, why: string): Promise<boolean> {
    try {
        await httpRequestJson("POST", withDirectory(`${base}${sessionPath(sessionId, "abort")}`, cwd), undefined, 5000);
    } catch (error) {
        logChannel.appendLine(`[${stamp()}] abort ${sessionId} failed (${why}): ${error}`);
        return false;
    }
    for (let i = 0; i < 15; i++) {
        if ((await sessionBusy(base, sessionId, cwd)) === false) {
            logChannel.appendLine(`[${stamp()}] aborted server run ${sessionId} (${why})`);
            return true;
        }
        await delay(200);
    }
    logChannel.appendLine(`[${stamp()}] abort ${sessionId} sent but the session still reports busy (${why})`);
    return false;
}

// ---------------------------------------------------------------------------
// headless asks
// ---------------------------------------------------------------------------
//
// Nobody can answer OpenCode's prompts from a chat turn. Measured on 1.18.32
// against a real server and model (REFS "Read-only turns"):
//   - `opencode run` creates its sessions with question, plan_enter and
//     plan_exit DENIED. POST /session — how the bridge made them — does not,
//     and the built-in plan agent allows `question`: a plan turn that asked
//     one waited until aborted (45s probe). With the rules, the tool is not
//     even offered and the model asks in its reply.
//   - an `ask` rule (plan's: external_directory, *.env reads, doom_loop) makes
//     the server wait for a reply: a plan turn reading /etc/hostname hung until
//     aborted. A reject WITH a message is fed back and the model carries on
//     (PermissionCorrectedError, 30s); a bare reject ends the turn, unanswered.
//   - the attached CLI answers permission asks itself (`--auto`: once; without:
//     reject) but not questions.
export const HEADLESS_PERMISSION = [
    { permission: "question", action: "deny", pattern: "*" },
    { permission: "plan_enter", action: "deny", pattern: "*" },
    { permission: "plan_exit", action: "deny", pattern: "*" }
];

// Answers a permission or question ask for THIS session — never one the demux
// passed along unattributed. Bounded and fire-and-forget: the run is what waits.
function answerAsk(
    base: string,
    cwd: string,
    sessionId: string,
    ev: Record<string, unknown>,
    opts: { permissions: boolean; autoApprove: boolean }
): void {
    const type = ev.type as string | undefined;
    const props = (ev.properties as Record<string, unknown> | undefined) ?? {};
    const id = typeof props.id === "string" ? props.id : "";
    if (!id || props.sessionID !== sessionId) {
        return;
    }
    let url: string;
    let body: Record<string, unknown>;
    let said: string;
    if (type === "permission.asked" && opts.permissions) {
        url = `/permission/${safeSessionId(id)}/reply`;
        body = opts.autoApprove ? { reply: "once" } : { reply: "reject", message: promptText("READ_ONLY") };
        const patterns = Array.isArray(props.patterns) ? props.patterns.join(", ") : "";
        said = `permission ${String(props.permission ?? "?")} (${truncate(patterns, 120)}) → ${opts.autoApprove ? "approved once" : "rejected: read-only turn"}`;
    } else if (type === "question.asked") {
        const questions = Array.isArray(props.questions) ? props.questions : [];
        url = `/question/${safeSessionId(id)}/reply`;
        body = { answers: (questions.length ? questions : [undefined]).map(() => [promptText("NO_QUESTIONS")]) };
        said = `question → answered "ask in your reply" (${questions.length} asked)`;
    } else {
        return;
    }
    logChannel.appendLine(`[${stamp()}] ${mark("warn")} ${said}`);
    void httpRequestJson("POST", withDirectory(`${base}${url}`, cwd), body, 5000).catch((error) =>
        logChannel.appendLine(`[${stamp()}] could not answer ${type} ${id}: ${error}`)
    );
}

// A session's asks AND those of the subagent sessions it spawns (the task
// tool): a child's ask carries the child's id, which the per-session demux never
// hands to the run. `opencode run` tracks the same family, from session.created
// events whose parentID is already in it.
function answerFamilyAsks(
    base: string,
    cwd: string,
    root: string,
    opts: { permissions: boolean; autoApprove: boolean }
): { close: () => void } {
    const family = new Set([root]);
    return connectSse(
        base,
        (ev) => {
            const props = (ev.properties as Record<string, unknown> | undefined) ?? {};
            if (ev.type === "session.created") {
                const info = props.info as { id?: unknown; parentID?: unknown } | undefined;
                if (typeof info?.id === "string" && typeof info.parentID === "string" && family.has(info.parentID)) {
                    family.add(info.id);
                }
                return;
            }
            if (typeof props.sessionID === "string" && family.has(props.sessionID)) {
                answerAsk(base, cwd, props.sessionID, ev, opts);
            }
        },
        () => undefined
    );
}

// The model that answered, as `provider/model`: the assistant message names it
// (1.18.32: info.providerID / info.modelID). The CLI's JSON stream never does.
function noteModel(ev: Record<string, unknown>, metrics: RunMetrics): void {
    if (ev.type !== "message.updated") {
        return;
    }
    const info = ((ev.properties as Record<string, unknown> | undefined)?.info ?? {}) as Record<string, unknown>;
    if (info.role === "assistant" && typeof info.providerID === "string" && typeof info.modelID === "string") {
        metrics.model = `${info.providerID}/${info.modelID}`;
    }
}

export async function createServerSession(base: string, cwd: string, title: string): Promise<string> {
    // Bounded: a server that accepts the socket and never answers must not
    // hold the turn (every caller falls back to letting the run create one).
    const created = await httpRequestJson<{ id: string }>("POST", withDirectory(`${base}/session`, cwd), {
        title: truncate(title, 60),
        permission: HEADLESS_PERMISSION
    }, 5000);
    return created.id;
}

// An attach that could not reach the server fails fast and says so on stderr;
// the turn then runs cold rather than being lost.
export function isAttachFailure(metrics: RunMetrics): boolean {
    if (metrics.exitCode === 0 || metrics.exitCode === undefined || metrics.hadOutput || metrics.steps.length) {
        return false;
    }
    return /ECONNREFUSED|ECONNRESET|fetch failed|unable to connect|socket hang up/i.test(
        `${metrics.stderr ?? ""}${metrics.error ?? ""}`
    );
}

export function isMissingSessionRun(metrics: RunMetrics): boolean {
    if (metrics.exitCode === 0 || metrics.exitCode === undefined) {
        return false;
    }
    return /session not found/i.test(`${metrics.stderr ?? ""}${metrics.error ?? ""}`);
}

// Drop the dead id, forget it, and run the same prompt again on a new session.
// The turn is answered instead of lost, and workspaceState is cleared so the
// next turn does not repeat the failure.
export async function restartAfterMissingSession(
    runOpts: RunOptions,
    serverTransport: boolean,
    beat: { phase: (text: string) => void },
    response: vscode.ChatResponseStream,
    cwd: string
): Promise<RunMetrics> {
    const dead = runOpts.sessionId;
    logChannel.appendLine(
        `[${stamp()}] session ${dead} no longer exists — starting a fresh one and retrying this turn`
    );
    beat.phase("Previous session is gone — starting a fresh one");
    response.markdown(
        `> ${mark("restart")} The previous OpenCode session (\`${dead}\`) no longer exists, so this turn starts a new one. Earlier conversation history is not available.\n\n`
    );
    await setActiveSession(cwd, { turns: 0 });
    runOpts.sessionId = undefined;
    return (serverTransport ? runOpenCodeServer : runOpenCode)(runOpts);
}

interface ServerMessageResponse {
    info?: {
        tokens?: TokenUsage;
        cost?: number;
        sessionID?: string;
        providerID?: string;
        modelID?: string;
    };
    parts?: Array<Record<string, unknown>>;
}

function markFirstByte(metrics: RunMetrics, started: number): void {
    if (metrics.firstByteMs === undefined) {
        metrics.firstByteMs = Date.now() - started;
    }
}

interface EmitCursor {
    n: number;
    last: { t?: string; r?: string };
}

export function emitKeyedDelta(
    kind: "t" | "r",
    text: string,
    part: Record<string, unknown>,
    emitted: Map<string, number>,
    cursor: EmitCursor,
    index?: number
): string | undefined {
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
        } else {
            cursor.n += 1;
            key = `${kind}:i${cursor.n}`;
            cursor.last[kind] = key;
        }
    } else {
        cursor.last[kind] = key;
    }
    const prev = emitted.get(key) ?? 0;
    if (text.length <= prev) {
        return undefined;
    }
    emitted.set(key, text.length);
    return text.slice(prev);
}

export function applyServerPart(
    part: Record<string, unknown>,
    metrics: RunMetrics,
    options: RunOptions,
    started: number,
    emitted: Map<string, number>,
    tools: Map<string, StepRecord>,
    cursor: EmitCursor = { n: 0, last: {} },
    index?: number
): void {
    const type = part.type as string | undefined;
    if (type === "reasoning") {
        const text = (part.text as string) ?? "";
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
        const text = (part.text as string) ?? "";
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
        const tool = (part.tool as string) ?? "tool";
        const state = part.state as Record<string, unknown> | undefined;
        const input = state?.input as Record<string, unknown> | undefined;
        const time = state?.time as { start?: number; end?: number } | undefined;
        const durationMs =
            time?.start !== undefined && time?.end !== undefined ? time.end - time.start : undefined;
        const key = String(part.id ?? `${tool}:${JSON.stringify(input ?? {})}`);
        const detail = truncate(
            (input?.command as string) ??
            (input?.filePath as string) ??
            (input?.pattern as string) ??
            (input?.description as string) ??
            JSON.stringify(input ?? {})
        );
        markFirstByte(metrics, started);
        const output = stepOutput(state);
        const filePath = toolFilePath(input);
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
        const step: StepRecord = {
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

// Server transport: POST the prompt to the warm serve instance, but subscribe to
// SSE first so tokens/tools stream instead of arriving only when the POST ends.
export async function runOpenCodeServer(options: RunOptions): Promise<RunMetrics> {
    const started = Date.now();
    // Same silence detection as the CLI runner. `transport: auto` sends `plan`
    // here, and a tool call that blocks (a `python -c` waiting on stdin, a host
    // that accepts and never answers) would otherwise hold the whole turn.
    const idleMs = options.idleTimeoutMs ?? 0;
    let lastEventAt = Date.now();
    const markServerActive = (): void => {
        lastEventAt = Date.now();
    };
    const metrics: RunMetrics = {
        firstByteMs: undefined,
        totalMs: 0,
        timedOut: false,
        steps: [],
        tokens: emptyTokens(),
        cost: 0,
        hadOutput: false,
        sessionId: options.sessionId,
        reasoning: ""
    };
    // Parity with runOpenCode: composeVisibleAnswer names the cap only if recorded.
    metrics.appliedTimeoutMs = options.timeoutMs;
    const emitted = new Map<string, number>();
    const tools = new Map<string, StepRecord>();
    const cursor: EmitCursor = { n: 0, last: {} };
    // Set while the bridge aborts its own run: the MessageAbortedError that
    // follows is ours, not OpenCode's error to show.
    let aborting = false;

    const base = options.serverUrl ?? (await ensureServer(options.cwd));

    // Every session call is scoped to THIS workspace, so a server started by
    // another VS Code window cannot silently root the run in its own checkout.
    const scoped = (path: string): string => withDirectory(`${base}${path}`, options.cwd);

    let sessionId = options.sessionId;
    if (!sessionId) {
        const created = await httpRequestJson<{ id: string }>("POST", scoped("/session"), {
            title: truncate(options.task, 60),
            permission: HEADLESS_PERMISSION
        });
        sessionId = created.id;
    }
    metrics.sessionId = sessionId;
    const mine = sessionId;

    const body: Record<string, unknown> = { parts: [{ type: "text", text: options.task }] };
    if (options.agent) {
        body.agent = options.agent;
    }
    if (options.model) {
        const i = options.model.indexOf("/");
        if (i > 0) {
            body.model = { providerID: options.model.slice(0, i), modelID: options.model.slice(i + 1) };
        }
    }

    logChannel.appendLine(
        `[${stamp()}] → server ${base}${sessionPath(sessionId, "message")} ` +
        `(agent=${options.agent ?? "-"} model=${options.model ?? "-"})`
    );

    // Subscribe before posting, or the first events are missed; the fixed delay
    // bounds a server that never reports "connected".
    let attached: () => void = () => undefined;
    const subscribed = new Promise<void>((resolve) => {
        attached = resolve;
    });
    const sse = connectSse(
        base,
        (ev) => {
            // The demux also hands out unattributed events (server.heartbeat,
            // ~10s): only this session's own events reset the idle cap.
            if (sessionIdFromEvent(ev) === mine) {
                markServerActive();
            }
            const props = (ev.properties as Record<string, unknown> | undefined) ?? ev;
            const part = (props.part ?? ev.part) as Record<string, unknown> | undefined;
            const type = ev.type as string | undefined;
            noteModel(ev, metrics);
            if (type === "session.error" && !aborting) {
                const err = (props.error ?? props.message ?? ev.error) as
                    | { message?: string; name?: string }
                    | string
                    | undefined;
                const text =
                    typeof err === "string" ? err : err?.message ?? err?.name ?? "unknown session error";
                metrics.error = text;
                logChannel.appendLine(`[${stamp()}] ${mark("fail")} session.error: ${metrics.error}`);
            }
            if (part && (type === "message.part.updated" || type === undefined || type.startsWith("message"))) {
                applyServerPart(part, metrics, options, started, emitted, tools, cursor);
            }
            if (type === "text" || type === "reasoning" || type === "tool_use" || type === "tool") {
                applyServerPart(
                    part ?? { type, text: (ev as { text?: string }).text, tool: (ev as { tool?: string }).tool, state: ev.state },
                    metrics,
                    options,
                    started,
                    emitted,
                    tools,
                    cursor
                );
            }
        },
        (status) => {
            if (status === "connected") {
                attached();
            }
        },
        sessionId
    );
    // The bridge is the client here: it answers every ask (see headless asks).
    const asks = answerFamilyAsks(base, options.cwd, mine, { permissions: true, autoApprove: options.autoApprove && !options.readOnly });
    const closeStreams = (): void => {
        sse.close();
        asks.close();
    };

    // The 80ms is the bound, not the wait: a server that accepts the subscription
    // socket and never answers it must not hold the turn.
    await Promise.race([subscribed, delay(80)]);

    let resp: ServerMessageResponse | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let idleFired = false;
    try {
        const pending = httpRequestJson<ServerMessageResponse>(
            "POST",
            scoped(sessionPath(sessionId, "message")),
            body,
            options.timeoutMs,
            options.token
        );
        if (idleMs > 0) {
            // A tool the server reports running earns toolQuietMs, as on the CLI.
            const toolQuietMs = Math.max(0, options.toolQuietMs ?? 0);
            const watchdog = new Promise<never>((_, reject) => {
                idleTimer = setInterval(() => {
                    const quietFor = Date.now() - lastEventAt;
                    const running = [...tools.values()].find((s) => s.status === "running");
                    const cap = running && toolQuietMs > idleMs ? toolQuietMs : idleMs;
                    if (quietFor >= cap) {
                        idleFired = true;
                        if (running) {
                            metrics.stuckTool = running.tool;
                        }
                        const err = new Error(`no output for ${Math.round(quietFor / 1000)}s`) as Error & {
                            code?: string;
                        };
                        err.code = "ETIMEDOUT_BRIDGE";
                        reject(err);
                    }
                }, 1000);
                idleTimer.unref?.();
            });
            resp = await Promise.race([pending, watchdog]);
        } else {
            resp = await pending;
        }
    } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "ETIMEDOUT_BRIDGE" || code === "ECANCELLED_BRIDGE") {
            metrics.timedOut = code === "ETIMEDOUT_BRIDGE";
            if (idleFired) {
                metrics.idleTimeout = true;
                logChannel.appendLine(`[${stamp()}] ${mark("quiet")} ${(error as Error).message} — aborting the server run`);
            }
            // Bounded, and not awaited after Stop (the host allows one second).
            aborting = true;
            const abort = httpRequestJson("POST", scoped(sessionPath(sessionId, "abort")), undefined, 5000).catch(() => undefined);
            if (code !== "ECANCELLED_BRIDGE") {
                await abort;
            }
            metrics.totalMs = Date.now() - started;
            logChannel.appendLine(`[${stamp()}] server run ${metrics.timedOut ? "timed out" : "cancelled"}`);
            closeStreams();
            return metrics;
        }
        closeStreams();
        throw error;
    } finally {
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
            applyServerPart(part, metrics, options, started, emitted, tools, cursor, i + 1);
        });
        if (metrics.firstByteMs === undefined && (metrics.hadOutput || metrics.reasoning || metrics.steps.length)) {
            metrics.firstByteMs = Date.now() - started;
        }

        metrics.totalMs = Date.now() - started;
        return metrics;
    } finally {
        // Reached on the happy path and on any throw from the response walk
        // above; a leaked subscriber keeps the shared socket open for the
        // lifetime of the window.
        closeStreams();
    }
}

// The model a session last ran on, read from the session: the newest assistant
// message names it, a user message carries the model it was sent with
// (1.18.32: info.providerID/modelID; info.model on a user message).
export async function sessionModel(base: string, cwd: string, sessionId: string): Promise<string | undefined> {
    try {
        const messages = await httpGetJson<Array<{ info?: Record<string, unknown> }>>(
            withDirectory(`${base}${sessionPath(sessionId, "message")}?limit=6`, cwd),
            5000
        );
        for (const message of [...(Array.isArray(messages) ? messages : [])].reverse()) {
            const info = message?.info ?? {};
            if (info.role === "assistant" && typeof info.providerID === "string" && typeof info.modelID === "string") {
                return `${info.providerID}/${info.modelID}`;
            }
            const sent = info.model as { providerID?: string; modelID?: string; id?: string } | undefined;
            const id = sent?.modelID ?? sent?.id;
            if (info.role === "user" && sent?.providerID && id) {
                return `${sent.providerID}/${id}`;
            }
        }
    } catch (error) {
        logChannel.appendLine(`[${stamp()}] could not read the model of ${sessionId}: ${error}`);
    }
    return undefined;
}

// Compact (summarize) the persistent session via the managed server. The run CLI
// and the server share the same session store, so this shrinks the context that
// the next `opencode run` will load.
//
// Summarize with the model the session runs on (this turn's, the session's
// record, else the pin) and in the turn's folder — never the catalog's first.
const COMPACT_TIMEOUT_MS = 180000;

export async function compactSession(sessionId: string, cwd: string, model?: string): Promise<boolean> {
    try {
        const base = await ensureServer(cwd);
        const spec =
            model ??
            (await sessionModel(base, cwd, sessionId)) ??
            (config().get<string>("model", "").trim() || undefined);
        const index = spec?.indexOf("/") ?? -1;
        if (!spec || index <= 0) {
            logChannel.appendLine(`[${stamp()}] compact skipped: the model of ${sessionId} is not known yet`);
            return false;
        }
        const parts = { providerID: spec.slice(0, index), modelID: spec.slice(index + 1) };
        // A full model pass over the context: 30s timed out on 66k tokens.
        const status = await httpPostJson(
            withDirectory(`${base}${sessionPath(sessionId, "summarize")}`, cwd),
            { providerID: parts.providerID, modelID: parts.modelID, auto: true },
            COMPACT_TIMEOUT_MS
        );
        logChannel.appendLine(
            `[${stamp()}] summarize ${sessionId} with ${parts.providerID}/${parts.modelID} → HTTP ${status}`
        );
        return status >= 200 && status < 300;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logChannel.appendLine(`[${stamp()}] compact failed: ${message}`);
        return false;
    }
}

// A session id is untrusted (stdout, server, replayed metadata). In a URL path
// `..` walks to another endpoint; in argv a leading `-` is a flag. Every site
// uses sessionPath or safeSessionId (tripwire: MA); anything else is replaced.
const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export function safeSessionId(sessionId: string): string {
    if (SAFE_ID.test(sessionId)) {
        return sessionId;
    }
    const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[.-]+/, "_").slice(0, 128);
    const safe = cleaned || "session";
    logChannel?.appendLine(`[${stamp()}] unsafe session id ${JSON.stringify(sessionId)} → ${safe}`);
    return safe;
}

export const sessionPath = (sessionId: string, tail: string): string => `/session/${safeSessionId(sessionId)}/${tail}`;
/** The session itself: GET, PATCH or DELETE `/session/<id>`. */
export const sessionRoot = (sessionId: string): string => `/session/${safeSessionId(sessionId)}`;
