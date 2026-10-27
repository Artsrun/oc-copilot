"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleWorktree = handleWorktree;
const core_1 = require("./core");
const followups_1 = require("./followups");
const net_1 = require("./net");
const runs_1 = require("./runs");
const prompt_1 = require("./prompt");
const format_1 = require("./format");
const chat_boot_1 = require("./chat-boot");
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
async function handleWorktree(p) {
    const { task, cwd, response, token } = p;
    if (!task) {
        response.markdown("Give the task after `/worktree`, e.g. `/worktree add a regression test for the redirect loop`.\n\n" +
            "It runs the editing agent in a new git worktree next to this repo, so your checkout is not touched.");
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
    let wt;
    if (previous) {
        wt = { root: previous.root, path: previous.path, branch: previous.branch, baseRef: previous.baseRef, baseSha: previous.baseSha };
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] worktree ${wt.path} on ${wt.branch} continued`);
        response.markdown(`> ${(0, followups_1.mark)("worktree")} Continuing in \`${wt.path}\` on branch \`${wt.branch}\`. ` +
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
        response.markdown(`> ${(0, followups_1.mark)("worktree")} Isolated run in \`${wt.path}\` on branch \`${wt.branch}\` ` +
            `(from \`${wt.baseRef}\` @ \`${wt.baseSha.slice(0, 7)}\`). Your checkout is not touched.` +
            (left ? ` Its ${left} uncommitted ${left === 1 ? "change is" : "changes are"} not in the worktree: commit first if the task needs them.` : "") +
            "\n\n");
    }
    const tPlan = (0, prompt_1.planTimeout)();
    const devAgent = settings.get("devAgent", "build").trim() || "build";
    const transport = settings.get("transport", "auto");
    let attachUrl;
    const resumed = previous?.sessionId;
    let sessionId = resumed;
    const args = [{ root: wt.root, path: wt.path, branch: wt.branch, baseSha: wt.baseSha }];
    if (transport === "auto" && settings.get("attachDevToServer", true)) {
        try {
            attachUrl = await (0, net_1.ensureServer)(cwd, (text) => response.progress(text));
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
    let answer = "";
    const run = (session) => (0, runs_1.runOpenCode)({
        executable,
        task,
        cwd: wt.path,
        agent: devAgent,
        model: settings.get("model", "").trim() || undefined,
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
        onText: (raw) => {
            const text = (0, format_1.scrubLeakedContext)(raw);
            if (text) {
                answer += text;
                response.markdown(text);
            }
        }
    });
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
    await beat.stop(token.isCancellationRequested);
    core_1.logChannel.appendLine((0, format_1.metricsLogLine)(metrics));
    if (token.isCancellationRequested) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${(0, followups_1.mark)("stop")} worktree run stopped by the user; ${wt.path} is kept`);
        return { metadata: { ...worktreeMeta(cwd, wt, runSession), cancelled: true } };
    }
    if (!answer.trim()) {
        response.markdown(metrics.error ? `> ${(0, followups_1.mark)("fail")} OpenCode reported an error: \`${metrics.error}\`` : "_OpenCode returned no text._");
    }
    if (runSession && !metrics.error && !metrics.timedOut) {
        const chips = (0, chat_boot_1.suggestFollowups)({ agent: "dev", answer, steps: metrics.steps })
            .filter((c) => c.command === "dev")
            .map((c) => ({ ...c, command: "worktree" }));
        (0, chat_boot_1.rememberFollowups)(runSession, chat_boot_1.WORKTREE_TURN, chips);
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