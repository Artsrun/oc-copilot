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
exports.extensionContext = void 0;
exports.setExtensionContext = setExtensionContext;
exports.vsConfig = vsConfig;
exports.ensureStatusItem = ensureStatusItem;
exports.setStatus = setStatus;
exports.refUri = refUri;
exports.relTo = relTo;
exports.folderOf = folderOf;
exports.resolveFolder = resolveFolder;
exports.activeCwd = activeCwd;
exports.rememberFolder = rememberFolder;
exports.isMultiRoot = isMultiRoot;
const vscode = __importStar(require("vscode"));
const core_1 = require("./core");
function setExtensionContext(context) {
    exports.extensionContext = context;
}
function vsConfig() {
    return vscode.workspace.getConfiguration("opencodeCopilotBridge");
}
let statusItem;
function ensureStatusItem() {
    if (!(0, core_1.config)().get("statusBar", true)) {
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
        return (0, core_1.underRoot)(cwd, uri.fsPath) || uri.fsPath;
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
(0, core_1.setHost)({
    settings: vsConfig,
    folder: () => resolveFolder()?.folder.uri.fsPath,
    trusted: () => vscode.workspace.isTrusted === true,
    state: () => exports.extensionContext?.globalState
}, false);
//# sourceMappingURL=host.js.map