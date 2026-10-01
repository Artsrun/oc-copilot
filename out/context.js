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
exports.stepUris = stepUris;
exports.splitModelPrefix = splitModelPrefix;
exports.splitModelsFanout = splitModelsFanout;
exports.parseChatPrompt = parseChatPrompt;
exports.uniqueModels = uniqueModels;
const vscode = __importStar(require("vscode"));
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
function splitModelsFanout(raw) {
    const m = raw.trim().match(/^models\s*[:=]\s*(\S+)\s*([\s\S]*)$/i);
    return m ? { models: m[1].split(",").map((x) => x.trim()).filter(Boolean), task: m[2].trim() } : undefined;
}
function parseChatPrompt(raw) {
    let rest = raw.trim();
    let kind = "plan";
    let model;
    for (let i = 0; i < 4 && rest; i += 1) {
        const match = rest.match(/^(?:(plan|dev|parallel|par)\s*:|(?:model|m)\s*[:=]\s*(\S+)\s*:?)\s*/i);
        if (!match) {
            break;
        }
        if (match[1]) {
            const word = match[1].toLowerCase();
            kind = (word === "par" ? "parallel" : word);
        }
        if (match[2]) {
            model = match[2].replace(/,$/, "");
        }
        rest = rest.slice(match[0].length).trim();
    }
    return { kind, model, task: rest };
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