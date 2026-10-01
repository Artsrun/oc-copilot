// OpenCode's own session store, as the server exposes it (1.18.33,
// server/routes/instance/httpapi/groups/session.ts): list (most recently
// updated first, archived excluded), messages, fork, archive, delete. Every
// call is scoped with ?directory= and bounded.
import { httpGetJson, httpRequestJson, withDirectory } from "./net";
import { HEADLESS_PERMISSION, abortServerRun, sessionBusy, sessionPath, sessionRoot } from "./runs";

export interface ServerSession {
    id: string;
    title?: string;
    parentID?: string;
    time?: { created?: number; updated?: number; archived?: number };
}

export interface SessionExcerpt {
    ask?: string;
    answer?: string;
}

const TIMEOUT_MS = 5000;

/** Ids with a run going now (`GET /session/status`); empty when it cannot tell. */
export const busySessions = async (base: string, cwd: string): Promise<Set<string>> => {
    try {
        const all = await httpGetJson<Record<string, { type?: string }>>(withDirectory(`${base}/session/status`, cwd), 3000);
        return new Set(Object.entries(all ?? {}).filter(([, v]) => v?.type && v.type !== "idle").map(([k]) => k));
    } catch {
        return new Set();
    }
};

/** This folder's top-level sessions (no subagent children), newest first. */
export const listSessions = async (base: string, cwd: string, limit = 50): Promise<ServerSession[]> => {
    // httpRequestJson rejects a non-2xx: an error body is not "no sessions".
    const all = await httpRequestJson<ServerSession[]>("GET", withDirectory(`${base}/session?roots=true&limit=${limit}`, cwd), undefined, TIMEOUT_MS);
    return (Array.isArray(all) ? all : []).filter((s) => s && typeof s.id === "string" && !s.time?.archived);
};

type WithParts = { info?: { role?: string }; parts?: Array<{ type?: string; text?: string; synthetic?: boolean }> };
const textOf = (m: WithParts): string =>
    (m.parts ?? []).filter((p) => p.type === "text" && !p.synthetic && p.text).map((p) => p.text).join("\n").trim();

/** The last ask and the last answer of a session, for "what was this?". */
export const sessionExcerpt = async (base: string, cwd: string, id: string): Promise<SessionExcerpt> => {
    const msgs = await httpGetJson<WithParts[]>(withDirectory(`${base}${sessionPath(id, "message")}?limit=20`, cwd), TIMEOUT_MS);
    const list = Array.isArray(msgs) ? msgs : [];
    const last = (role: string): string | undefined =>
        [...list].reverse().map((m) => (m.info?.role === role ? textOf(m) : "")).find(Boolean);
    return { ask: last("user"), answer: last("assistant") };
};

/**
 * A copy of the whole session. OpenCode's fork copies the messages and the
 * metadata, not the permission rules, so the bridge's headless rules are put
 * back on the copy (no question tool, no plan switches).
 */
export const forkSession = async (base: string, cwd: string, id: string): Promise<ServerSession> => {
    const fork = await httpRequestJson<ServerSession>("POST", withDirectory(`${base}${sessionPath(id, "fork")}`, cwd), undefined, TIMEOUT_MS);
    try {
        await httpRequestJson("PATCH", withDirectory(`${base}${sessionRoot(fork.id)}`, cwd), { permission: HEADLESS_PERMISSION }, TIMEOUT_MS);
    } catch (error) {
        // A copy without the headless rules would offer the question tool to a
        // chat that cannot answer it: it must not outlive a failed fork.
        await httpRequestJson("DELETE", withDirectory(`${base}${sessionRoot(fork.id)}`, cwd), undefined, TIMEOUT_MS).catch(() => undefined);
        throw error;
    }
    return fork;
};

/** Stop a run the session may still have going. */
const stopRun = async (base: string, cwd: string, id: string, why: string): Promise<void> => {
    if (await sessionBusy(base, id, cwd)) {
        await abortServerRun(base, id, cwd, why);
    }
};

/** OpenCode's archive: hidden from the list, messages kept. */
export const archiveSession = async (base: string, cwd: string, id: string): Promise<void> => {
    await stopRun(base, cwd, id, "closed from /sessions");
    await httpRequestJson("PATCH", withDirectory(`${base}${sessionRoot(id)}`, cwd), { time: { archived: Date.now() } }, TIMEOUT_MS);
};

/** Gone for good, with its messages. */
export const deleteSession = async (base: string, cwd: string, id: string): Promise<void> => {
    await stopRun(base, cwd, id, "deleted from /sessions");
    await httpRequestJson("DELETE", withDirectory(`${base}${sessionRoot(id)}`, cwd), undefined, TIMEOUT_MS);
};
