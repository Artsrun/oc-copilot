import * as vscode from "vscode";
import { config, logChannel, stamp } from "./core";
import { mark } from "./followups";
import { ensureServer } from "./net";
import { abortServerRun, createServerSession, runOpenCode } from "./runs";
import { planTimeout } from "./prompt";
import { metricsLogLine, scrubLeakedContext } from "./format";
import { startHeartbeat } from "./chat-boot";
import { createWorktree, worktreeDiff } from "./worktree";

// `/worktree <task>`: one isolated dev run (claim:worktree-command, see
// ./worktree). Deliberately NOT bound to the chat thread's session: the thread
// keeps working cooperatively in your checkout; the worktree is a side branch
// you open, review, keep or remove with the buttons below.
export async function handleWorktree(p: {
    task: string;
    cwd: string;
    response: vscode.ChatResponseStream;
    token: vscode.CancellationToken;
}): Promise<vscode.ChatResult> {
    const { task, cwd, response, token } = p;
    if (!task) {
        response.markdown(
            "Give the task after `/worktree`, e.g. `/worktree add a regression test for the redirect loop`.\n\n" +
            "It runs the editing agent in a new git worktree next to this repo, so your checkout is not touched."
        );
        return { metadata: { kind: "worktree" } };
    }
    const settings = config();
    const created = await createWorktree(cwd, task);
    if (!created.ok) {
        response.markdown(`Could not create a worktree: ${created.reason}\n\nPlain \`/dev\` works in your current checkout.`);
        logChannel.appendLine(`[${stamp()}] worktree failed: ${created.reason}`);
        return { metadata: { kind: "worktree", error: created.reason } };
    }
    const wt = created.worktree;
    logChannel.appendLine(`[${stamp()}] worktree ${wt.path} on ${wt.branch} from ${wt.baseRef}@${wt.baseSha.slice(0, 7)}`);
    response.markdown(
        `> ${mark("worktree")} Isolated run in \`${wt.path}\` on branch \`${wt.branch}\` ` +
        `(from \`${wt.baseRef}\` @ \`${wt.baseSha.slice(0, 7)}\`). Your checkout is not touched.\n\n`
    );

    const tPlan = planTimeout();
    const devAgent = settings.get<string>("devAgent", "build").trim() || "build";
    const transport = settings.get<string>("transport", "auto");
    let attachUrl: string | undefined;
    let sessionId: string | undefined;
    if (transport === "auto" && settings.get<boolean>("attachDevToServer", true)) {
        try {
            attachUrl = await ensureServer(cwd);
            // The server is multi-directory: this session is rooted in the worktree.
            sessionId = await createServerSession(attachUrl, wt.path, task);
        } catch (error) {
            attachUrl = undefined;
            sessionId = undefined;
            logChannel.appendLine(`[${stamp()}] worktree run goes cold: ${error}`);
        }
    }

    const beat = startHeartbeat(response, `Working in ${wt.branch}`, tPlan.timeoutMs, wt.path);
    let answer = "";
    const metrics = await runOpenCode({
        executable: settings.get<string>("executable", "opencode"),
        task,
        cwd: wt.path,
        agent: devAgent,
        model: settings.get<string>("model", "").trim() || undefined,
        pure: settings.get<boolean>("pure", false),
        autoApprove: true,
        json: true,
        thinking: false,
        timeoutMs: tPlan.timeoutMs,
        idleTimeoutMs: tPlan.idleTimeoutMs,
        toolQuietMs: Math.max(0, settings.get<number>("toolQuietMs", 600000)),
        sessionId,
        attachUrl,
        token,
        onStep: (s) => beat.step(s),
        onText: (raw) => {
            const text = scrubLeakedContext(raw);
            if (text) {
                answer += text;
                response.markdown(text);
            }
        }
    });
    // Stop and the cap end the server run too: killing the client does not.
    const runSession = metrics.sessionId ?? sessionId;
    if (attachUrl && runSession && (token.isCancellationRequested || metrics.timedOut)) {
        const abort = abortServerRun(attachUrl, runSession, wt.path, token.isCancellationRequested ? "worktree cancelled" : "worktree timed out");
        // After Stop the host allows one second; the abort finishes on its own.
        if (!token.isCancellationRequested) {
            await abort;
        }
    }
    await beat.stop(token.isCancellationRequested);
    logChannel.appendLine(metricsLogLine(metrics));
    if (token.isCancellationRequested) {
        // Nothing reaches the chat after Stop; the worktree stays for `git worktree list`.
        logChannel.appendLine(`[${stamp()}] ${mark("stop")} worktree run stopped by the user; ${wt.path} is kept`);
        return { metadata: { kind: "worktree", worktree: wt.path, branch: wt.branch, cancelled: true } };
    }

    if (!answer.trim()) {
        response.markdown(metrics.error ? `> ${mark("fail")} OpenCode reported an error: \`${metrics.error}\`` : "_OpenCode returned no text._");
    }
    const stat = await worktreeDiff(wt, true, config().get<number>("worktreeDiffMaxMB", 16));
    response.markdown(
        stat
            ? `\n\n**Changes in \`${wt.branch}\`** (uncommitted, against \`${wt.baseSha.slice(0, 7)}\`):\n\n\`\`\`\n${stat}\n\`\`\``
            : `\n\n**No file changes** in \`${wt.branch}\`.`
    );
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
