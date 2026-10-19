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
exports.isPermissionRule = void 0;
exports.parseAgentList = parseAgentList;
exports.configStamp = configStamp;
exports.listAgents = listAgents;
exports.planAgentSetting = planAgentSetting;
exports.resolvePlanAgent = resolvePlanAgent;
exports.planAgentNotice = planAgentNotice;
exports.laneAgentProblem = laneAgentProblem;
const node_crypto_1 = require("node:crypto");
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const core_1 = require("./core");
const enforce_1 = require("./enforce");
const net_1 = require("./net");
const oc_api_1 = require("./oc-api");
const proc_1 = require("./proc");
const isPermissionRule = (r) => {
    const x = r;
    return typeof x?.permission === "string" && typeof x.pattern === "string" &&
        (x.action === "allow" || x.action === "deny" || x.action === "ask");
};
exports.isPermissionRule = isPermissionRule;
const BUILT_IN_PLAN = "plan";
const LISTED_TTL_MS = 60000;
const RETRY_MS = 15000;
const LIST_TIMEOUT_MS = 30000;
const SERVER_LIST_TIMEOUT_MS = 10000;
const listed = new Map();
const noticed = new Set();
function parseAgentList(raw) {
    const out = [];
    let json = [];
    const closeRules = () => {
        const last = out[out.length - 1];
        const text = json.join("\n").trim();
        json = [];
        if (!last || !text) {
            return;
        }
        try {
            const rules = JSON.parse(text);
            if (Array.isArray(rules) && rules.length && rules.every(exports.isPermissionRule)) {
                last.permission = rules;
            }
        }
        catch {
        }
    };
    for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^([^\s[\]{}"][^\r\n]*?) \((primary|subagent|all)\)\s*$/);
        if (m) {
            closeRules();
            out.push({ name: m[1], mode: m[2] });
        }
        else if (out.length) {
            json.push(line);
        }
    }
    closeRules();
    return out;
}
async function agentsFromServer(base, cwd) {
    const raw = await (0, oc_api_1.api)(base).agents(cwd, SERVER_LIST_TIMEOUT_MS);
    if (!Array.isArray(raw)) {
        throw new Error("GET /agent did not return a list");
    }
    return raw
        .filter((a) => Boolean(a) && typeof a.name === "string")
        .map((a) => ({
        name: a.name,
        mode: a.mode,
        hidden: a.hidden === true,
        ...(Array.isArray(a.permission) && a.permission.every(exports.isPermissionRule) ? { permission: a.permission } : {})
    }));
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
const inFlight = new Map();
const digest = (text) => (0, node_crypto_1.createHash)("sha256").update(text).digest("hex").slice(0, 16);
function configStamp(cwd) {
    const parts = [];
    const stat = (file) => {
        try {
            parts.push(`${file}:${fs.statSync(file).mtimeMs}`);
        }
        catch {
        }
    };
    const configDir = (dir) => {
        for (const name of ["opencode.json", "opencode.jsonc", "config.json", "config.jsonc"]) {
            stat(path.join(dir, name));
        }
        for (const sub of ["agent", "agents"]) {
            try {
                for (const name of fs.readdirSync(path.join(dir, sub), { recursive: true })) {
                    stat(path.join(dir, sub, name));
                }
            }
            catch {
            }
        }
    };
    for (let dir = path.resolve(cwd);; dir = path.dirname(dir)) {
        stat(path.join(dir, "opencode.json"));
        stat(path.join(dir, "opencode.jsonc"));
        configDir(path.join(dir, ".opencode"));
        if (path.dirname(dir) === dir) {
            break;
        }
    }
    if (process.env.OPENCODE_CONFIG_DIR) {
        configDir(process.env.OPENCODE_CONFIG_DIR);
    }
    configDir(path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode"));
    if (process.platform === "win32" && process.env.APPDATA) {
        configDir(path.join(process.env.APPDATA, "opencode"));
    }
    if (process.env.OPENCODE_CONFIG) {
        stat(process.env.OPENCODE_CONFIG);
    }
    return digest(parts.join("\n"));
}
async function listAgents(cwd, base, want) {
    const key = base
        ? `${base}\0${(0, net_1.currentServerGeneration)()}\0${cwd}`
        : `cli\0${(0, core_1.config)().get("executable", "opencode")}\0${digest((0, enforce_1.enforcedConfigContent)() ?? "")}\0${configStamp(cwd)}\0${cwd}`;
    const hit = listed.get(key);
    const complete = hit?.agents && (!want || hit.agents.some((a) => a.name === want));
    const ttl = complete ? LISTED_TTL_MS : RETRY_MS;
    if (hit && Date.now() - hit.at < ttl) {
        return hit.agents;
    }
    const pending = inFlight.get(key);
    if (pending) {
        return pending;
    }
    const fetchPromise = (async () => {
        let agents;
        try {
            agents = base ? await agentsFromServer(base, cwd) : await agentsFromCli(cwd);
        }
        catch (error) {
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] could not list OpenCode's agents: ${error}`);
        }
        listed.set(key, { at: Date.now(), agents });
        return agents;
    })().finally(() => {
        inFlight.delete(key);
    });
    inFlight.set(key, fetchPromise);
    return fetchPromise;
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
function laneAgentProblem(name, agents) {
    const shown = `\`${name}\``;
    if (!agents) {
        return `Couldn't list OpenCode's agents to confirm ${shown} — not run (an unconfirmed name runs as \`build\`).`;
    }
    const found = agents.find((a) => a.name === name);
    if (!found) {
        return `No ${shown} agent in OpenCode for this folder — not run. \`opencode agent list\` shows the agents it loads.`;
    }
    if (found.mode === "subagent") {
        return `${shown} is a subagent — not run: \`opencode run\` would run it as \`build\`. Give it \`mode: all\`, or ask the lane's agent to use it.`;
    }
    if (found.hidden) {
        return `${shown} is a hidden agent — not run.`;
    }
    return undefined;
}
//# sourceMappingURL=agents.js.map