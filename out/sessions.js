"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteSession = exports.archiveSession = exports.forkSession = exports.sessionExcerpt = exports.listSessions = exports.busySessions = void 0;
const oc_api_1 = require("./oc-api");
const runs_1 = require("./runs");
const TIMEOUT_MS = 5000;
const busySessions = async (base, cwd) => {
    try {
        const all = await (0, oc_api_1.api)(base).sessionStatus(cwd, 3000);
        return new Set(Object.entries(all ?? {}).filter(([, v]) => v?.type && v.type !== "idle").map(([k]) => k));
    }
    catch {
        return new Set();
    }
};
exports.busySessions = busySessions;
const listSessions = async (base, cwd, limit = 50) => {
    const all = (await (0, oc_api_1.api)(base).sessions(cwd, { roots: true, limit }, TIMEOUT_MS));
    return (Array.isArray(all) ? all : []).filter((s) => s && typeof s.id === "string" && !s.time?.archived);
};
exports.listSessions = listSessions;
const textOf = (m) => (m.parts ?? []).filter((p) => p.type === "text" && !p.synthetic && p.text).map((p) => p.text).join("\n").trim();
const sessionExcerpt = async (base, cwd, id) => {
    const msgs = (await (0, oc_api_1.api)(base).sessionMessages(cwd, id, 20, TIMEOUT_MS));
    const list = Array.isArray(msgs) ? msgs : [];
    const last = (role) => [...list].reverse().map((m) => (m.info?.role === role ? textOf(m) : "")).find(Boolean);
    return { ask: last("user"), answer: last("assistant") };
};
exports.sessionExcerpt = sessionExcerpt;
const forkSession = async (base, cwd, id) => {
    const fork = await (0, oc_api_1.api)(base).sessionFork(cwd, id, TIMEOUT_MS);
    try {
        await (0, oc_api_1.api)(base).sessionPatch(cwd, fork.id, { permission: runs_1.HEADLESS_PERMISSION }, TIMEOUT_MS);
    }
    catch (error) {
        await (0, oc_api_1.api)(base).sessionDelete(cwd, fork.id, TIMEOUT_MS).catch(() => undefined);
        throw error;
    }
    return fork;
};
exports.forkSession = forkSession;
const stopRun = async (base, cwd, id, why) => {
    if (await (0, runs_1.sessionBusy)(base, id, cwd)) {
        await (0, runs_1.abortServerRun)(base, id, cwd, why);
    }
};
const archiveSession = async (base, cwd, id) => {
    await stopRun(base, cwd, id, "closed from /sessions");
    await (0, oc_api_1.api)(base).sessionPatch(cwd, id, { time: { archived: Date.now() } }, TIMEOUT_MS);
};
exports.archiveSession = archiveSession;
const deleteSession = async (base, cwd, id) => {
    await stopRun(base, cwd, id, "deleted from /sessions");
    await (0, oc_api_1.api)(base).sessionDelete(cwd, id, TIMEOUT_MS);
};
exports.deleteSession = deleteSession;
//# sourceMappingURL=sessions.js.map