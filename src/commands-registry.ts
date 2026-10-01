import * as vscode from "vscode";
import { activeCwd, config, logChannel, resolveFolder } from "./core";
import { getModelCatalog, setDefaultModel } from "./models";
import { diagnose, quickActions } from "./commands";
import { chatQuery, composeParallel, insertIntoChat } from "./compose";
import { refreshStatus, setActiveSession } from "./session";
import { removeWorktree, worktreeDiff } from "./worktree";

// Every non-chat command in the manifest, registered once at activation. The
// chat-generated commands (`/new`, `/model`, …) are handled inside handleChat;
// these are the toolbar, palette, and follow-up-button commands that must reach
// Copilot Chat regardless of whether a participant exists.
export function registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand("opencodeCopilotBridge.setModel", () => setDefaultModel()),
        vscode.commands.registerCommand("opencodeCopilotBridge.showLog", () => logChannel.show()),
        vscode.commands.registerCommand("opencodeCopilotBridge.diagnose", () => diagnose()),
        vscode.commands.registerCommand("opencodeCopilotBridge.refreshModels", async () => {
            const settings = config();
            const cwd = activeCwd();
            const catalog = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: "Refreshing the OpenCode model catalog",
                    cancellable: false
                },
                () => getModelCatalog(settings.get<string>("executable", "opencode"), cwd, { force: true })
            );
            void vscode.window.showInformationMessage(
                catalog.source === "live"
                    ? `OpenCode: cached ${catalog.models.length} models.`
                    : `OpenCode: could not reach the CLI — still using ${catalog.models.length} model(s) from the ${catalog.source} tier.`
            );
        }),
        vscode.commands.registerCommand("opencodeCopilotBridge.quickActions", () => quickActions()),
        // /worktree buttons: arguments come from the button the run rendered.
        vscode.commands.registerCommand("opencodeCopilotBridge.worktreeDiff", async (wt?: { path: string; baseSha: string; branch: string }) => {
            if (!wt?.path) {
                return;
            }
            const doc = await vscode.workspace.openTextDocument({ content: (await worktreeDiff(wt, false, config().get<number>("worktreeDiffMaxMB", 16))) || "(no changes)", language: "diff" });
            await vscode.window.showTextDocument(doc, { preview: true });
        }),
        vscode.commands.registerCommand("opencodeCopilotBridge.worktreeOpen", async (wt?: { path: string }) => {
            if (wt?.path) {
                await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(wt.path), { forceNewWindow: true });
            }
        }),
        vscode.commands.registerCommand("opencodeCopilotBridge.worktreeRemove", async (wt?: { root: string; path: string; branch: string }) => {
            if (!wt?.path) {
                return;
            }
            const pick = await vscode.window.showWarningMessage(
                `Remove worktree ${wt.path} and delete branch ${wt.branch}? Uncommitted changes there are lost.`,
                { modal: true },
                "Remove"
            );
            if (pick !== "Remove") {
                return;
            }
            const res = await removeWorktree(wt.root, wt.path, wt.branch);
            void (res.code === 0
                ? vscode.window.showInformationMessage(`Removed ${wt.path} and ${wt.branch}.`)
                : vscode.window.showErrorMessage(`git worktree remove failed: ${res.stderr.trim()}`));
        }),
        vscode.commands.registerCommand("opencodeCopilotBridge.retryLast", async (promptArg?: string) => {
            // With no prompt: open the chat with `@opencode ` typed. `chat.open`
            // without isPartialQuery SUBMITS (chatActions.ts); only an explicit
            // prompt is sent.
            const text = typeof promptArg === "string" ? promptArg.trim() : "";
            const query = text ? `@opencode ${text}` : "@opencode ";
            try {
                await vscode.commands.executeCommand(
                    "workbench.action.chat.open",
                    text ? { query } : { query, isPartialQuery: true }
                );
            } catch {
                await vscode.env.clipboard?.writeText?.(query);
                void vscode.window.showInformationMessage(
                    "Copied the prompt to the clipboard — paste it into Copilot Chat."
                );
            }
        }),
        // The only reset that clears what the user can SEE: `/new` resets the
        // OpenCode session, this resets the Copilot thread around it. A brand-new
        // thread has no history for threadSession() to walk, so a fresh session
        // follows for free. Both command ids are tried because the host owns
        // their naming, and failing to open a chat must never throw.
        vscode.commands.registerCommand("opencodeCopilotBridge.newChat", async () => {
            for (const id of ["workbench.action.chat.newChat", "workbench.action.chat.new"]) {
                try {
                    await vscode.commands.executeCommand(id);
                    // Prefill the participant so the empty thread is one keystroke
                    // from useful rather than one more thing to remember to type.
                    try {
                        await vscode.commands.executeCommand("workbench.action.chat.open", {
                            query: "@opencode ",
                            isPartialQuery: true
                        });
                    } catch {
                        // The thread is open and empty; the prefill is a nicety.
                    }
                    return;
                } catch {
                    // Try the next id.
                }
            }
            void vscode.window.showInformationMessage(
                "OpenCode: this VS Code build has no \"new chat\" command — use the + button in the Chat view."
            );
        }),
        // v190: New Session = a new chat with `@opencode ` typed. A new thread
        // has no history, so its first message starts a fresh OpenCode session;
        // the chat you left keeps its own. It replaces "Ask OpenCode" (same
        // chat, `@opencode ` typed) and the old submit of `/new` into the
        // current chat. Under workspace scope the folder pointer is reset too.
        vscode.commands.registerCommand("opencodeCopilotBridge.newSession", async () => {
            const cwd = resolveFolder()?.folder.uri.fsPath;
            if (cwd && config().get<string>("sessionScope", "thread") === "workspace") {
                await setActiveSession(cwd, { turns: 0 });
                refreshStatus(cwd);
            }
            await vscode.commands.executeCommand("opencodeCopilotBridge.newChat");
        }),
        // `@opencode /sessions` in the chat: the list needs a chat to bind to.
        vscode.commands.registerCommand("opencodeCopilotBridge.sessions", async () => {
            try {
                await vscode.commands.executeCommand("workbench.action.chat.open", { query: "@opencode /sessions" });
            } catch {
                void vscode.window.showInformationMessage("OpenCode: send `@opencode /sessions` in a chat.");
            }
        }),
        vscode.commands.registerCommand("opencodeCopilotBridge.composeParallel", async () => {
            const lanes = await composeParallel();
            if (lanes && !(await insertIntoChat(chatQuery(lanes)))) {
                await vscode.env.clipboard?.writeText?.(chatQuery(lanes));
                void vscode.window.showInformationMessage("Copied the /parallel command — paste it into Copilot Chat.");
            }
        }),
        vscode.workspace.onDidChangeConfiguration?.((event) => {
            if (event.affectsConfiguration("opencodeCopilotBridge")) {
                refreshStatus();
            }
        }) ?? { dispose: () => undefined }
    );
    refreshStatus();
}