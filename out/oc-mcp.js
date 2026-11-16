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
exports.installMcpServer = installMcpServer;
exports.userSettings = userSettings;
exports.mcpEntry = mcpEntry;
exports.copilotConfigNote = copilotConfigNote;
exports.registerOcMcp = registerOcMcp;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const core_1 = require("./core");
const host_1 = require("./host");
const SERVER = "oc-mcp-server.js";
const SETTINGS = "engine-settings.json";
const PREFIX = "opencodeCopilotBridge.";
let installed;
let installing;
function installMcpServer(context) {
    if (!installing) {
        installing = (async () => {
            const storage = context.globalStorageUri?.fsPath;
            if (!storage) {
                throw new Error("Global storage unavailable");
            }
            const source = path.join(context.extensionUri.fsPath, "out");
            const dir = path.join(storage, "oc-mcp");
            const version = String(context.extension?.packageJSON?.version ?? "?");
            const marker = `${version} ${Math.round((await fs.promises.stat(path.join(source, SERVER))).mtimeMs)}`;
            const markerFile = path.join(dir, "version");
            const had = await fs.promises.readFile(markerFile, "utf8").catch(() => "");
            if (had !== marker) {
                await fs.promises.mkdir(dir, { recursive: true });
                const files = (await fs.promises.readdir(source)).filter((f) => f.endsWith(".js") || f.endsWith(".json"));
                await Promise.all(files.map((f) => fs.promises.copyFile(path.join(source, f), path.join(dir, f))));
                await fs.promises.writeFile(markerFile, marker);
                core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] MCP server ${version} copied to ${dir} (${files.length} files)`);
            }
            installed = { dir, version };
            return dir;
        })().catch((error) => {
            installing = undefined;
            throw error;
        });
    }
    return installing;
}
function userSettings(context) {
    const declared = context.extension?.packageJSON?.contributes?.configuration;
    const groups = (Array.isArray(declared) ? declared : [declared]);
    const settings = (0, host_1.vsConfig)();
    const values = {};
    for (const name of groups.flatMap((group) => Object.keys(group?.properties ?? {}))) {
        if (!name.startsWith(PREFIX)) {
            continue;
        }
        const key = name.slice(PREFIX.length);
        const value = settings.inspect?.(key)?.globalValue;
        if (value !== undefined) {
            values[key] = value;
        }
    }
    return values;
}
async function writeSettings(context) {
    const dir = await installMcpServer(context);
    const file = path.join(dir, SETTINGS);
    const text = JSON.stringify({ version: installed?.version, settings: userSettings(context) }, null, 2) + "\n";
    if ((await fs.promises.readFile(file, "utf8").catch(() => "")) === text) {
        return;
    }
    const draft = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(draft, text);
    await fs.promises.rename(draft, file);
}
const nodeOnPath = () => (process.env.PATH ?? process.env.Path ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => (process.platform === "win32" ? ["node.exe", "node.cmd"] : ["node"]).some((name) => fs.existsSync(path.join(dir, name))));
function mcpEntry(dir, hasNode = nodeOnPath()) {
    const args = [path.join(dir, SERVER), "--settings", path.join(dir, SETTINGS), "--log", path.join(dir, "oc-mcp.log")];
    return hasNode
        ? { type: "stdio", command: "node", args }
        : { type: "stdio", command: process.execPath, args, env: { ELECTRON_RUN_AS_NODE: "1" } };
}
function copilotConfigNote(file = path.join(os.homedir(), ".copilot", "mcp-config.json")) {
    if (!installed) {
        return "the server is not copied yet (see the OpenCode output)";
    }
    const where = `server ${installed.version} in \`${installed.dir}\``;
    let text;
    try {
        text = fs.readFileSync(file, "utf8");
    }
    catch {
        return `${where} · no \`${file}\`: **OpenCode: Copy MCP Config for Copilot** gives the entry`;
    }
    const named = [path.join(installed.dir, SERVER), JSON.stringify(path.join(installed.dir, SERVER)).slice(1, -1)].some((p) => text.includes(p));
    return named
        ? `${where} · \`${file}\` names it`
        : `${where} · \`${file}\` does not name it: **OpenCode: Copy MCP Config for Copilot** gives the entry`;
}
function registerOcMcp(context) {
    const refresh = () => void writeSettings(context).catch((error) => core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] MCP server copy: ${String(error)}`));
    refresh();
    const changed = vscode.workspace.onDidChangeConfiguration?.((event) => {
        if (event.affectsConfiguration("opencodeCopilotBridge")) {
            refresh();
        }
    });
    if (changed) {
        context.subscriptions.push(changed);
    }
    context.subscriptions.push(vscode.commands.registerCommand("opencodeCopilotBridge.copilotMcpConfig", async () => {
        try {
            await writeSettings(context);
            const dir = await installMcpServer(context);
            const snippet = JSON.stringify({ mcpServers: { opencode: mcpEntry(dir) } }, null, 4);
            core_1.logChannel.appendLine(snippet);
            core_1.logChannel.show();
            await vscode.env.clipboard?.writeText?.(snippet);
            void vscode.window.showInformationMessage("OpenCode MCP config copied and printed in the OpenCode output. Merge its `mcpServers.opencode` entry into `~/.copilot/mcp-config.json`, then start a new Copilot chat. " +
                "It offers the read-only `opencode_ask`; add `\"--dev\"` to its `args` for `opencode_dev`, which edits files.");
        }
        catch (error) {
            void vscode.window.showErrorMessage(`OpenCode MCP config: ${String(error)}`);
        }
    }));
}
//# sourceMappingURL=oc-mcp.js.map