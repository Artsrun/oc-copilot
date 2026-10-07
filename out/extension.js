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
exports.__test = void 0;
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const core_1 = require("./core");
const proc_1 = require("./proc");
const net_1 = require("./net");
const metrics_1 = require("./metrics");
const env_1 = require("./env");
const prompt_1 = require("./prompt");
const context_1 = require("./context");
const session_1 = require("./session");
const models_1 = require("./models");
const runs_1 = require("./runs");
const compose_1 = require("./compose");
const agents_1 = require("./agents");
const chat_boot_1 = require("./chat-boot");
const chat_1 = require("./chat");
const followups_1 = require("./followups");
const format_1 = require("./format");
const natural_1 = require("./natural");
const commands_registry_1 = require("./commands-registry");
const worktree_1 = require("./worktree");
function activate(context) {
    (0, core_1.setExtensionContext)(context);
    (0, core_1.setLogChannel)(vscode.window.createOutputChannel("OpenCode"));
    context.subscriptions.push(core_1.logChannel);
    for (const problem of (0, followups_1.followupsProblems)()) {
        core_1.logChannel.appendLine(`followups.json: ${problem}`);
    }
    context.subscriptions.push(participant(context, session_1.PARTICIPANT_ID, chat_1.handleChat));
    try {
        context.subscriptions.push(participant(context, session_1.INLINE_PARTICIPANT_ID, (r, c, s, t) => (0, chat_1.handleChat)(r, c, s, t, { inline: true })));
    }
    catch (err) {
        core_1.logChannel.appendLine(`inline @opencode unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    (0, commands_registry_1.registerCommands)(context);
    const prewarm = setTimeout(() => void (0, net_1.prewarmServer)(), net_1.PREWARM_DELAY_MS);
    prewarm.unref?.();
    context.subscriptions.push({ dispose: () => clearTimeout(prewarm) });
}
const participant = (context, id, handler) => {
    const chat = vscode.chat.createChatParticipant(id, handler);
    chat.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
    chat.followupProvider = {
        provideFollowups: (result) => (0, chat_boot_1.followupsFor)((result?.metadata ?? {}))
    };
    const feedback = chat.onDidReceiveFeedback;
    if (feedback) {
        context.subscriptions.push(feedback((e) => core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] turn feedback: ${e.kind}`)));
    }
    return chat;
};
exports.__test = {
    resolveExecutable: proc_1.resolveExecutable,
    emitKeyedDelta: runs_1.emitKeyedDelta,
    toolFilePath: metrics_1.toolFilePath,
    parseChatPrompt: context_1.parseChatPrompt,
    splitLanes: chat_boot_1.splitLanes,
    parseModelList: models_1.parseModelList,
    getModelCatalog: models_1.getModelCatalog,
    resolveFolder: core_1.resolveFolder,
    notifyIfSlow: session_1.notifyIfSlow,
    safeSessionId: runs_1.safeSessionId,
    readShimTarget: proc_1.readShimTarget,
    tokenizeCmdLine: proc_1.tokenizeCmdLine,
    expandShimVar: proc_1.expandShimVar,
    httpGetJson: net_1.httpGetJson,
    httpPostJson: net_1.httpPostJson,
    planTimeout: prompt_1.planTimeout,
    isVaguePrompt: prompt_1.isVaguePrompt,
    discoverOpenCodeEnv: env_1.discoverOpenCodeEnv,
    summariseEnv: env_1.summariseEnv,
    readJsonc: env_1.readJsonc,
    handoffChain: session_1.handoffChain,
    withDirectory: net_1.withDirectory,
    isMissingSessionError: runs_1.isMissingSessionError,
    isMissingSessionRun: runs_1.isMissingSessionRun,
    threadSession: session_1.threadSession,
    resolveSessionState: session_1.resolveSessionState,
    slashCommands: [...chat_boot_1.SLASH_COMMANDS],
    kindCommands: [...chat_boot_1.KIND_COMMAND_NAMES],
    routedCommands: [...chat_boot_1.ROUTED_COMMANDS],
    suggestFollowups: chat_boot_1.suggestFollowups,
    thoughtLine: chat_boot_1.thoughtLine,
    nextMilestone: chat_boot_1.nextMilestone,
    slugify: worktree_1.slugify,
    sessionPath: runs_1.sessionPath,
    supportsTaskProgress: chat_boot_1.supportsTaskProgress,
    startHeartbeat: chat_boot_1.startHeartbeat,
    stepLabel: chat_boot_1.stepLabel,
    GROUP_MAX_ROWS: chat_boot_1.GROUP_MAX_ROWS,
    badge: followups_1.badge,
    badgeMarks: followups_1.badgeMarks,
    naturalFollowups: (input, max) => (0, natural_1.naturalFollowups)(input, max, chat_boot_1.splitLanes),
    laneItems: natural_1.laneItems,
    effortFor: models_1.effortFor,
    higherEffort: models_1.higherEffort,
    contextNote: models_1.contextNote,
    stepDetail: runs_1.stepDetail,
    createFileLinker: context_1.createFileLinker,
    chatStream: chat_boot_1.chatStream,
    SETTLE_MS: chat_boot_1.SETTLE_MS,
    parseAgentList: agents_1.parseAgentList,
    openCodeConfigModel: env_1.openCodeConfigModel,
    compactSession: runs_1.compactSession,
    noteTask: runs_1.noteTask,
    chipOf: followups_1.chipOf,
    createBadger: followups_1.createBadger,
    followupsProblems: followups_1.followupsProblems,
    parseVerboseModels: models_1.parseVerboseModels,
    parseProviders: models_1.parseProviders,
    resolveModelRef: models_1.resolveModelRef,
    modelLabel: models_1.modelLabel,
    splitModelPrefix: context_1.splitModelPrefix,
    splitModelsFanout: context_1.splitModelsFanout,
    resolveAlias: chat_boot_1.resolveAlias,
    commandAliases: chat_boot_1.commandAliases,
    laneProblem: compose_1.laneProblem,
    rememberLanes: chat_boot_1.rememberLanes,
    recallLanes: chat_boot_1.recallLanes,
    LANE_STORE_CAP: chat_boot_1.LANE_STORE_CAP,
    LANE_ANSWER_CAP: chat_boot_1.LANE_ANSWER_CAP,
    sessionRoot: runs_1.sessionRoot,
    splitLanePrefixes: context_1.splitLanePrefixes,
    laneAgentProblem: agents_1.laneAgentProblem,
    retryLanesPrompt: chat_boot_1.retryLanesPrompt,
    turnPermission: runs_1.turnPermission,
    lastServeLine: net_1.lastServeLine,
    setStartupDeadline: net_1.setStartupDeadline,
    setReplyConfirmWait: runs_1.setReplyConfirmWait,
    resetChipBackoff: chat_boot_1.resetChipBackoff,
    CHILD_MAX_ROWS: chat_boot_1.CHILD_MAX_ROWS,
    prewarmServer: net_1.prewarmServer,
    createLeakGate: format_1.createLeakGate,
    createEchoGate: format_1.createEchoGate,
    partDeltaOf: runs_1.partDeltaOf,
    providerRetryOf: runs_1.providerRetryOf,
    outcomeOf: chat_boot_1.outcomeOf
};
function deactivate() {
    (0, net_1.stopServer)();
}
//# sourceMappingURL=extension.js.map