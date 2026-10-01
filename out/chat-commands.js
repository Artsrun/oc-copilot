"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleControlCommand = handleControlCommand;
const core_1 = require("./core");
const followups_1 = require("./followups");
const proc_1 = require("./proc");
const net_1 = require("./net");
const runs_1 = require("./runs");
const env_1 = require("./env");
const prompt_1 = require("./prompt");
const context_1 = require("./context");
const models_1 = require("./models");
const session_1 = require("./session");
const commands_1 = require("./commands");
const chat_boot_1 = require("./chat-boot");
const chat_sessions_1 = require("./chat-sessions");
const flow_1 = require("./flow");
async function handleControlCommand(p) {
    switch (p.control) {
        case "help":
            p.response.markdown((0, chat_boot_1.helpMarkdown)());
            return { metadata: { kind: "help" } };
        case "stop": {
            if (!p.state.id) {
                p.response.markdown("Nothing to stop — this chat has no OpenCode session yet.");
                return { metadata: { kind: "stop" } };
            }
            let base;
            try {
                base = await (0, net_1.ensureServer)(p.cwd);
            }
            catch {
                base = undefined;
            }
            if (!base) {
                p.response.markdown("The OpenCode server is not reachable, so there is no server-side run to stop.");
                return { metadata: { kind: "stop" } };
            }
            const busy = await (0, runs_1.sessionBusy)(base, p.state.id, p.cwd);
            if (!busy) {
                p.response.markdown(`${(0, followups_1.mark)("ok")} \`${p.state.id}\` is idle — nothing was running.`);
                return { metadata: { kind: "stop" } };
            }
            const stopped = await (0, runs_1.abortServerRun)(base, p.state.id, p.cwd, "/stop");
            p.response.markdown(stopped
                ? `${(0, followups_1.mark)("stop")} Stopped the run in \`${p.state.id}\`. The session is kept; your next message continues it.`
                : `${(0, followups_1.mark)("warn")} Asked \`${p.state.id}\` to stop, but it still reports busy. \`/new\` starts a clean session.`);
            return { metadata: { kind: "stop" } };
        }
        case "new":
            if (p.state.id) {
                session_1.liveSessions.drop(p.cwd, p.state.id);
            }
            await (0, session_1.setActiveSession)(p.cwd, { turns: 0 });
            (0, session_1.refreshStatus)(p.cwd);
            p.response.markdown((p.state.id ? `${(0, followups_1.mark)("ok")} Started a fresh OpenCode session — \`${p.state.id}\` is closed. ` : (0, followups_1.mark)("ok") + " Started a fresh OpenCode session. ") +
                "Your next message starts from zero context.");
            p.response.button({
                command: "opencodeCopilotBridge.newChat",
                title: "Open a new chat"
            });
            return { metadata: { kind: "new", cwd: p.cwd } };
        case "model": {
            const settings = (0, core_1.config)();
            const chain = (0, context_1.uniqueModels)([settings.get("model", ""), ...(settings.get("fallbackModels", []) ?? [])], 4);
            const set = chain.length ? undefined : (0, env_1.openCodeConfigModel)(p.cwd);
            const info = (0, models_1.cachedModelInfo)();
            const listed = Object.keys(info);
            const pin = settings.get("model", "").trim();
            const level = (0, models_1.pinLevel)(settings);
            const row = (m, i) => `${i + 1}. ${(0, models_1.modelLabel)(m, info)}` +
                (m === pin && level ? ` · ${level} settings, chat only` : "") +
                (listed.length && !info[m] ? " · (not listed)" : "");
            const lines = [
                chain.length
                    ? `Model chain (first wins, rest are timeout fallbacks):\n\n${chain.map(row).join("\n")}`
                    : "No model pinned — OpenCode picks: " +
                        (set ? `a new session starts on ${(0, models_1.modelLabel)(set.model, info)} (${set.from})` : "a new session starts on OpenCode's default") +
                        ", and a session keeps the model it last ran on."
            ];
            if (p.state.lastModel) {
                lines.push(`This chat's session last ran on ${(0, models_1.modelLabel)(p.state.lastModel, info)}.`);
            }
            p.response.markdown(lines.join("\n\n"));
            p.response.button({ command: "opencodeCopilotBridge.setModel", title: "Change default model" });
            return { metadata: { kind: "model" } };
        }
        case "ping": {
            const settings = (0, core_1.config)();
            const exe = settings.get("executable", "opencode");
            const rows = ["| Check | Result |", "| --- | --- |"];
            let healthy = true;
            let resolvedTarget = "";
            try {
                const r = (0, proc_1.resolveExecutable)(exe);
                resolvedTarget = r.target;
                rows.push(`| executable | ${(0, followups_1.mark)("ok")} \`${r.target}\`${r.viaCmd ? " _(via cmd.exe)_" : ""} |`);
            }
            catch {
                healthy = false;
                rows.push(`| executable | ${(0, followups_1.mark)("fail")} \`${exe}\` not found on PATH |`);
            }
            if (resolvedTarget) {
                const version = (await (0, commands_1.runCapture)(exe, ["--version"], p.cwd, 6000)).trim();
                const ok = version && !/^error|timed out/i.test(version);
                healthy = healthy && Boolean(ok);
                rows.push(`| version | ${ok ? (0, followups_1.mark)("ok") : (0, followups_1.mark)("fail")} \`${(0, core_1.truncate)(version || "no output", 60)}\` |`);
            }
            const host = settings.get("serverHostname", "127.0.0.1");
            const port = settings.get("serverPort", 4096);
            try {
                await (0, net_1.httpGetJson)(`http://${host}:${port}/global/health`, 2000);
                let scope = "";
                try {
                    const mine = await (0, net_1.httpGetJson)((0, net_1.withDirectory)(`http://${host}:${port}/session`, p.cwd), 2500);
                    scope = ` · ${Array.isArray(mine) ? mine.length : 0} session(s) scoped to \`${p.folder.name}\``;
                }
                catch {
                }
                rows.push(`| server | ${(0, followups_1.mark)("ok")} healthy on ${host}:${port}${scope} |`);
            }
            catch {
                rows.push(`| server | not running on ${host}:${port} _(started on demand)_ |`);
            }
            const catalog = await (0, models_1.getModelCatalog)(exe, p.cwd);
            rows.push(`| models | ${catalog.models.length ? (0, followups_1.mark)("ok") : (0, followups_1.mark)("warn")} ${catalog.models.length} via the **${catalog.source}** tier |`);
            rows.push(`| workspace | \`${p.folder.name}\` |`);
            const env = (0, env_1.discoverOpenCodeEnv)(p.cwd);
            const counts = ["plugin", "hooks", "mcp", "command", "skill"]
                .map((k) => `${env.filter((i) => i.kind === k).length} ${k}`)
                .join(" · ");
            rows.push(`| environment | ${counts} — see \`/env\` |`);
            const tp = (0, prompt_1.planTimeout)("plan", "plan");
            rows.push(`| timeout | ${tp.timeoutMs > 0 ? `${Math.round(tp.timeoutMs / 1000)}s wall clock` : "no wall-clock cap"} · ${tp.idleTimeoutMs ? `${Math.round(tp.idleTimeoutMs / 1000)}s idle` : "no idle cap"} _(${tp.reason})_ |`);
            p.response.markdown(`${healthy ? "**Bridge is reachable.**" : "**Bridge cannot reach OpenCode.**"}\n\n${rows.join("\n")}\n\n_No model was called, so this cost nothing._`);
            if (!healthy) {
                p.response.button({ command: "opencodeCopilotBridge.diagnose", title: "Run diagnostics" });
                p.response.button({ command: "opencodeCopilotBridge.showLog", title: "Show debug log" });
            }
            return { metadata: { kind: "ping", healthy } };
        }
        case "env": {
            const items = (0, env_1.discoverOpenCodeEnv)(p.cwd);
            p.response.markdown(`**OpenCode environment for \`${p.folder.name}\`**\n\n${(0, env_1.summariseEnv)(items)}`);
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
                    p.state.toolOutputBytes ? `${(0, core_1.formatBytes)(p.state.toolOutputBytes)} tool output` : "",
                    p.state.lastModel ? `on \`${p.state.lastModel}\`` : ""
                ].filter(Boolean);
                p.response.markdown(`Active session \`${p.state.id}\` · ${totals.join(" · ")}` +
                    ((0, session_1.threadScopeActive)(p.context) ? " — scoped to this chat." : "."));
            }
            else {
                const elsewhere = (0, session_1.threadScopeActive)(p.context) ? (0, session_1.getActiveSession)(p.cwd).id : undefined;
                p.response.markdown(elsewhere
                    ? `No session in **this chat** yet — send a message to start one. ` +
                        `Session \`${elsewhere}\` belongs to another chat and is untouched.`
                    : "No active session yet — send a message to start one.");
            }
            return { metadata: { kind: "session", cwd: p.cwd } };
        }
        case "sessions":
            return (0, chat_sessions_1.handleSessions)({ cwd: p.cwd, folderName: p.folder.name, state: p.state, response: p.response, token: p.token });
        case "flow": {
            const arg = p.args.trim().toLowerCase();
            const back = arg === "" ? 1 : Number(arg);
            if (arg !== "all" && !(Number.isInteger(back) && back >= 1)) {
                p.response.markdown("`/flow` draws the last turn, `/flow 3` the third-last, `/flow all` every traced turn of this chat.");
                return { metadata: { kind: "flow" } };
            }
            const ids = (0, session_1.threadFlows)(p.context.history ?? [], p.cwd);
            const picked = arg === "all" ? [...ids].reverse() : ids.slice(back - 1, back);
            const traces = picked.flatMap((id) => (0, flow_1.flowById)(id) ?? []);
            if (!traces.length) {
                p.response.markdown(ids.length >= back || arg === "all"
                    ? "That turn is no longer in memory: `/flow` keeps the last 20 turns of this window, and none from before a reload."
                    : `This chat has ${ids.length ? `${ids.length} traced turn(s)` : "no traced turn yet"} — \`/flow\` draws a plan, dev or parallel turn after it ran.`);
                return { metadata: { kind: "flow" } };
            }
            p.response.markdown(traces
                .map((t) => `**${(0, core_1.mdText)((0, core_1.truncate)(t.title, 80))}** — ${(0, core_1.mdText)((0, flow_1.flowSummary)(t))}\n\n\`\`\`mermaid\n${(0, flow_1.toMermaid)(t)}\n\`\`\``)
                .join("\n\n"));
            return { metadata: { kind: "flow" } };
        }
        default:
            return undefined;
    }
}
//# sourceMappingURL=chat-commands.js.map