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
// fails mid-turn, the CLI that takes over runs as `plan` too (chat.ts).

import { config, logChannel, stamp } from "./core";
import { httpGetJson, withDirectory } from "./net";
import { killTree, spawnOpenCode } from "./proc";

export interface AgentInfo {
    name: string;
    mode?: string;
    hidden?: boolean;
}

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
// followed by its permission rules as indented JSON. A nested file
// (`agents/team/look.md`) is named `team/look`.
export function parseAgentList(raw: string): AgentInfo[] {
    const out: AgentInfo[] = [];
    for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^([^\s[\]{}"][^\r\n]*?) \((primary|subagent|all)\)\s*$/);
        if (m) {
            out.push({ name: m[1], mode: m[2] });
        }
    }
    return out;
}

async function agentsFromServer(base: string, cwd: string): Promise<AgentInfo[]> {
    const raw = await httpGetJson<unknown>(withDirectory(`${base}/agent`, cwd), SERVER_LIST_TIMEOUT_MS);
    if (!Array.isArray(raw)) {
        throw new Error("GET /agent did not return a list");
    }
    return raw
        .filter((a): a is Record<string, unknown> => Boolean(a) && typeof (a as { name?: unknown }).name === "string")
        .map((a) => ({ name: a.name as string, mode: a.mode as string | undefined, hidden: a.hidden === true }));
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

export async function listAgents(cwd: string, base?: string, want?: string): Promise<AgentInfo[] | undefined> {
    const key = `${base ?? `cli\0${config().get<string>("executable", "opencode")}`}\0${cwd}`;
    const hit = listed.get(key);
    const complete = hit?.agents && (!want || hit.agents.some((a) => a.name === want));
    const ttl = complete ? LISTED_TTL_MS : RETRY_MS;
    if (hit && Date.now() - hit.at < ttl) {
        return hit.agents;
    }
    let agents: AgentInfo[] | undefined;
    try {
        agents = base ? await agentsFromServer(base, cwd) : await agentsFromCli(cwd);
    } catch (error) {
        logChannel.appendLine(`[${stamp()}] could not list OpenCode's agents: ${error}`);
    }
    listed.set(key, { at: Date.now(), agents });
    return agents;
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
