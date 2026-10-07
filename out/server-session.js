"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HEADLESS_PERMISSION = exports.sessionRoot = exports.sessionPath = void 0;
exports.safeSessionId = safeSessionId;
exports.turnPermission = turnPermission;
exports.applyTurnPermission = applyTurnPermission;
exports.noteTurnPermission = noteTurnPermission;
exports.isMissingSessionError = isMissingSessionError;
exports.isMissingSessionRun = isMissingSessionRun;
exports.isAttachFailure = isAttachFailure;
exports.sessionBusy = sessionBusy;
exports.abortChildren = abortChildren;
exports.abortServerRun = abortServerRun;
exports.createServerSession = createServerSession;
exports.sessionModel = sessionModel;
exports.compactionInFlight = compactionInFlight;
exports.compactSession = compactSession;
exports.resetCompactBackoff = resetCompactBackoff;
const core_1 = require("./core");
const net_1 = require("./net");
const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
function safeSessionId(sessionId) {
    if (SAFE_ID.test(sessionId)) {
        return sessionId;
    }
    const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[.-]+/, "_").slice(0, 128);
    const safe = cleaned || "session";
    core_1.logChannel?.appendLine(`[${(0, core_1.stamp)()}] unsafe session id ${JSON.stringify(sessionId)} → ${safe}`);
    return safe;
}
const sessionPath = (sessionId, tail) => `/session/${safeSessionId(sessionId)}/${tail}`;
exports.sessionPath = sessionPath;
const sessionRoot = (sessionId) => `/session/${safeSessionId(sessionId)}`;
exports.sessionRoot = sessionRoot;
exports.HEADLESS_PERMISSION = [
    { permission: "question", action: "deny", pattern: "*" },
    { permission: "plan_enter", action: "deny", pattern: "*" },
    { permission: "plan_exit", action: "deny", pattern: "*" }
];
function turnPermission(readOnly) {
    if (!readOnly) {
        return exports.HEADLESS_PERMISSION;
    }
    const allowed = (0, core_1.config)().get("readOnlySubagents", ["explore"]) ?? [];
    return [
        ...exports.HEADLESS_PERMISSION,
        { permission: "task", action: "deny", pattern: "*" },
        ...allowed.filter((a) => typeof a === "string" && a.trim()).map((a) => ({ permission: "task", action: "allow", pattern: a.trim() }))
    ];
}
const appliedRules = new Map();
async function applyTurnPermission(base, cwd, sessionId, readOnly) {
    const rules = turnPermission(readOnly);
    const key = `${base}\0${sessionId}`;
    const want = JSON.stringify(rules);
    if (appliedRules.get(key) === want) {
        return;
    }
    try {
        await (0, net_1.httpRequestJson)("PATCH", (0, net_1.withDirectory)(`${base}${(0, exports.sessionRoot)(sessionId)}`, cwd), { permission: rules }, 3000);
        appliedRules.set(key, want);
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${sessionId}: ${readOnly ? "read-only subagents only" : "headless rules"}`);
    }
    catch (error) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] could not set the turn's rules on ${sessionId}: ${error}`);
    }
}
function noteTurnPermission(base, sessionId, readOnly) {
    appliedRules.set(`${base}\0${sessionId}`, JSON.stringify(turnPermission(readOnly)));
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
        const all = await (0, net_1.httpGetJson)((0, net_1.withDirectory)(`${base}/session/status`, cwd), 3000);
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
                const kids = await (0, net_1.httpGetJson)((0, net_1.withDirectory)(`${base}${(0, exports.sessionPath)(id, "children")}`, cwd), 3000);
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
    await Promise.all(ids.map((id) => (0, net_1.httpRequestJson)("POST", (0, net_1.withDirectory)(`${base}${(0, exports.sessionPath)(id, "abort")}`, cwd), undefined, 3000).catch(() => undefined)));
    if (ids.length) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] aborted ${ids.length} subagent session(s) under ${sessionId}`);
    }
    return ids;
}
async function abortServerRun(base, sessionId, cwd, why) {
    try {
        await (0, net_1.httpRequestJson)("POST", (0, net_1.withDirectory)(`${base}${(0, exports.sessionPath)(sessionId, "abort")}`, cwd), undefined, 5000);
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
    const created = await (0, net_1.httpRequestJson)("POST", (0, net_1.withDirectory)(`${base}/session`, cwd), {
        title: (0, core_1.truncate)(title, 60),
        permission: turnPermission(readOnly)
    }, 5000);
    noteTurnPermission(base, created.id, readOnly);
    return created.id;
}
async function sessionModel(base, cwd, sessionId) {
    try {
        const messages = await (0, net_1.httpGetJson)((0, net_1.withDirectory)(`${base}${(0, exports.sessionPath)(sessionId, "message")}?limit=6`, cwd), 5000);
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
        const status = await (0, net_1.httpPostJson)((0, net_1.withDirectory)(`${base}${(0, exports.sessionPath)(sessionId, "summarize")}`, cwd), { providerID: parts.providerID, modelID: parts.modelID, auto: false }, COMPACT_TIMEOUT_MS);
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] summarize ${sessionId} with ${parts.providerID}/${parts.modelID} → HTTP ${status}`);
        return status >= 200 && status < 300;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] compact failed: ${message}`);
        return false;
    }
}
function resetCompactBackoff() {
    compactServerFailedAt = 0;
}
//# sourceMappingURL=server-session.js.map