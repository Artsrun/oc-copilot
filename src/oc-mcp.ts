// VS Code's side of the MCP server (oc-mcp-server.ts): a stable copy of the engine
// in global storage, the settings that process reads, and the config entry a
// client needs. The Copilot harness does not get an extension's MCP servers
// (vscode#343729): it reads the user's own `mcp-config.json`, so the entry is
// copied for the user to put there, never written for them.
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { logChannel, stamp } from "./core";
import { vsConfig } from "./host";

const SERVER = "oc-mcp-server.js";
const SETTINGS = "engine-settings.json";
const PREFIX = "opencodeCopilotBridge.";

let installed: { dir: string; version: string } | undefined;
let installing: Promise<string> | undefined;

/** The engine as it is in `out/`, copied where an update does not move it: the
 * extension's own folder is named by its version. Copied again when the version or
 * the build changes; the marker is written last, so a half copy is copied again. */
export function installMcpServer(context: vscode.ExtensionContext): Promise<string> {
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
                logChannel.appendLine(`[${stamp()}] MCP server ${version} copied to ${dir} (${files.length} files)`);
            }
            installed = { dir, version };
            return dir;
        })().catch((error: unknown) => {
            installing = undefined;
            throw error;
        });
    }
    return installing;
}

/** The settings as the user set them for every window. A workspace's values are
 * left out: the server is one per machine, and a folder must not choose what it
 * starts (the manifest's `restrictedConfigurations`, for a process with no trust). */
export function userSettings(context: vscode.ExtensionContext): Record<string, unknown> {
    // The manifest lists its settings in titled groups (or, in one object, at once).
    const declared = context.extension?.packageJSON?.contributes?.configuration as unknown;
    const groups = (Array.isArray(declared) ? declared : [declared]) as Array<{ properties?: Record<string, unknown> } | undefined>;
    const settings = vsConfig();
    const values: Record<string, unknown> = {};
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

async function writeSettings(context: vscode.ExtensionContext): Promise<void> {
    const dir = await installMcpServer(context);
    const file = path.join(dir, SETTINGS);
    const text = JSON.stringify({ version: installed?.version, settings: userSettings(context) }, null, 2) + "\n";
    if ((await fs.promises.readFile(file, "utf8").catch(() => "")) === text) {
        return;
    }
    // Whole or not at all: the server reads this file while it runs.
    const draft = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(draft, text);
    await fs.promises.rename(draft, file);
}

const nodeOnPath = (): boolean =>
    (process.env.PATH ?? process.env.Path ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .some((dir) => (process.platform === "win32" ? ["node.exe", "node.cmd"] : ["node"]).some((name) => fs.existsSync(path.join(dir, name))));

/** The `mcpServers` entry: `node` when PATH has one, else VS Code's own runtime as Node. */
export function mcpEntry(dir: string, hasNode = nodeOnPath()): Record<string, unknown> {
    const args = [path.join(dir, SERVER), "--settings", path.join(dir, SETTINGS), "--log", path.join(dir, "oc-mcp.log")];
    return hasNode
        ? { type: "stdio", command: "node", args }
        : { type: "stdio", command: process.execPath, args, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** Whether the user's Copilot config names this server: read, never written. */
export function copilotConfigNote(file = path.join(os.homedir(), ".copilot", "mcp-config.json")): string {
    if (!installed) {
        return "the server is not copied yet (see the OpenCode output)";
    }
    const where = `server ${installed.version} in \`${installed.dir}\``;
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        return `${where} · no \`${file}\`: **OpenCode: Copy MCP Config for Copilot** gives the entry`;
    }
    // Compared as JSON writes it: a Windows path's backslashes are doubled in the file.
    const named = [path.join(installed.dir, SERVER), JSON.stringify(path.join(installed.dir, SERVER)).slice(1, -1)].some((p) => text.includes(p));
    return named
        ? `${where} · \`${file}\` names it`
        : `${where} · \`${file}\` does not name it: **OpenCode: Copy MCP Config for Copilot** gives the entry`;
}

export function registerOcMcp(context: vscode.ExtensionContext): void {
    const refresh = (): void => void writeSettings(context).catch((error: unknown) => logChannel.appendLine(`[${stamp()}] MCP server copy: ${String(error)}`));
    refresh();
    const changed = vscode.workspace.onDidChangeConfiguration?.((event) => {
        if (event.affectsConfiguration("opencodeCopilotBridge")) {
            refresh();
        }
    });
    if (changed) {
        context.subscriptions.push(changed);
    }
    context.subscriptions.push(
        vscode.commands.registerCommand("opencodeCopilotBridge.copilotMcpConfig", async () => {
            try {
                await writeSettings(context);
                const dir = await installMcpServer(context);
                const snippet = JSON.stringify({ mcpServers: { opencode: mcpEntry(dir) } }, null, 4);
                logChannel.appendLine(snippet);
                logChannel.show();
                await vscode.env.clipboard?.writeText?.(snippet);
                void vscode.window.showInformationMessage(
                    "OpenCode MCP config copied and printed in the OpenCode output. Merge its `mcpServers.opencode` entry into `~/.copilot/mcp-config.json`, then start a new Copilot chat. " +
                    "It offers the read-only `opencode_ask`; add `\"--dev\"` to its `args` for `opencode_dev`, which edits files."
                );
            } catch (error) {
                void vscode.window.showErrorMessage(`OpenCode MCP config: ${String(error)}`);
            }
        })
    );
}
