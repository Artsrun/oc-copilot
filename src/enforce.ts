// claim:enforced-read-only — spawned processes receive shell-free agent
// permissions through OPENCODE_CONFIG_CONTENT. Inspection uses dedicated tools:
// a Git inspection command executed a writing external helper (REFS). Leaf.
import { config, extensionContext, logChannel, stamp } from "./core";
import type { ReadOnlyEnforcement } from "./metrics";

/** Discovery metadata, before the final catch-all deny that withholds bash. */
export const ENFORCED_MARKER = "ocb-enforced";

const FORBIDDEN_SUBAGENTS = new Set(["plan", "build", "general"]);
let refusedSubagents = "";

/** The subagents a read-only turn may start (`readOnlySubagents`). */
export function readOnlySubagents(): string[] {
    const dev = config().get<string>("devAgent", "build").trim();
    const raw = (config().get<string[]>("readOnlySubagents", ["explore"]) ?? [])
        .filter((a) => typeof a === "string")
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
    const bad = [...new Set(raw.filter((a) => /[*?]/.test(a) || FORBIDDEN_SUBAGENTS.has(a) || (dev.length > 0 && a === dev)))];
    if (bad.length && bad.join("\0") !== refusedSubagents) {
        refusedSubagents = bad.join("\0");
        logChannel?.appendLine(`[${stamp()}] readOnlySubagents: ${bad.join(", ")} is a wildcard or primary/dev agent; left out`);
    }
    return [...new Set(raw.filter((a) => !bad.includes(a)))];
}

// Tools that write, run or delegate: `readOnlyTools` never gives one back, not
// even through a wildcard (`*`, `e*`). Both majors' names.
const WRITERS = ["edit", "write", "patch", "apply_patch", "multiedit", "bash", "shell", "task", "subagent", "execute", "question", "external_directory", "plan_enter", "plan_exit"];
export const ENFORCED_DENY_TOOLS = ["bash", "shell", "edit", "write", "patch", "apply_patch", "multiedit", "execute", "question", "plan_enter", "plan_exit"] as const;
const wildcard = (pattern: string): RegExp =>
    new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
let refusedTools = "";

/** More tools a read-only turn may use (`readOnlyTools`): MCP tools by OpenCode
 * permission name, `<server>_<tool>` on 1.x (`git-scan_gitScan`, measured). */
export function readOnlyTools(): string[] {
    const listed = (config().get<string[]>("readOnlyTools", ["git-scan_gitScan"]) ?? []).filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim());
    const refused = listed.filter((t) => WRITERS.some((w) => wildcard(t).test(w)));
    if (refused.length && refused.join("\0") !== refusedTools) {
        refusedTools = refused.join("\0");
        logChannel?.appendLine(`[${stamp()}] readOnlyTools: ${refused.join(", ")} would allow a tool that writes, runs or delegates; left out`);
    }
    return listed.filter((t) => !refused.includes(t));
}

// `"*": deny` first: a tool nobody listed (MCP tools, 2.x's Code Mode `execute`,
// which can POST anywhere and create worktrees, measured) is denied, then
// `readOnlyTools` allowed. Every writing/running tool is also explicitly denied
// (`edit: "deny"`, etc.): OpenCode deep-merges config objects and keeps earlier
// keys in place (`opencode.json` with `edit: "allow"` after `"*"`), so relying
// on `"*": "deny"` alone let project config re-enable `edit` and `bash` (1.18.35,
// 1.19.0 measured). A scalar `"deny"` replaces any earlier pattern map on that
// key, and `[ENFORCED_MARKER]: "deny"` is a top-level permission key so `bash`
// can stay scalar `"deny"`. Key order is rule order.
function readOnlyPermission(subagents: string[] | undefined, tools: string[]): Record<string, unknown> {
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
        ...Object.fromEntries(ENFORCED_DENY_TOOLS.filter((w) => w !== "bash").map((w) => [w, "deny"])),
        [ENFORCED_MARKER]: "deny",
        bash: "deny"
    };
}

/** One rule as OpenCode lists an agent's permission (`GET /agent`, `opencode agent list`). */
export interface ListedRule {
    permission: string;
    pattern: string;
    action: string;
}

/** The bridge's overrides are on these rules (top-level marker; 0.0.216's bash pattern too). */
export function hasEnforcedMarker(rules: readonly ListedRule[]): boolean {
    return rules.some((r) =>
        (r.permission === ENFORCED_MARKER && r.pattern === "*" && r.action === "deny") ||
        (r.permission === "bash" && r.pattern === ENFORCED_MARKER && r.action === "deny")
    );
}

/** Every writing/running tool is withheld: its last matching rule is `* deny`.
 * A tool offered with every command denied is not enough (parser edges, REFS). */
export function writersDisabled(rules: readonly ListedRule[]): boolean {
    return ENFORCED_DENY_TOOLS.every((tool) => {
        const last = rules.filter((r) => wildcard(r.permission).test(tool)).at(-1);
        return last?.pattern === "*" && last.action === "deny";
    });
}

// What the overrides allow after their `"*": deny`. external_directory only
// widens where those read tools reach (OpenCode appends its tool-output folder);
// doom_loop is the repeated-call prompt, not a tool. Anything else fails closed,
// a read-only tool OpenCode adds later included: the refusal names it.
const READ_ONLY_REACH = new Set(["grep", "glob", "list", "lsp", "skill", "todowrite", "todoread", "webfetch", "websearch", "external_directory", "doom_loop"]);

/**
 * Rules that allow (or ask for) anything the overrides do not, after the LAST
 * `* * deny`. OpenCode merges config objects key by key and keeps an earlier
 * file's key in place, so a key the bridge does not set — an MCP tool
 * (`"github_*": "allow"`), a custom tool, `task: { general: "allow" }` — keeps
 * its allow after the bridge's `"*": "deny"` (1.18.35, 1.19.0 measured).
 * An allowlist, so a tool OpenCode adds later is a leak too. `sessionTask`:
 * the session's own `task` rules come last (server path), so task is theirs.
 */
export function readOnlyLeaks(rules: readonly ListedRule[], subagents: readonly string[], sessionTask: boolean): string[] {
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
        .filter((r) => !(
            READ_ONLY_REACH.has(r.permission) ||
            (r.permission === "read" && (r.pattern === "*" || r.pattern === "*.env.example")) ||
            tools.some((t) => wildcard(t).test(r.permission)) ||
            (r.permission === "task" && (sessionTask || subagents.includes(r.pattern)))
        ))
        .map((r) => `${r.permission}${r.pattern === "*" ? "" : ` ${r.pattern}`}: ${r.action}`);
}

/**
 * What an agent's effective rules prove. `builtin`: plan or a readOnlySubagent,
 * which carry the bridge's overrides where the bridge configured the process —
 * reopened there refuses the turn; without the marker it is someone else's
 * server (unverified, as documented). A custom agent keeps its own rules: the
 * bridge only reports them.
 */
export function judgeReadOnly(
    rules: readonly ListedRule[] | undefined,
    agent: string,
    where: { base?: string; builtin: boolean; subagents: readonly string[]; sessionTask: boolean }
): ReadOnlyEnforcement {
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

/** Verifies whether an OPENCODE_CONFIG_CONTENT payload enforces shell-free read-only rules for `agent`. */
export function coldEnforcement(content: string | undefined, agent: string): ReadOnlyEnforcement {
    if (!config().get<boolean>("enforceReadOnly", true)) {
        return { kind: "disabled" };
    }
    try {
        const parsed = content
            ? (JSON.parse(content) as { agent?: Record<string, { permission?: Record<string, unknown> }> })
            : undefined;
        const perm = parsed?.agent?.[agent]?.permission;
        const bash = perm?.bash;
        const bashMap = bash && typeof bash === "object" && !Array.isArray(bash) ? (bash as Record<string, unknown>) : undefined;
        const bashKeys = bashMap ? Object.keys(bashMap) : [];
        const bashOk =
            (bash === "deny" && perm?.[ENFORCED_MARKER] === "deny") ||
            (Boolean(bashMap) && bashKeys.includes(ENFORCED_MARKER) && bashKeys.at(-1) === "*" && Object.values(bashMap as Record<string, unknown>).every((v) => v === "deny"));
        const writersDenied = ENFORCED_DENY_TOOLS.every((tool) => (tool === "bash" ? bashOk : perm?.[tool] === "deny"));
        if (perm && Object.keys(perm)[0] === "*" && perm["*"] === "deny" && bashOk && writersDenied) {
            return { kind: "enforced", agent };
        }
    } catch {
        // fall through to unverified
    }
    return { kind: "unverified", agent };
}

let noted = false;
let refusedUserContent = "";

/**
 * The OPENCODE_CONFIG_CONTENT a spawned OpenCode gets, or undefined (setting
 * off, or a user value that is not a JSON object: it is left alone). A user's
 * own value is merged, and these agents' `permission` replaces theirs.
 */
export function enforcedConfigContent(existing = process.env.OPENCODE_CONFIG_CONTENT): string | undefined {
    if (!config().get<boolean>("enforceReadOnly", true)) {
        return undefined;
    }
    let base: Record<string, unknown> = {};
    if (existing && existing.trim()) {
        try {
            const parsed = JSON.parse(existing) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("not a JSON object");
            }
            base = parsed as Record<string, unknown>;
        } catch (error) {
            if (refusedUserContent !== existing) {
                refusedUserContent = existing;
                logChannel?.appendLine(`[${stamp()}] OPENCODE_CONFIG_CONTENT is set and is not a JSON object (${error}); read-only turns are not enforced by permission in the processes the bridge starts`);
            }
            return undefined;
        }
    }
    const subagents = readOnlySubagents();
    const tools = readOnlyTools();
    const agents = { ...((base.agent as Record<string, unknown> | undefined) ?? {}) };
    const withPermission = (name: string, permission: Record<string, unknown>): void => {
        const own = agents[name];
        agents[name] = { ...(own && typeof own === "object" ? (own as Record<string, unknown>) : {}), permission };
    };
    withPermission("plan", readOnlyPermission(subagents, tools));
    for (const name of subagents) {
        if (name !== "plan") {
            withPermission(name, readOnlyPermission(undefined, tools));
        }
    }
    if (!noted) {
        noted = true;
        logChannel?.appendLine(`[${stamp()}] read-only by permission in the processes the bridge starts: plan${subagents.length ? `, ${subagents.join(", ")}` : ""} (enforceReadOnly)`);
    }
    return JSON.stringify({ ...base, agent: agents });
}

// Said once per install, after the first plan turn that ran enforced, and at
// most once per window (a cleared globalState does not repeat it).
const NOTED_KEY = "shellFreeReadOnlyNoted";
let notedWindow = false;
const unverifiedCustomNoted = new Set<string>();

/** The one line that tells a user plan turns changed, or undefined. */
export function enforcedReadOnlyNotice(evidence: ReadOnlyEnforcement | undefined): string | undefined {
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
    // A custom agent's own rules passed: the note below describes the bridge's overrides, not them.
    const state = extensionContext?.globalState;
    if (evidence?.kind !== "enforced" || !builtin || (state ? Boolean(state.get(NOTED_KEY)) : notedWindow)) {
        return undefined;
    }
    notedWindow = true;
    void state?.update(NOTED_KEY, true);
    return (
        "Plan turns are read-only by permission now: no edits or shell, inspection through read/search tools, " +
        "MCP tools only as `readOnlyTools` lists them (gitScan), " +
        "and only `readOnlySubagents` to delegate to. `enforceReadOnly: false` restores the old behaviour; `/dev` is unchanged."
    );
}
