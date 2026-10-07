// A chat turn after the gates (./chat): the live line, the attempts and the
// ladder that recovers a failed one (stale session, dead server, dead attach,
// model stall), then the answer, the session's books, autocompact and the
// chips. The router decides what to run and hands it over as a Turn.
import * as vscode from "vscode";
import { logChannel, own, secs, setStatus, stamp, truncate, untilStop } from "./core";
import { mark, prompt as promptText } from "./followups";
import { ChatKind, RunMetrics, RunOptions, StepRecord, finalizeStepStatuses, toolOutputBytes } from "./metrics";
import { composeVisibleAnswer, isPromptEcho, metricsLogLine, scrubLeakedContext } from "./format";
import { createFileLinker, emitAnswerParts, emitReferences, stepUris } from "./context";
import { versionNotice, warmServer } from "./net";
import { planAgentNotice, planAgentSetting, resolvePlanAgent } from "./agents";
import { SessionState, notifyIfSlow, refreshStatus, rememberHandoffReturn, setActiveSession } from "./session";
import {
    abortServerRun,
    compactSession,
    createServerSession,
    isAttachFailure,
    isMissingSessionError,
    isMissingSessionRun,
    restartAfterMissingSession,
    runOpenCode,
    runOpenCodeServer,
    safeSessionId,
    sessionBusy
} from "./runs";
import { cachedModelInfo, higherEffort } from "./models";
import { Heartbeat, rememberFollowups, startHeartbeat, suggestFollowups, thoughtLine } from "./chat-boot";

/** What the route and the gates decided: the turn reads nothing from the request again. */
export interface Turn {
    response: vscode.ChatResponseStream;
    token: vscode.CancellationToken;
    /** The settings as the turn began. */
    settings: vscode.WorkspaceConfiguration;
    state: SessionState;
    cwd: string;
    kind: ChatKind;
    agentLabel: "dev" | "plan";
    isBuild: boolean;
    devAgent: string;
    task: string;
    /** The task with the attachments and merged lanes folded in. */
    taskForModel: string;
    /** What a replay of this turn sends back (a failed launch carries it). */
    replay: string;
    executable: string;
    pure: boolean;
    useServer: boolean;
    attachDev: boolean;
    timeoutMs: number;
    idleTimeoutMs: number;
    /** The model this turn names, if any. */
    model: string | undefined;
    settingPin: string | undefined;
    /** What a handoff's way back is keyed by. */
    agentKey: string;
    /** The model, then each fallback: one attempt per entry. */
    chain: Array<string | undefined>;
    variantFor: (attempt: number) => string | undefined;
    continuing: boolean;
}

/** What opening the turn left running. */
interface Live {
    beat: Heartbeat;
    linker: ReturnType<typeof createFileLinker>;
    /** What happens before the model sees the task, logged as `pre-run:`. */
    preRun: string[];
    timed: <T>(label: string, work: () => Promise<T>) => Promise<T>;
    attachUrl: string | undefined;
}

/** What the run starts from. */
interface Ready {
    sessionId: string | undefined;
    guardBase: string | undefined;
    agent: string;
}

/** Stop came before the run started: the turn is over. */
interface Stopped {
    result: vscode.ChatResult;
}

/** What the attempts leave for finishing the turn. */
interface Outcome {
    metrics: RunMetrics | undefined;
    answer: string;
    streamed: boolean;
    sessionId: string | undefined;
    sessionRestarted: boolean;
    lastAttempt: number;
    /** The first attempt's model: the way back after an unpinned handoff. */
    firstModel: string | undefined;
}

export async function runTurn(t: Turn): Promise<vscode.ChatResult> {
    const live = await openTurn(t);
    try {
        const ready = await prepareRun(t, live);
        if ("result" in ready) {
            return ready.result;
        }
        return await finishTurn(t, live, await runAttempts(t, live, ready));
    } catch (error) {
        return await failTurn(t, live, error);
    }
}

// The line the user sees while the server starts and the heartbeat after it.
async function openTurn(t: Turn): Promise<Live> {
    const { response, token, cwd, agentLabel, continuing, model, timeoutMs, useServer, attachDev } = t;
    // A plain progress line on purpose: the host hides it once the next part follows.
    if (!useServer && attachDev) {
        response.progress("Connecting to the OpenCode server…");
    }
    const preRun: string[] = [];
    const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
        const began = Date.now();
        try {
            return await work();
        } finally {
            preRun.push(`${label} ${Date.now() - began}ms`);
        }
    };
    const attachUrl = !useServer && attachDev ? await untilStop(timed("server", () => warmServer(cwd, (text) => response.progress(text))), token) : undefined;

    const beat = startHeartbeat(
        response,
        `${continuing ? "Continuing" : "Starting"} the OpenCode ${agentLabel} session` +
        (useServer ? " via server" : attachUrl ? " via server (attached)" : " via cli") +
        (model ? ` (${model})` : ""),
        timeoutMs,
        cwd
    );
    // `src/cart.ts:42` in the answer becomes a pill that opens the file.
    const linker = createFileLinker(cwd);
    return { beat, linker, preRun, timed, attachUrl };
}

// Before the first attempt: the session, the server, the agent, and a busy
// session. Stop coming first ends the turn there.
async function prepareRun(t: Turn, live: Live): Promise<Ready | Stopped> {
    const { response, token, settings, state, cwd, kind, agentLabel, isBuild, devAgent, task, useServer } = t;
    const { beat, preRun, timed, attachUrl } = live;
    const busyPolicy = settings.get<string>("busySessionPolicy", "abort");
    let sessionId: string | undefined = state.id;

    // An attached run needs its session id first, for the SSE liveness feed.
    if (attachUrl && !sessionId && !token.isCancellationRequested) {
        try {
            sessionId = await timed("session", () => createServerSession(attachUrl, cwd, task, !isBuild));
        } catch (error) {
            logChannel.appendLine(`[${stamp()}] could not pre-create a session, the run creates one: ${error}`);
        }
    }

    // Never queue silently behind a run nobody watches (busySessionPolicy).
    const guardBase = attachUrl ?? (useServer ? await untilStop(timed("server", () => warmServer(cwd, (text) => response.progress(text))), token) : undefined);
    const versionNote = guardBase ? versionNotice(guardBase) : undefined;
    if (versionNote) {
        response.markdown(`> ${mark("warn")} ${versionNote}\n\n`);
    }
    // planAgent only once OpenCode lists it: the CLI runs an unknown name
    // as BUILD (REFS "Read-only turns"). Raced against Stop.
    const planChoice = isBuild || planAgentSetting() === "plan"
        ? undefined
        : await timed("agent", () => untilStop(resolvePlanAgent(cwd, guardBase), token));
    const agent = isBuild ? devAgent : planChoice?.agent ?? "plan";
    const agentNote = planAgentNotice(planChoice, cwd);
    if (agentNote) {
        response.markdown(`> ${mark("warn")} ${agentNote}\n\n`);
    }
    if (guardBase && sessionId && busyPolicy !== "queue" && !token.isCancellationRequested) {
        if (await timed("busy-check", () => sessionBusy(guardBase, sessionId as string, cwd))) {
            beat.phase("Stopping an unfinished earlier run in this session");
            const stopped = await abortServerRun(guardBase, sessionId, cwd, "busy before send");
            response.markdown(
                stopped
                    ? "> " + mark("stop") + " This session was still busy with an earlier run nobody was watching, so I stopped it first — otherwise this message would have waited behind it. If turns stay slow, `/new` starts a clean session.\n\n"
                    : "> " + mark("warn") + " This session is still busy with an earlier run and it did not stop. This message may wait behind it — `/new` starts a clean session.\n\n"
            );
        }
    }

    if (preRun.length) {
        logChannel.appendLine(`[${stamp()}] pre-run: ${preRun.join(" · ")}`);
    }
    // Stop pressed while the server was starting: nothing ran, nothing to abort.
    if (token.isCancellationRequested) {
        await beat.stop(true);
        logChannel.appendLine(`[${stamp()}] stopped by the user before the run started`);
        refreshStatus(cwd);
        return { result: { metadata: { kind, agent: agentLabel, sessionId, cwd, turns: state.turns, cancelled: true } } };
    }
    return { sessionId, guardBase, agent };
}

// The attempts: one per model in the chain, a handoff only on a model stall,
// and the ladder under each one (stale session, dead server, dead attach).
async function runAttempts(t: Turn, live: Live, ready: Ready): Promise<Outcome> {
    const { response, token, settings, cwd, isBuild, task, taskForModel, executable, pure, useServer, timeoutMs, idleTimeoutMs, chain, variantFor } = t;
    const { beat, linker, attachUrl } = live;
    const { guardBase } = ready;
    let { sessionId, agent } = ready;
    const toolQuietMs = Math.max(0, settings.get<number>("toolQuietMs", 600000));
    // Only ask OpenCode for thinking blocks when something will consume them.
    const wantThinking = settings.get<boolean>("showThoughtProcess", true);

    const streamStep = (step: StepRecord): void => beat.step(step);
    // The line shows where the reasoning has got to, not how it started.
    let thinking = "";
    const streamReasoning = (text: string): void => {
        thinking = (thinking + text).slice(-4000);
        beat.thought(thoughtLine(thinking));
    };

    let metrics: RunMetrics | undefined;
    let answer = "";
    let streamed = false;
    let serverTransport = useServer;
    // Recover from a missing session once per turn, or it could loop.
    let sessionRestarted = false;
    // Which attempt answered, and the first attempt's model (the way back).
    let lastAttempt = 0;
    let firstModel: string | undefined;

    for (let attempt = 0; attempt < chain.length; attempt++) {
        const attemptModel = chain[attempt];
        const handingOff = attempt > 0;
        if (handingOff) {
            emitAnswerParts(response, linker.flush());
            const label = attemptModel ?? "OpenCode default";
            beat.phase(`Timed out — handing off to ${label}`);
            logChannel.appendLine(
                `[${stamp()}] handoff → ${label}` + (sessionId ? ` (session ${sessionId})` : "")
            );
        }

        answer = "";
        streamed = false;
        // A handoff continues the same session: resend the task only if the
        // last attempt produced nothing at all (no text, steps or activity).
        const attemptTask = handingOff
            ? metrics?.hadOutput || metrics?.steps.length || metrics?.serverActivity
                ? promptText("CONTINUE")
                : `${promptText("CONTINUE")}\n\n${taskForModel}`
            : taskForModel;

        const runOpts: RunOptions = {
            executable,
            task: attemptTask,
            cwd,
            agent,
            model: attemptModel,
            pure,
            // `--auto` for /dev and the built-in plan only; the server path
            // answers a read-only turn's asks itself (readOnly).
            autoApprove: isBuild || agent === "plan",
            readOnly: !isBuild,
            json: true,
            thinking: wantThinking,
            variant: variantFor(attempt),
            timeoutMs,
            idleTimeoutMs,
            sessionId,
            attachUrl: serverTransport ? undefined : attachUrl,
            // First attempt only: a later handoff re-checks, and restarts a dead server.
            serverUrl: serverTransport && attempt === 0 ? guardBase : undefined,
            toolQuietMs,
            token,
            onStep: streamStep,
            onReasoning: streamReasoning,
            onSubagent: (sub) => beat.subagent(sub),
            onText: (rawText) => {
                const text = scrubLeakedContext(rawText);
                if (!text || (!answer.trim() && (isPromptEcho(text, task) || isPromptEcho(text, attemptTask)))) {
                    return;
                }
                answer += text;
                streamed = true;
                beat.activity();
                emitAnswerParts(response, linker.push(text));
            }
        };
        try {
            metrics = await (serverTransport ? runOpenCodeServer : runOpenCode)(runOpts);
        } catch (error) {
            // A stale session id is fatal on both transports.
            if (isMissingSessionError(error) && runOpts.sessionId && !token.isCancellationRequested) {
                metrics = await restartAfterMissingSession(
                    runOpts,
                    serverTransport,
                    beat,
                    response,
                    cwd
                );
                sessionRestarted = true;
                answer = "";
                streamed = false;
            } else if (!serverTransport || token.isCancellationRequested) {
                throw error;
            } else {
                // The managed server failed: the CLI takes this and later attempts.
                logChannel.appendLine(`[${stamp()}] server failed, falling back to CLI: ${error}`);
                beat.phase("Server transport unavailable — retrying via cli");
                serverTransport = false;
                answer = "";
                streamed = false;
                // Only the failed server confirmed planAgent: the CLI runs plan.
                if (!isBuild && agent !== "plan" && guardBase) {
                    logChannel.appendLine(`[${stamp()}] planAgent "${agent}" was confirmed by the server only — the CLI runs this turn as plan`);
                    response.markdown(`> ${mark("warn")} OpenCode's server failed, so the CLI ran this turn as the built-in \`plan\`: \`${agent}\` is not confirmed there.\n\n`);
                    agent = "plan";
                    runOpts.agent = agent;
                    runOpts.autoApprove = true;
                }
                metrics = await runOpenCode(runOpts);
            }
        }
        // A dead attach target: run the same attempt cold.
        if (runOpts.attachUrl && isAttachFailure(metrics) && !token.isCancellationRequested) {
            logChannel.appendLine(`[${stamp()}] attach to ${runOpts.attachUrl} failed — running cold`);
            beat.phase("Server unreachable — starting OpenCode directly");
            runOpts.attachUrl = undefined;
            answer = "";
            streamed = false;
            metrics = await runOpenCode(runOpts);
        }
        // The CLI reports a dead session by its exit, not by throwing.
        if (!sessionRestarted && isMissingSessionRun(metrics) && runOpts.sessionId && !token.isCancellationRequested) {
            metrics = await restartAfterMissingSession(runOpts, serverTransport, beat, response, cwd);
            sessionRestarted = true;
            answer = "";
            streamed = false;
        }
        sessionId = metrics.sessionId ?? sessionId;
        lastAttempt = attempt;
        if (attempt === 0) {
            firstModel = attemptModel ?? metrics.model;
        }

        // Stopping the client does not stop the run: abort it on the server.
        // After Stop, do not await it — the host allows the handler one second.
        if (runOpts.attachUrl && sessionId && token.isCancellationRequested) {
            void abortServerRun(runOpts.attachUrl, sessionId, cwd, "cancelled");
        } else if (runOpts.attachUrl && sessionId && metrics.timedOut) {
            await abortServerRun(runOpts.attachUrl, sessionId, cwd, metrics.stuckTool ? `${metrics.stuckTool} stuck` : "timed out");
        }

        if (!metrics.timedOut || token.isCancellationRequested || attempt === chain.length - 1) {
            break;
        }
        // Hand off only on a model stall: another model won't make a tool faster.
        const toolRunning = metrics.stuckTool ?? metrics.steps.find((s) => s.status === "running")?.tool;
        if (toolRunning) {
            logChannel.appendLine(
                `[${stamp()}] no handoff: stopped while ${toolRunning} was running — another model would not be faster`
            );
            metrics.stuckTool = toolRunning;
            break;
        }
    }
    return { metrics, answer, streamed, sessionId, sessionRestarted, lastAttempt, firstModel };
}

// After the attempts: what chat shows, the session's books, autocompact, the
// chips, and the metadata a later turn (and the chips) read.
async function finishTurn(t: Turn, live: Live, outcome: Outcome): Promise<vscode.ChatResult> {
    const { response, token, settings, state, cwd, kind, agentLabel, task, settingPin, agentKey, chain, variantFor, continuing } = t;
    const { beat, linker } = live;
    const { metrics, answer, streamed, sessionId, sessionRestarted, lastAttempt, firstModel } = outcome;
    const autoCompact = settings.get<boolean>("autoCompact", true);
    // Size triggers a summarize too, not only the turn count (9.6k → 199k seen in 8 turns):
    // 60k of context, or 70% of the model's window when the catalog knows it.
    const COMPACT_CONTEXT_TOKENS = 60000;
    const COMPACT_CONTEXT_SHARE = 0.7;
    const compactEvery = settings.get<number>("autoCompactEveryTurns", 8);

    emitAnswerParts(response, linker.flush());
    await beat.stop(token.isCancellationRequested);
    if (metrics) {
        metrics.cancelled = token.isCancellationRequested;
        notifyIfSlow(metrics, agentLabel, cwd);
        logChannel.appendLine(metricsLogLine(metrics));
    }

    // Chat gets the answer; thoughts and the full log go to the output channel.
    if (metrics) {
        finalizeStepStatuses(metrics);
        metrics.toolOutputBytes = toolOutputBytes(metrics);
    }
    const finalAnswer = scrubLeakedContext(
        metrics ? composeVisibleAnswer(task, answer, metrics) : answer.trim()
    );
    if (!streamed || isPromptEcho(answer, task) || !answer.trim()) {
        if (finalAnswer) {
            const whole = createFileLinker(cwd);
            emitAnswerParts(response, [...whole.push(finalAnswer), ...whole.flush()]);
        } else {
            response.markdown("_OpenCode returned no output._");
        }
    }

    if (metrics?.cancelled) {
        // Not a chat line: the host drops anything sent after Stop.
        logChannel.appendLine(`[${stamp()}] ${mark("stop")} stopped by the user after ${secs(metrics.totalMs)}; the session is kept`);
    }
    if (metrics?.error) {
        response.markdown(`\n\n> ${mark("fail")} OpenCode reported an error: \`${metrics.error}\``);
    }
    if (metrics?.timedOut && metrics.stuckTool && !metrics.cancelled) {
        response.markdown(
            `\n\n> ${mark("quiet")} Stopped while \`${metrics.stuckTool}\` was still running on the server; the run was aborted there too. ` +
            "Raise `toolQuietMs` if that tool is legitimately slow."
        );
    }

    // Files the agent read or wrote: the "Used N references" list.
    if (metrics) {
        emitReferences(response, stepUris(cwd, metrics.steps));
    }

    // After a stale-session restart the old counters belong to no session.
    const baseline = sessionRestarted
        ? { turns: 0, tokensIn: 0, tokensOut: 0, cost: 0, toolOutputBytes: 0 }
        : {
            turns: state.turns,
            tokensIn: state.tokensIn ?? 0,
            tokensOut: state.tokensOut ?? 0,
            cost: state.cost ?? 0,
            toolOutputBytes: state.toolOutputBytes ?? 0
        };
    const sessionBytes = baseline.toolOutputBytes + (metrics?.toolOutputBytes ?? 0);
    if (metrics?.timedOut && continuing) {
        response.markdown(
            "\n\n> Prior tool output stays in this session and is resent every turn. Use /new if the last command returned a large diff."
        );
    }
    // Retry and friends are chips; the body keeps only the artifact.
    if (metrics?.timedOut || metrics?.error) {
        response.button({ command: "opencodeCopilotBridge.showLog", title: "Show debug log" });
    }

    // The model that answered: reported by the run, else the one named.
    const answeredBy = metrics?.model ?? chain[lastAttempt];
    if (lastAttempt > 0 && !settingPin && firstModel && sessionId) {
        rememberHandoffReturn(sessionId, firstModel, agentKey);
        logChannel.appendLine(`[${stamp()}] handed off to ${answeredBy ?? "a fallback"}; the next ${agentLabel} turn goes back to ${firstModel}`);
    }

    let turns = baseline.turns;
    if (sessionId) {
        turns += 1;
        await setActiveSession(cwd, {
            id: sessionId,
            turns,
            toolOutputBytes: sessionBytes,
            tokensIn: baseline.tokensIn + (metrics?.tokens.input ?? 0),
            tokensOut: baseline.tokensOut + (metrics?.tokens.output ?? 0),
            cost: baseline.cost + (metrics?.cost ?? 0),
            lastModel: answeredBy,
            context: metrics?.context
        });
    }

    // Autocompact in the background: awaiting it held a finished answer for 30s.
    // Sized by the last step's context, as OpenCode sizes it: the turn's summed
    // `input` counted the context once per step and left out cache reads.
    const contextTokens = metrics?.context ?? 0;
    const sizedBy = answeredBy ?? state.lastModel;
    const contextLimit = sizedBy ? own(cachedModelInfo(), sizedBy)?.context : undefined;
    if (
        autoCompact &&
        sessionId &&
        turns > 0 &&
        (turns % compactEvery === 0 ||
            contextTokens > COMPACT_CONTEXT_TOKENS ||
            (contextLimit !== undefined && contextTokens >= contextLimit * COMPACT_CONTEXT_SHARE))
    ) {
        logChannel.appendLine(
            `[${stamp()}] compacting ${sessionId}: turn ${turns}, context ${contextTokens}` + (contextLimit ? ` of ${contextLimit}` : "")
        );
        void compactSession(sessionId, cwd, answeredBy);
    }
    // Autocompact off: offer it once the context is where it would have fired.
    const compactOffer =
        !autoCompact && sessionId && (contextTokens > COMPACT_CONTEXT_TOKENS || (contextLimit !== undefined && contextTokens >= contextLimit * COMPACT_CONTEXT_SHARE))
            ? contextLimit
                ? `${Math.round((100 * contextTokens) / contextLimit)}%`
                : `${Math.round(contextTokens / 1000)}k`
            : undefined;
    const failedTask = metrics?.failedTasks?.[0];
    const sentVariant = variantFor(lastAttempt);
    if (sessionId && metrics && !metrics.error && !metrics.timedOut && !metrics.cancelled) {
        rememberFollowups(
            sessionId,
            turns,
            suggestFollowups({
                agent: agentLabel,
                answer: finalAnswer || answer,
                steps: metrics.steps,
                nextEffort: higherEffort(sizedBy, sentVariant)
            })
        );
    }
    refreshStatus(cwd);
    return {
        metadata: {
            kind,
            agent: agentLabel,
            sessionId,
            cwd,
            turns,
            // Running totals travel with the turn: a reopened chat resumes them.
            tokensIn: baseline.tokensIn + (metrics?.tokens.input ?? 0),
            tokensOut: baseline.tokensOut + (metrics?.tokens.output ?? 0),
            cost: baseline.cost + (metrics?.cost ?? 0),
            toolOutputBytes: sessionBytes,
            model: answeredBy,
            ...(sentVariant ? { effort: sentVariant } : {}),
            ...(contextTokens ? { context: contextTokens } : {}),
            ...(compactOffer ? { compact: compactOffer } : {}),
            ...(failedTask
                ? { failedTask: { agent: failedTask.agent, description: truncate(failedTask.description, 80), ...(failedTask.sessionId ? { taskId: safeSessionId(failedTask.sessionId) } : {}) } }
                : {}),
            timedOut: Boolean(metrics?.timedOut),
            cancelled: Boolean(metrics?.cancelled),
            error: metrics?.error
            // Keep this small: history replays it on every later turn, forever.
        }
    };
}

// A throw out of the turn: Stop is not a failure; a launch that failed says why.
async function failTurn(t: Turn, live: Live, error: unknown): Promise<vscode.ChatResult> {
    const { response, token, state, cwd, kind, agentLabel, executable, replay } = t;
    const { beat, linker } = live;
    emitAnswerParts(response, linker.flush());
    await beat.stop(token.isCancellationRequested);
    if (token.isCancellationRequested) {
        // A run torn down by Stop is not a failed run.
        logChannel.appendLine(`[${stamp()}] stopped by the user: ${error}`);
        refreshStatus(cwd);
        return { metadata: { kind, agent: agentLabel, sessionId: state.id, cwd, turns: state.turns, cancelled: true } };
    }
    setStatus("$(warning) OpenCode", "The last OpenCode run failed", true);
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
        response.markdown(
            `\n\nCouldn't launch OpenCode (\`${executable}\`). Install the OpenCode CLI, ` +
            "or set an absolute path in the `opencodeCopilotBridge.executable` setting."
        );
        response.button({ command: "opencodeCopilotBridge.diagnose", title: "Run diagnostics" });
    } else {
        const message = err instanceof Error ? err.message : String(error);
        response.markdown(`\n\nOpenCode failed to start: ${message}`);
        response.button({ command: "opencodeCopilotBridge.showLog", title: "Show debug log" });
    }
    return { metadata: { kind, agent: agentLabel, error: String(err?.message ?? error), prompt: replay } };
}
