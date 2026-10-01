// `/sessions` (claim:sessions): this folder's OpenCode sessions, picked in a quick pick, then
// Continue here · Fork into this chat · Close (archive) · Delete. A chat thread
// is bound to a session by the metadata of its turns (threadSession), so
// Continue and Fork return that metadata; Close and Delete of this chat's own
// session return a `/new` barrier.
import * as vscode from "vscode";
import { config, logChannel, mdText, stamp, truncate } from "./core";
import { mark } from "./followups";
import { ensureServer } from "./net";
import { ServerSession, archiveSession, busySessions, deleteSession, forkSession, listSessions, sessionExcerpt } from "./sessions";
import { SessionState, getActiveSession, liveSessions, refreshStatus, setActiveSession } from "./session";

export interface SessionsProps {
    cwd: string;
    folderName: string;
    state: SessionState;
    response: vscode.ChatResponseStream;
    token?: vscode.CancellationToken;
}

type Action = "continue" | "fork" | "close" | "delete";

export const ago = (ms?: number, now = Date.now()): string => {
    if (!ms) {
        return "";
    }
    const s = Math.max(0, Math.round((now - ms) / 1000));
    return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

const titleOf = (s: ServerSession): string => truncate(s.title?.trim() || "(untitled)", 80);
// Titles come from user prompts: plain text inside the bold.
const titleMd = (s: ServerSession): string => mdText(titleOf(s));
// An excerpt stays markdown, but a cut inside a code fence would swallow
// everything after it: close an unbalanced fence.
const quote = (text: string, max: number): string => {
    const cut = truncate(text, max);
    let open: string | undefined;
    for (const line of cut.split("\n")) {
        const fence = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
        if (fence) {
            open = open ? undefined : fence;
        }
    }
    return (open ? `${cut}\n${open}` : cut).replace(/^/gm, "> ");
};

export async function handleSessions(p: SessionsProps): Promise<vscode.ChatResult> {
    const done = (extra: Record<string, unknown> = {}): vscode.ChatResult => ({ metadata: { kind: "sessions", ...extra } });
    let base: string;
    let sessions: ServerSession[];
    try {
        base = await ensureServer(p.cwd);
        sessions = await listSessions(base, p.cwd);
    } catch (error) {
        logChannel.appendLine(`[${stamp()}] /sessions: ${error}`);
        p.response.markdown(`${mark("fail")} Could not list sessions: \`${truncate(String(error instanceof Error ? error.message : error), 120).replace(/`/g, "'")}\`. \`/ping\` checks the connection.`);
        return done();
    }
    if (!sessions.length) {
        p.response.markdown(`No OpenCode sessions in \`${p.folderName}\` yet — send a message to start one.`);
        return done();
    }
    const running = await busySessions(base, p.cwd);
    type Item = vscode.QuickPickItem & { session: ServerSession };
    const items: Item[] = sessions.map((s) => ({
        label: titleOf(s),
        description: [ago(s.time?.updated), running.has(s.id) ? "running" : "", s.id === p.state.id ? "this chat" : ""].filter(Boolean).join(" · "),
        detail: s.id,
        session: s
    }));
    const picked = await vscode.window.showQuickPick(
        items,
        { title: `OpenCode sessions · ${p.folderName}`, placeHolder: "Pick a session", matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true },
        p.token
    );
    if (!picked) {
        p.response.markdown(`${sessions.length} session(s) in \`${p.folderName}\`; none picked.`);
        return done();
    }
    const s = picked.session;
    const mine = s.id === p.state.id;
    const actions: Array<vscode.QuickPickItem & { action: Action }> = [
        { label: mine ? "$(debug-continue) Keep in this chat" : "$(debug-continue) Continue here", detail: "This chat's next message continues it.", action: "continue" },
        { label: "$(repo-forked) Fork into this chat", detail: "A copy to continue here; the original is untouched.", action: "fork" },
        { label: "$(archive) Close", detail: "Archive it: stops a run, hides it from this list, keeps its messages.", action: "close" },
        { label: "$(trash) Delete…", detail: "Permanently, with its messages.", action: "delete" }
    ];
    const act = await vscode.window.showQuickPick(
        actions,
        { title: `${titleOf(s)} · ${s.id}`, placeHolder: "What to do with it", ignoreFocusOut: true },
        p.token
    );
    if (!act) {
        return done();
    }
    // Binding a thread = returning the metadata threadSession() reads.
    // This chat's own session is already bound with its counters: re-binding
    // with `turns: 0` would zero its turns and spend (see threadSession).
    const bind = async (id: string): Promise<vscode.ChatResult> => {
        liveSessions.mark(p.cwd, id);
        if (id === p.state.id) {
            refreshStatus(p.cwd);
            return done();
        }
        if (config().get<string>("sessionScope", "thread") === "workspace") {
            await setActiveSession(p.cwd, { id, turns: 0 });
        }
        refreshStatus(p.cwd);
        return done({ sessionId: id, turns: 0, cwd: p.cwd });
    };
    // The folder pointer is cleared only when it holds the session that is
    // gone, whichever chat owns it; this chat starts fresh only if it was its own.
    const unbind = async (): Promise<vscode.ChatResult> => {
        if (getActiveSession(p.cwd).id === s.id) {
            await setActiveSession(p.cwd, { turns: 0 });
        }
        refreshStatus(p.cwd);
        return mine ? { metadata: { kind: "new", cwd: p.cwd } } : done();
    };
    try {
        switch (act.action) {
            case "continue":
            case "fork": {
                const target = act.action === "fork" ? await forkSession(base, p.cwd, s.id) : s;
                const excerpt = await sessionExcerpt(base, p.cwd, target.id).catch(() => ({ ask: undefined, answer: undefined }));
                p.response.markdown(
                    (act.action === "fork"
                        ? `${mark("ok")} Forked **${titleMd(s)}** into \`${target.id}\` — this chat continues the copy; \`${s.id}\` is untouched.`
                        : `${mark("ok")} This chat continues **${titleMd(s)}** (\`${s.id}\`, ${ago(s.time?.updated) || "no activity yet"}).`) +
                    (act.action === "continue" && running.has(s.id)
                        ? `\n\n${mark("warn")} It is running now (another chat?). Your next message here follows \`busySessionPolicy\`: \`abort\` stops that run first.`
                        : "") +
                    (excerpt.ask ? `\n\nLast ask:\n\n${quote(excerpt.ask, 300)}` : "") +
                    (excerpt.answer ? `\n\nLast answer:\n\n${quote(excerpt.answer, 600)}` : "")
                );
                return await bind(target.id);
            }
            case "close":
                await archiveSession(base, p.cwd, s.id);
                liveSessions.drop(p.cwd, s.id);
                p.response.markdown(`${mark("ok")} Closed **${titleMd(s)}** (\`${s.id}\`): archived, messages kept.` + (mine ? " This chat starts a fresh session with its next message." : ""));
                return await unbind();
            case "delete": {
                const sure = await vscode.window.showWarningMessage(
                    `Delete "${titleOf(s)}" and all its messages? This cannot be undone.`,
                    { modal: true },
                    "Delete"
                );
                if (sure !== "Delete") {
                    p.response.markdown(`Kept **${titleMd(s)}**.`);
                    return done();
                }
                await deleteSession(base, p.cwd, s.id);
                liveSessions.drop(p.cwd, s.id);
                p.response.markdown(`${mark("ok")} Deleted **${titleMd(s)}** (\`${s.id}\`).` + (mine ? " This chat starts a fresh session with its next message." : ""));
                return await unbind();
            }
        }
    } catch (error) {
        logChannel.appendLine(`[${stamp()}] /sessions ${act.action} ${s.id}: ${error}`);
        p.response.markdown(`${mark("fail")} ${act.action} failed: \`${truncate(String(error instanceof Error ? error.message : error), 160)}\``);
    }
    return done();
}
