import * as vscode from "vscode";
import { config, logChannel } from "./core";

export function registerGitScan(context: vscode.ExtensionContext): void {
    const source = vscode.Uri.joinPath(context.extensionUri, "out", "git-scan-server.js");
    const storage = context.globalStorageUri;
    let copy: Promise<vscode.Uri> | undefined;
    const stableServer = (): Promise<vscode.Uri> => {
        if (!storage) return Promise.reject(new Error("Global storage unavailable"));
        if (!copy) copy = (async () => {
            const target = vscode.Uri.joinPath(storage, "git-scan-server.js");
            await vscode.workspace.fs.createDirectory(storage);
            await vscode.workspace.fs.writeFile(target, await vscode.workspace.fs.readFile(source));
            return target;
        })().catch((error: unknown) => { copy = undefined; throw error; });
        return copy;
    };
    if (storage) void stableServer().catch((error: unknown) => logChannel.appendLine(`gitScan copy: ${String(error)}`));
    const folder = (): vscode.Uri | undefined => {
        const uri = vscode.workspace.workspaceFolders?.[0]?.uri;
        return vscode.workspace.isTrusted && config().get<boolean>("gitScan", true) && uri?.scheme === "file" ? uri : undefined;
    };
    context.subscriptions.push(vscode.commands.registerCommand("opencodeCopilotBridge.gitScanConfig", async () => {
        const cwd = folder();
        if (!cwd) { void vscode.window.showInformationMessage("gitScan needs an enabled setting and a trusted local workspace."); return; }
        try {
            const server = await stableServer();
            const snippet = JSON.stringify({
                $schema: "https://opencode.ai/config.json",
                mcp: { "git-scan": { type: "local", command: ["node", server.fsPath, cwd.fsPath], enabled: true } }
            }, null, 4);
            logChannel.appendLine(snippet);
            logChannel.show();
            await vscode.env.clipboard?.writeText?.(snippet);
            void vscode.window.showInformationMessage("gitScan config copied and printed in OpenCode output. Merge it into opencode.json, then restart OpenCode and the bridge window.");
        } catch (error) { void vscode.window.showErrorMessage(`gitScan config: ${String(error)}`); }
    }));
    if (!vscode.lm?.registerMcpServerDefinitionProvider || !vscode.McpStdioServerDefinition || !vscode.EventEmitter) return;
    const changed = new vscode.EventEmitter<void>();
    const provider: vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> = {
        onDidChangeMcpServerDefinitions: changed.event,
        // claim:git-scan — Copilot MCP definitions exist only for a trusted local first folder.
        provideMcpServerDefinitions: (token) => {
            const cwd = folder();
            if (!cwd || token.isCancellationRequested) return [];
            const definition = new vscode.McpStdioServerDefinition("gitScan", process.execPath, [source.fsPath, cwd.fsPath], { ELECTRON_RUN_AS_NODE: "1" }, context.extension?.packageJSON.version);
            definition.cwd = cwd;
            return [definition];
        },
        resolveMcpServerDefinition: (server, token) => {
            const cwd = folder();
            return cwd && !token.isCancellationRequested && server.cwd?.fsPath === cwd.fsPath ? server : undefined;
        }
    };
    context.subscriptions.push(changed, vscode.lm.registerMcpServerDefinitionProvider("opencodeCopilotBridge.gitScan", provider));
    for (const disposable of [
        vscode.workspace.onDidGrantWorkspaceTrust?.(() => changed.fire()),
        vscode.workspace.onDidChangeWorkspaceFolders?.(() => changed.fire()),
        vscode.workspace.onDidChangeConfiguration?.((event) => { if (event.affectsConfiguration("opencodeCopilotBridge.gitScan")) changed.fire(); })
    ]) if (disposable) context.subscriptions.push(disposable);
}
