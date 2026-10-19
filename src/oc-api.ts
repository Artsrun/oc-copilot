// The server's routes, one set per OpenCode major. Callers speak the shapes the
// bridge was written against (1.x's: `{permission, pattern, action}` rules,
// `/session/:id/message` bodies, `{info, parts}` replies); a major whose API
// differs translates here, so no call site branches on the version. 2.x serves
// another API under `/api` (Basic auth, `location`, `{action, resource,
// effect}` rules, measured on 2.0.29 and 2.0.32, REFS): its set is not here yet,
// and a 2.x server is refused before any call reaches this module (net.ts).
import type * as vscode from "vscode";

import { logChannel, stamp } from "./core";
import { httpGetJson, httpPostJson, httpRequestJson, serverVersion, withDirectory } from "./net";

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
    return /^v?2\./.test(serverVersion(base) ?? "") ? 2 : 1;
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

const sets: Record<Major, ((base: string) => ServerApi) | undefined> = { 1: v1, 2: undefined };

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
