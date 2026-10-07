"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleChat = handleChat;
const core_1 = require("./core");
const followups_1 = require("./followups");
const prompt_1 = require("./prompt");
const context_1 = require("./context");
const agents_1 = require("./agents");
const session_1 = require("./session");
const models_1 = require("./models");
const natural_1 = require("./natural");
const chat_boot_1 = require("./chat-boot");
const chat_commands_1 = require("./chat-commands");
const chat_worktree_1 = require("./chat-worktree");
const chat_parallel_1 = require("./chat-parallel");
const chat_turn_1 = require("./chat-turn");
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
    const mergeId = (0, followups_1.mergeRunId)(prompt);
    const mergeLanes = mergeId ? (0, chat_boot_1.recallLanes)(mergeId) : undefined;
    if (mergeId && !(0, chat_boot_1.answeredLanes)(mergeLanes ?? []).length) {
        response.markdown((0, followups_1.prompt)("LANES_GONE"));
        return { metadata: { kind: "idle" } };
    }
    const state = (0, session_1.resolveSessionState)(context, cwd);
    const declared = request.command?.toLowerCase() ?? "";
    const control = (0, chat_boot_1.controlCommand)(declared, (0, chat_boot_1.typedSlash)(prompt));
    (0, chat_boot_1.noteNextMessage)(state.id, state.turns, declared, request.prompt, Boolean(control));
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
    const autoLanes = (0, core_1.config)().get("autoParallel", "offer") === "auto" &&
        !declared &&
        !slashKind &&
        !parsed.explicitKind &&
        !turn.inline &&
        !mergeId
        ? (0, natural_1.laneItems)(parsed.task, chat_boot_1.splitLanes)
        : undefined;
    const kind = autoLanes ? "parallel" : (0, chat_boot_1.kindChoice)(declared, parsed.kind);
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
    const effortAsked = parsed.effort ?? (settings.get("effort", "").trim() || undefined);
    const effortStrict = Boolean(parsed.effort);
    const fallbackModels = settings
        .get("fallbackModels", [])
        .map((m) => m.trim())
        .filter(Boolean);
    const resolveModel = (0, models_1.modelResolver)(executable, cwd, (work) => (0, core_1.untilStop)(work, token));
    if (kind === "parallel") {
        return (0, chat_parallel_1.runParallelTurn)({ request, response, token, settings, cwd, inline: turn.inline, autoLanes, parsed, resolveModel, transport, attachDev, settingPin, executable, timeoutMs, pure, devAgent, effortAsked });
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
    const firstEffort = (0, models_1.effortFor)(model ?? state.lastModel, effortAsked, effortStrict);
    if (firstEffort.problem && effortStrict) {
        response.markdown(firstEffort.problem);
        return { metadata: { kind: "idle" } };
    }
    if (firstEffort.problem) {
        response.markdown(`> ${(0, followups_1.mark)("warn")} ${firstEffort.problem}\n\n`);
    }
    else if (firstEffort.variant && effortStrict) {
        response.markdown(`> ${(0, followups_1.mark)("thought")} effort \`${firstEffort.variant}\`\n\n`);
    }
    const variantFor = (attempt) => attempt === 0 ? firstEffort.variant : (0, models_1.effortFor)(chain[attempt], effortAsked, false).variant;
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
    const taskForModel = `${task}${mergeLanes ? (0, chat_boot_1.laneMergeContext)(mergeLanes) : ""}${ctx.preamble}`;
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
    return (0, chat_turn_1.runTurn)({
        response, token, settings, state, cwd, kind, agentLabel, isBuild, devAgent, task, taskForModel, replay,
        executable, pure, useServer, attachDev, timeoutMs, idleTimeoutMs, model, settingPin, agentKey, chain, variantFor, continuing
    });
}
//# sourceMappingURL=chat.js.map