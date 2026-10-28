"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleWorktree = handleWorktree;
const path = __importStar(require("node:path"));
const core_1 = require("./core");
const followups_1 = require("./followups");
const net_1 = require("./net");
const runs_1 = require("./runs");
const prompt_1 = require("./prompt");
const format_1 = require("./format");
const chat_boot_1 = require("./chat-boot");
const context_1 = require("./context");
const models_1 = require("./models");
const session_1 = require("./session");
const worktree_1 = require("./worktree");
const worktreeMeta = (cwd, wt, sessionId) => ({
    kind: "worktree",
    cwd,
    worktree: wt.path,
    branch: wt.branch,
    worktreeRoot: wt.root,
    worktreeBase: wt.baseSha,
    worktreeBaseRef: wt.baseRef,
    ...(sessionId ? { worktreeSession: sessionId } : {})
});
const SUMMARY_WAIT_MS = 60000;
async function handleWorktree(p) {
    const { text, request, cwd, response, token } = p;
    const parsed = (0, context_1.parseChatPrompt)(text);
    const task = parsed.task;
    if (!task) {
        response.markdown("Give the task after `/worktree`, e.g. `/worktree add a regression test for the redirect loop`.\n\n" +
            "It runs the editing agent in its own git worktree next to this repo, so your checkout is not touched; follow-ups in this chat continue it.");
        return { metadata: { kind: "worktree" } };
    }
    const settings = (0, core_1.config)();
    const executable = settings.get("executable", "opencode");
    const refused = (0, net_1.openCode1Refusal)(executable) ?? (0, net_1.dataFolderRefusal)(executable);
    if (refused) {
        response.markdown(`> ${(0, followups_1.mark)("fail")} ${refused.message}`);
        return { metadata: { kind: "worktree", error: refused.message } };
    }
    let identityError;
    const identity = await (0, core_1.untilStop)((0, net_1.ensureCliIdentity)(executable, cwd).then(() => true).catch((error) => {
        identityError = error;
        return false;
    }), token);
    if (token.isCancellationRequested) {
        return { metadata: { kind: "worktree", cancelled: true } };
    }
    if (!identity) {
        const message = identityError instanceof Error ? identityError.message : String(identityError);
        response.markdown(`> ${(0, followups_1.mark)("fail")} ${message}`);
        return { metadata: { kind: "worktree", error: message } };
    }
    const previous = p.previous && (await (0, worktree_1.reopenWorktree)(cwd, p.previous)) ? p.previous : undefined;
    const references = request.references ?? [];
    if (!previous && !references.length && settings.get("clarifyVaguePrompts", true) && (0, prompt_1.isVaguePrompt)(task) && !(0, prompt_1.insistedOn)(text)) {
        response.markdown(`\`${task.slice(0, 40)}\` is too short for me to act on, so I have not made a worktree or spent a run on it.\n\n` +
            "Say what to change and what you want back, e.g. `/worktree add a regression test for the redirect loop`.");
        (0, prompt_1.markClarifiedPrompt)(text);
        return { metadata: { kind: "clarify", agent: "worktree", prompt: text } };
    }
    let model = settings.get("model", "").trim() || undefined;
    if (parsed.model) {
        const ref = await (0, models_1.modelResolver)(executable, cwd, (work) => (0, core_1.untilStop)(work, token))(parsed.model);
        if (token.isCancellationRequested) {
            return { metadata: { kind: "worktree", cancelled: true } };
        }
        if (!("id" in ref)) {
            response.markdown((0, models_1.modelRefProblem)(parsed.model, ref));
            return { metadata: { kind: "idle" } };
        }
        model = ref.id;
    }
    const effort = (0, models_1.effortFor)(model, parsed.effort ?? (settings.get("effort", "").trim() || undefined), Boolean(parsed.effort));
    if (effort.problem && parsed.effort) {
        response.markdown(effort.problem);
        return { metadata: { kind: "idle" } };
    }
    let wt;
    if (previous) {
        wt = { root: previous.root, path: previous.path, branch: previous.branch, baseRef: previous.baseRef, baseSha: previous.baseSha };
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] worktree ${wt.path} on ${wt.branch} continued`);
        response.markdown(`> ${(0, followups_1.mark)("worktree")} Continuing in \`${(0, worktree_1.worktreeLabel)(wt.path)}\` on branch \`${wt.branch}\`. ` +
            "Your checkout is not touched; a new chat starts a fresh worktree.\n\n");
    }
    else {
        const created = await (0, worktree_1.createWorktree)(cwd, task);
        if (!created.ok) {
            response.markdown(`Could not create a worktree: ${created.reason}\n\nPlain \`/dev\` works in your current checkout.`);
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] worktree failed: ${created.reason}`);
            return { metadata: { kind: "worktree", cwd, error: created.reason } };
        }
        wt = created.worktree;
        const left = created.uncommitted;
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] worktree ${wt.path} on ${wt.branch} from ${wt.baseRef}@${wt.baseSha.slice(0, 7)}; ${left} uncommitted left in the checkout`);
        response.markdown(`> ${(0, followups_1.mark)("worktree")} Isolated run in \`${(0, worktree_1.worktreeLabel)(wt.path)}\` on branch \`${wt.branch}\` ` +
            `(from \`${wt.baseRef}\` @ \`${wt.baseSha.slice(0, 7)}\`). Your checkout is not touched.` +
            (left ? ` Its ${left} uncommitted ${left === 1 ? "change is" : "changes are"} not in the worktree: commit first if the task needs them.` : "") +
            "\n\n");
    }
    if (effort.problem) {
        response.markdown(`> ${(0, followups_1.mark)("warn")} ${effort.problem}\n\n`);
    }
    else if (effort.variant && parsed.effort) {
        response.markdown(`> ${(0, followups_1.mark)("thought")} effort \`${effort.variant}\`\n\n`);
    }
    const ctx = (0, context_1.buildChatContext)(request, wt.root, { readOnly: false });
    (0, context_1.emitReferences)(response, ctx.uris);
    const referenceLine = (0, context_1.referenceLogLine)(ctx.notes);
    if (referenceLine) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${referenceLine}`);
    }
    const notSent = (0, context_1.contextNotice)(ctx.notes, false);
    if (notSent) {
        response.markdown(`> ${(0, followups_1.mark)("warn")} ${notSent}\n\n`);
    }
    const inRepo = ctx.uris
        .map((u) => path.relative(wt.root, u.fsPath))
        .filter((rel) => rel && !rel.startsWith("..") && !path.isAbsolute(rel))
        .map((rel) => rel.split(path.sep).join("/"));
    if (inRepo.length) {
        const changed = new Set(await (0, worktree_1.uncommittedPaths)(wt.root));
        const stale = [...new Set(inRepo.filter((rel) => changed.has(rel)))];
        if (stale.length) {
            response.markdown(`> ${(0, followups_1.mark)("warn")} ${stale.map((rel) => `\`${rel}\``).join(", ")} ${stale.length === 1 ? "has" : "have"} uncommitted changes in your checkout; ` +
                "the worktree has the last commit's version.\n\n");
        }
    }
    const taskForModel = `${task}${ctx.preamble}`;
    const tPlan = (0, prompt_1.planTimeout)();
    const devAgent = settings.get("devAgent", "build").trim() || "build";
    const transport = settings.get("transport", "auto");
    let attachUrl;
    const resumed = previous?.sessionId;
    let sessionId = resumed;
    const args = [{ root: wt.root, path: wt.path, branch: wt.branch, baseSha: wt.baseSha }];
    if (transport === "auto" && settings.get("attachDevToServer", true)) {
        try {
            attachUrl = await (0, net_1.ensureServer)(cwd, (line) => response.progress(line));
            sessionId = sessionId ?? await (0, runs_1.createServerSession)(attachUrl, wt.path, task);
        }
        catch (error) {
            if ((0, net_1.isNotOpenCode1)(error) || (0, net_1.isDataFolderClash)(error)) {
                response.markdown(`> ${(0, followups_1.mark)("fail")} ${error.message}`);
                response.button({ command: "opencodeCopilotBridge.worktreeRemove", title: "Remove worktree", arguments: args });
                return { metadata: { ...worktreeMeta(cwd, wt, resumed), error: error.message } };
            }
            attachUrl = undefined;
            sessionId = resumed;
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] worktree run goes cold: ${error}`);
        }
    }
    const beat = (0, chat_boot_1.startHeartbeat)(response, `Working in ${wt.branch}`, tPlan.timeoutMs, wt.path);
    if (resumed && !token.isCancellationRequested) {
        const summary = (0, runs_1.compactionInFlight)(resumed);
        if (summary) {
            beat.phase("Finishing this worktree session's summary first");
            const began = Date.now();
            let cap;
            const capped = new Promise((resolve) => (cap = setTimeout(() => resolve(false), SUMMARY_WAIT_MS)));
            await (0, core_1.untilStop)(Promise.race([summary.then(() => true), capped]), token);
            clearTimeout(cap);
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] waited ${(0, core_1.secs)(Date.now() - began)} for the worktree session's summary`);
        }
        if (attachUrl && settings.get("busySessionPolicy", "abort") !== "queue" && !token.isCancellationRequested && (await (0, runs_1.sessionBusy)(attachUrl, resumed, wt.path))) {
            await (0, runs_1.abortServerRun)(attachUrl, resumed, wt.path, "busy before send");
        }
    }
    const linker = (0, context_1.createFileLinker)(wt.path);
    let answer = "";
    const show = (shown) => {
        if (shown) {
            answer += shown;
            (0, context_1.emitAnswerParts)(response, linker.push(shown));
        }
    };
    const run = async (session) => {
        const leak = (0, format_1.createLeakGate)();
        const echo = (0, format_1.createEchoGate)([task, taskForModel]);
        let lastPart;
        const metrics = await (0, runs_1.runOpenCode)({
            executable,
            task: taskForModel,
            cwd: wt.path,
            agent: devAgent,
            model,
            variant: effort.variant,
            pure: settings.get("pure", false),
            autoApprove: true,
            json: true,
            thinking: false,
            timeoutMs: tPlan.timeoutMs,
            idleTimeoutMs: tPlan.idleTimeoutMs,
            toolQuietMs: Math.max(0, settings.get("toolQuietMs", 600000)),
            sessionId: session,
            attachUrl,
            token,
            onStep: (s) => beat.step(s),
            onText: (raw, part) => {
                lastPart = part;
                show(echo.push(leak.push(raw), part));
            }
        });
        show(echo.push(leak.flush(), lastPart));
        show(echo.flush());
        return metrics;
    };
    let metrics = await run(sessionId);
    if (resumed && sessionId === resumed && !token.isCancellationRequested && (0, runs_1.isMissingSessionRun)(metrics)) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] worktree session ${resumed} is gone; a fresh one in ${wt.path}`);
        sessionId = attachUrl ? await (0, runs_1.createServerSession)(attachUrl, wt.path, task).catch(() => undefined) : undefined;
        metrics = await run(sessionId);
    }
    const runSession = metrics.sessionId ?? sessionId;
    if (attachUrl && runSession && (token.isCancellationRequested || metrics.timedOut)) {
        const abort = (0, runs_1.abortServerRun)(attachUrl, runSession, wt.path, token.isCancellationRequested ? "worktree cancelled" : "worktree timed out");
        if (!token.isCancellationRequested) {
            await abort;
        }
    }
    (0, context_1.emitAnswerParts)(response, linker.flush());
    await beat.stop(token.isCancellationRequested);
    metrics.cancelled = token.isCancellationRequested;
    (0, session_1.notifyIfSlow)(metrics, "worktree", cwd);
    core_1.logChannel.appendLine((0, format_1.metricsLogLine)(metrics));
    if (token.isCancellationRequested) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${(0, followups_1.mark)("stop")} worktree run stopped by the user; ${wt.path} is kept`);
        return { metadata: { ...worktreeMeta(cwd, wt, runSession), cancelled: true } };
    }
    if (!answer.trim()) {
        response.markdown(metrics.error ? `> ${(0, followups_1.mark)("fail")} OpenCode reported an error: \`${metrics.error}\`` : "_OpenCode returned no text._");
    }
    (0, context_1.emitReferences)(response, (0, context_1.stepUris)(wt.path, metrics.steps));
    const done = Boolean(runSession && !metrics.error && !metrics.timedOut);
    if (done && runSession) {
        const chips = (0, chat_boot_1.suggestFollowups)({ agent: "dev", answer, steps: metrics.steps })
            .filter((c) => c.command !== "parallel")
            .map((c) => ({ ...c, command: "worktree" }));
        (0, chat_boot_1.rememberFollowups)(runSession, chat_boot_1.WORKTREE_TURN, chips);
    }
    const contextTokens = metrics.context ?? 0;
    const limit = metrics.model ? (0, core_1.own)((0, models_1.cachedModelInfo)(), metrics.model)?.context : undefined;
    const bridgeCompacts = settings.get("autoCompact", true) && settings.get("autoCompactEveryTurns", 8) > 0;
    if (done && runSession && bridgeCompacts && (0, runs_1.contextOverflowing)(contextTokens, limit)) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] compacting worktree session ${runSession}: context ${contextTokens}${limit ? ` of ${limit}` : ""}`);
        void (0, runs_1.compactSession)(runSession, wt.path, metrics.model ?? model);
    }
    const stat = await (0, worktree_1.worktreeDiff)(wt, true, (0, core_1.config)().get("worktreeDiffMaxMB", 16));
    response.markdown(stat
        ? `\n\n**Changes in \`${wt.branch}\`** (uncommitted, against \`${wt.baseSha.slice(0, 7)}\`):\n\n\`\`\`\n${stat}\n\`\`\``
        : `\n\n**No file changes** in \`${wt.branch}\`.`);
    if (stat) {
        response.button({ command: "opencodeCopilotBridge.worktreeDiff", title: "Show full diff", arguments: args });
    }
    response.button({ command: "opencodeCopilotBridge.worktreeOpen", title: "Open in new window", arguments: args });
    response.button({ command: "opencodeCopilotBridge.worktreeRemove", title: "Remove worktree", arguments: args });
    response.button({ command: "opencodeCopilotBridge.newChat", title: "New worktree", arguments: ["/worktree "] });
    return {
        metadata: {
            ...worktreeMeta(cwd, wt, runSession),
            timedOut: Boolean(metrics.timedOut),
            error: metrics.error
        }
    };
}
//# sourceMappingURL=chat-worktree.js.map