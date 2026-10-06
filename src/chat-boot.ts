// The chat vocabulary: control, kind and routed commands, aliases, retired
// words, `/help`. The rest of what chat renders lives in ./heartbeat (live
// turn), ./lanes (`/parallel`) and ./chips (follow-ups); they are re-exported
// here so the chat layer keeps one import.
import { config, own } from "./core";
import { ChatKind } from "./metrics";

export * from "./heartbeat";
export * from "./lanes";
export * from "./chips";

// One source of truth for the control commands: the manifest's
// `chatParticipants[].commands`, the runtime set, and the typed-`/word`
// regex all derive from this, so they cannot drift (the LB group guards it).
export const SLASH_COMMANDS = ["new", "session", "sessions", "help", "model", "ping", "env", "stop", "compact"] as const;
const CONTROL_COMMANDS = new Set<string>(SLASH_COMMANDS);
const KIND_COMMANDS: Record<string, ChatKind> = {
    plan: "plan",
    dev: "dev",
    parallel: "parallel"
};

export function controlCommand(declared: string, typed: string): string {
    return CONTROL_COMMANDS.has(declared) ? declared : typed;
}

export function typedSlash(prompt: string): string {
    return (
        prompt.match(new RegExp(`^/(${SLASH_COMMANDS.join("|")})\\b\\s*`, "i"))?.[1]?.toLowerCase() ?? ""
    );
}

// ---------------------------------------------------------------------------
// claim:command-aliases — `/d fix it` is `/dev fix it`. Typed only, never in the
// manifest. A real command always wins; an alias to a non-command is refused.
export const DEFAULT_ALIASES: Readonly<Record<string, string>> = {
    p: "parallel",
    d: "dev",
    pl: "plan",
    n: "new",
    s: "session",
    x: "stop",
    m: "model",
    w: "worktree",
    e: "env",
    ls: "sessions",
    h: "help",
    "?": "help"
};

export const allCommands = (): string[] => [...SLASH_COMMANDS, ...KIND_COMMAND_NAMES, ...ROUTED_COMMANDS];

const bare = (word: string): string => word.trim().replace(/^\//, "").toLowerCase();

/** The defaults with the user's `commandAliases` on top (keys and targets without the `/`). */
export function commandAliases(user: unknown = config().get<unknown>("commandAliases", {})): Record<string, string> {
    const table: Record<string, string> = { ...DEFAULT_ALIASES };
    if (user && typeof user === "object") {
        for (const [k, v] of Object.entries(user as Record<string, unknown>)) {
            if (typeof v === "string" && bare(k) && bare(v)) {
                table[bare(k)] = bare(v);
            }
        }
    }
    return table;
}

export function resolveAlias(
    prompt: string,
    table: Record<string, string> = commandAliases()
): { prompt: string; problem?: string } {
    const m = prompt.match(/^\/(\S+)(?=\s|$)/);
    if (!m) {
        return { prompt };
    }
    const word = m[1].toLowerCase();
    const commands = allCommands();
    if (commands.includes(word) || word === "par") {
        return { prompt };
    }
    const target = own(table, word);
    if (!target) {
        return { prompt };
    }
    if (!commands.includes(target)) {
        return {
            prompt,
            problem:
                `\`/${word}\` is set to \`/${target}\` in \`commandAliases\`, and that is not a command. ` +
                `Commands: ${commands.map((c) => `\`/${c}\``).join(" ")}.`
        };
    }
    return { prompt: `/${target}${prompt.slice(m[0].length)}` };
}

export function kindChoice(declared: string, parsedKind: ChatKind): ChatKind {
    return own(KIND_COMMANDS, declared) ?? parsedKind;
}

export const KIND_COMMAND_NAMES = Object.keys(KIND_COMMANDS);
// Participant commands routed to their own handler before kind/control parsing.
export const ROUTED_COMMANDS = ["worktree"] as const;

// A removed command typed from habit would otherwise go to the model as a paid
// task (`/` keeps it out of the vague-prompt gate). Answered, never run.
const RETIRED: Readonly<Record<string, string>> = { flow: "0.0.196", f: "0.0.196" };

export function retiredCommand(prompt: string): string | undefined {
    const word = prompt.match(/^\/(\S+)(?=\s|$)/)?.[1]?.toLowerCase() ?? "";
    const since = own(RETIRED, word);
    return since ? `\`/${word}\` was removed in ${since}, so nothing was run. \`/help\` lists the commands.` : undefined;
}

export function isKindCommand(declared: string): boolean {
    return Boolean(own(KIND_COMMANDS, declared));
}

export function helpMarkdown(): string {
    return [
        `**OpenCode bridge** — one ongoing session per ${config().get<string>("sessionScope", "thread") === "workspace" ? "folder" : "chat"}.`,
        "",
        "| Command | What it does |",
        "| --- | --- |",
        "| `/plan <task>` | Read-only agent (default): `plan`, or your `planAgent` |",
        "| `/dev <task>` | Editing agent — may write files |",
        "| `/parallel a \\| b \\| c` | Run independent lanes at once in isolated sessions — `/parallel` alone composes them step by step |",
        "| `/worktree <task>` | Editing agent in a NEW git worktree + branch next to the repo; your checkout is untouched |",
        "| `/session` | Session id, turns, totals |",
        "| `/sessions` | This folder's sessions: continue, fork, close or delete one |",
        "| `/stop` | Stop a run still going on the server (closing the chat does not) |",
        "| `/compact` | Summarise this chat's session now (one model pass), as autocompact does |",
        "| `/new` | Start a fresh session |",
        "| `/model` | Show and change the model chain |",
        "| `/ping` | Connectivity check — no model call, no cost |",
        "| `/env` | What OpenCode loaded: config, plugins, hooks, MCP, skills |",
        "| `/help` | This table |",
        "",
        "Inline prefixes still work: `dev:`, `model:provider/id` — or a short name, `model:tundra`.",
        "Lanes split on `|`, `;;` or a `---` line. Per lane: `/parallel m:tundra review auth | m:oasis read the logs`, and `a:<agent>` runs a lane as one of your primary agents (`a:look m:oasis read the logs`). One task on several models: `/parallel models:tundra,oasis,aspen review auth`.",
        "Attach files with `#file:` — they are passed to OpenCode as context.",
        "",
        `Aliases: ${Object.entries(commandAliases())
            .map(([k, v]) => `\`/${k}\` ${v}`)
            .join(" · ")} — add your own with the \`commandAliases\` setting.`
    ].join("\n");
}

