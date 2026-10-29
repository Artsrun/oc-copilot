import * as path from "node:path";
import * as vscode from "vscode";
import { config, logChannel, own, secs, stamp, untilStop } from "./core";
import { mark } from "./followups";
import { dataFolderRefusal, ensureCliIdentity, ensureServer, isDataFolderClash, isNotOpenCode1, openCode1Refusal } from "./net";
import { abortServerRun, compactSession, compactionInFlight, contextOverflowing, createServerSession, isMissingSessionRun, runOpenCode, sessionBusy } from "./runs";
import { insistedOn, isVaguePrompt, markClarifiedPrompt, planTimeout } from "./prompt";
import { createEchoGate, createLeakGate, metricsLogLine } from "./format";
import { WORKTREE_TURN, rememberFollowups, startHeartbeat, suggestFollowups } from "./chat-boot";
import { buildChatContext, contextNotice, createFileLinker, emitAnswerParts, emitReferences, parseChatPrompt, referenceLogLine, stepUris } from "./context";
import { cachedModelInfo, effortFor, modelRefProblem, modelResolver } from "./models";
import { notifyIfSlow } from "./session";
import { Worktree, createWorktree, listWorktrees, reopenWorktree, uncommittedPaths, worktreeChanges, worktreeDiff, worktreeLabel } from "./worktree";

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

// As a chat turn waits for this window's summary of its session (./chat-turn).
const SUMMARY_WAIT_MS = 60000;

// `/worktree <task>`: an isolated dev run (claim:worktree-command, see
// ./worktree). Deliberately NOT bound to the chat thread's session: the thread
// keeps working cooperatively in your checkout; the worktree is a side branch
// you open, review, keep or remove with the buttons below. A follow-up in the
// same chat continues that worktree and its OpenCode session (`previous`):
// Copilot keeps `/worktree` sticky, and a worktree per message cost OpenCode's
// whole per-folder start each time (0.0.225 live). A new chat starts afresh.
// Since a worktree chat is a conversation, its turns read what a chat turn
// reads: `model:` and `effort:`, the `effort` setting, attachments, the
// vague-prompt gate (0.0.228: each was dropped or skipped before).
export async function handleWorktree(p: {
    text: string;
    request: vscode.ChatRequest;
    cwd: string;
    response: vscode.ChatResponseStream;
    token: vscode.CancellationToken;
    previous?: Worktree & { sessionId?: string };
}): Promise<vscode.ChatResult> {
    const { text, request, cwd, response, token } = p;
    const parsed = parseChatPrompt(text);
    const task = parsed.task;
    if (!task) {
        response.markdown(
            "Give the task after `/worktree`, e.g. `/worktree add a regression test for the redirect loop`.\n\n" +
            "It runs the editing agent in its own git worktree next to this repo, so your checkout is not touched; follow-ups in this chat continue it."
        );
        // The ones it already made, and where to manage them (an artifact: a button).
        const listed = (await listWorktrees(cwd))?.worktrees ?? [];
        if (listed.length) {
            const shown = listed.slice(0, 8).map((w) => `- \`${w.branch}\` · ${worktreeChanges(w)}`);
            response.markdown(
                `\n\nThis repository has ${listed.length} worktree${listed.length === 1 ? "" : "s"} from \`/worktree\`:\n\n${shown.join("\n")}` +
                (listed.length > shown.length ? `\n- …${listed.length - shown.length} more` : "")
            );
            response.button({ command: "opencodeCopilotBridge.worktrees", title: "Worktrees…" });
        }
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

    // A bare word costs a branch, a folder and a run to learn nothing: ask
    // first, as a chat turn does. A continued worktree's `yes` answers the agent.
    const references = (request as { references?: readonly unknown[] }).references ?? [];
    if (!previous && !references.length && settings.get<boolean>("clarifyVaguePrompts", true) && isVaguePrompt(task) && !insistedOn(text)) {
        response.markdown(
            `\`${task.slice(0, 40)}\` is too short for me to act on, so I have not made a worktree or spent a run on it.\n\n` +
            "Say what to change and what you want back, e.g. `/worktree add a regression test for the redirect loop`."
        );
        markClarifiedPrompt(text);
        return { metadata: { kind: "clarify", agent: "worktree", prompt: text } };
    }

    // `model:tundra` is one catalog match or refused, before a folder exists.
    let model = settings.get<string>("model", "").trim() || undefined;
    if (parsed.model) {
        const ref = await modelResolver(executable, cwd, (work) => untilStop(work, token))(parsed.model);
        if (token.isCancellationRequested) {
            return { metadata: { kind: "worktree", cancelled: true } };
        }
        if (!("id" in ref)) {
            response.markdown(modelRefProblem(parsed.model, ref));
            return { metadata: { kind: "idle" } };
        }
        model = ref.id;
    }
    // `effort:` for this turn is strict; the setting runs at the default with a note.
    const effort = effortFor(model, parsed.effort ?? (settings.get<string>("effort", "").trim() || undefined), Boolean(parsed.effort));
    if (effort.problem && parsed.effort) {
        response.markdown(effort.problem);
        return { metadata: { kind: "idle" } };
    }

    let wt: Worktree;
    if (previous) {
        wt = { root: previous.root, path: previous.path, branch: previous.branch, baseRef: previous.baseRef, baseSha: previous.baseSha };
        logChannel.appendLine(`[${stamp()}] worktree ${wt.path} on ${wt.branch} continued`);
        response.markdown(
            `> ${mark("worktree")} Continuing in \`${worktreeLabel(wt.path)}\` on branch \`${wt.branch}\`. ` +
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
            `> ${mark("worktree")} Isolated run in \`${worktreeLabel(wt.path)}\` on branch \`${wt.branch}\` ` +
            `(from \`${wt.baseRef}\` @ \`${wt.baseSha.slice(0, 7)}\`). Your checkout is not touched.` +
            (left ? ` Its ${left} uncommitted ${left === 1 ? "change is" : "changes are"} not in the worktree: commit first if the task needs them.` : "") +
            "\n\n"
        );
    }
    if (effort.problem) {
        response.markdown(`> ${mark("warn")} ${effort.problem}\n\n`);
    } else if (effort.variant && parsed.effort) {
        response.markdown(`> ${mark("thought")} effort \`${effort.variant}\`\n\n`);
    }

    // Attachments go as a dev turn's do, by path from the repo root: the run's
    // folder is the worktree, whose copy of a file is the last commit's.
    const ctx = buildChatContext(request, wt.root, { readOnly: false });
    emitReferences(response, ctx.uris);
    const referenceLine = referenceLogLine(ctx.notes);
    if (referenceLine) {
        logChannel.appendLine(`[${stamp()}] ${referenceLine}`);
    }
    const notSent = contextNotice(ctx.notes, false);
    if (notSent) {
        response.markdown(`> ${mark("warn")} ${notSent}\n\n`);
    }
    const inRepo = ctx.uris
        .map((u) => path.relative(wt.root, u.fsPath))
        .filter((rel) => rel && !rel.startsWith("..") && !path.isAbsolute(rel))
        .map((rel) => rel.split(path.sep).join("/"));
    if (inRepo.length) {
        const changed = new Set(await uncommittedPaths(wt.root));
        const stale = [...new Set(inRepo.filter((rel) => changed.has(rel)))];
        if (stale.length) {
            response.markdown(
                `> ${mark("warn")} ${stale.map((rel) => `\`${rel}\``).join(", ")} ${stale.length === 1 ? "has" : "have"} uncommitted changes in your checkout; ` +
                "the worktree has the last commit's version.\n\n"
            );
        }
    }
    const taskForModel = `${task}${ctx.preamble}`;

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
            attachUrl = await ensureServer(cwd, (line) => response.progress(line));
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
    // A continued session may be summarizing (autocompact below): a prompt sent
    // now would queue behind it, and one nobody watches is stopped first.
    if (resumed && !token.isCancellationRequested) {
        const summary = compactionInFlight(resumed);
        if (summary) {
            beat.phase("Finishing this worktree session's summary first");
            const began = Date.now();
            let cap: NodeJS.Timeout | undefined;
            const capped = new Promise<false>((resolve) => (cap = setTimeout(() => resolve(false), SUMMARY_WAIT_MS)));
            await untilStop(Promise.race([summary.then(() => true), capped]), token);
            clearTimeout(cap);
            logChannel.appendLine(`[${stamp()}] waited ${secs(Date.now() - began)} for the worktree session's summary`);
        }
        if (attachUrl && settings.get<string>("busySessionPolicy", "abort") !== "queue" && !token.isCancellationRequested && (await sessionBusy(attachUrl, resumed, wt.path))) {
            await abortServerRun(attachUrl, resumed, wt.path, "busy before send");
        }
    }
    const linker = createFileLinker(wt.path);
    let answer = "";
    const show = (shown: string): void => {
        if (shown) {
            answer += shown;
            emitAnswerParts(response, linker.push(shown));
        }
    };
    // The leak and echo gates a chat turn's text passes, one pair per run.
    const run = async (session: string | undefined) => {
        const leak = createLeakGate();
        const echo = createEchoGate([task, taskForModel]);
        let lastPart: string | undefined;
        const metrics = await runOpenCode({
            executable,
            task: taskForModel,
            cwd: wt.path,
            agent: devAgent,
            model,
            variant: effort.variant,
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
    emitAnswerParts(response, linker.flush());
    await beat.stop(token.isCancellationRequested);
    metrics.cancelled = token.isCancellationRequested;
    notifyIfSlow(metrics, "worktree", cwd);
    logChannel.appendLine(metricsLogLine(metrics));
    if (token.isCancellationRequested) {
        // Nothing reaches the chat after Stop; the worktree stays for `git worktree list`.
        logChannel.appendLine(`[${stamp()}] ${mark("stop")} worktree run stopped by the user; ${wt.path} is kept`);
        return { metadata: { ...worktreeMeta(cwd, wt, runSession), cancelled: true } };
    }

    if (!answer.trim()) {
        response.markdown(metrics.error ? `> ${mark("fail")} OpenCode reported an error: \`${metrics.error}\`` : "_OpenCode returned no text._");
    }
    // The files it read or wrote, in the worktree.
    emitReferences(response, stepUris(wt.path, metrics.steps));
    const done = Boolean(runSession && !metrics.error && !metrics.timedOut);
    // A follow-up continues this worktree, so the answer's own chips go there as
    // `/worktree`, a review too: it reads the worktree, where the change is.
    // Lanes would run read-only in the checkout: left out.
    if (done && runSession) {
        const chips = suggestFollowups({ agent: "dev", answer, steps: metrics.steps })
            .filter((c) => c.command !== "parallel")
            .map((c) => ({ ...c, command: "worktree" as const }));
        rememberFollowups(runSession, WORKTREE_TURN, chips);
    }
    // Autocompact by size, as a chat turn's session is (the worktree keeps no
    // turn count); the next worktree turn waits for the summary above.
    const contextTokens = metrics.context ?? 0;
    const limit = metrics.model ? own(cachedModelInfo(), metrics.model)?.context : undefined;
    const bridgeCompacts = settings.get<boolean>("autoCompact", true) && settings.get<number>("autoCompactEveryTurns", 8) > 0;
    if (done && runSession && bridgeCompacts && contextOverflowing(contextTokens, limit)) {
        logChannel.appendLine(`[${stamp()}] compacting worktree session ${runSession}: context ${contextTokens}${limit ? ` of ${limit}` : ""}`);
        void compactSession(runSession, wt.path, metrics.model ?? model);
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
