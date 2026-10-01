"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseAgentList = parseAgentList;
exports.listAgents = listAgents;
exports.planAgentSetting = planAgentSetting;
exports.resolvePlanAgent = resolvePlanAgent;
exports.planAgentNotice = planAgentNotice;
const core_1 = require("./core");
const net_1 = require("./net");
const proc_1 = require("./proc");
const BUILT_IN_PLAN = "plan";
const LISTED_TTL_MS = 60000;
const RETRY_MS = 15000;
const LIST_TIMEOUT_MS = 30000;
const SERVER_LIST_TIMEOUT_MS = 10000;
const listed = new Map();
const noticed = new Set();
function parseAgentList(raw) {
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^([^\s[\]{}"][^\r\n]*?) \((primary|subagent|all)\)\s*$/);
        if (m) {
            out.push({ name: m[1], mode: m[2] });
        }
    }
    return out;
}
async function agentsFromServer(base, cwd) {
    const raw = await (0, net_1.httpGetJson)((0, net_1.withDirectory)(`${base}/agent`, cwd), SERVER_LIST_TIMEOUT_MS);
    if (!Array.isArray(raw)) {
        throw new Error("GET /agent did not return a list");
    }
    return raw
        .filter((a) => Boolean(a) && typeof a.name === "string")
        .map((a) => ({ name: a.name, mode: a.mode, hidden: a.hidden === true }));
}
function agentsFromCli(cwd) {
    return new Promise((resolve, reject) => {
        const child = (0, proc_1.spawnOpenCode)((0, core_1.config)().get("executable", "opencode"), ["agent", "list"], cwd);
        child.stdin?.end();
        let output = "";
        let errors = "";
        let settled = false;
        const done = (fn) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                fn();
            }
        };
        const timer = setTimeout(() => {
            (0, proc_1.killTree)(child);
            done(() => reject(new Error(`opencode agent list timed out after ${LIST_TIMEOUT_MS} ms`)));
        }, LIST_TIMEOUT_MS);
        timer.unref?.();
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (errors = (errors + chunk).slice(0, 400)));
        child.on("error", (error) => done(() => reject(error)));
        child.on("close", (code) => done(() => {
            const agents = parseAgentList(output);
            if (code !== 0 || !agents.length) {
                reject(new Error(`opencode agent list exited ${code}: ${errors.trim() || `${agents.length} agents`}`));
                return;
            }
            resolve(agents);
        }));
    });
}
async function listAgents(cwd, base, want) {
    const key = `${base ?? `cli\0${(0, core_1.config)().get("executable", "opencode")}`}\0${cwd}`;
    const hit = listed.get(key);
    const complete = hit?.agents && (!want || hit.agents.some((a) => a.name === want));
    const ttl = complete ? LISTED_TTL_MS : RETRY_MS;
    if (hit && Date.now() - hit.at < ttl) {
        return hit.agents;
    }
    let agents;
    try {
        agents = base ? await agentsFromServer(base, cwd) : await agentsFromCli(cwd);
    }
    catch (error) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] could not list OpenCode's agents: ${error}`);
    }
    listed.set(key, { at: Date.now(), agents });
    return agents;
}
function planAgentSetting() {
    return (0, core_1.config)().get("planAgent", "plan").trim() || BUILT_IN_PLAN;
}
async function resolvePlanAgent(cwd, base) {
    const wanted = planAgentSetting();
    if (wanted === BUILT_IN_PLAN) {
        return { agent: wanted, wanted };
    }
    const agents = await listAgents(cwd, base, wanted);
    const found = agents?.find((a) => a.name === wanted);
    const fallback = !agents
        ? "unverified"
        : !found
            ? "missing"
            : found.mode === "subagent"
                ? "subagent"
                : found.hidden
                    ? "hidden"
                    : undefined;
    if (fallback) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] planAgent "${wanted}" not usable (${fallback}) — this turn runs as plan`);
        return { agent: BUILT_IN_PLAN, wanted, fallback, onServer: Boolean(base) };
    }
    return { agent: wanted, wanted };
}
function planAgentNotice(choice, cwd) {
    if (!choice?.fallback) {
        return undefined;
    }
    const key = `${cwd}\0${choice.wanted}\0${choice.fallback}`;
    if (noticed.has(key) && choice.fallback !== "unverified") {
        return undefined;
    }
    noticed.add(key);
    const name = `\`${choice.wanted}\``;
    switch (choice.fallback) {
        case "missing":
            return choice.onServer
                ? `No ${name} agent in OpenCode for this folder — ran as \`plan\`. Just added it? OpenCode's server reads agents once: reload the window (if the bridge started it) or restart the server.`
                : `No ${name} agent in OpenCode for this folder — ran as \`plan\`. \`opencode agent list\` in this folder shows the agents it loads.`;
        case "subagent":
            return `${name} is a subagent — ran as \`plan\`. Give it \`mode: primary\`.`;
        case "hidden":
            return `${name} is a hidden agent — ran as \`plan\`.`;
        default:
            return `Couldn't list OpenCode's agents to confirm ${name} — ran as the built-in \`plan\`, which is read-only by instruction only.`;
    }
}
//# sourceMappingURL=agents.js.map