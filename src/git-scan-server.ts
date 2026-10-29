// Standalone MCP stdio entry point: copied unchanged into global storage.
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";

const TOOL = {
    name: "gitScan",
    description: "Read the current repository's branch, HEAD, upstream divergence and file status. No file contents. Maximum 40 changed files.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
};

function statusText(raw: string): string {
    const headers = new Map<string, string>();
    const files: string[] = [];
    const records = raw.split("\0");
    const quote = (name: string): string => JSON.stringify(name);
    for (let i = 0; i < records.length; i += 1) {
        const row = records[i];
        if (row.startsWith("# ")) {
            const at = row.indexOf(" ", 2);
            headers.set(row.slice(2, at), row.slice(at + 1));
        } else if (/^[12u] /.test(row)) {
            const count = row[0] === "1" ? 8 : row[0] === "2" ? 9 : 10;
            let at = 0;
            for (let field = 0; field < count; field += 1) at = row.indexOf(" ", at) + 1;
            const name = row.slice(at);
            const source = row[0] === "2" ? records[++i] : undefined;
            files.push(`${row.slice(2, 4)} ${source === undefined ? quote(name) : `${quote(source)} -> ${quote(name)}`}`);
        } else if (row.startsWith("? ")) files.push(`?? ${quote(row.slice(2))}`);
        else if (row.startsWith("! ")) files.push(`!! ${quote(row.slice(2))}`);
    }
    const oid = headers.get("branch.oid") ?? "(unknown)";
    return [
        `Branch: ${headers.get("branch.head") ?? "(unknown)"}`,
        `HEAD: ${oid.startsWith("(") ? oid : oid.slice(0, 7)}`,
        `Upstream: ${headers.get("branch.upstream") ?? "(none)"}`,
        `Ahead/behind: ${headers.get("branch.ab") ?? "(none)"}`,
        ...(files.length ? files.slice(0, 40) : ["Working tree: clean"]),
        ...(files.length > 40 ? [`…${files.length - 40} more`] : [])
    ].join("\n");
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
type GitError = (Error & { code?: unknown; killed?: boolean }) | null;

const git = (args: string[], done: (error: GitError, stdout: string, stderr: string) => void): void => {
    execFile("git", args, {
        cwd: process.argv[2] || process.cwd(),
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        timeout: 5000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8"
    }, done);
};

const failure = (error: NonNullable<GitError>, stderr: string): ToolResult => ({
    content: [{ type: "text", text: (error.code === "ENOENT" ? "git not on PATH" : error.killed ? "git status timed out after 5 s" : (stderr.trim() || error.message)).slice(0, 128 * 1024) }],
    isError: true
});

// `git status` runs a stat-dirty file through its clean/process filter, and in
// each submodule a status of its own: either executes a command from the repo's
// config (measured, git 2.43). Every configured driver is blanked, and
// submodules are compared by commit only. Reading config runs nothing.
function filterOverrides(listed: string): string[] | undefined {
    const names = new Set<string>();
    for (const record of listed.split("\0")) {
        const key = record.split("\n", 1)[0];
        const at = key.lastIndexOf(".");
        if (key.startsWith("filter.") && at > 7) names.add(key.slice(7, at));
    }
    // `-c` splits at the first `=`: such a name could not be overridden.
    if ([...names].some((n) => n.includes("="))) return undefined;
    return [...names].flatMap((n) => ["-c", `filter.${n}.clean=`, "-c", `filter.${n}.smudge=`, "-c", `filter.${n}.process=`, "-c", `filter.${n}.required=false`]);
}

function gitScan(): Promise<ToolResult> {
    return new Promise((resolve) => {
        git(["config", "-z", "--get-regexp", "^filter\\."], (listError, listed, listStderr) => {
            // Exit 1 is "no such key": no driver to blank.
            if (listError && listError.code !== 1) return resolve(failure(listError, listStderr));
            const overrides = filterOverrides(listError ? "" : listed);
            if (!overrides) return resolve({ content: [{ type: "text", text: "A configured Git filter name contains '=': not scanned." }], isError: true });
            git(["--no-optional-locks", "-c", "core.fsmonitor=false", ...overrides, "status", "--porcelain=v2", "--branch", "--ignore-submodules=dirty", "-z"], (error, stdout, stderr) => {
                resolve(error ? failure(error, stderr) : { content: [{ type: "text", text: statusText(stdout).slice(0, 128 * 1024) }] });
            });
        });
    });
}

const reply = (id: unknown, result?: unknown, error?: { code: number; message: string }): void => {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }) + "\n");
};

async function frame(line: string): Promise<void> {
    let request: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: { protocolVersion?: unknown; name?: unknown; arguments?: unknown } };
    try { request = JSON.parse(line); }
    catch { reply(null, undefined, { code: -32700, message: "Parse error" }); return; }
    if (!request || Array.isArray(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string" ||
        (request.id !== undefined && typeof request.id !== "string" && typeof request.id !== "number" && request.id !== null)) {
        reply(null, undefined, { code: -32600, message: "Invalid Request" }); return;
    }
    if (request.id === undefined) return;
    if (request.params !== undefined && (!request.params || typeof request.params !== "object" || Array.isArray(request.params))) {
        reply(request.id, undefined, { code: -32602, message: "Invalid params" }); return;
    }
    switch (request.method) {
        case "initialize": {
            const supported = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
            const asked = request.params?.protocolVersion;
            reply(request.id, { protocolVersion: typeof asked === "string" && supported.includes(asked) ? asked : "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "git-scan", version: "0.0.231" } });
            break;
        }
        case "ping": reply(request.id, {}); break;
        case "tools/list": reply(request.id, { tools: [TOOL] }); break;
        case "tools/call":
            if (request.params?.name !== TOOL.name || (request.params.arguments !== undefined &&
                (!request.params.arguments || typeof request.params.arguments !== "object" || Array.isArray(request.params.arguments) || Object.keys(request.params.arguments).length))) {
                reply(request.id, undefined, { code: -32602, message: "Expected gitScan with empty arguments" });
            } else reply(request.id, await gitScan());
            break;
        default: reply(request.id, undefined, { code: -32601, message: "Method not found" });
    }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
// Serial requests bound concurrent Git children. Notifications never get a response.
let queue = Promise.resolve();
input.on("line", (line) => {
    queue = queue.then(() => frame(line)).catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    });
});
