import * as vscode from "vscode";

import { logChannel, resolveFolder, setExtensionContext, setLogChannel } from "./core";
import { expandShimVar, readShimTarget, resolveExecutable, tokenizeCmdLine } from "./proc";
import { httpGetJson, httpPostJson, stopServer, withDirectory } from "./net";
import { toolFilePath } from "./metrics";
import { discoverOpenCodeEnv, openCodeConfigModel, readJsonc, summariseEnv } from "./env";
import { isVaguePrompt, planTimeout } from "./prompt";
import { parseChatPrompt, splitModelPrefix, splitModelsFanout } from "./context";
import {
    LiveSessionTracker,
    INLINE_PARTICIPANT_ID,
    PARTICIPANT_ID,
    handoffChain,
    notifyIfSlow,
    resolveSessionState,
    threadFlows,
    threadSession
} from "./session";
import { getModelCatalog, modelLabel, parseModelList, parseProviders, parseVerboseModels, resolveModelRef } from "./models";
import { compactSession, emitKeyedDelta, isMissingSessionError, isMissingSessionRun, safeSessionId, sessionPath, sessionRoot } from "./runs";
import { laneProblem } from "./compose";
import { parseAgentList } from "./agents";
import { GROUP_MAX_ROWS, KIND_COMMAND_NAMES, SETTLE_MS, chatStream, commandAliases, resolveAlias, ROUTED_COMMANDS, followupsFor, nextMilestone, splitLanes, startHeartbeat, stepLabel, supportsTaskProgress, suggestFollowups, thoughtLine, SLASH_COMMANDS } from "./chat-boot";
import { handleChat } from "./chat";
import { badge, badgeMarks, chipOf, createBadger, followupsProblems } from "./followups";
import { naturalFollowups } from "./natural";
import { registerCommands } from "./commands-registry";
import { slugify } from "./worktree";
import { MAX_NODES, flowAdd, flowById, flowSummary, newTrace, rememberFlow, toMermaid } from "./flow";

// Activation is kept deliberately thin. This file owns the participant
// registration (including the follow-up chips keyed on the turn's metadata), the
// __test handle the suite reads, and shutdown; the chat turn, control commands
// and rendering helpers live in ./chat, ./chat-commands and ./chat-boot.

export function activate(context: vscode.ExtensionContext): void {
    setExtensionContext(context);
    setLogChannel(vscode.window.createOutputChannel("OpenCode"));
    context.subscriptions.push(logChannel);
    // A broken followups.json is logged, never thrown: @opencode must still activate.
    for (const problem of followupsProblems()) {
        logChannel.appendLine(`followups.json: ${problem}`);
    }
    context.subscriptions.push(participant(context, PARTICIPANT_ID, handleChat));
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
    registerCommands(context);
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
    LiveSessionTracker,
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
    badgeMarks,
    naturalFollowups,
    chatStream,
    SETTLE_MS,
    parseAgentList,
    openCodeConfigModel,
    compactSession,
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
    MAX_NODES,
    flowAdd,
    flowById,
    flowSummary,
    newTrace,
    rememberFlow,
    threadFlows,
    toMermaid,
    laneProblem,
    sessionRoot
};

export function deactivate(): void {
    stopServer();
}