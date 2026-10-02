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
exports.liveSessions = exports.LiveSessionTracker = exports.OWN_PARTICIPANTS = exports.INLINE_PARTICIPANT_ID = exports.PARTICIPANT_ID = void 0;
exports.getActiveSession = getActiveSession;
exports.setActiveSession = setActiveSession;
exports.threadSession = threadSession;
exports.resolveSessionState = resolveSessionState;
exports.threadScopeActive = threadScopeActive;
exports.refreshStatus = refreshStatus;
exports.handoffChain = handoffChain;
exports.rememberHandoffReturn = rememberHandoffReturn;
exports.takeHandoffReturn = takeHandoffReturn;
exports.notifyIfSlow = notifyIfSlow;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("node:path"));
const core_1 = require("./core");
exports.PARTICIPANT_ID = "opencodeCopilotBridge.chat";
exports.INLINE_PARTICIPANT_ID = "opencodeCopilotBridge.inline";
exports.OWN_PARTICIPANTS = new Set([exports.PARTICIPANT_ID, exports.INLINE_PARTICIPANT_ID]);
function sessionStateKey(cwd) {
    return `opencode.session:${cwd}`;
}
function getActiveSession(cwd) {
    return core_1.extensionContext.workspaceState.get(sessionStateKey(cwd)) ?? { turns: 0 };
}
function setActiveSession(cwd, value) {
    return core_1.extensionContext.workspaceState.update(sessionStateKey(cwd), value);
}
class LiveSessionTracker {
    cap;
    now;
    entries = new Map();
    constructor(cap = 200, now = () => Date.now()) {
        this.cap = cap;
        this.now = now;
    }
    key(cwd, sessionId) {
        return `${cwd}\0${sessionId}`;
    }
    mark(cwd, sessionId) {
        const k = this.key(cwd, sessionId);
        this.entries.delete(k);
        this.entries.set(k, { lastSeenMs: this.now() });
        this.enforceCap();
    }
    drop(cwd, sessionId) {
        this.entries.delete(this.key(cwd, sessionId));
    }
    isLive(cwd, sessionId, graceMs) {
        const e = this.entries.get(this.key(cwd, sessionId));
        return !!e && this.now() - e.lastSeenMs <= graceMs;
    }
    get size() {
        return this.entries.size;
    }
    enforceCap() {
        while (this.entries.size > this.cap) {
            const oldest = this.entries.keys().next();
            if (oldest.done) {
                break;
            }
            this.entries.delete(oldest.value);
        }
    }
}
exports.LiveSessionTracker = LiveSessionTracker;
exports.liveSessions = new LiveSessionTracker();
function threadSession(history, cwd) {
    for (let i = history.length - 1; i >= 0; i--) {
        const turn = history[i];
        if (!turn || !exports.OWN_PARTICIPANTS.has(turn.participant ?? "") || !turn.result) {
            continue;
        }
        const meta = turn.result.metadata ?? {};
        if (meta.cwd && meta.cwd !== cwd) {
            continue;
        }
        if (meta.kind === "new") {
            return undefined;
        }
        if (!meta.sessionId || typeof meta.turns !== "number") {
            continue;
        }
        return {
            id: meta.sessionId,
            turns: meta.turns ?? 0,
            toolOutputBytes: meta.toolOutputBytes,
            tokensIn: meta.tokensIn,
            tokensOut: meta.tokensOut,
            cost: meta.cost,
            lastAgent: meta.agent,
            lastModel: meta.model
        };
    }
    return undefined;
}
function resolveSessionState(context, cwd) {
    if (!threadScopeActive(context)) {
        return getActiveSession(cwd);
    }
    const history = context.history;
    return threadSession(history, cwd) ?? { turns: 0 };
}
function threadScopeActive(context) {
    const history = context?.history;
    return (0, core_1.config)().get("sessionScope", "thread") !== "workspace" && Array.isArray(history);
}
function refreshStatus(cwd) {
    const folder = cwd ?? (0, core_1.resolveFolder)()?.folder.uri.fsPath;
    if (!folder) {
        return;
    }
    const state = getActiveSession(folder);
    const parts = ["$(code) OpenCode"];
    if ((0, core_1.isMultiRoot)()) {
        parts.push(path.basename(folder));
    }
    if (state.id) {
        parts.push(`${state.turns} turn${state.turns === 1 ? "" : "s"}`);
    }
    const head = state.id
        ? `Session \`${state.id}\` · ${state.turns} turn(s)`
        : "No active OpenCode session yet";
    (0, core_1.setStatus)(parts.join(" · "), `${head}\nClick for OpenCode actions`, false);
}
function handoffChain(model, fallbacks) {
    const max = Math.max(1, (0, core_1.config)().get("maxHandoffAttempts", 3));
    const chain = [];
    const seen = new Set();
    for (const candidate of [model, ...fallbacks]) {
        const key = candidate ?? "<default>";
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        chain.push(candidate);
        if (chain.length >= max) {
            break;
        }
    }
    return chain;
}
const handoffReturns = new Map();
const HANDOFF_RETURNS_CAP = 200;
function rememberHandoffReturn(sessionId, model, agent) {
    handoffReturns.delete(sessionId);
    handoffReturns.set(sessionId, { model, agent });
    while (handoffReturns.size > HANDOFF_RETURNS_CAP) {
        const oldest = handoffReturns.keys().next();
        if (oldest.done) {
            break;
        }
        handoffReturns.delete(oldest.value);
    }
}
function takeHandoffReturn(sessionId, agent, pinned) {
    const back = sessionId ? handoffReturns.get(sessionId) : undefined;
    if (!back || !sessionId) {
        return undefined;
    }
    if (pinned) {
        handoffReturns.delete(sessionId);
        return undefined;
    }
    if (back.agent !== agent) {
        return undefined;
    }
    handoffReturns.delete(sessionId);
    return back.model;
}
function notifyIfSlow(metrics, agentLabel, cwd) {
    const settings = (0, core_1.config)();
    if (!settings.get("notifyOnCompletion", true)) {
        return;
    }
    if (metrics.cancelled) {
        return;
    }
    const where = (0, core_1.isMultiRoot)() ? ` in ${path.basename(cwd)}` : "";
    if (metrics.timedOut || metrics.error) {
        const text = metrics.timedOut
            ? `OpenCode ${agentLabel}${where} timed out after ${(0, core_1.secs)(metrics.totalMs)} — output may be partial.`
            : `OpenCode ${agentLabel}${where} reported an error after ${(0, core_1.secs)(metrics.totalMs)}${metrics.error ? `: ${(0, core_1.truncate)(String(metrics.error), 120)}` : ""}`;
        const actions = vscode.window.state?.focused === false ? ["Open Chat"] : [];
        try {
            void vscode.window.showErrorMessage(text, ...actions)
                ?.then?.((pick) => {
                if (pick === "Open Chat") {
                    void vscode.commands.executeCommand("workbench.action.chat.open");
                }
            });
        }
        catch {
        }
        return;
    }
    const minMs = Math.max(0, settings.get("notifyAfterMs", 30000));
    if (minMs === 0 || metrics.totalMs < minMs) {
        return;
    }
    if (vscode.window.state?.focused !== false) {
        return;
    }
    try {
        void vscode.window.showInformationMessage(`OpenCode ${agentLabel}${where} finished in ${(0, core_1.secs)(metrics.totalMs)}.`, "Open Chat")?.then?.((pick) => {
            if (pick === "Open Chat") {
                void vscode.commands.executeCommand("workbench.action.chat.open");
            }
        });
    }
    catch {
    }
}
//# sourceMappingURL=session.js.map