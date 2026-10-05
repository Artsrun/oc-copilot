"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleChat = handleChat;
const core_1 = require("./core");
const followups_1 = require("./followups");
const metrics_1 = require("./metrics");
const format_1 = require("./format");
const prompt_1 = require("./prompt");
const context_1 = require("./context");
const net_1 = require("./net");
const agents_1 = require("./agents");
const session_1 = require("./session");
const runs_1 = require("./runs");
const models_1 = require("./models");
const chat_boot_1 = require("./chat-boot");
const chat_commands_1 = require("./chat-commands");
const compose_1 = require("./compose");
const chat_worktree_1 = require("./chat-worktree");
async function handleChat(request, context, rawResponse, token, turn = {}) {
    const response = (0, chat_boot_1.chatStream)(rawResponse, token);
    const choice = (0, core_1.resolveFolder)(request);
    if (!choice) {
        response.markdown("Open a workspace before delegating a task to OpenCode.");
        return { metadata: { kind: "error" } };
    }
    const folder = choice.folder;
    const cwd = folder.uri.fsPath;
    (0, core_1.rememberFolder)(cwd);
    const aliased = (0, chat_boot_1.resolveAlias)(request.prompt.trim());
    if (aliased.problem) {
        response.markdown(aliased.problem);
        return { metadata: { kind: "idle" } };
    }
    const prompt = aliased.prompt;
    const retired = (0, chat_boot_1.retiredCommand)(prompt);
    if (retired) {
        response.markdown(retired);
        return { metadata: { kind: "idle" } };
    }
    const state = (0, session_1.resolveSessionState)(context, cwd);
    const declared = request.command?.toLowerCase() ?? "";
    const control = (0, chat_boot_1.controlCommand)(declared, (0, chat_boot_1.typedSlash)(prompt));
    const answered = await (0, chat_commands_1.handleControlCommand)({
        control,
        token,
        context,
        cwd,
        folder,
        state,
        response
    });
    if (answered) {
        return answered;
    }
    const typedWorktree = /^\/worktree\b\s*/i.test(prompt);
    if (declared === "worktree" || typedWorktree) {
        return (0, chat_worktree_1.handleWorktree)({ task: prompt.replace(/^\/worktree\b\s*/i, "").trim(), cwd, response, token });
    }
    if (!prompt && !(0, chat_boot_1.isKindCommand)(declared)) {
        response.markdown("Describe the task and I'll keep it in one ongoing OpenCode plan session. " +
            "Use `/dev` to edit, `model:provider/id` to pin a model, " +
            "or `/new`, `/session`, `/help`.");
        return { metadata: { kind: "idle" } };
    }
    const slashKind = prompt.match(/^\/(plan|dev|parallel|par)\b\s*/i)?.[1]?.toLowerCase() ?? "";
    const normalizedPrompt = slashKind
        ? prompt.replace(/^\/\S+\s*/, `${slashKind === "par" ? "parallel" : slashKind}: `)
        : prompt;
    const parsed = (0, context_1.parseChatPrompt)(normalizedPrompt);
    const kind = (0, chat_boot_1.kindChoice)(declared, parsed.kind);
    const isBuild = kind === "dev";
    const devAgent = (0, core_1.config)().get("devAgent", "build").trim() || "build";
    const agentLabel = isBuild ? "dev" : "plan";
    const task = parsed.task;
    const replay = (0, chat_boot_1.isKindCommand)(declared) && !slashKind ? `/${declared} ${prompt}`.trim() : prompt;
    const settings = (0, core_1.config)();
    const executable = settings.get("executable", "opencode");
    const settingPin = settings.get("model", "").trim() || undefined;
    let timeoutMs = settings.get("timeoutMs", 0);
    const pure = settings.get("pure", false);
    const transport = settings.get("transport", "auto");
    const useServer = transport === "server" || (transport === "auto" && !isBuild);
    const attachDev = transport === "auto" && settings.get("attachDevToServer", true);
    const autoCompact = settings.get("autoCompact", true);
    const COMPACT_INPUT_TOKENS = 60000;
    const compactEvery = settings.get("autoCompactEveryTurns", 8);
    const showThoughts = settings.get("showThoughtProcess", true);
    const wantThinking = showThoughts;
    const fallbackModels = settings
        .get("fallbackModels", [])
        .map((m) => m.trim())
        .filter(Boolean);
    const resolveModel = (0, models_1.modelResolver)(executable, cwd, (work) => (0, core_1.untilStop)(work, token));
    if (kind === "parallel") {
        const laneText = parsed.model ? `m:${parsed.model} ${parsed.task}` : parsed.task;
        if (!laneText.trim()) {
            const composed = await (0, compose_1.composeParallel)(token, cwd);
            if (!composed) {
                response.markdown("No lanes composed. `/parallel` alone opens the composer; or type lanes separated by `|`, `;;` or a `---` line.");
                return { metadata: { kind: "idle" } };
            }
            const query = (0, compose_1.chatQuery)(composed);
            const inserted = await (0, compose_1.insertIntoChat)(query);
            response.markdown(`${inserted ? "Inserted into the chat input — press Enter to run" : "Copy this into the chat to run"} **${composed.length} lanes**:\n\n\`\`\`text\n${query}\n\`\`\``);
            return { metadata: { kind: "composed", composedLanes: (0, compose_1.composeLanes)(composed) } };
        }
        const fan = (0, context_1.splitModelsFanout)(laneText);
        if (fan && ((0, chat_boot_1.splitLanes)(fan.task).length > 1 || fan.models.length < 2 || !fan.task)) {
            response.markdown((0, chat_boot_1.splitLanes)(fan.task).length > 1
                ? "`models:` runs **one** task on each model, so it takes no `|`. For different tasks, put `m:<model>` in front of each lane:\n\n" +
                    "`@opencode /parallel m:tundra review auth | m:oasis read the logs`"
                : "Name at least two models and the task: `@opencode /parallel models:tundra,oasis review the auth flow`");
            return { metadata: { kind: "parallel" } };
        }
        const specsRaw = fan
            ? fan.models.map((ref) => ({ task: fan.task, ref }))
            : (0, chat_boot_1.splitLanes)(laneText).map((lane) => {
                const { model: ref, task: laneTask } = (0, context_1.splitModelPrefix)(lane);
                return { task: laneTask, ref };
            });
        if (specsRaw.length < 2) {
            response.markdown("Give me at least two lanes separated by `|`, `;;` or a `---` line (not inside backticks).\n\n" +
                "Example: `@opencode /parallel audit error handling | list unused deps | " +
                "review the auth flow`");
            return { metadata: { kind: "parallel", lanesMissing: true } };
        }
        const lanes = [];
        for (const { task: laneTask, ref } of specsRaw) {
            if (!ref) {
                lanes.push({ task: laneTask });
                continue;
            }
            const r = await resolveModel(ref);
            lanes.push("id" in r ? { task: laneTask, model: r.id } : { task: laneTask, error: (0, models_1.modelRefProblem)(ref, r) });
        }
        if (token.isCancellationRequested) {
            return { metadata: { kind: "parallel", lanes: lanes.length, cancelled: true } };
        }
        const write = settings.get("parallelAllowWrite", false);
        if (write) {
            response.markdown("> " + (0, followups_1.mark)("warn") + " `parallelAllowWrite` is on. Concurrent editing agents in one checkout can " +
                "overwrite each other — prefer the git-worktree scripts for parallel edits.\n");
        }
        const laneUrl = transport === "server" || attachDev ? await (0, core_1.untilStop)(warmServer(cwd), token) : undefined;
        const lanePlan = write ? undefined : await (0, core_1.untilStop)((0, agents_1.resolvePlanAgent)(cwd, laneUrl), token);
        if (token.isCancellationRequested) {
            return { metadata: { kind: "parallel", lanes: lanes.length, cancelled: true } };
        }
        const laneCtx = (0, context_1.buildChatContext)(request, cwd, { inline: turn.inline });
        (0, context_1.emitReferences)(response, laneCtx.uris);
        if (laneCtx.uris.length) {
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] context for ${lanes.length} lanes: ${laneCtx.uris.map((u) => (0, core_1.relTo)(cwd, u)).join(", ")}`);
        }
        const laneNote = (0, agents_1.planAgentNotice)(lanePlan, cwd);
        if (laneNote) {
            response.markdown(`> ${(0, followups_1.mark)("warn")} ${laneNote}\n\n`);
        }
        await (0, chat_boot_1.runParallelLanes)({
            response,
            token,
            cwd,
            executable,
            timeoutMs,
            model: settingPin,
            pure,
            lanes,
            write,
            devAgent,
            planAgent: lanePlan?.agent,
            attachUrl: laneUrl,
            preamble: laneCtx.preamble
        });
        return { metadata: { kind: "parallel", lanes: lanes.length } };
    }
    let inlineModel = parsed.model;
    if (inlineModel) {
        const ref = await resolveModel(inlineModel);
        if (!("id" in ref)) {
            response.markdown((0, models_1.modelRefProblem)(inlineModel, ref));
            return { metadata: { kind: "idle" } };
        }
        inlineModel = ref.id;
    }
    const pinned = inlineModel || settingPin;
    if (!task) {
        response.markdown("Describe the task after any `model:` / `dev:` prefix.");
        return { metadata: { kind: "idle" } };
    }
    const hasReferences = Boolean(turn.inline) || (request.references ?? []).length > 0;
    const firstMessage = !state.id;
    if (settings.get("clarifyVaguePrompts", true) &&
        firstMessage &&
        !hasReferences &&
        (0, prompt_1.isVaguePrompt)(task) &&
        !(0, prompt_1.insistedOn)(prompt)) {
        response.markdown(`\`${(0, core_1.truncate)(task, 40)}\` is too short for me to act on, so I have not spent a run on it.\n\n` +
            "**If you meant a connectivity check**, use `/ping` — it verifies the executable, " +
            "version, server, and model catalog without calling a model.\n\n" +
            "**If you meant a task**, say what to look at and what you want back, for example:\n" +
            "- `find every place we still branch on the legacy platform flag`\n" +
            "- `/dev add a regression test for the redirect loop`\n" +
            "- `explain how sessions are persisted in src/extension.ts`");
        (0, prompt_1.markClarifiedPrompt)(prompt);
        return { metadata: { kind: "clarify", agent: agentLabel, prompt } };
    }
    const agentKey = isBuild ? devAgent : (0, agents_1.planAgentSetting)();
    const handoffReturn = (0, session_1.takeHandoffReturn)(state.id, agentKey, Boolean(pinned));
    const model = pinned ?? handoffReturn;
    const chain = (0, session_1.handoffChain)(model, fallbackModels);
    const tPlan = (0, prompt_1.planTimeout)();
    timeoutMs = tPlan.timeoutMs;
    const idleTimeoutMs = tPlan.idleTimeoutMs;
    const continuing = Boolean(state.id);
    core_1.logChannel.appendLine(`\n===== ${(0, core_1.stamp)()} ${agentLabel} · ${continuing ? `session ${state.id}` : "new session"} · ` +
        `${(0, core_1.truncate)(task, 120)} =====`);
    if (model && !pinned) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] back to ${model}: the last turn handed off, and OpenCode keeps a session on its last model`);
    }
    const ctx = (0, context_1.buildChatContext)(request, cwd, { inline: turn.inline });
    const taskForModel = ctx.preamble ? `${task}${ctx.preamble}` : task;
    (0, context_1.emitReferences)(response, ctx.uris);
    if (ctx.uris.length) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] context: ${ctx.uris.map((u) => (0, core_1.relTo)(cwd, u)).join(", ")}`);
    }
    if ((0, core_1.isMultiRoot)()) {
        const why = {
            attachment: "from the file you attached",
            "active-editor": "from the active editor",
            remembered: "your last OpenCode folder here",
            "first-root": "first folder in the workspace",
            "only-root": ""
        }[choice.reason];
        response.markdown(`> ${(0, followups_1.mark)("folder")} \`${folder.name}\`${why ? ` — ${why}` : ""}\n\n`);
    }
    if (!continuing && (0, session_1.threadScopeActive)(context)) {
        const folderSession = (0, session_1.getActiveSession)(cwd).id;
        if (folderSession) {
            response.markdown(`> ${(0, followups_1.mark)("thread")} New chat — starting a fresh OpenCode session. The previous session ` +
                `\`${folderSession}\` is untouched and still open in its own chat.\n\n`);
        }
    }
    (0, core_1.setStatus)(`$(sync~spin) OpenCode · ${agentLabel}`, `Running the OpenCode ${agentLabel} agent${model ? ` (${model})` : ""}`);
    if (!useServer && attachDev) {
        response.progress("Connecting to the OpenCode server…");
    }
    const preRun = [];
    const timed = async (label, work) => {
        const t = Date.now();
        try {
            return await work();
        }
        finally {
            preRun.push(`${label} ${Date.now() - t}ms`);
        }
    };
    const attachUrl = !useServer && attachDev ? await (0, core_1.untilStop)(timed("server", () => warmServer(cwd)), token) : undefined;
    const beat = (0, chat_boot_1.startHeartbeat)(response, `${continuing ? "Continuing" : "Starting"} the OpenCode ${agentLabel} session` +
        (useServer ? " via server" : attachUrl ? " via server (attached)" : " via cli") +
        (model ? ` (${model})` : ""), timeoutMs, cwd);
    const streamStep = (step) => beat.step(step);
    let thinking = "";
    const streamReasoning = (text) => {
        thinking = (thinking + text).slice(-4000);
        beat.thought((0, chat_boot_1.thoughtLine)(thinking));
    };
    const toolQuietMs = Math.max(0, settings.get("toolQuietMs", 600000));
    const busyPolicy = settings.get("busySessionPolicy", "abort");
    const linker = (0, context_1.createFileLinker)(cwd);
    try {
        let sessionId = state.id;
        if (attachUrl && !sessionId && !token.isCancellationRequested) {
            try {
                sessionId = await timed("session", () => (0, runs_1.createServerSession)(attachUrl, cwd, task));
            }
            catch (error) {
                core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] could not pre-create a session, the run creates one: ${error}`);
            }
        }
        const guardBase = attachUrl ?? (useServer ? await (0, core_1.untilStop)(timed("server", () => warmServer(cwd)), token) : undefined);
        const planChoice = isBuild || (0, agents_1.planAgentSetting)() === "plan"
            ? undefined
            : await timed("agent", () => (0, core_1.untilStop)((0, agents_1.resolvePlanAgent)(cwd, guardBase), token));
        let agent = isBuild ? devAgent : planChoice?.agent ?? "plan";
        const agentNote = (0, agents_1.planAgentNotice)(planChoice, cwd);
        if (agentNote) {
            response.markdown(`> ${(0, followups_1.mark)("warn")} ${agentNote}\n\n`);
        }
        if (guardBase && sessionId && busyPolicy !== "queue" && !token.isCancellationRequested) {
            if (await timed("busy-check", () => (0, runs_1.sessionBusy)(guardBase, sessionId, cwd))) {
                beat.phase("Stopping an unfinished earlier run in this session");
                const stopped = await (0, runs_1.abortServerRun)(guardBase, sessionId, cwd, "busy before send");
                response.markdown(stopped
                    ? "> " + (0, followups_1.mark)("stop") + " This session was still busy with an earlier run nobody was watching, so I stopped it first — otherwise this message would have waited behind it. If turns stay slow, `/new` starts a clean session.\n\n"
                    : "> " + (0, followups_1.mark)("warn") + " This session is still busy with an earlier run and it did not stop. This message may wait behind it — `/new` starts a clean session.\n\n");
            }
        }
        let metrics;
        let answer = "";
        let streamed = false;
        let serverTransport = useServer;
        let sessionRestarted = false;
        let lastAttempt = 0;
        let firstModel;
        if (preRun.length) {
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] pre-run: ${preRun.join(" · ")}`);
        }
        if (token.isCancellationRequested) {
            await beat.stop(true);
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] stopped by the user before the run started`);
            (0, session_1.refreshStatus)(cwd);
            return { metadata: { kind, agent: agentLabel, sessionId, cwd, turns: state.turns, cancelled: true } };
        }
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
                timeoutMs,
                idleTimeoutMs,
                sessionId,
                attachUrl: serverTransport ? undefined : attachUrl,
                serverUrl: serverTransport && attempt === 0 ? guardBase : undefined,
                toolQuietMs,
                token,
                onStep: streamStep,
                onReasoning: streamReasoning,
                onText: (rawText) => {
                    const text = (0, format_1.scrubLeakedContext)(rawText);
                    if (!text || (!answer.trim() && ((0, format_1.isPromptEcho)(text, task) || (0, format_1.isPromptEcho)(text, attemptTask)))) {
                        return;
                    }
                    answer += text;
                    streamed = true;
                    beat.activity();
                    (0, context_1.emitAnswerParts)(response, linker.push(text));
                }
            };
            try {
                metrics = await (serverTransport ? runs_1.runOpenCodeServer : runs_1.runOpenCode)(runOpts);
            }
            catch (error) {
                if ((0, runs_1.isMissingSessionError)(error) && runOpts.sessionId && !token.isCancellationRequested) {
                    metrics = await (0, runs_1.restartAfterMissingSession)(runOpts, serverTransport, beat, response, cwd);
                    sessionRestarted = true;
                    answer = "";
                    streamed = false;
                }
                else if (!serverTransport || token.isCancellationRequested) {
                    throw error;
                }
                else {
                    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] server failed, falling back to CLI: ${error}`);
                    beat.phase("Server transport unavailable — retrying via cli");
                    serverTransport = false;
                    answer = "";
                    streamed = false;
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
                answer = "";
                streamed = false;
                metrics = await (0, runs_1.runOpenCode)(runOpts);
            }
            if (!sessionRestarted && (0, runs_1.isMissingSessionRun)(metrics) && runOpts.sessionId && !token.isCancellationRequested) {
                metrics = await (0, runs_1.restartAfterMissingSession)(runOpts, serverTransport, beat, response, cwd);
                sessionRestarted = true;
                answer = "";
                streamed = false;
            }
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
                lastModel: answeredBy
            });
        }
        const inputs = metrics?.tokens.input ?? 0;
        if (autoCompact && sessionId && turns > 0 && (turns % compactEvery === 0 || inputs > COMPACT_INPUT_TOKENS)) {
            void (0, runs_1.compactSession)(sessionId, cwd, answeredBy);
        }
        if (sessionId && metrics && !metrics.error && !metrics.timedOut && !metrics.cancelled) {
            (0, chat_boot_1.rememberFollowups)(sessionId, turns, (0, chat_boot_1.suggestFollowups)({ agent: agentLabel, answer: finalAnswer || answer, steps: metrics.steps }));
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
                timedOut: Boolean(metrics?.timedOut),
                cancelled: Boolean(metrics?.cancelled),
                error: metrics?.error
            }
        };
    }
    catch (error) {
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
}
async function warmServer(cwd) {
    try {
        return await (0, net_1.ensureServer)(cwd);
    }
    catch (error) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] server unavailable, dev runs cold: ${error}`);
        return undefined;
    }
}
//# sourceMappingURL=chat.js.map