"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ago = void 0;
exports.handleSessions = handleSessions;
const vscode = __importStar(require("vscode"));
const core_1 = require("./core");
const followups_1 = require("./followups");
const net_1 = require("./net");
const sessions_1 = require("./sessions");
const session_1 = require("./session");
const ago = (ms, now = Date.now()) => {
    if (!ms) {
        return "";
    }
    const s = Math.max(0, Math.round((now - ms) / 1000));
    return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
exports.ago = ago;
const titleOf = (s) => (0, core_1.truncate)(s.title?.trim() || "(untitled)", 80);
const quote = (text, max) => (0, core_1.truncate)(text, max).replace(/^/gm, "> ");
async function handleSessions(p) {
    const done = (extra = {}) => ({ metadata: { kind: "sessions", ...extra } });
    let base;
    let sessions;
    try {
        base = await (0, net_1.ensureServer)(p.cwd);
        sessions = await (0, sessions_1.listSessions)(base, p.cwd);
    }
    catch (error) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] /sessions: ${error}`);
        p.response.markdown(`${(0, followups_1.mark)("fail")} Could not list sessions: OpenCode's server did not answer. \`/ping\` checks the connection.`);
        return done();
    }
    if (!sessions.length) {
        p.response.markdown(`No OpenCode sessions in \`${p.folderName}\` yet — send a message to start one.`);
        return done();
    }
    const running = await (0, sessions_1.busySessions)(base, p.cwd);
    const items = sessions.map((s) => ({
        label: titleOf(s),
        description: [(0, exports.ago)(s.time?.updated), running.has(s.id) ? "running" : "", s.id === p.state.id ? "this chat" : ""].filter(Boolean).join(" · "),
        detail: s.id,
        session: s
    }));
    const picked = await vscode.window.showQuickPick(items, { title: `OpenCode sessions · ${p.folderName}`, placeHolder: "Pick a session", matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true }, p.token);
    if (!picked) {
        p.response.markdown(`${sessions.length} session(s) in \`${p.folderName}\`; none picked.`);
        return done();
    }
    const s = picked.session;
    const mine = s.id === p.state.id;
    const actions = [
        { label: mine ? "$(debug-continue) Keep in this chat" : "$(debug-continue) Continue here", detail: "This chat's next message continues it.", action: "continue" },
        { label: "$(repo-forked) Fork into this chat", detail: "A copy to continue here; the original is untouched.", action: "fork" },
        { label: "$(archive) Close", detail: "Archive it: stops a run, hides it from this list, keeps its messages.", action: "close" },
        { label: "$(trash) Delete…", detail: "Permanently, with its messages.", action: "delete" }
    ];
    const act = await vscode.window.showQuickPick(actions, { title: `${titleOf(s)} · ${s.id}`, placeHolder: "What to do with it", ignoreFocusOut: true }, p.token);
    if (!act) {
        return done();
    }
    const bind = async (id) => {
        session_1.liveSessions.mark(p.cwd, id);
        if ((0, core_1.config)().get("sessionScope", "thread") === "workspace") {
            await (0, session_1.setActiveSession)(p.cwd, { id, turns: 0 });
        }
        (0, session_1.refreshStatus)(p.cwd);
        return done({ sessionId: id, turns: 0, cwd: p.cwd });
    };
    const unbind = async () => {
        if (!mine) {
            return done();
        }
        await (0, session_1.setActiveSession)(p.cwd, { turns: 0 });
        (0, session_1.refreshStatus)(p.cwd);
        return { metadata: { kind: "new", cwd: p.cwd } };
    };
    try {
        switch (act.action) {
            case "continue":
            case "fork": {
                const target = act.action === "fork" ? await (0, sessions_1.forkSession)(base, p.cwd, s.id) : s;
                const excerpt = await (0, sessions_1.sessionExcerpt)(base, p.cwd, target.id).catch(() => ({ ask: undefined, answer: undefined }));
                p.response.markdown((act.action === "fork"
                    ? `${(0, followups_1.mark)("ok")} Forked **${titleOf(s)}** into \`${target.id}\` — this chat continues the copy; \`${s.id}\` is untouched.`
                    : `${(0, followups_1.mark)("ok")} This chat continues **${titleOf(s)}** (\`${s.id}\`, ${(0, exports.ago)(s.time?.updated) || "no activity yet"}).`) +
                    (act.action === "continue" && running.has(s.id)
                        ? `\n\n${(0, followups_1.mark)("warn")} It is running now (another chat?). Your next message here follows \`busySessionPolicy\`: \`abort\` stops that run first.`
                        : "") +
                    (excerpt.ask ? `\n\nLast ask:\n\n${quote(excerpt.ask, 300)}` : "") +
                    (excerpt.answer ? `\n\nLast answer:\n\n${quote(excerpt.answer, 600)}` : ""));
                return await bind(target.id);
            }
            case "close":
                await (0, sessions_1.archiveSession)(base, p.cwd, s.id);
                session_1.liveSessions.drop(p.cwd, s.id);
                p.response.markdown(`${(0, followups_1.mark)("ok")} Closed **${titleOf(s)}** (\`${s.id}\`): archived, messages kept.` + (mine ? " This chat starts a fresh session with its next message." : ""));
                return await unbind();
            case "delete": {
                const sure = await vscode.window.showWarningMessage(`Delete "${titleOf(s)}" and all its messages? This cannot be undone.`, { modal: true }, "Delete");
                if (sure !== "Delete") {
                    p.response.markdown(`Kept **${titleOf(s)}**.`);
                    return done();
                }
                await (0, sessions_1.deleteSession)(base, p.cwd, s.id);
                session_1.liveSessions.drop(p.cwd, s.id);
                p.response.markdown(`${(0, followups_1.mark)("ok")} Deleted **${titleOf(s)}** (\`${s.id}\`).` + (mine ? " This chat starts a fresh session with its next message." : ""));
                return await unbind();
            }
        }
    }
    catch (error) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] /sessions ${act.action} ${s.id}: ${error}`);
        p.response.markdown(`${(0, followups_1.mark)("fail")} ${act.action} failed: \`${(0, core_1.truncate)(String(error instanceof Error ? error.message : error), 160)}\``);
    }
    return done();
}
//# sourceMappingURL=chat-sessions.js.map