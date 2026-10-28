"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contextOverflowing = exports.isTurnPermissionError = exports.serverEnforcement = exports.HEADLESS_PERMISSION = exports.sessionRoot = exports.sessionPath = exports.safeSessionId = void 0;
exports.turnPermission = turnPermission;
exports.readOnlyReach = readOnlyReach;
exports.readOnlyEvidence = readOnlyEvidence;
exports.assertReadOnly = assertReadOnly;
exports.sessionRules = sessionRules;
exports.applyTurnPermission = applyTurnPermission;
exports.noteTurnPermission = noteTurnPermission;
exports.isMissingSessionError = isMissingSessionError;
exports.isMissingSessionRun = isMissingSessionRun;
exports.isAttachFailure = isAttachFailure;
exports.sessionBusy = sessionBusy;
exports.abortChildren = abortChildren;
exports.abortServerRun = abortServerRun;
exports.createServerSession = createServerSession;
exports.compactionInFlight = compactionInFlight;
exports.compactSession = compactSession;
const core_1 = require("./core");
const net_1 = require("./net");
const oc_api_1 = require("./oc-api");
Object.defineProperty(exports, "safeSessionId", { enumerable: true, get: function () { return oc_api_1.safeSessionId; } });
Object.defineProperty(exports, "sessionPath", { enumerable: true, get: function () { return oc_api_1.sessionPath; } });
Object.defineProperty(exports, "sessionRoot", { enumerable: true, get: function () { return oc_api_1.sessionRoot; } });
const agents_1 = require("./agents");
const enforce_1 = require("./enforce");
exports.HEADLESS_PERMISSION = [
    { permission: "question", action: "deny", pattern: "*" },
    { permission: "plan_enter", action: "deny", pattern: "*" },
    { permission: "plan_exit", action: "deny", pattern: "*" }
];
function turnPermission(readOnly, allowed = (0, enforce_1.readOnlySubagents)()) {
    if (!readOnly) {
        return exports.HEADLESS_PERMISSION;
    }
    return [
        ...exports.HEADLESS_PERMISSION,
        { permission: "task", action: "deny", pattern: "*" },
        ...allowed.map((a) => ({ permission: "task", action: "allow", pattern: a }))
    ];
}
const withheldLogged = new Set();
const isBuiltinReadOnly = (agent) => agent === "plan" || (0, enforce_1.readOnlySubagents)().includes(agent);
async function overriddenOn(base, cwd) {
    return ((await (0, agents_1.listAgents)(cwd, base, "plan")) ?? [])
        .filter((a) => (0, enforce_1.judgeReadOnly)(a.permission, a.name, {
        builtin: true,
        subagents: a.name === "plan" ? (0, enforce_1.readOnlySubagents)() : [],
        sessionTask: a.name === "plan"
    }).kind === "enforced")
        .map((a) => a.name);
}
async function readOnlyReach(base, cwd) {
    const wanted = (0, enforce_1.readOnlySubagents)();
    if (!(0, core_1.config)().get("enforceReadOnly", true)) {
        return { allowed: wanted, planEnforced: false };
    }
    const overridden = await overriddenOn(base, cwd);
    return { allowed: wanted.filter((a) => overridden.includes(a)), planEnforced: overridden.includes("plan") };
}
async function readOnlyEvidence(base, cwd, agent) {
    if (!(0, core_1.config)().get("enforceReadOnly", true)) {
        return { kind: "disabled" };
    }
    const builtin = isBuiltinReadOnly(agent);
    if (!base && builtin) {
        const injected = (0, enforce_1.coldEnforcement)((0, enforce_1.enforcedConfigContent)(), agent);
        if (injected.kind !== "enforced") {
            return injected;
        }
    }
    const agents = await (0, agents_1.listAgents)(cwd, base, agent);
    const subagents = (0, enforce_1.readOnlySubagents)();
    const judge = (name, isBuiltin) => (0, enforce_1.judgeReadOnly)(agents?.find((a) => a.name === name)?.permission, name, {
        base,
        builtin: isBuiltin,
        subagents: name === "plan" || !isBuiltin ? subagents : [],
        sessionTask: Boolean(base)
    });
    const own = judge(agent, builtin);
    if (base || agent !== "plan" || own.kind !== "enforced") {
        return own;
    }
    return subagents.map((s) => judge(s, true)).find((e) => e.kind === "reopened") ?? own;
}
const serverEnforcement = (base, cwd, agent) => readOnlyEvidence(base, cwd, agent);
exports.serverEnforcement = serverEnforcement;
function assertReadOnly(evidence) {
    if (evidence?.kind === "unverified" && evidence.base && (0, oc_api_1.serverMajor)(evidence.base) === 2) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${evidence.agent}: no verified read-only rules on the OpenCode 2 server ${evidence.base} — not sent`);
        throw Object.assign(new Error(`Nothing was sent: the OpenCode 2 server at ${evidence.base} does not list the bridge's read-only rules for \`${evidence.agent}\`, ` +
            "and OpenCode 2's own plan can write. Retry; if it repeats, `/ping` and the debug log say what the server reported, or ask with `/dev`."), { code: "ETURNPERMISSION" });
    }
    if (evidence?.kind !== "reopened") {
        return;
    }
    const shown = evidence.leaks.slice(0, 5).map((l) => `\`${l}\``).join(", ") + (evidence.leaks.length > 5 ? ` and ${evidence.leaks.length - 5} more` : "");
    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${evidence.agent}: read-only rules reopened by config on ${evidence.base ?? "the CLI"} — ${evidence.leaks.join("; ")} — not sent`);
    throw Object.assign(new Error(`Nothing was sent: OpenCode's configuration gives \`${evidence.agent}\` back what the bridge's read-only rules deny — ${shown}. ` +
        `Such keys under \`agent.${evidence.agent}.permission\` (\`opencode.json\`, or \`.opencode/agents/${evidence.agent}.md\`, in the project or your global config) ` +
        "outlast the bridge's rules. Remove them, or ask with `/dev`; `enforceReadOnly: false` turns read-only by permission off."), { code: "ETURNPERMISSION" });
}
async function sessionRules(base, cwd, readOnly) {
    if (!readOnly) {
        return exports.HEADLESS_PERMISSION;
    }
    const reach = await readOnlyReach(base, cwd);
    if ((0, core_1.config)().get("enforceReadOnly", true)) {
        const left = (0, enforce_1.readOnlySubagents)().filter((a) => !reach.allowed.includes(a));
        const key = `${base}\0${left.join(",")}\0${reach.planEnforced}`;
        if (left.length && !withheldLogged.has(key)) {
            withheldLogged.add(key);
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${left.join(", ")}: not read-only by permission on ${base}${reach.planEnforced ? " (it started before readOnlySubagents changed: restart it)" : ""} — left out of read-only turns`);
        }
    }
    return turnPermission(true, reach.allowed);
}
const appliedRules = new Map();
const TASK_ALLOW_ALL = { permission: "task", action: "allow", pattern: "*" };
const glob = (pattern) => new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
async function devTaskRules(base, cwd, agent) {
    const listed = (await (0, agents_1.listAgents)(cwd, base, agent))?.find((a) => a.name === agent)?.permission;
    if (!listed) {
        throw new Error(`Cannot restore task permissions for agent ${agent}: authoritative permission rules are unavailable.`);
    }
    const own = listed.filter((r) => glob(r.permission).test("task")).map((r) => ({ permission: "task", action: r.action, pattern: r.pattern }));
    return own.some((r) => r.pattern === "*") ? own : [TASK_ALLOW_ALL, ...own];
}
async function carriesTaskRules(base, cwd, sessionId) {
    try {
        const session = await (0, oc_api_1.api)(base).sessionGet(cwd, sessionId, 2000);
        return Array.isArray(session?.permission) && session.permission.some((r) => (0, agents_1.isPermissionRule)(r) && r.permission === "task");
    }
    catch (error) {
        if (isMissingSessionError(error)) {
            throw error;
        }
        return true;
    }
}
const isTurnPermissionError = (error) => error?.code === "ETURNPERMISSION";
exports.isTurnPermissionError = isTurnPermissionError;
async function applyTurnPermission(base, cwd, sessionId, readOnly, agent = "build") {
    const rules = await sessionRules(base, cwd, readOnly);
    const key = `${base}\0${cwd}\0${sessionId}`;
    const want = JSON.stringify(rules);
    const had = appliedRules.get(key);
    if (had?.rules === want && (readOnly || !had.restoredAgent || had.restoredAgent === agent)) {
        return;
    }
    try {
        const restore = !readOnly && (had?.restoredAgent !== undefined ||
            (had !== undefined && had.rules !== want) ||
            await carriesTaskRules(base, cwd, sessionId));
        const sent = restore ? [...rules, ...(await devTaskRules(base, cwd, agent))] : rules;
        await (0, oc_api_1.api)(base).sessionPatch(cwd, sessionId, { permission: sent }, 3000);
        appliedRules.set(key, { rules: want, restoredAgent: restore ? agent : undefined });
        const none = readOnly && !rules.some((r) => r.permission === "task" && r.action === "allow");
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${sessionId}: ${readOnly ? (none ? "no subagents" : "read-only subagents only") : restore ? `headless rules; subagents as \`${agent}\` allows them` : "headless rules"}`);
    }
    catch (error) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] could not set the turn's rules on ${sessionId}: ${error}`);
        if (isMissingSessionError(error)) {
            throw error;
        }
        const why = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").replace(/`/g, "'");
        throw Object.assign(new Error(`Nothing was sent: this turn's permission rules could not be set on its OpenCode session (${(0, core_1.truncate)(why, 160)}). ` +
            "Retry; if it fails again, `/new` starts a session that gets them at creation."), { code: "ETURNPERMISSION" });
    }
}
function noteTurnPermission(base, sessionId, rules, cwd = "") {
    appliedRules.set(`${base}\0${cwd}\0${sessionId}`, { rules: JSON.stringify(rules) });
}
function isMissingSessionError(error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /^HTTP 404\b/.test(message) || /session not found/i.test(message);
}
function isMissingSessionRun(metrics) {
    if (metrics.exitCode === 0 || metrics.exitCode === undefined) {
        return false;
    }
    return /session not found/i.test(`${metrics.stderr ?? ""}${metrics.error ?? ""}`);
}
function isAttachFailure(metrics) {
    if (metrics.exitCode === 0 || metrics.exitCode === undefined || metrics.hadOutput || metrics.steps.length) {
        return false;
    }
    return /ECONNREFUSED|ECONNRESET|fetch failed|unable to connect|socket hang up/i.test(`${metrics.stderr ?? ""}${metrics.error ?? ""}`);
}
async function sessionBusy(base, sessionId, cwd) {
    try {
        const all = await (0, oc_api_1.api)(base).sessionStatus(cwd, 3000);
        const st = all?.[sessionId]?.type;
        return Boolean(st && st !== "idle");
    }
    catch {
        return undefined;
    }
}
const TREE_DEPTH = 2;
const TREE_MAX = 16;
async function abortChildren(base, sessionId, cwd, known = []) {
    const seen = new Set(known.filter((id) => id !== sessionId));
    let level = [sessionId];
    for (let depth = 0; depth < TREE_DEPTH && level.length && seen.size < TREE_MAX; depth += 1) {
        const next = [];
        for (const id of level) {
            try {
                const kids = (await (0, oc_api_1.api)(base).sessionChildren(cwd, id, 3000));
                for (const k of Array.isArray(kids) ? kids : []) {
                    if (typeof k?.id === "string" && !seen.has(k.id) && seen.size < TREE_MAX) {
                        seen.add(k.id);
                        next.push(k.id);
                    }
                }
            }
            catch {
            }
        }
        level = next;
    }
    const ids = [...seen];
    await Promise.all(ids.map((id) => (0, oc_api_1.api)(base).sessionAbort(cwd, id, 3000).catch(() => undefined)));
    if (ids.length) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] aborted ${ids.length} subagent session(s) under ${sessionId}`);
    }
    return ids;
}
async function abortServerRun(base, sessionId, cwd, why) {
    try {
        await (0, oc_api_1.api)(base).sessionAbort(cwd, sessionId, 5000);
    }
    catch (error) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] abort ${sessionId} failed (${why}): ${error}`);
        return false;
    }
    void abortChildren(base, sessionId, cwd);
    for (let i = 0; i < 15; i++) {
        if ((await sessionBusy(base, sessionId, cwd)) === false) {
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] aborted server run ${sessionId} (${why})`);
            return true;
        }
        await (0, core_1.delay)(200);
    }
    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] abort ${sessionId} sent but the session still reports busy (${why})`);
    return false;
}
async function createServerSession(base, cwd, title, readOnly = false) {
    const permission = await sessionRules(base, cwd, readOnly);
    const created = await (0, oc_api_1.api)(base).sessionCreate(cwd, { title: (0, core_1.truncate)(title, 60), permission }, 5000);
    noteTurnPermission(base, created.id, permission, cwd);
    return created.id;
}
async function sessionModel(base, cwd, sessionId) {
    try {
        const messages = (await (0, oc_api_1.api)(base).sessionMessages(cwd, sessionId, 6, 5000));
        for (const message of [...(Array.isArray(messages) ? messages : [])].reverse()) {
            const info = message?.info ?? {};
            if (info.role === "assistant" && typeof info.providerID === "string" && typeof info.modelID === "string") {
                return `${info.providerID}/${info.modelID}`;
            }
            const sent = info.model;
            const id = sent?.modelID ?? sent?.id;
            if (info.role === "user" && sent?.providerID && id) {
                return `${sent.providerID}/${id}`;
            }
        }
    }
    catch (error) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] could not read the model of ${sessionId}: ${error}`);
    }
    return undefined;
}
const COMPACT_TIMEOUT_MS = 180000;
const COMPACT_BACKOFF_MS = 5 * 60000;
let compactServerFailedAt = 0;
const compactions = new Map();
const COMPACT_CONTEXT_TOKENS = 60000;
const COMPACT_CONTEXT_SHARE = 0.7;
const contextOverflowing = (tokens, limit) => tokens > COMPACT_CONTEXT_TOKENS || (limit !== undefined && tokens >= limit * COMPACT_CONTEXT_SHARE);
exports.contextOverflowing = contextOverflowing;
function compactionInFlight(sessionId) {
    return compactions.get(sessionId);
}
function compactSession(sessionId, cwd, model, asked = false) {
    const running = compactions.get(sessionId);
    if (running) {
        return running;
    }
    const work = summarize(sessionId, cwd, model, asked);
    compactions.set(sessionId, work);
    const done = () => {
        if (compactions.get(sessionId) === work) {
            compactions.delete(sessionId);
        }
    };
    work.then(done, done);
    return work;
}
async function summarize(sessionId, cwd, model, asked) {
    if (!asked && Date.now() - compactServerFailedAt < COMPACT_BACKOFF_MS) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] compact skipped: the server failed to start ${Math.round((Date.now() - compactServerFailedAt) / 1000)}s ago`);
        return false;
    }
    let base;
    try {
        base = await (0, net_1.ensureServer)(cwd);
    }
    catch (error) {
        compactServerFailedAt = Date.now();
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] compact failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
    compactServerFailedAt = 0;
    try {
        const spec = model ??
            (await sessionModel(base, cwd, sessionId)) ??
            ((0, core_1.config)().get("model", "").trim() || undefined);
        const index = spec?.indexOf("/") ?? -1;
        if (!spec || index <= 0) {
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] compact skipped: the model of ${sessionId} is not known yet`);
            return false;
        }
        const parts = { providerID: spec.slice(0, index), modelID: spec.slice(index + 1) };
        const status = await (0, oc_api_1.api)(base).sessionSummarize(cwd, sessionId, { providerID: parts.providerID, modelID: parts.modelID, auto: false }, COMPACT_TIMEOUT_MS);
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] summarize ${sessionId} with ${parts.providerID}/${parts.modelID} → HTTP ${status}`);
        return status >= 200 && status < 300;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] compact failed: ${message}`);
        return false;
    }
}
//# sourceMappingURL=server-session.js.map