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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROUTED_COMMANDS = exports.KIND_COMMAND_NAMES = exports.allCommands = exports.DEFAULT_ALIASES = exports.SLASH_COMMANDS = void 0;
exports.controlCommand = controlCommand;
exports.typedSlash = typedSlash;
exports.commandAliases = commandAliases;
exports.resolveAlias = resolveAlias;
exports.kindChoice = kindChoice;
exports.retiredCommand = retiredCommand;
exports.isKindCommand = isKindCommand;
exports.helpMarkdown = helpMarkdown;
const core_1 = require("./core");
__exportStar(require("./heartbeat"), exports);
__exportStar(require("./lanes"), exports);
__exportStar(require("./chips"), exports);
exports.SLASH_COMMANDS = ["new", "session", "sessions", "help", "model", "ping", "env", "stop", "compact"];
const CONTROL_COMMANDS = new Set(exports.SLASH_COMMANDS);
const KIND_COMMANDS = {
    plan: "plan",
    dev: "dev",
    parallel: "parallel"
};
function controlCommand(declared, typed) {
    return CONTROL_COMMANDS.has(declared) ? declared : typed;
}
function typedSlash(prompt) {
    return (prompt.match(new RegExp(`^/(${exports.SLASH_COMMANDS.join("|")})\\b\\s*`, "i"))?.[1]?.toLowerCase() ?? "");
}
exports.DEFAULT_ALIASES = {
    p: "parallel",
    d: "dev",
    pl: "plan",
    n: "new",
    s: "session",
    x: "stop",
    m: "model",
    w: "worktree",
    e: "env",
    ls: "sessions",
    h: "help",
    "?": "help"
};
const allCommands = () => [...exports.SLASH_COMMANDS, ...exports.KIND_COMMAND_NAMES, ...exports.ROUTED_COMMANDS];
exports.allCommands = allCommands;
const bare = (word) => word.trim().replace(/^\//, "").toLowerCase();
function commandAliases(user = (0, core_1.config)().get("commandAliases", {})) {
    const table = { ...exports.DEFAULT_ALIASES };
    if (user && typeof user === "object") {
        for (const [k, v] of Object.entries(user)) {
            if (typeof v === "string" && bare(k) && bare(v)) {
                table[bare(k)] = bare(v);
            }
        }
    }
    return table;
}
function resolveAlias(prompt, table = commandAliases()) {
    const m = prompt.match(/^\/(\S+)(?=\s|$)/);
    if (!m) {
        return { prompt };
    }
    const word = m[1].toLowerCase();
    const commands = (0, exports.allCommands)();
    if (commands.includes(word) || word === "par") {
        return { prompt };
    }
    const target = (0, core_1.own)(table, word);
    if (!target) {
        return { prompt };
    }
    if (!commands.includes(target)) {
        return {
            prompt,
            problem: `\`/${word}\` is set to \`/${target}\` in \`commandAliases\`, and that is not a command. ` +
                `Commands: ${commands.map((c) => `\`/${c}\``).join(" ")}.`
        };
    }
    return { prompt: `/${target}${prompt.slice(m[0].length)}` };
}
function kindChoice(declared, parsedKind) {
    return (0, core_1.own)(KIND_COMMANDS, declared) ?? parsedKind;
}
exports.KIND_COMMAND_NAMES = Object.keys(KIND_COMMANDS);
exports.ROUTED_COMMANDS = ["worktree"];
const RETIRED = { flow: "0.0.196", f: "0.0.196" };
function retiredCommand(prompt) {
    const word = prompt.match(/^\/(\S+)(?=\s|$)/)?.[1]?.toLowerCase() ?? "";
    const since = (0, core_1.own)(RETIRED, word);
    return since ? `\`/${word}\` was removed in ${since}, so nothing was run. \`/help\` lists the commands.` : undefined;
}
function isKindCommand(declared) {
    return Boolean((0, core_1.own)(KIND_COMMANDS, declared));
}
function helpMarkdown() {
    return [
        `**OpenCode bridge** — one ongoing session per ${(0, core_1.config)().get("sessionScope", "thread") === "workspace" ? "folder" : "chat"}.`,
        "",
        "| Command | What it does |",
        "| --- | --- |",
        "| `/plan <task>` | Read-only agent (default): `plan`, or your `planAgent` |",
        "| `/dev <task>` | Editing agent — may write files |",
        "| `/parallel a \\| b \\| c` | Run independent lanes at once in isolated sessions — `/parallel` alone composes them step by step |",
        "| `/worktree <task>` | Editing agent in a NEW git worktree + branch next to the repo; your checkout is untouched |",
        "| `/session` | Session id, turns, totals |",
        "| `/sessions` | This folder's sessions: continue, fork, close or delete one |",
        "| `/stop` | Stop a run still going on the server (closing the chat does not) |",
        "| `/compact` | Summarise this chat's session now (one model pass), as autocompact does |",
        "| `/new` | Start a fresh session |",
        "| `/model` | Show and change the model chain |",
        "| `/ping` | Connectivity check — no model call, no cost |",
        "| `/env` | What OpenCode loaded: config, plugins, hooks, MCP, skills |",
        "| `/help` | This table |",
        "",
        "Inline prefixes still work: `dev:`, `model:provider/id` — or a short name, `model:tundra`.",
        "Lanes split on `|`, `;;` or a `---` line. Per lane: `/parallel m:tundra review auth | m:oasis read the logs`, and `a:<agent>` runs a lane as one of your primary agents (`a:look m:oasis read the logs`). One task on several models: `/parallel models:tundra,oasis,aspen review auth`.",
        "Attach files with `#file:` — they are passed to OpenCode as context.",
        "",
        `Aliases: ${Object.entries(commandAliases())
            .map(([k, v]) => `\`/${k}\` ${v}`)
            .join(" · ")} — add your own with the \`commandAliases\` setting.`
    ].join("\n");
}
//# sourceMappingURL=chat-boot.js.map