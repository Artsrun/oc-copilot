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
exports.sentencesOf = exports.plainText = exports.mdText = exports.extensionContext = exports.logChannel = void 0;
exports.setLogChannel = setLogChannel;
exports.setExtensionContext = setExtensionContext;
exports.config = config;
exports.stamp = stamp;
exports.debugLine = debugLine;
exports.truncate = truncate;
exports.own = own;
exports.secs = secs;
exports.formatBytes = formatBytes;
exports.normLine = normLine;
exports.delay = delay;
exports.ensureStatusItem = ensureStatusItem;
exports.setStatus = setStatus;
exports.refUri = refUri;
exports.relTo = relTo;
exports.folderOf = folderOf;
exports.resolveFolder = resolveFolder;
exports.activeCwd = activeCwd;
exports.rememberFolder = rememberFolder;
exports.isMultiRoot = isMultiRoot;
exports.untilStop = untilStop;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("node:path"));
function setLogChannel(channel) {
    exports.logChannel = channel;
}
function setExtensionContext(context) {
    exports.extensionContext = context;
}
function config() {
    return vscode.workspace.getConfiguration("opencodeCopilotBridge");
}
function stamp() {
    return new Date().toISOString().slice(11, 19);
}
function debugLine(text) {
    if (config().get("debugLog", false)) {
        exports.logChannel.appendLine(`[${stamp()}] ${text}`);
    }
}
function truncate(text, max = 160) {
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
function own(table, key) {
    return Object.hasOwn(table, key) ? table[key] : undefined;
}
function secs(ms) {
    return `${(ms / 1000).toFixed(1)}s`;
}
function formatBytes(n) {
    if (n >= 1048576) {
        return `${(n / 1048576).toFixed(1)} MB`;
    }
    if (n >= 1024) {
        return `${Math.round(n / 1024)} KB`;
    }
    return `${n} B`;
}
function normLine(text) {
    return text.replace(/\s+/g, " ").trim().toLowerCase();
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
let statusItem;
function ensureStatusItem() {
    if (!config().get("statusBar", true)) {
        statusItem?.hide();
        return undefined;
    }
    if (!statusItem) {
        const align = vscode.StatusBarAlignment?.Right ?? 2;
        statusItem = vscode.window.createStatusBarItem?.(align, 40);
        if (statusItem) {
            statusItem.command = "opencodeCopilotBridge.quickActions";
            statusItem.name = "OpenCode";
            exports.extensionContext?.subscriptions.push(statusItem);
        }
    }
    return statusItem;
}
function setStatus(text, tooltip, warn = false) {
    const item = ensureStatusItem();
    if (!item) {
        return;
    }
    item.text = text;
    try {
        item.tooltip = tooltip && vscode.MarkdownString ? new vscode.MarkdownString(tooltip) : tooltip;
    }
    catch {
        item.tooltip = tooltip;
    }
    try {
        item.backgroundColor = warn
            ? new vscode.ThemeColor("statusBarItem.warningBackground")
            : undefined;
    }
    catch {
    }
    item.show();
}
const LAST_FOLDER_KEY = "opencode.lastFolder";
function refUri(value) {
    const candidate = value;
    if (!candidate) {
        return undefined;
    }
    if (typeof candidate.fsPath === "string" && candidate.scheme !== undefined) {
        return candidate;
    }
    if (candidate.uri) {
        return refUri(candidate.uri);
    }
    return undefined;
}
function relTo(cwd, uri) {
    try {
        const rel = path.relative(cwd, uri.fsPath);
        return rel && !rel.startsWith("..") ? rel.split(path.sep).join("/") : uri.fsPath;
    }
    catch {
        return uri.fsPath;
    }
}
function folderOf(uri) {
    if (!uri) {
        return undefined;
    }
    try {
        return vscode.workspace.getWorkspaceFolder?.(uri) ?? undefined;
    }
    catch {
        return undefined;
    }
}
function resolveFolder(request) {
    const roots = vscode.workspace.workspaceFolders ?? [];
    if (roots.length === 0) {
        return undefined;
    }
    if (roots.length === 1) {
        return { folder: roots[0], reason: "only-root" };
    }
    for (const ref of request?.references ?? []) {
        const uri = refUri(ref.value);
        const match = folderOf(uri);
        if (match) {
            return { folder: match, reason: "attachment" };
        }
    }
    const active = folderOf(vscode.window.activeTextEditor?.document.uri);
    if (active) {
        return { folder: active, reason: "active-editor" };
    }
    const remembered = exports.extensionContext?.workspaceState?.get(LAST_FOLDER_KEY);
    const hit = remembered ? roots.find((r) => r.uri.fsPath === remembered) : undefined;
    if (hit) {
        return { folder: hit, reason: "remembered" };
    }
    return { folder: roots[0], reason: "first-root" };
}
function activeCwd() {
    return resolveFolder()?.folder.uri.fsPath ?? process.cwd();
}
function rememberFolder(cwd) {
    void exports.extensionContext?.workspaceState?.update(LAST_FOLDER_KEY, cwd);
}
function isMultiRoot() {
    return (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
}
function untilStop(work, token) {
    if (token.isCancellationRequested) {
        return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
        const sub = token.onCancellationRequested(() => {
            sub.dispose();
            resolve(undefined);
        });
        work.then((value) => {
            sub.dispose();
            resolve(value);
        }, () => {
            sub.dispose();
            resolve(undefined);
        });
    });
}
const mdText = (s) => s.replace(/[\\`*_{}[\]<>#|~]/g, "\\$&");
exports.mdText = mdText;
const ABBREVIATIONS = /\b(e\.g|i\.e|etc|vs|approx|incl|esp|cf)\./gi;
const plainText = (markdown) => markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,!?;:]|$)/g, "$1$2")
    .replace(/^\s{0,3}(#{1,6}|>)\s*/gm, "")
    .replace(/[ \t]+/g, " ");
exports.plainText = plainText;
const sentencesOf = (text) => text
    .replace(ABBREVIATIONS, (m) => m.replace(/\./g, "․"))
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z("'‘“])/)
    .map((x) => x.replace(/․/g, ".").replace(/^[-*•]\s+/, "").trim())
    .filter(Boolean);
exports.sentencesOf = sentencesOf;
//# sourceMappingURL=core.js.map