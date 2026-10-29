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
exports.diagnose = diagnose;
exports.quickActions = quickActions;
exports.pickWorktree = pickWorktree;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("node:path"));
const node_process_1 = require("node:process");
const core_1 = require("./core");
const followups_1 = require("./followups");
const proc_1 = require("./proc");
const net_1 = require("./net");
const oc_api_1 = require("./oc-api");
const session_1 = require("./session");
const models_1 = require("./models");
const env_1 = require("./env");
const worktree_1 = require("./worktree");
async function diagnose() {
    const settings = (0, core_1.config)();
    const executable = settings.get("executable", "opencode");
    const folder = (0, core_1.resolveFolder)()?.folder;
    const cwd = folder?.uri.fsPath ?? process.cwd();
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
        const version = await (0, proc_1.runCapture)(executable, ["--version"], cwd);
        const major = (0, net_1.majorVersionNote)(executable, version);
        lines.push(row("version", `\`${(0, core_1.truncate)(version, 80)}\`${major ? ` — ${(0, followups_1.mark)("fail")} ${major}` : ""}`));
    }
    const failed = (0, net_1.lastServeFailure)();
    let serverState = (0, net_1.dataFolderRefusal)(executable)
        ? `${(0, followups_1.mark)("fail")} cannot start: OpenCode 1 cannot open its data folder, which OpenCode 2 created (README, *OpenCode 2*)`
        : failed ? `${(0, followups_1.mark)("warn")} not running — the last start failed: ${failed.replace(/\|/g, "\\|")}` : "not running (started on demand)";
    const serverBase = (0, net_1.knownServerBase)();
    if (serverBase) {
        try {
            const health = await (0, oc_api_1.api)(serverBase).health();
            serverState = health.healthy === true
                ? `${(0, followups_1.mark)("ok")} healthy on ${serverBase}${typeof health.version === "string" ? ` · OpenCode ${(0, core_1.truncate)(health.version, 24)}` : ""}`
                : `${(0, followups_1.mark)("warn")} responded, unhealthy`;
        }
        catch {
            serverState = `not running on ${serverBase} (started on demand)`;
        }
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
            label: "$(git-branch) Worktrees…",
            detail: "The worktrees /worktree made here: show changes, open, remove",
            run: () => vscode.commands.executeCommand("opencodeCopilotBridge.worktrees")
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
            detail: "Check executable, server, models, environment",
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
async function pickWorktree() {
    const listed = await (0, worktree_1.listWorktrees)((0, core_1.activeCwd)());
    if (!listed) {
        void vscode.window.showInformationMessage("OpenCode: this folder is not in a git repository.");
        return;
    }
    if (!listed.worktrees.length) {
        void vscode.window.showInformationMessage("OpenCode: /worktree has made no worktrees in this repository.");
        return;
    }
    const idle = listed.worktrees.filter((w) => !w.changed && !w.commits);
    const items = listed.worktrees.map((wt) => ({
        label: `$(git-branch) ${wt.branch}`,
        description: (0, worktree_1.worktreeChanges)(wt),
        detail: (0, worktree_1.worktreeLabel)(wt.path),
        wt
    }));
    if (idle.length) {
        items.push({ label: `$(trash) Remove all without changes (${idle.length})`, detail: "Their worktrees and branches; the ones with changes stay", removeIdle: true });
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "Worktrees /worktree made in this repository" });
    if (pick?.removeIdle) {
        const sure = await vscode.window.showWarningMessage(`Remove ${idle.length} worktree${idle.length === 1 ? "" : "s"} without changes, and ${idle.length === 1 ? "its branch" : "their branches"}?`, { modal: true }, "Remove");
        if (sure !== "Remove") {
            return;
        }
        const failed = [];
        for (const wt of idle) {
            const res = await (0, worktree_1.removeWorktree)(listed.root, wt.path, wt.branch);
            if (res.code !== 0) {
                failed.push(`${wt.branch}: ${res.stderr.trim().split(/\r?\n/)[0]}`);
            }
        }
        void (failed.length
            ? vscode.window.showWarningMessage(`OpenCode: removed ${idle.length - failed.length} of ${idle.length}; ${failed.join("; ")}`)
            : vscode.window.showInformationMessage(`OpenCode: removed ${idle.length} worktree${idle.length === 1 ? "" : "s"} without changes.`));
        return;
    }
    const wt = pick?.wt;
    if (!wt) {
        return;
    }
    const action = await vscode.window.showQuickPick([
        ...(wt.changed || wt.commits ? [{ label: "$(diff) Show changes", id: "worktreeDiff" }] : []),
        { label: "$(empty-window) Open in new window", id: "worktreeOpen" },
        { label: "$(trash) Remove…", id: "worktreeRemove" }
    ], { placeHolder: `${wt.branch} · ${(0, worktree_1.worktreeChanges)(wt)}` });
    if (action) {
        await vscode.commands.executeCommand(`opencodeCopilotBridge.${action.id}`, { root: listed.root, path: wt.path, branch: wt.branch, baseSha: wt.base });
    }
}
//# sourceMappingURL=commands.js.map