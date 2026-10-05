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
exports.runCapture = runCapture;
exports.diagnose = diagnose;
exports.quickActions = quickActions;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("node:path"));
const node_process_1 = require("node:process");
const core_1 = require("./core");
const followups_1 = require("./followups");
const proc_1 = require("./proc");
const net_1 = require("./net");
const session_1 = require("./session");
const models_1 = require("./models");
const env_1 = require("./env");
function runCapture(executable, args, cwd, timeoutMs = 8000) {
    return new Promise((resolve) => {
        let child;
        try {
            child = (0, proc_1.spawnOpenCode)(executable, args, cwd);
        }
        catch (error) {
            resolve(`error: ${error.message}`);
            return;
        }
        let out = "";
        const timer = setTimeout(() => {
            (0, proc_1.killTree)(child);
            resolve(out.trim() || "timed out");
        }, timeoutMs);
        child.stdin?.end();
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (c) => (out += c));
        child.stderr.on("data", (c) => (out += c));
        child.on("error", (err) => {
            clearTimeout(timer);
            resolve(`error: ${err.message}`);
        });
        child.on("close", () => {
            clearTimeout(timer);
            resolve(out.trim() || "(no output)");
        });
    });
}
async function diagnose() {
    const settings = (0, core_1.config)();
    const executable = settings.get("executable", "opencode");
    const folder = (0, core_1.resolveFolder)()?.folder;
    const cwd = folder?.uri.fsPath ?? process.cwd();
    const host = settings.get("serverHostname", "127.0.0.1");
    const port = settings.get("serverPort", 4096);
    const lines = ["# OpenCode bridge diagnostics", "", `_${new Date().toISOString()}_`, ""];
    const row = (k, v) => `| ${k} | ${v} |`;
    lines.push("| Check | Result |", "| --- | --- |");
    let resolved = "";
    try {
        const r = (0, proc_1.resolveExecutable)(executable);
        resolved = r.target;
        lines.push(row("executable", `\`${r.target}\`${r.viaCmd ? " (via cmd.exe)" : ""}`));
    }
    catch {
        lines.push(row("executable", `${(0, followups_1.mark)("fail")} \`${executable}\` not found on PATH`));
    }
    if (resolved) {
        const version = await runCapture(executable, ["--version"], cwd);
        lines.push(row("version", `\`${(0, core_1.truncate)(version, 80)}\``));
    }
    let serverState = "not running";
    try {
        const health = await (0, net_1.httpGetJson)(`http://${host}:${port}/global/health`);
        serverState = health.healthy === true ? `${(0, followups_1.mark)("ok")} healthy on ${host}:${port}` : `${(0, followups_1.mark)("warn")} responded, unhealthy`;
    }
    catch {
        serverState = `not running on ${host}:${port} (started on demand)`;
    }
    lines.push(row("server", serverState));
    lines.push(row("transport", settings.get("transport", "auto")));
    lines.push(row("model", settings.get("model", "").trim() || "_(OpenCode default)_"));
    lines.push(row("fallbackModels", (settings.get("fallbackModels", []) ?? []).join(", ") || "_none_"));
    lines.push(row("timeoutMs", settings.get("timeoutMs", 0) > 0
        ? String(settings.get("timeoutMs", 0))
        : "0 — _no wall-clock cap; idleTimeoutMs is the only cap armed_"));
    lines.push(row("workspace", cwd));
    const state = folder ? (0, session_1.getActiveSession)(cwd) : { turns: 0 };
    lines.push(row("active session", state.id ? `\`${state.id}\` · ${state.turns} turn(s)` : "_none — send an @opencode message_"));
    lines.push(row("session scope", settings.get("sessionScope", "thread") === "workspace"
        ? "**workspace** — every chat in this folder shares one session"
        : "**thread** — each Copilot chat keeps its own session"));
    const catalog = await (0, models_1.getModelCatalog)(executable, cwd);
    lines.push(row("model catalog", `${catalog.models.length} model(s) · tier: **${catalog.source}**${catalog.fetchedAt ? ` · ${(0, models_1.catalogAge)(catalog)}` : ""}`));
    if (catalog.models.length) {
        lines.push("", `## Models (${catalog.source} tier)`, "");
        lines.push(catalog.models.slice(0, 40).map((m) => `- \`${m}\``).join("\n"));
        if (catalog.models.length > 40) {
            lines.push("", `_…and ${catalog.models.length - 40} more._`);
        }
    }
    lines.push("", "## Runtime", "", "| Check | Result |", "| --- | --- |");
    lines.push(row("vscode", `${vscode.version ?? "?"} · ${vscode.env?.appName ?? "?"}`));
    lines.push(row("extension host", vscode.env?.remoteName ?? "local"));
    lines.push(row("ui kind", String(vscode.env?.uiKind ?? "?")));
    lines.push(row("workspace trust", vscode.workspace.isTrusted === false ? (0, followups_1.mark)("fail") + " untrusted — spawning is restricted" : (0, followups_1.mark)("ok") + " trusted"));
    lines.push(row("platform", `${node_process_1.platform} ${process.arch} · node ${process.versions.node}`));
    if (node_process_1.platform === "win32") {
        lines.push(row("windows session", `${process.env.SESSIONNAME ?? "?"} · ComSpec ${process.env.ComSpec ?? "?"}`));
    }
    lines.push(row("PATH entries", String((process.env.PATH ?? "").split(path.delimiter).filter(Boolean).length)));
    const env = (0, env_1.discoverOpenCodeEnv)(cwd);
    lines.push("", "## OpenCode environment", "", (0, env_1.summariseEnv)(env));
    const doc = await vscode.workspace.openTextDocument({ content: lines.join("\n"), language: "markdown" });
    await vscode.window.showTextDocument(doc, { preview: false });
}
async function quickActions() {
    const cwd = (0, core_1.resolveFolder)()?.folder.uri.fsPath;
    const state = cwd ? (0, session_1.getActiveSession)(cwd) : { turns: 0, id: undefined };
    const items = [
        {
            label: "$(add) New session",
            detail: "A new chat with @opencode typed" + (state.id ? ` — the current chat keeps ${state.id}` : ""),
            run: () => vscode.commands.executeCommand("opencodeCopilotBridge.newSession")
        },
        {
            label: "$(list-unordered) Sessions…",
            detail: "Continue, fork, close or delete one of this folder's sessions",
            run: () => vscode.commands.executeCommand("opencodeCopilotBridge.sessions")
        },
        {
            label: "$(split-horizontal) Compose parallel lanes…",
            detail: "A model and a task per lane; the command lands in the chat input",
            run: () => vscode.commands.executeCommand("opencodeCopilotBridge.composeParallel")
        },
        {
            label: "$(settings-gear) Set default model",
            detail: (0, core_1.config)().get("model", "").trim() || "OpenCode default",
            run: () => vscode.commands.executeCommand("opencodeCopilotBridge.setModel")
        },
        {
            label: "$(refresh) Refresh model catalog",
            detail: "Bypass the cached model list",
            run: () => vscode.commands.executeCommand("opencodeCopilotBridge.refreshModels")
        },
        {
            label: "$(stethoscope) Diagnose",
            detail: "Check executable, server, models, log dir",
            run: () => vscode.commands.executeCommand("opencodeCopilotBridge.diagnose")
        },
        {
            label: "$(output) Show debug log",
            detail: "OpenCode output channel",
            run: () => vscode.commands.executeCommand("opencodeCopilotBridge.showLog")
        }
    ];
    const choice = await vscode.window.showQuickPick(items, { placeHolder: "OpenCode bridge" });
    await choice?.run();
}
//# sourceMappingURL=commands.js.map