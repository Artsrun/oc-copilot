"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionRoot = exports.sessionPath = void 0;
exports.safeSessionId = safeSessionId;
exports.serverMajor = serverMajor;
exports.api = api;
const core_1 = require("./core");
const enforce_1 = require("./enforce");
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
const propsOf = (ev) => ev.properties ?? {};
function watch(base, sessionId, timeoutMs, token, step) {
    let connected = () => undefined;
    const ready = new Promise((r) => (connected = r));
    let sub;
    let timer;
    let cancel;
    const end = () => {
        if (timer) {
            clearTimeout(timer);
        }
        cancel?.dispose();
        sub?.close();
    };
    const result = new Promise((resolve, reject) => {
        sub = (0, net_1.connectSse)(base, (ev) => {
            const out = step(ev);
            if (out !== undefined) {
                end();
                resolve(out);
            }
        }, (status) => {
            if (status === "connected") {
                connected();
            }
        }, sessionId);
        if (timeoutMs && timeoutMs > 0) {
            timer = setTimeout(() => {
                end();
                reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT_BRIDGE" }));
            }, timeoutMs);
        }
        cancel = token?.onCancellationRequested(() => {
            end();
            reject(Object.assign(new Error("cancelled"), { code: "ECANCELLED_BRIDGE" }));
        });
    });
    return { ready: Promise.race([ready, (0, core_1.delay)(2000)]), result, abandon: end };
}
const v1Session = (s) => ({
    id: String(s.id),
    ...(typeof s.metadata?.title === "string" ? { title: s.metadata.title } : {}),
    ...(typeof s.parentID === "string" ? { parentID: s.parentID } : {}),
    time: { ...s.time, ...(typeof s.metadata?.ocbArchived === "number" ? { archived: s.metadata.ocbArchived } : {}) }
});
const v1Messages = (list) => (Array.isArray(list) ? list : [])
    .filter((m) => m && (m.type === "user" || m.type === "assistant"))
    .reverse()
    .map((m) => m.type === "user"
    ? { info: { role: "user" }, parts: [{ type: "text", text: String(m.text ?? "") }] }
    : {
        info: { role: "assistant", providerID: m.model?.providerID, modelID: m.model?.id },
        parts: (Array.isArray(m.content) ? m.content : []).filter((c) => c?.type === "text" || c?.type === "reasoning")
    });
const v2 = (base) => {
    const auth = () => (0, net_1.serverAuth)(base) ?? {};
    const url = (path, query = {}) => {
        const q = Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
        return `${base}/api${path}${q ? `?${q}` : ""}`;
    };
    const at = (path, cwd) => url(path, { "location[directory]": cwd });
    const get = (u, timeoutMs) => (0, net_1.httpRequestJson)("GET", u, undefined, timeoutMs, undefined, auth());
    const send = (method, u, body, timeoutMs) => (0, net_1.httpRequestJson)(method, u, body, timeoutMs, undefined, auth());
    const data = (r) => r?.data;
    const list = async (cwd, query, timeoutMs) => (data(await get(url("/session", { directory: cwd, ...query }), timeoutMs)) ?? []).map(v1Session);
    return {
        health: async (timeoutMs) => {
            const info = await (0, net_1.httpGetJson)(url("/info"), timeoutMs, auth());
            return { healthy: typeof info?.version === "string", version: info?.version };
        },
        agents: async (cwd, timeoutMs) => {
            const until = Date.now() + timeoutMs;
            let found = [];
            while (!found.length && Date.now() < until) {
                found = data(await get(at("/agent", cwd), timeoutMs)) ?? [];
                if (!found.length) {
                    await (0, core_1.delay)(150);
                }
            }
            return found.map((a) => ({ name: a.id, mode: a.mode, hidden: a.hidden === true, permission: (0, enforce_1.toV1Rules)(a.permissions) }));
        },
        providers: async (cwd, timeoutMs) => {
            const models = data(await get(at("/model", cwd), timeoutMs)) ?? [];
            const providers = new Map();
            for (const m of models) {
                if (typeof m.providerID !== "string" || typeof m.modelID !== "string" || m.enabled === false) {
                    continue;
                }
                const variants = Array.isArray(m.variants) ? Object.fromEntries(m.variants.filter((v) => typeof v?.id === "string").map((v) => [v.id, {}])) : undefined;
                const p = providers.get(m.providerID) ?? { id: m.providerID, name: m.providerID, models: {} };
                p.models[m.modelID] = { name: m.name, limit: m.limit, variants };
                providers.set(m.providerID, p);
            }
            return { providers: [...providers.values()] };
        },
        sessionsRaw: (cwd, timeoutMs) => list(cwd, {}, timeoutMs),
        sessions: async (cwd, query, timeoutMs) => (await list(cwd, { limit: query.limit }, timeoutMs)).filter((s) => !query.roots || !s.parentID),
        sessionStatus: async (cwd, timeoutMs) => {
            const active = data(await get(url("/session/active"), timeoutMs)) ?? {};
            return Object.fromEntries(Object.entries(active).map(([id, v]) => [id, { type: v?.type === "running" ? "busy" : v?.type }]));
        },
        sessionGet: async (cwd, id, timeoutMs) => ({ permission: (0, enforce_1.toV1Rules)(data(await get(url(`/session/${safeSessionId(id)}`), timeoutMs))?.permissions) }),
        sessionCreate: async (cwd, body, timeoutMs) => {
            const rules = Array.isArray(body.permission) ? (0, enforce_1.toV2Rules)(body.permission) : [];
            const created = data(await send("POST", url("/session"), { location: { directory: cwd }, permissions: rules, metadata: { title: body.title } }, timeoutMs));
            return { id: String(created?.id) };
        },
        sessionPatch: (cwd, id, body, timeoutMs) => {
            const archived = body.time?.archived;
            const patch = {
                ...(Array.isArray(body.permission) ? { permissions: (0, enforce_1.toV2Rules)(body.permission) } : {}),
                ...(typeof archived === "number" ? { metadata: { ocbArchived: archived } } : {})
            };
            return send("PATCH", url(`/session/${safeSessionId(id)}`), patch, timeoutMs);
        },
        sessionDelete: (cwd, id, timeoutMs) => send("DELETE", url(`/session/${safeSessionId(id)}`), undefined, timeoutMs),
        sessionFork: async (cwd, id, timeoutMs) => v1Session(data(await send("POST", url(`/session/${safeSessionId(id)}/fork`), {}, timeoutMs)) ?? {}),
        sessionChildren: async (cwd, id, timeoutMs) => (await list(cwd, { parentID: safeSessionId(id) }, timeoutMs)).map((s) => ({ id: s.id })),
        sessionMessages: async (cwd, id, limit, timeoutMs) => v1Messages(data(await get(url(`/session/${safeSessionId(id)}/message`, { limit }), timeoutMs))),
        sessionAbort: (cwd, id, timeoutMs) => send("POST", url(`/session/${safeSessionId(id)}/interrupt`), undefined, timeoutMs),
        sessionPrompt: async (cwd, id, body, timeoutMs, token) => {
            const b = (body ?? {});
            if (typeof b.agent === "string") {
                await send("POST", url(`/session/${safeSessionId(id)}/agent`), { agent: b.agent }, 5000);
            }
            if (typeof b.model?.providerID === "string" && typeof b.model.modelID === "string") {
                await send("POST", url(`/session/${safeSessionId(id)}/model`), { model: { id: b.model.modelID, providerID: b.model.providerID, ...(typeof b.variant === "string" ? { variant: b.variant } : {}) } }, 5000);
            }
            const delivered = new Set();
            let inbox;
            let model = {};
            let tokens;
            const costs = new Map();
            const texts = new Map();
            const w = watch(base, id, timeoutMs, token, (ev) => {
                const p = propsOf(ev);
                const info = (p.info ?? {});
                const part = (p.part ?? {});
                if (ev.type === "v2.delivered" && p.sessionID === id && typeof p.inboxID === "string") {
                    delivered.add(p.inboxID);
                }
                else if (ev.type === "message.updated" && info.sessionID === id) {
                    model = info.providerID ? info : model;
                    tokens = info.tokens ?? tokens;
                    if (typeof info.id === "string" && typeof info.cost === "number") {
                        costs.set(info.id, info.cost);
                    }
                }
                else if (ev.type === "message.part.updated" && part.sessionID === id && part.type === "text" && typeof part.id === "string" && part.text) {
                    texts.set(part.id, String(part.text));
                }
                else if (ev.type === "session.idle" && p.sessionID === id && inbox && delivered.has(inbox)) {
                    const t = tokens;
                    return {
                        info: {
                            sessionID: id,
                            providerID: model.providerID,
                            modelID: model.modelID,
                            ...(t ? { tokens: { ...t, total: (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) } } : {}),
                            cost: [...costs.values()].reduce((n, c) => n + c, 0)
                        },
                        parts: [...texts].map(([pid, text]) => ({ id: pid, type: "text", text }))
                    };
                }
                return undefined;
            });
            await w.ready;
            try {
                const parts = Array.isArray(b.parts) ? b.parts : [];
                const queued = data(await send("POST", url(`/session/${safeSessionId(id)}/prompt`), { text: parts.map((x) => String(x?.text ?? "")).join("\n") }, 15000));
                inbox = typeof queued?.id === "string" ? queued.id : undefined;
            }
            catch (error) {
                w.abandon();
                throw error;
            }
            return w.result;
        },
        sessionSummarize: async (cwd, id, _body, timeoutMs) => {
            const w = watch(base, id, timeoutMs, undefined, (ev) => (ev.type === "v2.compaction" && propsOf(ev).sessionID === id ? (propsOf(ev).ok === true ? 200 : 500) : undefined));
            await w.ready;
            try {
                await send("POST", url(`/session/${safeSessionId(id)}/compact`), {}, 15000);
            }
            catch (error) {
                w.abandon();
                throw error;
            }
            return w.result;
        },
        permissionReply: (cwd, sessionId, askId, _legacy, body, timeoutMs) => send("POST", url(`/session/${safeSessionId(sessionId)}/permission/${safeSessionId(askId)}/reply`), {
            decision: body.reply === "once" || body.response === "once" ? "once" : "reject",
            ...(typeof body.message === "string" ? { message: body.message } : {})
        }, timeoutMs),
        questionReply: () => Promise.reject(new Error("OpenCode 2 questions are not answered by the bridge"))
    };
};
const sets = { 1: v1, 2: v2 };
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