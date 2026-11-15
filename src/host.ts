// VS Code's side of core's seam: the settings, folder, trust and state the
// engine reads through `setHost`, plus what only a window has (status bar,
// folder choice). Installed when this module loads, before any engine read, so
// nothing reads the default host inside VS Code.
import * as vscode from "vscode";

import { config, setHost, underRoot } from "./core";

export let extensionContext: vscode.ExtensionContext;

export function setExtensionContext(context: vscode.ExtensionContext): void {
    extensionContext = context;
}

/** The whole configuration, for what the engine's `Settings` leaves out: where a value lives, writing it. */
export function vsConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("opencodeCopilotBridge");
}

// ---------------------------------------------------------------------------
// status bar
// ---------------------------------------------------------------------------

let statusItem: vscode.StatusBarItem | undefined;

// Every VS Code API touched here is optional-chained: the headless verify stub
// implements only the subset the chat path needs, and a missing API must never
// take a chat turn down.
export function ensureStatusItem(): vscode.StatusBarItem | undefined {
    if (!config().get<boolean>("statusBar", true)) {
        statusItem?.hide();
        return undefined;
    }
    if (!statusItem) {
        const align = (vscode.StatusBarAlignment as { Right?: number } | undefined)?.Right ?? 2;
        statusItem = vscode.window.createStatusBarItem?.(align as vscode.StatusBarAlignment, 40);
        if (statusItem) {
            statusItem.command = "opencodeCopilotBridge.quickActions";
            // Names the entry in the status bar's right-click (hide) menu.
            statusItem.name = "OpenCode";
            extensionContext?.subscriptions.push(statusItem);
        }
    }
    return statusItem;
}

export function setStatus(text: string, tooltip?: string, warn = false): void {
    const item = ensureStatusItem();
    if (!item) {
        return;
    }
    item.text = text;
    // A MarkdownString renders the session id as code; plain string hosts (and
    // the headless stub) fall back to the raw text, which is still readable.
    try {
        item.tooltip = tooltip && vscode.MarkdownString ? new vscode.MarkdownString(tooltip) : tooltip;
    } catch {
        item.tooltip = tooltip;
    }
    try {
        item.backgroundColor = warn
            ? new vscode.ThemeColor("statusBarItem.warningBackground")
            : undefined;
    } catch {
        // ThemeColor is unavailable in the headless stub.
    }
    item.show();
}

// ---------------------------------------------------------------------------
// multi-root workspaces
// ---------------------------------------------------------------------------
//
// Nothing here may hard-code workspaceFolders[0]: in a multi-root workspace that
// silently runs OpenCode against the first folder, whichever project you asked
// about. Session state is keyed by cwd, so once the right folder is chosen each
// root gets its own session and turn count for free.

const LAST_FOLDER_KEY = "opencode.lastFolder";

export interface FolderChoice {
    folder: vscode.WorkspaceFolder;
    reason: "only-root" | "attachment" | "active-editor" | "remembered" | "first-root";
}

export function refUri(value: unknown): vscode.Uri | undefined {
    const candidate = value as { uri?: unknown; fsPath?: unknown; scheme?: unknown } | undefined;
    if (!candidate) {
        return undefined;
    }
    if (typeof candidate.fsPath === "string" && candidate.scheme !== undefined) {
        return candidate as unknown as vscode.Uri;
    }
    if (candidate.uri) {
        return refUri(candidate.uri);
    }
    return undefined;
}

export function relTo(cwd: string, uri: vscode.Uri): string {
    try {
        return underRoot(cwd, uri.fsPath) || uri.fsPath;
    } catch {
        return uri.fsPath;
    }
}

export function folderOf(uri: vscode.Uri | undefined): vscode.WorkspaceFolder | undefined {
    if (!uri) {
        return undefined;
    }
    try {
        return vscode.workspace.getWorkspaceFolder?.(uri) ?? undefined;
    } catch {
        return undefined;
    }
}

// Resolution order, most-specific first. Nothing here prompts: a chat turn must
// never block on a picker.
export function resolveFolder(request?: vscode.ChatRequest): FolderChoice | undefined {
    const roots = vscode.workspace.workspaceFolders ?? [];
    if (roots.length === 0) {
        return undefined;
    }
    if (roots.length === 1) {
        return { folder: roots[0], reason: "only-root" };
    }
    for (const ref of (request as { references?: readonly unknown[] } | undefined)?.references ?? []) {
        const uri = refUri((ref as { value?: unknown }).value);
        const match = folderOf(uri);
        if (match) {
            return { folder: match, reason: "attachment" };
        }
    }
    const active = folderOf(vscode.window.activeTextEditor?.document.uri);
    if (active) {
        return { folder: active, reason: "active-editor" };
    }
    const remembered = extensionContext?.workspaceState?.get<string>(LAST_FOLDER_KEY);
    const hit = remembered ? roots.find((r) => r.uri.fsPath === remembered) : undefined;
    if (hit) {
        return { folder: hit, reason: "remembered" };
    }
    return { folder: roots[0], reason: "first-root" };
}

export function activeCwd(): string {
    return resolveFolder()?.folder.uri.fsPath ?? process.cwd();
}

export function rememberFolder(cwd: string): void {
    void extensionContext?.workspaceState?.update(LAST_FOLDER_KEY, cwd);
}

export function isMultiRoot(): boolean {
    return (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
}

setHost(
    {
        settings: vsConfig,
        folder: () => resolveFolder()?.folder.uri.fsPath,
        trusted: () => (vscode.workspace as { isTrusted?: boolean }).isTrusted === true,
        state: () => extensionContext?.globalState
    },
    false
);
