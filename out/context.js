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
exports.isInstructionFile = isInstructionFile;
exports.isIgnorableReference = isIgnorableReference;
exports.buildChatContext = buildChatContext;
exports.emitReferences = emitReferences;
exports.createFileLinker = createFileLinker;
exports.emitAnswerParts = emitAnswerParts;
exports.stepUris = stepUris;
exports.splitModelPrefix = splitModelPrefix;
exports.splitLanePrefixes = splitLanePrefixes;
exports.splitModelsFanout = splitModelsFanout;
exports.parseChatPrompt = parseChatPrompt;
exports.uniqueModels = uniqueModels;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const core_1 = require("./core");
const INSTRUCTION_FILES = /(^|[\\/])(AGENTS\.md|CLAUDE\.md|copilot-instructions\.md|.*\.instructions\.md|.*\.prompt\.md)$/i;
function isInstructionFile(uri) {
    return INSTRUCTION_FILES.test(uri.fsPath);
}
function isIgnorableReference(id, value) {
    if (typeof value === "string") {
        return true;
    }
    return /instruction|prompt|copilot\.|vscode\.implicit/i.test(id);
}
function buildChatContext(request, cwd, origin = {}) {
    const lines = [];
    const uris = [];
    const seen = new Set();
    const settings = (0, core_1.config)();
    if (settings.get("includeChatReferences", true)) {
        for (const ref of request.references ?? []) {
            const value = ref.value;
            const id = String(ref.id ?? "");
            if (isIgnorableReference(id, value)) {
                continue;
            }
            const uri = (0, core_1.refUri)(value);
            if (!uri || isInstructionFile(uri)) {
                continue;
            }
            const key = uri.fsPath;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            uris.push(uri);
            const range = value
                .range;
            const span = range?.start?.line !== undefined && range?.end?.line !== undefined
                ? `:${range.start.line + 1}-${range.end.line + 1}`
                : "";
            lines.push(`- ${(0, core_1.relTo)(cwd, uri)}${span}`);
        }
    }
    let selectionBlock = "";
    if (origin.inline || settings.get("includeEditorSelection", false)) {
        const editor = vscode.window.activeTextEditor;
        const sel = editor?.selection;
        if (origin.inline && editor && sel && (sel.isEmpty || !editor.document.getText(sel).trim())) {
            const name = (0, core_1.relTo)(cwd, editor.document.uri);
            selectionBlock = `\nInline chat — ${name}:${sel.active.line + 1} (cursor, nothing selected)\n`;
            if (!seen.has(editor.document.uri.fsPath)) {
                uris.push(editor.document.uri);
            }
        }
        else if (editor && sel && !sel.isEmpty) {
            const text = editor.document.getText(sel);
            if (text.trim()) {
                const name = (0, core_1.relTo)(cwd, editor.document.uri);
                selectionBlock =
                    `\nActive selection — ${name}:${sel.start.line + 1}-${sel.end.line + 1}\n` +
                        "```\n" +
                        text +
                        "\n```\n";
                if (!seen.has(editor.document.uri.fsPath)) {
                    uris.push(editor.document.uri);
                }
            }
        }
    }
    if (lines.length === 0 && !selectionBlock) {
        return { preamble: "", uris };
    }
    const attached = lines.length ? `Files the user attached:\n${lines.join("\n")}\n` : "";
    return {
        preamble: `\n\n---\n${attached}${selectionBlock}(Context only. Do not repeat or summarize this block.)`,
        uris
    };
}
function emitReferences(response, uris) {
    if (typeof response.reference !== "function") {
        return;
    }
    const seen = new Set();
    for (const uri of uris) {
        if (!uri || seen.has(uri.fsPath)) {
            continue;
        }
        seen.add(uri.fsPath);
        try {
            response.reference(uri);
        }
        catch {
        }
    }
}
const PATH_SPAN = /^((?:[A-Za-z]:)?[\w@.\-\\/]*[\w@\-]\.[A-Za-z0-9]{1,10})(?::(\d{1,6})(?:[:-]\d{1,6})?|#L(\d{1,6}))?$/;
function createFileLinker(cwd, isFile = (p) => {
    try {
        return fs.statSync(p).isFile();
    }
    catch {
        return false;
    }
}) {
    let fence = "";
    let multi = 0;
    let lineStart = true;
    let held = "";
    const known = new Map();
    const anchorFor = (span) => {
        const m = span.length <= 240 ? span.match(PATH_SPAN) : null;
        if (!m) {
            return undefined;
        }
        const abs = path.resolve(cwd, m[1]);
        const rel = path.relative(cwd, abs);
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
            return undefined;
        }
        if (!known.has(abs)) {
            known.set(abs, isFile(abs));
        }
        if (!known.get(abs)) {
            return undefined;
        }
        const uri = vscode.Uri.file(abs);
        const line = Number(m[2] ?? m[3] ?? 0);
        const Loc = vscode.Location;
        const Range = vscode.Range;
        return { anchor: line > 0 && Loc && Range ? new Loc(uri, new Range(line - 1, 0, line - 1, 0)) : uri };
    };
    const run = (text, final) => {
        const parts = [];
        let out = "";
        let i = 0;
        let nlAt = 0;
        const hold = (from) => {
            held = text.slice(from);
            i = text.length;
        };
        while (i < text.length) {
            const c = text[i];
            if (c === "\n") {
                if (lineStart) {
                    multi = 0;
                }
                lineStart = true;
                out += c;
                i += 1;
                continue;
            }
            if (lineStart && !multi) {
                const nl = text.indexOf("\n", i);
                const line = text.slice(i, nl === -1 ? text.length : nl);
                if (!final && nl === -1 && /^ {0,3}(?:`*|~*)$|^ {0,3}(?:`{3,}|~{3,})/.test(line)) {
                    hold(i);
                    break;
                }
                const lead = line.match(/^ {0,3}(`{3,}|~{3,})/);
                if (lead) {
                    const r = lead[1];
                    if (!fence || (r[0] === fence[0] && r.length >= fence.length && !line.slice(lead[0].length).trim())) {
                        fence = fence ? "" : r;
                    }
                    out += line;
                    i += line.length;
                    continue;
                }
            }
            lineStart = false;
            if (fence) {
                out += c;
                i += 1;
                continue;
            }
            if (c === "\\") {
                if (i + 1 === text.length && !final) {
                    hold(i);
                    break;
                }
                out += text.slice(i, i + 2);
                i += 2;
                continue;
            }
            if (c !== "`") {
                out += c;
                i += 1;
                continue;
            }
            let n = 1;
            while (text[i + n] === "`") {
                n += 1;
            }
            if (i + n === text.length && !final) {
                hold(i);
                break;
            }
            if (multi) {
                multi = n === multi ? 0 : multi;
                out += text.slice(i, i + n);
                i += n;
                continue;
            }
            if (n > 1) {
                multi = n;
                out += text.slice(i, i + n);
                i += n;
                continue;
            }
            const tickAt = text.indexOf("`", i + 1);
            if (nlAt !== -1 && nlAt <= i) {
                nlAt = text.indexOf("\n", i + 1);
            }
            const end = tickAt === -1 ? nlAt : nlAt === -1 ? tickAt : Math.min(tickAt, nlAt);
            if (end === -1 && !final) {
                hold(i);
                break;
            }
            if (end === -1 || text[end] === "\n" || text[end + 1] === "`") {
                out += c;
                i += 1;
                continue;
            }
            const link = anchorFor(text.slice(i + 1, end));
            if (link) {
                if (out) {
                    parts.push(out);
                }
                parts.push(link);
                out = "";
            }
            else {
                out += text.slice(i, end + 1);
            }
            i = end + 1;
        }
        if (out) {
            parts.push(out);
        }
        return parts;
    };
    return {
        push: (chunk) => {
            const text = held + chunk;
            held = "";
            return run(text, false);
        },
        flush: () => {
            const text = held;
            held = "";
            return text ? run(text, true) : [];
        }
    };
}
function emitAnswerParts(response, parts) {
    for (const part of parts) {
        if (typeof part === "string") {
            response.markdown(part);
        }
        else {
            response.anchor(part.anchor);
        }
    }
}
function stepUris(cwd, steps) {
    const out = [];
    for (const step of steps) {
        const raw = step.filePath?.trim();
        if (!raw) {
            continue;
        }
        try {
            out.push(vscode.Uri.file(path.isAbsolute(raw) ? raw : path.join(cwd, raw)));
        }
        catch {
        }
    }
    return out;
}
function splitModelPrefix(raw) {
    const m = raw.trim().match(/^(?:model|m)\s*[:=]\s*([^\s,]+)(?:,|\s|$)\s*([\s\S]*)$/i);
    const model = m?.[1].replace(/:$/, "");
    return m && model ? { model, task: m[2].trim() } : { task: raw.trim() };
}
function splitLanePrefixes(raw) {
    let rest = raw.trim();
    let model;
    let agent;
    for (let i = 0; i < 2; i += 1) {
        const a = agent ? undefined : rest.match(/^(?:agent\s*[:=]\s*|a[:=])([A-Za-z0-9_][\w./-]{0,63}?):?(?:,|\s|$)\s*([\s\S]*)$/i);
        if (a) {
            agent = a[1];
            rest = a[2].trim();
            continue;
        }
        if (!model) {
            const m = splitModelPrefix(rest);
            if (m.model) {
                model = m.model;
                rest = m.task;
                continue;
            }
        }
        break;
    }
    return { model, agent, task: rest };
}
function splitModelsFanout(raw) {
    const m = raw.trim().match(/^models\s*[:=]\s*(\S+)\s*([\s\S]*)$/i);
    return m ? { models: m[1].split(",").map((x) => x.trim()).filter(Boolean), task: m[2].trim() } : undefined;
}
function parseChatPrompt(raw) {
    let rest = raw.trim();
    let kind = "plan";
    let model;
    let effort;
    let explicitKind = false;
    for (let i = 0; i < 5 && rest; i += 1) {
        const match = rest.match(/^(?:(plan|dev|parallel|par)\s*:|(?:model|m)\s*[:=]\s*(\S+)\s*:?|(?:effort\s*[:=]\s*|e[:=])([A-Za-z][\w-]{0,23})(?=\s|$))\s*/i);
        if (!match) {
            break;
        }
        if (match[1]) {
            const word = match[1].toLowerCase();
            kind = (word === "par" ? "parallel" : word);
            explicitKind = true;
        }
        if (match[2]) {
            model = match[2].replace(/,$/, "");
        }
        if (match[3]) {
            effort = match[3];
        }
        rest = rest.slice(match[0].length).trim();
    }
    return { kind, model, task: rest, effort, explicitKind };
}
function uniqueModels(candidates, cap = 4) {
    const out = [];
    const seen = new Set();
    for (const candidate of candidates) {
        const value = (candidate ?? "").trim();
        if (!value || seen.has(value)) {
            continue;
        }
        seen.add(value);
        out.push(value);
        if (out.length >= cap) {
            break;
        }
    }
    return out;
}
//# sourceMappingURL=context.js.map