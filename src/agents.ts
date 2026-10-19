// Which OpenCode agent a read-only turn runs as: `planAgent`, but only
// once OpenCode itself says it loaded that agent for this folder.
//
// Measured on 1.18.32 (REFS "Read-only turns"):
//   - `opencode run --agent <unknown>` prints `agent "x" not found. Falling
//     back to default agent` on stderr, exits 0, and runs as BUILD — with
//     --auto, a turn that edits. A subagent name falls back the same way.
//   - `POST /session/:id/message` with an unknown agent answers HTTP 500
//     "Unexpected server error" (session.error: `Agent not found: "x"`) —
//     it never falls back.
//   - A running server lists a folder's agents once: an agent file added
//     later is missing from `GET /agent` until the server restarts.
// So a name OpenCode has not confirmed is never sent: the turn runs as the
// built-in `plan` and says why. A server confirms for itself only — when it
// fails mid-turn, the CLI that takes over runs as `plan` too (chat-turn.ts).

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { config, logChannel, stamp } from "./core";
import { enforcedConfigContent } from "./enforce";
import { currentServerGeneration } from "./net";
import { api } from "./oc-api";
import { killTree, spawnOpenCode } from "./proc";

/** One permission rule, as OpenCode lists and stores them (1.19.0). */
export interface PermissionRule {
    permission: string;
    pattern: string;
    action: string;
}

export interface AgentInfo {
    name: string;
    mode?: string;
    hidden?: boolean;
    /** The agent's own rules, from a server's `GET /agent` (1.19.0); the CLI listing has none. */
    permission?: PermissionRule[];
}

export const isPermissionRule = (r: unknown): r is PermissionRule => {
    const x = r as Partial<PermissionRule> | undefined;
    return typeof x?.permission === "string" && typeof x.pattern === "string" &&
        (x.action === "allow" || x.action === "deny" || x.action === "ask");
};

export type AgentFallback = "missing" | "subagent" | "hidden" | "unverified";

export interface PlanAgentChoice {
    /** What the turn runs as. */
    agent: string;
    /** What `planAgent` asked for. */
    wanted: string;
    /** Why `agent` is not `wanted`. */
    fallback?: AgentFallback;
    /** The fallback came from a server's list (it reads agents once). */
    onServer?: boolean;
}

const BUILT_IN_PLAN = "plan";
// A server lists agents once per directory (restart to reread), so a minute is
// plenty. `opencode agent list` costs a process (1.4s measured; 14s the first
// time in a fresh config dir), but its good answer is kept no longer: `opencode
// run` reads agent files fresh, so a deleted planAgent trusted from a stale
// listing would run as BUILD. An answer WITHOUT the wanted agent, or no answer,
// is asked again after RETRY_MS: a just-added agent file is found.
const LISTED_TTL_MS = 60000;
const RETRY_MS = 15000;
const LIST_TIMEOUT_MS = 30000;
// The server's first request for a folder bootstraps it (config, plugins, MCP).
const SERVER_LIST_TIMEOUT_MS = 10000;
const listed = new Map<string, { at: number; agents: AgentInfo[] | undefined }>();
const noticed = new Set<string>();

// `opencode agent list` (1.18.32): one `name (mode)` line per agent, each
// followed by its permission rules as indented JSON — the effective, merged
// rules (1.18.35, 1.19.0: the same list `GET /agent` gives). A nested file
// (`agents/team/look.md`) is named `team/look`.
export function parseAgentList(raw: string): AgentInfo[] {
    const out: AgentInfo[] = [];
    let json: string[] = [];
    const closeRules = (): void => {
        const last = out[out.length - 1];
        const text = json.join("\n").trim();
        json = [];
        if (!last || !text) {
            return;
        }
        try {
            const rules = JSON.parse(text) as unknown;
            if (Array.isArray(rules) && rules.length && rules.every(isPermissionRule)) {
                last.permission = rules;
            }
        } catch {
            // not the rules block this version prints: names and modes still count
        }
    };
    for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^([^\s[\]{}"][^\r\n]*?) \((primary|subagent|all)\)\s*$/);
        if (m) {
            closeRules();
            out.push({ name: m[1], mode: m[2] });
        } else if (out.length) {
            json.push(line);
        }
    }
    closeRules();
    return out;
}

async function agentsFromServer(base: string, cwd: string): Promise<AgentInfo[]> {
    const raw = await api(base).agents(cwd, SERVER_LIST_TIMEOUT_MS);
    if (!Array.isArray(raw)) {
        throw new Error("GET /agent did not return a list");
    }
    return raw
        .filter((a): a is Record<string, unknown> => Boolean(a) && typeof (a as { name?: unknown }).name === "string")
        .map((a) => ({
            name: a.name as string,
            mode: a.mode as string | undefined,
            hidden: a.hidden === true,
            ...(Array.isArray(a.permission) && a.permission.every(isPermissionRule) ? { permission: a.permission } : {})
        }));
}

// No server on this path (transport cli, or a server that would not start):
// ask the same loader `opencode run` uses, in the same folder.
function agentsFromCli(cwd: string): Promise<AgentInfo[]> {
    return new Promise((resolve, reject) => {
        const child = spawnOpenCode(config().get<string>("executable", "opencode"), ["agent", "list"], cwd);
        child.stdin?.end();
        let output = "";
        let errors = "";
        let settled = false;
        const done = (fn: () => void): void => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                fn();
            }
        };
        const timer = setTimeout(() => {
            killTree(child);
            done(() => reject(new Error(`opencode agent list timed out after ${LIST_TIMEOUT_MS} ms`)));
        }, LIST_TIMEOUT_MS);
        timer.unref?.();
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => (output += chunk));
        child.stderr.on("data", (chunk: string) => (errors = (errors + chunk).slice(0, 400)));
        child.on("error", (error) => done(() => reject(error)));
        child.on("close", (code) =>
            done(() => {
                const agents = parseAgentList(output);
                if (code !== 0 || !agents.length) {
                    reject(new Error(`opencode agent list exited ${code}: ${errors.trim() || `${agents.length} agents`}`));
                    return;
                }
                resolve(agents);
            })
        );
    });
}

const inFlight = new Map<string, Promise<AgentInfo[] | undefined>>();

const digest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The config files a cold `opencode run` in `cwd` reads (1.x: opencode.json[c]
 * up the tree, `.opencode/` and the global config dir with their agent files,
 * OPENCODE_CONFIG), as paths and mtimes. Stats only; nothing is read or written. */
export function configStamp(cwd: string): string {
    const parts: string[] = [];
    const stat = (file: string): void => {
        try {
            parts.push(`${file}:${fs.statSync(file).mtimeMs}`);
        } catch {
            // absent: nothing to stamp
        }
    };
    const configDir = (dir: string): void => {
        for (const name of ["opencode.json", "opencode.jsonc", "config.json", "config.jsonc"]) {
            stat(path.join(dir, name));
        }
        for (const sub of ["agent", "agents"]) {
            try {
                for (const name of fs.readdirSync(path.join(dir, sub), { recursive: true }) as string[]) {
                    stat(path.join(dir, sub, name));
                }
            } catch {
                // no agent folder here
            }
        }
    };
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
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

export async function listAgents(cwd: string, base?: string, want?: string): Promise<AgentInfo[] | undefined> {
    // A cold listing is what `opencode run` would load now: keyed by the injected
    // config and the config files' stamps, so an edit — or a checkout that adds
    // an opencode.json — is listed afresh, not served from the minute's cache.
    const key = base
        ? `${base}\0${currentServerGeneration()}\0${cwd}`
        : `cli\0${config().get<string>("executable", "opencode")}\0${digest(enforcedConfigContent() ?? "")}\0${configStamp(cwd)}\0${cwd}`;
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
    const fetchPromise = (async (): Promise<AgentInfo[] | undefined> => {
        let agents: AgentInfo[] | undefined;
        try {
            agents = base ? await agentsFromServer(base, cwd) : await agentsFromCli(cwd);
        } catch (error) {
            logChannel.appendLine(`[${stamp()}] could not list OpenCode's agents: ${error}`);
        }
        listed.set(key, { at: Date.now(), agents });
        return agents;
    })().finally(() => {
        inFlight.delete(key);
    });
    inFlight.set(key, fetchPromise);
    return fetchPromise;
}

/** `planAgent` as set — `plan` when blank. */
export function planAgentSetting(): string {
    return config().get<string>("planAgent", "plan").trim() || BUILT_IN_PLAN;
}

export async function resolvePlanAgent(cwd: string, base?: string): Promise<PlanAgentChoice> {
    const wanted = planAgentSetting();
    if (wanted === BUILT_IN_PLAN) {
        return { agent: wanted, wanted };
    }
    const agents = await listAgents(cwd, base, wanted);
    const found = agents?.find((a) => a.name === wanted);
    const fallback: AgentFallback | undefined = !agents
        ? "unverified"
        : !found
            ? "missing"
            : found.mode === "subagent"
                ? "subagent"
                : found.hidden
                    ? "hidden"
                    : undefined;
    if (fallback) {
        logChannel.appendLine(`[${stamp()}] planAgent "${wanted}" not usable (${fallback}) — this turn runs as plan`);
        return { agent: BUILT_IN_PLAN, wanted, fallback, onServer: Boolean(base) };
    }
    return { agent: wanted, wanted };
}

/** The one line a fallback earns in chat — once per window per folder, agent
 * and reason (every later turn only logs it); a turn that could not check at
 * all says so every time. */
export function planAgentNotice(choice: PlanAgentChoice | undefined, cwd: string): string | undefined {
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

/**
 * claim:lane-agents — why a lane cannot run as `a:<name>`, or undefined. Lanes run through
 * `opencode run`, which runs an unknown or subagent-mode `--agent` as BUILD
 * (it edits) with only a stderr warning (1.18.32 `cli/cmd/run.ts`): such a lane
 * is refused before anything runs. A subagent is for the lane's own agent to
 * call, through the task tool.
 */
export function laneAgentProblem(name: string, agents: AgentInfo[] | undefined): string | undefined {
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
