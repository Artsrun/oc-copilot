"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionRoot = exports.sessionPath = void 0;
exports.safeSessionId = safeSessionId;
exports.serverMajor = serverMajor;
exports.api = api;
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
function serverMajor(base) {
    return /^v?2\./.test((0, net_1.serverVersion)(base) ?? "") ? 2 : 1;
}
const v1 = (base) => {
    const at = (path, cwd) => (0, net_1.withDirectory)(`${base}${path}`, cwd);
    return {
        health: (timeoutMs) => (0, net_1.httpGetJson)(`${base}/global/health`, timeoutMs),
        agents: (cwd, timeoutMs) => (0, net_1.httpGetJson)(at("/agent", cwd), timeoutMs),
        providers: (cwd, timeoutMs) => (0, net_1.httpGetJson)(at("/config/providers", cwd), timeoutMs),
        sessionsRaw: (cwd, timeoutMs) => (0, net_1.httpGetJson)(at("/session", cwd), timeoutMs),
        sessions: (cwd, query, timeoutMs) => (0, net_1.httpRequestJson)("GET", at(`/session?roots=${query.roots}&limit=${query.limit}`, cwd), undefined, timeoutMs),
        sessionStatus: (cwd, timeoutMs) => (0, net_1.httpGetJson)(at("/session/status", cwd), timeoutMs),
        sessionGet: (cwd, id, timeoutMs) => (0, net_1.httpGetJson)(at((0, exports.sessionRoot)(id), cwd), timeoutMs),
        sessionCreate: (cwd, body, timeoutMs) => (0, net_1.httpRequestJson)("POST", at("/session", cwd), body, timeoutMs),
        sessionPatch: (cwd, id, body, timeoutMs) => (0, net_1.httpRequestJson)("PATCH", at((0, exports.sessionRoot)(id), cwd), body, timeoutMs),
        sessionDelete: (cwd, id, timeoutMs) => (0, net_1.httpRequestJson)("DELETE", at((0, exports.sessionRoot)(id), cwd), undefined, timeoutMs),
        sessionFork: (cwd, id, timeoutMs) => (0, net_1.httpRequestJson)("POST", at((0, exports.sessionPath)(id, "fork"), cwd), undefined, timeoutMs),
        sessionChildren: (cwd, id, timeoutMs) => (0, net_1.httpGetJson)(at((0, exports.sessionPath)(id, "children"), cwd), timeoutMs),
        sessionMessages: (cwd, id, limit, timeoutMs) => (0, net_1.httpGetJson)(at(`${(0, exports.sessionPath)(id, "message")}?limit=${limit}`, cwd), timeoutMs),
        sessionAbort: (cwd, id, timeoutMs) => (0, net_1.httpRequestJson)("POST", at((0, exports.sessionPath)(id, "abort"), cwd), undefined, timeoutMs),
        sessionPrompt: (cwd, id, body, timeoutMs, token) => (0, net_1.httpRequestJson)("POST", at((0, exports.sessionPath)(id, "message"), cwd), body, timeoutMs, token),
        sessionSummarize: (cwd, id, body, timeoutMs) => (0, net_1.httpPostJson)(at((0, exports.sessionPath)(id, "summarize"), cwd), body, timeoutMs),
        permissionReply: (cwd, sessionId, askId, legacy, body, timeoutMs) => (0, net_1.httpRequestJson)("POST", at(legacy ? (0, exports.sessionPath)(sessionId, `permissions/${safeSessionId(askId)}`) : `/permission/${safeSessionId(askId)}/reply`, cwd), body, timeoutMs),
        questionReply: (cwd, askId, body, timeoutMs) => (0, net_1.httpRequestJson)("POST", at(`/question/${safeSessionId(askId)}/reply`, cwd), body, timeoutMs)
    };
};
const sets = { 1: v1, 2: undefined };
function api(base) {
    const major = serverMajor(base);
    const make = sets[major];
    if (make) {
        return make(base);
    }
    const refuse = () => Promise.reject(Object.assign(new Error(`OpenCode ${major}'s server API is not supported yet (${base})`), { code: "ENOTOPENCODE1" }));
    return Object.fromEntries(Object.keys(v1(base)).map((k) => [k, refuse]));
}
//# sourceMappingURL=oc-api.js.map