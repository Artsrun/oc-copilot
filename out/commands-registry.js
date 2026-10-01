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
exports.registerCommands = registerCommands;
const vscode = __importStar(require("vscode"));
const core_1 = require("./core");
const models_1 = require("./models");
const commands_1 = require("./commands");
const compose_1 = require("./compose");
const session_1 = require("./session");
const worktree_1 = require("./worktree");
function registerCommands(context) {
    context.subscriptions.push(vscode.commands.registerCommand("opencodeCopilotBridge.setModel", () => (0, models_1.setDefaultModel)()), vscode.commands.registerCommand("opencodeCopilotBridge.showLog", () => core_1.logChannel.show()), vscode.commands.registerCommand("opencodeCopilotBridge.diagnose", () => (0, commands_1.diagnose)()), vscode.commands.registerCommand("opencodeCopilotBridge.refreshModels", async () => {
        const settings = (0, core_1.config)();
        const cwd = (0, core_1.activeCwd)();
        const catalog = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Refreshing the OpenCode model catalog",
            cancellable: false
        }, () => (0, models_1.getModelCatalog)(settings.get("executable", "opencode"), cwd, { force: true }));
        void vscode.window.showInformationMessage(catalog.source === "live"
            ? `OpenCode: cached ${catalog.models.length} models.`
            : `OpenCode: could not reach the CLI — still using ${catalog.models.length} model(s) from the ${catalog.source} tier.`);
    }), vscode.commands.registerCommand("opencodeCopilotBridge.quickActions", () => (0, commands_1.quickActions)()), vscode.commands.registerCommand("opencodeCopilotBridge.worktreeDiff", async (wt) => {
        if (!wt?.path) {
            return;
        }
        const doc = await vscode.workspace.openTextDocument({ content: (await (0, worktree_1.worktreeDiff)(wt, false, (0, core_1.config)().get("worktreeDiffMaxMB", 16))) || "(no changes)", language: "diff" });
        await vscode.window.showTextDocument(doc, { preview: true });
    }), vscode.commands.registerCommand("opencodeCopilotBridge.worktreeOpen", async (wt) => {
        if (wt?.path) {
            await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(wt.path), { forceNewWindow: true });
        }
    }), vscode.commands.registerCommand("opencodeCopilotBridge.worktreeRemove", async (wt) => {
        if (!wt?.path) {
            return;
        }
        const pick = await vscode.window.showWarningMessage(`Remove worktree ${wt.path} and delete branch ${wt.branch}? Uncommitted changes there are lost.`, { modal: true }, "Remove");
        if (pick !== "Remove") {
            return;
        }
        const res = await (0, worktree_1.removeWorktree)(wt.root, wt.path, wt.branch);
        void (res.code === 0
            ? vscode.window.showInformationMessage(`Removed ${wt.path} and ${wt.branch}.`)
            : vscode.window.showErrorMessage(`git worktree remove failed: ${res.stderr.trim()}`));
    }), vscode.commands.registerCommand("opencodeCopilotBridge.retryLast", async (promptArg) => {
        const text = typeof promptArg === "string" ? promptArg.trim() : "";
        const query = text ? `@opencode ${text}` : "@opencode ";
        try {
            await vscode.commands.executeCommand("workbench.action.chat.open", text ? { query } : { query, isPartialQuery: true });
        }
        catch {
            await vscode.env.clipboard?.writeText?.(query);
            void vscode.window.showInformationMessage("Copied the prompt to the clipboard — paste it into Copilot Chat.");
        }
    }), vscode.commands.registerCommand("opencodeCopilotBridge.newChat", async () => {
        for (const id of ["workbench.action.chat.newChat", "workbench.action.chat.new"]) {
            try {
                await vscode.commands.executeCommand(id);
                try {
                    await vscode.commands.executeCommand("workbench.action.chat.open", {
                        query: "@opencode ",
                        isPartialQuery: true
                    });
                }
                catch {
                }
                return;
            }
            catch {
            }
        }
        void vscode.window.showInformationMessage("OpenCode: this VS Code build has no \"new chat\" command — use the + button in the Chat view.");
    }), vscode.commands.registerCommand("opencodeCopilotBridge.newSession", async () => {
        const cwd = (0, core_1.resolveFolder)()?.folder.uri.fsPath;
        if (cwd && (0, core_1.config)().get("sessionScope", "thread") === "workspace") {
            await (0, session_1.setActiveSession)(cwd, { turns: 0 });
            (0, session_1.refreshStatus)(cwd);
        }
        await vscode.commands.executeCommand("opencodeCopilotBridge.newChat");
    }), vscode.commands.registerCommand("opencodeCopilotBridge.sessions", async () => {
        try {
            await vscode.commands.executeCommand("workbench.action.chat.open", { query: "@opencode /sessions" });
        }
        catch {
            void vscode.window.showInformationMessage("OpenCode: send `@opencode /sessions` in a chat.");
        }
    }), vscode.commands.registerCommand("opencodeCopilotBridge.composeParallel", async () => {
        const lanes = await (0, compose_1.composeParallel)();
        if (lanes && !(await (0, compose_1.insertIntoChat)((0, compose_1.chatQuery)(lanes)))) {
            await vscode.env.clipboard?.writeText?.((0, compose_1.chatQuery)(lanes));
            void vscode.window.showInformationMessage("Copied the /parallel command — paste it into Copilot Chat.");
        }
    }), vscode.workspace.onDidChangeConfiguration?.((event) => {
        if (event.affectsConfiguration("opencodeCopilotBridge")) {
            (0, session_1.refreshStatus)();
        }
    }) ?? { dispose: () => undefined });
    (0, session_1.refreshStatus)();
}
//# sourceMappingURL=commands-registry.js.map