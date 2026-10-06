// The server transport: POST the prompt to the warm `opencode serve`, stream
// its events from the shared SSE demux, answer every ask of the session and its
// subagents, abort on silence or Stop.
import { delay, logChannel, stamp, truncate } from "./core";
import { mark } from "./followups";
import { connectSse, ensureServer, httpRequestJson, sessionIdFromEvent, withDirectory } from "./net";
import { RunMetrics, RunOptions, StepRecord, TokenUsage, contextOf } from "./metrics";
import { watchFamily } from "./asks";
import { EmitCursor, addSubagents, applyServerPart, blankMetrics, noteModel } from "./run-steps";
import { abortChildren, applyTurnPermission, noteTurnPermission, sessionPath, turnPermission } from "./server-session";

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
    const metrics: RunMetrics = blankMetrics(options.sessionId);
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

    const readOnly = Boolean(options.readOnly);
    let sessionId = options.sessionId;
    if (!sessionId) {
        const created = await httpRequestJson<{ id: string }>("POST", scoped("/session"), {
            title: truncate(options.task, 60),
            permission: turnPermission(readOnly)
        });
        sessionId = created.id;
        noteTurnPermission(base, sessionId, readOnly);
    } else {
        await applyTurnPermission(base, options.cwd, sessionId, readOnly);
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
    // Sent every turn: OpenCode resets a session to "default" on a prompt without one.
    if (options.variant) {
        body.variant = options.variant;
    }

    logChannel.appendLine(
        `[${stamp()}] → server ${base}${sessionPath(sessionId, "message")} ` +
        `(agent=${options.agent ?? "-"} model=${options.model ?? "-"}${options.variant ? ` variant=${options.variant}` : ""})`
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
    const family = watchFamily(
        base,
        options.cwd,
        mine,
        { permissions: true, autoApprove: options.autoApprove && !readOnly },
        { onActivity: markServerActive, onSubagent: options.onSubagent }
    );
    let closed = false;
    const closeStreams = (): void => {
        if (closed) {
            return;
        }
        closed = true;
        sse.close();
        addSubagents(metrics, family.children(), family.childCost());
        family.close();
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
            // Its subagents too, never awaited: the ids the stream showed, and
            // whatever /children adds.
            void abortChildren(base, sessionId, options.cwd, family.children());
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
            metrics.context = contextOf(tk) || metrics.context;
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
