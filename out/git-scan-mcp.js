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
exports.registerGitScan = registerGitScan;
const vscode = __importStar(require("vscode"));
const core_1 = require("./core");
function registerGitScan(context) {
    const source = vscode.Uri.joinPath(context.extensionUri, "out", "git-scan-server.js");
    const storage = context.globalStorageUri;
    let copy;
    const stableServer = () => {
        if (!storage)
            return Promise.reject(new Error("Global storage unavailable"));
        if (!copy)
            copy = (async () => {
                const target = vscode.Uri.joinPath(storage, "git-scan-server.js");
                await vscode.workspace.fs.createDirectory(storage);
                await vscode.workspace.fs.writeFile(target, await vscode.workspace.fs.readFile(source));
                return target;
            })().catch((error) => { copy = undefined; throw error; });
        return copy;
    };
    if (storage)
        void stableServer().catch((error) => core_1.logChannel.appendLine(`gitScan copy: ${String(error)}`));
    const folder = () => {
        const uri = vscode.workspace.workspaceFolders?.[0]?.uri;
        return vscode.workspace.isTrusted && (0, core_1.config)().get("gitScan", true) && uri?.scheme === "file" ? uri : undefined;
    };
    context.subscriptions.push(vscode.commands.registerCommand("opencodeCopilotBridge.gitScanConfig", async () => {
        const cwd = folder();
        if (!cwd) {
            void vscode.window.showInformationMessage("gitScan needs an enabled setting and a trusted local workspace.");
            return;
        }
        try {
            const server = await stableServer();
            const snippet = JSON.stringify({
                $schema: "https://opencode.ai/config.json",
                mcp: { "git-scan": { type: "local", command: ["node", server.fsPath, cwd.fsPath], enabled: true } }
            }, null, 4);
            core_1.logChannel.appendLine(snippet);
            core_1.logChannel.show();
            await vscode.env.clipboard?.writeText?.(snippet);
            void vscode.window.showInformationMessage("gitScan config copied and printed in OpenCode output. Merge it into opencode.json, then restart OpenCode and the bridge window.");
        }
        catch (error) {
            void vscode.window.showErrorMessage(`gitScan config: ${String(error)}`);
        }
    }));
    if (!vscode.lm?.registerMcpServerDefinitionProvider || !vscode.McpStdioServerDefinition || !vscode.EventEmitter)
        return;
    const changed = new vscode.EventEmitter();
    const provider = {
        onDidChangeMcpServerDefinitions: changed.event,
        provideMcpServerDefinitions: (token) => {
            const cwd = folder();
            if (!cwd || token.isCancellationRequested)
                return [];
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
        vscode.workspace.onDidChangeConfiguration?.((event) => { if (event.affectsConfiguration("opencodeCopilotBridge.gitScan"))
            changed.fire(); })
    ])
        if (disposable)
            context.subscriptions.push(disposable);
}
//# sourceMappingURL=git-scan-mcp.js.map