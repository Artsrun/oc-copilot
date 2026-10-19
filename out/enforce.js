"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENFORCED_DENY_TOOLS = exports.ENFORCED_MARKER = void 0;
exports.readOnlySubagents = readOnlySubagents;
exports.readOnlyTools = readOnlyTools;
exports.hasEnforcedMarker = hasEnforcedMarker;
exports.writersDisabled = writersDisabled;
exports.readOnlyLeaks = readOnlyLeaks;
exports.judgeReadOnly = judgeReadOnly;
exports.coldEnforcement = coldEnforcement;
exports.enforcedConfigContent = enforcedConfigContent;
exports.enforcedReadOnlyNotice = enforcedReadOnlyNotice;
const core_1 = require("./core");
exports.ENFORCED_MARKER = "ocb-enforced";
const FORBIDDEN_SUBAGENTS = new Set(["plan", "build", "general"]);
let refusedSubagents = "";
function readOnlySubagents() {
    const dev = (0, core_1.config)().get("devAgent", "build").trim();
    const raw = ((0, core_1.config)().get("readOnlySubagents", ["explore"]) ?? [])
        .filter((a) => typeof a === "string")
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
    const bad = [...new Set(raw.filter((a) => /[*?]/.test(a) || FORBIDDEN_SUBAGENTS.has(a) || (dev.length > 0 && a === dev)))];
    if (bad.length && bad.join("\0") !== refusedSubagents) {
        refusedSubagents = bad.join("\0");
        core_1.logChannel?.appendLine(`[${(0, core_1.stamp)()}] readOnlySubagents: ${bad.join(", ")} is a wildcard or primary/dev agent; left out`);
    }
    return [...new Set(raw.filter((a) => !bad.includes(a)))];
}
const WRITERS = ["edit", "write", "patch", "apply_patch", "multiedit", "bash", "shell", "task", "subagent", "execute", "question", "external_directory", "plan_enter", "plan_exit"];
exports.ENFORCED_DENY_TOOLS = ["bash", "shell", "edit", "write", "patch", "apply_patch", "multiedit", "execute", "question", "plan_enter", "plan_exit"];
const wildcard = (pattern) => new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
let refusedTools = "";
function readOnlyTools() {
    const listed = ((0, core_1.config)().get("readOnlyTools", ["git-scan_gitScan"]) ?? []).filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim());
    const refused = listed.filter((t) => WRITERS.some((w) => wildcard(t).test(w)));
    if (refused.length && refused.join("\0") !== refusedTools) {
        refusedTools = refused.join("\0");
        core_1.logChannel?.appendLine(`[${(0, core_1.stamp)()}] readOnlyTools: ${refused.join(", ")} would allow a tool that writes, runs or delegates; left out`);
    }
    return listed.filter((t) => !refused.includes(t));
}
function readOnlyPermission(subagents, tools) {
    return {
        "*": "deny",
        ...Object.fromEntries(tools.map((t) => [t, "allow"])),
        read: { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" },
        grep: "allow",
        glob: "allow",
        list: "allow",
        lsp: "allow",
        skill: "allow",
        todowrite: "allow",
        todoread: "allow",
        webfetch: "allow",
        websearch: "allow",
        task: subagents ? { "*": "deny", ...Object.fromEntries(subagents.map((s) => [s, "allow"])) } : "deny",
        ...Object.fromEntries(exports.ENFORCED_DENY_TOOLS.filter((w) => w !== "bash").map((w) => [w, "deny"])),
        [exports.ENFORCED_MARKER]: "deny",
        bash: "deny"
    };
}
function hasEnforcedMarker(rules) {
    return rules.some((r) => (r.permission === exports.ENFORCED_MARKER && r.pattern === "*" && r.action === "deny") ||
        (r.permission === "bash" && r.pattern === exports.ENFORCED_MARKER && r.action === "deny"));
}
function writersDisabled(rules) {
    return exports.ENFORCED_DENY_TOOLS.every((tool) => {
        const last = rules.filter((r) => wildcard(r.permission).test(tool)).at(-1);
        return last?.pattern === "*" && last.action === "deny";
    });
}
const READ_ONLY_REACH = new Set(["grep", "glob", "list", "lsp", "skill", "todowrite", "todoread", "webfetch", "websearch", "external_directory", "doom_loop"]);
function readOnlyLeaks(rules, subagents, sessionTask) {
    let fence = rules.length - 1;
    while (fence >= 0 && !(rules[fence].permission === "*" && rules[fence].pattern === "*" && rules[fence].action === "deny")) {
        fence -= 1;
    }
    if (fence < 0) {
        return ["no `*: deny`"];
    }
    const tools = readOnlyTools();
    return rules
        .slice(fence + 1)
        .filter((r) => r.action !== "deny")
        .filter((r) => !(READ_ONLY_REACH.has(r.permission) ||
        (r.permission === "read" && (r.pattern === "*" || r.pattern === "*.env.example")) ||
        tools.some((t) => wildcard(t).test(r.permission)) ||
        (r.permission === "task" && (sessionTask || subagents.includes(r.pattern)))))
        .map((r) => `${r.permission}${r.pattern === "*" ? "" : ` ${r.pattern}`}: ${r.action}`);
}
function judgeReadOnly(rules, agent, where) {
    const at = where.base ? { base: where.base } : {};
    if (!rules?.length || (where.builtin && !hasEnforcedMarker(rules))) {
        return { kind: "unverified", agent, ...at };
    }
    const leaks = readOnlyLeaks(rules, where.subagents, where.sessionTask);
    if (leaks.length) {
        return where.builtin ? { kind: "reopened", agent, ...at, leaks } : { kind: "unverified", agent, ...at, leaks };
    }
    return writersDisabled(rules) ? { kind: "enforced", agent } : { kind: "unverified", agent, ...at };
}
function coldEnforcement(content, agent) {
    if (!(0, core_1.config)().get("enforceReadOnly", true)) {
        return { kind: "disabled" };
    }
    try {
        const parsed = content
            ? JSON.parse(content)
            : undefined;
        const perm = parsed?.agent?.[agent]?.permission;
        const bash = perm?.bash;
        const bashMap = bash && typeof bash === "object" && !Array.isArray(bash) ? bash : undefined;
        const bashKeys = bashMap ? Object.keys(bashMap) : [];
        const bashOk = (bash === "deny" && perm?.[exports.ENFORCED_MARKER] === "deny") ||
            (Boolean(bashMap) && bashKeys.includes(exports.ENFORCED_MARKER) && bashKeys.at(-1) === "*" && Object.values(bashMap).every((v) => v === "deny"));
        const writersDenied = exports.ENFORCED_DENY_TOOLS.every((tool) => (tool === "bash" ? bashOk : perm?.[tool] === "deny"));
        if (perm && Object.keys(perm)[0] === "*" && perm["*"] === "deny" && bashOk && writersDenied) {
            return { kind: "enforced", agent };
        }
    }
    catch {
    }
    return { kind: "unverified", agent };
}
let noted = false;
let refusedUserContent = "";
function enforcedConfigContent(existing = process.env.OPENCODE_CONFIG_CONTENT) {
    if (!(0, core_1.config)().get("enforceReadOnly", true)) {
        return undefined;
    }
    let base = {};
    if (existing && existing.trim()) {
        try {
            const parsed = JSON.parse(existing);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("not a JSON object");
            }
            base = parsed;
        }
        catch (error) {
            if (refusedUserContent !== existing) {
                refusedUserContent = existing;
                core_1.logChannel?.appendLine(`[${(0, core_1.stamp)()}] OPENCODE_CONFIG_CONTENT is set and is not a JSON object (${error}); read-only turns are not enforced by permission in the processes the bridge starts`);
            }
            return undefined;
        }
    }
    const subagents = readOnlySubagents();
    const tools = readOnlyTools();
    const agents = { ...(base.agent ?? {}) };
    const withPermission = (name, permission) => {
        const own = agents[name];
        agents[name] = { ...(own && typeof own === "object" ? own : {}), permission };
    };
    withPermission("plan", readOnlyPermission(subagents, tools));
    for (const name of subagents) {
        if (name !== "plan") {
            withPermission(name, readOnlyPermission(undefined, tools));
        }
    }
    if (!noted) {
        noted = true;
        core_1.logChannel?.appendLine(`[${(0, core_1.stamp)()}] read-only by permission in the processes the bridge starts: plan${subagents.length ? `, ${subagents.join(", ")}` : ""} (enforceReadOnly)`);
    }
    return JSON.stringify({ ...base, agent: agents });
}
const NOTED_KEY = "shellFreeReadOnlyNoted";
let notedWindow = false;
const unverifiedCustomNoted = new Set();
function enforcedReadOnlyNotice(evidence) {
    const builtin = evidence && evidence.kind !== "disabled" && (evidence.agent === "plan" || readOnlySubagents().includes(evidence.agent));
    if (evidence?.kind === "unverified") {
        if (!builtin) {
            const key = `${evidence.base ?? "cli"}\0${evidence.agent}\0${evidence.leaks?.join("\0") ?? ""}`;
            if (unverifiedCustomNoted.has(key)) {
                return undefined;
            }
            unverifiedCustomNoted.add(key);
            return evidence.leaks?.length
                ? `\`${evidence.agent}\` is a custom agent: its own rules apply, and they allow ${evidence.leaks.slice(0, 4).map((l) => `\`${l}\``).join(", ")}${evidence.leaks.length > 4 ? " and more" : ""}.`
                : `\`${evidence.agent}\` is a custom agent whose read-only permissions are not verified by the bridge; its own permissions apply.`;
        }
        return evidence.base
            ? `The OpenCode server at ${evidence.base} has no verified shell-free read-only rules for \`${evidence.agent}\`. Its agents keep their own permissions; only verified subagents are available. Use \`serverPort: 0\` to start a server with the current rules.`
            : `Read-only permissions could not be verified for \`${evidence.agent}\` in this process. Its own permissions apply; check \`OPENCODE_CONFIG_CONTENT\` and the agent configuration.`;
    }
    const state = core_1.extensionContext?.globalState;
    if (evidence?.kind !== "enforced" || !builtin || (state ? Boolean(state.get(NOTED_KEY)) : notedWindow)) {
        return undefined;
    }
    notedWindow = true;
    void state?.update(NOTED_KEY, true);
    return ("Plan turns are read-only by permission now: no edits or shell, inspection through read/search tools, " +
        "MCP tools only as `readOnlyTools` lists them (gitScan), " +
        "and only `readOnlySubagents` to delegate to. `enforceReadOnly: false` restores the old behaviour; `/dev` is unchanged.");
}
//# sourceMappingURL=enforce.js.map