import * as vscode from "vscode";
import * as path from "node:path";
import { platform } from "node:process";
import { config, resolveFolder, truncate } from "./core";
import { mark } from "./followups";
import { resolveExecutable, runCapture } from "./proc";
import { dataFolderRefusal, knownServerBase, lastServeFailure, majorVersionNote } from "./net";
import { api } from "./oc-api";
import { getActiveSession } from "./session";
import { catalogAge, getModelCatalog } from "./models";
import { discoverOpenCodeEnv, summariseEnv } from "./env";

export async function diagnose(): Promise<void> {
    const settings = config();
    const executable = settings.get<string>("executable", "opencode");
    const folder = resolveFolder()?.folder;
    const cwd = folder?.uri.fsPath ?? process.cwd();

    const lines: string[] = ["# OpenCode bridge diagnostics", "", `_${new Date().toISOString()}_`, ""];
    const row = (k: string, v: string): string => `| ${k} | ${v} |`;
    lines.push("| Check | Result |", "| --- | --- |");

    let resolved = "";
    try {
        const r = resolveExecutable(executable);
        resolved = r.target;
        lines.push(row("executable", `\`${r.target}\`${r.viaCmd ? " (via cmd.exe)" : ""}`));
    } catch {
        lines.push(row("executable", `${mark("fail")} \`${executable}\` not found on PATH`));
    }
    if (resolved) {
        const version = await runCapture(executable, ["--version"], cwd);
        const major = majorVersionNote(executable, version);
        lines.push(row("version", `\`${truncate(version, 80)}\`${major ? ` — ${mark("fail")} ${major}` : ""}`));
    }

    const failed = lastServeFailure();
    let serverState = dataFolderRefusal(executable)
        ? `${mark("fail")} cannot start: OpenCode 1 cannot open its data folder, which OpenCode 2 created (README, *OpenCode 2*)`
        : failed ? `${mark("warn")} not running — the last start failed: ${failed.replace(/\|/g, "\\|")}` : "not running (started on demand)";
    const serverBase = knownServerBase();
    if (serverBase) {
        try {
            const health = await api(serverBase).health();
            serverState = health.healthy === true
                ? `${mark("ok")} healthy on ${serverBase}${typeof health.version === "string" ? ` · OpenCode ${truncate(health.version, 24)}` : ""}`
                : `${mark("warn")} responded, unhealthy`;
        } catch {
            serverState = `not running on ${serverBase} (started on demand)`;
        }
    }
    lines.push(row("server", serverState));
    lines.push(row("transport", settings.get<string>("transport", "auto")));
    lines.push(row("model", settings.get<string>("model", "").trim() || "_(OpenCode default)_"));
    lines.push(row("fallbackModels", (settings.get<string[]>("fallbackModels", []) ?? []).join(", ") || "_none_"));
    lines.push(
        row(
            "timeoutMs",
            settings.get<number>("timeoutMs", 0) > 0
                ? String(settings.get<number>("timeoutMs", 0))
                : "0 — _no wall-clock cap; idleTimeoutMs is the only cap armed_"
        )
    );
    lines.push(row("workspace", cwd));

    const state = folder ? getActiveSession(cwd) : { turns: 0 };
    lines.push(
        row(
            "active session",
            state.id ? `\`${state.id}\` · ${state.turns} turn(s)` : "_none — send an @opencode message_"
        )
    );
    lines.push(
        row(
            "session scope",
            settings.get<string>("sessionScope", "thread") === "workspace"
                ? "**workspace** — every chat in this folder shares one session"
                : "**thread** — each Copilot chat keeps its own session"
        )
    );

    const catalog = await getModelCatalog(executable, cwd);
    lines.push(
        row(
            "model catalog",
            `${catalog.models.length} model(s) · tier: **${catalog.source}**${catalog.fetchedAt ? ` · ${catalogAge(catalog)}` : ""
            }`
        )
    );
    if (catalog.models.length) {
        lines.push("", `## Models (${catalog.source} tier)`, "");
        lines.push(catalog.models.slice(0, 40).map((m) => `- \`${m}\``).join("\n"));
        if (catalog.models.length > 40) {
            lines.push("", `_…and ${catalog.models.length - 40} more._`);
        }
    }

    // Runtime facts turn "it does not work on my machine" into a fixable report:
    // remote/WSL hosts, untrusted workspaces, and elevated Windows sessions all
    // change which binary and which PATH the spawn actually sees.
    lines.push("", "## Runtime", "", "| Check | Result |", "| --- | --- |");
    lines.push(row("vscode", `${vscode.version ?? "?"} · ${vscode.env?.appName ?? "?"}`));
    lines.push(row("extension host", vscode.env?.remoteName ?? "local"));
    lines.push(row("ui kind", String(vscode.env?.uiKind ?? "?")));
    lines.push(
        row(
            "workspace trust",
            vscode.workspace.isTrusted === false ? mark("fail") + " untrusted — spawning is restricted" : mark("ok") + " trusted"
        )
    );
    lines.push(row("platform", `${platform} ${process.arch} · node ${process.versions.node}`));
    if (platform === "win32") {
        lines.push(
            row("windows session", `${process.env.SESSIONNAME ?? "?"} · ComSpec ${process.env.ComSpec ?? "?"}`)
        );
    }
    lines.push(row("PATH entries", String((process.env.PATH ?? "").split(path.delimiter).filter(Boolean).length)));

    const env = discoverOpenCodeEnv(cwd);
    lines.push("", "## OpenCode environment", "", summariseEnv(env));

    const doc = await vscode.workspace.openTextDocument({ content: lines.join("\n"), language: "markdown" });
    await vscode.window.showTextDocument(doc, { preview: false });
}

export async function quickActions(): Promise<void> {
    const cwd = resolveFolder()?.folder.uri.fsPath;
    const state = cwd ? getActiveSession(cwd) : { turns: 0, id: undefined };
    const items: Array<vscode.QuickPickItem & { run: () => unknown }> = [
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
            detail: config().get<string>("model", "").trim() || "OpenCode default",
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