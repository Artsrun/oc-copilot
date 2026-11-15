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
exports.sentencesOf = exports.plainText = exports.mdText = exports.logChannel = void 0;
exports.setHost = setHost;
exports.setLogChannel = setLogChannel;
exports.config = config;
exports.hostFolder = hostFolder;
exports.hostTrusted = hostTrusted;
exports.hostState = hostState;
exports.stamp = stamp;
exports.debugLine = debugLine;
exports.truncate = truncate;
exports.own = own;
exports.secs = secs;
exports.formatBytes = formatBytes;
exports.normLine = normLine;
exports.delay = delay;
exports.underRoot = underRoot;
exports.untilStop = untilStop;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const NO_HOST = {
    settings: () => ({ get: (_key, fallback) => fallback }),
    folder: () => undefined,
    trusted: () => false,
    state: () => undefined
};
let host = NO_HOST;
function setHost(next, replace = true) {
    if (replace || host === NO_HOST) {
        host = next;
    }
}
exports.logChannel = { appendLine: () => undefined, show: () => undefined };
function setLogChannel(channel) {
    exports.logChannel = channel;
}
function config() {
    return host.settings();
}
function hostFolder() {
    return host.folder();
}
function hostTrusted() {
    return host.trusted();
}
function hostState() {
    return host.state();
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
const realOr = (p) => {
    try {
        return fs.realpathSync.native(p);
    }
    catch {
        return p;
    }
};
function underRoot(root, file) {
    const inside = (rel) => rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    let rel = path.relative(root, file);
    if (!inside(rel)) {
        rel = path.relative(realOr(root), realOr(file));
    }
    return inside(rel) ? rel.split(path.sep).join("/") : "";
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