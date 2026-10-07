"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runTurn = runTurn;
const core_1 = require("./core");
const followups_1 = require("./followups");
const metrics_1 = require("./metrics");
const format_1 = require("./format");
const context_1 = require("./context");
const net_1 = require("./net");
const agents_1 = require("./agents");
const session_1 = require("./session");
const runs_1 = require("./runs");
const models_1 = require("./models");
const chat_boot_1 = require("./chat-boot");
const SUMMARY_WAIT_MS = 60000;
const COMPACT_MIN_TOKENS = 20000;
async function runTurn(t) {
    const live = await openTurn(t);
    try {
        const ready = await prepareRun(t, live);
        if ("result" in ready) {
            return ready.result;
        }
        return await finishTurn(t, live, await runAttempts(t, live, ready));
    }
    catch (error) {
        return await failTurn(t, live, error);
    }
}
async function openTurn(t) {
    const { response, token, cwd, agentLabel, continuing, model, timeoutMs, useServer, attachDev } = t;
    if (!useServer && attachDev) {
        response.progress("Connecting to the OpenCode server…");
    }
    const preRun = [];
    const timed = async (label, work) => {
        const began = Date.now();
        try {
            return await work();
        }
        finally {
            preRun.push(`${label} ${Date.now() - began}ms`);
        }
    };
    const attachUrl = !useServer && attachDev ? await (0, core_1.untilStop)(timed("server", () => (0, net_1.warmServer)(cwd, (text) => response.progress(text))), token) : undefined;
    const opening = `${continuing ? "Continuing" : "Starting"} the OpenCode ${agentLabel} session` +
        (useServer ? " via server" : attachUrl ? " via server (attached)" : " via cli") +
        (model ? ` (${model})` : "");
    const beat = (0, chat_boot_1.startHeartbeat)(response, opening, timeoutMs, cwd);
    const linker = (0, context_1.createFileLinker)(cwd);
    return { beat, linker, preRun, timed, attachUrl, opening };
}
async function prepareRun(t, live) {
    const { response, token, settings, state, cwd, kind, agentLabel, isBuild, devAgent, task, useServer } = t;
    const { beat, preRun, timed, attachUrl } = live;
    const busyPolicy = settings.get("busySessionPolicy", "abort");
    let sessionId = state.id;
    if (attachUrl && !sessionId && !token.isCancellationRequested) {
        try {
            sessionId = await timed("session", () => (0, runs_1.createServerSession)(attachUrl, cwd, task, !isBuild));
        }
        catch (error) {
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] could not pre-create a session, the run creates one: ${error}`);
        }
    }
    const guardBase = attachUrl ?? (useServer ? await (0, core_1.untilStop)(timed("server", () => (0, net_1.warmServer)(cwd, (text) => response.progress(text))), token) : undefined);
    const versionNote = guardBase ? (0, net_1.versionNotice)(guardBase) : undefined;
    if (versionNote) {
        response.markdown(`> ${(0, followups_1.mark)("warn")} ${versionNote}\n\n`);
    }
    const planChoice = isBuild || (0, agents_1.planAgentSetting)() === "plan"
        ? undefined
        : await timed("agent", () => (0, core_1.untilStop)((0, agents_1.resolvePlanAgent)(cwd, guardBase), token));
    const agent = isBuild ? devAgent : planChoice?.agent ?? "plan";
    const agentNote = (0, agents_1.planAgentNotice)(planChoice, cwd);
    if (agentNote) {
        response.markdown(`> ${(0, followups_1.mark)("warn")} ${agentNote}\n\n`);
    }
    const summary = sessionId ? (0, runs_1.compactionInFlight)(sessionId) : undefined;
    let summaryStillRunning = false;
    if (summary && !token.isCancellationRequested) {
        beat.phase("Finishing this session's summary first");
        const began = Date.now();
        const finished = await timed("summary", () => (0, core_1.untilStop)(Promise.race([summary.then(() => true), (0, core_1.delay)(SUMMARY_WAIT_MS).then(() => false)]), token));
        summaryStillRunning = finished === false;
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] waited ${(0, core_1.secs)(Date.now() - began)} for the session summary${summaryStillRunning ? " — still running" : ""}`);
    }
    if (guardBase && sessionId && busyPolicy !== "queue" && !token.isCancellationRequested) {
        if (await timed("busy-check", () => (0, runs_1.sessionBusy)(guardBase, sessionId, cwd))) {
            beat.phase("Stopping an unfinished earlier run in this session");
            const stopped = await (0, runs_1.abortServerRun)(guardBase, sessionId, cwd, summaryStillRunning ? "summary still running" : "busy before send");
            response.markdown(stopped && summaryStillRunning
                ? "> " + (0, followups_1.mark)("stop") + ` This session's summary was still running after ${Math.round(SUMMARY_WAIT_MS / 1000)} s, so I stopped it; the session keeps its full context.\n\n`
                : stopped
                    ? "> " + (0, followups_1.mark)("stop") + " This session was still busy with an earlier run nobody was watching, so I stopped it first — otherwise this message would have waited behind it. If turns stay slow, `/new` starts a clean session.\n\n"
                    : "> " + (0, followups_1.mark)("warn") + " This session is still busy with an earlier run and it did not stop. This message may wait behind it — `/new` starts a clean session.\n\n");
        }
    }
    if (preRun.length) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] pre-run: ${preRun.join(" · ")}`);
    }
    if (token.isCancellationRequested) {
        await beat.stop(true);
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] stopped by the user before the run started`);
        (0, session_1.refreshStatus)(cwd);
        return { result: { metadata: { kind, agent: agentLabel, sessionId, cwd, turns: state.turns, cancelled: true, notSent: true, prompt: t.replay } } };
    }
    return { sessionId, guardBase, agent };
}
async function runAttempts(t, live, ready) {
    const { response, token, settings, cwd, isBuild, task, taskForModel, executable, pure, useServer, timeoutMs, idleTimeoutMs, chain, variantFor } = t;
    const { beat, linker, attachUrl, opening } = live;
    const { guardBase } = ready;
    let { sessionId, agent } = ready;
    const toolQuietMs = Math.max(0, settings.get("toolQuietMs", 600000));
    const wantThinking = settings.get("showThoughtProcess", true);
    const streamStep = (step) => beat.step(step);
    let thinking = "";
    const streamReasoning = (text) => {
        thinking = (thinking + text).slice(-4000);
        beat.thought((0, chat_boot_1.thoughtLine)(thinking));
    };
    let metrics;
    let answer = "";
    let streamed = false;
    const show = (text) => {
        if (!text) {
            return;
        }
        answer += text;
        streamed = true;
        beat.activity();
        (0, context_1.emitAnswerParts)(response, linker.push(text));
    };
    const openSink = (attemptTask) => {
        const leak = (0, format_1.createLeakGate)();
        const echo = (0, format_1.createEchoGate)([task, attemptTask]);
        let lastPart;
        return {
            push: (raw, part) => {
                lastPart = part;
                show(echo.push(leak.push(raw), part));
            },
            flush: () => {
                show(echo.push(leak.flush(), lastPart));
                show(echo.flush());
            }
        };
    };
    let retrying = false;
    const settleRetry = () => {
        if (retrying) {
            retrying = false;
            beat.phase(opening, true);
        }
    };
    let serverTransport = useServer;
    let sessionRestarted = false;
    let lastAttempt = 0;
    let firstModel;
    for (let attempt = 0; attempt < chain.length; attempt++) {
        const attemptModel = chain[attempt];
        const handingOff = attempt > 0;
        if (handingOff) {
            (0, context_1.emitAnswerParts)(response, linker.flush());
            const label = attemptModel ?? "OpenCode default";
            beat.phase(`Timed out — handing off to ${label}`);
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] handoff → ${label}` + (sessionId ? ` (session ${sessionId})` : ""));
        }
        answer = "";
        streamed = false;
        const attemptTask = handingOff
            ? metrics?.hadOutput || metrics?.steps.length || metrics?.serverActivity
                ? (0, followups_1.prompt)("CONTINUE")
                : `${(0, followups_1.prompt)("CONTINUE")}\n\n${taskForModel}`
            : taskForModel;
        let sink = openSink(attemptTask);
        const rerun = (shown = false) => {
            if (shown) {
                sink.flush();
            }
            answer = "";
            streamed = false;
            sink = openSink(attemptTask);
        };
        const runOpts = {
            executable,
            task: attemptTask,
            cwd,
            agent,
            model: attemptModel,
            pure,
            autoApprove: isBuild || agent === "plan",
            readOnly: !isBuild,
            json: true,
            thinking: wantThinking,
            variant: variantFor(attempt),
            timeoutMs,
            idleTimeoutMs,
            sessionId,
            attachUrl: serverTransport ? undefined : attachUrl,
            serverUrl: serverTransport && attempt === 0 ? guardBase : undefined,
            toolQuietMs,
            token,
            onStep: (step) => {
                settleRetry();
                streamStep(step);
            },
            onReasoning: (text) => {
                settleRetry();
                streamReasoning(text);
            },
            onSubagent: (sub) => beat.subagent(sub),
            onText: (rawText, part) => {
                settleRetry();
                sink.push(rawText, part);
            },
            onRetry: (r) => {
                retrying = true;
                beat.phase(`${(0, followups_1.mark)("quiet")} Provider retry ${r.attempt || ""}`.trimEnd() +
                    (r.message ? ` · ${r.message}` : "") +
                    (r.nextMs ? ` · next in ${Math.ceil(r.nextMs / 1000)}s` : ""));
            }
        };
        try {
            metrics = await (serverTransport ? runs_1.runOpenCodeServer : runs_1.runOpenCode)(runOpts);
        }
        catch (error) {
            if ((0, runs_1.isMissingSessionError)(error) && runOpts.sessionId && !token.isCancellationRequested) {
                metrics = await (0, runs_1.restartAfterMissingSession)(runOpts, serverTransport, beat, response, cwd);
                sessionRestarted = true;
                rerun(true);
            }
            else if (!serverTransport || token.isCancellationRequested) {
                throw error;
            }
            else {
                core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] server failed, falling back to CLI: ${error}`);
                beat.phase("Server transport unavailable — retrying via cli");
                serverTransport = false;
                rerun();
                if (!isBuild && agent !== "plan" && guardBase) {
                    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] planAgent "${agent}" was confirmed by the server only — the CLI runs this turn as plan`);
                    response.markdown(`> ${(0, followups_1.mark)("warn")} OpenCode's server failed, so the CLI ran this turn as the built-in \`plan\`: \`${agent}\` is not confirmed there.\n\n`);
                    agent = "plan";
                    runOpts.agent = agent;
                    runOpts.autoApprove = true;
                }
                metrics = await (0, runs_1.runOpenCode)(runOpts);
            }
        }
        if (runOpts.attachUrl && (0, runs_1.isAttachFailure)(metrics) && !token.isCancellationRequested) {
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] attach to ${runOpts.attachUrl} failed — running cold`);
            beat.phase("Server unreachable — starting OpenCode directly");
            runOpts.attachUrl = undefined;
            rerun();
            metrics = await (0, runs_1.runOpenCode)(runOpts);
        }
        if (!sessionRestarted && (0, runs_1.isMissingSessionRun)(metrics) && runOpts.sessionId && !token.isCancellationRequested) {
            metrics = await (0, runs_1.restartAfterMissingSession)(runOpts, serverTransport, beat, response, cwd);
            sessionRestarted = true;
            rerun(true);
        }
        sink.flush();
        sessionId = metrics.sessionId ?? sessionId;
        lastAttempt = attempt;
        if (attempt === 0) {
            firstModel = attemptModel ?? metrics.model;
        }
        if (runOpts.attachUrl && sessionId && token.isCancellationRequested) {
            void (0, runs_1.abortServerRun)(runOpts.attachUrl, sessionId, cwd, "cancelled");
        }
        else if (runOpts.attachUrl && sessionId && metrics.timedOut) {
            await (0, runs_1.abortServerRun)(runOpts.attachUrl, sessionId, cwd, metrics.stuckTool ? `${metrics.stuckTool} stuck` : "timed out");
        }
        if (!metrics.timedOut || token.isCancellationRequested || attempt === chain.length - 1) {
            break;
        }
        const toolRunning = metrics.stuckTool ?? metrics.steps.find((s) => s.status === "running")?.tool;
        if (toolRunning) {
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] no handoff: stopped while ${toolRunning} was running — another model would not be faster`);
            metrics.stuckTool = toolRunning;
            break;
        }
    }
    return { metrics, answer, streamed, sessionId, sessionRestarted, lastAttempt, firstModel };
}
async function finishTurn(t, live, outcome) {
    const { response, token, settings, state, cwd, kind, agentLabel, task, settingPin, agentKey, chain, variantFor, continuing } = t;
    const { beat, linker } = live;
    const { metrics, answer, streamed, sessionId, sessionRestarted, lastAttempt, firstModel } = outcome;
    const autoCompact = settings.get("autoCompact", true);
    const COMPACT_CONTEXT_TOKENS = 60000;
    const COMPACT_CONTEXT_SHARE = 0.7;
    const compactEvery = settings.get("autoCompactEveryTurns", 8);
    (0, context_1.emitAnswerParts)(response, linker.flush());
    await beat.stop(token.isCancellationRequested);
    if (metrics) {
        metrics.cancelled = token.isCancellationRequested;
        (0, session_1.notifyIfSlow)(metrics, agentLabel, cwd);
        core_1.logChannel.appendLine((0, format_1.metricsLogLine)(metrics));
    }
    if (metrics) {
        (0, metrics_1.finalizeStepStatuses)(metrics);
        metrics.toolOutputBytes = (0, metrics_1.toolOutputBytes)(metrics);
    }
    const finalAnswer = (0, format_1.scrubLeakedContext)(metrics ? (0, format_1.composeVisibleAnswer)(task, answer, metrics) : answer.trim());
    if (!streamed || (0, format_1.isPromptEcho)(answer, task) || !answer.trim()) {
        if (finalAnswer) {
            const whole = (0, context_1.createFileLinker)(cwd);
            (0, context_1.emitAnswerParts)(response, [...whole.push(finalAnswer), ...whole.flush()]);
        }
        else {
            response.markdown("_OpenCode returned no output._");
        }
    }
    if (metrics?.cancelled) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${(0, followups_1.mark)("stop")} stopped by the user after ${(0, core_1.secs)(metrics.totalMs)}; the session is kept`);
    }
    if (metrics?.error) {
        response.markdown(`\n\n> ${(0, followups_1.mark)("fail")} OpenCode reported an error: \`${metrics.error}\``);
    }
    const cutOff = Boolean(metrics && !metrics.error && !metrics.timedOut && !metrics.cancelled && metrics.finishReason === "length");
    if (cutOff) {
        response.markdown(`\n\n> ${(0, followups_1.mark)("warn")} The answer stopped at the model's output limit, so it is cut off here.`);
    }
    if (metrics?.timedOut && metrics.stuckTool && !metrics.cancelled) {
        response.markdown(`\n\n> ${(0, followups_1.mark)("quiet")} Stopped while \`${metrics.stuckTool}\` was still running on the server; the run was aborted there too. ` +
            "Raise `toolQuietMs` if that tool is legitimately slow.");
    }
    if (metrics) {
        (0, context_1.emitReferences)(response, (0, context_1.stepUris)(cwd, metrics.steps));
    }
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
        response.markdown("\n\n> Prior tool output stays in this session and is resent every turn. Use /new if the last command returned a large diff.");
    }
    if (metrics?.timedOut || metrics?.error) {
        response.button({ command: "opencodeCopilotBridge.showLog", title: "Show debug log" });
    }
    const answeredBy = metrics?.model ?? chain[lastAttempt];
    if (lastAttempt > 0 && !settingPin && firstModel && sessionId) {
        (0, session_1.rememberHandoffReturn)(sessionId, firstModel, agentKey);
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] handed off to ${answeredBy ?? "a fallback"}; the next ${agentLabel} turn goes back to ${firstModel}`);
    }
    let turns = baseline.turns;
    if (sessionId) {
        turns += 1;
        await (0, session_1.setActiveSession)(cwd, {
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
    const contextTokens = metrics?.context ?? 0;
    const sizedBy = answeredBy ?? state.lastModel;
    const contextLimit = sizedBy ? (0, core_1.own)((0, models_1.cachedModelInfo)(), sizedBy)?.context : undefined;
    if (autoCompact &&
        sessionId &&
        turns > 0 &&
        ((turns % compactEvery === 0 && (contextTokens === 0 || contextTokens >= COMPACT_MIN_TOKENS)) ||
            contextTokens > COMPACT_CONTEXT_TOKENS ||
            (contextLimit !== undefined && contextTokens >= contextLimit * COMPACT_CONTEXT_SHARE))) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] compacting ${sessionId}: turn ${turns}, context ${contextTokens}` + (contextLimit ? ` of ${contextLimit}` : ""));
        void (0, runs_1.compactSession)(sessionId, cwd, answeredBy);
    }
    const compactOffer = !autoCompact && sessionId && (contextTokens > COMPACT_CONTEXT_TOKENS || (contextLimit !== undefined && contextTokens >= contextLimit * COMPACT_CONTEXT_SHARE))
        ? contextLimit
            ? `${Math.round((100 * contextTokens) / contextLimit)}%`
            : `${Math.round(contextTokens / 1000)}k`
        : undefined;
    const failedTask = metrics?.failedTasks?.[0];
    const sentVariant = variantFor(lastAttempt);
    if (sessionId && metrics && !metrics.error && !metrics.timedOut && !metrics.cancelled) {
        (0, chat_boot_1.rememberFollowups)(sessionId, turns, (0, chat_boot_1.suggestFollowups)({
            agent: agentLabel,
            answer: finalAnswer || answer,
            steps: metrics.steps,
            nextEffort: (0, models_1.higherEffort)(sizedBy, sentVariant)
        }));
    }
    (0, session_1.refreshStatus)(cwd);
    return {
        metadata: {
            kind,
            agent: agentLabel,
            sessionId,
            cwd,
            turns,
            tokensIn: baseline.tokensIn + (metrics?.tokens.input ?? 0),
            tokensOut: baseline.tokensOut + (metrics?.tokens.output ?? 0),
            cost: baseline.cost + (metrics?.cost ?? 0),
            toolOutputBytes: sessionBytes,
            model: answeredBy,
            ...(sentVariant ? { effort: sentVariant } : {}),
            ...(contextTokens ? { context: contextTokens } : {}),
            ...(compactOffer ? { compact: compactOffer } : {}),
            ...(failedTask
                ? { failedTask: { agent: failedTask.agent, description: (0, core_1.truncate)(failedTask.description, 80), ...(failedTask.sessionId ? { taskId: (0, runs_1.safeSessionId)(failedTask.sessionId) } : {}) } }
                : {}),
            ...(cutOff ? { truncated: true } : {}),
            ...(metrics?.timedOut && metrics.stuckTool && !metrics.cancelled ? { stuckTool: (0, core_1.truncate)(metrics.stuckTool, 40) } : {}),
            timedOut: Boolean(metrics?.timedOut),
            cancelled: Boolean(metrics?.cancelled),
            error: metrics?.error
        }
    };
}
async function failTurn(t, live, error) {
    const { response, token, state, cwd, kind, agentLabel, executable, replay } = t;
    const { beat, linker } = live;
    (0, context_1.emitAnswerParts)(response, linker.flush());
    await beat.stop(token.isCancellationRequested);
    if (token.isCancellationRequested) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] stopped by the user: ${error}`);
        (0, session_1.refreshStatus)(cwd);
        return { metadata: { kind, agent: agentLabel, sessionId: state.id, cwd, turns: state.turns, cancelled: true } };
    }
    (0, core_1.setStatus)("$(warning) OpenCode", "The last OpenCode run failed", true);
    const err = error;
    if (err.code === "ENOENT") {
        response.markdown(`\n\nCouldn't launch OpenCode (\`${executable}\`). Install the OpenCode CLI, ` +
            "or set an absolute path in the `opencodeCopilotBridge.executable` setting.");
        response.button({ command: "opencodeCopilotBridge.diagnose", title: "Run diagnostics" });
    }
    else {
        const message = err instanceof Error ? err.message : String(error);
        response.markdown(`\n\nOpenCode failed to start: ${message}`);
        response.button({ command: "opencodeCopilotBridge.showLog", title: "Show debug log" });
    }
    return { metadata: { kind, agent: agentLabel, error: String(err?.message ?? error), prompt: replay } };
}
//# sourceMappingURL=chat-turn.js.map