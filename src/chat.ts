import * as vscode from "vscode";
import {
    config,
    isMultiRoot,
    logChannel,
    relTo,
    rememberFolder,
    resolveFolder,
    setStatus,
    stamp,
    truncate,
    untilStop
} from "./core";
import { mark, mergeRunId, prompt as promptText } from "./followups";
import { insistedOn, isVaguePrompt, markClarifiedPrompt, planTimeout } from "./prompt";
import { buildChatContext, emitReferences, parseChatPrompt } from "./context";
import { planAgentSetting } from "./agents";
import {
    getActiveSession,
    handoffChain,
    resolveSessionState,
    takeHandoffReturn,
    threadScopeActive
} from "./session";
import { effortFor, modelRefProblem, modelResolver } from "./models";
import { laneItems } from "./natural";
import {
    answeredLanes,
    controlCommand,
    isKindCommand,
    kindChoice,
    laneMergeContext,
    noteNextMessage,
    recallLanes,
    resolveAlias,
    retiredCommand,
    splitLanes,
    chatStream,
    typedSlash
} from "./chat-boot";
import { handleControlCommand } from "./chat-commands";
import { handleWorktree } from "./chat-worktree";
import { runParallelTurn } from "./chat-parallel";
import { runTurn } from "./chat-turn";

export interface TurnOrigin {
    inline?: boolean;
}

export async function handleChat(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    rawResponse: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    turn: TurnOrigin = {}
): Promise<vscode.ChatResult> {
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
    const retired = retiredCommand(prompt);
    if (retired) {
        response.markdown(retired);
        return { metadata: { kind: "idle" } };
    }
    // A Merge-lanes chip sends the run id, never the answers: they live in this
    // window's memory only. After a reload there is nothing to merge, and the
    // turn must cost nothing rather than ask the model to merge thin air.
    const mergeId = mergeRunId(prompt);
    const mergeLanes = mergeId ? recallLanes(mergeId) : undefined;
    if (mergeId && !answeredLanes(mergeLanes ?? []).length) {
        response.markdown(promptText("LANES_GONE"));
        return { metadata: { kind: "idle" } };
    }
    // Scoped to this chat thread, not to the folder — see threadSession().
    const state = resolveSessionState(context, cwd);

    // A registered command arrives as `request.command`, stripped from the prompt;
    // a typed `/word` (older hosts, unregistered commands) arrives in the text.
    const declared = (request as { command?: string }).command?.toLowerCase() ?? "";
    const control = controlCommand(declared, typedSlash(prompt));
    // The chip backoff reads this message against the last turn's chips.
    noteNextMessage(state.id, state.turns, declared, request.prompt, Boolean(control));

    // Control commands (./chat-commands): model-free, and never mistaken for a task.
    const answered = await handleControlCommand({
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
    // `autoParallel: auto`: a plain prompt that is itself a list of 2-5
    // read-only steps, each naming a file or call, runs as lanes — the same
    // rule as the "Run N as lanes" chip. Any typed kind (`plan:`, `/plan`,
    // `/dev`), an inline turn or a merge keeps the single turn. claim:auto-parallel
    const autoLanes =
        config().get<string>("autoParallel", "offer") === "auto" &&
        !declared &&
        !slashKind &&
        !parsed.explicitKind &&
        !turn.inline &&
        !mergeId
            ? laneItems(parsed.task, splitLanes)
            : undefined;
    // An explicit slash command wins over an inline `dev:` prefix.
    const kind = autoLanes ? "parallel" : kindChoice(declared, parsed.kind);
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
    // `effort:` for this turn, else the setting. Inline is strict: a level the
    // model is known to lack refuses the turn; the setting is dropped with a note.
    const effortAsked = parsed.effort ?? (settings.get<string>("effort", "").trim() || undefined);
    const effortStrict = Boolean(parsed.effort);
    const fallbackModels = settings
        .get<string[]>("fallbackModels", [])
        .map((m) => m.trim())
        .filter(Boolean);

    const resolveModel = modelResolver(executable, cwd, (work) => untilStop(work, token));

    if (kind === "parallel") {
        return runParallelTurn({ request, response, token, settings, cwd, inline: turn.inline, autoLanes, parsed, resolveModel, transport, attachDev, settingPin, executable, timeoutMs, pure, devAgent, effortAsked });
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
        // "Run it anyway" is a chip (followupsFor), never also a button.
        return { metadata: { kind: "clarify", agent: agentLabel, prompt } };
    }

    // After an unpinned handoff the session goes back to its earlier model once
    // (OpenCode would keep the fallback). Keyed by agent; a named model clears it.
    const agentKey = isBuild ? devAgent : planAgentSetting();
    const handoffReturn = takeHandoffReturn(state.id, agentKey, Boolean(pinned));
    const model = pinned ?? handoffReturn;
    const chain = handoffChain(model, fallbackModels);

    // Unpinned, the session's last model is the best guess at who answers.
    const firstEffort = effortFor(model ?? state.lastModel, effortAsked, effortStrict);
    if (firstEffort.problem && effortStrict) {
        response.markdown(firstEffort.problem);
        return { metadata: { kind: "idle" } };
    }
    if (firstEffort.problem) {
        response.markdown(`> ${mark("warn")} ${firstEffort.problem}\n\n`);
    } else if (firstEffort.variant && effortStrict) {
        response.markdown(`> ${mark("thought")} effort \`${firstEffort.variant}\`\n\n`);
    }
    // A fallback model gets the level only if it has it (or is not described).
    const variantFor = (attempt: number): string | undefined =>
        attempt === 0 ? firstEffort.variant : effortFor(chain[attempt], effortAsked, false).variant;

    // timeoutMs is an optional hard cap (at least 1s); idleTimeoutMs is what stops a hung run.
    const tPlan = planTimeout();
    timeoutMs = tPlan.timeoutMs;
    const idleTimeoutMs = tPlan.idleTimeoutMs;

    const continuing = Boolean(state.id);
    logChannel.appendLine(
        `\n===== ${stamp()} ${agentLabel} · ${continuing ? `session ${state.id}` : "new session"} · ` +
        `${truncate(task, 120)} =====`
    );
    if (model && !pinned) {
        logChannel.appendLine(`[${stamp()}] back to ${model}: the last turn handed off, and OpenCode keeps a session on its last model`);
    }

    // Attachments (and, opt-in, the selection) go into the prompt and back as references.
    const ctx = buildChatContext(request, cwd, { inline: turn.inline });
    // A merge turn carries the lanes it names; they are context, like an attachment.
    const taskForModel = `${task}${mergeLanes ? laneMergeContext(mergeLanes) : ""}${ctx.preamble}`;
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

    return runTurn({
        response, token, settings, state, cwd, kind, agentLabel, isBuild, devAgent, task, taskForModel, replay,
        executable, pure, useServer, attachDev, timeoutMs, idleTimeoutMs, model, settingPin, agentKey, chain, variantFor, continuing
    });
}
