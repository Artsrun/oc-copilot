import * as vscode from "vscode";
import { config, logChannel, stamp, untilStop } from "./core";
import { mark } from "./followups";
import { dataFolderRefusal, ensureCliIdentity, ensureServer, isDataFolderClash, isNotOpenCode1, openCode1Refusal } from "./net";
import { abortServerRun, createServerSession, isMissingSessionRun, runOpenCode } from "./runs";
import { planTimeout } from "./prompt";
import { metricsLogLine, scrubLeakedContext } from "./format";
import { WORKTREE_TURN, rememberFollowups, startHeartbeat, suggestFollowups } from "./chat-boot";
import { Worktree, createWorktree, reopenWorktree, worktreeDiff } from "./worktree";

// What the next `/worktree` turn of this chat needs to continue: `threadWorktree`
// reads it back. Never `sessionId` + `turns`: those bind the chat's own session.
const worktreeMeta = (cwd: string, wt: Worktree, sessionId: string | undefined): Record<string, unknown> => ({
    kind: "worktree",
    cwd,
    worktree: wt.path,
    branch: wt.branch,
    worktreeRoot: wt.root,
    worktreeBase: wt.baseSha,
    worktreeBaseRef: wt.baseRef,
    ...(sessionId ? { worktreeSession: sessionId } : {})
});

// `/worktree <task>`: an isolated dev run (claim:worktree-command, see
// ./worktree). Deliberately NOT bound to the chat thread's session: the thread
// keeps working cooperatively in your checkout; the worktree is a side branch
// you open, review, keep or remove with the buttons below. A follow-up in the
// same chat continues that worktree and its OpenCode session (`previous`):
// Copilot keeps `/worktree` sticky, and a worktree per message cost OpenCode's
// whole per-folder start each time (0.0.225 live). A new chat starts afresh.
export async function handleWorktree(p: {
    task: string;
    cwd: string;
    response: vscode.ChatResponseStream;
    token: vscode.CancellationToken;
    previous?: Worktree & { sessionId?: string };
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
    const executable = settings.get<string>("executable", "opencode");
    // Not OpenCode 1, or a data folder it cannot open: no worktree, no run.
    const refused = openCode1Refusal(executable) ?? dataFolderRefusal(executable);
    if (refused) {
        response.markdown(`> ${mark("fail")} ${refused.message}`);
        return { metadata: { kind: "worktree", error: refused.message } };
    }
    let identityError: unknown;
    const identity = await untilStop(ensureCliIdentity(executable, cwd).then(() => true).catch((error) => {
        identityError = error;
        return false;
    }), token);
    if (token.isCancellationRequested) {
        return { metadata: { kind: "worktree", cancelled: true } };
    }
    if (!identity) {
        const message = identityError instanceof Error ? identityError.message : String(identityError);
        response.markdown(`> ${mark("fail")} ${message}`);
        return { metadata: { kind: "worktree", error: message } };
    }
    const previous = p.previous && (await reopenWorktree(cwd, p.previous)) ? p.previous : undefined;
    let wt: Worktree;
    if (previous) {
        wt = { root: previous.root, path: previous.path, branch: previous.branch, baseRef: previous.baseRef, baseSha: previous.baseSha };
        logChannel.appendLine(`[${stamp()}] worktree ${wt.path} on ${wt.branch} continued`);
        response.markdown(
            `> ${mark("worktree")} Continuing in \`${wt.path}\` on branch \`${wt.branch}\`. ` +
            "Your checkout is not touched; a new chat starts a fresh worktree.\n\n"
        );
    } else {
        const created = await createWorktree(cwd, task);
        if (!created.ok) {
            response.markdown(`Could not create a worktree: ${created.reason}\n\nPlain \`/dev\` works in your current checkout.`);
            logChannel.appendLine(`[${stamp()}] worktree failed: ${created.reason}`);
            return { metadata: { kind: "worktree", cwd, error: created.reason } };
        }
        wt = created.worktree;
        const left = created.uncommitted;
        logChannel.appendLine(`[${stamp()}] worktree ${wt.path} on ${wt.branch} from ${wt.baseRef}@${wt.baseSha.slice(0, 7)}; ${left} uncommitted left in the checkout`);
        response.markdown(
            `> ${mark("worktree")} Isolated run in \`${wt.path}\` on branch \`${wt.branch}\` ` +
            `(from \`${wt.baseRef}\` @ \`${wt.baseSha.slice(0, 7)}\`). Your checkout is not touched.` +
            (left ? ` Its ${left} uncommitted ${left === 1 ? "change is" : "changes are"} not in the worktree: commit first if the task needs them.` : "") +
            "\n\n"
        );
    }

    const tPlan = planTimeout();
    const devAgent = settings.get<string>("devAgent", "build").trim() || "build";
    const transport = settings.get<string>("transport", "auto");
    let attachUrl: string | undefined;
    // A continued worktree resumes its own session (argv and URLs check the id).
    const resumed = previous?.sessionId;
    let sessionId: string | undefined = resumed;
    const args = [{ root: wt.root, path: wt.path, branch: wt.branch, baseSha: wt.baseSha }];
    if (transport === "auto" && settings.get<boolean>("attachDevToServer", true)) {
        try {
            attachUrl = await ensureServer(cwd, (text) => response.progress(text));
            // The server is multi-directory: this session is rooted in the worktree.
            sessionId = sessionId ?? await createServerSession(attachUrl, wt.path, task);
        } catch (error) {
            if (isNotOpenCode1(error) || isDataFolderClash(error)) {
                // Found out just now: nothing runs; a new worktree is empty and can go.
                response.markdown(`> ${mark("fail")} ${(error as Error).message}`);
                response.button({ command: "opencodeCopilotBridge.worktreeRemove", title: "Remove worktree", arguments: args });
                return { metadata: { ...worktreeMeta(cwd, wt, resumed), error: (error as Error).message } };
            }
            attachUrl = undefined;
            sessionId = resumed;
            logChannel.appendLine(`[${stamp()}] worktree run goes cold: ${error}`);
        }
    }

    const beat = startHeartbeat(response, `Working in ${wt.branch}`, tPlan.timeoutMs, wt.path);
    let answer = "";
    const run = (session: string | undefined) => runOpenCode({
        executable,
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
        sessionId: session,
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
    let metrics = await run(sessionId);
    // The continued session is gone (deleted in /sessions, another data folder):
    // the worktree stays, the run starts a fresh session there, once.
    if (resumed && sessionId === resumed && !token.isCancellationRequested && isMissingSessionRun(metrics)) {
        logChannel.appendLine(`[${stamp()}] worktree session ${resumed} is gone; a fresh one in ${wt.path}`);
        sessionId = attachUrl ? await createServerSession(attachUrl, wt.path, task).catch(() => undefined) : undefined;
        metrics = await run(sessionId);
    }
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
        return { metadata: { ...worktreeMeta(cwd, wt, runSession), cancelled: true } };
    }

    if (!answer.trim()) {
        response.markdown(metrics.error ? `> ${mark("fail")} OpenCode reported an error: \`${metrics.error}\`` : "_OpenCode returned no text._");
    }
    // A follow-up continues this worktree, so the answer's own chips go there as
    // `/worktree`. A read-only chip would read the checkout instead: left out.
    if (runSession && !metrics.error && !metrics.timedOut) {
        const chips = suggestFollowups({ agent: "dev", answer, steps: metrics.steps })
            .filter((c) => c.command === "dev")
            .map((c) => ({ ...c, command: "worktree" as const }));
        rememberFollowups(runSession, WORKTREE_TURN, chips);
    }
    const stat = await worktreeDiff(wt, true, config().get<number>("worktreeDiffMaxMB", 16));
    response.markdown(
        stat
            ? `\n\n**Changes in \`${wt.branch}\`** (uncommitted, against \`${wt.baseSha.slice(0, 7)}\`):\n\n\`\`\`\n${stat}\n\`\`\``
            : `\n\n**No file changes** in \`${wt.branch}\`.`
    );
    if (stat) {
        response.button({ command: "opencodeCopilotBridge.worktreeDiff", title: "Show full diff", arguments: args });
    }
    response.button({ command: "opencodeCopilotBridge.worktreeOpen", title: "Open in new window", arguments: args });
    response.button({ command: "opencodeCopilotBridge.worktreeRemove", title: "Remove worktree", arguments: args });
    // Follow-ups here continue this worktree; a fresh one is a new chat, opened
    // with `@opencode /worktree ` typed and nothing sent.
    response.button({ command: "opencodeCopilotBridge.newChat", title: "New worktree", arguments: ["/worktree "] });
    return {
        metadata: {
            ...worktreeMeta(cwd, wt, runSession),
            timedOut: Boolean(metrics.timedOut),
            error: metrics.error
        }
    };
}
