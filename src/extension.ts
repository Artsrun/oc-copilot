import * as vscode from "vscode";

import { logChannel, resolveFolder, setExtensionContext, setLogChannel, stamp } from "./core";
import { expandShimVar, readShimTarget, resolveExecutable, tokenizeCmdLine } from "./proc";
import { PREWARM_DELAY_MS, httpGetJson, httpPostJson, knownServerBase, lastServeLine, setStartupDeadline, stopServer, withDirectory } from "./net";
import { api, serverMajor } from "./oc-api";
import { toolFilePath } from "./metrics";
import { discoverOpenCodeEnv, openCodeConfigModel, readJsonc, summariseEnv } from "./env";
import { isVaguePrompt, planTimeout } from "./prompt";
import { createFileLinker, parseChatPrompt, splitLanePrefixes, splitModelPrefix, splitModelsFanout } from "./context";
import {
    INLINE_PARTICIPANT_ID,
    PARTICIPANT_ID,
    getParticipantProblem,
    handoffChain,
    harnessNote,
    localSessionProblem,
    notifyIfSlow,
    resolveSessionState,
    setParticipantProblem,
    threadSession
} from "./session";
import { contextNote, effortFor, getModelCatalog, higherEffort, modelLabel, parseModelList, parseProviders, parseVerboseModels, resolveModelRef } from "./models";
import { compactSession, emitKeyedDelta, isMissingSessionError, isMissingSessionRun, noteTask, partDeltaOf, providerRetryOf, safeSessionId, sessionPath, sessionRoot, setReplyConfirmWait, stepDetail, readOnlyReach, turnPermission } from "./runs";
import { coldEnforcement, enforcedConfigContent, readOnlyLeaks } from "./enforce";
import { laneProblem } from "./compose";
import { laneAgentProblem, parseAgentList, prewarmFolder } from "./agents";
import { CHILD_MAX_ROWS, GROUP_MAX_ROWS, KIND_COMMAND_NAMES, LANE_ANSWER_CAP, LANE_STORE_CAP, SETTLE_MS, chatStream, commandAliases, outcomeOf, recallLanes, rememberLanes, resolveAlias, retryLanesPrompt, ROUTED_COMMANDS, followupsFor, resetChipBackoff, nextMilestone, splitLanes, startHeartbeat, stepLabel, supportsTaskProgress, suggestFollowups, thoughtLine, SLASH_COMMANDS } from "./chat-boot";
import { handleChat } from "./chat";
import { badge, chipOf, createBadger, followupsProblems } from "./followups";
import { createEchoGate, createLeakGate } from "./format";
import { CONTEXT_HOLD_BYTES } from "./context-markers";
import { laneItems, naturalFollowups } from "./natural";
import { registerCommands } from "./commands-registry";
import { slugify } from "./worktree";
import { registerGitScan } from "./git-scan-mcp";

// Activation is kept deliberately thin. This file owns the participant
// registration (including the follow-up chips keyed on the turn's metadata), the
// __test handle the suite reads, and shutdown; the chat turn, control commands
// and rendering helpers live in ./chat, ./chat-commands and ./chat-boot.

const LOCAL_NOTICE_KEY = "opencode.localSessionNotice";

export function activate(context: vscode.ExtensionContext): void {
    setExtensionContext(context);
    setLogChannel(vscode.window.createOutputChannel("OpenCode"));
    context.subscriptions.push(logChannel);
    // A broken followups.json is logged, never thrown: @opencode must still activate.
    for (const problem of followupsProblems()) {
        logChannel.appendLine(`followups.json: ${problem}`);
    }
    // The chat participant API is deprecated (Copilot harness, VS Code 1.142+):
    // a host without it must still get the palette commands and gitScan (HR).
    setParticipantProblem("");
    try {
        context.subscriptions.push(participant(context, PARTICIPANT_ID, handleChat));
    } catch (err) {
        setParticipantProblem(err instanceof Error ? err.message : String(err));
    }
    const problem = getParticipantProblem();
    logChannel.appendLine(`[${stamp()}] chat harness: VS Code ${vscode.version ?? "?"} · ${harnessNote()}${problem ? ` · @opencode not registered: ${problem}` : ""}`);
    if (problem) {
        void vscode.window.showWarningMessage?.(
            "OpenCode: this VS Code offers no chat participants, so @opencode cannot run. The palette commands and gitScan still work; OpenCode: Diagnose says why."
        );
    } else {
        // Out-of-view news, said once per reason (HR): with Local hidden, Send stays
        // disabled for @opencode and no chat turn of ours ever runs to say it.
        const local = localSessionProblem();
        if (local && context.globalState?.get<string>(LOCAL_NOTICE_KEY) !== local) {
            void context.globalState?.update(LOCAL_NOTICE_KEY, local);
            void vscode.window.showWarningMessage?.(
                `OpenCode: ${local}, and @opencode answers only there. Turn the setting on, or see OpenCode: Diagnose.`,
                "Open Settings"
            )?.then((pick) => pick && vscode.commands.executeCommand("workbench.action.openSettings", "chat.editor.localAgent.enabled"));
        } else if (!local && context.globalState?.get<string>(LOCAL_NOTICE_KEY)) {
            void context.globalState?.update(LOCAL_NOTICE_KEY, undefined);
        }
        // claim:inline-participant — @opencode in inline chat (Ctrl+I). It needs the
        // chatParticipantAdditions proposal; registering it must never take the
        // panel participant down.
        try {
            context.subscriptions.push(
                participant(context, INLINE_PARTICIPANT_ID, (r, c, s, t) => handleChat(r, c, s, t, { inline: true }))
            );
        } catch (err) {
            logChannel.appendLine(`inline @opencode unavailable: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    registerCommands(context);
    registerGitScan(context);
    // claim:prewarm-server — off the activation path, cancelled on deactivate.
    const prewarm = setTimeout(() => void prewarmFolder(), PREWARM_DELAY_MS);
    prewarm.unref?.();
    context.subscriptions.push({ dispose: () => clearTimeout(prewarm) });
}

const participant = (
    context: vscode.ExtensionContext,
    id: string,
    handler: vscode.ChatRequestHandler
): vscode.ChatParticipant => {
    const chat = vscode.chat.createChatParticipant(id, handler);
    chat.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
    // Follow-up chips: see followupsFor() in ./chat-boot. A chip is the ONLY
    // channel for "the next message" (Retry, Continue, Run it anyway); buttons
    // in the reply are for artifacts, toasts for out-of-view news.
    chat.followupProvider = {
        provideFollowups: (result): vscode.ChatFollowup[] =>
            followupsFor((result?.metadata ?? {}) as Record<string, unknown>)
    };
    // Docs (chat follow-ups) ask for success metrics: the host's verdict on a
    // turn (thumbs up/down) goes to the log next to the chip offered/taken
    // lines. Optional-chained: the stub host may not have the event.
    const feedback = (chat as { onDidReceiveFeedback?: vscode.Event<vscode.ChatResultFeedback> }).onDidReceiveFeedback;
    if (feedback) {
        context.subscriptions.push(
            feedback((e) => logChannel.appendLine(`[${stamp()}] turn feedback: ${e.kind}`))
        );
    }
    return chat;
};

export const __test = {
    resolveExecutable,
    emitKeyedDelta,
    toolFilePath,
    parseChatPrompt,
    splitLanes,
    parseModelList,
    getModelCatalog,
    resolveFolder,
    notifyIfSlow,
    safeSessionId,
    api,
    serverMajor,
    knownServerBase,
    readShimTarget,
    tokenizeCmdLine,
    expandShimVar,
    httpGetJson,
    httpPostJson,
    planTimeout,
    isVaguePrompt,
    discoverOpenCodeEnv,
    summariseEnv,
    readJsonc,
    handoffChain,
    withDirectory,
    isMissingSessionError,
    isMissingSessionRun,
    threadSession,
    resolveSessionState,
    slashCommands: [...SLASH_COMMANDS],
    kindCommands: [...KIND_COMMAND_NAMES],
    routedCommands: [...ROUTED_COMMANDS],
    suggestFollowups,
    thoughtLine,
    nextMilestone,
    slugify,
    sessionPath,
    supportsTaskProgress,
    startHeartbeat,
    stepLabel,
    GROUP_MAX_ROWS,
    badge,
    naturalFollowups: (input: Parameters<typeof naturalFollowups>[0], max?: number) => naturalFollowups(input, max, splitLanes),
    laneItems,
    effortFor,
    higherEffort,
    contextNote,
    stepDetail,
    createFileLinker,
    chatStream,
    SETTLE_MS,
    parseAgentList,
    openCodeConfigModel,
    compactSession,
    noteTask,
    chipOf,
    createBadger,
    followupsProblems,
    parseVerboseModels,
    parseProviders,
    resolveModelRef,
    modelLabel,
    splitModelPrefix,
    splitModelsFanout,
    resolveAlias,
    commandAliases,
    laneProblem,
    rememberLanes,
    recallLanes,
    LANE_STORE_CAP,
    LANE_ANSWER_CAP,
    sessionRoot,
    splitLanePrefixes,
    laneAgentProblem,
    retryLanesPrompt,
    turnPermission,
    readOnlyReach,
    enforcedConfigContent,
    coldEnforcement,
    readOnlyLeaks,
    lastServeLine,
    setStartupDeadline,
    setReplyConfirmWait,
    resetChipBackoff,
    CHILD_MAX_ROWS,
    // What activation schedules: the server, then the folder's agent list.
    prewarmServer: prewarmFolder,
    createLeakGate,
    CONTEXT_HOLD_BYTES,
    createEchoGate,
    partDeltaOf,
    providerRetryOf,
    outcomeOf
};

export function deactivate(): void {
    stopServer();
}
