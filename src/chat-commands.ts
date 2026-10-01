import * as vscode from "vscode";
import { config, formatBytes, truncate } from "./core";
import { mark } from "./followups";
import { resolveExecutable } from "./proc";
import { ensureServer, httpGetJson, withDirectory } from "./net";
import { abortServerRun, sessionBusy } from "./runs";
import { discoverOpenCodeEnv, openCodeConfigModel, summariseEnv } from "./env";
import { planTimeout } from "./prompt";
import { uniqueModels } from "./context";
import { cachedModelInfo, getModelCatalog, modelLabel, pinLevel } from "./models";
import {
    SessionState,
    getActiveSession,
    threadFlows,
    liveSessions,
    refreshStatus,
    setActiveSession,
    threadScopeActive
} from "./session";
import { runCapture } from "./commands";
import { helpMarkdown } from "./chat-boot";
import { handleSessions } from "./chat-sessions";
import { flowById, flowSummary, toMermaid } from "./flow";

/** Plain text in markdown: `my_file.ts` is not italic, a backtick opens nothing. */
const mdText = (s: string): string => s.replace(/[\\`*_{}[\]<>#|~]/g, "\\$&");

// The "/help", "/new", "/model", "/ping", "/env", and "/session" control
// commands. Each answers from local state and never touches the model, so they
// are cheap, self-contained, and share no state with the running of a turn.
// Returns a ChatResult when `control` names one of them, otherwise undefined so
// the caller continues on to the real task.
export interface ControlProps {
    control: string;
    /** What follows the command: `/flow 3` → "3". */
    args: string;
    token?: vscode.CancellationToken;
    context: vscode.ChatContext;
    cwd: string;
    folder: vscode.WorkspaceFolder;
    state: SessionState;
    response: vscode.ChatResponseStream;
}

export async function handleControlCommand(p: ControlProps): Promise<vscode.ChatResult | undefined> {
    switch (p.control) {
        case "help":
            p.response.markdown(helpMarkdown());
            return { metadata: { kind: "help" } };
        case "stop": {
            // Closing a chat or reloading does not stop a server run.
            if (!p.state.id) {
                p.response.markdown("Nothing to stop — this chat has no OpenCode session yet.");
                return { metadata: { kind: "stop" } };
            }
            let base: string | undefined;
            try {
                base = await ensureServer(p.cwd);
            } catch {
                base = undefined;
            }
            if (!base) {
                p.response.markdown("The OpenCode server is not reachable, so there is no server-side run to stop.");
                return { metadata: { kind: "stop" } };
            }
            const busy = await sessionBusy(base, p.state.id, p.cwd);
            if (!busy) {
                p.response.markdown(`${mark("ok")} \`${p.state.id}\` is idle — nothing was running.`);
                return { metadata: { kind: "stop" } };
            }
            const stopped = await abortServerRun(base, p.state.id, p.cwd, "/stop");
            p.response.markdown(
                stopped
                    ? `${mark("stop")} Stopped the run in \`${p.state.id}\`. The session is kept; your next message continues it.`
                    : `${mark("warn")} Asked \`${p.state.id}\` to stop, but it still reports busy. \`/new\` starts a clean session.`
            );
            return { metadata: { kind: "stop" } };
        }
        case "new":
            // An explicit walk-away: the previous session is no longer live.
            if (p.state.id) {
                liveSessions.drop(p.cwd, p.state.id);
            }
            await setActiveSession(p.cwd, { turns: 0 });
            refreshStatus(p.cwd);
            // `/new` resets our session, not the Copilot thread on screen: one
            // line, and a button for a clean chat.
            p.response.markdown(
                (p.state.id ? `${mark("ok")} Started a fresh OpenCode session — \`${p.state.id}\` is closed. ` : mark("ok") + " Started a fresh OpenCode session. ") +
                "Your next message starts from zero context."
            );
            p.response.button({
                command: "opencodeCopilotBridge.newChat",
                title: "Open a new chat"
            });
            // `cwd` makes this a barrier only for the folder it was typed in, and
            // threadSession() stops walking here — so /new is scoped to this chat.
            return { metadata: { kind: "new", cwd: p.cwd } };
        case "model": {
            const settings = config();
            const chain = uniqueModels(
                [settings.get<string>("model", ""), ...(settings.get<string[]>("fallbackModels", []) ?? [])],
                4
            );
            // Unpinned, a session keeps the model it last ran on (REFS "Which model answers").
            const set = chain.length ? undefined : openCodeConfigModel(p.cwd);
            // Names from the last catalog (nothing fetched), where the pin lives, if listed.
            const info = cachedModelInfo();
            const listed = Object.keys(info);
            const pin = settings.get<string>("model", "").trim();
            const level = pinLevel(settings);
            const row = (m: string, i: number): string =>
                `${i + 1}. ${modelLabel(m, info)}` +
                (m === pin && level ? ` · ${level} settings, chat only` : "") +
                (listed.length && !info[m] ? " · (not listed)" : "");
            const lines = [
                chain.length
                    ? `Model chain (first wins, rest are timeout fallbacks):\n\n${chain.map(row).join("\n")}`
                    : "No model pinned — OpenCode picks: " +
                    (set ? `a new session starts on ${modelLabel(set.model, info)} (${set.from})` : "a new session starts on OpenCode's default") +
                    ", and a session keeps the model it last ran on."
            ];
            if (p.state.lastModel) {
                lines.push(`This chat's session last ran on ${modelLabel(p.state.lastModel, info)}.`);
            }
            p.response.markdown(lines.join("\n\n"));
            p.response.button({ command: "opencodeCopilotBridge.setModel", title: "Change default model" });
            return { metadata: { kind: "model" } };
        }
        case "ping": {
            // Deliberately does NOT call a model: the point is to separate "the
            // bridge cannot reach OpenCode" from "the model returned nothing", which
            // is exactly the ambiguity that made an empty reply so hard to read.
            const settings = config();
            const exe = settings.get<string>("executable", "opencode");
            const rows: string[] = ["| Check | Result |", "| --- | --- |"];
            let healthy = true;

            let resolvedTarget = "";
            try {
                const r = resolveExecutable(exe);
                resolvedTarget = r.target;
                rows.push(`| executable | ${mark("ok")} \`${r.target}\`${r.viaCmd ? " _(via cmd.exe)_" : ""} |`);
            } catch {
                healthy = false;
                rows.push(`| executable | ${mark("fail")} \`${exe}\` not found on PATH |`);
            }
            if (resolvedTarget) {
                const version = (await runCapture(exe, ["--version"], p.cwd, 6000)).trim();
                const ok = version && !/^error|timed out/i.test(version);
                healthy = healthy && Boolean(ok);
                rows.push(`| version | ${ok ? mark("ok") : mark("fail")} \`${truncate(version || "no output", 60)}\` |`);
            }
            const host = settings.get<string>("serverHostname", "127.0.0.1");
            const port = settings.get<number>("serverPort", 4096);
            try {
                await httpGetJson<{ healthy?: boolean }>(
                    `http://${host}:${port}/global/health`,
                    2000
                );
                // One server serves many workspaces. The count for THIS directory
                // is live proof that `?directory=` scoping reaches the server.
                let scope = "";
                try {
                    const mine = await httpGetJson<unknown[]>(
                        withDirectory(`http://${host}:${port}/session`, p.cwd),
                        2500
                    );
                    scope = ` · ${Array.isArray(mine) ? mine.length : 0} session(s) scoped to \`${p.folder.name}\``;
                } catch {
                    // The list endpoint is advisory here; health already passed.
                }
                rows.push(`| server | ${mark("ok")} healthy on ${host}:${port}${scope} |`);
            } catch {
                rows.push(`| server | not running on ${host}:${port} _(started on demand)_ |`);
            }
            const catalog = await getModelCatalog(exe, p.cwd);
            rows.push(
                `| models | ${catalog.models.length ? mark("ok") : mark("warn")} ${catalog.models.length} via the **${catalog.source
                }** tier |`
            );
            rows.push(`| workspace | \`${p.folder.name}\` |`);
            const env = discoverOpenCodeEnv(p.cwd);
            const counts = ["plugin", "hooks", "mcp", "command", "skill"]
                .map((k) => `${env.filter((i) => i.kind === k).length} ${k}`)
                .join(" · ");
            rows.push(`| environment | ${counts} — see \`/env\` |`);
            const tp = planTimeout("plan", "plan");
            rows.push(
                `| timeout | ${tp.timeoutMs > 0 ? `${Math.round(tp.timeoutMs / 1000)}s wall clock` : "no wall-clock cap"} · ${tp.idleTimeoutMs ? `${Math.round(tp.idleTimeoutMs / 1000)}s idle` : "no idle cap"
                } _(${tp.reason})_ |`
            );

            p.response.markdown(
                `${healthy ? "**Bridge is reachable.**" : "**Bridge cannot reach OpenCode.**"}\n\n${rows.join(
                    "\n"
                )}\n\n_No model was called, so this cost nothing._`
            );
            if (!healthy) {
                p.response.button({ command: "opencodeCopilotBridge.diagnose", title: "Run diagnostics" });
                p.response.button({ command: "opencodeCopilotBridge.showLog", title: "Show debug log" });
            }
            return { metadata: { kind: "ping", healthy } };
        }
        case "env": {
            const items = discoverOpenCodeEnv(p.cwd);
            p.response.markdown(
                `**OpenCode environment for \`${p.folder.name}\`**\n\n${summariseEnv(items)}`
            );
            p.response.button({ command: "opencodeCopilotBridge.diagnose", title: "Full diagnostics" });
            return { metadata: { kind: "env", items: items.length } };
        }
        case "session": {
            if (p.state.id) {
                const totals = [
                    `${p.state.turns} turn(s)`,
                    p.state.tokensIn || p.state.tokensOut
                        ? `${p.state.tokensIn ?? 0}↓/${p.state.tokensOut ?? 0}↑ tokens`
                        : "",
                    p.state.cost ? `$${p.state.cost.toFixed(4)}` : "",
                    p.state.toolOutputBytes ? `${formatBytes(p.state.toolOutputBytes)} tool output` : "",
                    p.state.lastModel ? `on \`${p.state.lastModel}\`` : ""
                ].filter(Boolean);
                p.response.markdown(
                    `Active session \`${p.state.id}\` · ${totals.join(" · ")}` +
                    (threadScopeActive(p.context) ? " — scoped to this chat." : ".")
                );
            } else {
                const elsewhere = threadScopeActive(p.context) ? getActiveSession(p.cwd).id : undefined;
                p.response.markdown(
                    elsewhere
                        ? `No session in **this chat** yet — send a message to start one. ` +
                        `Session \`${elsewhere}\` belongs to another chat and is untouched.`
                        : "No active session yet — send a message to start one."
                );
            }
            return { metadata: { kind: "session", cwd: p.cwd } };
        }
        case "sessions":
            return handleSessions({ cwd: p.cwd, folderName: p.folder.name, state: p.state, response: p.response, token: p.token });
        case "flow": {
            // No model call, no spawn, no request: the trace is in memory.
            const arg = p.args.trim().toLowerCase();
            const back = arg === "" ? 1 : Number(arg);
            if (arg !== "all" && !(Number.isInteger(back) && back >= 1)) {
                p.response.markdown("`/flow` draws the last turn, `/flow 3` the third-last, `/flow all` every traced turn of this chat.");
                return { metadata: { kind: "flow" } };
            }
            const ids = threadFlows(p.context.history ?? [], p.cwd);
            const picked = arg === "all" ? [...ids].reverse() : ids.slice(back - 1, back);
            const traces = picked.flatMap((id) => flowById(id) ?? []);
            if (!traces.length) {
                p.response.markdown(
                    ids.length >= back || arg === "all"
                        ? "That turn is no longer in memory: `/flow` keeps the last 20 turns of this window, and none from before a reload."
                        : `This chat has ${ids.length ? `${ids.length} traced turn(s)` : "no traced turn yet"} — \`/flow\` draws a plan, dev or parallel turn after it ran.`
                );
                return { metadata: { kind: "flow" } };
            }
            p.response.markdown(
                traces
                    .map((t) => `**${mdText(truncate(t.title, 80))}** — ${mdText(flowSummary(t))}\n\n\`\`\`mermaid\n${toMermaid(t)}\n\`\`\``)
                    .join("\n\n")
            );
            return { metadata: { kind: "flow" } };
        }
        default:
            return undefined;
    }
}