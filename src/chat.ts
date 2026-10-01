import * as vscode from "vscode";
import {
    config,
    isMultiRoot,
    logChannel,
    relTo,
    rememberFolder,
    resolveFolder,
    secs,
    setStatus,
    stamp,
    truncate,
    untilStop
} from "./core";
import { mark, prompt as promptText } from "./followups";
import { RunMetrics, RunOptions, StepRecord, finalizeStepStatuses, toolOutputBytes } from "./metrics";
import { composeVisibleAnswer, isPromptEcho, metricsLogLine, scrubLeakedContext } from "./format";
import { insistedOn, isVaguePrompt, markClarifiedPrompt, planTimeout } from "./prompt";
import { buildChatContext, emitReferences, parseChatPrompt, splitModelPrefix, splitModelsFanout, stepUris } from "./context";
import { ensureServer } from "./net";
import { planAgentNotice, planAgentSetting, resolvePlanAgent } from "./agents";
import {
    getActiveSession,
    handoffChain,
    liveSessions,
    notifyIfSlow,
    refreshStatus,
    rememberHandoffReturn,
    resolveSessionState,
    setActiveSession,
    takeHandoffReturn,
    threadScopeActive
} from "./session";
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
    sessionBusy
} from "./runs";
import { modelRefProblem, modelResolver } from "./models";
import { FlowNode, FlowStatus, FlowTrace, flowAdd, newTrace, rememberFlow } from "./flow";
import {
    LaneSpec,
    controlCommand,
    isKindCommand,
    kindChoice,
    rememberFollowups,
    resolveAlias,
    runParallelLanes,
    splitLanes,
    startHeartbeat,
    traceSteps,
    chatStream,
    suggestFollowups,
    thoughtLine,
    typedSlash
} from "./chat-boot";
import { handleControlCommand } from "./chat-commands";
import { chatQuery, composeLanes, composeParallel, insertIntoChat } from "./compose";
import { handleWorktree } from "./chat-worktree";

export interface TurnOrigin {
    inline?: boolean;
}

// Every turn that reached a task is traced for /flow (metadata.flow = its id);
// control commands are not.
export async function handleChat(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    rawResponse: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    turn: TurnOrigin = {}
): Promise<vscode.ChatResult> {
    const flow = newTrace();
    const result = await chatTurn(request, context, rawResponse, token, turn, flow);
    if (!flow.nodes.length && !flow.lanes.length) {
        return result;
    }
    const meta = (result.metadata ?? {}) as Record<string, unknown>;
    flow.end ??= endNode(meta.cancelled ? "stopped" : meta.error ? `error: ${meta.error}` : String(meta.kind ?? "done"),
        meta.cancelled ? "warn" : meta.error ? "fail" : undefined);
    rememberFlow(flow);
    return { ...result, metadata: { ...meta, flow: flow.id } };
}

const endNode = (key: string, status?: FlowStatus): FlowNode => ({ kind: "end", key, parts: [], count: 1, status });

const runEnd = (m: RunMetrics, model?: string): FlowNode =>
    m.cancelled
        ? endNode(`stopped by you after ${secs(m.totalMs)}`, "warn")
        : m.timedOut
            ? endNode(`timed out after ${secs(m.totalMs)}${m.stuckTool ? ` in ${m.stuckTool}` : ""}`, "fail")
            : m.error
                ? endNode(`error: ${m.error}`, "fail")
                : endNode(
                    `answered in ${secs(m.totalMs)}` +
                    (model ? ` by ${model}` : "") +
                    (m.tokens.input || m.tokens.output ? ` · ${m.tokens.input}↓/${m.tokens.output}↑` : "") +
                    (m.cost > 0 ? ` · $${m.cost.toFixed(4)}` : "")
                );

async function chatTurn(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    rawResponse: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    turn: TurnOrigin,
    flow: FlowTrace
): Promise<vscode.ChatResult> {
    const note = (key: string, part = "", status?: FlowStatus): void => flowAdd(flow.nodes, "info", key, part, status);
    // Nothing is written after Stop (the host drops it, then throws); marks become pills.
    const response = chatStream(rawResponse, token);
    const choice = resolveFolder(request);
    if (!choice) {
        response.markdown("Open a workspace before delegating a task to OpenCode.");
        return { metadata: { kind: "error" } };
    }
    const folder = choice.folder;
    const cwd = folder.uri.fsPath;
    rememberFolder(cwd);

    // `/d …` → `/dev …` before anything reads the prompt.
    const aliased = resolveAlias(request.prompt.trim());
    if (aliased.problem) {
        response.markdown(aliased.problem);
        return { metadata: { kind: "idle" } };
    }
    const prompt = aliased.prompt;
    // Scoped to this chat thread, not to the folder — see threadSession().
    const state = resolveSessionState(context, cwd);
    // A thread restored from a previous window: hold its session out of retention now.
    if (state.id) {
        liveSessions.mark(cwd, state.id);
    }

    // A registered command arrives as `request.command`, stripped from the prompt;
    // a typed `/word` (older hosts, unregistered commands) arrives in the text.
    const declared = (request as { command?: string }).command?.toLowerCase() ?? "";
    const control = controlCommand(declared, typedSlash(prompt));

    // Control commands (./chat-commands): model-free, and never mistaken for a task.
    const answered = await handleControlCommand({
        control,
        args: typedSlash(prompt) ? prompt.replace(/^\/\S+\s*/, "") : prompt,
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

    // `/worktree <task>`: the opt-in isolated run; everything else shares the checkout.
    const typedWorktree = /^\/worktree\b\s*/i.test(prompt);
    if (declared === "worktree" || typedWorktree) {
        return handleWorktree({ task: prompt.replace(/^\/worktree\b\s*/i, "").trim(), cwd, response, token });
    }

    if (!prompt && !isKindCommand(declared)) {
        response.markdown(
            "Describe the task and I'll keep it in one ongoing OpenCode plan session. " +
            "Use `/dev` to edit, `model:provider/id` to pin a model, " +
            "or `/new`, `/session`, `/help`."
        );
        return { metadata: { kind: "idle" } };
    }

    // A typed `/dev x` becomes `dev: x`, so typed, declared and inline forms match.
    const slashKind = prompt.match(/^\/(plan|dev|parallel|par)\b\s*/i)?.[1]?.toLowerCase() ?? "";
    const normalizedPrompt = slashKind
        ? prompt.replace(/^\/\S+\s*/, `${slashKind === "par" ? "parallel" : slashKind}: `)
        : prompt;
    const parsed = parseChatPrompt(normalizedPrompt);
    // An explicit slash command wins over an inline `dev:` prefix.
    const kind = kindChoice(declared, parsed.kind);
    const isBuild = kind === "dev";
    // The editing agent is always named: without --agent OpenCode runs the
    // config's `default_agent`, which may be plan (measured, 1.18.32).
    const devAgent = config().get<string>("devAgent", "build").trim() || "build";
    const agentLabel = isBuild ? "dev" : "plan";
    const task = parsed.task;
    // `request.prompt` lost its declared /command: a replay puts the kind back.
    const replay = isKindCommand(declared) && !slashKind ? `/${declared} ${prompt}`.trim() : prompt;

    const settings = config();
    const executable = settings.get<string>("executable", "opencode");
    // Pinned: `model:` (this turn), else the setting (every turn). Unpinned,
    // OpenCode keeps a session on the model it was last sent.
    const settingPin = settings.get<string>("model", "").trim() || undefined;
    let timeoutMs = settings.get<number>("timeoutMs", 0);
    const pure = settings.get<boolean>("pure", false);
    const transport = settings.get<string>("transport", "auto");
    const useServer =
        transport === "server" || (transport === "auto" && !isBuild);
    // dev keeps the CLI for `--auto`, attached to the warm server (cold boots: 48–69s).
    const attachDev = transport === "auto" && settings.get<boolean>("attachDevToServer", true);
    const autoCompact = settings.get<boolean>("autoCompact", true);
    // Size triggers a summarize too, not only the turn count (9.6k → 199k seen in 8 turns).
    const COMPACT_INPUT_TOKENS = 60000;
    const compactEvery = settings.get<number>("autoCompactEveryTurns", 8);
    const showThoughts = settings.get<boolean>("showThoughtProcess", true);
    // Only ask OpenCode for thinking blocks when something will consume them.
    const wantThinking = showThoughts;
    const fallbackModels = settings
        .get<string[]>("fallbackModels", [])
        .map((m) => m.trim())
        .filter(Boolean);

    flow.title = kind === "parallel" ? "parallel" : `${agentLabel} · ${task}`;
    note("folder", folder.name + (isMultiRoot() ? ` (${choice.reason})` : ""));
    const resolveModel = modelResolver(executable, cwd, (work) => untilStop(work, token));

    if (kind === "parallel") {
        // `models:a,b,c <task>`: one task per model. Otherwise each lane may
        // carry `m:<model>`; a leading `m:` belongs to lane 1. No lane cap.
        const laneText = parsed.model ? `m:${parsed.model} ${parsed.task}` : parsed.task;
        // A bare `/parallel`: compose the lanes step by step, then put the
        // command in the chat input — nothing runs until it is sent.
        if (!laneText.trim()) {
            const composed = await composeParallel(token, cwd);
            if (!composed) {
                response.markdown("No lanes composed. `/parallel` alone opens the composer; or type lanes separated by `|`, `;;` or a `---` line.");
                return { metadata: { kind: "idle" } };
            }
            const query = chatQuery(composed);
            const inserted = await insertIntoChat(query);
            response.markdown(
                `${inserted ? "Inserted into the chat input — press Enter to run" : "Copy this into the chat to run"} **${composed.length} lanes**:\n\n\`\`\`text\n${query}\n\`\`\``
            );
            return { metadata: { kind: "composed", lanes: composeLanes(composed) } };
        }
        const fan = splitModelsFanout(laneText);
        if (fan && (splitLanes(fan.task).length > 1 || fan.models.length < 2 || !fan.task)) {
            response.markdown(
                splitLanes(fan.task).length > 1
                    ? "`models:` runs **one** task on each model, so it takes no `|`. For different tasks, put `m:<model>` in front of each lane:\n\n" +
                    "`@opencode /parallel m:tundra review auth | m:oasis read the logs`"
                    : "Name at least two models and the task: `@opencode /parallel models:tundra,oasis review the auth flow`"
            );
            return { metadata: { kind: "parallel" } };
        }
        const specsRaw = fan
            ? fan.models.map((ref) => ({ task: fan.task, ref }))
            : splitLanes(laneText).map((lane) => {
                const { model: ref, task: laneTask } = splitModelPrefix(lane);
                return { task: laneTask, ref };
            });
        if (specsRaw.length < 2) {
            response.markdown(
                "Give me at least two lanes separated by `|`, `;;` or a `---` line (not inside backticks).\n\n" +
                "Example: `@opencode /parallel audit error handling | list unused deps | " +
                "review the auth flow`"
            );
            return { metadata: { kind: "parallel", lanesMissing: true } };
        }
        const lanes: LaneSpec[] = [];
        for (const { task: laneTask, ref } of specsRaw) {
            if (!ref) {
                lanes.push({ task: laneTask });
                continue;
            }
            const r = await resolveModel(ref);
            lanes.push("id" in r ? { task: laneTask, model: r.id } : { task: laneTask, error: modelRefProblem(ref, r), ref });
        }
        if (token.isCancellationRequested) {
            return { metadata: { kind: "parallel", lanes: lanes.length, cancelled: true } };
        }
        const write = settings.get<boolean>("parallelAllowWrite", false);
        if (write) {
            response.markdown(
                "> " + mark("warn") + " `parallelAllowWrite` is on. Concurrent editing agents in one checkout can " +
                "overwrite each other — prefer the git-worktree scripts for parallel edits.\n"
            );
        }
        const laneUrl = attachDev ? await warmServer(cwd) : undefined;
        // Read-only lanes run as `planAgent` too, checked once for all.
        const lanePlan = write ? undefined : await untilStop(resolvePlanAgent(cwd, laneUrl), token);
        if (token.isCancellationRequested) {
            return { metadata: { kind: "parallel", lanes: lanes.length, cancelled: true } };
        }
        const laneNote = planAgentNotice(lanePlan, cwd);
        if (laneNote) {
            response.markdown(`> ${mark("warn")} ${laneNote}\n\n`);
        }
        note("agent", write ? devAgent : lanePlan?.agent ?? "plan", laneNote ? "warn" : undefined);
        note("transport", laneUrl ? "cli attached to server" : "cli");
        await runParallelLanes({
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
            trace: flow
        });
        return { metadata: { kind: "parallel", lanes: lanes.length } };
    }

    // `model:tundra`: one catalog match, else refused before anything runs.
    let inlineModel = parsed.model;
    if (inlineModel) {
        const ref = await resolveModel(inlineModel);
        if (!("id" in ref)) {
            response.markdown(modelRefProblem(inlineModel, ref));
            return { metadata: { kind: "idle" } };
        }
        inlineModel = ref.id;
    }
    const pinned = inlineModel || settingPin;

    if (!task) {
        response.markdown("Describe the task after any `model:` / `dev:` prefix.");
        return { metadata: { kind: "idle" } };
    }

    // A bare one-word FIRST message costs a run to learn nothing: ask first.
    // An attachment, a selection or an inline turn is the missing context, and
    // mid-conversation `yes` / `go` answer the agent.
    const hasReferences =
        Boolean(turn.inline) || ((request as { references?: readonly unknown[] }).references ?? []).length > 0;
    const firstMessage = !state.id;
    if (
        settings.get<boolean>("clarifyVaguePrompts", true) &&
        firstMessage &&
        !hasReferences &&
        isVaguePrompt(task) &&
        !insistedOn(prompt)
    ) {
        response.markdown(
            `\`${truncate(task, 40)}\` is too short for me to act on, so I have not spent a run on it.\n\n` +
            "**If you meant a connectivity check**, use `/ping` — it verifies the executable, " +
            "version, server, and model catalog without calling a model.\n\n" +
            "**If you meant a task**, say what to look at and what you want back, for example:\n" +
            "- `find every place we still branch on the legacy platform flag`\n" +
            "- `/dev add a regression test for the redirect loop`\n" +
            "- `explain how sessions are persisted in src/extension.ts`"
        );
        markClarifiedPrompt(prompt);
        note("vague prompt", "asked for detail, no run", "warn");
        // "Run it anyway" is a chip (followupsFor), never also a button.
        return { metadata: { kind: "clarify", agent: agentLabel, prompt } };
    }

    // After an unpinned handoff the session goes back to its earlier model once
    // (OpenCode would keep the fallback). Keyed by agent; a named model clears it.
    const agentKey = isBuild ? devAgent : planAgentSetting();
    const handoffReturn = takeHandoffReturn(state.id, agentKey, Boolean(pinned));
    const model = pinned ?? handoffReturn;
    const chain = handoffChain(model, fallbackModels);
    note("model", model ? `${model} (${inlineModel ? "model:" : settingPin ? "setting" : "back after a handoff"})` : "OpenCode default");

    // timeoutMs is a verbatim fixed cap; idleTimeoutMs is what stops a hung run.
    const tPlan = planTimeout(agentLabel, kind);
    timeoutMs = tPlan.timeoutMs;
    const idleTimeoutMs = tPlan.idleTimeoutMs;

    const continuing = Boolean(state.id);
    note("session", continuing ? `${state.id} · turn ${state.turns + 1}` : "new");
    logChannel.appendLine(
        `\n===== ${stamp()} ${agentLabel} · ${continuing ? `session ${state.id}` : "new session"} · ` +
        `${truncate(task, 120)} =====`
    );
    if (model && !pinned) {
        logChannel.appendLine(`[${stamp()}] back to ${model}: the last turn handed off, and OpenCode keeps a session on its last model`);
    }

    // Attachments (and, opt-in, the selection) go into the prompt and back as references.
    const ctx = buildChatContext(request, cwd, { inline: turn.inline });
    const taskForModel = ctx.preamble ? `${task}${ctx.preamble}` : task;
    emitReferences(response, ctx.uris);
    if (ctx.uris.length) {
        logChannel.appendLine(
            `[${stamp()}] context: ${ctx.uris.map((u) => relTo(cwd, u)).join(", ")}`
        );
    }

    if (isMultiRoot()) {
        const why = {
            attachment: "from the file you attached",
            "active-editor": "from the active editor",
            remembered: "your last OpenCode folder here",
            "first-root": "first folder in the workspace",
            "only-root": ""
        }[choice.reason];
        response.markdown(`> ${mark("folder")} \`${folder.name}\`${why ? ` — ${why}` : ""}\n\n`);
    }

    // A new chat gets a new session; say so when the folder holds another one.
    if (!continuing && threadScopeActive(context)) {
        const folderSession = getActiveSession(cwd).id;
        if (folderSession) {
            response.markdown(
                `> ${mark("thread")} New chat — starting a fresh OpenCode session. The previous session ` +
                `\`${folderSession}\` is untouched and still open in its own chat.\n\n`
            );
        }
    }

    setStatus(
        `$(sync~spin) OpenCode · ${agentLabel}`,
        `Running the OpenCode ${agentLabel} agent${model ? ` (${model})` : ""}`
    );

    // A plain progress line on purpose: the host hides it once the next part follows.
    if (!useServer && attachDev) {
        response.progress("Connecting to the OpenCode server…");
    }
    // What happens before the model sees the task, logged as `pre-run:`.
    const preRun: string[] = [];
    const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
        const t = Date.now();
        try {
            return await work();
        } finally {
            preRun.push(`${label} ${Date.now() - t}ms`);
        }
    };
    const attachUrl = !useServer && attachDev ? await timed("server", () => warmServer(cwd)) : undefined;

    const beat = startHeartbeat(
        response,
        `${continuing ? "Continuing" : "Starting"} the OpenCode ${agentLabel} session` +
        (useServer ? " via server" : attachUrl ? " via server (attached)" : " via cli") +
        (model ? ` (${model})` : ""),
        timeoutMs,
        cwd
    );

    const streamStep = (step: StepRecord): void => beat.step(step);
    // The line shows where the reasoning has got to, not how it started.
    let thinking = "";
    const streamReasoning = (text: string): void => {
        thinking = (thinking + text).slice(-4000);
        beat.thought(thoughtLine(thinking));
    };

    const toolQuietMs = Math.max(0, settings.get<number>("toolQuietMs", 600000));
    const busyPolicy = settings.get<string>("busySessionPolicy", "abort");

    try {
        let sessionId: string | undefined = state.id;

        // An attached run needs its session id first, for the SSE liveness feed.
        if (attachUrl && !sessionId && !token.isCancellationRequested) {
            try {
                sessionId = await timed("session", () => createServerSession(attachUrl, cwd, task));
            } catch (error) {
                logChannel.appendLine(`[${stamp()}] could not pre-create a session, the run creates one: ${error}`);
            }
        }

        // Never queue silently behind a run nobody watches (busySessionPolicy).
        const guardBase = attachUrl ?? (useServer ? await timed("server", () => warmServer(cwd)) : undefined);
        // planAgent only once OpenCode lists it: the CLI runs an unknown name
        // as BUILD (REFS "Read-only turns"). Raced against Stop.
        const planChoice = isBuild || planAgentSetting() === "plan"
            ? undefined
            : await timed("agent", () => untilStop(resolvePlanAgent(cwd, guardBase), token));
        let agent = isBuild ? devAgent : planChoice?.agent ?? "plan";
        const agentNote = planAgentNotice(planChoice, cwd);
        if (agentNote) {
            response.markdown(`> ${mark("warn")} ${agentNote}\n\n`);
        }
        note("transport", useServer ? "server" : attachUrl ? "cli attached to server" : "cli");
        note("agent", agent, agentNote ? "warn" : undefined);
        if (guardBase && sessionId && busyPolicy !== "queue" && !token.isCancellationRequested) {
            if (await timed("busy-check", () => sessionBusy(guardBase, sessionId as string, cwd))) {
                beat.phase("Stopping an unfinished earlier run in this session");
                const stopped = await abortServerRun(guardBase, sessionId, cwd, "busy before send");
                note("busy session", stopped ? "stopped the earlier run" : "still busy", "warn");
                response.markdown(
                    stopped
                        ? "> " + mark("stop") + " This session was still busy with an earlier run nobody was watching, so I stopped it first — otherwise this message would have waited behind it. If turns stay slow, `/new` starts a clean session.\n\n"
                        : "> " + mark("warn") + " This session is still busy with an earlier run and it did not stop. This message may wait behind it — `/new` starts a clean session.\n\n"
                );
            }
        }
        let metrics: RunMetrics | undefined;
        let answer = "";
        let streamed = false;
        let serverTransport = useServer;
        // Recover from a missing session once per turn, or it could loop.
        let sessionRestarted = false;
        // Which attempt answered, and the first attempt's model (the way back).
        let lastAttempt = 0;
        let firstModel: string | undefined;

        if (preRun.length) {
            logChannel.appendLine(`[${stamp()}] pre-run: ${preRun.join(" · ")}`);
            note("pre-run", preRun.join(" · "));
        }
        // Stop pressed while the server was starting: nothing ran, nothing to abort.
        if (token.isCancellationRequested) {
            await beat.stop(true);
            logChannel.appendLine(`[${stamp()}] stopped by the user before the run started`);
            flow.end = endNode("stopped before the run", "warn");
            refreshStatus(cwd);
            return { metadata: { kind, agent: agentLabel, sessionId, cwd, turns: state.turns, cancelled: true } };
        }

        for (let attempt = 0; attempt < chain.length; attempt++) {
            const attemptModel = chain[attempt];
            const handingOff = attempt > 0;
            if (handingOff) {
                const label = attemptModel ?? "OpenCode default";
                beat.phase(`Timed out — handing off to ${label}`);
                flowAdd(flow.nodes, "handoff", "handoff", label, "warn");
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
                onText: (rawText) => {
                    const text = scrubLeakedContext(rawText);
                    if (!text || (!answer.trim() && (isPromptEcho(text, task) || isPromptEcho(text, attemptTask)))) {
                        return;
                    }
                    answer += text;
                    streamed = true;
                    beat.activity();
                    response.markdown(text);
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
                    note("session missing", "restarted", "warn");
                    answer = "";
                    streamed = false;
                } else if (!serverTransport || token.isCancellationRequested) {
                    throw error;
                } else {
                    // The managed server failed: the CLI takes this and later attempts.
                    logChannel.appendLine(`[${stamp()}] server failed, falling back to CLI: ${error}`);
                    beat.phase("Server transport unavailable — retrying via cli");
                    note("server failed", "cli took over", "warn");
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
                note("attach failed", "ran cold", "warn");
                runOpts.attachUrl = undefined;
                answer = "";
                streamed = false;
                metrics = await runOpenCode(runOpts);
            }
            // The CLI reports a dead session by its exit, not by throwing.
            if (!sessionRestarted && isMissingSessionRun(metrics) && runOpts.sessionId && !token.isCancellationRequested) {
                metrics = await restartAfterMissingSession(runOpts, serverTransport, beat, response, cwd);
                sessionRestarted = true;
                note("session missing", "restarted", "warn");
                answer = "";
                streamed = false;
            }
            sessionId = metrics.sessionId ?? sessionId;
            traceSteps(flow.nodes, metrics.steps, cwd);
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
                response.markdown(finalAnswer);
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
        if (metrics) {
            flow.end = runEnd(metrics, answeredBy);
        }
        if (lastAttempt > 0 && !settingPin && firstModel && sessionId) {
            rememberHandoffReturn(sessionId, firstModel, agentKey);
            logChannel.appendLine(`[${stamp()}] handed off to ${answeredBy ?? "a fallback"}; the next ${agentLabel} turn goes back to ${firstModel}`);
        }

        let turns = baseline.turns;
        if (sessionId) {
            turns += 1;
            liveSessions.mark(cwd, sessionId);
            await setActiveSession(cwd, {
                id: sessionId,
                turns,
                toolOutputBytes: sessionBytes,
                tokensIn: baseline.tokensIn + (metrics?.tokens.input ?? 0),
                tokensOut: baseline.tokensOut + (metrics?.tokens.output ?? 0),
                cost: baseline.cost + (metrics?.cost ?? 0),
                lastAgent: agentLabel,
                lastModel: answeredBy
            });
        }

        // Autocompact in the background: awaiting it held a finished answer for 30s.
        const inputs = metrics?.tokens.input ?? 0;
        if (autoCompact && sessionId && turns > 0 && (turns % compactEvery === 0 || inputs > COMPACT_INPUT_TOKENS)) {
            void compactSession(sessionId, cwd, answeredBy);
        }
        if (sessionId && metrics && !metrics.error && !metrics.timedOut && !metrics.cancelled) {
            rememberFollowups(
                sessionId,
                turns,
                suggestFollowups({ agent: agentLabel, answer: finalAnswer || answer, steps: metrics.steps })
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
                timedOut: Boolean(metrics?.timedOut),
                cancelled: Boolean(metrics?.cancelled),
                error: metrics?.error
                // Keep this small: history replays it on every later turn, forever.
            }
        };
    } catch (error) {
        await beat.stop(token.isCancellationRequested);
        if (token.isCancellationRequested) {
            // A run torn down by Stop is not a failed run.
            logChannel.appendLine(`[${stamp()}] stopped by the user: ${error}`);
            flow.end = endNode("stopped", "warn");
            refreshStatus(cwd);
            return { metadata: { kind, agent: agentLabel, sessionId: state.id, cwd, turns: state.turns, cancelled: true } };
        }
        setStatus("$(warning) OpenCode", "The last OpenCode run failed", true);
        const err = error as NodeJS.ErrnoException;
        flow.end = endNode(`failed to start: ${err?.message ?? error}`, "fail");
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
}
// Start or adopt the managed `opencode serve` for an attached CLI run. Never
// throws: a server that cannot start just means this turn runs cold.
async function warmServer(cwd: string): Promise<string | undefined> {
    try {
        return await ensureServer(cwd);
    } catch (error) {
        logChannel.appendLine(`[${stamp()}] server unavailable, dev runs cold: ${error}`);
        return undefined;
    }
}
