import * as vscode from "vscode";
import { ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import { platform } from "node:process";
import { config, resolveFolder, truncate } from "./core";
import { mark } from "./followups";
import { killTree, resolveExecutable, spawnOpenCode } from "./proc";
import { httpGetJson } from "./net";
import { getActiveSession } from "./session";
import { catalogAge, getModelCatalog } from "./models";
import { discoverOpenCodeEnv, summariseEnv } from "./env";

export function runCapture(executable: string, args: string[], cwd: string, timeoutMs = 8000): Promise<string> {
    return new Promise((resolve) => {
        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawnOpenCode(executable, args, cwd);
        } catch (error) {
            resolve(`error: ${(error as Error).message}`);
            return;
        }
        let out = "";
        const timer = setTimeout(() => {
            killTree(child);
            resolve(out.trim() || "timed out");
        }, timeoutMs);
        child.stdin?.end();
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (c: string) => (out += c));
        child.stderr.on("data", (c: string) => (out += c));
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

export async function diagnose(): Promise<void> {
    const settings = config();
    const executable = settings.get<string>("executable", "opencode");
    const folder = resolveFolder()?.folder;
    const cwd = folder?.uri.fsPath ?? process.cwd();
    const host = settings.get<string>("serverHostname", "127.0.0.1");
    const port = settings.get<number>("serverPort", 4096);

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
        lines.push(row("version", `\`${truncate(version, 80)}\``));
    }

    let serverState = "not running";
    try {
        const health = await httpGetJson<{ healthy?: boolean }>(`http://${host}:${port}/global/health`);
        serverState = health.healthy === true ? `${mark("ok")} healthy on ${host}:${port}` : `${mark("warn")} responded, unhealthy`;
    } catch {
        serverState = `not running on ${host}:${port} (started on demand)`;
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