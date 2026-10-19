// The server's routes, one set per OpenCode major. Callers speak the shapes the
// bridge was written against (1.x's: `{permission, pattern, action}` rules,
// `/session/:id/message` bodies, `{info, parts}` replies); a major whose API
// differs translates here, so no call site branches on the version. 2.x serves
// another API under `/api` (Basic auth, `location`, `{action, resource,
// effect}` rules; measured on 2.0.29 and 2.0.32, REFS), driven only when
// `opencode2` is on and only on the server this window started (net.ts).
import type * as vscode from "vscode";

import { delay, logChannel, stamp } from "./core";
import { toV1Rules, toV2Rules } from "./enforce";
import { connectSse, httpGetJson, httpPostJson, httpRequestJson, serverAuth, serverVersion, withDirectory } from "./net";

// A session id is untrusted (stdout, server, replayed metadata). In a URL path
// `..` walks to another endpoint; in argv a leading `-` is a flag. Every site
// uses sessionPath or safeSessionId (tripwire: MA); anything else is replaced.
const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export function safeSessionId(sessionId: string): string {
    if (SAFE_ID.test(sessionId)) {
        return sessionId;
    }
    const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[.-]+/, "_").slice(0, 128);
    const safe = cleaned || "session";
    logChannel?.appendLine(`[${stamp()}] unsafe session id ${JSON.stringify(sessionId)} → ${safe}`);
    return safe;
}

export const sessionPath = (sessionId: string, tail: string): string => `/session/${safeSessionId(sessionId)}/${tail}`;
/** The session itself: GET, PATCH or DELETE `/session/<id>`. */
export const sessionRoot = (sessionId: string): string => `/session/${safeSessionId(sessionId)}`;

export type Major = 1 | 2;

/** The major `base` named at `/global/health`; 1 until it named one. */
export function serverMajor(base: string): Major {
    return Number((serverVersion(base) ?? "").match(/^v?(\d+)\./)?.[1] ?? 1) >= 2 ? 2 : 1;
}

/** Every request the bridge makes of a server, `cwd`-scoped where OpenCode scopes it. */
export interface ServerApi {
    health(timeoutMs?: number): Promise<{ healthy?: boolean; version?: unknown }>;
    agents(cwd: string, timeoutMs: number): Promise<unknown>;
    providers(cwd: string, timeoutMs: number): Promise<unknown>;
    /** Lenient: whatever the list route answered (the `/ping` scope count). */
    sessionsRaw(cwd: string, timeoutMs: number): Promise<unknown>;
    /** Strict: a non-2xx rejects. */
    sessions(cwd: string, query: { roots: boolean; limit: number }, timeoutMs: number): Promise<unknown>;
    sessionStatus(cwd: string, timeoutMs: number): Promise<Record<string, { type?: string }>>;
    sessionGet(cwd: string, id: string, timeoutMs: number): Promise<{ permission?: unknown }>;
    sessionCreate(cwd: string, body: { title: string; permission: unknown }, timeoutMs?: number): Promise<{ id: string }>;
    sessionPatch(cwd: string, id: string, body: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
    sessionDelete(cwd: string, id: string, timeoutMs: number): Promise<unknown>;
    sessionFork(cwd: string, id: string, timeoutMs: number): Promise<{ id: string; title?: string; parentID?: string; time?: Record<string, number> }>;
    sessionChildren(cwd: string, id: string, timeoutMs: number): Promise<unknown>;
    sessionMessages(cwd: string, id: string, limit: number, timeoutMs: number): Promise<unknown>;
    sessionAbort(cwd: string, id: string, timeoutMs: number): Promise<unknown>;
    sessionPrompt<T>(cwd: string, id: string, body: unknown, timeoutMs: number | undefined, token?: vscode.CancellationToken): Promise<T>;
    /** The HTTP status: a summary's reply body is not read. */
    sessionSummarize(cwd: string, id: string, body: Record<string, unknown>, timeoutMs: number): Promise<number>;
    /** `legacy`: pre-1.1's `permission.updated`, answered at the session's own route. */
    permissionReply(cwd: string, sessionId: string, askId: string, legacy: boolean, body: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
    questionReply(cwd: string, askId: string, body: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
}

// 1.x (1.18.27–1.19.0): `?directory=` on every scoped call (withDirectory).
const v1 = (base: string): ServerApi => {
    const at = (path: string, cwd: string): string => withDirectory(`${base}${path}`, cwd);
    return {
        health: (timeoutMs) => httpGetJson(`${base}/global/health`, timeoutMs),
        agents: (cwd, timeoutMs) => httpGetJson(at("/agent", cwd), timeoutMs),
        providers: (cwd, timeoutMs) => httpGetJson(at("/config/providers", cwd), timeoutMs),
        sessionsRaw: (cwd, timeoutMs) => httpGetJson(at("/session", cwd), timeoutMs),
        sessions: (cwd, query, timeoutMs) => httpRequestJson("GET", at(`/session?roots=${query.roots}&limit=${query.limit}`, cwd), undefined, timeoutMs),
        sessionStatus: (cwd, timeoutMs) => httpGetJson(at("/session/status", cwd), timeoutMs),
        sessionGet: (cwd, id, timeoutMs) => httpGetJson(at(sessionRoot(id), cwd), timeoutMs),
        sessionCreate: (cwd, body, timeoutMs) => httpRequestJson("POST", at("/session", cwd), body, timeoutMs),
        sessionPatch: (cwd, id, body, timeoutMs) => httpRequestJson("PATCH", at(sessionRoot(id), cwd), body, timeoutMs),
        sessionDelete: (cwd, id, timeoutMs) => httpRequestJson("DELETE", at(sessionRoot(id), cwd), undefined, timeoutMs),
        sessionFork: (cwd, id, timeoutMs) => httpRequestJson("POST", at(sessionPath(id, "fork"), cwd), undefined, timeoutMs),
        sessionChildren: (cwd, id, timeoutMs) => httpGetJson(at(sessionPath(id, "children"), cwd), timeoutMs),
        sessionMessages: (cwd, id, limit, timeoutMs) => httpGetJson(at(`${sessionPath(id, "message")}?limit=${limit}`, cwd), timeoutMs),
        sessionAbort: (cwd, id, timeoutMs) => httpRequestJson("POST", at(sessionPath(id, "abort"), cwd), undefined, timeoutMs),
        sessionPrompt: (cwd, id, body, timeoutMs, token) => httpRequestJson("POST", at(sessionPath(id, "message"), cwd), body, timeoutMs, token),
        sessionSummarize: (cwd, id, body, timeoutMs) => httpPostJson(at(sessionPath(id, "summarize"), cwd), body, timeoutMs),
        permissionReply: (cwd, sessionId, askId, legacy, body, timeoutMs) =>
            httpRequestJson("POST", at(legacy ? sessionPath(sessionId, `permissions/${safeSessionId(askId)}`) : `/permission/${safeSessionId(askId)}/reply`, cwd), body, timeoutMs),
        questionReply: (cwd, askId, body, timeoutMs) => httpRequestJson("POST", at(`/question/${safeSessionId(askId)}/reply`, cwd), body, timeoutMs)
    };
};

// --- 2.x ---------------------------------------------------------------------
// claim:opencode-2-api — with `opencode2`, OpenCode 2 through these routes, on
// this window's own server only (net.ts), 1.x shapes in and out.

type Ev = Record<string, unknown>;
const propsOf = (ev: Ev): Record<string, unknown> => (ev.properties as Record<string, unknown> | undefined) ?? {};

// This session's events (1.x-shaped, ./v2-events) until `step` returns a value;
// bounded by `timeoutMs` and Stop, which reject as the 1.x request would.
function watch<T>(base: string, sessionId: string, timeoutMs: number | undefined, token: vscode.CancellationToken | undefined, step: (ev: Ev) => T | undefined) {
    let connected: () => void = () => undefined;
    const ready = new Promise<void>((r) => (connected = r));
    let sub: { close: () => void } | undefined;
    let timer: NodeJS.Timeout | undefined;
    let cancel: { dispose(): void } | undefined;
    const end = (): void => {
        if (timer) {
            clearTimeout(timer);
        }
        cancel?.dispose();
        sub?.close();
    };
    const result = new Promise<T>((resolve, reject) => {
        sub = connectSse(base, (ev) => {
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
    // Subscribed before the request that starts what it waits for; 2 s bounds a stream that never says so.
    return { ready: Promise.race([ready, delay(2000)]), result, abandon: end };
}

type V2Session = { id?: unknown; parentID?: unknown; time?: Record<string, number>; metadata?: Record<string, unknown>; permissions?: unknown };
const v1Session = (s: V2Session): { id: string; title?: string; parentID?: string; time?: Record<string, number> } => ({
    id: String(s.id),
    ...(typeof s.metadata?.title === "string" ? { title: s.metadata.title } : {}),
    ...(typeof s.parentID === "string" ? { parentID: s.parentID } : {}),
    // 2.x has no archive call: the bridge's Close marks metadata (2.0.29 PATCH takes metadata and permissions only).
    time: { ...s.time, ...(typeof s.metadata?.ocbArchived === "number" ? { archived: s.metadata.ocbArchived } : {}) }
});

// 2.x's messages (newest first, 2.0.29) as 1.x's (oldest first, `{info, parts}`).
const v1Messages = (list: unknown): unknown[] =>
    (Array.isArray(list) ? list : [])
        .filter((m) => m && (m.type === "user" || m.type === "assistant"))
        .reverse()
        .map((m) => m.type === "user"
            ? { info: { role: "user" }, parts: [{ type: "text", text: String(m.text ?? "") }] }
            : {
                info: { role: "assistant", providerID: m.model?.providerID, modelID: m.model?.id },
                parts: (Array.isArray(m.content) ? m.content : []).filter((c: { type?: unknown }) => c?.type === "text" || c?.type === "reasoning")
            });

const v2 = (base: string): ServerApi => {
    const auth = (): Record<string, string> => serverAuth(base) ?? {};
    const url = (path: string, query: Record<string, string | number | undefined> = {}): string => {
        const q = Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
        return `${base}/api${path}${q ? `?${q}` : ""}`;
    };
    // `location` is a deep-object query (`location[directory]=`; flat is a 400).
    const at = (path: string, cwd: string): string => url(path, { "location[directory]": cwd });
    const get = <T>(u: string, timeoutMs?: number): Promise<T> => httpRequestJson<T>("GET", u, undefined, timeoutMs, undefined, auth());
    const send = <T>(method: string, u: string, body: unknown, timeoutMs?: number): Promise<T> => httpRequestJson<T>(method, u, body, timeoutMs, undefined, auth());
    const data = <T>(r: unknown): T => (r as { data?: T } | undefined)?.data as T;
    const list = async (cwd: string, query: Record<string, string | number | undefined>, timeoutMs: number): Promise<ReturnType<typeof v1Session>[]> =>
        (data<V2Session[]>(await get(url("/session", { directory: cwd, ...query }), timeoutMs)) ?? []).map(v1Session);
    return {
        health: async (timeoutMs) => {
            const info = await httpGetJson<{ version?: unknown }>(url("/info"), timeoutMs, auth());
            return { healthy: typeof info?.version === "string", version: info?.version };
        },
        // A folder's agents load lazily: 400 ms after boot the list was `[]` (2.0.29).
        agents: async (cwd, timeoutMs) => {
            const until = Date.now() + timeoutMs;
            let found: Array<Record<string, unknown>> = [];
            while (!found.length && Date.now() < until) {
                found = data<Array<Record<string, unknown>>>(await get(at("/agent", cwd), timeoutMs)) ?? [];
                if (!found.length) {
                    await delay(150);
                }
            }
            return found.map((a) => ({ name: a.id, mode: a.mode, hidden: a.hidden === true, permission: toV1Rules(a.permissions) }));
        },
        providers: async (cwd, timeoutMs) => {
            const models = data<Array<Record<string, unknown>>>(await get(at("/model", cwd), timeoutMs)) ?? [];
            const providers = new Map<string, Record<string, unknown>>();
            for (const m of models) {
                if (typeof m.providerID !== "string" || typeof m.modelID !== "string" || m.enabled === false) {
                    continue;
                }
                const variants = Array.isArray(m.variants) ? Object.fromEntries(m.variants.filter((v) => typeof v?.id === "string").map((v) => [v.id, {}])) : undefined;
                const p = providers.get(m.providerID) ?? { id: m.providerID, name: m.providerID, models: {} };
                (p.models as Record<string, unknown>)[m.modelID] = { name: m.name, limit: m.limit, variants };
                providers.set(m.providerID, p);
            }
            return { providers: [...providers.values()] };
        },
        sessionsRaw: (cwd, timeoutMs) => list(cwd, {}, timeoutMs),
        sessions: async (cwd, query, timeoutMs) => (await list(cwd, { limit: query.limit }, timeoutMs)).filter((s) => !query.roots || !s.parentID),
        sessionStatus: async (cwd, timeoutMs) => {
            const active = data<Record<string, { type?: string }>>(await get(url("/session/active"), timeoutMs)) ?? {};
            return Object.fromEntries(Object.entries(active).map(([id, v]) => [id, { type: v?.type === "running" ? "busy" : v?.type }]));
        },
        sessionGet: async (cwd, id, timeoutMs) => ({ permission: toV1Rules(data<V2Session>(await get(url(`/session/${safeSessionId(id)}`), timeoutMs))?.permissions) }),
        sessionCreate: async (cwd, body, timeoutMs) => {
            const rules = Array.isArray(body.permission) ? toV2Rules(body.permission) : [];
            const created = data<V2Session>(await send("POST", url("/session"), { location: { directory: cwd }, permissions: rules, metadata: { title: body.title } }, timeoutMs));
            return { id: String(created?.id) };
        },
        sessionPatch: (cwd, id, body, timeoutMs) => {
            const archived = (body.time as { archived?: unknown } | undefined)?.archived;
            const patch = {
                ...(Array.isArray(body.permission) ? { permissions: toV2Rules(body.permission) } : {}),
                ...(typeof archived === "number" ? { metadata: { ocbArchived: archived } } : {})
            };
            return send("PATCH", url(`/session/${safeSessionId(id)}`), patch, timeoutMs);
        },
        sessionDelete: (cwd, id, timeoutMs) => send("DELETE", url(`/session/${safeSessionId(id)}`), undefined, timeoutMs),
        sessionFork: async (cwd, id, timeoutMs) => v1Session(data<V2Session>(await send("POST", url(`/session/${safeSessionId(id)}/fork`), {}, timeoutMs)) ?? {}),
        sessionChildren: async (cwd, id, timeoutMs) => (await list(cwd, { parentID: safeSessionId(id) }, timeoutMs)).map((s) => ({ id: s.id })),
        sessionMessages: async (cwd, id, limit, timeoutMs) => v1Messages(data(await get(url(`/session/${safeSessionId(id)}/message`, { limit }), timeoutMs))),
        sessionAbort: (cwd, id, timeoutMs) => send("POST", url(`/session/${safeSessionId(id)}/interrupt`), undefined, timeoutMs),
        // 2.x queues a prompt and answers at once; 1.x answers when the run ends,
        // which is what the runner awaits. So: agent and model first (2.x's
        // prompt takes neither), then the prompt, then this session's events
        // until its run ends — the reply built from what they said.
        sessionPrompt: async <T>(cwd: string, id: string, body: unknown, timeoutMs: number | undefined, token?: vscode.CancellationToken): Promise<T> => {
            const b = (body ?? {}) as { parts?: Array<{ text?: unknown }>; agent?: unknown; model?: { providerID?: unknown; modelID?: unknown }; variant?: unknown };
            if (typeof b.agent === "string") {
                await send("POST", url(`/session/${safeSessionId(id)}/agent`), { agent: b.agent }, 5000);
            }
            if (typeof b.model?.providerID === "string" && typeof b.model.modelID === "string") {
                await send("POST", url(`/session/${safeSessionId(id)}/model`), { model: { id: b.model.modelID, providerID: b.model.providerID, ...(typeof b.variant === "string" ? { variant: b.variant } : {}) } }, 5000);
            }
            const delivered = new Set<string>();
            let inbox: string | undefined;
            let model: { providerID?: unknown; modelID?: unknown } = {};
            let tokens: Record<string, unknown> | undefined;
            const costs = new Map<string, number>();
            const texts = new Map<string, string>();
            const w = watch(base, id, timeoutMs, token, (ev) => {
                const p = propsOf(ev);
                const info = (p.info ?? {}) as Record<string, unknown>;
                const part = (p.part ?? {}) as Record<string, unknown>;
                if (ev.type === "v2.delivered" && p.sessionID === id && typeof p.inboxID === "string") {
                    delivered.add(p.inboxID);
                } else if (ev.type === "message.updated" && info.sessionID === id) {
                    model = info.providerID ? info : model;
                    tokens = (info.tokens as Record<string, unknown> | undefined) ?? tokens;
                    if (typeof info.id === "string" && typeof info.cost === "number") {
                        costs.set(info.id, info.cost);
                    }
                } else if (ev.type === "message.part.updated" && part.sessionID === id && part.type === "text" && typeof part.id === "string" && part.text) {
                    texts.set(part.id, String(part.text));
                } else if (ev.type === "session.idle" && p.sessionID === id && inbox && delivered.has(inbox)) {
                    const t = tokens as { input?: number; output?: number; reasoning?: number } | undefined;
                    return {
                        info: {
                            sessionID: id,
                            providerID: model.providerID,
                            modelID: model.modelID,
                            ...(t ? { tokens: { ...t, total: (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) } } : {}),
                            cost: [...costs.values()].reduce((n, c) => n + c, 0)
                        },
                        parts: [...texts].map(([pid, text]) => ({ id: pid, type: "text", text }))
                    } as T;
                }
                return undefined;
            });
            await w.ready;
            try {
                const parts = Array.isArray(b.parts) ? b.parts : [];
                const queued = data<{ id?: unknown }>(await send("POST", url(`/session/${safeSessionId(id)}/prompt`), { text: parts.map((x) => String(x?.text ?? "")).join("\n") }, 15000));
                inbox = typeof queued?.id === "string" ? queued.id : undefined;
            } catch (error) {
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
            } catch (error) {
                w.abandon();
                throw error;
            }
            return w.result;
        },
        permissionReply: (cwd, sessionId, askId, _legacy, body, timeoutMs) =>
            send("POST", url(`/session/${safeSessionId(sessionId)}/permission/${safeSessionId(askId)}/reply`), {
                decision: body.reply === "once" || body.response === "once" ? "once" : "reject",
                ...(typeof body.message === "string" ? { message: body.message } : {})
            }, timeoutMs),
        // Sessions the bridge creates deny the question tool on both majors.
        questionReply: () => Promise.reject(new Error("OpenCode 2 questions are not answered by the bridge"))
    };
};

const sets: Record<Major, ((base: string) => ServerApi) | undefined> = { 1: v1, 2: v2 };

/** The routes of the server at `base`, by the major it named. Never throws:
 * a major without a set rejects every call (Stop paths `.catch` a promise). */
export function api(base: string): ServerApi {
    const major = serverMajor(base);
    const make = sets[major];
    if (make) {
        return make(base);
    }
    const refuse = (): Promise<never> =>
        Promise.reject(Object.assign(new Error(`OpenCode ${major}'s server API is not supported yet (${base})`), { code: "ENOTOPENCODE1" }));
    return Object.fromEntries(Object.keys(v1(base)).map((k) => [k, refuse])) as unknown as ServerApi;
}
