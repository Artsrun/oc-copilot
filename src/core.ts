// Bottom of the dependency graph, and the engine's only seam to its host. Nothing
// in here may import another bridge module or `vscode`: the running layer (the
// engine, EN) loads in a plain Node process, so a host — VS Code (`host.ts`), a
// probe, a standalone server — hands in its settings, log and state with
// `setHost` and `setLogChannel`.
import * as fs from "node:fs";
import * as path from "node:path";

/** The `opencodeCopilotBridge` settings: vscode.WorkspaceConfiguration fits it. */
export interface Settings {
    get<T>(key: string): T | undefined;
    get<T>(key: string, fallback: T): T;
}

export interface Log {
    appendLine(line: string): void;
    show(preserveFocus?: boolean): void;
}

/** Stop, as the engine reads it: vscode.CancellationToken fits it. A listener added
 * after Stop is still called (VS Code calls it on the next tick), and the engine's
 * waits rely on that: another host's token must do the same. */
export interface Cancel {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => unknown): { dispose(): unknown };
}

/** State that outlives the process: vscode.Memento fits it. */
export interface Memo {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void> | void;
}

export interface Host {
    /** Read afresh on every call, so a changed setting reaches the next read. */
    settings(): Settings;
    /** The folder a run uses when the caller names none. */
    folder(): string | undefined;
    /** May the folder start OpenCode unasked (prewarm): VS Code's workspace trust. */
    trusted(): boolean;
    state(): Memo | undefined;
}

const NO_HOST: Host = {
    settings: () => ({ get: <T>(_key: string, fallback?: T) => fallback }) as Settings,
    folder: () => undefined,
    trusted: () => false,
    state: () => undefined
};
let host = NO_HOST;

/** `replace: false` installs only over the default: a probe that set its own keeps it. */
export function setHost(next: Host, replace = true): void {
    if (replace || host === NO_HOST) {
        host = next;
    }
}

// Exported `let` compiles to a live property read on the module object under
// commonjs, so call sites keep writing `logChannel.appendLine(...)` unchanged.
export let logChannel: Log = { appendLine: () => undefined, show: () => undefined };

export function setLogChannel(channel: Log): void {
    logChannel = channel;
}

export function config(): Settings {
    return host.settings();
}

export function hostFolder(): string | undefined {
    return host.folder();
}

export function hostTrusted(): boolean {
    return host.trusted();
}

export function hostState(): Memo | undefined {
    return host.state();
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

// User/model keys must not resolve inherited properties such as constructor.
export function own<T>(table: Record<string, T>, key: string): T | undefined {
    return Object.hasOwn(table, key) ? table[key] : undefined;
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

const realOr = (p: string): string => {
    try {
        return fs.realpathSync.native(p);
    } catch {
        return p;
    }
};

/** `file` relative to `root`, with `/`, or "" when it is outside. Tried as given, then
 * with both resolved: git names a repository by its real path (macOS `/private/var`,
 * Windows long names), VS Code a file by the path it was opened by (`WT11`). */
export function underRoot(root: string, file: string): string {
    const inside = (rel: string): boolean => rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    let rel = path.relative(root, file);
    if (!inside(rel)) {
        rel = path.relative(realOr(root), realOr(file));
    }
    return inside(rel) ? rel.split(path.sep).join("/") : "";
}

// Resolves with the work's value, or undefined as soon as Stop is pressed —
// the work itself carries on (a listing still lands in its cache).
export function untilStop<T>(work: Promise<T>, token: Cancel): Promise<T | undefined> {
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

// Answer-to-sentence utilities (the natural follow-ups read answers this way;
// kept here so the rest of the bridge can reuse them). Pure string work.
const ABBREVIATIONS = /\b(e\.g|i\.e|etc|vs|approx|incl|esp|cf)\./gi;

/** Markdown and code out, one sentence per line-ish unit, abbreviations kept whole. */
export const plainText = (markdown: string): string =>
    markdown
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`\n]*)`/g, "$1")
        .replace(/\*\*|__/g, "")
        .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,!?;:]|$)/g, "$1$2")
        .replace(/^\s{0,3}(#{1,6}|>)\s*/gm, "")
        .replace(/[ \t]+/g, " ");

export const sentencesOf = (text: string): string[] =>
    text
        .replace(ABBREVIATIONS, (m) => m.replace(/\./g, "․"))
        .split(/\n+|(?<=[.!?])\s+(?=[A-Z("'‘“])/)
        .map((x) => x.replace(/․/g, ".").replace(/^[-*•]\s+/, "").trim())
        .filter(Boolean);
