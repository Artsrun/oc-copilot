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
async function handleWorktree(p) {
    const { task, cwd, response, token } = p;
    if (!task) {
        response.markdown("Give the task after `/worktree`, e.g. `/worktree add a regression test for the redirect loop`.\n\n" +
            "It runs the editing agent in a new git worktree next to this repo, so your checkout is not touched.");
        return { metadata: { kind: "worktree" } };
    }
    const settings = (0, core_1.config)();
    const created = await (0, worktree_1.createWorktree)(cwd, task);
    if (!created.ok) {
        response.markdown(`Could not create a worktree: ${created.reason}\n\nPlain \`/dev\` works in your current checkout.`);
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] worktree failed: ${created.reason}`);
        return { metadata: { kind: "worktree", error: created.reason } };
    }
    const wt = created.worktree;
    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] worktree ${wt.path} on ${wt.branch} from ${wt.baseRef}@${wt.baseSha.slice(0, 7)}`);
    response.markdown(`> ${(0, followups_1.mark)("worktree")} Isolated run in \`${wt.path}\` on branch \`${wt.branch}\` ` +
        `(from \`${wt.baseRef}\` @ \`${wt.baseSha.slice(0, 7)}\`). Your checkout is not touched.\n\n`);
    const tPlan = (0, prompt_1.planTimeout)();
    const devAgent = settings.get("devAgent", "build").trim() || "build";
    const transport = settings.get("transport", "auto");
    let attachUrl;
    let sessionId;
    if (transport === "auto" && settings.get("attachDevToServer", true)) {
        try {
            attachUrl = await (0, net_1.ensureServer)(cwd);
            sessionId = await (0, runs_1.createServerSession)(attachUrl, wt.path, task);
        }
        catch (error) {
            attachUrl = undefined;
            sessionId = undefined;
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] worktree run goes cold: ${error}`);
        }
    }
    const beat = (0, chat_boot_1.startHeartbeat)(response, `Working in ${wt.branch}`, tPlan.timeoutMs, wt.path);
    let answer = "";
    const metrics = await (0, runs_1.runOpenCode)({
        executable: settings.get("executable", "opencode"),
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
        sessionId,
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
        return { metadata: { kind: "worktree", worktree: wt.path, branch: wt.branch, cancelled: true } };
    }
    if (!answer.trim()) {
        response.markdown(metrics.error ? `> ${(0, followups_1.mark)("fail")} OpenCode reported an error: \`${metrics.error}\`` : "_OpenCode returned no text._");
    }
    const stat = await (0, worktree_1.worktreeDiff)(wt, true, (0, core_1.config)().get("worktreeDiffMaxMB", 16));
    response.markdown(stat
        ? `\n\n**Changes in \`${wt.branch}\`** (uncommitted, against \`${wt.baseSha.slice(0, 7)}\`):\n\n\`\`\`\n${stat}\n\`\`\``
        : `\n\n**No file changes** in \`${wt.branch}\`.`);
    const args = [{ root: wt.root, path: wt.path, branch: wt.branch, baseSha: wt.baseSha }];
    if (stat) {
        response.button({ command: "opencodeCopilotBridge.worktreeDiff", title: "Show full diff", arguments: args });
    }
    response.button({ command: "opencodeCopilotBridge.worktreeOpen", title: "Open in new window", arguments: args });
    response.button({ command: "opencodeCopilotBridge.worktreeRemove", title: "Remove worktree", arguments: args });
    return {
        metadata: {
            kind: "worktree",
            worktree: wt.path,
            branch: wt.branch,
            timedOut: Boolean(metrics.timedOut),
            error: metrics.error
        }
    };
}
//# sourceMappingURL=chat-worktree.js.map