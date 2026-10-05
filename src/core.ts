// Bottom of the dependency graph. Nothing in here may import another bridge
// module, so every other cluster can depend on it without risking a cycle.
import * as vscode from "vscode";
import * as path from "node:path";

// Exported `let` compiles to a live property read on the module object under
// commonjs, so call sites keep writing `logChannel.appendLine(...)` unchanged.
export let logChannel: vscode.OutputChannel;
export let extensionContext: vscode.ExtensionContext;

export function setLogChannel(channel: vscode.OutputChannel): void {
    logChannel = channel;
}

export function setExtensionContext(context: vscode.ExtensionContext): void {
    extensionContext = context;
}

export function config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("opencodeCopilotBridge");
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

export function stamp(): string {
    return new Date().toISOString().slice(11, 19);
}

// Per-delta logging only. The output channel keeps everything for the window's
// lifetime, so this would otherwise hold every token of every run.
export function debugLine(text: string): void {
    if (config().get<boolean>("debugLog", false)) {
        logChannel.appendLine(`[${stamp()}] ${text}`);
    }
}

export function truncate(text: string, max = 160): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export function secs(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
}

export function formatBytes(n: number): string {
    if (n >= 1048576) {
        return `${(n / 1048576).toFixed(1)} MB`;
    }
    if (n >= 1024) {
        return `${Math.round(n / 1024)} KB`;
    }
    return `${n} B`;
}

export function normLine(text: string): string {
    return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
        const rel = path.relative(cwd, uri.fsPath);
        return rel && !rel.startsWith("..") ? rel.split(path.sep).join("/") : uri.fsPath;
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

// Resolves with the work's value, or undefined as soon as Stop is pressed —
// the work itself carries on (a listing still lands in its cache).
export function untilStop<T>(work: Promise<T>, token: vscode.CancellationToken): Promise<T | undefined> {
    if (token.isCancellationRequested) {
        return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
        const sub = token.onCancellationRequested(() => {
            sub.dispose();
            resolve(undefined);
        });
        work.then(
            (value) => {
                sub.dispose();
                resolve(value);
            },
            () => {
                sub.dispose();
                resolve(undefined);
            }
        );
    });
}

/** Plain text in markdown: `my_file.ts` is not italic, a backtick opens nothing. */
export const mdText = (s: string): string => s.replace(/[\\`*_{}[\]<>#|~]/g, "\\$&");
