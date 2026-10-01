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
exports.followupsProblems = exports.badgeMarks = exports.createBadger = exports.badge = exports.naturalText = exports.chipOf = exports.chipLabel = exports.prompt = exports.mark = exports.NATURAL_MAX_LABEL = exports.CASES = exports.MARKS = exports.PROMPTS = exports.TAIL = exports.CHIP_COMMANDS = void 0;
const data = __importStar(require("./followups.json"));
exports.CHIP_COMMANDS = ["dev", "plan", "new", "ping"];
exports.TAIL = data.tail;
const fill = (template, vars = {}) => template.replace(/\{(\w+)\}/g, (all, key) => (key === "tail" ? exports.TAIL : vars[key] ?? all)).trim();
exports.PROMPTS = Object.fromEntries(Object.entries(data.prompts).map(([k, v]) => [k, fill(v)]));
exports.MARKS = data.marks;
exports.CASES = data.cases;
exports.NATURAL_MAX_LABEL = data.natural.maxLabel;
const mark = (key) => exports.MARKS[key];
exports.mark = mark;
const prompt = (key) => exports.PROMPTS[key];
exports.prompt = prompt;
const chipLabel = (key) => {
    const def = data.chips[key];
    return `${def.kao} ${def.label}`;
};
exports.chipLabel = chipLabel;
const chipOf = (key, kind, text) => {
    const def = data.chips[key];
    if (!def) {
        return undefined;
    }
    const command = (def.command === "@kind" ? kind : def.command);
    const stored = def.prompt ? exports.PROMPTS[def.prompt] ?? "" : "";
    if (!(text ?? stored) && def.command === "@kind") {
        return undefined;
    }
    return { label: (0, exports.chipLabel)(key), prompt: text ?? stored, command };
};
exports.chipOf = chipOf;
const naturalText = (key, vars = {}) => {
    const def = data.natural[key];
    const promptText = def.prompt.startsWith("@") ? exports.PROMPTS[def.prompt.slice(1)] : fill(def.prompt, vars);
    return { kao: def.kao, label: fill(def.label, vars), prompt: promptText };
};
exports.naturalText = naturalText;
const MARK_LIST = Object.values(data.marks).sort((a, b) => b.length - a.length);
const badge = (text) => `\`${text}\``;
exports.badge = badge;
const createBadger = () => {
    let fence = "";
    let inlineLen = 0;
    let lineStart = true;
    let blank = false;
    let run = "";
    let runAtLineStart = false;
    let escaped = false;
    let tick = false;
    let pillEnd = false;
    const closeRun = () => {
        if (!run) {
            return;
        }
        const ch = run[0];
        if (run.length >= 3 && runAtLineStart && inlineLen === 0 && (!fence || (fence[0] === ch && run.length >= fence.length))) {
            fence = fence ? "" : run;
        }
        else if (!fence && ch === "`") {
            inlineLen = inlineLen === 0 ? run.length : inlineLen === run.length ? 0 : inlineLen;
        }
        run = "";
    };
    const sep = "\u200b";
    return (chunk) => {
        let out = "";
        let i = 0;
        while (i < chunk.length) {
            const c = chunk[i];
            if (pillEnd && c === "`") {
                out += sep;
            }
            pillEnd = false;
            const tickBefore = tick;
            tick = false;
            if (c === "\r") {
                closeRun();
                escaped = false;
                out += c;
                i += 1;
                continue;
            }
            const wasEscaped = escaped;
            escaped = false;
            if (wasEscaped && (c === "`" || c === "\\")) {
                out += c;
                blank = false;
                lineStart = false;
                i += 1;
                continue;
            }
            if (c === "\\") {
                closeRun();
                escaped = !fence && inlineLen === 0;
                out += c;
                blank = false;
                lineStart = false;
                i += 1;
                continue;
            }
            if (c === "`" || c === "~") {
                if (run && run[0] !== c) {
                    closeRun();
                }
                if (!run) {
                    runAtLineStart = lineStart;
                }
                run += c;
                out += c;
                tick = c === "`";
                lineStart = false;
                blank = false;
                i += 1;
                continue;
            }
            closeRun();
            if (c === "\n") {
                if (blank) {
                    inlineLen = 0;
                }
                blank = true;
                lineStart = true;
                out += c;
                i += 1;
                continue;
            }
            if (c === " " || c === "\t") {
                out += c;
                i += 1;
                continue;
            }
            blank = false;
            const kao = !fence && inlineLen === 0 && !wasEscaped ? MARK_LIST.find((m) => chunk.startsWith(m, i)) : undefined;
            if (kao) {
                out += (tickBefore ? sep : "") + (0, exports.badge)(kao);
                i += kao.length;
                pillEnd = true;
            }
            else {
                out += c;
                i += 1;
            }
            lineStart = false;
        }
        return out;
    };
};
exports.createBadger = createBadger;
const badgeMarks = (markdown) => (0, exports.createBadger)()(markdown);
exports.badgeMarks = badgeMarks;
const followupsProblems = (d = data) => {
    const problems = [];
    const prompts = d.prompts;
    const commands = ["@kind", ...exports.CHIP_COMMANDS];
    for (const [k, def] of Object.entries(d.chips)) {
        if (def.prompt && !(def.prompt in prompts)) {
            problems.push(`chips.${k}.prompt "${def.prompt}" is not a prompt key`);
        }
        if (!commands.includes(def.command)) {
            problems.push(`chips.${k}.command "${def.command}" is neither "@kind" nor a chip command`);
        }
    }
    for (const [k, keys] of Object.entries(d.cases)) {
        for (const c of keys) {
            if (!(c in d.chips)) {
                problems.push(`cases.${k} names unknown chip "${c}"`);
            }
        }
    }
    for (const [k, def] of Object.entries(d.natural)) {
        const prompt = def?.prompt;
        if (typeof prompt === "string" && prompt.startsWith("@") && !(prompt.slice(1) in prompts)) {
            problems.push(`natural.${k}.prompt "${prompt}" is not a prompt key`);
        }
    }
    return problems;
};
exports.followupsProblems = followupsProblems;
//# sourceMappingURL=followups.js.map