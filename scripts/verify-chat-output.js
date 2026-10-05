// The suite (AGENTS.md §5): stubs vscode, loads out/extension.js, drives chat
// turns through fake OpenCode binaries, and prints ALL <N> CHECKS PASSED.
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-verify-"));

// v181: chips, prompts and marks live in out/followups.json. Checks name chips
// by KEY and compare against the exact label the extension ships, so a copy
// edit in the JSON never needs a test edit — and a typo in code still fails.
const FJ = require(path.join(__dirname, "..", "out", "followups.json"));
const L = Object.fromEntries(Object.entries(FJ.chips).map(([k, c]) => [k, `${c.kao} ${c.label}`]));
const M = FJ.marks;
// v183: prompts are templates ending in {tail}; checks read them resolved.
const fillTail = (t) => String(t).replace(/\{tail\}/g, FJ.tail).trim();
const P = Object.fromEntries(Object.entries(FJ.prompts).map(([k, v]) => [k, fillTail(v)]));
// v184: an answer-derived chip's label exactly as the extension builds it from
// the JSON (kaomoji first where the template has one). Checks name chips by
// template key, so a copy edit never needs a test edit — and a relabel can never
// turn a "this chip is absent" check vacuous (v183's hardcoded labels would have).
const NL = (key, vars = {}) => {
    const t = FJ.natural && FJ.natural[key];
    if (!t) return `<no natural.${key}>`;
    const label = String(t.label).replace(/\{(\w+)\}/g, (all, k) => (k in vars ? vars[k] : all));
    return t.kao ? `${t.kao} ${label}` : label;
};
// The static words of a template (placeholders cut out) — what must never be
// spelled out again in src.
const staticParts = (t) => String(t).split(/\{\w+\}/).map((x) => x.trim()).filter((x) => x.length >= 12);
// Everything any turn in this suite rendered to chat (markdown + progress):
// KM sweeps it for emoji at the end — the artifact, not the source.
const renderedAll = [];
// v182: raw markdown parts (MarkdownString objects keep supportHtml) and every
// progress line, so KB can assert what crossed the stream, not a helper's output.
const mdPartsAll = [];
const progressAll = [];
// v187: marks arrive as inline-code pills; checks about WORDS read the text without them.
const PILL_MARKS = Object.values(require(path.join(__dirname, "..", "src", "followups.json")).marks);
const plain = (text) => PILL_MARKS.reduce((t, m) => t.split("`" + m + "`").join(m), String(text));
const marker = path.join(work, "injected-marker.txt");

// The suite hands `work` to the stub as the workspace root, so every OpenCode
// process it spawns inherits it as cwd — and Windows locks a directory that is
// any live process's cwd. Measured: the lock clears ~0.1s after THIS process
// exits, not before, so no in-process retry can ever win the race. Sweeping at
// startup instead is what actually collects them: by the next run the previous
// run's children are gone and its directories delete cleanly. Without this the
// suite leaks a directory per run indefinitely (12 had accumulated when this was
// found), which is the same "a probe litters the tree it validates" failure that
// AGENTS.md §4 warns about.
function sweepStaleTemp() {
    const tmp = os.tmpdir();
    let swept = 0;
    for (const name of fs.readdirSync(tmp)) {
        // The whole `ocb-*` namespace in tmpdir belongs to this project's probes
        // (ocb-verify, ocb-shim, ocb-env, ocb-bare, ocb-root-b, ocb-probe).
        const stale = /^ocb-/.test(name);
        if (!stale) {
            continue;
        }
        const full = path.join(tmp, name);
        if (full === work) {
            continue;
        }
        try {
            fs.rmSync(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            swept += 1;
        } catch {
            // A concurrent run still owns it. Leave it; the next sweep gets it.
        }
    }
    if (swept) {
        console.log(`(cleanup) swept ${swept} stale temp director${swept === 1 ? "y" : "ies"} from previous runs`);
    }
}
sweepStaleTemp();

function writeFake(name, events, extraJs) {
    const file = path.join(work, name);
    const argvFile = file + ".argv";
    const body =
        "#!/usr/bin/env node\n" +
        "const fs = require('fs');\n" +
        "fs.writeFileSync(" +
        JSON.stringify(argvFile) +
        ", JSON.stringify(process.argv));\n" +
        // v183: what the real CLI resolves its directory from (PWD first).
        "fs.writeFileSync(" +
        JSON.stringify(file + ".env") +
        ", JSON.stringify({ pwd: process.env.PWD ?? null, cwd: process.cwd() }));\n" +
        "const events = " +
        JSON.stringify(events) +
        ";\nfor (const ev of events) process.stdout.write(JSON.stringify(ev) + '\\n');\n" +
        (extraJs || "");
    fs.writeFileSync(file, body);
    fs.chmodSync(file, 0o755);
    if (process.platform === "win32") {
        const cmd = file + ".cmd";
        fs.writeFileSync(cmd, `@echo off\r\nnode "${file}" %*\r\n`);
        return cmd;
    }
    return file;
}

const happy = writeFake("fake-ok.js", [
    { type: "reasoning", sessionID: "ses_test", part: { text: "Thinking about the redirect bug.\nNeed to inspect login.ts." } },
    {
        type: "tool_use",
        sessionID: "ses_test",
        part: {
            tool: "grep",
            state: { input: { pattern: "redirect" }, output: "src/login.ts:41: res.redirect('/')", time: { start: 0, end: 120 } }
        }
    },
    {
        type: "tool_use",
        sessionID: "ses_test",
        part: {
            tool: "read",
            state: { input: { filePath: "src/login.ts" }, output: "export function login() {}", time: { start: 0, end: 80 } }
        }
    },
    { type: "text", sessionID: "ses_test", part: { text: "The redirect loop comes from a stale cookie." } },
    {
        type: "step_finish",
        sessionID: "ses_test",
        part: {
            reason: "stop",
            cost: 0.0031,
            tokens: { input: 1200, output: 340, reasoning: 90, total: 1540, cache: { read: 10, write: 0 } }
        }
    }
]);

const partial = writeFake("fake-partial.js", [
    { type: "reasoning", sessionID: "ses_diff", part: { text: "User wants diffs between current branch and dev-newplat." } },
    {
        type: "tool_use",
        sessionID: "ses_diff",
        part: {
            tool: "bash",
            state: {
                input: {
                    command:
                        "git branch --show-current && git fetch origin dev-newplat --quiet 2>&1; git diff origin/dev-newplat"
                },
                output: "feat/login\ndiff --git a/src/login.ts b/src/login.ts\n+return false;"
            }
        }
    },
    { type: "text", sessionID: "ses_diff", part: { text: "check current branch difs with dev-newplat" } }
]);

const inflight = writeFake(
    "fake-inflight.js",
    [
        {
            type: "tool_use",
            sessionID: "ses_to",
            part: {
                tool: "bash",
                state: { input: { command: "git branch --show-current" }, output: "feat/login\n" }
            }
        },
        {
            type: "tool_use",
            sessionID: "ses_to",
            part: {
                tool: "bash",
                state: { input: { command: "git fetch origin dev-newplat" }, output: "" }
            }
        }
    ],
    "setTimeout(() => {}, 5000);\n"
);

const fat = writeFake("fake-fat.js", [
    {
        type: "tool_use",
        sessionID: "ses_fat",
        part: {
            tool: "bash",
            state: {
                input: { command: "git diff origin/dev-newplat" },
                output: "X".repeat(300000),
                time: { start: 0, end: 50 }
            }
        }
    },
    { type: "text", sessionID: "ses_fat", part: { text: "Diff is large." } },
    {
        type: "step_finish",
        sessionID: "ses_fat",
        part: { reason: "stop", cost: 0.01, tokens: { input: 10, output: 4, reasoning: 0, total: 14, cache: { read: 0, write: 0 } } }
    }
]);

const settings = {
    executable: happy,
    model: "",
    timeoutMs: 30000,
    pure: false,
    transport: "cli",
    autoCompact: false,
    autoCompactEveryTurns: 8,
    showThoughtProcess: true,
    debugLog: false,
    fallbackModels: [],
    notifyOnCompletion: true,
    notifyAfterMs: 30000,
    statusBar: true,
    progressHeartbeatMs: 0,
    groupProgress: true,
    kaomojiBadges: true,
    includeEditorSelection: false,
    serverHostname: "127.0.0.1",
    idleTimeoutMs: 0,
    clarifyVaguePrompts: true,
    maxHandoffAttempts: 3,
    modelCatalogTtlMinutes: 360,
    parallelAllowWrite: false,
    worktreeDiffMaxMB: 16,
    sessionScope: "thread",
    devAgent: "build",
    planAgent: "plan",
    attachDevToServer: true,
    toolQuietMs: 600000,
    busySessionPolicy: "abort",
    commandAliases: {}
};

const repoDir = path.join(__dirname, "..");
let quickPickScript;
const quickPicksShown = [];
let lastStatusItem;
const webviewPanels = [];
const registeredCommands = new Map();
const logLines = [];

const vscodeStub = {
    workspace: {
        workspaceFolders: [{ uri: { fsPath: work }, name: path.basename(work), index: 0 }],
        getWorkspaceFolder: (uri) =>
            (vscodeStub.workspace.workspaceFolders || []).find(
                (f) => uri && uri.fsPath && uri.fsPath.startsWith(f.uri.fsPath)
            ),
        getConfiguration: () => ({
            get: (key, def) => (settings[key] !== undefined ? settings[key] : def),
            update: async () => { }
        }),
        fs: {
            createDirectory: async (uri) => fs.mkdirSync(uri.fsPath, { recursive: true }),
            readFile: async (uri) => fs.readFileSync(uri.fsPath),
            writeFile: async (uri, buf) => fs.writeFileSync(uri.fsPath, buf),
            readDirectory: async (uri) => {
                if (!fs.existsSync(uri.fsPath)) return [];
                return fs
                    .readdirSync(uri.fsPath, { withFileTypes: true })
                    .map((de) => [de.name, de.isDirectory() ? 2 : 1]);
            },
            stat: async (uri) => {
                const st = fs.statSync(uri.fsPath);
                return { mtime: st.mtimeMs ?? st.mtime * 1000, size: st.size };
            },
            delete: async (uri) => fs.rmSync(uri.fsPath, { force: true })
        }
    },
    window: {
        activeTextEditor: undefined,
        state: { focused: true },
        createOutputChannel: () => ({ appendLine: (line) => logLines.push(String(line)), show() { }, dispose() { } }),
        // v184: kept, so a check can read what the bar says after a turn.
        createStatusBarItem: () =>
            (lastStatusItem = {
                text: "",
                tooltip: "",
                command: "",
                backgroundColor: undefined,
                show() { },
                hide() { },
                dispose() { }
            }),
        showInformationMessage() { },
        showWarningMessage() { },
        showErrorMessage() { },
        showQuickPick: async () => undefined,
        showInputBox: async () => undefined,
        // v190: a scriptable createQuickPick. `quickPickScript(qp)` drives it
        // after show() (set value, activeItems, fire accept/button/hide); by
        // default it is dismissed, as Esc would.
        createQuickPick: () => {
            const on = (list) => (cb) => (list.push(cb), { dispose() { } });
            const qp = {
                title: "", placeholder: "", value: "", step: undefined, totalSteps: undefined, items: [], activeItems: [], selectedItems: [], buttons: [],
                ignoreFocusOut: false, shown: 0, disposed: false,
                _accept: [], _button: [], _hide: [],
                onDidAccept: undefined, onDidTriggerButton: undefined, onDidHide: undefined,
                accept() { for (const cb of qp._accept) cb(); },
                trigger(b) { for (const cb of qp._button) cb(b ?? qp.buttons[0]); },
                hide() { for (const cb of qp._hide) cb(); },
                show() { qp.shown += 1; quickPicksShown.push(qp); queueMicrotask(() => (quickPickScript ?? ((q) => q.hide()))(qp)); },
                dispose() { qp.disposed = true; }
            };
            qp.onDidAccept = on(qp._accept);
            qp.onDidTriggerButton = on(qp._button);
            qp.onDidHide = on(qp._hide);
            return qp;
        },
        withProgress: async (_options, task) => task({ report() { } }, { isCancellationRequested: false }),
        // Panels are kept so a check can read back what the extension decorated
        // them with; a returned object nobody holds proves nothing.
        createWebviewPanel: (viewType, title) => {
            const disposeListeners = [];
            const panel = {
                viewType,
                title,
                iconPath: undefined,
                messages: [],
                webview: {
                    html: "",
                    cspSource: "vscode-webview:",
                    postMessage: async (m) => (panel.messages.push(m), true)
                },
                reveal() { },
                onDidDispose: (cb) => (disposeListeners.push(cb), { dispose() { } }),
                dispose() {
                    for (const cb of disposeListeners) cb();
                }
            };
            webviewPanels.push(panel);
            return panel;
        }
    },
    chat: {
        // v186: two participants (panel + inline). Keyed by id so the inline
        // one can never replace the handler every other check drives.
        createChatParticipant: (id, handler) => {
            const participant = { id, iconPath: undefined, followupProvider: undefined, dispose() {} };
            (global.__participants = global.__participants || {})[id] = { handler, participant };
            if (id === "opencodeCopilotBridge.chat") {
                global.__handler = handler;
                global.__participant = participant;
            }
            return participant;
        }
    },
    commands: {
        registerCommand: (id, handler) => (registeredCommands.set(id, handler), { dispose() { } }),
        executeCommand: async () => undefined
    },
    Uri: {
        file: (p) => ({ fsPath: p, scheme: "file", toString: () => p }),
        joinPath: (base, ...parts) => {
            const p = path.join(base.fsPath, ...parts);
            return { fsPath: p, scheme: "file", toString: () => p };
        }
    },
    ThemeColor: class { constructor(id) { this.id = id; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    Range: class { constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; } },
    Location: class { constructor(uri, range) { this.uri = uri; this.range = range; } },
    MarkdownString: class { constructor(v) { this.value = v; } },
    ChatResponseReferencePart: class { constructor(value) { this.value = value; } },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    version: "1.136.0",
    env: { clipboard: { writeText: async () => { } }, appName: "Code", remoteName: undefined, uiKind: 1 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    FileType: { Unknown: 0, File: 1, Directory: 2, Symlink: 64 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { Notification: 15 },
    ViewColumn: { Beside: 2 }
};
vscodeStub.workspace.onDidChangeConfiguration = () => ({ dispose() { } });

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === "vscode") return vscodeStub;
    return originalLoad.call(this, request, ...rest);
};

const ext = require(path.join(__dirname, "..", "out", "extension.js"));
const memento = new Map();
const globalMemento = new Map();
ext.activate({
    subscriptions: [],
    extensionUri: { fsPath: repoDir, scheme: "file", toString: () => repoDir },
    extensionPath: repoDir,
    workspaceState: { get: (k) => memento.get(k), update: async (k, v) => void memento.set(k, v) },
    globalState: { get: (k) => globalMemento.get(k), update: async (k, v) => void globalMemento.set(k, v) }
});

function stream() {
    const chatMarkdown = [];
    const anchors = [];
    const buttons = [];
    const refs = [];
    const progress = [];
    const listeners = [];
    const token = {
        isCancellationRequested: false,
        onCancellationRequested: (cb) => (listeners.push(cb), { dispose() { } }),
        // Test-only: flip the flag then fan out, exactly like VS Code does.
        cancel() {
            token.isCancellationRequested = true;
            for (const cb of listeners) cb();
        }
    };
    return {
        chatMarkdown,
        anchors,
        buttons,
        refs,
        progress,
        response: {
            markdown: (v) => {
                const text = typeof v === "string" ? v : String(v.value ?? v);
                chatMarkdown.push(text);
                renderedAll.push(text);
                mdPartsAll.push(v);
            },
            progress: (v) => (progress.push(String(v)), renderedAll.push(String(v)), progressAll.push(String(v))),
            anchor: (uri, title) => anchors.push({ uri, title }),
            button: (b) => buttons.push(b),
            reference: (uri) => refs.push(uri.fsPath ?? String(uri))
        },
        token
    };
}

// v184: what the REAL host does with a participant's stream, read from
// microsoft/vscode main@75f204b. stream() above keeps every chunk and runs every
// task — which is how v182/v183 shipped a spinner that outlives Stop and writes
// that throw after it. This one models:
//  - extHostChatAgents2.ts: a frozen object literal whose methods use `this`
//    (anchor() is `this.push(…)`); send() batches per microtask; a task's rows
//    and result go out only after its header's batch is acknowledged; the turn
//    is raced against Stop + 1000ms (raceCancellationWithTimeout), then the
//    stream is closed and every later call THROWS;
//  - chatServiceImpl.ts: once the request's token is cancelled, every chunk is
//    dropped (progressCallback); mainThreadChatAgents2.ts: chunks after the
//    request finished are dropped ("No pending progress");
//  - chatModel.ts cancel() settles tool invocations, not tasks, and
//    chatTaskContentPart.ts keeps a task part while its settledness is
//    unchanged: a task with no rows that never settles spins for good.
function hostStream() {
    const main = { parts: [], tasks: [], cancelled: false, pending: true, droppedAfterCancel: 0, droppedAfterEnd: 0 };
    const stats = { writesAfterCancel: 0, throwsAfterClose: 0 };
    let closed = false;
    let cancelledAt;
    const accept = (chunk, handle) => {
        if (!main.pending) return void main.droppedAfterEnd++;
        if (main.cancelled) return void main.droppedAfterCancel++;
        if (chunk.kind === "progressTask") {
            main.tasks[handle] = { title: chunk.content, rows: [], settled: false, result: undefined };
            main.parts.push({ kind: "task", handle });
        } else if (chunk.kind === "taskRow") {
            if (main.tasks[handle]) main.tasks[handle].rows.push(chunk.row);
        } else if (chunk.kind === "taskResult") {
            if (main.tasks[handle]) Object.assign(main.tasks[handle], { settled: true, result: chunk.result });
        } else {
            main.parts.push(chunk);
        }
    };
    const queue = [];
    let notify = [];
    const send = (chunk, handle) => {
        if (queue.push(handle !== undefined ? [chunk, handle] : chunk) === 1) {
            queueMicrotask(() => {
                const toNotify = notify;
                notify = [];
                for (const item of queue.splice(0)) {
                    const [c, h] = Array.isArray(item) ? item : [item, undefined];
                    accept(c, h);
                }
                // The RPC reply (the "ack") comes back a macrotask later.
                setTimeout(() => toNotify.forEach((f) => f()), 2);
            });
        }
        return handle !== undefined ? new Promise((resolve) => notify.push(resolve)) : undefined;
    };
    let pool = 0;
    // A row with a file renders `cart.js  #read` (chatReferencesContentPart.ts, 1.139).
    const rowText = (p) =>
        (p && p.value && (p.value.value && p.value.value.fsPath ? `${path.basename(p.value.value.fsPath)} #${p.value.variableName}` : p.value.variableName ?? String(p.value))) || String(p);
    const check = () => {
        if (main.cancelled) stats.writesAfterCancel++;
        if (closed) {
            stats.throwsAfterClose++;
            throw new Error("Response stream has been closed");
        }
    };
    const report = (dto, task) => {
        if (!task) return void send(dto);
        const handle = pool++;
        const acked = send({ kind: "progressTask", content: dto.content }, handle);
        const reporter = { report: (p) => void acked.then(() => send({ kind: "taskRow", row: rowText(p) }, handle)) };
        Promise.all([acked, task(reporter)]).then(([, res]) => send({ kind: "taskResult", result: res }, handle));
    };
    const response = Object.freeze({
        markdown(value) {
            check();
            report({ kind: "markdownContent", content: typeof value === "string" ? value : value.value, supportHtml: Boolean(value && value.supportHtml) });
            return this;
        },
        progress(value, task) {
            check();
            report({ kind: task ? "progressTask" : "progressMessage", content: String(value) }, task);
            return this;
        },
        button(value) {
            check();
            report({ kind: "command", command: value });
            return this;
        },
        reference(value) {
            check();
            report({ kind: "reference", reference: value });
            return this;
        },
        anchor(value, title) {
            return this.push({ kind: "inlineReference", value, title });
        },
        push(part) {
            check();
            report(part);
            return this;
        }
    });
    const listeners = [];
    const token = {
        isCancellationRequested: false,
        onCancellationRequested(cb) {
            if (token.isCancellationRequested) {
                const h = setTimeout(cb, 0);
                return { dispose: () => clearTimeout(h) };
            }
            listeners.push(cb);
            return { dispose: () => void (listeners.includes(cb) && listeners.splice(listeners.indexOf(cb), 1)) };
        }
    };
    const cancel = () => {
        cancelledAt = Date.now();
        main.cancelled = true;
        token.isCancellationRequested = true;
        for (const cb of listeners.splice(0)) cb();
    };
    const close = () => {
        closed = true;
        main.pending = false;
    };
    const invoke = async (handler) => {
        let doneAt;
        const task = Promise.resolve()
            .then(() => handler(response, token))
            .finally(() => (doneAt = Date.now()));
        task.catch(() => undefined);
        const result = await new Promise((resolve) => {
            const ref = token.onCancellationRequested(async () => {
                ref.dispose();
                await new Promise((r) => setTimeout(r, 1000));
                resolve(undefined);
            });
            task.then(resolve, () => resolve(undefined)).finally(() => ref.dispose());
        });
        close();
        return { result, handlerTask: task, timing: () => ({ handlerAfterCancelMs: cancelledAt && doneAt ? doneAt - cancelledAt : undefined }) };
    };
    const spinning = () => main.tasks.filter((t) => t && !t.settled && t.rows.length === 0);
    const lines = () => main.parts.filter((p) => p.kind === "progressMessage").map((p) => p.content);
    return { response, token, cancel, close, invoke, main, stats, spinning, lines };
}
const waitFor = async (pred, ms = 5000) => {
    const t = Date.now();
    while (!pred() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 20));
    return pred();
};

function lastEnv(name) {
    const file = path.join(work, name + ".env");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}
const samePath = (a, b) => {
    try {
        return Boolean(a && b) && fs.realpathSync(a) === fs.realpathSync(b);
    } catch {
        return false;
    }
};

function lastArgv(name) {
    const file = path.join(work, name + ".argv");
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

// v164 (B3): `contributes.configuration` is an array of titled groups. Several
// checks still want the flat property map (default drift, shipped-defaults), so
// this folds the groups back together. It doubles as the B3 union check: any key
// in two groups, or missing the pragma, is caught here.
function collectConfigProperties(configuration) {
    if (!configuration) {
        return {};
    }
    // Pre-v164 single-object form.
    if (!Array.isArray(configuration)) {
        return configuration.properties || {};
    }
    const out = {};
    const seen = new Set();
    for (const group of configuration) {
        if (!group || typeof group.title !== "string" || !group.properties) {
            throw new Error("B3 configuration group missing a title or properties");
        }
        for (const key of Object.keys(group.properties)) {
            if (seen.has(key)) {
                throw new Error(`B3 configuration key in two groups: ${key}`);
            }
            seen.add(key);
            out[key] = group.properties[key];
        }
    }
    return out;
}

(async () => {
    const checks = [];
    const add = (name, ok) => checks.push([name, ok]);

    const a = stream();
    await global.__handler({ prompt: "Why does login redirect loop?" }, {}, a.response, a.token);
    const chat = a.chatMarkdown.join("");

    add("A chat has no <details>", !/<details>/i.test(chat));
    add("A chat contains answer", chat.includes("stale cookie"));
    add("A chat answer leads", chat.trimStart().startsWith("The redirect loop"));
    add("A chat has no mermaid", !chat.includes("```mermaid"));
    add("A chat hides raw thought", !chat.includes("Thinking about the redirect bug"));
    add("A a turn writes nothing into the workspace", !fs.existsSync(path.join(work, "sessions")));

    settings.executable = partial;
    memento.clear();
    const b = stream();
    const promptB = "check current branch difs with dev-newplat";
    await global.__handler({ prompt: promptB }, {}, b.response, b.token);
    const chatB = b.chatMarkdown.join("");

    add("B does not use prompt as the only answer", !/^check current branch difs with dev-newplat\s*$/m.test(chatB.trim()));

    // C: argv injection / punctuation
    settings.executable = happy;
    memento.clear();
    // `%` is excluded: a .cmd shim must go through cmd.exe, which expands %VAR%
    // before quotes are parsed and offers no command-line escape. Real installs
    // resolve to opencode.exe (no cmd.exe, exact argv) — see preferNonCmdSibling.
    const dirty = 'compare A & B | foo > bar < baz ^ (x) "quoted"';
    const c = stream();
    await global.__handler({ prompt: dirty }, {}, c.response, c.token);
    const argv = lastArgv("fake-ok.js");
    add("C metacharacters reach fake argv", argv[argv.length - 1] === dirty);
    add("C no injection side-effect file", !fs.existsSync(marker));

    memento.clear();
    const cPct = stream();
    await global.__handler({ prompt: "what does %PATH% mean" }, {}, cPct.response, cPct.token);
    add("C percent prompt still answers", cPct.chatMarkdown.join("").includes("stale cookie"));

    writeFake("ocb-fake", [
        { type: "text", sessionID: "ses_bare", part: { text: "bare-ok" } },
        { type: "step_finish", sessionID: "ses_bare", part: { reason: "stop", cost: 0.001, tokens: { input: 1, output: 1, reasoning: 0, total: 2, cache: { read: 0, write: 0 } } } }
    ]);
    process.env.PATH = work + path.delimiter + process.env.PATH;
    ext.__test && ext.__test.resolveExecutable && ext.__test.resolveExecutable("ocb-fake");
    settings.executable = "ocb-fake";
    memento.clear();
    const c2 = stream();
    // NOT a relaxed assertion: this check is about resolving a bare executable
    // name on PATH, and its prompt was incidental. "ping" now routes to the
    // connectivity command, so the prompt is changed to a real task and the new
    // behaviour gets its own check below.
    await global.__handler({ prompt: "resolve a bare executable name" }, {}, c2.response, c2.token);
    add("C bare executable name launches", c2.chatMarkdown.join("").includes("bare-ok"));

    // D: only last in-flight step is timeout
    settings.executable = inflight;
    // Long enough for node to boot and emit both tool events on Windows, short
    // enough to cap while the fake is still holding the process open.
    settings.timeoutMs = 2000;
    memento.clear();
    const d = stream();
    await global.__handler({ prompt: "diff please" }, {}, d.response, d.token);
    const chatD = d.chatMarkdown.join("");
    add("D a capped run still answers instead of going silent", chatD.trim().length > 0);

    // E: the context warning went out with the nerd surface; a fat run must
    // still answer normally.
    settings.timeoutMs = 30000;
    settings.executable = fat;
    memento.clear();
    const e = stream();
    await global.__handler({ prompt: "show the diff" }, {}, e.response, e.token);
    add("E a run with a 300 KB tool output still shows its answer", e.chatMarkdown.join("").includes("Diff is large."));

    settings.executable = happy;
    memento.clear();
    const e2 = stream();
    await global.__handler({ prompt: "Why does login redirect loop?" }, {}, e2.response, e2.token);
    add("E small tool output does not warn", !e2.chatMarkdown.join("").includes(M.warn));

    // F: id-less parts, second shorter
    const emitted = new Map();
    const cursor = { n: 0, last: {} };
    const d1 = ext.__test.emitKeyedDelta("t", "Hello world from part one", {}, emitted, cursor);
    const d2 = ext.__test.emitKeyedDelta("t", "Hi", {}, emitted, cursor);
    add("F two id-less text parts both appear once", d1 === "Hello world from part one" && d2 === "Hi");
    const d1b = ext.__test.emitKeyedDelta("t", "Hello world from part one", {}, emitted, cursor, 1);
    add("F replay does not re-emit", d1b === undefined);

    // H: an unreachable `opencode serve` must fall back to the CLI, not lose the turn
    settings.executable = happy;
    settings.transport = "server";
    settings.serverPort = 45999;
    settings.serverStartupPollMs = 20;
    memento.clear();
    const h = stream();
    await global.__handler({ prompt: "Why does login redirect loop?" }, {}, h.response, h.token);
    const chatH = h.chatMarkdown.join("");
    add("H server transport falls back to cli", chatH.includes("stale cookie"));
    add("H fallback does not duplicate the answer", chatH.split("stale cookie").length === 2);
    settings.transport = "cli";

    // ==================== v13 ====================

    // I: registered slash commands arrive as request.command with an EMPTY prompt.
    // v12 would have fallen through to the "describe the task" message.
    settings.executable = happy;
    settings.transport = "cli";
    settings.timeoutMs = 30000;
    memento.clear();
    const i1 = stream();
    await global.__handler({ prompt: "", command: "help" }, {}, i1.response, i1.token);
    const helpChat = i1.chatMarkdown.join("");
    add("I /help command renders the table", /\/dev <task>/.test(helpChat) && /\| Command \|/.test(helpChat));
    const iPkg = require(path.join(__dirname, "..", "package.json"));
    const iMissing = iPkg.contributes.chatParticipants[0].commands.map((c) => c.name).filter((n) => n !== "help" && !helpChat.includes("`/" + n));
    add(`I /help names every panel command${iMissing.length ? ` (missing: ${iMissing.join(", ")})` : ""}`, iMissing.length === 0);
    add("I /help says one session per chat, as sessionScope defaults", /one ongoing session per chat\b/.test(helpChat) && !/per workspace/.test(helpChat));

    const i2 = stream();
    await global.__handler({ prompt: "", command: "new" }, {}, i2.response, i2.token);
    add("I /new command starts a fresh session", i2.chatMarkdown.join("").includes("fresh OpenCode session"));

    const i3 = stream();
    await global.__handler({ prompt: "", command: "model" }, {}, i3.response, i3.token);
    add(
        "I /model command reports the chain",
        /No model pinned — OpenCode picks: a new session starts on .+, and a session keeps the model it last ran on\.|Model chain/.test(i3.chatMarkdown.join("")) &&
        i3.buttons.some((b) => b.command === "opencodeCopilotBridge.setModel")
    );

    // /dev must reach the editing agent (no --agent plan), the same as `dev:`.
    memento.clear();
    const i4 = stream();
    await global.__handler({ prompt: "add a test", command: "dev" }, {}, i4.response, i4.token);
    const argvDev = lastArgv("fake-ok.js");
    add("I /dev command uses the editing agent", !argvDev.includes("plan") && argvDev.includes("add a test"));
    // v176: the editing agent must be NAMED. With no --agent, `opencode run
    // --session` kept the session's last agent, so /dev after plan stayed plan.
    add(
        "I /dev names the editing agent explicitly",
        argvDev[argvDev.indexOf("--agent") + 1] === "build" && argvDev.indexOf("--agent") >= 0
    );

    // A typed /new (unregistered host, or muscle memory) must still work.
    memento.clear();
    const i5 = stream();
    await global.__handler({ prompt: "/new" }, {}, i5.response, i5.token);
    add("I typed /new still works", i5.chatMarkdown.join("").includes("fresh OpenCode session"));

    // J: attached files become a context block AND clickable references.
    memento.clear();
    const attached = path.join(work, "src", "login.ts");
    fs.mkdirSync(path.dirname(attached), { recursive: true });
    fs.writeFileSync(attached, "export const login = () => {};\n");
    const j = stream();
    await global.__handler(
        {
            prompt: "explain this file",
            references: [{ id: "vscode.file", value: { fsPath: attached, scheme: "file" } }]
        },
        {},
        j.response,
        j.token
    );
    const argvJ = lastArgv("fake-ok.js");
    const sentJ = argvJ[argvJ.length - 1] || "";
    add("J attachment reaches the prompt as context", /Files the user attached:/.test(sentJ) && sentJ.includes("src/login.ts"));
    add("J the task leads, context trails", sentJ.trimStart().startsWith("explain this file") && /\(Context only\./.test(sentJ));
    add("J attachment is emitted as a chat reference", j.refs.some((r) => r === attached));
    add("J tool file paths are emitted as references", j.refs.some((r) => /login\.ts$/.test(r)));

    // Opt-out must be honoured.
    settings.includeChatReferences = false;
    memento.clear();
    const j2 = stream();
    await global.__handler(
        { prompt: "explain this file", references: [{ id: "vscode.file", value: { fsPath: attached, scheme: "file" } }] },
        {},
        j2.response,
        j2.token
    );
    const sentJ2 = (lastArgv("fake-ok.js").slice(-1)[0]) || "";
    add("J includeChatReferences=false sends no context block", !/Files the user attached:/.test(sentJ2));
    settings.includeChatReferences = true;

    // J: a /parallel turn hands the attachment to every lane. 0.0.195 built the
    // context after the parallel branch had returned, so `#file:` reached no lane.
    {
        const jpLog = path.join(work, "fake-jp.argvs");
        const jpFake = writeFake(
            "fake-jp.js",
            [{ type: "text", sessionID: "ses_jp", part: { text: "lane ok" } }],
            `fs.appendFileSync(${JSON.stringify(jpLog)}, JSON.stringify(process.argv) + "\\n");\n`
        );
        const jpRun = async (prompt) => {
            settings.executable = jpFake;
            settings.transport = "cli";
            fs.rmSync(jpLog, { force: true });
            memento.clear();
            const st = stream();
            await global.__handler(
                { prompt, command: "parallel", references: [{ id: "vscode.file", value: { fsPath: attached, scheme: "file" } }] },
                {},
                st.response,
                st.token
            );
            const runs = fs.existsSync(jpLog) ? fs.readFileSync(jpLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
            return { runs, st, text: st.chatMarkdown.join("") };
        };
        const jp = await jpRun("review auth | list deps");
        const jpTasks = jp.runs.map((a) => a[a.length - 1]);
        add(
            "J every /parallel lane gets the attachment, its own task leading",
            jpTasks.length === 2 && jpTasks.every((t) => /Files the user attached:/.test(t) && t.includes("src/login.ts")) &&
                jpTasks.some((t) => t.startsWith("review auth")) && jpTasks.some((t) => t.startsWith("list deps"))
        );
        add("J a /parallel attachment is a chat reference, and no lane title carries the context block", jp.st.refs.some((r) => r === attached) && !/### \d\. [^\n]*Files the user attached/.test(jp.text));
        settings.includeChatReferences = false;
        const jpOff = await jpRun("review auth | list deps");
        add("J includeChatReferences=false keeps /parallel lanes bare", jpOff.runs.length === 2 && jpOff.runs.every((a) => !/Files the user attached:/.test(a[a.length - 1])));
        settings.includeChatReferences = true;
        settings.executable = happy;
    }

    // K: heartbeat keeps the progress line alive with an elapsed readout.
    add(
        "K progress line carries elapsed / cap",
        j.progress.some((p) => /\d+s \/ \d+s$/.test(p))
    );

    // L: two turns, and nothing lands on disk.
    memento.clear();
    const l1 = stream();
    await global.__handler({ prompt: "first question" }, {}, l1.response, l1.token);
    const l2 = stream();
    await global.__handler({ prompt: "second question" }, {}, l2.response, l2.token);
    add("L two turns write nothing into the workspace", !fs.existsSync(path.join(work, "sessions")));

    // M: cumulative session totals.
    const totalsChat = (() => {
        const st = stream();
        return global.__handler({ prompt: "", command: "session" }, {}, st.response, st.token).then(() => st);
    });
    const m = await totalsChat();
    add("M /session reports cumulative totals", /2 turn\(s\)/.test(m.chatMarkdown.join("")) && /tokens/.test(m.chatMarkdown.join("")));

    // O: Stop. VS Code drops every chunk a participant sends after Stop
    // (chatServiceImpl.ts progressCallback). v176–v183 wrote "Stopped after…"
    // here and this stub kept it, so "O cancellation is reported" passed while
    // the line never showed. What is real: nothing is sent after Stop, and the
    // result says cancelled — that is what drives the Continue chip.
    settings.executable = inflight;
    settings.timeoutMs = 30000;
    memento.clear();
    const o = stream();
    const oRun = global.__handler({ prompt: "long job" }, {}, o.response, o.token);
    setTimeout(() => o.token.cancel(), 700);
    const oRes = await oRun;
    const chatO = o.chatMarkdown.join("");
    add("O nothing is sent after Stop, and the result says cancelled", !/Stopped after|returned no output/.test(plain(chatO)) && oRes.metadata.cancelled === true);
    add("O cancellation is not called a timeout", !/timed out \(partial\)/.test(chatO) && !oRes.metadata.timedOut);
    settings.executable = happy;
    settings.timeoutMs = 30000;

    // P: follow-up chips were removed in the cleanup; there is no provider.

    // Q: retry affordance on a dead end.
    settings.executable = inflight;
    settings.timeoutMs = 1200;
    settings.fallbackModels = [];
    memento.clear();
    const q = stream();
    await global.__handler({ prompt: "will time out" }, {}, q.response, q.token);
    // v180: Retry moved to a follow-up chip (one action, one channel — FU).
    add("Q timeout offers no retry BUTTON", !q.buttons.some((b) => b.command === "opencodeCopilotBridge.retryLast"));
    add("Q timeout offers the debug log", q.buttons.some((b) => b.command === "opencodeCopilotBridge.showLog"));
    settings.executable = happy;
    settings.timeoutMs = 30000;

    // R: pure unit checks.
    add("R toolFilePath reads the common keys", ext.__test.toolFilePath({ filePath: "a.ts" }) === "a.ts" &&
        ext.__test.toolFilePath({ file_path: "b.ts" }) === "b.ts" &&
        ext.__test.toolFilePath({ pattern: "x" }) === undefined);
    add("R toolFilePath rejects multiline junk", ext.__test.toolFilePath({ path: "a\nb" }) === undefined);
    add(
        "R parseChatPrompt still honours inline prefixes",
        ext.__test.parseChatPrompt("dev: model:acme/x do it").kind === "dev" &&
        ext.__test.parseChatPrompt("dev: model:acme/x do it").model === "acme/x"
    );

    // ==================== v14 ====================

    // S: Copilot's own instruction-file references must never become context.
    // This is the bug that printed a raw <workspace-context> block into chat.
    settings.executable = happy;
    settings.chatDensity = "full";
    memento.clear();
    const instr = path.join(work, ".github", "copilot-instructions.md");
    fs.mkdirSync(path.dirname(instr), { recursive: true });
    fs.writeFileSync(instr, "# house rules\n");
    const agentsMd = path.join(work, "AGENTS.md");
    fs.writeFileSync(agentsMd, "# agents\n");
    const sInstr = stream();
    await global.__handler(
        {
            prompt: "what are the risks?",
            references: [
                { id: "copilot.instructions", value: { fsPath: instr, scheme: "file" } },
                { id: "vscode.file", value: { fsPath: agentsMd, scheme: "file" } },
                { id: "copilot.instructions", value: "<instructions>Here is a list of instruction files that contain rules for working with this codebase…</instructions>" }
            ]
        },
        {},
        sInstr.response,
        sInstr.token
    );
    const sentS = (lastArgv("fake-ok.js").slice(-1)[0]) || "";
    add("S instruction-file references are not resent", !/copilot-instructions|AGENTS\.md/.test(sentS));
    add("S string-valued references are dropped", !/<instructions>/.test(sentS));
    add("S no context block when nothing real was attached", !/Files the user attached:/.test(sentS));
    add("S instruction files are not shown as chat references", !sInstr.refs.some((r) => /AGENTS\.md|copilot-instructions/.test(r)));

    // T: a model that echoes the context block anyway must not leak it into chat.
    const leak = writeFake("fake-leak.js", [
        {
            type: "text",
            sessionID: "ses_leak",
            part: { text: "<workspace-context>\nFiles the user attached:\n- a.ts\n</workspace-context>\n\nThe real answer is 42." }
        },
        { type: "step_finish", sessionID: "ses_leak", part: { reason: "stop", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, total: 2, cache: { read: 0, write: 0 } } } }
    ]);
    settings.executable = leak;
    memento.clear();
    const t1 = stream();
    await global.__handler({ prompt: "leak test" }, {}, t1.response, t1.token);
    const chatT = t1.chatMarkdown.join("");
    add("T leaked context block is scrubbed from chat", !/workspace-context/.test(chatT));
    add("T the real answer survives scrubbing", chatT.includes("The real answer is 42"));
    settings.executable = happy;

    // U: chat is answer-only — the density branches and their setting are gone.
    memento.clear();
    const u1 = stream();
    await global.__handler({ prompt: "Why does login redirect loop?" }, {}, u1.response, u1.token);
    const chatU = u1.chatMarkdown.join("");
    add("U compact drops the numbered Working list", !chatU.includes("**Working**"));
    add("U compact keeps the answer", chatU.includes("stale cookie"));

    memento.clear();
    const u2 = stream();
    await global.__handler({ prompt: "Why does login redirect loop?" }, {}, u2.response, u2.token);
    const chatU2 = u2.chatMarkdown.join("");
    add("U minimal prints answer only", chatU2.includes("stale cookie") && !chatU2.includes("**Working**") && !/🤓/.test(chatU2));

    // V: follow-up labels — removed with the follow-up provider.

    // W: the workspace stays clean. Nothing is written into it at all.
    add("W no session directory is created at all", !fs.existsSync(path.join(work, "sessions")));
    add("W root .gitignore is never touched", !fs.existsSync(path.join(work, ".gitignore")));

    // X: parallel lanes.
    add("X lanes split on the pipe", ext.__test.splitLanes("a | b | c").length === 3);
    add("X a single lane is rejected upstream", ext.__test.splitLanes("just one").length === 1);
    settings.executable = happy;
    memento.clear();
    const x1 = stream();
    await global.__handler({ prompt: "", command: "parallel" }, {}, x1.response, x1.token);
    // v190: a bare /parallel opens the composer; dismissed, it says how to type lanes.
    add("X /parallel with no lanes opens the composer; dismissed, it explains itself", quickPicksShown.length === 1 && /No lanes composed/.test(x1.chatMarkdown.join("")) && /`\|`, `;;` or a `---` line/.test(x1.chatMarkdown.join("")));
    const x1b = stream();
    const x1bResult = await global.__handler({ prompt: "just one lane", command: "parallel" }, {}, x1b.response, x1b.token);
    const x1bChips = global.__participant.followupProvider.provideFollowups(x1bResult, {}, stream().token);
    add("X one lane explains itself and offers the composer as a chip", /at least two lanes/.test(x1b.chatMarkdown.join("")) && x1b.buttons.length === 0 && x1bChips.some((c) => c.command === "parallel" && c.prompt === ""));

    memento.clear();
    const x2 = stream();
    await global.__handler({ prompt: "audit errors | list dead deps", command: "parallel" }, {}, x2.response, x2.token);
    const chatX = x2.chatMarkdown.join("");
    add("X two lanes both report", /### 1\. audit errors/.test(chatX) && /### 2\. list dead deps/.test(chatX));
    add("X parallel announces the lane count", /Running \*\*2 lanes\*\*/.test(chatX));
    add("X parallel compares wall clock to sequential", /vs .* sequential/.test(chatX));
    add("X parallel defaults to the read-only plan agent", /read-only plan agent/.test(chatX));

    // v187: no lane cap (parallelMaxLanes removed) — every lane written runs.
    memento.clear();
    const x3 = stream();
    await global.__handler({ prompt: "a | b | c | d | e | f | g", command: "parallel" }, {}, x3.response, x3.token);
    const x3Chat = x3.chatMarkdown.join("");
    add("X no lane cap: seven lanes, seven reports, nothing dropped", /Running \*\*7 lanes\*\*/.test(x3Chat) && /### 7\. g/.test(x3Chat) && !/cap were dropped/.test(x3Chat));

    // A lane that carries an error event must render that error in the lane and
    // NOT be tagged as the timeout/partial case (the two are different causes).
    settings.executable = writeFake("fake-laneerr.js", [
        { type: "error", sessionID: "ses_le", part: { message: "gateway refused connection" } }
    ]);
    memento.clear();
    const x4 = stream();
    await global.__handler({ prompt: "boom | also boom", command: "parallel" }, {}, x4.response, x4.token);
    const chatX4 = x4.chatMarkdown.join("");
    add("X an errored lane surfaces its error message", /gateway refused connection/.test(chatX4));
    add("X an errored lane is not tagged as a timeout", !chatX4.includes(`${M.quiet} partial`));
    settings.executable = happy;

    add("X par: prefix maps to parallel", ext.__test.parseChatPrompt("par: a | b").kind === "parallel");
    add("X parallel: prefix maps to parallel", ext.__test.parseChatPrompt("parallel: a | b").kind === "parallel");

    // ==================== v14.5 ====================

    // Z: model catalog parsing and tiering.
    const parsed = ext.__test.parseModelList(
        [
            "Available models:",            // banner — no slash
            "  acme-gateway/Oasis",
            "- anthropic/claude-sonnet-5",
            "anthropic/claude-sonnet-5",    // duplicate
            "",
            "not a model id",
            "opencode/gpt-5.6-luna"
        ].join("\n")
    );
    add("Z catalog parser keeps only provider/id lines", parsed.length === 3 && parsed[0] === "acme-gateway/Oasis");
    add("Z catalog parser dedupes", new Set(parsed).size === parsed.length);
    add("Z catalog parser strips list bullets", parsed.includes("anthropic/claude-sonnet-5"));

    // Tier 1: live. The happy fake prints JSON events, not model ids, so use a
    // dedicated fake that behaves like `opencode models`.
    const modelsFake = writeFake("fake-models.js", []);
    fs.appendFileSync(
        modelsFake.replace(/\.cmd$/, ""),
        "process.stdout.write('acme/one\\nacme/two\\n');\n"
    );
    globalMemento.clear();
    const live = await ext.__test.getModelCatalog(modelsFake, work);
    add("Z tier 1 fetches live", live.source === "live" && live.models.length === 2);

    // Tier 2: cached — a broken executable must not lose the list.
    const cached = await ext.__test.getModelCatalog("definitely-not-a-real-binary", work);
    add("Z tier 2 serves the cache when the CLI is gone", cached.source === "cached" && cached.models.length === 2);

    // Tier 3: stale — past the TTL, still served, but labelled.
    settings.modelCatalogTtlMinutes = 0;
    const stale = await ext.__test.getModelCatalog("definitely-not-a-real-binary", work);
    add("Z tier 3 serves a stale catalog rather than nothing", stale.source === "stale" && stale.models.length === 2);
    settings.modelCatalogTtlMinutes = 360;

    // Tier 4: configured — no cache at all, fall back to the user's own settings.
    globalMemento.clear();
    settings.model = "acme/pinned";
    settings.fallbackModels = ["acme/backup"];
    const configured = await ext.__test.getModelCatalog("definitely-not-a-real-binary", work);
    add(
        "Z tier 4 falls back to configured models",
        configured.source === "configured" && configured.models.join() === "acme/pinned,acme/backup"
    );
    settings.model = "";
    settings.fallbackModels = [];
    globalMemento.clear();
    const empty = await ext.__test.getModelCatalog("definitely-not-a-real-binary", work);
    add("Z with nothing anywhere the catalog is empty, not invented", empty.source === "empty" && empty.models.length === 0);

    // ==================== v14.6 (VS Code 1.136 parity) ====================

    // AA: multi-root resolution. Every folder lookup used to be workspaceFolders[0],
    // so in a multi-root workspace the bridge silently ran against the wrong project.
    const rootA = { uri: { fsPath: work, scheme: "file" }, name: "root-a", index: 0 };
    const otherRoot = path.join(work, "..", "ocb-root-b");
    fs.mkdirSync(otherRoot, { recursive: true });
    const rootB = { uri: { fsPath: otherRoot, scheme: "file" }, name: "root-b", index: 1 };

    vscodeStub.workspace.workspaceFolders = [rootA];
    add("AA single root resolves as only-root", ext.__test.resolveFolder().reason === "only-root");

    vscodeStub.workspace.workspaceFolders = [rootA, rootB];
    memento.clear();
    add("AA multi-root with no signal at all falls back to the first root", ext.__test.resolveFolder().reason === "first-root");
    memento.set("opencode.lastFolder", otherRoot);
    const remembered = ext.__test.resolveFolder();
    add("AA the last folder used here is remembered", remembered.reason === "remembered" && remembered.folder.name === "root-b");
    memento.clear();

    const attachedInB = { fsPath: path.join(otherRoot, "svc.ts"), scheme: "file" };
    const byAttachment = ext.__test.resolveFolder({ references: [{ id: "vscode.file", value: attachedInB }] });
    add(
        "AA an attachment picks its own root",
        byAttachment.reason === "attachment" && byAttachment.folder.name === "root-b"
    );

    vscodeStub.window.activeTextEditor = { document: { uri: { fsPath: path.join(otherRoot, "open.ts"), scheme: "file" } } };
    const byEditor = ext.__test.resolveFolder();
    add("AA the active editor picks its root", byEditor.reason === "active-editor" && byEditor.folder.name === "root-b");
    add("AA an attachment outranks the active editor", ext.__test.resolveFolder({ references: [{ id: "f", value: { fsPath: path.join(work, "x.ts"), scheme: "file" } }] }).folder.name === "root-a");
    vscodeStub.window.activeTextEditor = undefined;

    // A turn in a multi-root workspace must say which root it used.
    settings.executable = happy;
    settings.chatDensity = "full";
    memento.clear();
    const aa = stream();
    await global.__handler({ prompt: "which root?" }, {}, aa.response, aa.token);
    add("AA the reply names the chosen root", plain(aa.chatMarkdown.join("")).includes(`${M.folder} \`root-a\``));

    // ...and must NOT add that noise when there is only one root.
    vscodeStub.workspace.workspaceFolders = [rootA];
    memento.clear();
    const aa2 = stream();
    await global.__handler({ prompt: "single root" }, {}, aa2.response, aa2.token);
    add("AA single root adds no folder banner", !aa2.chatMarkdown.join("").includes(M.folder));

// AB: completion notifications mirror chat.notifyWindowOnResponseReceived.
    const notes = [];
    const errorNotes = [];
    const realInfo = vscodeStub.window.showInformationMessage;
    const realError = vscodeStub.window.showErrorMessage;
    vscodeStub.window.showInformationMessage = (msg) => (notes.push(msg), Promise.resolve(undefined));
    vscodeStub.window.showErrorMessage = (msg) => (errorNotes.push(msg), Promise.resolve(undefined));
    const slow = { totalMs: 60000, timedOut: false, cancelled: false };
    const quick = { totalMs: 1000, timedOut: false, cancelled: false };

    vscodeStub.window.state.focused = true;
    ext.__test.notifyIfSlow(slow, "plan", work);
    add("AB a focused window is never interrupted", notes.length === 0);

    vscodeStub.window.state.focused = false;
    ext.__test.notifyIfSlow(quick, "plan", work);
    add("AB fast runs do not notify", notes.length === 0);

    ext.__test.notifyIfSlow(slow, "plan", work);
    add("AB a slow run in an unfocused window notifies", notes.length === 1 && /finished in 60\.0s/.test(notes[0]));

    ext.__test.notifyIfSlow({ totalMs: 60000, timedOut: false, cancelled: true }, "plan", work);
    add("AB cancelled runs are not announced", notes.length === 1);

    // v170: a timeout or error is news even to someone at the screen, so it
    // raises the ERROR notification with a Retry action — not the info banner
    // that is only meant to nudge someone who tabbed away and might have missed a
    // quiet "done".
    ext.__test.notifyIfSlow({ totalMs: 90000, timedOut: true, cancelled: false }, "dev", work);
    add(
        "AB a timeout raises an error notification with Retry",
        errorNotes.length === 1 && /timed out after 90\.0s/.test(errorNotes[0])
    );

    settings.notifyOnCompletion = false;
    ext.__test.notifyIfSlow({ totalMs: 90000, timedOut: true, cancelled: false }, "dev", work);
    add("AB failure notifications can be disabled", errorNotes.length === 1);
    settings.notifyOnCompletion = true;
    vscodeStub.window.state.focused = true;
    vscodeStub.window.showInformationMessage = realInfo;
    vscodeStub.window.showErrorMessage = realError;

    // AC: per-model usage rollup — removed with the usage subsystem.

    // AD: no session files are written, so there is no index.
    add("AD no session index is written", !fs.existsSync(path.join(work, "sessions", "index.md")));

    // ==================== v14.7 (review response) ====================

    // BA: session ids come from OpenCode's stdout, not from us. A traversal id
    // must never place a transcript, a .gitignore, or a briefing outside the repo.
    add("BA a normal id is untouched", ext.__test.safeSessionId("ses_7f3a-01.b") === "ses_7f3a-01.b");
    for (const evil of ["../../../etc/passwd", "..\\..\\win", "a/b", "..", ".", "x\u0000y", ""]) {
        const safe = ext.__test.safeSessionId(evil);
        add(
            `BA traversal id is neutralised: ${JSON.stringify(evil)}`,
            /^[A-Za-z0-9._-]{1,128}$/.test(safe) && safe !== ".." && safe !== "." && !safe.includes("/") && !safe.includes("\\")
        );
    }
    add("BA an over-long id is clamped", ext.__test.safeSessionId("z".repeat(500)).length === 128);
    // v179: the id is an argv value (`--session <id>`), so a flag-shaped id must
    // not survive as one.
    for (const flag of ["-x", "--model=evil/x", ".hidden"]) {
        const safe = ext.__test.safeSessionId(flag);
        add(`BA a flag-shaped id cannot start with - or .: ${JSON.stringify(flag)}`, /^[A-Za-z0-9_]/.test(safe));
    }

    // BB (v179): escapeHtml guarded the HTML briefing, which v165 removed along
    // with every other file the extension wrote. Nothing has rendered HTML since,
    // so the function was test-only weight. The tripwire is that it stays gone —
    // reintroducing HTML output must come back with its own escaping checks.
    add("BB escapeHtml is gone from the harness surface", ext.__test.escapeHtml === undefined);

    // BC: the health probe must be bounded. An open-but-silent port used to hang
    // ensureServer and diagnose forever.
    const net = require("node:net");
    const blackhole = net.createServer(() => { }); // accepts, never responds
    await new Promise((r) => blackhole.listen(0, "127.0.0.1", r));
    const bhPort = blackhole.address().port;
    const t0 = Date.now();
    let bounded = false;
    try {
        await ext.__test.httpGetJson(`http://127.0.0.1:${bhPort}/global/health`, 700);
    } catch {
        bounded = true;
    }
    const elapsed = Date.now() - t0;
    blackhole.close();
    add("BC a silent port rejects instead of hanging", bounded);
    add("BC the probe honours its timeout", elapsed >= 600 && elapsed < 4000);

    // BD: Windows shim parsing. Measured against a real file on disk, not asserted
    // in a comment — a probe wrote here, so this is what the parser actually does.
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-shim-"));
    const realExe = path.join(shimDir, "opencode-real.js");
    fs.writeFileSync(realExe, "// stand-in for the packaged binary\n");
    const shimCmd = path.join(shimDir, "opencode.cmd");
    fs.writeFileSync(shimCmd, `@echo off\r\n"%~dp0opencode-real.js" %*\r\n`);
    const parsedShim = ext.__test.readShimTarget(shimCmd);
    add("BD readShimTarget finds the forwarded target", !!parsedShim && parsedShim.target === realExe);
    add("BD %~dp0 expands to the shim's own directory", !!parsedShim && !/%/.test(parsedShim.target));

    // A shim pointing at another shim must be refused, not chained.
    const chained = path.join(shimDir, "chain.cmd");
    fs.writeFileSync(chained, `@echo off\r\n"%~dp0opencode.cmd" %*\r\n`);
    add("BD a shim that chains into another shim is refused", ext.__test.readShimTarget(chained) === undefined);

    // An unexpandable variable must fall back to cmd.exe rather than be guessed at.
    const varShim = path.join(shimDir, "varied.cmd");
    fs.writeFileSync(varShim, `@echo off\r\n"%SOME_UNKNOWN_ROOT%\\bin\\opencode" %*\r\n`);
    add("BD an unresolvable %VAR% is refused, not guessed", ext.__test.readShimTarget(varShim) === undefined);

    add("BD tokenizer keeps quoted spans intact", JSON.stringify(ext.__test.tokenizeCmdLine('"a b" c "d"')) === '["a b","c","d"]');
    add("BD expandShimVar rejects a leftover percent", /%/.test(ext.__test.expandShimVar("%NOPE%/x", shimDir)));

    // BE: default drift. Every config().get("k", DEFAULT) in the source must match
    // the default declared in package.json, or the docs lie about behaviour.
    // Every cluster is concatenated: a tripwire that only read extension.ts would
    // silently stop covering code the moment it moved into another module.
    const srcDir = path.join(__dirname, "..", "src");
    const srcText = fs
        .readdirSync(srcDir)
        .filter((f) => f.endsWith(".ts"))
        .sort()
        .map((f) => fs.readFileSync(path.join(srcDir, f), "utf8"))
        .join("\n");
    const packageJsonPath = path.join(__dirname, "..", "package.json");
    const packageJsonText = fs.readFileSync(packageJsonPath, "utf8");
    const packageJson = require(packageJsonPath);
    const declared = collectConfigProperties(packageJson.contributes.configuration);
    const manifestReads = new Set(
        [...packageJsonText.matchAll(/config\.opencodeCopilotBridge\.([\w]+)/g)]
            .map((match) => `opencodeCopilotBridge.${match[1]}`)
    );
    const drift = [];
    const seenKeys = new Set();
    const driftRe = /get<([^>]+)>\(\s*"([\w.]+)"\s*,\s*([^)]+?)\s*\)/g;
    let dm;
    while ((dm = driftRe.exec(srcText))) {
        const [, , key, rawDefault] = dm;
        const full = `opencodeCopilotBridge.${key}`;
        if (!(full in declared)) {
            drift.push(`${key}: read in code, not declared in package.json`);
            continue;
        }
        seenKeys.add(full);
        let codeDefault;
        try {
            codeDefault = JSON.parse(rawDefault.replace(/'/g, '"'));
        } catch {
            continue; // computed default (e.g. `?? []`), not comparable
        }
        const pkgDefault = declared[full].default;
        if (JSON.stringify(codeDefault) !== JSON.stringify(pkgDefault)) {
            drift.push(`${key}: code=${JSON.stringify(codeDefault)} package.json=${JSON.stringify(pkgDefault)}`);
        }
    }
    if (drift.length) {
        console.log("\n  default drift:\n    " + drift.join("\n    "));
    }
    add("BE no default drift between code and package.json", drift.length === 0);
    const undeclaredInStub = [...seenKeys]
        .map((k) => k.replace("opencodeCopilotBridge.", ""))
        .filter((k) => !(k in settings));
    if (undeclaredInStub.length) {
        console.log("\n  settings read in code but absent from the harness stub: " + undeclaredInStub.join(", "));
    }
    add("BE every setting read in code is exercised by the harness", undeclaredInStub.length === 0);
    const unread = Object.keys(declared).filter((k) => !seenKeys.has(k) && !manifestReads.has(k));
    if (unread.length) {
        console.log("\n  settings declared but not read by code: " + unread.join(", "));
    }
    add("BE every declared setting is read by code or the manifest", unread.length === 0);

    // BF: tripwires for behaviour that is already correct, so a future rewrite
    // cannot quietly undo it.
    add("BF no unsafe innerHTML anywhere in the source", !/innerHTML/.test(srcText));
    add("BF windows kill is process-tree wide", /taskkill[^\n]*\/T/.test(srcText));
    add("BF stdin is closed immediately after spawn", /stdin\??\.end\(\)/.test(srcText));
    // Every OpenCode process must go through spawnOpenCode: that is where shim
    // resolution, cmd.exe quoting, and prefixArgs live. The only other permitted
    // spawn is taskkill inside killTree, which takes no user text.
    const spawnLines = srcText
        .split("\n")
        .map((l, i) => [i + 1, l])
        .filter(([, l]) => /(?<!\w)spawn\(/.test(l));
    const strayCalls = spawnLines.filter(([, l]) => !/resolved\.command|"taskkill"/.test(l));
    add(
        "BF every OpenCode spawn goes through spawnOpenCode",
        strayCalls.length === 0 ||
        console.log("\n  stray spawn: " + strayCalls.map(([n]) => `line ${n}`).join(", ")) === undefined
    );
    add("BF taskkill is the only non-spawnOpenCode spawn", spawnLines.length === 3);
    add("BF status bar APIs stay optional-chained for the headless stub", /createStatusBarItem\?\./.test(srcText));

    // BF (v172): three crash-safety guards that no behavioural check can reach
    // from here — they need a socket to drop mid-body, a taskkill binary to be
    // missing, and a serve spawn to fail with EACCES. Until the harness can
    // stage those, pin the source so a rewrite cannot drop them silently. Each
    // one was an uncaught exception in the extension host, i.e. the whole
    // window, not just the turn.
    const resErrorHandlers = (srcText.match(/res\.on\("error"/g) || []).length;
    add("BF every http response stream has an error handler", resErrorHandlers >= 4);
    add(
        "BF the taskkill spawn cannot throw asynchronously",
        /const reaper = spawn\("taskkill"/.test(srcText) && /reaper\.on\("error"/.test(srcText)
    );
    add("BF the serve spawn has an error handler", /serveProcess\.on\("error"/.test(srcText));
    add(
        "BF a failed serve spawn reports its message, not a negated errno",
        /could not be started: \$\{serveSpawnError\}/.test(srcText)
    );
    add("BF metrics.stderr is bounded", /STDERR_CAP/.test(srcText) && /kept\.length < STDERR_CAP/.test(srcText));

    // BG: repo hygiene AGENTS.md states in prose and nothing measured. Asserted
    // against the bytes on disk, because .gitattributes governs checkout, not what
    // an editor writes — VS Code created .gitattributes itself as CRLF.
    const repoRoot = path.join(__dirname, "..");
    const readRepo = (f) => {
        const p = path.join(repoRoot, f);
        return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined;
    };
    const attributes = readRepo(".gitattributes");
    for (const f of [".vscodeignore", ".gitignore", ".gitattributes"]) {
        const raw = readRepo(f);
        add(`BG ${f} exists and is LF-only`, raw !== undefined && !raw.includes("\r"));
    }
    add(
        "BG .gitattributes pins the ignore files to LF",
        !!attributes && /\.vscodeignore\s+text\s+eol=lf/.test(attributes) && /\.gitignore\s+text\s+eol=lf/.test(attributes)
    );
    // v166: the same carriage-return trap, one directory over and shipped to users.
    // scripts/start-parallel-agents.sh went out in the .vsix with CRLF; measured on
    // Linux: `bash start-parallel-agents.sh --help` -> "set: pipefail\r: invalid
    // option name", exit 2, dead on line 2. .gitattributes `* text=auto` normalises
    // the blob but the working tree on Windows is CRLF and vsce packs the working
    // tree. Pin *.sh and read the bytes, same as the ignore files above.
    for (const f of fs.readdirSync(path.join(repoRoot, "scripts")).filter((n) => n.endsWith(".sh"))) {
        const raw = readRepo(path.join("scripts", f));
        add(`BG scripts/${f} is LF-only (CRLF breaks it under bash)`, raw !== undefined && !raw.includes("\r"));
    }
    add("BG .gitattributes pins *.sh to LF", !!attributes && /\*\.sh\s+text\s+eol=lf/.test(attributes));
    // 0.0.147 shipped without start-parallel-agents.* because scripts/** was globbed.
    add("BG .vscodeignore never globs scripts/**", !/^\s*scripts\/\*\*/m.test(readRepo(".vscodeignore") || "scripts/**"));
    // 0.0.149's idle cap was computed and discarded; strict does not imply this.
    add("BG noUnusedLocals is on", /"noUnusedLocals"\s*:\s*true/.test(readRepo("tsconfig.json") || ""));

    // ============ v148 (the "@opencode ping returns nothing" report) ============

    // CA: THE REPORTED BUG. A run that completes, prints non-JSON output, and
    // reports no events used to render as a COMPLETELY EMPTY chat reply while the
    // work had actually happened. Reproduce it: a fake that prints prose, not events.
    // The raw-stdout salvage is gone, so an unparsed run now reports as empty —
    // that is the accepted cost of dropping the safety net.
    const proseFake = writeFake(
        "fake-prose.js",
        [],
        "process.stdout.write('> plan \u00b7 Aspen\\n');\n" +
        "process.stdout.write('App.js defines the root router and mounts four providers.\\n');\n" +
        "process.stdout.write('It has 412 lines and imports 19 modules.\\n');\n"
    );
    settings.executable = proseFake;
    settings.chatDensity = "full";
    memento.clear();
    const ca = stream();
    await global.__handler({ prompt: "read App.js and Report" }, {}, ca.response, ca.token);
    const chatCA = ca.chatMarkdown.join("");
    add("CA an unparsed run is never a blank reply", chatCA.trim().length > 0);

    // CB: a truly empty run explains itself instead of rendering nothing.
    const silentFake = writeFake("fake-silent.js", [], "process.exit(3);\n");
    settings.executable = silentFake;
    memento.clear();
    const cb = stream();
    await global.__handler({ prompt: "this will produce nothing at all" }, {}, cb.response, cb.token);
    const chatCB = cb.chatMarkdown.join("");
    add("CB an empty run still says something", chatCB.trim().length > 0);
    add("CB its exit code goes to the debug log", logLines.some((l) => / exit code 3\b/.test(l)));

    // CC: a CLI error event must reach chat. Before v148 only the SSE path handled
    // session.error; on the CLI path it fell into `default:` and was dropped.
    const errFake = writeFake("fake-err.js", [
        { type: "session.error", sessionID: "ses_e", part: { message: "provider returned 401 Unauthorized" } }
    ]);
    settings.executable = errFake;
    memento.clear();
    const cc = stream();
    await global.__handler({ prompt: "trigger a provider error" }, {}, cc.response, cc.token);
    const chatCC = cc.chatMarkdown.join("");
    add("CC a CLI session.error reaches chat", /401 Unauthorized/.test(chatCC));

    // CD: usageKnown must not be flipped by an aborted step reporting cost 0 —
    // that is what made the bug report say "usageKnown: true, 0 tokens".
    const zeroFake = writeFake("fake-zero.js", [
        { type: "step_finish", sessionID: "ses_z", part: { reason: "abort", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } } } }
    ]);
    settings.executable = zeroFake;
    memento.clear();
    const cd = stream();
    await global.__handler({ prompt: "an aborted step with zero usage" }, {}, cd.response, cd.token);
    // v165: emptyRunDiagnosis is disabled, so the reply is the short no-output line.
    add("CD zero-cost zero-token steps do not claim usage is known", /returned no output|usage n\/a|no token usage|without producing/.test(cd.chatMarkdown.join("")));
    settings.executable = happy;

    // CE: /ping never calls a model.
    memento.clear();
    const ce = stream();
    await global.__handler({ prompt: "", command: "ping" }, {}, ce.response, ce.token);
    const chatCE = ce.chatMarkdown.join("");
    add("CE /ping reports reachability", /Bridge is reachable|cannot reach OpenCode/.test(chatCE));
    add("CE /ping states it cost nothing", /cost nothing/.test(chatCE));
    // v167: the row names whichever policy is actually armed. With the wall
    // clock off by default there is no "Ns cap" to print, and printing one
    // anyway was how the old message sent people to raise a setting that was
    // not involved in stopping their run.
    add("CE /ping shows the timeout policy in force", /wall.clock|idle/.test(chatCE));
    const savedCeTimeout = settings.timeoutMs;
    settings.timeoutMs = 0;
    const ceZero = stream();
    await global.__handler({ prompt: "", command: "ping" }, {}, ceZero.response, ceZero.token);
    add("CE /ping says so when no wall clock is armed", /no wall-clock cap/.test(ceZero.chatMarkdown.join("")));
    settings.timeoutMs = 180000;
    const ceCap = stream();
    await global.__handler({ prompt: "", command: "ping" }, {}, ceCap.response, ceCap.token);
    add("CE /ping names an explicit wall clock", /180s wall clock/.test(ceCap.chatMarkdown.join("")));
    settings.timeoutMs = savedCeTimeout;

    // CF: vague-prompt clarification, and the narrowness that the harness forced.
    add("CF a bare connectivity word is vague", ext.__test.isVaguePrompt("ping") && ext.__test.isVaguePrompt("hello"));
    add("CF a single bare word is vague", ext.__test.isVaguePrompt("stuff"));
    add(
        "CF two-word tasks are NOT vague",
        !ext.__test.isVaguePrompt("run tests") &&
        !ext.__test.isVaguePrompt("fix build") &&
        !ext.__test.isVaguePrompt("review PR")
    );
    add("CF a filename is not vague", !ext.__test.isVaguePrompt("App.js") && !ext.__test.isVaguePrompt("src/x"));
    memento.clear();
    const cf = stream();
    await global.__handler({ prompt: "ping" }, {}, cf.response, cf.token);
    add("CF a vague prompt is clarified, not run", /too short for me to act on/.test(cf.chatMarkdown.join("")));
    // v180: Run it anyway is a chip only — the body button duplicated it (FU).
    add("CF clarification offers no run-it-anyway BUTTON", cf.buttons.length === 0);
    const cf2 = stream();
    await global.__handler({ prompt: "ping" }, {}, cf2.response, cf2.token);
    add("CF sending the same prompt again runs it", !/too short for me to act on/.test(cf2.chatMarkdown.join("")));

    // CG: timeout policy.
    settings.timeoutMs = 180000;
    add("CG a positive timeoutMs is used verbatim", ext.__test.planTimeout().timeoutMs === settings.timeoutMs);
    const planT = ext.__test.planTimeout();
    add("CG the budget takes no agent or kind: an editing run gets the same cap as a read-only one", ext.__test.planTimeout.length === 0);
    add("CG idle cap is carried alongside the wall clock", planT.idleTimeoutMs === settings.idleTimeoutMs);

    // v167: the wall clock is opt-in. 0 means no cap at all, and the idle cap
    // is still carried so a hung run still dies.
    const savedCgTimeout = settings.timeoutMs;
    settings.timeoutMs = 0;
    settings.idleTimeoutMs = 90000;
    const zero = ext.__test.planTimeout();
    add("CG timeoutMs 0 means no wall-clock cap", zero.timeoutMs === 0);
    add("CG the idle cap survives a zero wall clock", zero.idleTimeoutMs === 90000);
    add(
        "CG the no-cap plan says so rather than naming a number",
        /no wall-clock cap/.test(ext.__test.planTimeout().reason)
    );
    settings.idleTimeoutMs = 0;
    settings.timeoutMs = savedCgTimeout;

    // CJ: the progress heartbeat must not inflate Copilot's "Completed N steps".
    settings.executable = inflight;
    settings.timeoutMs = 4000;
    settings.progressHeartbeatMs = 1000;
    memento.clear();
    const cj = stream();
    await global.__handler({ prompt: "a run long enough to tick several times" }, {}, cj.response, cj.token);
    add("CJ progress calls stay well below one per second", cj.progress.length < 8);
    add("CJ progress still reports elapsed against the cap", cj.progress.some((p) => /\d+s \/ \d+s/.test(p)));
    settings.progressHeartbeatMs = 0;
    settings.timeoutMs = 30000;
    settings.executable = happy;

    // CK: the idle cap must reach the runner, not just be computed.
    //
    // v0.0.148 had `const idleTimeoutMs = tPlan.idleTimeoutMs;` in the chat path
    // and never put it in runOpts, so `options.idleTimeoutMs ?? 0` disabled idle
    // detection on every run while `/ping` still advertised "90s idle". The CG
    // checks passed throughout, because they assert what planTimeout RETURNS
    // rather than what crossed the process boundary — an opinion, not an artifact.
    // The 0.0.151 drop kept the extension.ts fix but dropped these checks, which
    // left the fix unprotected; restored here.
    //
    // So measure the only thing that can tell the difference: wall time. A fake
    // that speaks once and then goes silent for a minute must be cut at the idle
    // cap (~2s), not held to the wall clock (30s). The two outcomes are an order
    // of magnitude apart, so this cannot pass by luck on a slow machine.
    const goesSilent = writeFake(
        "fake-goes-silent.js",
        [{ type: "tool_use", sessionID: "ses_idle", part: { tool: "bash", state: { input: { command: "python -c ..." }, output: "" } } }],
        "setTimeout(() => {}, 60000);\n"
    );
    settings.executable = goesSilent;
    settings.timeoutMs = 30000;
    settings.idleTimeoutMs = 2000;
    memento.clear();
    const ck = stream();
    const ckStart = Date.now();
    await global.__handler({ prompt: "run something that stops talking" }, {}, ck.response, ck.token);
    const ckElapsed = Date.now() - ckStart;
    add("CK a silent run is cut at the idle cap, not the wall clock", ckElapsed < 15000);
    // v165: the "⏱️ partial" footer is gone, so the fact that the run was cut now
    // reaches chat only through composeVisibleAnswer's idle sentence. Same fact,
    // different words — the assertion is widened, not weakened.
    add("CK the idle kill still reports a timeout to chat", /timed out|partial|went quiet/i.test(ck.chatMarkdown.join("") + ck.progress.join("")) || (ck.chatMarkdown.join("") + ck.progress.join("")).includes(M.quiet));

    // And with the idle cap off, the same fake must survive past it — otherwise
    // the check above would pass even if something else were killing the run.
    settings.idleTimeoutMs = 0;
    settings.timeoutMs = 6000;
    memento.clear();
    const ck2 = stream();
    const ck2Start = Date.now();
    await global.__handler({ prompt: "run something that stops talking" }, {}, ck2.response, ck2.token);
    const ck2Elapsed = Date.now() - ck2Start;
    add("CK idleTimeoutMs=0 disables idle detection", ck2Elapsed >= 5000);

    // Back to the suite defaults (line ~187) so later groups are unperturbed.
    settings.idleTimeoutMs = 0;
    settings.timeoutMs = 30000;
    settings.executable = happy;

    // ==================== v150 (plugin/hook awareness) ====================

    // DA: environment discovery. Written to a real temp tree, read back — the
    // whole point is to see what OpenCode sees, so a stub would prove nothing.
    //
    // discoverOpenCodeEnv() walks TWO roots: the project's .opencode and the
    // machine's global config dir. Left alone it therefore reads whatever the
    // developer happens to have installed, so "an empty workspace discovers
    // nothing" fails on any machine that actually runs OpenCode — measured here:
    // ~/.config/opencode/opencode.jsonc exists, so the count was 1, not 0. The
    // exact-count assertion below ("Plugins (2)") was passing only because that
    // particular file declares no plugins; one `plugin` entry added globally
    // would have broken it too. Point OPENCODE_CONFIG_DIR at a path that does
    // not exist so the global root is skipped and these checks measure the
    // project scope in isolation.
    const realConfigDir = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = path.join(os.tmpdir(), "ocb-env-absent-global");
    const envRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-env-"));
    fs.mkdirSync(path.join(envRoot, ".opencode", "command"), { recursive: true });
    fs.mkdirSync(path.join(envRoot, ".opencode", "skills", "trekoon"), { recursive: true });
    fs.mkdirSync(path.join(envRoot, ".opencode", "hook"), { recursive: true });
    fs.writeFileSync(path.join(envRoot, ".opencode", "command", "jira.md"), "---\ndescription: x\n---\n");
    fs.writeFileSync(path.join(envRoot, ".opencode", "command", "tfs-pr.md"), "---\ndescription: y\n---\n");
    fs.writeFileSync(path.join(envRoot, ".opencode", "skills", "trekoon", "SKILL.md"), "# trekoon\n");
    fs.writeFileSync(path.join(envRoot, ".opencode", "hook", "hooks.yaml"), "hooks: []\n");
    fs.writeFileSync(path.join(envRoot, "AGENTS.md"), "# agents\n");
    fs.writeFileSync(
        path.join(envRoot, "opencode.json"),
        JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            plugin: ["opencode-yaml-hooks", "@tarquinen/opencode-dcp"],
            mcp: { "jira-cloud": {}, "chrome-devtools": {} }
        })
    );
    const envItems = ext.__test.discoverOpenCodeEnv(envRoot);
    const kinds = (k) => envItems.filter((i) => i.kind === k).map((i) => i.name);
    add("DA finds the project opencode.json", kinds("config").includes("opencode.json"));
    add("DA lists declared plugins", kinds("plugin").includes("opencode-yaml-hooks") && kinds("plugin").includes("@tarquinen/opencode-dcp"));
    add("DA lists MCP servers", kinds("mcp").includes("jira-cloud") && kinds("mcp").includes("chrome-devtools"));
    add("DA finds commands", kinds("command").includes("jira") && kinds("command").includes("tfs-pr"));
    add("DA finds skills", kinds("skill").includes("trekoon"));
    add("DA finds the hooks file", kinds("hooks").some((n) => n.includes("hooks.yaml")));
    add("DA finds instruction files", kinds("instructions").includes("AGENTS.md"));

    // jsonc with comments and trailing commas must parse — opencode.json allows both.
    fs.writeFileSync(
        path.join(envRoot, "opencode.jsonc"),
        '{\n  // a comment\n  "plugin": ["with-comments"],\n}\n'
    );
    add(
        "DA jsonc comments and trailing commas parse",
        ext.__test.readJsonc(path.join(envRoot, "opencode.jsonc")).plugin[0] === "with-comments"
    );
    add("DA a malformed config does not throw", ext.__test.readJsonc(path.join(envRoot, "nope.json")) === undefined);

    // An empty workspace must report nothing rather than inventing entries.
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-bare-"));
    add("DA an empty workspace discovers nothing", ext.__test.discoverOpenCodeEnv(emptyRoot).length === 0);
    add("DA the empty summary says so", /No OpenCode configuration/.test(ext.__test.summariseEnv([])));

    const summary = ext.__test.summariseEnv(envItems);
    add("DA the summary groups by kind", /\*\*Plugins\*\* \(2\)/.test(summary) && /\*\*MCP servers\*\*/.test(summary));

    // The isolation above must not be hiding a broken feature: point the global
    // dir at a real tree and the same walk has to report it, tagged "global".
    const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-env-"));
    fs.writeFileSync(path.join(globalRoot, "opencode.json"), JSON.stringify({ plugin: ["a-global-plugin"] }));
    process.env.OPENCODE_CONFIG_DIR = globalRoot;
    const globalItems = ext.__test.discoverOpenCodeEnv(emptyRoot);
    add(
        "DA global config is discovered and scoped as global",
        globalItems.some((i) => i.kind === "plugin" && i.name === "a-global-plugin" && i.scope === "global")
    );
    if (realConfigDir === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR;
    } else {
        process.env.OPENCODE_CONFIG_DIR = realConfigDir;
    }

    // DB: event schema drift. v150's drift counter (a hardcoded allow-list, a
    // globalState tally, three report surfaces) was removed in v167 — it was a
    // snapshot of OpenCode's schema pinned inside the bundle, stale on every
    // OpenCode release. What must still hold is the defence that actually works:
    // an unrecognised type does not break the reply, and is not swallowed.
    add(
        "DB the drift-counter subsystem is gone from the harness surface",
        ext.__test.recordUnknownEvent === undefined &&
        ext.__test.unknownEventReport === undefined &&
        ext.__test.KNOWN_EVENT_TYPES === undefined
    );
    globalMemento.clear();
    const driftFake = writeFake("fake-drift.js", [
        { type: "totally.new.event", sessionID: "ses_d", part: { text: "x" } },
        { type: "text", sessionID: "ses_d", part: { text: "an answer long enough to render fine" } }
    ]);
    settings.executable = driftFake;
    settings.chatDensity = "full";
    memento.clear();
    const db = stream();
    await global.__handler({ prompt: "surface an unknown event type" }, {}, db.response, db.token);
    add("DB drift does not break the reply", /an answer long enough/.test(db.chatMarkdown.join("")));
    add("DB an unrecognised type is still logged", logLines.join("\n").includes("totally.new.event"));

    // A type whose NAME carries a failure word still becomes a visible error even
    // though nothing knows its shape. That path is what survived the removal.
    const driftErrFake = writeFake("fake-drift-err.js", [
        { type: "agent.invalid.state", sessionID: "ses_de", part: { message: "the agent refused" } }
    ]);
    settings.executable = driftErrFake;
    memento.clear();
    const dbe = stream();
    await global.__handler({ prompt: "an unknown type that names a failure" }, {}, dbe.response, dbe.token);
    add(
        "DB an unknown failure-shaped type still surfaces as an error",
        /agent\.invalid\.state|the agent refused/.test(dbe.chatMarkdown.join(""))
    );
    settings.executable = happy;

    // DC: /env in chat.
    const dc = stream();
    await global.__handler({ prompt: "", command: "env" }, {}, dc.response, dc.token);
    const chatDC = dc.chatMarkdown.join("");
    add("DC /env reports the environment", /OpenCode environment for/.test(chatDC));
    // v167 removed the drift warning from /env along with the counter behind it.
    add("DC /env no longer carries a drift warning", !/does not recognise/.test(chatDC));
    globalMemento.clear();

    // ============ v151 (fallbackModels handoff audit) ============
    //
    // A handoff run is TWO model calls. Attempt 1 times out after burning a full
    // cap of tokens, attempt 2 answers. Both cost money. These checks assert the
    // bridge accounts for both, and attributes each to the model that ran it.

    // A fake that always times out, so the chain is forced to advance.
    const stallFake = writeFake(
        "fake-stall.js",
        [
            { type: "step_finish", sessionID: "ses_hand", part: { reason: "length", cost: 0.05, tokens: { input: 5000, output: 100, reasoning: 0, total: 5100, cache: { read: 0, write: 0 } } } }
        ],
        "setTimeout(() => {}, 60000);\n"
    );

    settings.executable = stallFake;
    settings.timeoutMs = 1200;
    settings.idleTimeoutMs = 0;
    settings.model = "acme/first";
    settings.fallbackModels = ["acme/second"];
    globalMemento.clear();
    memento.clear();

    const ea = stream();
    await global.__handler({ prompt: "force a model handoff" }, {}, ea.response, ea.token);

    const argvAll = fs
        .readdirSync(work)
        .filter((f) => f === "fake-stall.js.argv")
        .map((f) => JSON.parse(fs.readFileSync(path.join(work, f), "utf8")));
    add("EA the chain advanced to the fallback model", argvAll.length > 0 && argvAll[0].includes("acme/second"));

    // The chain must be bounded: an unbounded fallbackModels list multiplies the
    // cap by its length, so ten fallbacks would allow a 30-minute turn.
    settings.fallbackModels = ["a/1", "a/2", "a/3", "a/4", "a/5", "a/6"];
    add("EA the handoff chain is capped", ext.__test.handoffChain("acme/first", settings.fallbackModels).length <= 4);
    add(
        "EA the chain keeps the primary model first",
        ext.__test.handoffChain("acme/first", settings.fallbackModels)[0] === "acme/first"
    );
    add(
        "EA the chain dedupes without dropping the default",
        ext.__test.handoffChain(undefined, ["a/1", "a/1"]).length === 2
    );

    settings.model = "";
    settings.fallbackModels = [];
    settings.timeoutMs = 30000;
    settings.executable = happy;
    globalMemento.clear();

    // ============ v153 (directory scoping + stale session recovery) ============

    // FA: withDirectory is the only place the query string is built, so its edge
    // cases are worth pinning even though FB proves the wiring.
    add(
        "FA withDirectory appends a directory query",
        ext.__test.withDirectory("http://h/session", "C:\\a") === "http://h/session?directory=C%3A%5Ca"
    );
    add(
        "FA withDirectory respects an existing query string",
        ext.__test.withDirectory("http://h/session?x=1", "C:\\a").includes("?x=1&directory=")
    );
    add("FA withDirectory is a no-op without a cwd", ext.__test.withDirectory("http://h/s", undefined) === "http://h/s");
    add(
        "FA a path with spaces is encoded, not broken",
        ext.__test.withDirectory("http://h/s", "C:\\my repo").endsWith("directory=C%3A%5Cmy%20repo")
    );

    // FB: the request the server actually receives.
    //
    // `opencode serve` is multi-directory: every /session endpoint takes a
    // `directory` query parameter and roots the session there, falling back to
    // the SERVER's cwd when it is absent. ensureServer() adopts any healthy
    // listener on the port, so two VS Code windows share one server -- and
    // before v153 the second window's prompts ran against the first window's
    // checkout. Measured against opencode 1.18.27: a server with cwd=...\site
    // answered `?directory=...\site-builder` with `path.cwd = ...\site-builder`,
    // and body fields named `directory` or `cwd` were ignored outright.
    //
    // So assert the bytes on the wire, not a helper's return value: stand up a
    // real HTTP server, record every URL it is asked for, and read them back.
    const seenUrls = [];
    let failNextMessageWith404 = false;
    const http = require("node:http");
    const fakeServer = http.createServer((req, res) => {
        seenUrls.push(`${req.method} ${req.url}`);
        const send = (code, payload) => {
            res.writeHead(code, { "content-type": "application/json" });
            res.end(JSON.stringify(payload));
        };
        if (req.url.startsWith("/global/health")) {
            return send(200, { healthy: true });
        }
        if (req.url.startsWith("/global/event")) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            return; // held open, never written to
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            // The real server accepts /session with or without a query string,
            // so the fake must too — otherwise a missing `directory` would fail
            // the recovery checks as well and stop isolating the defect.
            if (req.method === "POST" && /^\/session(\?|$)/.test(req.url)) {
                return send(200, { id: "ses_fresh" });
            }
            if (/\/message/.test(req.url)) {
                if (failNextMessageWith404) {
                    failNextMessageWith404 = false;
                    return send(404, { error: "Session not found" });
                }
                return send(200, {
                    info: { sessionID: "ses_fresh", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, total: 2, cache: { read: 0, write: 0 } } },
                    parts: [{ type: "text", text: "an answer from the server transport" }]
                });
            }
            return send(200, {});
        });
    });
    await new Promise((r) => fakeServer.listen(0, "127.0.0.1", r));
    const fakePort = fakeServer.address().port;

    settings.transport = "server";
    settings.serverPort = fakePort;
    settings.serverHostname = "127.0.0.1";
    settings.serverStartupPollMs = 20;
    memento.clear();
    seenUrls.length = 0;

    const fb = stream();
    await global.__handler({ prompt: "which repository am I rooted in?" }, {}, fb.response, fb.token);

    const encodedCwd = encodeURIComponent(work);
    // Match the path only, so "did the run reach the server" stays independent
    // of "was it scoped" — otherwise one defect fails both checks and the
    // report no longer says which thing broke.
    const createUrl = seenUrls.find((u) => u.startsWith("POST /session") && !/\/session\//.test(u));
    const messageUrl = seenUrls.find((u) => /\/message/.test(u));
    add("FB the server run actually reached the fake server", Boolean(createUrl) && Boolean(messageUrl));
    add("FB session create is scoped to this workspace", Boolean(createUrl) && createUrl.includes(`directory=${encodedCwd}`));
    add("FB the message POST is scoped to this workspace", Boolean(messageUrl) && messageUrl.includes(`directory=${encodedCwd}`));
    add("FB the server answer reaches chat", /an answer from the server transport/.test(fb.chatMarkdown.join("")));

    // FC (v176): under transport auto, /dev keeps the CLI (for --auto) but
    // ATTACHES it to the warm server instead of booting OpenCode per turn.
    // v175 log: 48–69s first byte on cold CLI dev turns vs ~10s on the server.
    settings.transport = "auto";
    settings.executable = happy;
    memento.clear();
    const fcRun = stream();
    await global.__handler({ prompt: "attach me", command: "dev" }, {}, fcRun.response, fcRun.token);
    const attArgv = lastArgv("fake-ok.js");
    const attAt = attArgv.indexOf("--attach");
    add("FC auto-transport /dev attaches to the warm server", attAt >= 0 && attArgv[attAt + 1] === `http://127.0.0.1:${fakePort}`);
    add("FC the attached run is scoped with --dir to this workspace", attArgv[attArgv.indexOf("--dir") + 1] === work);
    add("FC the attached run still auto-approves and names its agent", attArgv.includes("--auto") && attArgv[attArgv.indexOf("--agent") + 1] === "build");
    add("FC the answer still reaches chat", fcRun.chatMarkdown.join("").length > 0 && !/returned no output/.test(fcRun.chatMarkdown.join("")));

    // A dead attach target must not lose the turn: rerun cold, once.
    const attFlaky = writeFake(
        "fake-attach-flaky.js",
        [],
        "if (process.argv.includes('--attach')) { process.stderr.write('Error: Unable to connect. fetch failed ECONNREFUSED\\n'); process.exit(1); }\n" +
        "process.stdout.write(JSON.stringify({ type: 'text', sessionID: 'ses_cold', part: { text: 'answered cold' } }) + '\\n');\n"
    );
    settings.executable = attFlaky;
    memento.clear();
    const attCold = stream();
    await global.__handler({ prompt: "attach then fail", command: "dev" }, {}, attCold.response, attCold.token);
    add("FC a failed attach falls back to a cold run", /answered cold/.test(attCold.chatMarkdown.join("")));
    add("FC the fallback run has no --attach", !lastArgv("fake-attach-flaky.js").includes("--attach"));

    settings.transport = "cli";
    settings.executable = happy;
    const attCli = stream();
    memento.clear();
    await global.__handler({ prompt: "cli stays cold", command: "dev" }, {}, attCli.response, attCli.token);
    add("FC transport cli never attaches", !lastArgv("fake-ok.js").includes("--attach"));

    // FC: `transport: server` attaches /parallel lanes too; cold lanes
    // serialise on one opencode.db. Both lanes' argv are appended: the plain
    // .argv file is overwritten by whichever lane exits last.
    const laneLog = path.join(work, "fake-lane-att.argvs");
    const laneFake = writeFake(
        "fake-lane-att.js",
        [{ type: "text", sessionID: "ses_lane", part: { text: "lane ok" } }],
        `fs.appendFileSync(${JSON.stringify(laneLog)}, JSON.stringify(process.argv) + "\\n");\n`
    );
    const laneRuns = async (transport) => {
        settings.transport = transport;
        settings.executable = laneFake;
        fs.rmSync(laneLog, { force: true });
        const st = stream();
        await global.__handler({ prompt: "review auth | read the logs", command: "parallel" }, {}, st.response, st.token);
        return fs.existsSync(laneLog) ? fs.readFileSync(laneLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    };
    const laneUrlArg = `http://127.0.0.1:${fakePort}`;
    const srvLanes = await laneRuns("server");
    add("FC transport server attaches both parallel lanes to the warm server", srvLanes.length === 2 && srvLanes.every((a) => a[a.indexOf("--attach") + 1] === laneUrlArg));
    const cliLanes = await laneRuns("cli");
    add("FC transport cli keeps parallel lanes cold", cliLanes.length === 2 && cliLanes.every((a) => !a.includes("--attach")));
    settings.executable = happy;
    settings.transport = "server";

    // FC: a stale session id must not poison the workspace.
    //
    // The id lives in workspaceState and outlives OpenCode's storage, so it goes
    // stale when a session is deleted, storage is cleared, or settings sync
    // carries it to another machine. Measured: server -> HTTP 404,
    // cli -> exit 1 with stderr "Error: Session not found". Nothing cleared the
    // id, so EVERY later turn failed the same way, and the server->cli fallback
    // retried with the same dead id. The only escape was knowing to type /new.
    add("FC a 404 is recognised as a missing session", ext.__test.isMissingSessionError(new Error("HTTP 404: Session not found")));
    add("FC an unrelated HTTP error is not", ext.__test.isMissingSessionError(new Error("HTTP 500: boom")) === false);
    add(
        "FC the cli's exit-1 wording is recognised",
        ext.__test.isMissingSessionRun({ exitCode: 1, stderr: "Error: Session not found\n" })
    );
    add(
        "FC a clean run is never treated as missing",
        ext.__test.isMissingSessionRun({ exitCode: 0, stderr: "Error: Session not found" }) === false
    );

    // End to end: seed a session id, make the server reject it once, and assert
    // the turn still answers -- and that a NEW session was created to do it.
    memento.set(`opencode.session:${work}`, {
        id: "ses_stale",
        turns: 7,
        cost: 4.2,
        tokensIn: 900,
        // v162: over the toolOutputWarnBytes threshold (262144) on purpose. The
        // restart baseline zeroed turns/tokens/cost but sessionBytes was computed
        // outside it, so the dead session's total survived and contextWarning
        // warned about 390 KB held by a session created seconds earlier.
        toolOutputBytes: 400000
    });
    failNextMessageWith404 = true;
    seenUrls.length = 0;
    const att = stream();
    await global.__handler({ prompt: "continue where we left off" }, {}, att.response, att.token);
    const chatFC = att.chatMarkdown.join("");
    add("FC the turn is answered instead of lost", /an answer from the server transport/.test(chatFC));
    add("FC the user is told the old session is gone", /no longer exists/.test(chatFC));
    add(
        "FC a replacement session was created",
        seenUrls.filter((u) => u.startsWith("POST /session") && !/\/session\//.test(u)).length === 1
    );
    const restored = memento.get(`opencode.session:${work}`);
    add("FC the dead id is replaced, not kept", restored && restored.id === "ses_fresh");
    add("FC the new session does not inherit the dead one's turn count", restored && restored.turns === 1);
    add("FC the new session does not inherit the dead one's spend", restored && (restored.cost ?? 0) < 4.2);
    add(
        "FC the new session does not inherit the dead one's tool-output bytes",
        restored && (restored.toolOutputBytes ?? 0) < 400000
    );
    add(
        "FC a fresh session is not warned about the dead one's context",
        !/has accumulated/.test(chatFC)
    );

    await new Promise((r) => fakeServer.close(r));
    settings.transport = "cli";
    settings.serverPort = 4096;
    settings.executable = happy;
    memento.clear();
    globalMemento.clear();

    // ======= v160 (the "a new Copilot chat continues the old session" report) =======
    //
    // GA: THE REPORTED BUG. Session state was keyed by folder alone, so opening a
    // new Copilot chat resolved to the SAME OpenCode session: the model still
    // carried context the user had deliberately walked away from, and two chats
    // open side by side interleaved into one conversation. The fix scopes the
    // session to the chat thread, which the host hands us as `context.history`.
    const turnOf = (metadata, participant = "opencodeCopilotBridge.chat") => ({
        participant,
        result: { metadata }
    });

    // Unit: what a thread can prove about itself from its own history.
    add("GA a chat with no history is bound to no session", ext.__test.threadSession([], work) === undefined);
    const gaBound = ext.__test.threadSession(
        [turnOf({ kind: "plan", sessionId: "ses_a", cwd: work, turns: 4 })],
        work
    );
    add("GA a chat that has run before resumes its own session", Boolean(gaBound) && gaBound.id === "ses_a");
    add("GA it resumes that chat's own turn count", Boolean(gaBound) && gaBound.turns === 4);
    add(
        "GA the most recent turn wins",
        ext.__test.threadSession(
            [
                turnOf({ sessionId: "ses_old", cwd: work, turns: 1 }),
                turnOf({ sessionId: "ses_new", cwd: work, turns: 2 })
            ],
            work
        ).id === "ses_new"
    );
    add(
        "GA /new is a barrier scoped to the chat it was typed in",
        ext.__test.threadSession(
            [turnOf({ sessionId: "ses_a", cwd: work, turns: 4 }), turnOf({ kind: "new", cwd: work })],
            work
        ) === undefined
    );
    add(
        "GA another participant's metadata is never read as ours",
        ext.__test.threadSession(
            [turnOf({ sessionId: "ses_theirs", cwd: work }, "some.other.participant")],
            work
        ) === undefined
    );
    add(
        "GA a request turn carries no result and is skipped",
        ext.__test.threadSession([{ participant: "opencodeCopilotBridge.chat", prompt: "hi" }], work) === undefined
    );
    add(
        "GA a turn from another folder does not bind this one",
        ext.__test.threadSession(
            [turnOf({ sessionId: "ses_elsewhere", cwd: path.join(os.tmpdir(), "ocb-root-b"), turns: 3 })],
            work
        ) === undefined
    );
    add(
        "GA a failed turn does not sever the thread",
        ext.__test.threadSession(
            [
                turnOf({ sessionId: "ses_a", cwd: work, turns: 4 }),
                turnOf({ kind: "dev", cwd: work, error: "boom" })
            ],
            work
        ).id === "ses_a"
    );
    // A control command may name the session it just rendered without carrying
    // any counters. Binding to such a turn rebuilt the state from it and reset
    // the thread's turns, spend and context size to zero -- worse than the bug
    // this feature fixed, because those counters used to be out of its reach.
    const gaAfterHandoff = ext.__test.threadSession(
        [
            turnOf({ kind: "plan", sessionId: "ses_a", cwd: work, turns: 7, cost: 1.23, tokensIn: 50000 }),
            turnOf({ kind: "handoff", sessionId: "ses_a", cwd: work })
        ],
        work
    );
    add("GA /handoff does not reset the thread's turn count", gaAfterHandoff.turns === 7);
    add("GA /handoff does not reset the thread's spend", gaAfterHandoff.cost === 1.23);
    add("GA /handoff still leaves the thread on its session", gaAfterHandoff.id === "ses_a");
    add(
        "GA a turn with an id but no counters is not a binding",
        ext.__test.threadSession([turnOf({ kind: "handoff", sessionId: "ses_a", cwd: work })], work) === undefined
    );

    // The bug itself, at the resolver: the folder pointer must not leak into a
    // chat that has never spoken to us.
    memento.set(`opencode.session:${work}`, { id: "ses_folder", turns: 9 });
    add(
        "GA a new chat does not inherit the folder's session",
        ext.__test.resolveSessionState({ history: [] }, work).id === undefined
    );
    add(
        "GA an ongoing chat keeps its own session",
        ext.__test.resolveSessionState(
            { history: [turnOf({ sessionId: "ses_mine", cwd: work, turns: 2 })] },
            work
        ).id === "ses_mine"
    );
    // Proof the two checks above have teeth rather than passing vacuously: the
    // pre-v160 behaviour is still reachable, and under it the identical call
    // returns the folder's session.
    settings.sessionScope = "workspace";
    add(
        "GA sessionScope:workspace restores the old folder-wide sharing",
        ext.__test.resolveSessionState({ history: [] }, work).id === "ses_folder"
    );
    settings.sessionScope = "thread";
    // A host that hands us no history at all cannot be thread-scoped. It keeps
    // the folder pointer rather than silently losing every session.
    add(
        "GA a host that supplies no history falls back to the folder pointer",
        ext.__test.resolveSessionState({}, work).id === "ses_folder"
    );

    // End to end, across the process boundary: `--session` in the child's argv is
    // the observable artifact, not anything the extension merely returns.
    const ga1 = stream();
    const gaR1 = await global.__handler({ prompt: "start something new here" }, { history: [] }, ga1.response, ga1.token);
    add("GA a new chat spawns OpenCode without --session", !lastArgv("fake-ok.js").includes("--session"));
    add("GA the turn reports its session back to the thread", gaR1.metadata.sessionId === "ses_test");
    add("GA the turn stamps the folder it ran in", gaR1.metadata.cwd === work);
    add("GA the turn starts this chat's own turn count at 1", gaR1.metadata.turns === 1);
    add("GA a new chat says the older session is untouched", /New chat/.test(ga1.chatMarkdown.join("")));

    const ga2 = stream();
    const gaR2 = await global.__handler(
        { prompt: "and now continue that work" },
        { history: [turnOf(gaR1.metadata)] },
        ga2.response,
        ga2.token
    );
    const gaArgv = lastArgv("fake-ok.js");
    add(
        "GA the next turn in the same chat resumes it",
        gaArgv.includes("--session") && gaArgv[gaArgv.indexOf("--session") + 1] === "ses_test"
    );
    add("GA the thread carries its own turn count forward", gaR2.metadata.turns === 2);
    add("GA a continuing chat does not repeat the new-chat notice", !/New chat/.test(ga2.chatMarkdown.join("")));

    // A second chat opened in the same folder at the same moment: its own
    // conversation, even though the folder pointer now says ses_test.
    const ga3 = stream();
    await global.__handler({ prompt: "an unrelated question entirely" }, { history: [] }, ga3.response, ga3.token);
    add("GA a second chat in the same folder still starts clean", !lastArgv("fake-ok.js").includes("--session"));

    // Tripwire: the handler must never go back to reading the folder pointer for
    // continuity, which is exactly how this bug was written in the first place.
    add(
        "GA the chat handler resolves its session from the thread",
        /const state = resolveSessionState\(context, cwd\);/.test(srcText)
    );

    memento.clear();

    // GC: things that were unbounded, unpersisted, or unguarded. Each is asserted
    // against an artifact — elapsed wall time, the memento read back, the manifest
    // on disk — never against what a helper returned.

    // httpGetJson was bounded in 0.0.147 and httpPostJson was not, so the one
    // call that autoCompact makes every autoCompactEveryTurns turns could hang
    // the turn forever. Same probe as BC: a port that accepts and never answers.
    // The outer race is what makes this a RED CHECK instead of a hung suite when
    // the timeout is removed again — a hang reports nothing and blocks the gate.
    const gcBlackhole = net.createServer(() => { });
    await new Promise((r) => gcBlackhole.listen(0, "127.0.0.1", r));
    const gcPort = gcBlackhole.address().port;
    const gcStarted = Date.now();
    const gcOutcome = await Promise.race([
        ext.__test
            .httpPostJson(`http://127.0.0.1:${gcPort}/session/ses_x/summarize`, { auto: true }, 700)
            .then(() => "resolved", () => "rejected"),
        new Promise((r) => setTimeout(() => r("hung"), 4000).unref())
    ]);
    const gcElapsed = Date.now() - gcStarted;
    gcBlackhole.close();
    add("GC a silent port rejects the summarize POST instead of hanging", gcOutcome === "rejected");
    add("GC the summarize POST honours its timeout", gcOutcome === "rejected" && gcElapsed >= 600 && gcElapsed < 3000);

    // A workspace that is not trusted must not get to name the binary a chat turn
    // spawns, or the host it talks to. VS Code enforces that only if the manifest
    // declares it, so the manifest is the artifact.
    const gcPkg = require(path.join(__dirname, "..", "package.json"));
    const gcTrust = (gcPkg.capabilities || {}).untrustedWorkspaces || {};
    const gcRestricted = gcTrust.restrictedConfigurations || [];
    add("GC the manifest limits an untrusted workspace", gcTrust.supported === "limited");
    for (const key of ["executable", "serverHostname", "serverPort"]) {
        add(
            `GC ${key} is restricted in an untrusted workspace`,
            gcRestricted.includes(`opencodeCopilotBridge.${key}`)
        );
    }
    add(
        "GC every restricted key is a real setting",
        gcRestricted.every((k) => Object.prototype.hasOwnProperty.call(declared, k))
    );

    // A3: the Quick Actions button used to sit in the always-visible slot of every
    // editor's title bar with no `when` clause, so settings JSON and PNG previews
    // carried the icon too. The commandPalette entry above it was gated; this one
    // just missed the idiom. Generic: every title-bar entry must carry a `when`, so
    // the next one added is caught too.
    const haTitle = (gcPkg.contributes.menus || {})["editor/title"] || [];
    for (const [i, menu] of haTitle.entries()) {
        add(
            `A3 editor/title menu ${i} carries a when clause`,
            typeof menu.when === "string" && menu.when.trim().length > 0
        );
    }
    add("A3 the button is gated on its own setting", haTitle.every((m) => m.when));
    add(
        "A3 the editorTitleButton setting exists and defaults on",
        declared["opencodeCopilotBridge.editorTitleButton"]?.default === true
    );

    // B4: this extension spawns a local executable and writes session files with
    // node:fs, neither of which a virtual file system provides. Declared, or VS
    // Code would offer it in remote/virtual hosts where it cannot work.
    add(
        "B4 virtualWorkspaces is declared unsupported",
        (gcPkg.capabilities || {}).virtualWorkspaces?.supported === false
    );
    add(
        "B4 virtualWorkspaces has an honest description",
        typeof (gcPkg.capabilities || {}).virtualWorkspaces?.description === "string" &&
        (gcPkg.capabilities || {}).virtualWorkspaces.description.length > 20
    );

    // B1: the engine floor and the typings must name the same major.minor — vsce
    // hard-rejects a package whose @types/vscode exceeds engines.vscode, and the
    // floor described no reachable configuration when it sat below Copilot Chat's.
    const gcEngines = /^\^?(\d+)\.(\d+)/.exec(gcPkg.engines.vscode);
    const gcTypes = /^\^?(\d+)\.(\d+)/.exec(gcPkg.devDependencies["@types/vscode"]);
    add(
        "B1 engine and typings agree on major.minor",
        gcEngines && gcTypes && gcEngines[1] === gcTypes[1] && gcEngines[2] === gcTypes[2]
    );

    // B3: configuration is now an array of titled groups. collectConfigProperties
    // already validates groups have title + properties and that no key is duplicated.
    add(
        "B3 configuration is grouped and every property appears once",
        gcPkg.contributes.configuration &&
        Array.isArray(gcPkg.contributes.configuration) &&
        gcPkg.contributes.configuration.length >= 2
    );

    // With density gone the reply is the answer, not the answer plus a run report.
    memento.clear();
    const gdQuiet = stream();
    await global.__handler({ prompt: "Why does login redirect loop?" }, { history: [] }, gdQuiet.response, gdQuiet.token);
    const gdChat = gdQuiet.chatMarkdown.join("");
    add("GD the default reply still carries the answer", gdChat.includes("stale cookie"));
    add("GD the default reply has no Working list", !gdChat.includes("**Working**"));
    add("GD the default reply has no metrics footer", !/> 🤓 /.test(gdChat));

    // No transcript is written at all — the workspace stays clean, asserted by
    // reading the disk back after a real turn.
    memento.clear();
    const gdTurn = stream();
    await global.__handler({ prompt: "append to me" }, { history: [] }, gdTurn.response, gdTurn.token);
    add("GD a turn writes no transcript at all", !fs.existsSync(path.join(work, "sessions", "ses_test.md")));

    // HA: the extension had no surface of its own. With no `icon` in the manifest
    // the Extensions view AND the @opencode chat avatar both fell back to the
    // default placeholder (the avatar derives from the extension icon; there is no
    // per-participant icon), and `contributes.menus` held only commandPalette so no
    // command reached a toolbar. v169 retires opencode-16.svg/opencode.svg; the
    // command glyph now lives at media/command.svg, which the editor/title button
    // and this check both read.
    //
    // Every check below reads a shipped artifact: the PNG's own header bytes and
    // the manifest on disk.
    const haIconRel = gcPkg.icon;
    add("HA the manifest names an icon", typeof haIconRel === "string" && haIconRel.length > 0);
    const haIconAbs = path.join(repoDir, haIconRel || "missing");
    add("HA the icon resolves to a file on disk", fs.existsSync(haIconAbs));
    // Decode the PNG header rather than trusting the filename: IHDR is the first
    // chunk, so width/height sit at fixed offsets 16 and 20 (big-endian u32).
    const haIcon = fs.existsSync(haIconAbs) ? fs.readFileSync(haIconAbs) : Buffer.alloc(0);
    const haIsPng =
        haIcon.length > 24 &&
        haIcon.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    add("HA the icon really is a PNG", haIsPng);
    add(
        "HA the icon is at least 128x128",
        haIsPng && haIcon.readUInt32BE(16) >= 128 && haIcon.readUInt32BE(20) >= 128
    );
    add("HA the marketplace banner is themed with it", (gcPkg.galleryBanner || {}).theme === "dark");

    // v184: the title-bar button is the theme's own codicon. A file icon is a
    // CSS background image (menuEntryActionViewItem.ts, so no currentColor) —
    // v179 gave it an opaque 16px blue tile, which rendered as the one coloured
    // square in a row of monochrome buttons. A $(codicon) follows the theme and
    // the hover state like VS Code's own; $(code) is the status bar item's glyph.
    const haBtn = gcPkg.contributes.commands.find((c) => c.command === "opencodeCopilotBridge.quickActions");
    add("HA the title-bar button is a theme codicon, not a coloured file", !!haBtn && /^\$\([a-z-]+\)$/.test(haBtn.icon));
    add("HA …the same glyph as the status bar item", !!haBtn && srcText.includes(`"${haBtn.icon} OpenCode"`));
    add("HA the retired tile no longer ships", !fs.existsSync(path.join(repoDir, "media", "command.svg")));


    // A menu entry naming a command that does not exist is silently dropped by
    // VS Code, so "the button is contributed" and "the button is real" are two
    // different facts.
    const haTitleMenu = (gcPkg.contributes.menus || {})["editor/title"] || [];
    const haCommandIds = new Set(gcPkg.contributes.commands.map((c) => c.command));
    add("HA the editor title bar gets a button", haTitleMenu.length > 0);
    add(
        "HA every editor/title entry names a declared command",
        haTitleMenu.length > 0 && haTitleMenu.every((m) => haCommandIds.has(m.command))
    );
    add(
        "HA a toolbar command declares the icon it renders as",
        haTitleMenu.length > 0 &&
        haTitleMenu.every((m) => {
            const cmd = gcPkg.contributes.commands.find((c) => c.command === m.command);
            return cmd && typeof cmd.icon === "string" && cmd.icon.length > 0;
        })
    );

    // ============ v162 ============
    //
    // Both P0 defects below reached a shipped build. Each check drives a real run
    // and reads back an artifact the extension produced — the progress array the
    // stream recorded, the chat body it streamed, the argv a fake wrote to disk —
    // rather than asking a helper what it would have returned.

    // JA: progress inflation. Copilot Chat renders every response.progress() call
    // as a step. streamReasoning calls beat.phase() once per reasoning delta, and
    // forcing a render whenever the text differed short-circuited all three
    // backoff guards. Measured on this exact 47-event run at the shipped default
    // progressHeartbeatMs=1000: 47 progress() calls in 1.7s, i.e. 47 chat steps.
    //
    // CJ already scoped progressHeartbeatMs to 1000, but drove it with a fake that
    // streams no reasoning, so it only ever exercised the idle ticker — the one
    // path that was NOT broken. The setting is scoped here for the same reason CJ
    // scopes it: flipping the file default would silently change the conditions of
    // every other check at once.
    const beatEvents = [];
    for (let i = 0; i < 40; i++) {
        beatEvents.push({
            type: "reasoning",
            sessionID: "ses_beat",
            part: { text: `reasoning chunk number ${i} about the auth flow` }
        });
        if (i % 7 === 0) {
            beatEvents.push({
                type: "tool_use",
                sessionID: "ses_beat",
                part: { tool: "read", state: { input: { filePath: `src/f${i}.ts` }, output: "x", time: { start: 0, end: 5 } } }
            });
        }
    }
    beatEvents.push({ type: "text", sessionID: "ses_beat", part: { text: "Done." } });
    const chatty = writeFake(
        "fake-chatty.js",
        [],
        "const evs = " +
        JSON.stringify(beatEvents) +
        ";\nlet i = 0;\nconst t = setInterval(() => {\n" +
        "  if (i >= evs.length) { clearInterval(t); return; }\n" +
        "  process.stdout.write(JSON.stringify(evs[i++]) + '\\n');\n" +
        "}, 25);\n"
    );
    settings.executable = chatty;
    settings.progressHeartbeatMs = 1000;
    settings.timeoutMs = 30000;
    settings.idleTimeoutMs = 0;
    memento.clear();
    const ja = stream();
    await global.__handler({ prompt: "explain the auth flow" }, {}, ja.response, ja.token);

    add("JA 40 reasoning deltas do not become 40 chat steps", ja.progress.length <= 12);
    add(
        "JA every tool step still reaches the progress line",
        [0, 7, 14, 21, 28, 35].every((i) => ja.progress.some((p) => p.includes(`src/f${i}.ts`)))
    );

    // The other half of the fix: reasoning now rides the backoff ladder, so on a
    // slow run the elapsed readout is the only thing left moving. If it stopped
    // moving, a long turn would look frozen — the exact symptom the heartbeat was
    // added to prevent. One event, then silence; the idle cap ends the run.
    const slowFake = writeFake(
        "fake-slow-tick.js",
        [{ type: "reasoning", sessionID: "ses_slow", part: { text: "thinking hard about it" } }],
        "setTimeout(() => {}, 60000);\n"
    );
    settings.executable = slowFake;
    settings.idleTimeoutMs = 4000;
    memento.clear();
    const jaSlow = stream();
    await global.__handler({ prompt: "a slow run that goes quiet" }, {}, jaSlow.response, jaSlow.token);
    add("JA the elapsed ticker still moves on a slow run", new Set(jaSlow.progress).size >= 2);
    add(
        "JA the ticker still reports elapsed against the cap",
        jaSlow.progress.some((p) => /\d+s \/ \d+s/.test(p))
    );
    settings.progressHeartbeatMs = 0;
    settings.idleTimeoutMs = 0;
    settings.executable = happy;

    // JB: cross-session leakage on the shared SSE stream. runOpenCodeServer
    // subscribes to /global/event — every session, every workspace, every window —
    // and ensureServer deliberately adopts a server another window started. The
    // old filter was `if (sid && sessionId && sid !== sessionId) return`, so an
    // event with no extractable id failed OPEN and was streamed into this reply.
    const jbMine = "ses_jb_mine";
    let jbSse;
    let jbHealthGets = 0;
    const jbServer = http.createServer((req, res) => {
        const url = req.url || "";
        if (url.startsWith("/global/health")) {
            jbHealthGets += 1;
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify({ healthy: true }));
        }
        if (url.startsWith("/global/event")) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            jbSse = res;
            return;
        }
        if (req.method === "POST" && /\/session\/[^/]+\/message/.test(url)) {
            const send = (o) => jbSse && jbSse.write(`data: ${JSON.stringify(o)}\n\n`);
            setTimeout(() => {
                // (1) another session's text, shaped the way message.part.updated
                //     arrives but with no session id anywhere on it.
                send({
                    type: "message.part.updated",
                    properties: { part: { type: "text", id: "prt_other", text: "LEAKED-FOREIGN-TEXT. " } }
                });
                // (2) my own text, attributed the way OpenCode actually sends it:
                //     the envelope's info.id is the MESSAGE id, not a session id.
                //     Probing info.id before info.sessionID made this look like a
                //     foreign event and dropped it.
                send({
                    type: "message.part.updated",
                    properties: {
                        info: { id: "msg_jb", sessionID: jbMine, role: "assistant" },
                        part: { type: "text", id: "prt_mine", sessionID: jbMine, text: "OWN-SESSION-TEXT." }
                    }
                });
            }, 40);
            setTimeout(() => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                    JSON.stringify({
                        info: {
                            sessionID: jbMine,
                            cost: 0.001,
                            tokens: { input: 1, output: 1, total: 2, reasoning: 0, cache: { read: 0, write: 0 } }
                        },
                        parts: []
                    })
                );
            }, 300);
            return;
        }
        if (req.method === "POST" && url.startsWith("/session")) {
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify({ id: jbMine }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
    });
    await new Promise((r) => jbServer.listen(0, "127.0.0.1", r));
    settings.transport = "server";
    settings.serverPort = jbServer.address().port;
    memento.clear();
    const jb = stream();
    logLines.length = 0;
    await global.__handler({ prompt: "what does this repo do" }, {}, jb.response, jb.token);
    const jbLog = logLines.join("\n");
    const chatJB = jb.chatMarkdown.join("");
    settings.transport = "cli";
    settings.serverPort = 4096;
    if (jbSse) {
        jbSse.end();
    }
    await new Promise((r) => jbServer.close(r));

    add("JB an unattributable text part never reaches the reply", !chatJB.includes("LEAKED-FOREIGN-TEXT"));
    // v180 S3/S0: the server turn health-checks its server ONCE (v179: twice —
    // chat.ts warmServer, then runs.ts ensureServer) and logs its pre-run cost.
    add(`FW a server turn health-checks the server once (saw ${jbHealthGets})`, jbHealthGets === 1);
    add("FW the turn logs its pre-run timings", /pre-run: server \d+ms/.test(jbLog));
    add(
        "JB a part whose envelope carries the MESSAGE id is still attributed here",
        chatJB.includes("OWN-SESSION-TEXT")
    );

// JD: the SSE subscription is shared per server and refcounted. connectSse was
    // called once per run, so every concurrent chat opened its own socket to the
    // same server-wide stream and JSON-parsed every frame for every session.
    // Count the /global/event requests that actually crossed the socket: two
    // concurrent server-transport runs must share one. A returned object nobody
    // counted proves nothing.
    let jdSse;
    let jdEventRequests = 0;
    let jdNextId = 0;
    const jdServer = http.createServer((req, res) => {
        const url = req.url || "";
        if (url.startsWith("/global/health")) {
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify({ healthy: true }));
        }
        if (url.startsWith("/global/event")) {
            jdEventRequests += 1;
            res.writeHead(200, { "content-type": "text/event-stream" });
            jdSse = res;
            return;
        }
        const jdMsg = /\/session\/([^/]+)\/message/.exec(url);
        if (req.method === "POST" && jdMsg) {
            const sid = jdMsg[1];
            setTimeout(() => {
                jdSse &&
                    jdSse.write(
                        `data: ${JSON.stringify({
                            type: "message.part.updated",
                            properties: { part: { type: "text", id: "prt_" + sid, sessionID: sid, text: "SHARED-STREAM-TEXT-" + sid + "." } }
                        })}\n\n`
                    );
            }, 40);
            setTimeout(() => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                    JSON.stringify({
                        info: {
                            sessionID: sid,
                            cost: 0.001,
                            tokens: { input: 1, output: 1, total: 2, reasoning: 0, cache: { read: 0, write: 0 } }
                        },
                        parts: []
                    })
                );
            }, 300);
            return;
        }
        if (req.method === "POST" && url.startsWith("/session")) {
            jdNextId += 1;
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify({ id: "ses_jd_" + jdNextId }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
    });
    await new Promise((r) => jdServer.listen(0, "127.0.0.1", r));
    settings.transport = "server";
    settings.serverPort = jdServer.address().port;
    memento.clear();
    // Two runs at once, so the second connectSse must JOIN the first run's socket
    // rather than open a second one to the same server-wide stream.
    const jdRun = async (tag) => {
        const s = stream();
        await global.__handler({ prompt: tag }, {}, s.response, s.token);
        return s;
    };
    const [jd1, jd2] = await Promise.all([jdRun("a run that shares"), jdRun("a second sharing run")]);
    settings.transport = "cli";
    settings.serverPort = 4096;
    if (jdSse) {
        jdSse.end();
    }
    if (jdServer.closeAllConnections) {
        jdServer.closeAllConnections();
    }
    await new Promise((r) => jdServer.close(r));

    add("JD two concurrent runs share one /global/event socket", jdEventRequests === 1);
    const jdBoth = jd1.chatMarkdown.join("") + " " + jd2.chatMarkdown.join("");
    add("JD both runs' text crosses the one shared socket", jdBoth.includes("SHARED-STREAM-TEXT-ses_jd_1") && jdBoth.includes("SHARED-STREAM-TEXT-ses_jd_2"));
    add(
        "JD the shared stream is demultiplexed per run",
        !(jd1.chatMarkdown.join("").includes("SHARED-STREAM-TEXT-ses_jd_1") && jd1.chatMarkdown.join("").includes("SHARED-STREAM-TEXT-ses_jd_2")) &&
        !(jd2.chatMarkdown.join("").includes("SHARED-STREAM-TEXT-ses_jd_1") && jd2.chatMarkdown.join("").includes("SHARED-STREAM-TEXT-ses_jd_2"))
    );

    // JC: the P1 correctness items.

    // A dead "Repository" link renders for everyone who sees the listing.
    // Measured: fetching the URL this shipped with did not 404 — it redirected to
    // "Single sign-on to <employer>", so the link both failed and advertised the
    // employer. Absent is honest; dead is not.
    const PUBLIC_REPO = /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\//i;
    const jcLinks = ["repository", "homepage", "bugs"]
        .map((f) => (typeof gcPkg[f] === "string" ? gcPkg[f] : gcPkg[f] && gcPkg[f].url))
        .filter(Boolean);
    add("JC package.json links are omitted or on a public host", jcLinks.every((u) => PUBLIC_REPO.test(u)));

    // A handoff continues the SAME session, so the task is already in its context.
    // Re-sending it duplicated the whole prompt — attachment preamble included —
    // and paid input tokens for it twice on a turn already billed twice.
    const talkThenStall = writeFake(
        "fake-talk-stall.js",
        [{ type: "text", sessionID: "ses_ho", part: { text: "Partial answer so far." } }],
        "setTimeout(() => {}, 60000);\n"
    );
    settings.executable = talkThenStall;
    settings.timeoutMs = 1200;
    settings.model = "acme/first";
    settings.fallbackModels = ["acme/second"];
    memento.clear();
    const jcHandoff = stream();
    await global.__handler({ prompt: "UNIQUE-TASK-TEXT-162 explain it" }, {}, jcHandoff.response, jcHandoff.token);
    // Both attempts run the same fake, so the file holds attempt 2's argv.
    const jcArgv = lastArgv("fake-talk-stall.js").join(" ");
    add("JC the handoff does not re-send the task into a session that has it", !jcArgv.includes("UNIQUE-TASK-TEXT-162"));
    add("JC the handoff still tells the model to continue", jcArgv.includes(P.CONTINUE) && !jcArgv.includes("{tail}"));

    // The exception: an attempt that produced nothing may not have left anything
    // in context to continue from, so that one still carries the task.
    const silentStall = writeFake("fake-silent-stall.js", [], "setTimeout(() => {}, 60000);\n");
    settings.executable = silentStall;
    memento.clear();
    const jcEmpty = stream();
    await global.__handler({ prompt: "UNIQUE-EMPTY-TEXT-162 explain it" }, {}, jcEmpty.response, jcEmpty.token);
    const jcEmptyArgv = lastArgv("fake-silent-stall.js").join(" ");
    add("JC a handoff after zero output still carries the task", jcEmptyArgv.includes("UNIQUE-EMPTY-TEXT-162"));

    settings.model = "";
    settings.fallbackModels = [];
    settings.timeoutMs = 30000;
    settings.executable = happy;

    // Since v160 the success metadata IS the thread's persistent state: VS Code
    // replays it in ChatContext.history on every later turn, forever. `prompt` was
    // never read by threadSession or buildFollowups, so it was the user's raw text
    // sitting in chat storage and re-serialised on every replay.
    memento.clear();
    const jcMeta = stream();
    const jcResult = await global.__handler(
        { prompt: "a plain successful turn" },
        {},
        jcMeta.response,
        jcMeta.token
    );
    add("JC success-path metadata carries no raw prompt", !("prompt" in (jcResult?.metadata ?? {})));
    add("JC success-path metadata still carries the session id", Boolean(jcResult?.metadata?.sessionId));

    const jeFake = writeFake("fake-je.js", [
        { type: "text", sessionID: "ses_je", part: { text: "JE answer." } },
        {
            type: "step_finish",
            sessionID: "ses_je",
            part: { reason: "stop", cost: 0.001, tokens: { input: 1, output: 1, reasoning: 0, total: 2, cache: { read: 0, write: 0 } } }
        }
    ]);
    settings.executable = jeFake;
    memento.clear();
    const je1 = stream();
    await global.__handler({ prompt: "first turn of the sidecar" }, {}, je1.response, je1.token);
    const jeStore = path.join(work, "sessions", "ses_je.turns.json");
    add("JE no turn sidecar is written", !fs.existsSync(jeStore));
    settings.executable = happy;

    // JF: the two runners must reduce the same event stream to the same steps.
    // The CLI path deduped with `steps.find(s => s.tool === tool && s.detail ===
    // detail)` — a linear scan per event that also merged two genuine
    // `read src/login.ts` calls into a single step, fusing their timings and byte
    // counts. The server path already keyed on part.id. Same stream, same records.
    // The step count is read from the run's metrics line in the debug log.
    const jfSteps = (from) => {
        const m = [...logLines.slice(from).join("\n").matchAll(/ metrics first byte: .*? · steps: (\d+) /g)].pop();
        return m ? Number(m[1]) : -1;
    };
    const jfEvents = [
        { type: "tool_use", sessionID: "ses_dup", part: { id: "prt_a", tool: "read", state: { input: { filePath: "src/login.ts" }, output: "first call", time: { start: 0, end: 5 } } } },
        { type: "tool_use", sessionID: "ses_dup", part: { id: "prt_b", tool: "read", state: { input: { filePath: "src/login.ts" }, output: "second call", time: { start: 0, end: 9 } } } },
        { type: "text", sessionID: "ses_dup", part: { text: "Read it twice." } }
    ];
    settings.executable = writeFake("fake-dup.js", jfEvents);
    memento.clear();
    const jfCli = stream();
    const jfCliFrom = logLines.length;
    await global.__handler({ prompt: "read the same file twice" }, {}, jfCli.response, jfCli.token);
    const jfCliSteps = jfSteps(jfCliFrom);
    add("JF two distinct calls to the same file stay two steps", jfCliSteps === 2);

    let jfSse;
    const jfOrder = [];
    const jfServer = http.createServer((req, res) => {
        const url = req.url || "";
        if (url.startsWith("/global/health")) {
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify({ healthy: true }));
        }
        if (url.startsWith("/global/event")) {
            jfOrder.push("subscribe");
            res.writeHead(200, { "content-type": "text/event-stream" });
            jfSse = res;
            return;
        }
        if (req.method === "POST" && /\/session\/[^/]+\/message/.test(url)) {
            jfOrder.push("post");
            setTimeout(() => {
                for (const ev of jfEvents) {
                    jfSse &&
                        jfSse.write(
                            `data: ${JSON.stringify({
                                type: "message.part.updated",
                                properties: { part: { ...ev.part, type: ev.type === "text" ? "text" : "tool", sessionID: "ses_dup_srv" } }
                            })}\n\n`
                        );
                }
            }, 40);
            setTimeout(() => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ info: { sessionID: "ses_dup_srv", cost: 0.001, tokens: { input: 1, output: 1, total: 2, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] }));
            }, 300);
            return;
        }
        if (req.method === "POST" && url.startsWith("/session")) {
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify({ id: "ses_dup_srv" }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
    });
    await new Promise((r) => jfServer.listen(0, "127.0.0.1", r));
    settings.transport = "server";
    settings.serverPort = jfServer.address().port;
    memento.clear();
    const jfSrv = stream();
    const jfSrvFrom = logLines.length;
    await global.__handler({ prompt: "read the same file twice" }, {}, jfSrv.response, jfSrv.token);
    const jfSrvSteps = jfSteps(jfSrvFrom);
    settings.transport = "cli";
    settings.serverPort = 4096;
    if (jfSse) {
        jfSse.end();
    }
    if (jfServer.closeAllConnections) {
        jfServer.closeAllConnections();
    }
    await new Promise((r) => jfServer.close(r));

    add("JF the server transport reduces the same stream the same way", jfSrvSteps === jfCliSteps);
    // Invariant, not a timing assertion: the subscription must reach the server
    // before the prompt does, or the first events of a run are posted into a
    // stream nobody is listening to yet.
    add("JF the subscription attaches before the prompt is posted", jfOrder.indexOf("subscribe") === 0 && jfOrder.includes("post"));
    settings.executable = happy;

    // JG: v162 replaced a fixed `await delay(80)` before every server POST with
    // the SSE "connected" signal, keeping the 80ms only as a bound. The bound is
    // the load-bearing half: a server that accepts the subscription socket and
    // never answers it must not hold the turn. Measured by widening the bound to
    // 80000ms — every server-transport group in this file then waits the full cap
    // instead of 80ms and the suite runs past 300s without finishing, so the cost
    // is cumulative across runs, not confined to the one broken server. Raced
    // against a timeout so the regression surfaces as a RED CHECK, not a stall.
    let jgHeld;
    const jgServer = http.createServer((req, res) => {
        const url = req.url || "";
        if (url.startsWith("/global/health")) {
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify({ healthy: true }));
        }
        if (url.startsWith("/global/event")) {
            // Accepted and never answered: no headers, no body, no close.
            jgHeld = res;
            return;
        }
        if (req.method === "POST" && /\/session\/[^/]+\/message/.test(url)) {
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(
                JSON.stringify({
                    info: { sessionID: "ses_jg", cost: 0.001, tokens: { input: 1, output: 1, total: 2, reasoning: 0, cache: { read: 0, write: 0 } } },
                    parts: [{ type: "text", id: "prt_jg", sessionID: "ses_jg", text: "FALLBACK-ANSWER." }]
                })
            );
        }
        if (req.method === "POST" && url.startsWith("/session")) {
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify({ id: "ses_jg" }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
    });
    await new Promise((r) => jgServer.listen(0, "127.0.0.1", r));
    settings.transport = "server";
    settings.serverPort = jgServer.address().port;
    memento.clear();
    const jg = stream();
    const jgOutcome = await Promise.race([
        global.__handler({ prompt: "a server whose event stream never answers" }, {}, jg.response, jg.token).then(
            () => "answered"
        ),
        new Promise((r) => {
            const t = setTimeout(() => r("hung"), 15000);
            t.unref?.();
        })
    ]);
    settings.transport = "cli";
    settings.serverPort = 4096;
    if (jgHeld) {
        jgHeld.destroy();
    }
    // Under a removed bound the turn never finishes, so it never releases its SSE
    // subscription, which reconnects on a 1.5s backoff into the server being shut
    // down — close() then never resolves and the suite deadlocks instead of
    // reporting. Bound the teardown too, for the same reason the run is bounded.
    if (jgServer.closeAllConnections) {
        jgServer.closeAllConnections();
    }
    await Promise.race([
        new Promise((r) => jgServer.close(r)),
        new Promise((r) => {
            const t = setTimeout(r, 3000);
            t.unref?.();
        })
    ]);
    if (jgServer.closeAllConnections) {
        jgServer.closeAllConnections();
    }

    add("JG a subscription that never connects does not stall the turn", jgOutcome === "answered");
    add("JG the turn still answers from the POST response", jg.chatMarkdown.join("").includes("FALLBACK-ANSWER"));

    // JH: the output channel keeps everything it is given for the window's whole
    // lifetime, and runOpenCode logged one line per reasoning and per text delta —
    // so a window accumulated the entire token stream of every run it had ever
    // done. Gated behind debugLog; step, error and metrics lines stay unconditional
    // because those are what a bug report actually needs.
    settings.executable = happy;
    settings.debugLog = false;
    memento.clear();
    logLines.length = 0;
    const jhOff = stream();
    await global.__handler({ prompt: "a normal turn with debug logging off" }, {}, jhOff.response, jhOff.token);
    const jhQuiet = logLines.join("\n");

    settings.debugLog = true;
    memento.clear();
    logLines.length = 0;
    const jhOn = stream();
    await global.__handler({ prompt: "a normal turn with debug logging on" }, {}, jhOn.response, jhOn.token);
    const jhLoud = logLines.join("\n");
    settings.debugLog = false;

    add("JH per-delta reasoning is kept out of the channel by default", !jhQuiet.includes(M.thought));
    add("JH per-delta text is kept out of the channel by default", !jhQuiet.includes(M.text));
    add("JH debugLog:true still yields the deltas when asked for", jhLoud.includes(M.thought) || jhLoud.includes(M.text));
    add("JH tool steps are logged either way", jhQuiet.includes("grep") && jhLoud.includes("grep"));
    add("JH turning the deltas off makes the channel strictly smaller", jhQuiet.length < jhLoud.length);

    // KA: v167 — the wall clock no longer blocks a long task, and captured
    // output is no longer clipped.
    //
    // The blocker was one line: `if (now - started >= options.timeoutMs)`, with
    // timeoutMs defaulting to 180s. A run that was still streaming tool calls
    // got killed for taking too long, which is the one thing a streaming run
    // proves it is not. The idle cap already distinguished hung from slow.
    settings.timeoutMs = 0;
    settings.idleTimeoutMs = 0;
    settings.progressHeartbeatMs = 1000;
    const kaLong = writeFake(
        "fake-ka-long.js",
        [{ type: "text", sessionID: "ses_ka", part: { text: "a reply that arrives after a while" } }],
        "setTimeout(() => {}, 2500);\n"
    );
    settings.executable = kaLong;
    memento.clear();
    const kaStarted = Date.now();
    const ka = stream();
    await global.__handler({ prompt: "a run that outlives the old 180s shape" }, {}, ka.response, ka.token);
    const kaElapsed = Date.now() - kaStarted;
    add("KA a run with no wall-clock cap is not killed", /a reply that arrives after a while/.test(ka.chatMarkdown.join("")));
    add("KA it really did run past the first tick", kaElapsed >= 2000);
    add(
        "KA the progress line drops the cap readout when there is none",
        ka.progress.length === 0 || ka.progress.every((p) => !/\d+s \/ \d+s/.test(p))
    );
    settings.progressHeartbeatMs = 0;

    // A positive timeoutMs still caps, exactly as before — this is opt-in, not
    // a removal of the capability.
    settings.timeoutMs = 1200;
    settings.executable = writeFake("fake-ka-hang.js", [], "setTimeout(() => {}, 60000);\n");
    memento.clear();
    const kaCap = stream();
    const kaCapStarted = Date.now();
    await global.__handler({ prompt: "a hung run under an explicit wall clock" }, {}, kaCap.response, kaCap.token);
    add("KA an explicit wall clock still stops a run", Date.now() - kaCapStarted < 8000);
    add(
        "KA the cap message names the cap and the way out",
        /wall-clock cap/.test(kaCap.chatMarkdown.join("")) && /timeoutMs. to 0/.test(kaCap.chatMarkdown.join(""))
    );
    settings.timeoutMs = 30000;

    // Output caps. stderr was kept as a 4 KB TAIL, which dropped the head of a
    // trace — the part naming the cause. metrics.error was cut at 400 chars,
    // which lands mid-stack.
    const kaBigLine = "E".repeat(9000);
    settings.executable = writeFake(
        "fake-ka-stderr.js",
        [],
        `process.stderr.write(${JSON.stringify("HEAD-MARKER " + kaBigLine + " TAIL-MARKER\n")});\n`
    );
    memento.clear();
    const kaErr = stream();
    await global.__handler({ prompt: "a run that only writes to stderr" }, {}, kaErr.response, kaErr.token);
    const kaLog = logLines.join("\n");
    add("KA stderr keeps its head, not just a 4 KB tail", kaLog.includes("HEAD-MARKER"));

    const kaLongErr = "X".repeat(1200);
    settings.executable = writeFake("fake-ka-err.js", [
        { type: "session.error", sessionID: "ses_kae", error: { message: `boom ${kaLongErr} END-MARKER` } }
    ]);
    memento.clear();
    const kaE = stream();
    await global.__handler({ prompt: "a run whose error is longer than 400 chars" }, {}, kaE.response, kaE.token);
    add("KA a long error is not cut at 400 chars", /END-MARKER/.test(kaE.chatMarkdown.join("") + logLines.join("\n")));
    settings.executable = happy;
    settings.timeoutMs = 30000;

    // LB (v169): context-aware follow-up chips. Keyed on the turn's metadata, so
    // a host can render next steps; chips must not offer dead ends. `/new` and
    // `/help` answer themselves, so they offer nothing.
const lbProvider = (global.__participant || {}).followupProvider;
    add(
        "LB the participant exposes a followupProvider",
        !!lbProvider && typeof lbProvider.provideFollowups === "function"
    );
    if (lbProvider) {
        const lbToken = { isCancellationRequested: false };
        add(
            "LB /new and /help offer no followups",
            lbProvider.provideFollowups({ metadata: { kind: "new" } }, {}, lbToken).length === 0 &&
                lbProvider.provideFollowups({ metadata: { kind: "help" } }, {}, lbToken).length === 0
        );
        // v183: a finished turn offers only what ITS answer points at, else
        // nothing (Grok-style: natural, or absent). v173–v182 always added
        // Continue + New session; after a finished answer, "Continue from where
        // you stopped" asked the agent to resume work that had not stopped.
        const lbCompleted = lbProvider.provideFollowups(
            { metadata: { kind: "dev", agent: "dev", sessionId: "ses_lb", turns: 1 } },
            {},
            lbToken
        );
        add("LB a finished turn with nothing to point at offers no chips", Array.isArray(lbCompleted) && lbCompleted.length === 0);
        add("LB a fresh finished turn offers no chips either", lbProvider.provideFollowups({ metadata: { kind: "dev" } }, {}, lbToken).length === 0);
        // /parallel lanes ran in isolated sessions that are already closed.
        const lbPar = lbProvider.provideFollowups({ metadata: { kind: "parallel", lanes: 2 } }, {}, lbToken);
        add("LB a parallel turn offers no chips", lbPar.length === 0);
        const lbFailed = lbProvider.provideFollowups(
            { metadata: { kind: "dev", sessionId: "ses_lb", turns: 1, timedOut: true } },
            {},
            lbToken
        );
        add("LB a timed-out turn offers a Retry chip", lbFailed.some((f) => f.label === L.RETRY && typeof f.prompt === "string" && f.prompt.length > 0));
        const lbFailedPrompts = lbFailed.map((f) => f.prompt);
        add(
            "LB a failed turn's Retry and Continue are not the same prompt",
            lbFailed.length === 2 && new Set(lbFailedPrompts).size === lbFailedPrompts.length
        );
        add("LB at most three chips are ever offered", lbFailed.length <= 3);
        const lbNet = lbProvider.provideFollowups(
            { metadata: { kind: "dev", agent: "dev", error: "spawn opencode ENOENT", prompt: "fix it" } },
            {},
            lbToken
        );
        add(
            "LB an unreachable OpenCode offers Retry + Check the connection, not Pick up",
            lbNet.some((f) => f.label === L.PING) && !lbNet.some((f) => f.label === L.CONTINUE)
        );
        const lbCancel = lbProvider.provideFollowups({ metadata: { kind: "plan", agent: "plan", sessionId: "ses_lb", turns: 2, cancelled: true } }, {}, lbToken);
        add("LB a cancelled turn offers exactly Pick up", lbCancel.length === 1 && lbCancel[0].label === L.CONTINUE);
        const lbClarify = lbProvider.provideFollowups(
            { metadata: { kind: "clarify", prompt: "hi" } },
            {},
            lbToken
        );
        add(
            "LB a clarified turn offers to run it anyway",
            lbClarify.some((f) => f.label === L.RUN_ANYWAY && f.prompt === "hi")
        );

        // v176 LC: under a dev turn every "keep going" chip keeps /dev, or a
        // click demotes the session to the read-only plan agent.
        const lcDev = lbProvider.provideFollowups(
            { metadata: { kind: "dev", agent: "dev", sessionId: "ses_lc", turns: 1, timedOut: true } },
            {},
            lbToken
        );
        add("LC a dev turn's Pick-up chip stays on /dev", lcDev.some((f) => f.label === L.CONTINUE && f.command === "dev"));
        const lcAll = [...lcDev, ...lbFailed, ...lbNet, ...lbCancel, ...lbClarify];
        add("LC no chip carries a /command in its text", lcAll.length >= 7 && lcAll.every((f) => !/^\//.test(f.prompt)));
        add("LC every chip names its command", lcAll.every((f) => typeof f.command === "string" && f.command.length > 0));
        const lcDevFailed = lbProvider.provideFollowups(
            { metadata: { kind: "dev", agent: "dev", sessionId: "ses_lc", turns: 2, error: "boom" } },
            {},
            lbToken
        );
        add(
            "LC a failed dev turn's Retry and Pick-up chips stay on /dev",
            lcDevFailed.length === 2 && lcDevFailed.every((f) => f.command === "dev")
        );
        add("LC a plan turn's Pick-up chip stays on plan", lbCancel.some((f) => f.label === L.CONTINUE && f.command === "plan"));

        // LD: answer-aware chips, now phrased naturally and naming what they act on.
        const sf = ext.__test.suggestFollowups;
        const ldRec = sf({
            agent: "plan",
            answer: "## 1) Move x\n## 2) Rewrite y\n\nKeep the rules or match site? My recommendation: **match site exactly**.",
            steps: []
        });
        add("LD a closing recommendation becomes a one-click dev handoff", ldRec.some((f) => f.label === NL("recommend") && f.command === "dev"));
        add("LD a numbered plan offers its step 1, named", ldRec.some((f) => f.label === NL("step1", { item: "Move x" }) && f.command === "dev"));
        const ldRefusal = sf({ agent: "dev", answer: "We're in plan mode — I can't execute edits yet.", steps: [] });
        add("LD a dev turn that refused as plan offers to apply now", ldRefusal.some((f) => f.label === NL("applyNow") && f.command === "dev"));
        const ldEdited = sf({ agent: "dev", answer: "Done.", steps: [{ tool: "edit", detail: "a.ts" }] });
        add(
            "LD a dev turn that edited one file offers to review THAT file, and tests",
            ldEdited.some((f) => f.label === NL("review1", { file: "a.ts" }) && f.command === "plan") &&
                ldEdited.some((f) => f.label === NL("tests") && f.command === "dev")
        );
        add("LD a plain answer adds no chips", sf({ agent: "plan", answer: "The cache lives in core.ts.", steps: [] }).length === 0);

        // LE: the thought line shows where the reasoning got to, not its opening
        // restatement of the prompt.
        const tl = ext.__test.thoughtLine;
        const leLine = tl("The user said continue and finish. The system reminder says plan mode. I should check hooks.json before moving files.");
        add("LE the thought line skips the prompt restatement", !/^The user/.test(leLine) && /hooks\.json/.test(leLine));
        // LF: Copilot Chat appends a NEW line per progress() call. The v175
        // ticker printed 24 lines for a 60s silent cold start (1/s for 15s, then
        // 1/5s); the milestone ticker must stay at 1 + milestones reached.
        let lfLines = 1;
        for (let due = ext.__test.nextMilestone(0); due <= 60; due = ext.__test.nextMilestone(due)) lfLines++;
        add("LF a 60s silent run renders at most 5 progress lines", lfLines <= 5);
        add("LE the thought line strips markdown", tl("**Checking** `opencode.json` now.") === "Checking opencode.json now.");
    }

    // LT (v177): long runs on an attached server session.
    //
    // Field log 2026-09-23: an MCP call made an attached run silent on stdout;
    // the idle cap killed the CLIENT, the server kept running, and each handoff
    // queued behind it. Measured on 1.18.32: kill != stop (status stays busy),
    // a second prompt to a busy session waits, and 12 abandoned clients leave
    // 12 prompts in the session. The fake server below records the ORDER of
    // spawns and aborts on the wire, and pushes SSE tool events on demand.
    {
        const ltLog = [];
        const ltStatus = {};
        const ltSse = [];
        const ltServer = http.createServer((req, res) => {
            const u = new URL(req.url, "http://x");
            const send = (code, payload) => {
                res.writeHead(code, { "content-type": "application/json" });
                res.end(JSON.stringify(payload));
            };
            if (u.pathname === "/global/health") return send(200, { healthy: true });
            if (u.pathname === "/global/event") {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.write(": hi\n\n");
                ltSse.push(res);
                return;
            }
            if (u.pathname === "/__spawn") { ltLog.push("spawn:" + u.searchParams.get("m")); return send(200, {}); }
            if (u.pathname === "/__emit") {
                const sid = u.searchParams.get("sid");
                const ev = { payload: { type: "message.part.updated", properties: { sessionID: sid, part: {
                    id: "prt_lt", sessionID: sid, type: "tool", tool: "acme_get_issue",
                    state: { status: "running", input: { description: "fetch BLD-37752" }, time: { start: Date.now() } } } } } };
                for (const r of ltSse) r.write("data: " + JSON.stringify(ev) + "\n\n");
                return send(200, {});
            }
            if (u.pathname === "/session/status") return send(200, ltStatus);
            const abort = u.pathname.match(/^\/session\/([^/]+)\/abort$/);
            if (abort && req.method === "POST") {
                ltLog.push("abort:" + abort[1]);
                delete ltStatus[abort[1]];
                return send(200, true);
            }
            if (req.method === "POST" && u.pathname === "/session") return send(200, { id: "ses_lt" });
            return send(200, {});
        });
        await new Promise((r) => ltServer.listen(0, "127.0.0.1", r));
        // A fake attached CLI: reports its spawn (and model) to the server, then
        // behaves per mode. `--attach <url>` tells it where the server is.
        const ltFake = (name, body) =>
            writeFake(
                name,
                [],
                "const http = require('http');\n" +
                "const a = process.argv; const url = a[a.indexOf('--attach') + 1];\n" +
                "const sid = a[a.indexOf('--session') + 1]; const model = a.includes('--model') ? a[a.indexOf('--model') + 1] : '-';\n" +
                "const hit = (p) => new Promise((r) => http.get(url + p, (res) => { res.resume(); res.on('end', r); }).on('error', r));\n" +
                "(async () => { await hit('/__spawn?m=' + encodeURIComponent(model));\n" + body + "\n})();\n"
            );
        const say = (text) => `process.stdout.write(JSON.stringify({ type: 'text', sessionID: sid, part: { text: ${JSON.stringify(text)} } }) + '\\n');`;
        const saved = { t: settings.transport, p: settings.serverPort, i: settings.idleTimeoutMs, q: settings.toolQuietMs, f: settings.fallbackModels, e: settings.executable, to: settings.timeoutMs };
        settings.transport = "auto";
        settings.serverPort = ltServer.address().port;
        settings.serverHostname = "127.0.0.1";
        settings.timeoutMs = 0;
        settings.idleTimeoutMs = 1500;

        // LT1: stdout silent for 3s while the SERVER reports a tool running.
        settings.toolQuietMs = 10000;
        settings.executable = ltFake("fake-lt-worker.js", "await hit('/__emit?sid=' + sid); await new Promise((r) => setTimeout(r, 3000)); " + say("fetched BLD-37752") + " process.exit(0);");
        memento.clear(); ltLog.length = 0;
        const lt1 = stream();
        await global.__handler({ prompt: "use mcp to get the ticket", command: "dev" }, { history: [] }, lt1.response, lt1.token);
        add("LT1 a silent run with a tool running on the server is not killed by idleTimeoutMs", /fetched BLD-37752/.test(lt1.chatMarkdown.join("")));
        add("LT1 the running tool reaches the progress line", lt1.progress.some((p) => /acme_get_issue/.test(p)));
        add("LT1 a finished run is not aborted", !ltLog.some((l) => l.startsWith("abort")));

        // LT2: same, but the tool outlives toolQuietMs -> stopped, ABORTED on
        // the server, and NOT handed off (a tool was running: not a model stall).
        settings.toolQuietMs = 1600;
        settings.fallbackModels = ["acme/backup"];
        settings.executable = ltFake("fake-lt-stuck.js", "await hit('/__emit?sid=' + sid); setTimeout(() => {}, 60000);");
        memento.clear(); ltLog.length = 0;
        const lt2 = stream();
        await global.__handler({ prompt: "use mcp to get the ticket", command: "dev" }, { history: [] }, lt2.response, lt2.token);
        add("LT2 a stuck tool ends the run and the server run is aborted", ltLog.includes("abort:ses_lt"));
        add("LT2 no handoff when a tool was running", ltLog.filter((l) => l.startsWith("spawn")).length === 1);
        add("LT2 chat names the stuck tool", /acme_get_issue/.test(lt2.chatMarkdown.join("")));

        // LT3: a genuine model stall (nothing at all) still hands off — but
        // only AFTER the stalled run is aborted, so the next one is not queued.
        settings.executable = ltFake("fake-lt-stall.js", "setTimeout(() => {}, 60000);");
        memento.clear(); ltLog.length = 0;
        const lt3 = stream();
        await global.__handler({ prompt: "use mcp to get the ticket", command: "dev" }, { history: [] }, lt3.response, lt3.token);
        add(
            "LT3 a model stall aborts on the server before handing off",
            ltLog[0] === "spawn:-" && ltLog[1] === "abort:ses_lt" && ltLog[2] === "spawn:acme/backup"
        );

        // LT4: a session left busy by an earlier run is stopped BEFORE sending,
        // instead of this turn silently queueing behind it.
        settings.fallbackModels = [];
        settings.toolQuietMs = 600000;
        settings.executable = ltFake("fake-lt-quick.js", say("answered") + " process.exit(0);");
        const ltHistory = { history: [{ participant: "opencodeCopilotBridge.chat", result: { metadata: { sessionId: "ses_busy", turns: 3, cwd: work, kind: "dev", agent: "dev" } } }] };
        ltStatus.ses_busy = { type: "busy" };
        memento.clear(); ltLog.length = 0;
        const lt4 = stream();
        await global.__handler({ prompt: "next question", command: "dev" }, ltHistory, lt4.response, lt4.token);
        add("LT4 a busy session is aborted before the new turn is sent", ltLog[0] === "abort:ses_busy" && ltLog[1] === "spawn:-");
        add("LT4 chat says why it stopped the earlier run", /still busy with an earlier run/.test(lt4.chatMarkdown.join("")));
        add("LT4 the new turn is answered", /answered/.test(lt4.chatMarkdown.join("")));

        // LT5: busySessionPolicy "queue" keeps the old behaviour, explicitly.
        settings.busySessionPolicy = "queue";
        ltStatus.ses_busy = { type: "busy" };
        memento.clear(); ltLog.length = 0;
        const lt5 = stream();
        await global.__handler({ prompt: "next question", command: "dev" }, ltHistory, lt5.response, lt5.token);
        add("LT5 policy queue does not abort", !ltLog.some((l) => l.startsWith("abort")));
        settings.busySessionPolicy = "abort";

        // LT6: /stop aborts a busy session; an idle one is left alone.
        ltStatus.ses_busy = { type: "busy" };
        memento.clear(); ltLog.length = 0;
        const lt6 = stream();
        await global.__handler({ prompt: "", command: "stop" }, ltHistory, lt6.response, lt6.token);
        add("LT6 /stop aborts the running server session", ltLog.includes("abort:ses_busy") && /Stopped the run/.test(lt6.chatMarkdown.join("")));
        ltLog.length = 0;
        const lt6b = stream();
        await global.__handler({ prompt: "", command: "stop" }, ltHistory, lt6b.response, lt6b.token);
        add("LT6 /stop on an idle session aborts nothing", ltLog.length === 0 && /idle/.test(lt6b.chatMarkdown.join("")));

        for (const r of ltSse) r.end();
        ltServer.close();
        settings.transport = saved.t; settings.serverPort = saved.p; settings.idleTimeoutMs = saved.i;
        settings.toolQuietMs = saved.q; settings.fallbackModels = saved.f; settings.executable = saved.e; settings.timeoutMs = saved.to;
    }

    // WT (v178): `/worktree <task>` — opt-in isolation. Cooperative is the
    // default; this command must put the run in a NEW worktree + branch next to
    // the repo and leave the checkout alone. Asserted on the filesystem and on
    // the argv/cwd the fake OpenCode actually received, not on return values.
    {
        const { execFileSync } = require("node:child_process");
        const g = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: work, stdio: "pipe" }).toString();
        const wtParent = path.join(path.dirname(work), `${path.basename(work)}.worktrees`);
        const wtFake = writeFake(
            "fake-wt.js",
            [{ type: "text", sessionID: "ses_wt", part: { text: "edited in the worktree" } }],
            "fs.writeFileSync(require('path').join(process.cwd(), 'wt-proof.txt'), 'x');\n" +
            "fs.writeFileSync(" + JSON.stringify(path.join(work, "fake-wt.cwd")) + ", process.cwd());\n"
        );
        const saved = { e: settings.executable, t: settings.transport };
        settings.executable = wtFake;
        settings.transport = "cli";

        // WT0: not a git repository -> a clear refusal, no run.
        fs.rmSync(path.join(work, "fake-wt.cwd"), { force: true });
        const wt0 = stream();
        const r0 = await global.__handler({ prompt: "add a test", command: "worktree" }, { history: [] }, wt0.response, wt0.token);
        add("WT0 /worktree outside a git repo refuses clearly", /not inside a git repository/.test(wt0.chatMarkdown.join("")) && r0.metadata.kind === "worktree");
        add("WT0 and runs nothing", !fs.existsSync(path.join(work, "fake-wt.cwd")));

        g("init", "-q", "-b", "main");
        fs.writeFileSync(path.join(work, "tracked.txt"), "v1\n");
        g("add", "tracked.txt");
        g("commit", "-qm", "base");
        const wt1 = stream();
        const r1 = await global.__handler({ prompt: "Add a regression test!", command: "worktree" }, { history: [] }, wt1.response, wt1.token);
        const wtPath = r1.metadata.worktree;
        const ranIn = fs.existsSync(path.join(work, "fake-wt.cwd")) ? fs.readFileSync(path.join(work, "fake-wt.cwd"), "utf8") : "";
        // Compared on real paths: os.tmpdir() can be an 8.3 short name
        // (ARTSRU~1.HAK) while git reports the long one.
        add("WT1 the worktree is created next to the repo, not inside it", typeof wtPath === "string" && fs.existsSync(wtPath) && fs.existsSync(wtParent) && fs.realpathSync.native(path.dirname(wtPath)) === fs.realpathSync.native(wtParent));
        add("WT1 on a new ai/<slug> branch", /^ai\/add-a-regression-test-\d{4}-\d{6}$/.test(r1.metadata.branch) && g("branch", "--list", r1.metadata.branch).includes(r1.metadata.branch));
        add("WT1 OpenCode ran with the worktree as its cwd", fs.realpathSync(ranIn || work) === fs.realpathSync(wtPath));
        // v183: the real CLI resolves its directory from PWD first, so the
        // worktree must arrive as PWD too — cwd alone let a no-server
        // /worktree run edit the checkout VS Code was launched from.
        add("WT1 …and as its PWD, which is what OpenCode actually reads", samePath(lastEnv("fake-wt.js").pwd, wtPath));
        add("WT1 the editing agent is named", lastArgv("fake-wt.js")[lastArgv("fake-wt.js").indexOf("--agent") + 1] === "build");
        add("WT1 the run's file landed in the worktree only", fs.existsSync(path.join(wtPath, "wt-proof.txt")) && !fs.existsSync(path.join(work, "wt-proof.txt")));
        add("WT1 the reply lists the changed files (new files included)", /wt-proof\.txt/.test(wt1.chatMarkdown.join("")));
        add(
            "WT1 diff / open / remove buttons carry the worktree",
            ["worktreeDiff", "worktreeOpen", "worktreeRemove"].every((c) => wt1.buttons.some((b) => b.command === `opencodeCopilotBridge.${c}` && b.arguments[0].path === wtPath))
        );
        add("WT1 the thread session is not rebound to the worktree", r1.metadata.sessionId === undefined && r1.metadata.turns === undefined);
        add("WT1 no follow-up chips under a worktree turn", (global.__participant.followupProvider.provideFollowups(r1, {}, {}) || []).length === 0);

        const wt2 = stream();
        await global.__handler({ prompt: "", command: "worktree" }, { history: [] }, wt2.response, wt2.token);
        add("WT2 /worktree with no task explains itself", /Give the task after `\/worktree`/.test(wt2.chatMarkdown.join("")));
        add("WT3 slugs are filesystem- and branch-safe", ext.__test.slugify("Fix: ../../etc  ÆØ!!") === "fix-etc" && ext.__test.slugify("!!!") === "task");

        // WT4: git runs without a shell, from one file only.
        const execFileFiles = fs.readdirSync(path.join(__dirname, "..", "src")).filter((f) => /execFile\(/.test(fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8")));
        add("WT4 execFile appears only in worktree.ts", execFileFiles.length === 1 && execFileFiles[0] === "worktree.ts");
        add("WT4 git is never run through a shell", !/shell\s*:\s*true/.test(srcText));

        g("worktree", "remove", "--force", wtPath);
        fs.rmSync(wtParent, { recursive: true, force: true });
        fs.rmSync(path.join(work, ".git"), { recursive: true, force: true });
        fs.rmSync(path.join(work, "tracked.txt"), { force: true });
        settings.executable = saved.e;
        settings.transport = saved.t;
    }

    // LB (v169): `response.anchor` renders an inline jump link for files the
    // agent touched, beside the bottom "used references" chips. Drive a fake whose
    // tool step carries a file_path and assert both surfaces.
    settings.executable = writeFake("fake-lb.js", [
        {
            type: "tool_use",
            sessionID: "ses_lb",
            part: {
                tool: "read",
                state: {
                    input: { file_path: path.join(work, "lane.ts") },
                    output: "// lane",
                    time: { start: 0, end: 10 }
                }
            }
        },
        { type: "text", sessionID: "ses_lb", part: { text: "Touched lane.ts." } }
    ]);
    memento.clear();
    const lb = stream();
    await global.__handler({ prompt: "read the lane" }, {}, lb.response, lb.token);
    const lbFile = path.join(work, "lane.ts");
    add("LB a touched file is emitted as a reference chip", lb.refs.includes(lbFile));
    // v184: the inline anchors beside it are gone. They never rendered in VS
    // Code: the host's anchor() is `this.push(…)`, and it was called unbound —
    // every call threw into a catch. This stub's arrow-function anchor() hid it.
    add("LB no inline anchor is sent (the reference list already carries the file)", lb.anchors.length === 0);

    // FK (0.0.194): a file named in the answer opens on click. `src/cart.ts:42`
    // in inline code becomes an inline anchor at that line — only for a file
    // in the workspace, never in a fence or a ``-span. Accordion rows that
    // name one file carry it, so the row opens it.
    {
        const fkDir = fs.mkdtempSync(path.join(work, "fk-"));
        fs.mkdirSync(path.join(fkDir, "src"));
        fs.writeFileSync(path.join(fkDir, "src", "cart.ts"), "// cart\n");
        const fkCart = path.join(fkDir, "src", "cart.ts");
        const fkRun = (chunks) => {
            const l = ext.__test.createFileLinker?.(fkDir);
            return l ? [...chunks.flatMap((c) => l.push(c)), ...l.flush()] : chunks;
        };
        const fkText = (parts) => parts.map((p) => (typeof p === "string" ? p : "<A>")).join("");
        const fkAnchors = (parts) => parts.filter((p) => typeof p !== "string").map((p) => p.anchor);
        const fk1 = fkRun(["See `src/cart.ts:42` now."]);
        const fk1a = fkAnchors(fk1)[0];
        add("FK a path:line in inline code becomes an anchor at that line", fkText(fk1) === "See <A> now." && fk1a?.uri?.fsPath === fkCart && fk1a?.range?.start?.line === 41);
        add("FK a bare path becomes an anchor to the file", fkAnchors(fkRun(["Edit `src/cart.ts`."]))[0]?.fsPath === fkCart);
        const fkSame = (what, chunks) => {
            const out = fkRun(chunks);
            add(`FK ${what} stays text`, fkAnchors(out).length === 0 && fkText(out) === chunks.join(""));
        };
        fkSame("a path that does not exist", ["See `src/nope.ts:3`."]);
        fkSame("a path outside the workspace", ["See `../cart.ts` and `" + path.join(os.tmpdir(), "x.ts") + "`."]);
        fkSame("a path in a fence", ["```ts\n`src/cart.ts`\n```\n"]);
        fkSame("a path in a fence split mid-fence", ["``", "`js\n`src/c", "art.ts`\n``", "`\n"]);
        fkSame("a path in a ``-span", ["Run `` `src/cart.ts` `` here."]);
        fkSame("an escaped backtick", ["Not \\`src/cart.ts\\` here."]);
        fkSame("a span left open at the end", ["Tail `src/cart.ts"]);
        const fkSplit = fkRun(["See `src/ca", "rt.ts:7", "` then."]);
        add("FK a path split across chunks still becomes one anchor", fkText(fkSplit) === "See <A> then." && fkAnchors(fkSplit)[0]?.range?.start?.line === 6);
        const fkAfter = fkRun(["```\nx\n```\nThen `src/cart.ts`."]);
        add("FK a path after a closed fence becomes an anchor", fkText(fkAfter) === "```\nx\n```\nThen <A>.");
        // An answer that never streamed arrives whole: one 300 KB line, 48k backticks.
        const fkBig = "See `a` and `b.x` here, `src/nope.ts` too. ".repeat(7000);
        const fkT0 = Date.now();
        const fkBigOut = fkRun([fkBig]);
        const fkMs = Date.now() - fkT0;
        add(`FK a 300 KB one-line answer links in < 500ms (${fkMs}ms)`, fkMs < 500 && fkText(fkBigOut) === fkBig);

        // Through a real turn: the anchor reaches the chat, the text around it too.
        fs.writeFileSync(path.join(work, "fk-lane.ts"), "a\nb\nc\n");
        settings.executable = writeFake("fake-fk.js", [
            { type: "text", sessionID: "ses_fk", part: { text: "Fixed `fk-lane.ts:3`; `fk-gone.ts` is not there." } }
        ]);
        memento.clear();
        const fk = stream();
        await global.__handler({ prompt: "fix the lane for fk" }, {}, fk.response, fk.token);
        const fkChat = fk.chatMarkdown.join("");
        add(
            "FK a turn sends a file it names as an inline anchor, the rest as text",
            fk.anchors.length === 1 && fk.anchors[0].uri?.uri?.fsPath === path.join(work, "fk-lane.ts") && !fkChat.includes("`fk-lane.ts:3`") && fkChat.includes("`fk-gone.ts`")
        );

        // Accordion rows: a read/edit row carries its file; a shell row stays text.
        const fkH = hostStream();
        const fkBeat = ext.__test.startHeartbeat(fkH.response, "rows", 0, fkDir);
        fkBeat.thought("Look at the cart");
        fkBeat.step({ tool: "read", detail: path.join(fkDir, "src", "cart.ts"), filePath: path.join(fkDir, "src", "cart.ts"), durationMs: 2, status: "done" });
        fkBeat.step({ tool: "bash", detail: "npm test", durationMs: 2, status: "done" });
        fkBeat.activity();
        await fkBeat.stop();
        fkH.close();
        await new Promise((r) => setTimeout(r, 20));
        const fkRows = fkH.main.tasks.filter(Boolean).flatMap((t) => t.rows);
        add("FK a read row carries its file (cart.ts #read); a shell row stays text", fkRows.join("|") === "cart.ts #read|bash: npm test");
    }

    // LB (v169): the manifest's command table and the runtime control/agent
    // tables must not drift — the mirror of the BE setting-drift guard, for
    // commands. Rendering no typing and no spawn, this is pure manifest⇄source
    // consistency, asserted against both artifacts.
    const lbPkgCommands = (
        (require(path.join(__dirname, "..", "package.json")).contributes.chatParticipants || [])
            .find((p) => p.id === "opencodeCopilotBridge.chat")?.commands || []
    );
    const lbNames = lbPkgCommands.map((c) => c.name);
    // v176: kind commands come from the runtime table too. /plan was in it (and
    // in /help) since v168 but missing from the manifest, so it could not be
    // chosen to leave a sticky /dev — the hand-typed list here hid that drift.
    const lbExpected = [...ext.__test.slashCommands, ...ext.__test.kindCommands, ...ext.__test.routedCommands].sort();
    add(
        "LB manifest commands exactly match runtime control + agent tables",
        JSON.stringify([...lbNames].sort()) === JSON.stringify(lbExpected)
    );
    add(
        "LB every manifest command carries a description",
        lbPkgCommands.length > 0 && lbPkgCommands.every((c) => typeof c.description === "string" && c.description.length > 0)
    );

    // ==================== v179 ====================
    // MA: session ids reach two boundaries — a URL path and an argv value. v165
    // removed the file-path use that safeSessionId was written for, which left
    // it test-only while five URL sites interpolated the raw id. Every site now
    // goes through sessionPath/safeSessionId; the tripwire keeps it that way.
    add("MA sessionPath keeps a plain id", ext.__test.sessionPath("ses_ab12", "abort") === "/session/ses_ab12/abort");
    const maEvil = ext.__test.sessionPath("../../config", "abort");
    add("MA sessionPath cannot walk to another endpoint", maEvil.split("/").length === 4 && !maEvil.split("/").some((seg) => seg === ".." || seg === "."));
    add("MA no raw session id is interpolated into a URL", !/\/session\/\$\{(?!safeSessionId\()/.test(srcText));
    add("MA the CLI --session value is sanitised", /"--session", safeSessionId\(/.test(srcText));
    // Every __test key must be read by this harness. v178 carried 12 that were
    // not — imports kept alive only to be re-exported to nobody.
    const maHarness = fs.readFileSync(__filename, "utf8");
    const maUnread = Object.keys(ext.__test).filter((k) => !new RegExp(`__test\\s*\\.\\s*${k}\\b`).test(maHarness));
    add(`MA every __test key is read by the harness${maUnread.length ? ` (unread: ${maUnread.join(", ")})` : ""}`, maUnread.length === 0);


    // ==================== v180 ====================
    // FU: one action, one channel. v179 showed "Run it anyway" as a button AND a
    // chip on one turn, and "Retry" as button + chip + toast. Chips own the next
    // message, buttons own artifacts, toasts only out-of-view news.
    const fuChips = (result) => global.__participant.followupProvider.provideFollowups(result, {}, {}) || [];
    const fuNorm = (s) => String(s).toLowerCase().replace(/ this prompt$/, "").replace(/^start a (new|fresh) session$/, "new session");
    const fuOverlap = (buttons, chips) => buttons.map((b) => fuNorm(b.title)).filter((t) => chips.some((c) => fuNorm(c.label) === t));

    settings.executable = happy;
    memento.clear();
    const fu1 = stream();
    const fu1r = await global.__handler({ prompt: "zork" }, {}, fu1.response, fu1.token);
    const fu1c = fuChips(fu1r);
    add("FU1 a clarified turn is clarified", fu1r.metadata.kind === "clarify");
    add("FU1 clarify: no action is both a button and a chip", fuOverlap(fu1.buttons, fu1c).length === 0);
    add("FU1 clarify: exactly one Run it anyway", fu1c.filter((c) => c.label === L.RUN_ANYWAY).length === 1 && fu1.buttons.length === 0);
    add("FU2 the Run it anyway chip names its command (plan)", fu1c[0] && fu1c[0].command === "plan" && fu1c[0].prompt === "zork");
    const fu2 = stream();
    const fu2r = await global.__handler({ prompt: "blorp", command: "dev" }, {}, fu2.response, fu2.token);
    const fu2c = fuChips(fu2r);
    add("FU2 a clarified /dev turn's chip stays on /dev", fu2r.metadata.kind === "clarify" && fu2c.length === 1 && fu2c[0].command === "dev");

    settings.executable = inflight;
    settings.timeoutMs = 1200;
    settings.fallbackModels = [];
    memento.clear();
    const fu3 = stream();
    const fu3r = await global.__handler({ prompt: "will time out again" }, {}, fu3.response, fu3.token);
    const fu3c = fuChips(fu3r);
    add("FU3 timeout: no action is both a button and a chip", fuOverlap(fu3.buttons, fu3c).length === 0);
    add("FU3 timeout: Retry is a chip", fu3c.some((c) => c.label === L.RETRY));
    add("FU3 timeout: the debug log stays a button", fu3.buttons.some((b) => b.command === "opencodeCopilotBridge.showLog"));
    settings.executable = happy;
    settings.timeoutMs = 30000;
    add(
        "FU3 no body button ever replays a prompt",
        !/button\(\{[^}]*retryLast/.test(srcText)
    );

    // A timed-out CONTINUING session gets /new as a chip (was a body button).
    const fu4 = fuChips({ metadata: { kind: "dev", agent: "dev", sessionId: "ses_fu", turns: 3, timedOut: true } });
    add("FU4 a timed-out continuing session offers /new as a chip", fu4.some((c) => c.command === "new") && fu4.length === 3);
    // A launch failure (catch path) carries the replay; Retry resends it, kind in `command`.
    const fu5 = fuChips({ metadata: { kind: "dev", agent: "dev", error: "spawn EACCES", prompt: "/dev fix the login" } });
    const fu5r = fu5.find((c) => c.label === L.RETRY);
    add("FU5 a launch-failure Retry resends the original task", fu5r && fu5r.prompt === "fix the login" && fu5r.command === "dev");
    const fuAll = [...fu1c, ...fu2c, ...fu3c, ...fu4, ...fu5];
    add("FU5 every chip, clarify included, names its command", fuAll.every((c) => typeof c.command === "string" && c.command.length > 0));
    add("FU5 no chip carries a /command in its text", fuAll.every((c) => !/^\//.test(c.prompt)));

    // Toasts: a focused failure repeats nothing; unfocused offers only Open Chat.
    const fuToasts = [];
    const fuRealError = vscodeStub.window.showErrorMessage;
    vscodeStub.window.showErrorMessage = (msg, ...actions) => (fuToasts.push(actions), Promise.resolve(undefined));
    vscodeStub.window.state.focused = true;
    ext.__test.notifyIfSlow({ totalMs: 5000, timedOut: true, cancelled: false }, "dev", work);
    vscodeStub.window.state.focused = false;
    ext.__test.notifyIfSlow({ totalMs: 5000, timedOut: true, cancelled: false }, "dev", work);
    vscodeStub.window.state.focused = true;
    vscodeStub.window.showErrorMessage = fuRealError;
    add("FU6 a focused failure toast carries no action", fuToasts[0] && fuToasts[0].length === 0);
    add("FU6 an unfocused failure toast offers only Open Chat", fuToasts[1] && fuToasts[1].length === 1 && fuToasts[1][0] === "Open Chat");
    add("FU6 no toast action duplicates a chip", fuToasts.flat().every((a) => !fuAll.some((c) => fuNorm(c.label) === fuNorm(a))));

    // FV: a one-word prompt WITH an attachment is a task (the v179 screenshot:
    // `do` + chat.js:370 selected was refused).
    memento.clear();
    const fv = stream();
    const fvBefore = (lastArgv("fake-ok.js") || []).join("\u0000");
    const fvr = await global.__handler(
        { prompt: "do", references: [{ id: "vscode.file", value: { fsPath: attached, scheme: "file" } }] },
        {},
        fv.response,
        fv.token
    );
    const fvArgv = lastArgv("fake-ok.js") || [];
    add("FV a one-word prompt with an attachment runs", fvr.metadata.kind !== "clarify" && !/too short for me to act on/.test(fv.chatMarkdown.join("")));
    add("FV and the run actually reached OpenCode", fvArgv.join("\u0000") !== fvBefore && /src\/login\.ts/.test(fvArgv[fvArgv.length - 1] || ""));
    // v181: the gate guards a session's FIRST message only, so start fresh.
    memento.clear();
    const fv2 = stream();
    await global.__handler({ prompt: "blip" }, {}, fv2.response, fv2.token);
    add("FV the same word with NO attachment is still clarified", /too short for me to act on/.test(fv2.chatMarkdown.join("")));

    // ==================== v181 ====================
    // VG: the vague gate is a FIRST-message gate. Mid-session, `yes` / `go` /
    // `do` answer the agent's last question; v180 blocked them.
    memento.clear();
    const vg0 = stream();
    const vg0r = await global.__handler({ prompt: "start a real session for vg" }, {}, vg0.response, vg0.token);
    add("VG a real first turn opens a session", typeof vg0r.metadata.sessionId === "string");
    const vgHistory = { history: [{ participant: "opencodeCopilotBridge.chat", result: vg0r, prompt: "start a real session for vg" }] };
    const vgBefore = (lastArgv("fake-ok.js") || []).join("\u0000");
    const vg1 = stream();
    const vg1r = await global.__handler({ prompt: "go" }, vgHistory, vg1.response, vg1.token);
    const vgArgv = lastArgv("fake-ok.js") || [];
    add("VG a one-word reply mid-session is not clarified", vg1r.metadata.kind !== "clarify" && !/too short for me to act on/.test(vg1.chatMarkdown.join("")));
    add("VG and it reached OpenCode in the same session", vgArgv.join("\u0000") !== vgBefore && vgArgv.includes(vg0r.metadata.sessionId));
    memento.clear();
    const vg2 = stream();
    const vg2r = await global.__handler({ prompt: "go" }, {}, vg2.response, vg2.token);
    add("VG the same word as a FIRST message is still clarified", vg2r.metadata.kind === "clarify");
    add("VG isVaguePrompt: one regex, same verdicts", ["ping", "stuff", "hello!"].every(ext.__test.isVaguePrompt) && !["run tests", "App.js", "x1", "src/x", "a_b", "abcdefghijklm"].some(ext.__test.isVaguePrompt));

    // KM: every emoji is a kaomoji now, every chip reads from followups.json.
    const kmEmoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{23E9}-\u{23FA}\u{FE0F}]/u;
    const kmMarks = Object.values(M);
    const kmKaos = Object.values(FJ.chips).map((c) => c.kao);
    add("KM no mark or chip kaomoji is an emoji", [...kmMarks, ...kmKaos].every((k) => !kmEmoji.test(k)));
    add("KM every mark is markdown-inert", kmMarks.every((k) => !/[_*`\\[\]|<>#~]/.test(k)));
    add("KM marks are distinct", new Set(kmMarks).size === kmMarks.length);
    add("KM chip kaomoji are distinct", new Set(kmKaos).size === kmKaos.length);
    add("KM no emoji literal or escape left in src", !kmEmoji.test(srcText) && !/\\u(?:23[ef][0-9a-f]|2[67][0-9a-f]{2}|fe0f|d83[cde])/i.test(srcText));
    const kmRendered = renderedAll.join("\n");
    add(`KM nothing the suite rendered to chat carries an emoji (${renderedAll.length} writes)`, renderedAll.length > 100 && !kmEmoji.test(kmRendered));
    add("KM the kaomoji actually reach chat", kmMarks.filter((k) => kmRendered.includes(k)).length >= 4);
    // One place for every sentence a chip or handoff sends: no copy of a
    // prompt survives in code, and no two prompts say the same thing.
    // v183: compare each template's STATIC words (v181/v182 compared raw
    // templates containing {tail}, which can never occur in src — vacuous).
    const kmTemplates = [...Object.values(FJ.prompts), ...Object.values(FJ.natural ?? {}).flatMap((n) => (typeof n === "object" ? [n.prompt, n.label] : []))];
    const kmStatic = kmTemplates.flatMap(staticParts);
    add(`KM no chip sentence is spelled out in src (${kmStatic.length} fragments)`, kmStatic.length >= 10 && kmStatic.every((t) => !srcText.includes(t)) && !/be concise/i.test(srcText));
    add("KM prompts are distinct", new Set(Object.values(P)).size === Object.values(P).length);
    add("KM every case names a real chip", Object.values(FJ.cases).flat().every((k) => k in FJ.chips));
    add("KM every chip prompt key is a real prompt", Object.values(FJ.chips).every((c) => c.prompt === "" || c.prompt in P));
    const kmAll = [
        { kind: "clarify", prompt: "hi" },
        { kind: "parallel" },
        { kind: "dev", agent: "dev", sessionId: "ses_km", turns: 1, error: "x" },
        { kind: "dev", agent: "dev", sessionId: "ses_km", turns: 3, timedOut: true },
        { kind: "plan", agent: "plan", sessionId: "ses_km", turns: 2, cancelled: true },
        { kind: "plan", agent: "plan", sessionId: "ses_km", turns: 2 }
    ].flatMap((m) => global.__participant.followupProvider.provideFollowups({ metadata: m }, {}, {}));
    const kmLabels = new Set(Object.values(L));
    add(`KM every recovery chip label is a JSON label (${kmAll.length} chips)`, kmAll.length >= 5 && kmAll.every((c) => kmLabels.has(c.label)));
    const kmSmart = ext.__test.suggestFollowups({ agent: "dev", answer: "done", steps: [{ tool: "edit", filePath: "src/z.ts" }] });
    const kmFill = (t, v) => fillTail(String(t).replace(/\{(\w+)\}/g, (all, k) => (k in v ? v[k] : all)));
    add(
        "KM answer chips are the JSON templates, filled",
        kmSmart.length === 2 &&
            kmSmart[0].label === NL("review1", { file: "z.ts" }) &&
            kmSmart[0].prompt === kmFill(FJ.natural?.review1?.prompt, { file: "z.ts" }) &&
            kmSmart[1].prompt === kmFill(FJ.natural?.tests?.prompt, {})
    );
    add("KM every sent prompt ends with the one tail, where a template asks for it", [P.CONTINUE, P.RETRY].every((t) => t.endsWith(FJ.tail)));
    add("KM the clarify chip reads Run it", kmAll[0] && kmAll[0].label === L.RUN_ANYWAY);

    // ==================== v182 ====================
    // GP (v182) was checked against a stub that runs every task and keeps every
    // chunk; it asserted the open spinner tasks v184 removes. The group is
    // rewritten against hostStream() in the v184 section.

    // KB (v187): kaomoji pills. v182–v186 sent <span style> + supportHtml; chat's
    // response renderer applies KaTeX's `style` rule, which replaces the span
    // rule (domSanitize keeps one predicate per attribute): no background, no
    // radius, a colour only as a bare word. Measured 2026-09-29, the sanitizer run
    // in Chromium: every v182 style came out "". A pill is inline code — plain
    // markdown, no supportHtml, so neighbouring parts merge.
    const kbPill = (m) => "`" + m + "`";
    const kbText = (v) => (typeof v === "string" ? v : String(v.value ?? v));
    const kbParts = mdPartsAll.filter((v) => Object.values(M).some((m) => kbText(v).includes(kbPill(m))));
    add(`KB pills were rendered (${kbParts.length} parts)`, kbParts.length >= 5);
    add("KB no markdown part is sent with supportHtml (parts must merge)", mdPartsAll.length > 100 && mdPartsAll.every((v) => typeof v === "string" || v.supportHtml !== true));
    add("KB no markdown part carries a <span>", !mdPartsAll.some((v) => /<span/.test(kbText(v))));
    add("KB progress lines carry no pill", progressAll.length > 50 && !progressAll.some((l) => Object.values(M).some((m) => l.includes(kbPill(m)))));
    const kbBm = ext.__test.badgeMarks;
    add("KB a pill wraps a mark and nothing else", Object.values(M).every((m) => kbBm(m) === kbPill(m) && ext.__test.badge(m) === kbPill(m)));
    add(
        "KB mid-sentence, blockquote and table cell marks become pills",
        kbBm(`fine ${M.ok} here`) === `fine ${kbPill(M.ok)} here` &&
            kbBm(`> ${M.ok} x`) === `> ${kbPill(M.ok)} x` &&
            kbBm(`| ${M.ok} | a |`) === `| ${kbPill(M.ok)} | a |`
    );
    add("KB a mark inside inline code stays plain", kbBm("run `x " + M.ok + "` now " + M.ok) === "run `x " + M.ok + "` now " + kbPill(M.ok));
    add("KB a mark inside a fence stays plain", kbBm("```ts\nk = '" + M.ok + "'\n```\n" + M.ok) === "```ts\nk = '" + M.ok + "'\n```\n" + kbPill(M.ok));
    add("KB ~~~ fences hold; a ~ in prose does not", kbBm("~~~\n" + M.ok + "\n~~~\n~5s " + M.ok) === "~~~\n" + M.ok + "\n~~~\n~5s " + kbPill(M.ok));
    add("KB ``code with ` inside`` closes only on its own run length", kbBm("``a ` " + M.ok + "`` " + M.ok) === "``a ` " + M.ok + "`` " + kbPill(M.ok));
    add("KB a blank line ends an unclosed inline span", kbBm("oops `open\n\n" + M.ok) === "oops `open\n\n" + kbPill(M.ok));
    add("KB a CRLF blank line ends an unclosed inline span", kbBm("oops `open\r\n\r\n" + M.ok) === "oops `open\r\n\r\n" + kbPill(M.ok));
    add("KB a fence after CRLF holds", kbBm("text\r\n```\r\n" + M.ok + "\r\n```\r\n" + M.ok) === "text\r\n```\r\n" + M.ok + "\r\n```\r\n" + kbPill(M.ok));
    add("KB an escaped backtick opens nothing", kbBm("a \\`" + M.ok + " b") === "a \\`" + kbPill(M.ok) + " b" && kbBm("\\\\`" + M.ok + "`") === "\\\\`" + M.ok + "`");
    // v188: `\(` escapes the `(` (CommonMark: any ASCII punctuation). A pill
    // there sent `\`(…)`: an escaped backtick and a stray one.
    add("KB a mark after a backslash stays as written", kbBm("\\" + M.ok) === "\\" + M.ok && kbBm("a \\" + M.ok + " " + M.ok) === "a \\" + M.ok + " " + kbPill(M.ok));
    const ZW = "\u200b";
    add("KB a pill right after a closing backtick is kept apart", kbBm("`x`" + M.ok) === "`x`" + ZW + kbPill(M.ok));
    add("KB a pill right before a backtick is kept apart", kbBm(M.ok + "`x`") === kbPill(M.ok) + ZW + "`x`");
    add("KB an escaped backtick needs no separator", kbBm("a \\`" + M.ok) === "a \\`" + kbPill(M.ok));
    add("KB a ```` fence is not closed by ```", kbBm("````\n```\n" + M.ok + "\n````\n" + M.ok) === "````\n```\n" + M.ok + "\n````\n" + kbPill(M.ok));
    // The answer streams in deltas: state must carry across chunks.
    const kbRun = (chunks) => {
        const b = ext.__test.createBadger();
        return chunks.map(b).join("");
    };
    add(
        "KB a fence opened in an earlier chunk still holds",
        kbRun(["intro\n```", "ts\nk = '" + M.ok + "';\n", "```\nafter " + M.ok]) === "intro\n```ts\nk = '" + M.ok + "';\n```\nafter " + kbPill(M.ok)
    );
    add(
        "KB a fence whose backticks split across chunks is still a fence",
        kbRun(["x\n``", "`\n" + M.ok + "\n``", "`\n" + M.ok]) === "x\n```\n" + M.ok + "\n```\n" + kbPill(M.ok)
    );
    add(
        "KB inline code split across chunks stays plain; after it, a pill",
        kbRun(["see `foo ", M.ok + " bar` and ", M.ok]) === "see `foo " + M.ok + " bar` and " + kbPill(M.ok)
    );
    add("KB a mark split across chunks is left plain, never a lone backtick", kbRun([M.ok.slice(0, 2), M.ok.slice(2)]) === M.ok);
    add("KB an escaped backtick split across chunks opens nothing", kbRun(["a \\", "`" + M.ok]) === "a \\`" + kbPill(M.ok));
    add("KB a pill ending one chunk is kept apart from a backtick starting the next", kbRun(["done " + M.ok, "`x` next"]) === "done " + kbPill(M.ok) + ZW + "`x` next");
    add("KB a mark after a backslash that ended the last chunk stays as written", kbRun(["a \\", M.ok]) === "a \\" + M.ok);
    add("KB a CRLF split between chunks still ends the line", kbRun(["oops `open\r", "\n\r", "\n" + M.ok]) === "oops `open\r\n\r\n" + kbPill(M.ok));
    // Wiring: one badger per turn, shared by every markdown() call.
    const kbT = stream();
    const kbW = ext.__test.chatStream(kbT.response, kbT.token);
    kbW.markdown("```ts\n");
    kbW.markdown(`x = '${M.ok}'\n`);
    kbW.markdown("```\n");
    kbW.markdown(`${M.ok} done`);
    add(
        "KB chatStream keeps one badger per turn (fence state spans markdown calls)",
        kbT.chatMarkdown[1] === `x = '${M.ok}'\n` && kbT.chatMarkdown[3] === `${kbPill(M.ok)} done`
    );
    settings.kaomojiBadges = false;
    const kbOff = stream();
    await global.__handler({ prompt: "", command: "new" }, {}, kbOff.response, kbOff.token);
    settings.kaomojiBadges = true;
    add("KB kaomojiBadges:false sends marks bare", kbOff.chatMarkdown.join("").includes(M.ok) && !kbOff.chatMarkdown.join("").includes(kbPill(M.ok)));
    const kbOn = stream();
    await global.__handler({ prompt: "", command: "new" }, {}, kbOn.response, kbOn.token);
    add("KB /new's mark is a pill", kbOn.chatMarkdown.join("").includes(`${kbPill(M.ok)} Started`));

    // ==================== v183 ====================
    // NF: natural follow-ups. The chips under a finished answer are the next
    // moves the agent itself offered, in its words — or none. Real endings
    // first (the v179 review, the two lane answers), then the shapes that must
    // stay EMPTY: that half is what keeps "natural" from becoming noise.
    const nf = (agent, answer, steps = []) => ext.__test.naturalFollowups?.({ agent, answer, steps }) ?? [];
    const nfLabels = (chips) => chips.map((c) => c.label);
    const nfReview = nf("plan", "Solid overall.\n\nWant me to draft a concrete plan for any of these — e.g. updating the §1 map, extracting the catalog/compact constants, or aligning `chat-worktree.ts` against `handleChat` — or is this review the deliverable?");
    add("NF an 'any of these — e.g. A, B, or C' offer becomes three chips", nfReview.length === 3);
    add(
        "NF each keeps the agent's own verb and the item, and drops the '— or is this…' question",
        nfReview[0] && nfReview[0].prompt === `Draft a concrete plan for updating the §1 map. ${FJ.tail}` &&
            nfReview.every((c) => /^Draft a concrete plan for /.test(c.prompt) && !/deliverable/.test(c.prompt) && c.command === "plan")
    );
    // A cut label is a prefix of its action that ends at a word or after a '/'.
    const nfPath = nf("dev", "Done. Want me to fix src/components/authentication/LoginRedirectHandlerWithAVeryLongName.tsx?");
    const nfAtBoundary = (c) => {
        const head = c.label.endsWith("…") ? c.label.slice(0, -1) : undefined;
        return head === undefined || (c.prompt.startsWith(head) && (head.endsWith("/") || /^[\s,;:—–-]/.test(c.prompt.slice(head.length))));
    };
    add("NF a long action is cut at a word, never mid-word", [...nfReview, ...nfPath].every((c) => c.label.length <= (FJ.natural?.maxLabel ?? 56) && nfAtBoundary(c)));
    add("NF a long path is cut after a '/', not mid-name", nfPath[0]?.label === "Fix src/components/authentication/…");
    const nfLane = nf("plan", "Note: `README.md` is referenced by `ship-gate.js` but wasn't in your `scripts/` glob — let me know if you want the claim-anchor and documentation checks walked through too.");
    add("NF an offer after a dash, in participle form, reads as an action", nfLabels(nfLane).join("|") === "Walk through the claim-anchor and documentation checks");
    const nfOr = nf("dev", "The fix is on a scratch branch. Should I merge it into main or open a PR?");
    add("NF 'X or Y' between two actions is two chips", nfLabels(nfOr).join("|") === "Merge it into main|Open a PR" && nfOr.every((c) => c.command === "dev"));
    const nfWalk = nf("plan", "That's the flow. Would you like me to walk you through the SSE demultiplexer next?");
    add("NF the agent's 'you' becomes the user's 'me', and a trailing 'next' is dropped", nfLabels(nfWalk).join("|") === "Walk me through the SSE demultiplexer");
    const nfChoice = nf("plan", "Both work. Which do you prefer: integer cents or decimal.js?");
    add(
        "NF an either/or question becomes quick replies in the user's words",
        nfLabels(nfChoice).join("|") === "Integer cents|Decimal.js" && nfChoice[0].prompt === `Go with integer cents. ${FJ.tail}`
    );
    // The README ("How it behaves", 0.0.183) quotes this exact line. v183 first
    // shipped the bare "Postgres or MySQL?" there, which gives no chips.
    const nfReadme = nf("plan", "Both are fine. Which do you prefer: Postgres or MySQL?");
    add("NF the README's either/or example gives its two quick replies", nfLabels(nfReadme).join("|") === "Postgres|MySQL" && nfReadme[0].prompt === `Go with Postgres. ${FJ.tail}`);
    const nfAlso = nf("dev", "Fixed the loop bound. I can also add a regression test for the first-item case if you'd like.", [{ tool: "edit", filePath: "src/cart.js" }]);
    add(
        "NF an 'I can also … if you'd like' offer leads, then the file it touched",
        nfLabels(nfAlso).join("|") === ["Add a regression test for the first-item case", NL("review1", { file: "cart.js" }), NL("tests")].join("|")
    );
    add("NF tests already green in the answer → no 'Run the tests'", !nfLabels(nf("dev", "Applied the fix. All 4 tests pass.", [{ tool: "edit", filePath: "a.js" }])).includes(NL("tests")));
    add("NF 'Next, I'll …' puts Keep going first", nf("dev", "Fixed subtotal. Next, I'll handle the rounding.", [{ tool: "edit", filePath: "a.js" }])[0]?.label === NL("resume"));
    const nfIssue = nf("plan", "Found three bugs:\n1. **Off-by-one** in `subtotal()` — the loop starts at 1 and skips the first item entirely.\n2. **Tax order** is wrong.\n3. Rounding.");
    add(
        "NF only the LABEL is shortened; the prompt carries the whole item",
        nfIssue[0] && nfIssue[0].label.endsWith("…") && nfIssue[0].prompt.includes("skips the first item entirely.") && !/\w…/.test(nfIssue[0].prompt)
    );
    const nfIssueAll = nfLabels(nf("plan", "Found three bugs:\n1. **Off-by-one** in `subtotal()` — skips the first item.\n2. **Tax order** is wrong.\n3. Rounding."));
    add("NF an issue list offers to fix #1 and all of them", (nfIssueAll[0] || "").startsWith(NL("fix1", { item: "Off-by-one in subtotal()" })) && nfIssueAll.includes(NL("fixAll")));
    // Real endings from the v183 brevity runs (free OpenCode models, 2026-09-27).
    const nfFixPlan = nf("plan", "Found three bugs.\n\nWould you like me to create a fix plan, or do you have questions about any of these?");
    add("NF real: an offer to create a plan runs under plan, not /dev", nfLabels(nfFixPlan).join("|") === "Create a fix plan" && nfFixPlan[0].command === "plan");
    const nfApplyThese = nf("plan", "1. **Off-by-one** — `subtotal()` skips the first item.\n2. **Tax order** is inverted.\n\nWant me to apply these?");
    add(
        "NF real: 'Apply these' retires the duplicate 'Fix all of them'",
        nfApplyThese[0]?.label === "Apply these" && !nfLabels(nfApplyThese).includes(NL("fixAll")) && !nfLabels(nfApplyThese).includes(NL("apply"))
    );
    add(
        "NF real: an offer after 'Question:' splits into its two alternatives",
        nfLabels(nf("plan", "**Question:** Should I include the minor #4 hardening, or limit to the 3 load-bearing bugs covered by tests? No changes made — awaiting approval to implement.")).slice(0, 2).join("|") ===
            "Include the minor #4 hardening|Limit to the 3 load-bearing bugs covered by tests"
    );
    const nfWantA = nf("plan", "The order is inverted too. Want a plan to fix these?");
    add("NF real: 'Want a plan to …?' reads as an offer", nfLabels(nfWantA).join("|") === "Draft a plan to fix these" && nfWantA[0].command === "plan");
    // 0.0.193: a participle offer splits like a verb offer ("Add the docs
    // updated or the tests" shipped before).
    add(
        "NF 'X-ed or Y-ed' participle offers are two chips",
        nfLabels(nf("plan", "Done. Let me know if you would like the docs updated or the tests added.")).join("|") === "Update the docs|Add the tests"
    );
    const nfPart3 = nf("plan", "Done. Let me know if you want the caching fixed, the tests added or the logging removed.");
    add(
        "NF a participle list of three is three chips, each with its own verb",
        nfLabels(nfPart3).join("|") === "Fix the caching|Add the tests|Remove the logging" && nfPart3.every((c) => c.command === "dev")
    );
    add(
        "NF 'Next steps: A, B, and C' is three chips",
        nfLabels(nf("plan", "Next steps: run the load test, benchmark the parser, and update the docs.")).join("|") === "Run the load test|Benchmark the parser|Update the docs"
    );
    add("NF 'A, and B' stays one action in two steps", nfLabels(nf("dev", "Want me to run the tests, and fix any failures?")).join("|") === "Run the tests, and fix any failures");
    add(
        "NF a throw in the chip code costs the chips, not the turn",
        (() => {
            try {
                return Array.isArray(ext.__test.suggestFollowups({ agent: "dev", answer: "Done.", steps: undefined }));
            } catch {
                return false;
            }
        })()
    );
    const nfEmpty = [
        ["a yes/no question", nf("plan", "The comment says discounts apply before tax, but the code applies them after. Is that intended?")],
        ["a plain explanation", nf("plan", "The total is subtotal times 1.2, then the discount. Money is integer cents throughout.")],
        ["an explanation that happens to be numbered", nf("plan", "It runs in three stages:\n1. `subtotal()` sums price × qty.\n2. Tax is applied at 20%.\n3. The discount is applied last.")],
        ["'I can' as a statement, not an offer", nf("plan", "I can see the loop starts at index 1, which skips the first item.")],
        ["an answer that ends in code", nf("plan", "Use this:\n```js\nconst total = Math.round(x);\n```")],
        ["a markdown bullet list (not a diff)", nf("plan", "- If `out/` is missing, run the compile.\n- Otherwise nothing to do.")],
        ["a confirmation question (real)", nf("plan", "Question before implementing: confirm scope stays single-currency EUR, whole-cents?")],
        ["'say the word' (vague, real)", nf("dev", "The guard was not applied — say the word if you want it.")],
        // A bare "X or Y?" is an invitation as often as a choice; no chips.
        ["an invitation shaped like a choice", nf("plan", "That covers it. Questions or feedback?")],
        ["'Any questions or concerns?'", nf("plan", "That covers it. Any questions or concerns?")],
        ["a participle offer with a part that is no action", nf("plan", "Done. Let me know if you want more detail or the tests added.")]
    ];
    for (const [what, chips] of nfEmpty) {
        add(`NF no chips for ${what}`, chips.length === 0);
    }
    // It runs on every finished answer in the extension host: bound it on a
    // 250 KB answer and on inputs shaped to make a regex backtrack.
    const nfBig = "The loop starts at index 1, which skips the first item — e.g. one line, or two. ".repeat(3000) + "\n\nWant me to fix the loop, add a test, or open a PR?";
    const nfT0 = Date.now();
    const nfBigChips = nf("plan", nfBig);
    nf("plan", "Want me to draft a plan for any of these — e.g. " + "a, ".repeat(20000) + "or b?");
    nf("plan", "Should I " + "fix x or ".repeat(20000) + "stop?");
    const nfMs = Date.now() - nfT0;
    add(`NF a 250 KB answer and two backtracking traps take < 500ms (${nfMs}ms)`, nfMs < 500 && nfLabels(nfBigChips).join("|") === "Fix the loop|Add a test|Open a PR");

    // PW (v183): `opencode run` works in `process.env.PWD ?? process.cwd()`.
    // Every CLI turn must hand the chosen folder over as PWD as well as cwd.
    // The suite's own PWD is somewhere else, so the check can fail (it did on
    // v182: the fake saw the suite's PWD).
    settings.executable = happy;
    settings.transport = "cli";
    memento.clear();
    const pw = stream();
    await global.__handler({ prompt: "which directory are you in for pw" }, {}, pw.response, pw.token);
    const pwEnv = lastEnv("fake-ok.js");
    add("PW the suite's own PWD is not the workspace, so PW can fail", !samePath(process.env.PWD, work));
    add("PW a CLI turn hands OpenCode the folder as PWD", samePath(pwEnv.pwd, work));
    add("PW …and as cwd, as before", samePath(pwEnv.cwd, work));

    // The plan → dev handoff, through the real turn: a plan whose item 1 is an
    // instruction offers its step 1 first and the full handoff after it.
    settings.executable = writeFake("fake-plan.js", [
        { type: "text", sessionID: "ses_nfp", part: { text: "Plan:\n1. Fix the loop start in `subtotal()` (it skips the first item).\n2. Apply the discount before tax.\n3. Round the total to whole cents." } },
        { type: "step_finish", sessionID: "ses_nfp", part: { reason: "stop", cost: 0, tokens: { input: 10, output: 10, reasoning: 0, total: 20, cache: { read: 0, write: 0 } } } }
    ]);
    memento.clear();
    const nfp = stream();
    const nfpr = await global.__handler({ prompt: "plan the cart fixes for nf" }, {}, nfp.response, nfp.token);
    const nfpChips = global.__participant.followupProvider.provideFollowups(nfpr, {}, {}) || [];
    add(
        "NF a finished plan offers its named step 1, then the full handoff, both on /dev",
        nfpChips[0]?.label === NL("step1", { item: "Fix the loop start in subtotal()" }) &&
            nfpChips.some((c) => c.label === NL("apply")) &&
            nfpChips.every((c) => c.command === "dev")
    );
    settings.executable = happy;

    // KB (v183, v184): the chat stream must survive a stream whose methods live
    // on a prototype. v182 copied Object.keys() — a class-instance stream would
    // have come back with no progress(), no button(), nothing but markdown.
    class KbStream {
        constructor() { this.parts = []; }
        markdown(v) { this.parts.push(v); }
        progress(v, task) { this.parts.push(String(v)); void task; }
        button(b) { this.parts.push(b); }
        anchor(u, t) { return this.push({ u, t }); }
        push(p) { this.parts.push(p); }
    }
    const kbInst = Object.freeze(new KbStream());
    const kbWrap = ext.__test.chatStream?.(kbInst, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
    add(
        "KB a class-instance stream keeps every method, arity included",
        !!kbWrap && typeof kbWrap.button === "function" && typeof kbWrap.progress === "function" && kbWrap.progress.length === 2
    );
    kbWrap?.markdown(`> ${M.ok} done`);
    kbWrap?.anchor("u", "t");
    add(
        "KB …and still pills, and inherited methods still reach the stream",
        kbInst.parts[0] === `> \`${M.ok}\` done` && kbInst.parts[1] && kbInst.parts[1].u === "u"
    );

    // ==================== v184 ====================
    // Everything below runs against hostStream(): the real host's contract, not
    // a stub that runs every task and keeps every chunk.

    // GP (v184): every live line is plain; an accordion is sent FINISHED (rows
    // and result inside the task call), so nothing is ever left open.
    {
        const gpSaved = { e: settings.executable, t: settings.transport, g: settings.groupProgress, to: settings.timeoutMs };
        settings.executable = happy;
        settings.transport = "cli";
        settings.groupProgress = true;
        settings.timeoutMs = 30000;
        memento.clear();
        const gpH = hostStream();
        await gpH.invoke((api, token) => global.__handler({ prompt: "group the progress for gp" }, { history: [] }, api, token));
        await new Promise((r) => setTimeout(r, 30));
        const gpTasks = gpH.main.tasks.filter(Boolean);
        const gpThought = gpTasks.find((t) => t.title.startsWith(M.thought));
        add("GP a two-argument progress is detected as the task overload", ext.__test.supportsTaskProgress?.(gpH.response) === true);
        add("GP the one-argument stub stays on lines", !ext.__test.supportsTaskProgress?.(stream().response));
        add(
            "GP the Starting line is a plain line, never a task",
            gpH.lines().some((l) => /^Starting the OpenCode plan session/.test(l)) && !gpTasks.some((t) => /^Starting/.test(t.title))
        );
        add(
            "GP a thought and the tools that ran under it are one accordion",
            !!gpThought && gpThought.rows.length === 2 && /^grep: /.test(gpThought.rows[0]) && /^\S+ #read$/.test(gpThought.rows[1]) && / · 2 steps · /.test(gpThought.title)
        );
        add("GP no task is left open when the turn ends", gpTasks.length >= 1 && gpH.spinning().length === 0 && gpTasks.every((t) => t.settled));
        const gpTaskAt = gpH.main.parts.findIndex((p) => p.kind === "task");
        const gpAnswerAt = gpH.main.parts.findIndex((p) => p.kind === "markdownContent" && /stale cookie/.test(p.content));
        add("GP the accordion lands above the answer, not under it", gpTaskAt >= 0 && gpAnswerAt > gpTaskAt);
        add("GP live tool lines are plain and carry the elapsed time", gpH.lines().some((l) => /^grep: .* · \d+s( \/ \d+s)?$/.test(l)));
        add("GP Connecting is a plain line (it fades)", /response\.progress\("Connecting to the OpenCode server…"\)/.test(srcText));

        const hb = (h, title) => ext.__test.startHeartbeat(h.response, title, 0);
        // A run with no thoughts: "Working" accordions, capped per group.
        const cap = ext.__test.GROUP_MAX_ROWS ?? 24;
        const gpCapH = hostStream();
        const gpCap = hb(gpCapH, "cap test");
        for (let i = 0; i < cap + 5; i++) {
            gpCap.step({ tool: "bash", detail: `echo ${i} (running)`, status: "running" });
            gpCap.step({ tool: "bash", detail: `echo ${i}`, durationMs: 1, status: "done" });
        }
        await gpCap.stop();
        gpCap.step({ tool: "bash", detail: "after stop", durationMs: 1 });
        await new Promise((r) => setTimeout(r, 30));
        const gpWork = gpCapH.main.tasks.filter((t) => t && t.title.startsWith(`${M.tool} Working`));
        add("GP a thoughtless run groups under Working, capped per group", gpWork.length === 2 && gpWork.every((t) => t.rows.length <= cap));
        add("GP the running + done reports of one call are one row", gpWork.reduce((n, t) => n + t.rows.length, 0) === cap + 5);
        add("GP nothing is added after stop", !gpCapH.main.tasks.some((t) => t && t.rows.includes("bash: after stop")));
        add(
            "GP a bare running ping is not a row; a (running) suffix is dropped",
            ext.__test.stepLabel?.({ tool: "bash", detail: "running" }) === "" &&
                ext.__test.stepLabel?.({ tool: "bash", detail: "git status (running)" }) === "bash: git status"
        );
        add("GP every accordion arrives settled", gpCapH.spinning().length === 0 && gpWork.every((t) => t.settled));

        // A call that starts under one thought and finishes under the next.
        const gpSbH = hostStream();
        const gpSb = hb(gpSbH, "straddle");
        gpSb.thought("Reading the config first");
        gpSb.step({ tool: "bash", detail: "npm test (running)", status: "running" });
        gpSb.thought("Now the tests");
        gpSb.step({ tool: "bash", detail: "npm test", durationMs: 900, status: "done" });
        gpSb.step({ tool: "bash", detail: "npm test", durationMs: 800, status: "done" });
        await gpSb.stop();
        await new Promise((r) => setTimeout(r, 30));
        const gpSbTasks = gpSbH.main.tasks.filter(Boolean);
        add(
            "GP a call straddling two thoughts is one row; a real second run is another, under the new thought",
            gpSbTasks.length === 2 &&
                gpSbTasks[0].rows.join("|") === "bash: npm test" && /Reading the config first/.test(gpSbTasks[0].title) &&
                gpSbTasks[1].rows.join("|") === "bash: npm test" && /Now the tests/.test(gpSbTasks[1].title)
        );
        // A long path: shown relative to the workspace, and its running report
        // (the server's SSE) and done report (the CLI) stay one row.
        const gpLongH = hostStream();
        const gpLong = ext.__test.startHeartbeat(gpLongH.response, "long path", 0, work);
        const gpLongRel = path.join("packages", "cart-ui", "src", "components", "Cart.tsx");
        const gpLongPath = path.join(work, gpLongRel);
        gpLong.step({ tool: "read", detail: `${gpLongPath} (running)`, status: "running" });
        gpLong.step({ tool: "read", detail: gpLongPath, durationMs: 3, status: "done" });
        await gpLong.stop();
        await new Promise((r) => setTimeout(r, 30));
        const gpLongRows = gpLongH.main.tasks.filter(Boolean).flatMap((t) => t.rows);
        add(
            "GP a path inside the workspace is shown relative to it, running + done still one row",
            gpLongRows.length === 1 && gpLongRows[0] === `read: ${gpLongRel}`
        );
        add(
            "GP a long path outside the workspace keeps its end",
            /^read: …\S*Cart\.tsx$/.test(ext.__test.stepLabel?.({ tool: "read", detail: path.join(path.sep, "elsewhere", "x".repeat(40), gpLongRel) }, work) || "")
        );
        // The attached CLI prints a reasoning part when it completes — often
        // after its tool started. That thought names the group; it does not
        // close it and leave the tool in a "Working" group of its own.
        const gpLateH = hostStream();
        const gpLate = hb(gpLateH, "late thought");
        gpLate.step({ tool: "bash", detail: "sleep 40 (running)", status: "running" });
        gpLate.thought("Let me do that");
        gpLate.step({ tool: "bash", detail: "sleep 40", durationMs: 40000, status: "done" });
        await gpLate.stop();
        await new Promise((r) => setTimeout(r, 30));
        const gpLateTasks = gpLateH.main.tasks.filter(Boolean);
        add("GP a thought that lands mid-tool names that tool's group", gpLateTasks.length === 1 && gpLateTasks[0].title.startsWith(`${M.thought} Let me do that`) && gpLateTasks[0].rows.length === 1);

        const gpThinH = hostStream();
        const gpThin = hb(gpThinH, "thought only");
        gpThin.thought("First idea about the fix");
        gpThin.thought("Second idea, still no tools");
        const gpT0 = Date.now();
        await gpThin.stop();
        const gpThinMs = Date.now() - gpT0;
        add("GP a thought-only stretch sends no accordion", gpThinH.main.tasks.filter(Boolean).length === 0);
        add(`GP stop() waits nothing when no accordion is left to send (${gpThinMs}ms)`, gpThinMs < 50);
        const gpEndH = hostStream();
        const gpEnd = hb(gpEndH, "ends in a group");
        gpEnd.thought("Run the tests");
        gpEnd.step({ tool: "bash", detail: "npm test", durationMs: 5, status: "done" });
        const gpT1 = Date.now();
        await gpEnd.stop();
        const gpEndMs = Date.now() - gpT1;
        await new Promise((r) => setTimeout(r, 10));
        add(
            `GP a group still open at the end goes out finished, and stop() waits SETTLE_MS for its rows (${gpEndMs}ms)`,
            gpEndMs >= (ext.__test.SETTLE_MS ?? 1e9) - 5 && gpEndH.spinning().length === 0 && gpEndH.main.tasks.filter(Boolean).length === 1 && gpEndH.main.tasks[0].rows.length === 1
        );
        const gpCanH = hostStream();
        const gpCan = hb(gpCanH, "cancelled");
        gpCan.thought("Run the tests");
        gpCan.step({ tool: "bash", detail: "npm test (running)", status: "running" });
        gpCanH.cancel();
        const gpT2 = Date.now();
        await gpCan.stop(true);
        add(
            "GP after Stop, stop(true) sends nothing and waits nothing",
            Date.now() - gpT2 < 20 && gpCanH.main.tasks.filter(Boolean).length === 0 && gpCanH.stats.writesAfterCancel === 0
        );
        settings.groupProgress = false;
        memento.clear();
        const gpOff = hostStream();
        await gpOff.invoke((api, token) => global.__handler({ prompt: "lines please for gp" }, { history: [] }, api, token));
        settings.groupProgress = true;
        add("GP groupProgress:false keeps lines only, even on a task host", gpOff.main.tasks.length === 0 && gpOff.lines().some((l) => /^grep: /.test(l)));
        Object.assign(settings, { executable: gpSaved.e, transport: gpSaved.t, groupProgress: gpSaved.g, timeoutMs: gpSaved.to });
    }

    // TK (v184): the live line names what is running. v183 dropped a tool
    // whose first report had no input yet — a 40s `sleep` showed nothing until
    // it ended (reproduced with the real CLI: REFS "What VS Code does after Stop").
    {
        const tkH = hostStream();
        const tk = ext.__test.startHeartbeat(tkH.response, "tk", 0);
        tk.step({ tool: "bash", detail: "running", status: "running" });
        tk.step({ tool: "bash", detail: "sleep 40 && echo finished (running)", status: "running" });
        tk.thought("Let me do that.");
        await new Promise((r) => setTimeout(r, 10));
        add("TK a running tool is on the line even before its input is known", tkH.lines().some((l) => /^bash: running · /.test(l)));
        add("TK …and is named once its input arrives", tkH.lines().some((l) => /^bash: sleep 40 && echo finished · /.test(l)));
        add("TK a thought landing mid-tool does not take the line from the running tool", /^bash: sleep 40/.test(tkH.lines().pop() || ""));
        tk.step({ tool: "bash", detail: "sleep 40 && echo finished", durationMs: 40000, status: "done" });
        tk.phase("Handing off");
        await new Promise((r) => setTimeout(r, 10));
        add("TK a done report clears the running tool from the line", /^Handing off · /.test(tkH.lines().pop() || ""));
        await tk.stop();
    }

    // SP (v184): Stop. A fake server records the wire: spawns, the prompt a
    // server-transport turn holds open, and aborts — which it can answer slowly,
    // as a real server busy killing a tool does.
    {
        const spLog = [];
        const spStatus = {};
        const spSse = [];
        let spAbortDelay = 0;
        let spNext = 0;
        const spServer = http.createServer((req, res) => {
            const u = new URL(req.url, "http://x");
            const send = (code, payload) => {
                res.writeHead(code, { "content-type": "application/json" });
                res.end(JSON.stringify(payload));
            };
            if (u.pathname === "/global/health") return send(200, { healthy: true });
            if (u.pathname === "/global/event") {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.write(": hi\n\n");
                spSse.push(res);
                return;
            }
            if (u.pathname === "/__spawn") {
                spLog.push("spawn:" + u.searchParams.get("sid"));
                spStatus[u.searchParams.get("sid")] = { type: "busy" };
                return send(200, {});
            }
            if (u.pathname === "/__emit") {
                // What 1.18.32 streams for a bash call: pending with no input
                // yet, then running with it.
                const sid = u.searchParams.get("sid");
                const ev = (state) => ({ payload: { type: "message.part.updated", properties: { sessionID: sid, part: { id: "prt_sp", sessionID: sid, type: "tool", tool: "bash", state } } } });
                for (const r of spSse) r.write("data: " + JSON.stringify(ev({ status: "pending", input: {} })) + "\n\n");
                setTimeout(() => {
                    for (const r of spSse) r.write("data: " + JSON.stringify(ev({ status: "running", input: { command: "sleep 40 && echo finished", description: "Sleeps, then prints" }, time: { start: Date.now() } })) + "\n\n");
                }, 60);
                return send(200, {});
            }
            if (u.pathname === "/session/status") return send(200, spStatus);
            const abort = u.pathname.match(/^\/session\/([^/]+)\/abort$/);
            if (abort && req.method === "POST") {
                spLog.push("abort:" + abort[1]);
                setTimeout(() => {
                    delete spStatus[abort[1]];
                    send(200, true);
                }, spAbortDelay);
                return;
            }
            const msg = u.pathname.match(/^\/session\/([^/]+)\/message$/);
            if (msg && req.method === "POST") {
                // Held open: the server run is working until it is aborted.
                spLog.push("message:" + msg[1]);
                spStatus[msg[1]] = { type: "busy" };
                return;
            }
            if (req.method === "POST" && u.pathname === "/session") return send(200, { id: `ses_sp${++spNext}` });
            return send(200, {});
        });
        await new Promise((r) => spServer.listen(0, "127.0.0.1", r));
        // An attached CLI that reads a file, starts a long bash call, and hangs.
        const spFake = writeFake(
            "fake-sp-hang.js",
            [],
            "const http = require('http');\n" +
            "const a = process.argv; const url = a[a.indexOf('--attach') + 1];\n" +
            "const sid = a.includes('--session') ? a[a.indexOf('--session') + 1] : 'none';\n" +
            "const hit = (p) => new Promise((r) => http.get(url + p, (res) => { res.resume(); res.on('end', r); }).on('error', r));\n" +
            "(async () => { await hit('/__spawn?sid=' + sid);\n" +
            "  process.stdout.write(JSON.stringify({ type: 'reasoning', sessionID: sid, part: { text: 'Checking the loop first.' } }) + '\\n');\n" +
            "  process.stdout.write(JSON.stringify({ type: 'tool_use', sessionID: sid, part: { tool: 'read', state: { input: { filePath: 'src/cart.js' }, output: 'x', time: { start: 0, end: 5 } } } }) + '\\n');\n" +
            "  await hit('/__emit?sid=' + sid);\n" +
            "  setTimeout(() => {}, 60000); })();\n"
        );
        const spSaved = { t: settings.transport, p: settings.serverPort, h: settings.serverHostname, e: settings.executable, to: settings.timeoutMs, i: settings.idleTimeoutMs, g: settings.groupProgress, a: settings.attachDevToServer };
        Object.assign(settings, { transport: "auto", attachDevToServer: true, serverPort: spServer.address().port, serverHostname: "127.0.0.1", executable: spFake, timeoutMs: 0, idleTimeoutMs: 0, groupProgress: true });
        const spFirstSpawn = () => (spLog.find((l) => l.startsWith("spawn:")) || "").slice(6);

        // SP1: /dev, attached, Stop mid-run while the server is slow to abort.
        spAbortDelay = 3000;
        memento.clear();
        spLog.length = 0;
        const sp1 = hostStream();
        const sp1Run = sp1.invoke((api, token) => global.__handler({ prompt: "fix the cart loop for sp", command: "dev" }, { history: [] }, api, token));
        await waitFor(() => sp1.lines().some((l) => /^bash: sleep 40/.test(l)), 8000);
        add("TK a long server-side tool is named on the live line of a real attached turn", sp1.lines().some((l) => /^bash: sleep 40 && echo finished/.test(l)));
        sp1.cancel();
        const sp1Res = await sp1Run;
        await sp1Res.handlerTask.catch(() => undefined);
        await new Promise((r) => setTimeout(r, 100));
        const sp1Ms = sp1Res.timing().handlerAfterCancelMs;
        add(`SP after Stop the turn returns inside the host's one second, even with a slow server abort (${sp1Ms}ms)`, sp1Ms !== undefined && sp1Ms < 1000);
        add("SP …so the thread keeps its session: the result arrived and names it", sp1Res.result?.metadata?.sessionId === spFirstSpawn() && sp1Res.result?.metadata?.cancelled === true);
        add("SP nothing is sent after Stop, so nothing throws when the stream closes", sp1.stats.writesAfterCancel === 0 && sp1.stats.throwsAfterClose === 0);
        add("SP Stop leaves no spinner behind", sp1.spinning().length === 0);
        add("SP the status bar is back to idle, not spinning and not a failure", !!lastStatusItem && !/sync~spin|warning/.test(lastStatusItem.text) && !lastStatusItem.backgroundColor);
        await waitFor(() => spLog.includes("abort:" + spFirstSpawn()), 4000);
        add("SP the server run is aborted, not just the client", /^ses_sp\d+$/.test(spFirstSpawn()) && spLog.includes("abort:" + spFirstSpawn()));

        // SP2: a plan turn on the server transport, same slow abort.
        await new Promise((r) => setTimeout(r, spAbortDelay));
        memento.clear();
        spLog.length = 0;
        const sp2 = hostStream();
        const sp2Run = sp2.invoke((api, token) => global.__handler({ prompt: "explain the cart for sp" }, { history: [] }, api, token));
        await waitFor(() => spLog.some((l) => l.startsWith("message:")), 8000);
        sp2.cancel();
        const sp2Res = await sp2Run;
        await sp2Res.handlerTask.catch(() => undefined);
        const sp2Ms = sp2Res.timing().handlerAfterCancelMs;
        add(`SP a server-transport turn also returns inside one second of Stop (${sp2Ms}ms)`, sp2Ms !== undefined && sp2Ms < 1000);
        await waitFor(() => spLog.some((l) => l.startsWith("abort:")), 4000);
        add("SP …its server run is aborted, and nothing is left spinning or sent after Stop", spLog.some((l) => /^abort:ses_sp\d+$/.test(l)) && sp2.spinning().length === 0 && sp2.stats.writesAfterCancel === 0);

        // SP3: Stop before the run starts.
        await new Promise((r) => setTimeout(r, spAbortDelay));
        spAbortDelay = 0;
        memento.clear();
        spLog.length = 0;
        const sp3 = hostStream();
        const sp3LogFrom = logLines.length;
        sp3.cancel();
        const sp3Res = await sp3.invoke((api, token) => global.__handler({ prompt: "never runs for sp", command: "dev" }, { history: [] }, api, token));
        await sp3Res.handlerTask.catch(() => undefined);
        // Read the extension's own "$ <exe> run …" line: a child killed at once
        // may never get as far as reporting itself to the fake server.
        add("SP Stop before the run starts spawns nothing", !logLines.slice(sp3LogFrom).some((l) => /\$ .*fake-sp-hang/.test(l)));

        // SP4: /parallel with attached lanes.
        memento.clear();
        spLog.length = 0;
        const sp4 = hostStream();
        const sp4Run = sp4.invoke((api, token) => global.__handler({ prompt: "lane one sp | lane two sp", command: "parallel" }, { history: [] }, api, token));
        await waitFor(() => spLog.filter((l) => l.startsWith("spawn:")).length >= 2, 8000);
        sp4.cancel();
        const sp4Res = await sp4Run;
        await sp4Res.handlerTask.catch(() => undefined);
        const sp4Lanes = spLog.filter((l) => l.startsWith("spawn:")).map((l) => l.slice(6));
        await waitFor(() => sp4Lanes.every((sid) => spLog.includes("abort:" + sid)), 4000);
        add("SP /parallel: every attached lane runs in a session known up front", sp4Lanes.length === 2 && sp4Lanes.every((sid) => /^ses_sp\d+$/.test(sid)));
        add("SP /parallel: Stop aborts every lane on the server", sp4Lanes.length === 2 && sp4Lanes.every((sid) => spLog.includes("abort:" + sid)));

        // SP5: /worktree, in a git repo of its own.
        const spRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-spwt-"));
        const { execFileSync: spGit } = require("node:child_process");
        for (const args of [["init", "-q", "-b", "main"], ["commit", "-q", "--allow-empty", "-m", "base"]]) {
            spGit("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: spRepo, stdio: "pipe" });
        }
        const spFolders = vscodeStub.workspace.workspaceFolders;
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: spRepo }, name: path.basename(spRepo), index: 0 }];
        memento.clear();
        spLog.length = 0;
        const sp5 = hostStream();
        const sp5Run = sp5.invoke((api, token) => global.__handler({ prompt: "add a test for sp", command: "worktree" }, { history: [] }, api, token));
        await waitFor(() => spLog.some((l) => l.startsWith("spawn:")), 8000);
        sp5.cancel();
        const sp5Res = await sp5Run;
        await sp5Res.handlerTask.catch(() => undefined);
        await waitFor(() => spLog.includes("abort:" + spFirstSpawn()), 4000);
        vscodeStub.workspace.workspaceFolders = spFolders;
        add("SP /worktree: Stop aborts the worktree's server run", /^ses_sp\d+$/.test(spFirstSpawn()) && spLog.includes("abort:" + spFirstSpawn()));
        add(`SP /worktree: …and returns inside one second (${sp5Res.timing().handlerAfterCancelMs}ms)`, (sp5Res.timing().handlerAfterCancelMs ?? 1e9) < 1000);

        for (const r of spSse) r.end();
        spServer.closeAllConnections?.();
        spServer.close();
        Object.assign(settings, { transport: spSaved.t, serverPort: spSaved.p, serverHostname: spSaved.h, executable: spSaved.e, timeoutMs: spSaved.to, idleTimeoutMs: spSaved.i, groupProgress: spSaved.g, attachDevToServer: spSaved.a });
    }

    // QA (v184): the Quick Actions button. Its first item, Ask OpenCode (what
    // Enter picks), and "OpenCode: Ask in Chat" filled in "Continue from where
    // you stopped…" and called chat.open without isPartialQuery — which SUBMITS
    // (chatActions.ts acceptInput): every click started a run.
    {
        const executed = [];
        const realExec = vscodeStub.commands.executeCommand;
        const realPick = vscodeStub.window.showQuickPick;
        vscodeStub.commands.executeCommand = async (id, ...args) => {
            executed.push([id, ...args]);
            const handler = registeredCommands.get(id);
            return handler ? handler(...args) : undefined;
        };
        let picked;
        vscodeStub.window.showQuickPick = async (items) => ((picked = items), items[0]);
        await registeredCommands.get("opencodeCopilotBridge.quickActions")();
        const opened = executed.filter((c) => c[0] === "workbench.action.chat.open");
        // v190: Ask OpenCode merged into New session (both opened a chat with
        // @opencode typed); New session does it in a NEW chat.
        add("QA Quick Actions leads with New session; Ask OpenCode is gone", !!picked && /New session/.test(picked[0].label) && !picked.some((i) => /Ask OpenCode/.test(i.label)));
        add(
            "QA New session opens a new chat, types @opencode and sends nothing",
            executed.some((c) => c[0] === "workbench.action.chat.newChat") && opened.length === 1 && opened[0][1].query === "@opencode " && opened[0][1].isPartialQuery === true
        );
        executed.length = 0;
        await registeredCommands.get("opencodeCopilotBridge.retryLast")();
        add(
            "QA 'OpenCode: Ask in Chat' from the palette does the same",
            executed.length === 1 && executed[0][1].query === "@opencode " && executed[0][1].isPartialQuery === true
        );
        executed.length = 0;
        await registeredCommands.get("opencodeCopilotBridge.retryLast")("fix the loop");
        add("QA an explicit prompt is sent as given", executed.length === 1 && executed[0][1].query === "@opencode fix the loop" && !executed[0][1].isPartialQuery);
        vscodeStub.commands.executeCommand = realExec;
        vscodeStub.window.showQuickPick = realPick;
    }

    // RM (v184): the concise-vs-sharp experiment is gone, all of it.
    {
        const rmPkg = JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8"));
        const rmText = (f) => (fs.existsSync(path.join(repoDir, f)) ? fs.readFileSync(path.join(repoDir, f), "utf8") : "");
        add("RM no brevity probe script", !fs.existsSync(path.join(repoDir, "scripts", "probe-brevity.js")));
        add("RM no probe:brevity npm script", !(rmPkg.scripts && rmPkg.scripts["probe:brevity"]));
        add(
            "RM nothing names it: .vscodeignore, AGENTS, REFS, README, CHANGELOG",
            ![".vscodeignore", "AGENTS.md", "REFS.md", "README.md", "CHANGELOG.md"].some((f) => /probe-brevity|probe:brevity|Brevity phrase/.test(rmText(f)))
        );
        add("RM the tail is: Be short.", FJ.tail === "Be short." && P.CONTINUE.endsWith("Be short."));
        add("RM recovery chips are short again (Jan style)", Object.values(FJ.chips).every((c) => c.label.length <= 12));
    }

    // HS (v184): the chat stream every handler writes to.
    {
        const hsNone = { anchor() {}, markdown() {}, progress() {}, button() {} };
        const hs = hostStream();
        const hsStream = ext.__test.chatStream?.(hs.response, hs.token) ?? hsNone;
        hsStream.anchor({ fsPath: path.join(work, "a.ts") }, "a.ts");
        await new Promise((r) => setTimeout(r, 5));
        add("HS a host method built on `this` works through the stream", hs.main.parts.some((p) => p.kind === "inlineReference"));
        hs.cancel();
        hsStream.markdown("after stop");
        hsStream.progress("after stop");
        hsStream.button({ command: "x", title: "y" });
        add("HS nothing reaches the host after Stop", hs.stats.writesAfterCancel === 0);
        const hs2 = hostStream();
        const hs2Stream = ext.__test.chatStream?.(hs2.response, hs2.token) ?? hsNone;
        hs2.close();
        let hsThrew = false;
        try {
            hs2Stream.markdown("late");
            hs2Stream.progress("late");
        } catch {
            hsThrew = true;
        }
        add("HS a write racing the close is swallowed, never thrown into the turn", !hsThrew && hs2.stats.throwsAfterClose === 2);
    }

    // ==================== v185 ====================
    // GP (v185): the answer's first text closes the group a few ms before a
    // CLI turn ends (the CLI prints its final text and exits at once). v184's
    // stop() waited only for a group it sent itself, so the host ended the
    // request before the rows arrived and dropped them: a task with no rows
    // spins for good. The suite's own GP turn failed on exactly this, 2 of 4 runs.
    {
        const gpRaceH = hostStream();
        const gpRace = ext.__test.startHeartbeat(gpRaceH.response, "race", 0);
        gpRace.thought("Check the loop");
        gpRace.step({ tool: "read", detail: "src/cart.js", durationMs: 2, status: "done" });
        gpRace.activity();
        await gpRace.stop();
        gpRaceH.close();
        await new Promise((r) => setTimeout(r, 20));
        const gpRaceTasks = gpRaceH.main.tasks.filter(Boolean);
        add(
            "GP a group the answer closed just before the end still delivers its rows and settles",
            gpRaceTasks.length === 1 && gpRaceTasks[0].rows.join("|") === "read: src/cart.js" && gpRaceTasks[0].settled && gpRaceH.spinning().length === 0
        );
        const gpOldH = hostStream();
        const gpOld = ext.__test.startHeartbeat(gpOldH.response, "old group", 0);
        gpOld.thought("Early");
        gpOld.step({ tool: "read", detail: "a.js", durationMs: 1, status: "done" });
        gpOld.activity();
        await new Promise((r) => setTimeout(r, (ext.__test.SETTLE_MS ?? 0) + 20));
        const gpOldT = Date.now();
        await gpOld.stop();
        add(`GP …and a group sent long before the end costs stop() nothing (${Date.now() - gpOldT}ms)`, Date.now() - gpOldT < 20);
    }

    // PA (planAgent), HQ (headless asks), DM (which model answers). One fake
    // server records the wire: what the bridge sent, and what it replied.
    {
        const v5 = { agentCalls: [], sessions: [], messages: [], replies: [], summarize: [], sse: [], asks: [], mode: "answer", sessionMsgs: {}, held: [] };
        let v5Next = 0;
        // What GET /agent returns on 1.18.32 (trimmed): name, mode, hidden.
        const V5_AGENTS = [
            { name: "build", mode: "primary", native: true },
            { name: "plan", mode: "primary", native: true },
            { name: "explore", mode: "subagent", native: true },
            { name: "title", mode: "primary", native: true, hidden: true },
            { name: "look", mode: "primary", native: false }
        ];
        const v5Emit = (payload) => {
            for (const r of v5.sse) r.write("data: " + JSON.stringify({ payload }) + "\n\n");
        };
        const v5Waiters = new Map();
        const v5WaitReply = (id, ms) =>
            new Promise((resolve) => {
                const t = setTimeout(() => (v5Waiters.delete(id), resolve(false)), ms);
                v5Waiters.set(id, () => (clearTimeout(t), v5Waiters.delete(id), resolve(true)));
            });
        const v5Answer = (res, sid, model) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                info: { sessionID: sid, providerID: model.providerID, modelID: model.modelID, cost: 0, tokens: { input: 5, output: 2, reasoning: 0, total: 7, cache: { read: 0, write: 0 } } },
                parts: [{ type: "text", text: `answered by ${model.providerID}/${model.modelID}` }]
            }));
        };
        const V5_DEFAULT = { providerID: "oc", modelID: "server-default" };
        const v5Server = http.createServer((req, res) => {
            const u = new URL(req.url, "http://x");
            const send = (code, payload) => {
                res.writeHead(code, { "content-type": "application/json" });
                res.end(JSON.stringify(payload));
            };
            if (u.pathname === "/global/health") return send(200, { healthy: true });
            if (u.pathname === "/global/event") {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.write(": hi\n\n");
                v5.sse.push(res);
                return;
            }
            if (u.pathname === "/agent") {
                v5.agentCalls.push(u.searchParams.get("directory"));
                if (v5.agentFail) return send(500, { name: "UnknownError", data: { message: "Unexpected server error" } });
                return send(200, V5_AGENTS);
            }
            if (u.pathname === "/session/status") return send(200, {});
            if (u.pathname === "/__ask") {
                // An attached CLI's session asks a question and a permission.
                const sid = u.searchParams.get("sid");
                v5Emit({ type: "question.asked", properties: { id: "que_a1", sessionID: sid, questions: [{ question: "Tabs or spaces?", header: "Indent", options: [] }] } });
                v5Emit({ type: "permission.asked", properties: { id: "per_a1", sessionID: sid, permission: "external_directory", patterns: ["/etc/*"] } });
                // 1.18.32: message.updated is { sessionID, info }; info alone names it too.
                const infoOnly = u.searchParams.get("shape") === "info";
                const info = { id: "msg_att", sessionID: sid, role: "assistant", providerID: "att", modelID: infoOnly ? "m2" : "m1" };
                v5Emit({ type: "message.updated", properties: infoOnly ? { info } : { sessionID: sid, info } });
                return send(200, {});
            }
            let raw = "";
            req.on("data", (c) => (raw += c));
            req.on("end", async () => {
                const body = raw ? JSON.parse(raw) : undefined;
                const dir = u.searchParams.get("directory");
                if (req.method === "POST" && u.pathname === "/session") {
                    const id = `ses_v5${++v5Next}`;
                    v5.sessions.push({ id, body, dir });
                    return send(200, { id });
                }
                const reply = u.pathname.match(/^\/(permission|question)\/([^/]+)\/reply$/);
                if (reply && req.method === "POST") {
                    v5.replies.push({ kind: reply[1], id: reply[2], body, dir });
                    v5Waiters.get(reply[2])?.();
                    return send(200, true);
                }
                const sum = u.pathname.match(/^\/session\/([^/]+)\/summarize$/);
                if (sum && req.method === "POST") {
                    v5.summarize.push({ sid: sum[1], body, dir });
                    return send(200, true);
                }
                const aborted = u.pathname.match(/^\/session\/([^/]+)\/abort$/);
                if (aborted) {
                    // What 1.18.32 does: the prompt loop is cancelled (and reports
                    // MessageAbortedError) before the abort call itself returns.
                    v5Emit({ type: "session.error", properties: { sessionID: aborted[1], error: { name: "MessageAbortedError", data: { message: "Aborted" } } } });
                    for (const h of v5.held.splice(0)) h.end();
                    setTimeout(() => send(200, true), 150);
                    return;
                }
                const msg = u.pathname.match(/^\/session\/([^/]+)\/message$/);
                if (msg && req.method === "GET") {
                    v5.messageGets = (v5.messageGets ?? 0) + 1;
                    return send(200, v5.sessionMsgs[msg[1]] ?? []);
                }
                if (msg && req.method === "POST") {
                    const sid = msg[1];
                    v5.messages.push({ sid, body, dir });
                    if (v5.mode === "fail-post") return send(500, { name: "UnknownError", data: { message: "Unexpected server error" } });
                    if (v5.mode === "tool-silent") {
                        // A tool the server reports as running, then only heartbeats.
                        v5Emit({ type: "message.part.updated", properties: { sessionID: sid, part: { id: "prt_ts", sessionID: sid, type: "tool", tool: "bash", state: { status: "running", input: { command: "npm test" }, time: { start: Date.now() } } } } });
                    }
                    if (v5.mode === "heartbeat" || v5.mode === "tool-silent") {
                        // Held; the only traffic is what 1.18.32 sends every ~10s
                        // to everyone: server.heartbeat, no session. Gives up at 6s.
                        const beat = setInterval(() => v5Emit({ type: "server.heartbeat", properties: {} }), 150);
                        v5.held.push({ end: () => clearInterval(beat) });
                        setTimeout(() => {
                            clearInterval(beat);
                            v5Answer(res, sid, V5_DEFAULT);
                        }, 6000);
                        return;
                    }
                    if (v5.mode === "stall-first" && !body.model) {
                        // A model stall: the assistant message exists (and names
                        // the model OpenCode picked), but nothing ever comes back.
                        v5Emit({ type: "message.updated", properties: { sessionID: sid, info: { id: "msg_s", sessionID: sid, role: "assistant", providerID: "prov", modelID: "primary" } } });
                        v5.held.push(res);
                        return;
                    }
                    if (v5.mode === "asks") {
                        for (const ask of v5.asks) {
                            const props = { ...ask.properties, sessionID: ask.properties.sessionID ?? sid };
                            v5Emit({ type: ask.type, properties: props });
                            if (ask.type !== "session.created") {
                                // A real server waits for good; the fake gives up
                                // after 3s so a regression fails instead of hanging.
                                await v5WaitReply(props.id, ask.wait ?? 3000);
                            }
                        }
                    }
                    return v5Answer(res, sid, body.model ?? V5_DEFAULT);
                }
                return send(200, {});
            });
        });
        await new Promise((r) => v5Server.listen(0, "127.0.0.1", r));
        const v5Saved = { ...settings };
        Object.assign(settings, {
            transport: "server",
            serverPort: v5Server.address().port,
            serverHostname: "127.0.0.1",
            serverStartupPollMs: 20,
            executable: happy,
            timeoutMs: 30000,
            idleTimeoutMs: 0,
            model: "",
            fallbackModels: [],
            planAgent: "plan",
            autoCompact: false
        });
        const v5Turn = async (prompt, extra = {}, history = []) => {
            const h = hostStream();
            const r = await h.invoke((api, token) => global.__handler({ prompt, ...extra }, { history }, api, token));
            await new Promise((res) => setTimeout(res, 30));
            const md = h.main.parts.filter((p) => p.kind === "markdownContent").map((p) => plain(p.content)).join("");
            return { h, result: r.result, md };
        };
        const v5Hist = (...turns) => turns.map((t, i) => ({ participant: "opencodeCopilotBridge.chat", prompt: `turn ${i}`, result: t.result }));
        const lastMsg = () => v5.messages[v5.messages.length - 1] || { body: {} };
        const count = (text, re) => (text.match(re) || []).length;

        // ---- PA: which agent a read-only turn runs as ----
        const pa1 = await v5Turn("explain the cart for pa one");
        add("PA the default planAgent runs the built-in plan", lastMsg().body.agent === "plan" && /answered by/.test(pa1.md));
        add("PA the default costs nothing: no agent lookup", v5.agentCalls.length === 0);

        settings.planAgent = "look";
        const pa2 = await v5Turn("explain the cart for pa two");
        add("PA planAgent=look, listed by OpenCode, runs as look", lastMsg().body.agent === "look" && !/No `look` agent/.test(pa2.md));
        add("PA the agent lookup is scoped to this folder", v5.agentCalls.length === 1 && v5.agentCalls[0] === work);
        await v5Turn("explain the cart for pa three");
        add("PA the lookup is cached across turns", v5.agentCalls.length === 1 && lastMsg().body.agent === "look");

        settings.planAgent = "ghost";
        const pa4 = await v5Turn("explain the cart for pa four");
        add("PA an agent OpenCode does not list runs as plan, never as itself", lastMsg().body.agent === "plan");
        add("PA …and says so exactly once", count(pa4.md, /No `ghost` agent in OpenCode/g) === 1);
        const pa5 = await v5Turn("explain the cart for pa five");
        add("PA …once per window: the next turn only logs it", lastMsg().body.agent === "plan" && count(pa5.md, /`ghost`/g) === 0 && logLines.some((l) => /planAgent "ghost" not usable \(missing\)/.test(l)));

        settings.planAgent = "explore";
        const pa6 = await v5Turn("explain the cart for pa six");
        add("PA a subagent name runs as plan, with its own notice", lastMsg().body.agent === "plan" && /`explore` is a subagent/.test(pa6.md));
        settings.planAgent = "title";
        const pa7 = await v5Turn("explain the cart for pa seven");
        add("PA a hidden agent runs as plan, with its own notice", lastMsg().body.agent === "plan" && /`title` is a hidden agent/.test(pa7.md));

        settings.planAgent = "look";
        const pa8 = await v5Turn("add a test for pa eight", { command: "dev" });
        add("PA /dev is untouched: it runs devAgent", lastMsg().body.agent === "build" && /answered by/.test(pa8.md));

        // Lanes: attached to the same server, so the listing is the cached one.
        settings.transport = "auto";
        settings.attachDevToServer = true;
        const paLanes = await v5Turn("lane a for pa | lane b for pa", { command: "parallel" });
        const paLaneArgv = lastArgv("fake-ok.js");
        add("PA /parallel lanes run as planAgent", paLaneArgv[paLaneArgv.indexOf("--agent") + 1] === "look" && paLaneArgv.includes("--attach"));
        add("PA …a read-only lane never passes --auto", !paLaneArgv.includes("--auto"));
        add("PA …and the lane header names the agent", /read-only `look` agent/.test(paLanes.md));

        // No server (transport cli): ask `opencode agent list` in this folder.
        const agentsFake = writeFake(
            "fake-agents.js",
            [],
            "const fsx = require('fs');\n" +
            "if (process.argv.includes('agent') && process.argv.includes('list')) {\n" +
            "  fsx.appendFileSync(" + JSON.stringify(path.join(work, "fake-agents.listed")) + ", 'x');\n" +
            "  process.stdout.write('build (primary)\\n  [\\n  {\\n    \"permission\": \"*\"\\n  }\\n]\\nexplore (subagent)\\n  [\\n]\\nlook (primary)\\n  [\\n]\\n');\n" +
            "  process.exit(0);\n" +
            "}\n" +
            "process.stdout.write(JSON.stringify({ type: 'text', sessionID: 'ses_pacli', part: { text: 'cli answer' } }) + '\\n');\n"
        );
        const listedCount = () => (fs.existsSync(path.join(work, "fake-agents.listed")) ? fs.readFileSync(path.join(work, "fake-agents.listed"), "utf8").length : 0);
        Object.assign(settings, { transport: "cli", executable: agentsFake, planAgent: "look" });
        const paCli = await v5Turn("explain the cart for pa cli");
        const paCliArgv = lastArgv("fake-agents.js");
        add("PA with no server, `opencode agent list` confirms the agent", listedCount() === 1 && paCliArgv[paCliArgv.indexOf("--agent") + 1] === "look" && /cli answer/.test(paCli.md));
        add("PA …a CLI plan turn never passes --auto", paCliArgv[1] !== undefined && !paCliArgv.includes("--auto"));
        settings.planAgent = "lookk";
        const paCli2 = await v5Turn("explain the cart for pa typo");
        const paCli2Argv = lastArgv("fake-agents.js");
        add(
            "PA a typo never reaches `opencode run --agent` (it would run BUILD): plan, and a notice",
            paCli2Argv[paCli2Argv.indexOf("--agent") + 1] === "plan" && /No `lookk` agent/.test(paCli2.md) && listedCount() === 1
        );
        const paCliDev = await v5Turn("add a test for pa cli dev", { command: "dev" });
        const paCliDevArgv = lastArgv("fake-agents.js");
        add("PA …while a CLI /dev turn still auto-approves", paCliDevArgv.includes("--auto") && paCliDevArgv[paCliDevArgv.indexOf("--agent") + 1] === "build" && /cli answer/.test(paCliDev.md));
        // Stop while a cold `opencode agent list` is still running: the turn
        // must return inside the host's one second (v184), not after the list.
        const slowAgents = writeFake(
            "fake-agents-slow.js",
            [],
            "if (process.argv.includes('agent') && process.argv.includes('list')) {\n" +
            "  setTimeout(() => { process.stdout.write('look (primary)\\n'); process.exit(0); }, 5000);\n" +
            "} else { process.stdout.write(JSON.stringify({ type: 'text', sessionID: 'ses_slow', part: { text: 'should not run' } }) + '\\n'); }\n"
        );
        Object.assign(settings, { executable: slowAgents, planAgent: "look" });
        // A folder of its own: the listing above is cached per folder for 60s.
        const paStopDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-pastop-"));
        const paStopFolders = vscodeStub.workspace.workspaceFolders;
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: paStopDir }, name: path.basename(paStopDir), index: 0 }];
        const paStopLogFrom = logLines.length;
        const paStop = hostStream();
        const paStopRun = paStop.invoke((api, token) => global.__handler({ prompt: "explain the cart for pa stop" }, { history: [] }, api, token));
        await waitFor(() => logLines.slice(paStopLogFrom).some((l) => /\$ .*fake-agents-slow\.js agent list/.test(l)), 4000);
        paStop.cancel();
        const paStopRes = await paStopRun;
        await paStopRes.handlerTask.catch(() => undefined);
        const paStopMs = paStopRes.timing().handlerAfterCancelMs;
        add(
            `PA Stop during a slow agent lookup returns inside the host's second, and runs nothing (${paStopMs}ms)`,
            paStopMs !== undefined && paStopMs < 1000 && paStopRes.result?.metadata?.cancelled === true &&
                !logLines.slice(paStopLogFrom).some((l) => /\$ .*fake-agents-slow\.js run /.test(l))
        );
        // …and the same for /parallel: its lanes must not start after Stop.
        const paPStopDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-papstop-"));
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: paPStopDir }, name: path.basename(paPStopDir), index: 0 }];
        const paPStopLogFrom = logLines.length;
        const paPStop = hostStream();
        const paPStopRun = paPStop.invoke((api, token) => global.__handler({ prompt: "lane a for stop | lane b for stop", command: "parallel" }, { history: [] }, api, token));
        await waitFor(() => logLines.slice(paPStopLogFrom).some((l) => /\$ .*fake-agents-slow\.js agent list/.test(l)), 4000);
        paPStop.cancel();
        const paPStopRes = await paPStopRun;
        await paPStopRes.handlerTask.catch(() => undefined);
        const paPStopMs = paPStopRes.timing().handlerAfterCancelMs;
        add(
            `PA Stop during /parallel's agent lookup returns inside the host's second, and starts no lane (${paPStopMs}ms)`,
            paPStopMs !== undefined && paPStopMs < 1000 && paPStopRes.result?.metadata?.cancelled === true &&
                !logLines.slice(paPStopLogFrom).some((l) => /\$ .*fake-agents-slow\.js run /.test(l))
        );
        vscodeStub.workspace.workspaceFolders = paStopFolders;
        Object.assign(settings, { executable: agentsFake, planAgent: "look" });
        const paParsed = ext.__test.parseAgentList?.(
            "build (primary)\n  [\n  {\n    \"permission\": \"*\",\n    \"action\": \"allow\"\n  }\n]\nexplore (subagent)\n  [\n]\nteam/look (primary)\n  [\n]\nsome agent (all)\n"
        );
        add(
            "PA the `opencode agent list` format parses: names (nested too), modes, no JSON lines",
            JSON.stringify(paParsed) === JSON.stringify([
                { name: "build", mode: "primary" },
                { name: "explore", mode: "subagent" },
                { name: "team/look", mode: "primary" },
                { name: "some agent", mode: "all" }
            ])
        );
        // The built-in plan keeps --auto on the CLI: without it the first ask
        // ends the turn (0.0.184 parity). Only a planAgent of your own goes without.
        const argvOf = (name) => path.join(work, name + ".argv");
        settings.planAgent = "plan";
        fs.rmSync(argvOf("fake-agents.js"), { force: true });
        const paBuiltCli = await v5Turn("explain the cart for pa built-in cli");
        const paBuiltArgv = lastArgv("fake-agents.js");
        add("PA the built-in plan keeps --auto on the CLI, as in 0.0.184", paBuiltArgv[paBuiltArgv.indexOf("--agent") + 1] === "plan" && paBuiltArgv.includes("--auto") && /cli answer/.test(paBuiltCli.md));

        // A listing that fails never lets an unconfirmed name through (the CLI
        // runs an unknown one as BUILD): plan, and a notice on every such turn.
        const paInDir = async (dir, run) => {
            const saved = vscodeStub.workspace.workspaceFolders;
            vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: dir }, name: path.basename(dir), index: 0 }];
            try {
                return await run();
            } finally {
                vscodeStub.workspace.workspaceFolders = saved;
            }
        };
        const paFailCli = writeFake(
            "fake-agents-fail.js",
            [],
            "if (process.argv.includes('agent') && process.argv.includes('list')) { process.stderr.write('boom'); process.exit(1); }\n" +
            "process.stdout.write(JSON.stringify({ type: 'text', sessionID: 'ses_pafail', part: { text: 'fail answer' } }) + '\\n');\n"
        );
        Object.assign(settings, { executable: paFailCli, planAgent: "look" });
        const paFailDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-pafail-"));
        const paF1 = await paInDir(paFailDir, () => v5Turn("explain the cart for pa fail one"));
        const paF1Argv = lastArgv("fake-agents-fail.js");
        const paF2 = await paInDir(paFailDir, () => v5Turn("explain the cart for pa fail two"));
        add("PA `opencode agent list` failing: plan, never the unconfirmed name", paF1Argv[paF1Argv.indexOf("--agent") + 1] === "plan" && /fail answer/.test(paF1.md));
        add("PA …and a notice on every such turn", [paF1, paF2].every((t) => /Couldn't list OpenCode's agents to confirm `look`/.test(t.md)));
        Object.assign(settings, { transport: "server", executable: happy });
        v5.agentFail = true;
        const paS1 = await paInDir(paFailDir, () => v5Turn("explain the cart for pa server list fail"));
        add("PA a server that cannot list its agents: plan too, and the notice", lastMsg().body.agent === "plan" && /Couldn't list OpenCode's agents to confirm `look`/.test(paS1.md) && /answered by/.test(paS1.md));
        Object.assign(settings, { transport: "auto", attachDevToServer: true });
        fs.rmSync(argvOf("fake-ok.js"), { force: true });
        const paLF = await paInDir(paFailDir, () => v5Turn("lane a for pa fail | lane b for pa fail", { command: "parallel" }));
        const paLFArgv = lastArgv("fake-ok.js");
        add(
            "PA lanes that cannot confirm planAgent run the built-in plan, with --auto as in 0.0.184",
            paLFArgv[paLFArgv.indexOf("--agent") + 1] === "plan" && paLFArgv.includes("--auto") && /Couldn't list OpenCode's agents to confirm `look`/.test(paLF.md)
        );
        v5.agentFail = false;
        // The server confirmed `look`, then failed mid-turn: the CLI that takes
        // over never confirmed it, so it runs the turn as plan and says so.
        Object.assign(settings, { transport: "server", executable: agentsFake, planAgent: "look" });
        fs.rmSync(argvOf("fake-agents.js"), { force: true });
        const paModeSaved = v5.mode;
        v5.mode = "fail-post";
        const paSF = await v5Turn("explain the cart for pa server down");
        v5.mode = paModeSaved;
        const paSFArgv = lastArgv("fake-agents.js");
        add(
            "PA a server that confirmed planAgent, then failed: the CLI runs the turn as plan",
            lastMsg().body.agent === "look" && paSFArgv[paSFArgv.indexOf("--agent") + 1] === "plan" && /cli answer/.test(paSF.md) && /the CLI ran this turn as the built-in `plan`/.test(paSF.md)
        );
        fs.rmSync(paFailDir, { recursive: true, force: true });
        Object.assign(settings, { transport: "server", executable: happy, planAgent: "plan" });

        // ---- HQ: nobody can answer OpenCode's prompts in a chat turn ----
        const hqRules = (s) =>
            Array.isArray(s.body?.permission) &&
            ["question", "plan_enter", "plan_exit"].every((p) => s.body.permission.some((r) => r.permission === p && r.action === "deny" && r.pattern === "*"));
        add(`HQ every session the bridge creates denies question / plan_enter / plan_exit, as \`opencode run\` does (${v5.sessions.length})`, v5.sessions.length >= 8 && v5.sessions.every(hqRules));

        v5.mode = "asks";
        v5.asks = [
            { type: "permission.asked", properties: { id: "per_p1", permission: "external_directory", patterns: ["/etc/*"] } },
            { type: "question.asked", properties: { id: "que_q1", questions: [{ question: "Tabs or spaces?", header: "Indent", options: [] }, { question: "Which file?", header: "File", options: [] }] } },
            { type: "session.created", properties: { info: { id: "ses_child1", parentID: "@parent" } } },
            { type: "permission.asked", properties: { id: "per_c1", sessionID: "ses_child1", permission: "read", patterns: ["/x/.env"] } },
            { type: "permission.asked", properties: { id: "per_x1", sessionID: "ses_someone_else", permission: "bash", patterns: ["rm -rf /"] }, wait: 300 }
        ];
        // the child's parent is whatever session this turn gets
        const hqCreated = v5.sessions.length;
        v5.asks[2].properties.info.parentID = `ses_v5${hqCreated + 1}`;
        v5.replies.length = 0;
        const hqT0 = Date.now();
        const hq1 = await v5Turn("read /etc/hostname for hq");
        const hqMs = Date.now() - hqT0;
        const rep = (id) => v5.replies.find((r) => r.id === id);
        // Four asks the fake waits up to 3s each for: answered, the turn takes
        // well under one wait (the foreign ask's 300ms is the floor).
        add(`HQ a plan turn's asks are answered, not left to hang (${hqMs}ms)`, /answered by/.test(hq1.md) && hqMs < 2500);
        add(
            "HQ …a read-only turn rejects WITH feedback, so the model carries on",
            rep("per_p1")?.body?.reply === "reject" && rep("per_p1")?.body?.message === P.READ_ONLY && rep("per_p1")?.dir === work
        );
        add(
            "HQ a question is answered with 'ask in your reply', once per question",
            JSON.stringify(rep("que_q1")?.body) === JSON.stringify({ answers: [[P.NO_QUESTIONS], [P.NO_QUESTIONS]] }) && rep("que_q1")?.dir === work
        );
        add("HQ a subagent's ask (the task tool's child session) is answered too", rep("per_c1")?.body?.reply === "reject");
        add("HQ another session's ask is never answered", !rep("per_x1"));

        v5.asks = [{ type: "permission.asked", properties: { id: "per_d1", permission: "external_directory", patterns: ["/tmp/*"] } }];
        v5.replies.length = 0;
        const hq2 = await v5Turn("touch /tmp/x for hq", { command: "dev" });
        add("HQ an editing turn on the server approves once, like `run --auto`", rep("per_d1")?.body?.reply === "once" && !("message" in (rep("per_d1")?.body ?? {})) && /answered by/.test(hq2.md));

        // Attached: the CLI answers permission asks itself; questions it never does.
        v5.mode = "answer";
        const attachedFake = (name, query) =>
            writeFake(
                name,
                [],
                "const http = require('http');\n" +
                "const a = process.argv; const url = a[a.indexOf('--attach') + 1]; const sid = a[a.indexOf('--session') + 1];\n" +
                "setTimeout(() => http.get(url + '/__ask?sid=' + sid + '" + query + "', (res) => { res.resume(); res.on('end', () => setTimeout(() => {\n" +
                "  process.stdout.write(JSON.stringify({ type: 'text', sessionID: sid, part: { text: 'attached done' } }) + '\\n'); process.exit(0); }, 700)); }), 300);\n"
            );
        const hqAttached = attachedFake("fake-hq-attached.js", "");
        Object.assign(settings, { transport: "auto", attachDevToServer: true, executable: hqAttached });
        v5.replies.length = 0;
        const hq3 = await v5Turn("fix it attached for hq", { command: "dev" });
        await waitFor(() => !!rep("que_a1"), 1500);
        add("HQ an attached run's question is answered by the bridge", /attached done/.test(hq3.md) && JSON.stringify(rep("que_a1")?.body) === JSON.stringify({ answers: [[P.NO_QUESTIONS]] }));
        add("HQ …but its permission asks are left to the CLI (no double reply)", !rep("per_a1"));
        // The attached CLI's stdout names no model; the session's message.updated
        // does (1.18.32: { sessionID, info }), so the turn records what answered.
        add("DM an attached run records the model that answered, from the session's events", hq3.result?.metadata?.model === "att/m1");
        settings.executable = attachedFake("fake-hq-attached2.js", "&shape=info");
        const hq4 = await v5Turn("fix it attached for dm", { command: "dev" });
        add("DM …also when only the event's info names the session", /attached done/.test(hq4.md) && hq4.result?.metadata?.model === "att/m2");
        Object.assign(settings, { transport: "server", executable: happy });

        // LT7: a server-path run is not kept alive by server.heartbeat. The
        // demux hands unattributed events to every subscriber, and v184 counted
        // them as the run's own: a turn blocked on an ask never hit the idle cap
        // (real 1.18.32: >140s with idleTimeoutMs 60s, killed by hand).
        v5.mode = "heartbeat";
        settings.idleTimeoutMs = 1200;
        const ltT0 = Date.now();
        const lt7 = await v5Turn("a run that goes silent for lt7");
        const ltMs = Date.now() - ltT0;
        add(`LT7 a server-transport run that goes silent hits the idle cap despite server.heartbeat (${ltMs}ms)`, lt7.result?.metadata?.timedOut === true && ltMs < 4500);
        add("LT7 …and the bridge's own abort is not reported as OpenCode's error", !/reported an error/.test(lt7.md) && !lt7.result?.metadata?.error);
        // …and, like the attached CLI (v177), a tool the server reports as
        // running earns toolQuietMs of silence, then is named as the cause.
        v5.mode = "tool-silent";
        const ltToolSaved = settings.toolQuietMs;
        settings.toolQuietMs = 3000;
        const lt8T0 = Date.now();
        const lt8 = await v5Turn("a silent tool for lt8");
        const lt8Ms = Date.now() - lt8T0;
        add(
            `LT7 a running tool on the server path gets toolQuietMs, not idleTimeoutMs, and is named (${lt8Ms}ms)`,
            lt8.result?.metadata?.timedOut === true && lt8Ms >= 2900 && lt8Ms < 5800 && /Stopped while `bash` was still running/.test(lt8.md)
        );
        settings.toolQuietMs = ltToolSaved;
        settings.idleTimeoutMs = 0;
        v5.mode = "answer";

        // ---- DM: which model answers, and what the bridge does with it ----
        const dm1 = await v5Turn("which model for dm one");
        add("DM with no pin, no model is sent (OpenCode picks)", lastMsg().body.model === undefined);
        add("DM the model that ANSWERED is recorded, not the (absent) pin", dm1.result?.metadata?.model === "oc/server-default");
        const dmSess = await v5Turn("", { command: "session" }, v5Hist(dm1));
        add("DM /session names the model the session last ran on", /on `oc\/server-default`/.test(dmSess.md));
        const dmModel = await v5Turn("", { command: "model" }, v5Hist(dm1));
        add(
            "DM /model with no pin says what OpenCode actually does",
            /No model pinned — OpenCode picks: a new session starts on .+, and a session keeps the model it last ran on\./.test(dmModel.md) &&
                /last ran on `oc\/server-default`/.test(dmModel.md)
        );
        const dmPin = await v5Turn("model:prov/inline which model for dm pin");
        add("DM an inline pin is sent, and recorded as what answered", lastMsg().body.model?.modelID === "inline" && dmPin.result?.metadata?.model === "prov/inline");

        // Compaction summarizes with the session's own model — never the
        // catalog's first entry (≤0.0.184: `opencode/big-pickle` for a session
        // on github-copilot/claude-sonnet-4.6).
        globalMemento.set("opencode.models.v1", { models: ["aaa/first-in-catalog", "prov/pick"], fetchedAt: Date.now() });
        Object.assign(settings, { autoCompact: true, autoCompactEveryTurns: 1 });
        v5.summarize.length = 0;
        const dm2 = await v5Turn("which model for dm compact");
        await waitFor(() => v5.summarize.length > 0, 3000);
        const dmSum = v5.summarize[0];
        add(
            "DM compaction summarizes with the model that answered, scoped to the turn's folder",
            !!dmSum && dmSum.sid === dm2.result?.metadata?.sessionId && dmSum.body.providerID === "oc" && dmSum.body.modelID === "server-default" && dmSum.dir === work
        );
        add("DM …never the catalog's first model", !v5.summarize.some((s) => s.body.modelID === "first-in-catalog"));
        Object.assign(settings, { autoCompact: false, autoCompactEveryTurns: 8 });

        // No model from the turn (a cold CLI run names none): read the session.
        v5.summarize.length = 0;
        v5.sessionMsgs.ses_dm3a = [
            { info: { role: "user", model: { providerID: "prov", modelID: "u1" } } },
            { info: { role: "assistant", providerID: "prov", modelID: "from-session" } }
        ];
        const dm3a = await ext.__test.compactSession?.("ses_dm3a", work);
        add("DM with no turn model, compaction reads the session's own", dm3a === true && v5.summarize[0]?.body.modelID === "from-session" && v5.summarize[0]?.dir === work);
        v5.sessionMsgs.ses_dm3b = [{ info: { role: "user", model: { providerID: "prov", id: "u2" } } }];
        await ext.__test.compactSession?.("ses_dm3b", work);
        add("DM …a user message's model counts (its `id` form too)", v5.summarize[1]?.body.providerID === "prov" && v5.summarize[1]?.body.modelID === "u2");
        const dm3c = await ext.__test.compactSession?.("ses_dm3c", work);
        add("DM an unknown model skips compaction instead of guessing", dm3c === false && v5.summarize.length === 2 && logLines.some((l) => /compact skipped: the model of ses_dm3c is not known yet/.test(l)));
        settings.model = "pin/p1";
        await ext.__test.compactSession?.("ses_dm3c", work);
        add("DM …with a pin, the pin is the last resort", v5.summarize[2]?.body.providerID === "pin" && v5.summarize[2]?.body.modelID === "p1");
        settings.model = "";
        const dm3d = await ext.__test.compactSession?.("ses_dm3a", work, "given/model");
        add("DM the turn's model wins over the session read", dm3d === true && v5.summarize[3]?.body.modelID === "model" && v5.summarize[3]?.body.providerID === "given");
        // A turn in another folder of the window: scoped to THAT folder, not the active one.
        const dmOther = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-dmother-"));
        await ext.__test.compactSession?.("ses_dm3a", dmOther, "given/model");
        add("DM compaction is scoped to the turn's folder, not the active one", v5.summarize[4]?.dir === dmOther && dmOther !== work);
        fs.rmSync(dmOther, { recursive: true, force: true });

        // A no-pin handoff must not move the session to the fallback for good:
        // OpenCode keeps a session on the model it was last SENT (measured).
        Object.assign(settings, { fallbackModels: ["prov/fallback"], timeoutMs: 1500 });
        v5.mode = "stall-first";
        const dmStartAt = v5.messages.length;
        const dmH1 = await v5Turn("stall then fallback for dm");
        const dmSent = v5.messages.slice(dmStartAt).map((m) => (m.body.model ? `${m.body.model.providerID}/${m.body.model.modelID}` : "-"));
        add("DM a stall with no pin hands off to the fallback", dmSent.join(",") === "-,prov/fallback" && dmH1.result?.metadata?.model === "prov/fallback");
        v5.mode = "answer";
        settings.timeoutMs = 30000;
        const dmDev = await v5Turn("a dev turn between for dm", { command: "dev" }, v5Hist(dmH1));
        add("DM …a turn of another agent is left alone (it may carry its own model)", lastMsg().body.model === undefined && /answered by/.test(dmDev.md));
        const dmH2 = await v5Turn("next plan turn for dm", {}, v5Hist(dmH1, dmDev));
        add("DM …the next same-agent turn goes back to the model the session ran on before", lastMsg().body.model?.providerID === "prov" && lastMsg().body.model?.modelID === "primary");
        await v5Turn("the one after for dm", {}, v5Hist(dmH1, dmDev, dmH2));
        add("DM …once: after that, OpenCode picks again", lastMsg().body.model === undefined);
        // A pinned turn in between moves the session to the pin: nothing to go back to.
        v5.mode = "stall-first";
        settings.timeoutMs = 1500;
        const dmP1 = await v5Turn("stall again for dm pin", {});
        v5.mode = "answer";
        settings.timeoutMs = 30000;
        const dmP2 = await v5Turn("model:prov/pinned a pinned turn for dm", {}, v5Hist(dmP1));
        await v5Turn("unpinned again for dm", {}, v5Hist(dmP1, dmP2));
        add("DM a pinned turn clears the way back: the next unpinned turn sends no model", dmP1.result?.metadata?.model === "prov/fallback" && lastMsg().body.model === undefined);
        settings.fallbackModels = [];

        for (const r of v5.sse) r.end();
        v5Server.closeAllConnections?.();
        v5Server.close();
        Object.assign(settings, v5Saved);
        globalMemento.delete("opencode.models.v1");
    }

    // DM: the model picker writes where the pin lives — never a new
    // .vscode/settings.json in the repo (≤0.0.184 always wrote Workspace).
    {
        const realConfig = vscodeStub.workspace.getConfiguration;
        const realPick = vscodeStub.window.showQuickPick;
        const realInfo = vscodeStub.window.showInformationMessage;
        let scope = {};
        const writes = [];
        const infos = [];
        vscodeStub.workspace.getConfiguration = () => ({
            get: (key, def) => (key === "model" ? scope.workspaceValue ?? scope.globalValue ?? def : settings[key] !== undefined ? settings[key] : def),
            inspect: (key) => (key === "model" ? { key, defaultValue: "", ...scope } : undefined),
            update: async (key, value, target) => void writes.push([key, value, target])
        });
        vscodeStub.window.showInformationMessage = (text) => void infos.push(text);
        globalMemento.set("opencode.models.v1", { models: ["aaa/first-in-catalog", "prov/pick"], fetchedAt: Date.now() });
        const pick = async (label, s) => {
            scope = s;
            writes.length = 0;
            infos.length = 0;
            // v187: the default item names what OpenCode picks, after the label.
            vscodeStub.window.showQuickPick = async (items) => items.find((i) => i.label === label || i.label.includes(label));
            await registeredCommands.get("opencodeCopilotBridge.setModel")();
        };
        const G = vscodeStub.ConfigurationTarget.Global;
        const W = vscodeStub.ConfigurationTarget.Workspace;
        await pick("prov/pick", {});
        add("DM a pick with no pin anywhere goes to User settings, not the repo", writes.length === 1 && writes[0][1] === "prov/pick" && writes[0][2] === G && /User settings/.test(infos[0] || ""));
        await pick("prov/pick", { workspaceValue: "ws/old", globalValue: "user/old" });
        add("DM a pick replaces a Workspace pin where it lives", writes.length === 1 && writes[0][2] === W);
        await pick("prov/pick", { globalValue: "user/old" });
        add("DM …and a User pin in User settings", writes.length === 1 && writes[0][2] === G);
        await pick("Use OpenCode default", { workspaceValue: "ws/old", globalValue: "user/old" });
        add(
            "DM 'Use OpenCode default' removes the pin everywhere it is set — no \"\" left to shadow it",
            writes.length === 2 && writes.every((w) => w[1] === undefined) && writes.some((w) => w[2] === W) && writes.some((w) => w[2] === G)
        );
        const F = vscodeStub.ConfigurationTarget.WorkspaceFolder;
        await pick("prov/pick", { workspaceFolderValue: "folder/old", globalValue: "user/old" });
        add("DM a folder-scoped pin is replaced in the folder, not shadowed by a User write", writes.length === 1 && writes[0][2] === F && /Workspace folder settings/.test(infos[0] || ""));
        await pick("Use OpenCode default", { workspaceFolderValue: "folder/old" });
        add("DM …and 'Use OpenCode default' clears it there", writes.length === 1 && writes[0][1] === undefined && writes[0][2] === F);
        await pick("Use OpenCode default", {});
        add("DM …and with nothing pinned it writes nothing", writes.length === 0 && /No model was pinned/.test(infos[0] || ""));
        vscodeStub.workspace.getConfiguration = realConfig;
        vscodeStub.window.showQuickPick = realPick;
        vscodeStub.window.showInformationMessage = realInfo;
        globalMemento.delete("opencode.models.v1");
    }

    // DM/PA: what /env and /model read from OpenCode's own files.
    {
        const dmRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-dmenv-"));
        const dmGlobal = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-dmglobal-"));
        fs.mkdirSync(path.join(dmRoot, ".opencode", "agents", "team"), { recursive: true });
        fs.mkdirSync(path.join(dmRoot, ".opencode", "agent"), { recursive: true });
        fs.writeFileSync(path.join(dmRoot, ".opencode", "agents", "team", "look.md"), "---\nmode: primary\n---\nlook\n");
        fs.writeFileSync(path.join(dmRoot, ".opencode", "agent", "old.md"), "---\nmode: primary\n---\nold\n");
        fs.writeFileSync(path.join(dmRoot, ".opencode", "agents", "old.md"), "---\nmode: primary\n---\nold twin\n");
        fs.mkdirSync(path.join(dmRoot, ".opencode", "skills", "real"), { recursive: true });
        fs.mkdirSync(path.join(dmRoot, ".opencode", "skills", "empty"), { recursive: true });
        fs.mkdirSync(path.join(dmRoot, ".opencode", "skill", "single"), { recursive: true });
        fs.writeFileSync(path.join(dmRoot, ".opencode", "skills", "real", "SKILL.md"), "---\nname: real\n---\n");
        fs.writeFileSync(path.join(dmRoot, ".opencode", "skill", "single", "SKILL.md"), "---\nname: single\n---\n");
        fs.writeFileSync(path.join(dmRoot, ".opencode", "skills", "README.md"), "notes\n");
        fs.writeFileSync(path.join(dmRoot, "opencode.json"), JSON.stringify({ model: "root/model", agent: { review: { mode: "subagent" } } }));
        const envSaved = { dir: process.env.OPENCODE_CONFIG_DIR, content: process.env.OPENCODE_CONFIG_CONTENT, cfg: process.env.OPENCODE_CONFIG };
        process.env.OPENCODE_CONFIG_DIR = dmGlobal;
        delete process.env.OPENCODE_CONFIG_CONTENT;
        delete process.env.OPENCODE_CONFIG;
        const dmEnv = ext.__test.discoverOpenCodeEnv(dmRoot);
        const dmAgents = dmEnv.filter((i) => i.kind === "agent").map((i) => i.name).sort();
        add("DM /env lists agents from agents/ (nested) and agent/, and the root config's — one row for a name in both", JSON.stringify(dmAgents) === JSON.stringify(["old", "review", "team/look"]));
        const dmSkills = dmEnv.filter((i) => i.kind === "skill").map((i) => i.name).sort();
        add("DM /env lists only folders holding SKILL.md, from skill/ and skills/ (no README.md, no empty folder)", JSON.stringify(dmSkills) === JSON.stringify(["real", "single"]));
        add("DM /env shows the root opencode.json model", dmEnv.some((i) => i.kind === "config" && i.name === "model = root/model"));
        add("DM OpenCode's configured model: the folder's opencode.json", JSON.stringify(ext.__test.openCodeConfigModel?.(dmRoot)) === JSON.stringify({ model: "root/model", from: "opencode.json" }));
        fs.writeFileSync(path.join(dmRoot, ".opencode", "opencode.json"), JSON.stringify({ model: "dot/model" }));
        add("DM ….opencode/opencode.json wins over it", ext.__test.openCodeConfigModel?.(dmRoot)?.model === "dot/model");
        process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "env/model" });
        add("DM …and OPENCODE_CONFIG_CONTENT over both", ext.__test.openCodeConfigModel?.(dmRoot)?.from === "OPENCODE_CONFIG_CONTENT");
        // The global dir follows XDG_CONFIG_HOME, as OpenCode's own does.
        const dmXdg = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-dmxdg-"));
        fs.mkdirSync(path.join(dmXdg, "opencode"), { recursive: true });
        fs.writeFileSync(path.join(dmXdg, "opencode", "opencode.json"), JSON.stringify({ model: "xdg/model" }));
        const xdgSaved = process.env.XDG_CONFIG_HOME;
        delete process.env.OPENCODE_CONFIG_DIR;
        delete process.env.OPENCODE_CONFIG_CONTENT;
        process.env.XDG_CONFIG_HOME = dmXdg;
        const dmBare = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-dmbare-"));
        add("DM the global config is found under XDG_CONFIG_HOME", JSON.stringify(ext.__test.openCodeConfigModel?.(dmBare)) === JSON.stringify({ model: "xdg/model", from: "global opencode.json" }));
        if (xdgSaved === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = xdgSaved;
        for (const d of [dmXdg, dmBare]) fs.rmSync(d, { recursive: true, force: true });
        for (const [k, v] of [["OPENCODE_CONFIG_DIR", envSaved.dir], ["OPENCODE_CONFIG_CONTENT", envSaved.content], ["OPENCODE_CONFIG", envSaved.cfg]]) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        for (const d of [dmRoot, dmGlobal]) fs.rmSync(d, { recursive: true, force: true });
    }

    // LK (v185): the read-only agent the README ships must stay read-only.
    // Measured with a real model on 1.18.32: the first look.md let 5 of 10
    // write attempts through (`cat a > b`, `>>`, `find -fprint`, `git log > f`,
    // and the task tool's `general` subagent); this shape held all 10.
    {
        const readme = fs.readFileSync(path.join(repoDir, "README.md"), "utf8");
        const block = (readme.match(/```markdown\n(---\ndescription: Read-only look[\s\S]*?)```/) || [])[1] || "";
        const front = block.split("\n---\n")[0];
        add("LK the README ships the look agent", block.length > 200 && /\nmode: primary\n/.test(front));
        add("LK everything not named is denied (task, MCP tools, webfetch, edit)", /\npermission:\n {2}"\*": deny\n/.test(front));
        add("LK bash is deny-by-default, with redirects denied last", /\n {2}bash:\n {4}"\*": deny\n/.test(front) && /\n {4}"\*>\*": deny\n$/.test(front + "\n"));
        add("LK find's writing flags are denied", ["-delete", "-exec", "-ok", "-fprint", "-fls"].every((f) => front.includes(`"find *${f}*": deny`)));
        add("LK it never asks (an ask hangs a headless turn or is auto-approved)", !/:\s*ask\b/.test(front));
        // Allow-lists, so a looser edit fails here rather than in someone's repo.
        const lkTop = [];
        const lkBash = [];
        let lkIn = "";
        for (const line of front.split("\n").slice(front.split("\n").indexOf("permission:") + 1)) {
            const top = line.match(/^ {2}"?([^":]+)"?:\s*(\S*)$/);
            if (top) {
                lkIn = top[1];
                lkTop.push([top[1], top[2]]);
                continue;
            }
            const rule = line.match(/^ {4}"(.+)": (allow|deny)$/);
            if (rule && lkIn === "bash") lkBash.push(rule);
        }
        const LK_TOOLS = new Set(["*", "read", "grep", "glob", "list", "lsp", "skill", "todowrite", "todoread", "bash"]);
        add(
            "LK only inspect tools are allowed (anything else is absent or denied)",
            lkTop.length >= 8 && lkTop.every(([k, v]) => LK_TOOLS.has(k) || v === "deny") && lkTop.some(([k]) => k === "bash")
        );
        const LK_BASH = new Set(["ls", "ls *", "pwd", "cat *", "head *", "wc *", "grep *", "rg *", "find *", "git status", "git status *", "git show *", "git log *", "git diff *", "git rev-parse *", "git branch", "git branch --list*"]);
        const lkAllowed = lkBash.filter((r) => r[2] === "allow").map((r) => r[1]);
        add(`LK bash allows only inspect commands (${lkAllowed.length})`, lkAllowed.length >= 10 && lkAllowed.every((c) => LK_BASH.has(c)));
    }

    // deactivate() runs near the end (AGENTS.md §5): the groups after it must not
    // start a server (KA…MA once ran turns against a torn-down extension).
    globalMemento.delete("opencode.usage.v1");
    ext.deactivate();
    add("GC deactivate does not resurrect the usage store", globalMemento.get("opencode.usage.v1") === undefined);

    // IL (v186): @opencode in inline chat (Ctrl+I). The manifest half guards the
    // stable-host trap measured in chatParticipant.contribution.ts (main): a
    // participant declaring `locations` without the chatParticipantAdditions
    // proposal is SKIPPED — so the panel participant must never declare it.
    const ilPkg = require(path.join(__dirname, "..", "package.json"));
    const ilParts = ilPkg.contributes.chatParticipants || [];
    const ilMain = ilParts.find((p) => p.id === "opencodeCopilotBridge.chat");
    const ilInline = ilParts.find((p) => p.id === "opencodeCopilotBridge.inline");
    add("IL the panel participant declares no locations (a stable host would skip it)", Boolean(ilMain) && ilMain.locations === undefined);
    add(
        "IL the inline participant is @opencode in the editor only",
        Boolean(ilInline) && ilInline.name === "opencode" && JSON.stringify(ilInline.locations) === JSON.stringify(["editor"])
    );
    add("IL the only API proposal is chatParticipantAdditions", JSON.stringify(ilPkg.enabledApiProposals) === JSON.stringify(["chatParticipantAdditions"]));
    add("IL the inline participant has its activation event", ilPkg.activationEvents.includes("onChatParticipant:opencodeCopilotBridge.inline"));
    const ilMainCmds = new Map((ilMain?.commands || []).map((c) => [c.name, c.description]));
    add(
        "IL every inline command is a panel command, same description",
        (ilInline?.commands || []).length > 0 && ilInline.commands.every((c) => ilMainCmds.get(c.name) === c.description)
    );
    const ilReg = global.__participants || {};
    add(
        "IL activate registers both participants, each with icon and follow-ups",
        ["opencodeCopilotBridge.chat", "opencodeCopilotBridge.inline"].every(
            (id) => ilReg[id] && ilReg[id].participant.iconPath && typeof ilReg[id].participant.followupProvider?.provideFollowups === "function"
        )
    );
    add("IL the panel handler is still the one the suite drives", ilReg["opencodeCopilotBridge.chat"]?.handler === global.__handler);

    // Behaviour: the inline turn sends its selection even with
    // includeEditorSelection off; the panel turn, same editor, does not.
    settings.executable = happy;
    settings.includeEditorSelection = false;
    settings.chatDensity = "full";
    vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: work }, name: path.basename(work), index: 0 }];
    const ilDoc = (text) => ({ uri: { fsPath: path.join(work, "src", "sel.ts"), scheme: "file" }, getText: () => text });
    const ilSel = (a, b, empty) => ({ isEmpty: empty, start: { line: a }, end: { line: b }, active: { line: b } });
    const ilInlineHandler = ilReg["opencodeCopilotBridge.inline"]?.handler;
    const ilRun = async (handler, prompt, ctx = {}) => {
        const s = stream();
        const r = await handler({ prompt }, ctx, s.response, s.token);
        return { r, argv: lastArgv("fake-ok.js"), s };
    };
    memento.clear();
    vscodeStub.window.activeTextEditor = { document: ilDoc("const x = 1;\nreturn x;"), selection: ilSel(2, 3, false) };
    const il1 = await ilRun(ilInlineHandler, "explain this block");
    const il1Prompt = String(il1.argv[il1.argv.length - 1] || "");
    add(
        "IL an inline turn sends its selection with includeEditorSelection off",
        il1Prompt.includes("Active selection — src/sel.ts:3-4") && il1Prompt.includes("return x;")
    );
    memento.clear();
    const il2 = await ilRun(global.__handler, "explain this block");
    add("IL a panel turn, same editor, sends no selection", !String(il2.argv[il2.argv.length - 1] || "").includes("Active selection"));

    // Nothing selected: the file and cursor line go, and a bare `fix` is a task.
    memento.clear();
    vscodeStub.window.activeTextEditor = { document: ilDoc(""), selection: ilSel(6, 6, true) };
    const il3 = await ilRun(ilInlineHandler, "fix");
    const il3Prompt = String(il3.argv[il3.argv.length - 1] || "");
    add("IL an empty inline selection sends the file and cursor line", il3Prompt.includes("Inline chat — src/sel.ts:7 (cursor, nothing selected)"));
    add("IL a bare `fix` inline is run, not gated as vague", il3.r?.metadata?.kind !== "clarify" && il3Prompt.startsWith("fix"));

    // The inline widget keeps its own session: its turns bind the thread.
    const il4 = await ilRun(ilInlineHandler, "and the next line?", {
        history: [{ participant: "opencodeCopilotBridge.inline", prompt: "fix", result: il3.r }]
    });
    add(
        "IL a second inline turn continues the widget's session",
        Boolean(il3.r?.metadata?.sessionId) && il4.argv.includes("--session") && il4.argv[il4.argv.indexOf("--session") + 1] === il3.r.metadata.sessionId
    );
    add(
        "IL threadSession reads inline turns",
        ext.__test.threadSession([{ participant: "opencodeCopilotBridge.inline", result: il3.r }], work)?.id === il3.r?.metadata?.sessionId
    );
    vscodeStub.window.activeTextEditor = undefined;

    // MB (v187): followups hardening. A chip with nothing to send is left out
    // (never thrown — provideFollowups would lose every chip), and the JSON's
    // cross-references are checked here, at build time, by the same function
    // activation logs with. A broken JSON must not stop @opencode activating.
    {
        const mbNoText = (() => {
            try {
                return ext.__test.chipOf("RUN_ANYWAY", "dev") === undefined;
            } catch {
                return false;
            }
        })();
        add("MB chipOf leaves out an @kind chip with no prompt (no throw)", mbNoText);
        add("MB chipOf accepts the same chip once text is supplied", ext.__test.chipOf("RUN_ANYWAY", "dev", "do it")?.prompt === "do it");
        add("MB chipOf of an unknown key is undefined, not a crash", ext.__test.chipOf("NOPE", "dev", "x") === undefined);
        const mbData = require(path.join(__dirname, "..", "src", "followups.json"));
        const mbOk = Object.values(mbData.cases).every((keys) =>
            keys.every((k) => {
                const c = ext.__test.chipOf(k, "dev", "sent text");
                return Boolean(c) && c.prompt === "sent text" && typeof c.command === "string";
            })
        );
        add("MB every CASES chip resolves from the JSON alone", mbOk);
        const mbLogBefore = logLines.length;
        let mbChips = ["threw"];
        try {
            mbChips = global.__participant.followupProvider.provideFollowups({ metadata: { kind: "clarify", agent: "plan", prompt: "" } }, {}, {}) || [];
        } catch {
            // a throw here is the bug this check exists for
        }
        add(
            "MB a clarify turn with an empty prompt yields no chip and one log line, no throw",
            mbChips.length === 0 && logLines.slice(mbLogBefore).some((l) => /chip RUN_ANYWAY left out/.test(l))
        );
        add("MB followups.json has no broken cross-reference", JSON.stringify(ext.__test.followupsProblems()) === "[]");
        const mbBroken = JSON.parse(JSON.stringify(mbData));
        mbBroken.chips.RETRY.prompt = "RETR";
        mbBroken.chips.PING.command = "bogus";
        mbBroken.cases.done = [...mbBroken.cases.done, "NOPE"];
        const mbFound = ext.__test.followupsProblems(mbBroken);
        add(
            "MB followupsProblems names each broken reference",
            mbFound.length === 3 && /RETRY.*RETR/.test(mbFound.join("|")) && /PING.*bogus/.test(mbFound.join("|")) && /NOPE/.test(mbFound.join("|"))
        );
        add("MB activation logged no followups.json problem", !logLines.some((l) => l.startsWith("followups.json:")));
    }

    // ==================== v187 ====================
    // MC: model catalog v2 — names and providers. The model JSON `--verbose`
    // prints carries `options` and `headers` (credentials live there); only
    // name, provider and context may ever be kept.
    {
        const SECRET = "sk-v187-do-not-store";
        const verboseOut = [
            "acme-gateway/Oasis",
            JSON.stringify({ id: "Oasis", providerID: "acme-gateway", name: "Oasis (Model-2, Investigation & log analysis)", limit: { context: 128000, output: 8000 }, headers: { Authorization: `Bearer ${SECRET}` }, options: { apiKey: SECRET } }, null, 2),
            "acme-gateway/Tundra",
            JSON.stringify({ id: "Tundra", providerID: "acme-gateway", name: "Tundra (Model-1, Code generation & refactors)", limit: { context: 200000 } }, null, 2),
            "opencode/big-pickle",
            ""
        ].join("\n");
        const mcInfo = ext.__test.parseVerboseModels(verboseOut);
        add(
            "MC --verbose output parses into names, provider and context",
            mcInfo["acme-gateway/Oasis"]?.name === "Oasis (Model-2, Investigation & log analysis)" &&
                mcInfo["acme-gateway/Tundra"]?.context === 200000 &&
                mcInfo["acme-gateway/Oasis"]?.provider === "acme-gateway" &&
                mcInfo["opencode/big-pickle"]?.name === "opencode/big-pickle"
        );
        add("MC nothing from options or headers is kept", !JSON.stringify(mcInfo).includes(SECRET) && !JSON.stringify(mcInfo).includes("headers"));
        add("MC the id list from --verbose output is the ids alone", ext.__test.parseModelList(verboseOut).join() === "acme-gateway/Oasis,acme-gateway/Tundra,opencode/big-pickle");
        const mcProv = ext.__test.parseProviders({
            providers: [{ id: "acme-gateway", name: "Acme", models: { Tundra: { name: "Tundra (Model-1, Code generation & refactors)", limit: { context: 200000 }, headers: { k: SECRET } } } }],
            default: {}
        });
        add(
            "MC GET /config/providers gives the provider's display name",
            mcProv["acme-gateway/Tundra"]?.providerName === "Acme" && mcProv["acme-gateway/Tundra"]?.name.startsWith("Tundra (") && !JSON.stringify(mcProv).includes(SECRET)
        );
        const mcAll = ext.__test.parseProviders({ all: [{ id: "a", name: "A", models: { x: { name: "X" } } }, { id: "b", name: "B", models: { y: { name: "Y" } } }], connected: ["a"] });
        add("MC the /provider shape keeps connected providers only", Object.keys(mcAll).join() === "a/x");

        // Live via the CLI, with --verbose.
        const mcFake = writeFake("fake-models-v.js", []);
        fs.appendFileSync(mcFake.replace(/\.cmd$/, ""), `process.stdout.write(${JSON.stringify(verboseOut)});\n`);
        globalMemento.clear();
        const mcLive = await ext.__test.getModelCatalog(mcFake, work);
        add("MC the CLI is asked with --verbose", lastArgv("fake-models-v.js").slice(-2).join(" ") === "models --verbose");
        add("MC a live catalog carries names", mcLive.source === "live" && mcLive.info["acme-gateway/Tundra"]?.name.startsWith("Tundra ("));
        const mcStored = globalMemento.get("opencode.models.v2");
        add("MC the cache is v2, with names and without secrets", mcStored?.info?.["acme-gateway/Oasis"]?.name.startsWith("Oasis") && !JSON.stringify(mcStored).includes(SECRET));
        // A CLI that rejects --verbose still yields the ids.
        const mcOld = writeFake("fake-models-old.js", []);
        fs.appendFileSync(mcOld.replace(/\.cmd$/, ""), "if (process.argv.includes('--verbose')) { process.stderr.write('Unknown argument: verbose'); process.exit(1); }\nprocess.stdout.write('acme/one\\nacme/two\\n');\n");
        globalMemento.clear();
        const mcOldCat = await ext.__test.getModelCatalog(mcOld, work, { force: true });
        add("MC a CLI without --verbose falls back to plain `models`", mcOldCat.source === "live" && mcOldCat.models.join() === "acme/one,acme/two" && lastArgv("fake-models-old.js").slice(-1)[0] === "models");
        // A v1 cache (≤0.0.186) is still served.
        globalMemento.clear();
        globalMemento.set("opencode.models.v1", { models: ["old/one"], fetchedAt: Date.now() });
        const mcV1 = await ext.__test.getModelCatalog("definitely-not-a-real-binary", work);
        add("MC a v1 cache is still read", mcV1.source === "cached" && mcV1.models.join() === "old/one");
        globalMemento.clear();

        // A running server answers with provider names; no process is spawned.
        const mcHttp = require("node:http");
        const mcHits = [];
        const mcServer = mcHttp.createServer((req, res) => {
            mcHits.push(req.url);
            if (req.url.startsWith("/config/providers")) {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ providers: [{ id: "acme-gateway", name: "Acme", models: { Tundra: { name: "Tundra (Model-1, Code generation & refactors)" }, Oasis: { name: "Oasis (Model-2, Investigation & log analysis)" } } }], default: {} }));
                return;
            }
            res.statusCode = 404;
            res.end();
        });
        await new Promise((r) => mcServer.listen(0, "127.0.0.1", r));
        const mcSaved = { transport: settings.transport, serverPort: settings.serverPort, serverHostname: settings.serverHostname };
        Object.assign(settings, { transport: "server", serverPort: mcServer.address().port, serverHostname: "127.0.0.1" });
        const mcSrv = await ext.__test.getModelCatalog("definitely-not-a-real-binary", work, { force: true });
        add(
            "MC with a server running, the catalog comes from it, provider names included",
            mcSrv.source === "live" && mcSrv.info["acme-gateway/Tundra"]?.providerName === "Acme" && mcSrv.models.length === 2
        );
        add("MC the server request is scoped to the folder", mcHits.some((u) => u.startsWith("/config/providers") && u.includes("directory=")));
        settings.transport = "cli";
        mcHits.length = 0;
        await ext.__test.getModelCatalog(mcFake, work, { force: true });
        add("MC transport cli never asks the server", mcHits.length === 0);
        Object.assign(settings, mcSaved);
        mcServer.close();
        globalMemento.clear();
    }

    // MN: names in the picker and in /model.
    {
        globalMemento.set("opencode.models.v2", {
            models: ["acme-gateway/Tundra", "acme-gateway/Oasis"],
            info: {
                "acme-gateway/Tundra": { id: "acme-gateway/Tundra", name: "Tundra (Model-1, Code generation & refactors)", provider: "acme-gateway", providerName: "Acme", context: 200000 },
                "acme-gateway/Oasis": { id: "acme-gateway/Oasis", name: "Oasis (Model-2, Investigation & log analysis)", provider: "acme-gateway", providerName: "Acme" }
            },
            fetchedAt: Date.now()
        });
        const realCfg = vscodeStub.workspace.getConfiguration;
        const realPick = vscodeStub.window.showQuickPick;
        const realInfo = vscodeStub.window.showInformationMessage;
        let mnItems = [];
        const mnWrites = [];
        let mnWhere = {};
        vscodeStub.workspace.getConfiguration = () => ({
            get: (key, def) => (settings[key] !== undefined ? settings[key] : def),
            inspect: () => mnWhere,
            update: async (key, value, target) => void mnWrites.push([key, value, target])
        });
        vscodeStub.window.showInformationMessage = () => undefined;
        const mnPick = async (choose) => {
            mnWrites.length = 0;
            vscodeStub.window.showQuickPick = async (items) => ((mnItems = items), choose(items));
            await registeredCommands.get("opencodeCopilotBridge.setModel")();
        };
        const ocJson = path.join(work, "opencode.json");
        const hadOc = fs.existsSync(ocJson);
        const ocBefore = hadOc ? fs.readFileSync(ocJson, "utf8") : "";
        fs.writeFileSync(ocJson, JSON.stringify({ model: "acme-gateway/Tundra" }));
        settings.model = "";
        mnWhere = {};
        await mnPick((items) => items.find((i) => i.label.startsWith("Oasis (")));
        const mnTundra = mnItems.find((i) => i.modelId === "acme-gateway/Tundra");
        add(
            "MN the picker shows names, the id beside them, provider and context below",
            mnTundra?.label === "Tundra (Model-1, Code generation & refactors)" && mnTundra.description.includes("acme-gateway/Tundra") && mnTundra.detail === "Acme · 200k context"
        );
        add("MN picking by name pins the id", mnWrites.length === 1 && mnWrites[0][1] === "acme-gateway/Oasis");
        add("MN 'Use OpenCode default' names what OpenCode picks", /Use OpenCode default \(Tundra \(Model-1, Code generation & refactors\), from opencode\.json\)/.test(mnItems[0].label));
        settings.model = "gone/model";
        mnWhere = { workspaceValue: "gone/model" };
        await mnPick(() => undefined);
        add("MN a pin the catalog no longer lists is shown as (not listed)", mnItems.some((i) => i.modelId === "gone/model" && /\(not listed\)/.test(i.description)));
        settings.model = "acme-gateway/Tundra";
        mnWhere = { workspaceValue: "acme-gateway/Tundra" };
        memento.clear();
        const mnM = stream();
        await global.__handler({ prompt: "", command: "model" }, {}, mnM.response, mnM.token);
        const mnMd = plain(mnM.chatMarkdown.join(""));
        add("MN /model shows the pin by name and id, and where it lives", mnMd.includes("1. Tundra (Model-1, Code generation & refactors) · `acme-gateway/Tundra` · Workspace settings, chat only"));
        settings.model = "gone/model";
        const mnG = stream();
        await global.__handler({ prompt: "", command: "model" }, {}, mnG.response, mnG.token);
        add("MN /model flags a pin the catalog does not list", plain(mnG.chatMarkdown.join("")).includes("`gone/model` · Workspace settings, chat only · (not listed)"));
        settings.model = "";
        if (hadOc) fs.writeFileSync(ocJson, ocBefore);
        else fs.rmSync(ocJson, { force: true });
        vscodeStub.workspace.getConfiguration = realCfg;
        vscodeStub.window.showQuickPick = realPick;
        vscodeStub.window.showInformationMessage = realInfo;
    }

    // SN: short model names — one match or a refusal, never a guess.
    {
        const snCat = {
            models: ["acme-gateway/Tundra", "acme-gateway/Oasis", "openai/gpt-5-flash", "google/gemini-flash", "google/gemini-pro"],
            info: {
                "acme-gateway/Tundra": { name: "Tundra (Model-1, Code generation & refactors)" },
                "acme-gateway/Oasis": { name: "Oasis (Model-2, Investigation & log analysis)" }
            }
        };
        const R = (ref) => ext.__test.resolveModelRef(ref, snCat);
        add("SN a short name resolves to the one model it names, any case", R("tundra").id === "acme-gateway/Tundra" && R("OASIS").id === "acme-gateway/Oasis");
        add("SN a unique prefix of 3+ letters resolves; shorter does not", R("tun").id === "acme-gateway/Tundra" && "unknown" in R("tu"));
        add("SN two matches are refused with both named", JSON.stringify(R("gemini-flash")) === JSON.stringify({ id: "google/gemini-flash" }) && R("gpt").id === "openai/gpt-5-flash" && Array.isArray(R("g").ambiguous) === false);
        const snAmb = ext.__test.resolveModelRef("flash", { models: ["openai/flash", "google/flash"], info: {} });
        add("SN an ambiguous short name lists every candidate", Array.isArray(snAmb.ambiguous) && snAmb.ambiguous.join() === "openai/flash,google/flash");
        add("SN a full id passes through as typed, even unlisted", R("x/y").id === "x/y" && R("x/y").unlisted === true && R("acme-gateway/tundra").id === "acme-gateway/Tundra");
        add("SN a label reads name then id", ext.__test.modelLabel("acme-gateway/Tundra", snCat.info) === "Tundra (Model-1, Code generation & refactors) · `acme-gateway/Tundra`" && ext.__test.modelLabel("x/y", {}) === "`x/y`");

        globalMemento.set("opencode.models.v2", { models: snCat.models, info: snCat.info, fetchedAt: Date.now() });
        settings.executable = happy;
        memento.clear();
        const snT = stream();
        await global.__handler({ prompt: "model:tundra why is login slow" }, {}, snT.response, snT.token);
        const snArgv = lastArgv("fake-ok.js");
        add("SN `model:tundra` sends the full id", snArgv[snArgv.indexOf("--model") + 1] === "acme-gateway/Tundra" && snArgv[snArgv.length - 1].startsWith("why is login slow"));
        fs.rmSync(path.join(work, "fake-ok.js.argv"), { force: true });
        const snA = stream();
        await global.__handler({ prompt: "model:gemini why is login slow" }, {}, snA.response, snA.token);
        add(
            "SN an ambiguous `model:` is refused before anything runs",
            !fs.existsSync(path.join(work, "fake-ok.js.argv")) && /matches .*google\/gemini-flash.*google\/gemini-pro/.test(snA.chatMarkdown.join(""))
        );
        const snU = stream();
        await global.__handler({ prompt: "model:nosuch why is login slow" }, {}, snU.response, snU.token);
        const snUArgv = lastArgv("fake-ok.js");
        add("SN an unknown short name is refused, not sent", !snUArgv.some((a) => a.includes("why is login slow")) && /not in OpenCode's model list/.test(snU.chatMarkdown.join("")));
        add("SN an unknown short name refetches the catalog even when the cache is fresh", snUArgv.slice(-2).join(" ") === "models --verbose");
        fs.rmSync(path.join(work, "fake-ok.js.argv"), { force: true });

        // Real `opencode models --verbose` shape, captured 2026-09-29 on a
        // company gateway, provider renamed acme-gateway (trimmed to the fields that matter; options/headers
        // kept to prove they are dropped). One id holds three slashes.
        const snModel = (id, name) => `acme-gateway/${id}\n` + JSON.stringify({
            id, api: { id, npm: "@ai-sdk/openai-compatible", url: "" }, status: "active", name, providerID: "acme-gateway",
            options: { apiKey: "SECRET" }, limit: { context: 1000000, output: 128000 }, headers: { Authorization: "SECRET" }, variants: {}
        }, null, 2) + "\n";
        const snRaw = [
            ["Arbor", "Arbor (Model-3, Documentation & summaries)"],
            ["Aspen", "Aspen (Model-4, Deep reasoning & architecture)"],
            ["Auto", "Auto"],
            ["openrouter/moonshotai/kimi-k3", "Kimi K3"],
            ["Oasis", "Oasis (Model-2, Investigation & log analysis)"],
            ["Tundra", "Tundra (Model-1, Code generation & refactors)"]
        ].map(([id, name]) => snModel(id, name)).join("");
        const snReal = { models: ext.__test.parseModelList(snRaw), info: ext.__test.parseVerboseModels(snRaw) };
        const RR = (ref) => ext.__test.resolveModelRef(ref, snReal);
        const kimi = "acme-gateway/openrouter/moonshotai/kimi-k3";
        add("SN the real verbose output parses: six ids, names, nothing secret", snReal.models.length === 6 && snReal.info[kimi]?.name === "Kimi K3" && !JSON.stringify(snReal.info).includes("SECRET"));
        add("SN a multi-slash id resolves by its last segment", RR("kimi-k3").id === kimi && RR("KIMI-K").id === kimi && "unknown" in RR("k3"));
        add("SN a multi-slash id resolves by its own id or any /-suffix", RR("openrouter/moonshotai/kimi-k3").id === kimi && RR("moonshotai/kimi-k3").id === kimi && RR("MoonshotAI/Kimi-K3").id === kimi);
        add("SN a routing prefix is not a short name", "unknown" in RR("openrouter") && "unknown" in RR("moonshotai"));
        add("SN the real catalog's short names still resolve", RR("tundra").id === "acme-gateway/Tundra" && RR("arb").id === "acme-gateway/Arbor" && RR("auto").id === "acme-gateway/Auto" && RR("kimi").id === kimi);
        const snSuf = ext.__test.resolveModelRef("m/x", { models: ["a/m/x", "b/m/x"], info: {} });
        add("SN a /-suffix matching two ids is refused with both", Array.isArray(snSuf.ambiguous) && snSuf.ambiguous.join() === "a/m/x,b/m/x");
        add("SN an unknown full id still passes through as typed", RR("x/y").id === "x/y" && RR("x/y").unlisted === true);
    }

    // PL: /parallel per-lane models, models: fan-out, no cap, pipe-safe lanes.
    {
        const S = ext.__test.splitLanes;
        add("PL a | inside backticks is not a lane break", JSON.stringify(S("explain `grep a | wc -l` output | list deps")) === JSON.stringify(["explain `grep a | wc -l` output", "list deps"]));
        add("PL a markdown table row is one lane's text", S("review this:\n| a | b |\n| c | d |").length === 1);
        // v188 (D1): `|`, `;;` and a `---` line only. `||` is a shell OR, and a
        // spaced `::` is prose (`std :: vector`, `10 :: 20`): each would be a paid lane.
        add("PL `a || b` is one lane: a shell OR, not a split", JSON.stringify(S("run npm test || true")) === JSON.stringify(["run npm test || true"]));
        add("PL `||` beside a real split stays text", JSON.stringify(S("a || b | c")) === JSON.stringify(["a || b", "c"]));
        add("PL `::` never splits", S("explain std :: vector").length === 1 && S("ratio 10 :: 20").length === 1 && S("review std::vector usage").length === 1);
        add("PL ;; and a --- line still separate lanes", S("a ;; b\n---\nc").length === 3);
        add("PL every separator token splits", JSON.stringify(S("a | b ;; c\n---\nd")) === JSON.stringify(["a", "b", "c", "d"]));
        // v189: a Windows paste arrives with CRLF; 0.0.188 ran a 4-lane
        // `---` prompt as one lane (reproduced: LF 4, CRLF 1, CR 1).
        add("PL a CRLF or CR `---` line separates lanes", S("a\r\n---\r\nb\r\n---\r\nc").length === 3 && S("a\r---\rb").length === 2);
        add("PL a `---` line with spaces around it separates lanes", S("a\n  ---  \nb").length === 2);
        add("PL a CRLF table row is one lane's text", S("review this:\r\n| a | b |\r\n| c | d |").length === 1);
        add("PL a `---` line inside a fence is text", S("check this yaml\n```\n---\nkey: 1\n```\nnow").length === 1 && S("a - b | c-d").join() === "a - b,c-d");
        add("PL ;; inside backticks is text, the | outside still splits", JSON.stringify(S("explain `for(;;)` | explain `a | b`")) === JSON.stringify(["explain `for(;;)`", "explain `a | b`"]));
        add("PL an unclosed backtick guards the rest: a forgotten ` never splits a pipe", S("use `grep a | wc -l on the logs").length === 1 && S("a | b `x | y").length === 2);
        add("PL an unclosed fence guards the rest", S("check\n```\ncat a | sort").length === 1);
        add(
            "PL a lane's m: prefix splits off",
            JSON.stringify(ext.__test.splitModelPrefix("m:tundra review auth")) === JSON.stringify({ model: "tundra", task: "review auth" }) &&
                JSON.stringify(ext.__test.splitModelPrefix("model: oasis, read logs")) === JSON.stringify({ model: "oasis", task: "read logs" }) &&
                ext.__test.splitModelPrefix("review m:x later").model === undefined
        );
        add(
            "PL models: parses into models and one task",
            JSON.stringify(ext.__test.splitModelsFanout("models:tundra,oasis, aspen review auth")) === JSON.stringify({ models: ["tundra", "oasis"], task: "aspen review auth" }) &&
                ext.__test.splitModelsFanout("model:tundra x") === undefined
        );

        // Each lane's argv, logged by a fake that appends instead of overwriting.
        const plLog = path.join(work, "pl-argv.jsonl");
        const plFake = writeFake(
            "fake-pl.js",
            [
                { type: "text", sessionID: "ses_pl", part: { text: "lane answer" } },
                { type: "step_finish", sessionID: "ses_pl", part: { reason: "stop", cost: 0.0031, tokens: { input: 10, output: 5, reasoning: 0, total: 15, cache: { read: 0, write: 0 } } } }
            ],
            `fs.appendFileSync(${JSON.stringify(plLog)}, JSON.stringify(process.argv) + "\\n");\n`
        );
        const plAll = () =>
            fs.existsSync(plLog) ? fs.readFileSync(plLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
        const plIsCatalog = (a) => a[a.length - 1] === "models" || a.slice(-2).join(" ") === "models --verbose";
        const plRuns = () => plAll().filter((a) => !plIsCatalog(a));
        const plModels = () => plRuns().map((a) => (a.includes("--model") ? a[a.indexOf("--model") + 1] : "")).sort();
        settings.executable = plFake;
        const plTurn = async (prompt) => {
            fs.rmSync(plLog, { force: true });
            memento.clear();
            const st = stream();
            await global.__handler({ prompt, command: "parallel" }, {}, st.response, st.token);
            return plain(st.chatMarkdown.join(""));
        };
        const pl1 = await plTurn("m:tundra review auth | m:oasis read the logs | list deps");
        add("PL each lane runs on its own model; a lane without one uses the default", plModels().join() === ",acme-gateway/Oasis,acme-gateway/Tundra");
        add("PL a lane header names its model", pl1.includes("### 1. review auth · Tundra (Model-1, Code generation & refactors)") && pl1.includes("### 3. list deps\n"));
        add("PL each lane shows its own cost", (pl1.match(/ · \$0\.0031/g) || []).length === 3);
        const pl2 = await plTurn("models:tundra,oasis review the auth flow");
        add(
            "PL models: runs one task on each model",
            plModels().join() === "acme-gateway/Oasis,acme-gateway/Tundra" && plRuns().every((a) => a[a.length - 1].startsWith("review the auth flow"))
        );
        add("PL a models: lane is titled by its model", pl2.includes("on 2 models") && pl2.includes("### 1. Tundra (Model-1, Code generation & refactors)\n") && pl2.includes("### 2. Oasis ("));
        const pl3 = await plTurn("models:tundra,oasis review auth | list deps");
        add("PL models: with a | is refused, nothing runs", plRuns().length === 0 && /takes no `\|`/.test(pl3));
        const pl4 = await plTurn("models:tundra review auth");
        add("PL models: with one model is refused, nothing runs", plRuns().length === 0 && /at least two models/.test(pl4));
        const pl5 = await plTurn("m:nosuch review auth | list deps");
        add(
            "PL a lane whose model does not resolve fails alone, unrun",
            plRuns().length === 1 && pl5.includes("_(not run)_") && /not in OpenCode's model list/.test(pl5) && /1\/2 lanes returned/.test(pl5)
        );
        add("PL an unknown lane model refetches the catalog once before refusing", plAll().filter(plIsCatalog).length === 1);
        // v188 (F2): three unknown lanes, one fetch — not one per lane.
        const plCrlf = await plTurn("m:tundra review auth\r\n---\r\nm:oasis read the logs\r\n---\r\nlist deps");
        add("PL a CRLF `---` prompt runs every lane on its model", plRuns().length === 3 && plModels().join() === ",acme-gateway/Oasis,acme-gateway/Tundra" && /Running \*\*3 lanes\*\*/.test(plCrlf));
        const pl5b = await plTurn("m:nosuch1 a | m:nosuch2 b | m:nosuch3 c | list deps");
        add("PL three unknown lane models cost one catalog fetch", plAll().filter(plIsCatalog).length === 1 && plRuns().length === 1 && (pl5b.match(/_\(not run\)_/g) || []).length === 3);
        const pl6 = await plTurn("models:a1,a2,a3,a4,a5,a6,a7 x".replace(/a(\d)/g, "acme-gateway/M$1"));
        add("PL models: has no cap either", plRuns().length === 7 && pl6.includes("on 7 models"));
        settings.executable = happy;
        globalMemento.clear();
    }

    // AL: command aliases — typed only, a real command always wins.
    {
        const A = (prompt, user = {}) => ext.__test.resolveAlias(prompt, ext.__test.commandAliases(user));
        add("AL /d is /dev, /p is /parallel, /pl is /plan", A("/d fix it").prompt === "/dev fix it" && A("/p a | b").prompt === "/parallel a | b" && A("/pl look").prompt === "/plan look");
        add("AL a real command is never rewritten, even by a user alias", A("/dev x", { dev: "plan" }).prompt === "/dev x" && A("/par a | b").prompt === "/par a | b");
        add("AL a user alias overrides a default and adds new ones", A("/p x", { p: "plan" }).prompt === "/plan x" && A("/zg a | b", { "/zg": "/parallel" }).prompt === "/parallel a | b");
        add("AL an alias to a non-command is refused", /not a command/.test(A("/zz x", { zz: "paralel" }).problem || "") && A("/zz x", { zz: "paralel" }).prompt === "/zz x");
        add("AL /? and /h are help; text that is not an alias is left alone", A("/?").prompt === "/help" && A("/h").prompt === "/help" && A("/usr/bin is odd").prompt === "/usr/bin is odd");
        const alPkg = require(path.join(__dirname, "..", "package.json"));
        const alNames = (alPkg.contributes.chatParticipants || []).flatMap((p) => (p.commands || []).map((c) => c.name));
        add("AL no alias is in the manifest (the / menu stays one entry per command)", Object.keys(ext.__test.commandAliases()).every((k) => !alNames.includes(k)));

        settings.executable = happy;
        memento.clear();
        const alD = stream();
        await global.__handler({ prompt: "/d fix the redirect bug" }, {}, alD.response, alD.token);
        const alArgv = lastArgv("fake-ok.js");
        add("AL `/d <task>` runs the editing agent", alArgv[alArgv.indexOf("--agent") + 1] === "build" && alArgv[alArgv.length - 1].startsWith("fix the redirect bug"));
        fs.rmSync(path.join(work, "fake-ok.js.argv"), { force: true });
        const alN = stream();
        const alNr = await global.__handler({ prompt: "/n" }, {}, alN.response, alN.token);
        add("AL /n starts a new session and spawns nothing", alNr?.metadata?.kind === "new" && !fs.existsSync(path.join(work, "fake-ok.js.argv")));
        settings.commandAliases = { zz: "paralel" };
        const alZ = stream();
        await global.__handler({ prompt: "/zz a | b" }, {}, alZ.response, alZ.token);
        add("AL a broken user alias is explained, never sent as a task", /not a command/.test(alZ.chatMarkdown.join("")) && !fs.existsSync(path.join(work, "fake-ok.js.argv")));
        settings.commandAliases = {};
        const alH = stream();
        await global.__handler({ prompt: "/?" }, {}, alH.response, alH.token);
        add("AL /help lists the aliases", /Aliases: `\/p` parallel · `\/d` dev/.test(alH.chatMarkdown.join("")));
    }

    // ==================== v196 ====================
    // RM: /flow is gone, all of it — the command, its alias, the trace id in
    // metadata, the module, the probe, the gate entry and the docs.
    {
        const rmRead = (f) => (fs.existsSync(path.join(repoDir, f)) ? fs.readFileSync(path.join(repoDir, f), "utf8") : "");
        const rmPkg = JSON.parse(rmRead("package.json"));
        add(
            "RM no flow module, build output or mermaid probe",
            !fs.existsSync(path.join(repoDir, "src", "flow.ts")) && !fs.existsSync(path.join(repoDir, "out", "flow.js")) && !fs.existsSync(path.join(repoDir, "scripts", "probe-mermaid-flow.js"))
        );
        const rmSrc = fs.readdirSync(path.join(repoDir, "src")).filter((f) => f.endsWith(".ts")).map((f) => rmRead(path.join("src", f))).join("\n");
        add("RM no source imports ./flow or draws mermaid", !/from "\.\/flow"/.test(rmSrc) && !/mermaid/i.test(rmSrc));
        add("RM neither participant offers /flow", rmPkg.contributes.chatParticipants.every((p) => !p.commands.some((c) => c.name === "flow")));
        add("RM /flow is no control command and /f no alias", !ext.__test.slashCommands.includes("flow") && ext.__test.resolveAlias("/f 2", ext.__test.commandAliases({})).prompt === "/f 2");
        add("RM a user alias to flow is refused as a non-command", /not a command/.test(ext.__test.resolveAlias("/zz", ext.__test.commandAliases({ zz: "flow" })).problem || ""));
        add("RM the gate allows no out/flow.js and the package ignores no mermaid probe", !/flow\.js/.test(rmRead("scripts/ship-gate.js")) && !/mermaid/.test(rmRead(".vscodeignore")));
        const rmHelp = stream();
        await global.__handler({ prompt: "", command: "help" }, {}, rmHelp.response, rmHelp.token);
        // The README's changelog may say it was removed; nothing above it may offer it.
        const rmReadme = rmRead("README.md").split(/^## Changelog$/m)[0];
        add("RM README (above its changelog), AGENTS and /help name no /flow", rmReadme.length > 1000 && !/\/flow\b|claim:flow/.test(rmReadme + rmRead("AGENTS.md")) && /\/sessions/.test(rmHelp.chatMarkdown.join("")) && !/\/flow\b|`\/f`/.test(rmHelp.chatMarkdown.join("")));

        settings.executable = happy;
        settings.transport = "cli";
        memento.clear();
        const rmTurn = stream();
        const rmR = await global.__handler({ prompt: "explain the redirect loop" }, {}, rmTurn.response, rmTurn.token);
        add("RM a finished turn's metadata carries no trace id", rmR.metadata.kind !== undefined && !("flow" in rmR.metadata) && Number.isInteger(rmR.metadata.turns));
        // `/` keeps a typed word out of the vague-prompt gate: without the
        // notice, habit would send `/flow 2` to the model as a paid task.
        for (const typed of ["/flow", "/flow 2", "/FLOW all", "/f 2"]) {
            fs.rmSync(path.join(work, "fake-ok.js.argv"), { force: true });
            const rmTyped = stream();
            const rmT = await global.__handler({ prompt: typed }, {}, rmTyped.response, rmTyped.token);
            add(`RM a typed \`${typed}\` runs nothing and says it was removed`, rmT.metadata.kind === "idle" && !fs.existsSync(path.join(work, "fake-ok.js.argv")) && /was removed in 0\.0\.196/.test(rmTyped.chatMarkdown.join("")));
        }
        fs.rmSync(path.join(work, "fake-ok.js.argv"), { force: true });
        const rmFlowy = stream();
        await global.__handler({ prompt: "/flowchart of the auth module" }, {}, rmFlowy.response, rmFlowy.token);
        add("RM only the exact word is retired: `/flowchart …` still runs", fs.existsSync(path.join(work, "fake-ok.js.argv")));
    }

    // ==================== v197 ====================
    // ES: no if/else/loop block with nothing in it, not even a comment. The
    // /flow removal deleted the one statement of `if (metrics) { … }` (0.0.196).
    {
        const esRe = /\b(?:if|for|while)\s*\((?:[^()]|\([^()]*\))*\)\s*\{\s*\}|\belse\s*\{\s*\}/g;
        const esHits = fs.readdirSync(path.join(repoDir, "src")).filter((f) => f.endsWith(".ts")).flatMap((f) => {
            const s = fs.readFileSync(path.join(repoDir, "src", f), "utf8");
            return [...s.matchAll(esRe)].map((m) => `${f}:${s.slice(0, m.index).split("\n").length}`);
        });
        add(`ES no empty if/else/loop block in src${esHits.length ? ` (${esHits.join(", ")})` : ""}`, esHits.length === 0);
        add("ES the tripwire sees one: `if (metrics) {\\n}`", [..."if (metrics) {\n        }".matchAll(esRe)].length === 1 && [..."catch {\n // why\n}".matchAll(esRe)].length === 0);
    }

    // ==================== v190 ====================
    // NS: "Ask OpenCode" and "New session" merged. New session = a new chat
    // with @opencode typed (a new thread is a new session); nothing is sent.
    {
        const executed = [];
        const realExec = vscodeStub.commands.executeCommand;
        vscodeStub.commands.executeCommand = async (id, ...args) => {
            executed.push([id, ...args]);
            const handler = registeredCommands.get(id);
            return handler ? handler(...args) : undefined;
        };
        await registeredCommands.get("opencodeCopilotBridge.newSession")();
        const opened = executed.filter((c) => c[0] === "workbench.action.chat.open");
        add("NS New session opens a new chat first", executed.findIndex((c) => c[0] === "workbench.action.chat.newChat") >= 0 && executed.findIndex((c) => c[0] === "workbench.action.chat.newChat") < executed.findIndex((c) => c[0] === "workbench.action.chat.open"));
        add("NS New session submits nothing (no /new sent into the old chat)", opened.length === 1 && opened[0][1].isPartialQuery === true && !executed.some((c) => c[1] && /\/new/.test(c[1].query || "")));
        settings.sessionScope = "workspace";
        memento.set(`opencode.session:${work}`, { id: "ses_ws", turns: 3 });
        executed.length = 0;
        await registeredCommands.get("opencodeCopilotBridge.newSession")();
        add("NS under workspace scope New session also clears the folder's session", !(memento.get(`opencode.session:${work}`) || {}).id);
        settings.sessionScope = "thread";
        const nsPkg = require(path.join(__dirname, "..", "package.json"));
        const hidden = (nsPkg.contributes.menus.commandPalette || []).filter((m) => m.when === "false").map((m) => m.command);
        add("NS Ask in Chat and New Chat stay registered but leave the palette", ["retryLast", "newChat"].every((c) => registeredCommands.has(`opencodeCopilotBridge.${c}`) && hidden.includes(`opencodeCopilotBridge.${c}`)));
        vscodeStub.commands.executeCommand = realExec;
    }

    // SL: /sessions — this folder's sessions from OpenCode's server; Continue
    // and Fork bind this chat (metadata threadSession reads), Close archives,
    // Delete deletes after a modal confirm. Read back from what hit the server.
    {
        const slSeen = [];
        let slBusy = {};
        // RV toggles: a failing list, a failing permission PATCH, a custom ask.
        let slListFail = false;
        let slPatchFail = false;
        let slAsk;
        const slSessions = [
            { id: "ses_mine", title: "Fix the login loop", time: { created: 1, updated: Date.now() - 3 * 3600e3 } },
            { id: "ses_other", title: "Audit deps", time: { created: 1, updated: Date.now() - 60e3 } },
            { id: "ses_gone", title: "Archived one", time: { created: 1, updated: 1, archived: 5 } }
        ];
        const slServer = http.createServer((req, res) => {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const u = new URL(req.url, "http://x");
                slSeen.push({ method: req.method, path: u.pathname, query: u.search, body: body ? JSON.parse(body) : undefined });
                const send = (code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
                if (u.pathname === "/global/health") return send(200, { healthy: true });
                if (u.pathname === "/session/status") return send(200, slBusy);
                if (req.method === "GET" && u.pathname === "/session") return slListFail ? send(500, { name: "UnknownError", data: {} }) : send(200, slSessions);
                if (req.method === "GET" && /\/message$/.test(u.pathname)) return send(200, [
                    { info: { role: "user" }, parts: [{ type: "text", text: slAsk ?? "why does login loop?" }] },
                    { info: { role: "assistant" }, parts: [{ type: "text", text: "A stale cookie survives logout." }, { type: "text", text: "hidden", synthetic: true }] }
                ]);
                if (req.method === "POST" && /\/fork$/.test(u.pathname)) return send(200, { id: "ses_fork", title: "Fix the login loop (fork #1)" });
                if (req.method === "POST" && /\/abort$/.test(u.pathname)) { slBusy = {}; return send(200, true); }
                if (req.method === "PATCH" && slPatchFail && u.pathname === "/session/ses_fork") return send(500, { name: "UnknownError", data: {} });
                if (req.method === "PATCH") return send(200, { id: u.pathname.split("/").pop() });
                if (req.method === "DELETE") return send(200, true);
                return send(404, {});
            });
        });
        await new Promise((r) => slServer.listen(0, "127.0.0.1", r));
        const slSaved = { p: settings.serverPort, t: settings.transport };
        settings.serverPort = slServer.address().port;
        const realPick = vscodeStub.window.showQuickPick;
        const realWarn = vscodeStub.window.showWarningMessage;
        let slPicks = [];
        const slRun = async (choose, confirm) => {
            slSeen.length = 0;
            slPicks = [];
            let step = 0;
            vscodeStub.window.showQuickPick = async (items, opts) => (slPicks.push({ items, opts }), choose[step++]?.(items));
            vscodeStub.window.showWarningMessage = async (...a) => (a[1] && a[1].modal ? confirm : undefined);
            const st = stream();
            const own = "opencodeCopilotBridge.chat";
            const history = [{ participant: own, result: { metadata: { kind: "plan", sessionId: "ses_mine", turns: 4, cwd: work } } }];
            const r = await global.__handler({ prompt: "", command: "sessions" }, { history }, st.response, st.token);
            return { r, text: st.chatMarkdown.join(""), history };
        };
        const by = (id) => (items) => items.find((i) => i.session && i.session.id === id);
        const act = (word) => (items) => items.find((i) => i.action === word);
        const scoped = (x) => x.query.includes(`directory=${encodeURIComponent(work)}`);

        const s0 = await slRun([() => undefined]);
        add("SL lists this folder's top-level sessions, newest data from the server, archived left out", slPicks[0] && slPicks[0].items.map((i) => i.detail).join() === "ses_mine,ses_other" && slSeen.some((x) => x.method === "GET" && x.path === "/session" && /roots=true/.test(x.query) && scoped(x)));
        add("SL marks this chat's session and how long ago each was active", /this chat/.test(slPicks[0].items[0].description) && /3h ago/.test(slPicks[0].items[0].description) && /1m ago/.test(slPicks[0].items[1].description));
        add("SL dismissing the list changes nothing and binds nothing", !s0.r.metadata.sessionId && s0.r.metadata.kind === "sessions" && !slSeen.some((x) => x.method !== "GET"));

        const s1 = await slRun([by("ses_other"), act("continue")]);
        add("SL the actions are Continue, Fork, Close, Delete", slPicks[1] && slPicks[1].items.map((i) => i.action).join() === "continue,fork,close,delete");
        add("SL Continue binds this chat to the picked session (threadSession reads it)", s1.r.metadata.sessionId === "ses_other" && ext.__test.threadSession([...s1.history, { participant: "opencodeCopilotBridge.chat", result: s1.r }], work)?.id === "ses_other");
        add("SL Continue shows the session's last ask and answer, not synthetic parts", /why does login loop\?/.test(s1.text) && /stale cookie/.test(s1.text) && !/hidden/.test(s1.text));
        add("SL Continue changes nothing on the server", !slSeen.some((x) => x.method !== "GET"));

        const s2 = await slRun([by("ses_mine"), act("fork")]);
        const fork = slSeen.find((x) => x.method === "POST" && x.path === "/session/ses_mine/fork");
        const perm = slSeen.find((x) => x.method === "PATCH" && x.path === "/session/ses_fork");
        add("SL Fork forks on the server, scoped, and binds this chat to the copy", Boolean(fork) && scoped(fork) && s2.r.metadata.sessionId === "ses_fork" && /ses_mine` is untouched/.test(s2.text));
        add("SL a fork gets the bridge's headless rules back (fork copies no permissions)", Boolean(perm) && JSON.stringify(perm.body.permission.map((r) => r.permission)) === '["question","plan_enter","plan_exit"]');

        slBusy = { ses_other: { type: "busy" } };
        const s2b = await slRun([by("ses_other"), act("continue")]);
        add("SL a running session is marked, and continuing it warns about busySessionPolicy", /running/.test(slPicks[0].items[1].description) && !/running/.test(slPicks[0].items[0].description) && /busySessionPolicy/.test(s2b.text) && !slSeen.some((x) => /\/abort$/.test(x.path)));
        const s3 = await slRun([by("ses_other"), act("close")]);
        const archive = slSeen.find((x) => x.method === "PATCH" && x.path === "/session/ses_other");
        add("SL Close stops a running session, then archives it", slSeen.findIndex((x) => /\/abort$/.test(x.path)) >= 0 && slSeen.findIndex((x) => /\/abort$/.test(x.path)) < slSeen.indexOf(archive) && typeof archive.body.time.archived === "number");
        add("SL closing another chat's session leaves this chat bound as it was", s3.r.metadata.kind === "sessions" && !s3.r.metadata.sessionId);

        const s4 = await slRun([by("ses_mine"), act("delete")], undefined);
        add("SL Delete asks first; dismissed, nothing is deleted", !slSeen.some((x) => x.method === "DELETE") && /Kept/.test(s4.text));
        const s5 = await slRun([by("ses_mine"), act("delete")], "Delete");
        const del = slSeen.find((x) => x.method === "DELETE");
        add("SL Delete of this chat's session deletes it, scoped, and starts this chat fresh", Boolean(del) && del.path === "/session/ses_mine" && scoped(del) && s5.r.metadata.kind === "new" && !ext.__test.threadSession([...s5.history, { participant: "opencodeCopilotBridge.chat", result: s5.r }], work));

        // RV: review findings on /sessions, each reproduced against this server.
        const own = "opencodeCopilotBridge.chat";
        const rv1 = await slRun([by("ses_mine"), act("continue")]);
        const rv1Bound = ext.__test.threadSession([...rv1.history, { participant: own, result: rv1.r }], work);
        add("RV keeping this chat's own session keeps its turn count (no re-bind at 0)", !rv1.r.metadata.sessionId && rv1Bound?.id === "ses_mine" && rv1Bound.turns === 4);

        slPatchFail = true;
        const rv2 = await slRun([by("ses_mine"), act("fork")]);
        slPatchFail = false;
        const rv2Del = slSeen.find((x) => x.method === "DELETE" && x.path === "/session/ses_fork");
        add("RV a fork whose headless rules cannot be restored is deleted, and nothing is bound", Boolean(rv2Del) && scoped(rv2Del) && !rv2.r.metadata.sessionId && /fork failed/.test(rv2.text));

        const pointer = `opencode.session:${work}`;
        memento.set(pointer, { id: "ses_other", turns: 2 });
        await slRun([by("ses_other"), act("delete")], "Delete");
        add("RV deleting another chat's session clears the folder pointer that held it", !(memento.get(pointer) || {}).id);
        memento.set(pointer, { id: "ses_other", turns: 2 });
        const rv3 = await slRun([by("ses_mine"), act("delete")], "Delete");
        add("RV deleting this chat's session leaves a pointer to another session alone", (memento.get(pointer) || {}).id === "ses_other" && rv3.r.metadata.kind === "new");
        memento.delete(pointer);

        slListFail = true;
        const rv4 = await slRun([() => undefined]);
        slListFail = false;
        add("RV a server error listing sessions is reported, not shown as no sessions", /Could not list sessions/.test(rv4.text) && /HTTP 500/.test(rv4.text) && !/No OpenCode sessions/.test(rv4.text) && !slPicks.length);

        const rvTitle = slSessions[1].title;
        slSessions[1].title = "fix *ptr | use `x` [here](y)";
        slAsk = "```sh\n" + "echo step\n".repeat(60);
        const rv5 = await slRun([by("ses_other"), act("continue")]);
        slSessions[1].title = rvTitle;
        slAsk = undefined;
        const rv5Before = rv5.text.slice(0, rv5.text.indexOf("Last answer:"));
        const rv5Fences = rv5Before.split("\n").filter((l) => /^>\s*```/.test(l)).length;
        add("RV a session title is plain text inside the bold", rv5.text.includes("**fix \\*ptr \\| use \\`x\\` \\[here\\](y)**"));
        add("RV an excerpt cut inside a code fence is closed before the next section", rv5Before.length > 0 && rv5Fences === 2);

        const slEvil = ext.__test.sessionRoot("../../config");
        add("SL a hostile session id cannot walk to another endpoint (one segment, never `..`)", slEvil.split("/").length === 3 && !slEvil.split("/").some((seg) => seg === ".." || seg === "."));

        vscodeStub.window.showQuickPick = realPick;
        vscodeStub.window.showWarningMessage = realWarn;
        await new Promise((r) => slServer.close(r));
        settings.serverPort = slSaved.p;
        settings.transport = slSaved.t;
        const slPkg = require(path.join(__dirname, "..", "package.json"));
        add("SL /sessions is a panel command, and `/ls` its alias", slPkg.contributes.chatParticipants[0].commands.some((c) => c.name === "sessions") && ext.__test.resolveAlias("/ls", ext.__test.commandAliases({})).prompt === "/sessions");
    }

    // PW: the /parallel composer — one quick pick per lane (type the task,
    // Enter = default model, or pick one); Submit from two lanes on; the
    // command is inserted into the chat input, never sent.
    {
        const executed = [];
        const realExec = vscodeStub.commands.executeCommand;
        vscodeStub.commands.executeCommand = async (id, ...args) => (executed.push([id, ...args]), undefined);
        globalMemento.set("opencode.models.v2", {
            models: ["acme-gateway/Tundra", "acme-gateway/Oasis", "ollama/qwen2.5-coder:7b"],
            info: { "acme-gateway/Tundra": { id: "acme-gateway/Tundra", name: "Tundra (Model-1)", provider: "g", providerName: "G" } },
            fetchedAt: Date.now()
        });
        const pages = [];
        const plan = (steps) => {
            let i = 0;
            quickPickScript = (qp) => {
                const next = () => {
                    // The words live in the description; the label is an icon.
                    const words = (it) => `${it.label} ${it.description ?? ""}`;
                    pages.push({ title: qp.title, step: qp.step, items: qp.items.map(words), shown: qp.items.every((it) => it.alwaysShow === true), iconOnly: qp.items.every((it) => /^\$\([\w-]+\)$/.test(it.label)), buttons: qp.buttons.length, active: qp.activeItems[0] && words(qp.activeItems[0]) });
                    const s = steps[i++];
                    if (!s) return qp.hide();
                    qp.value = s.type ?? "";
                    if (s.pick) qp.activeItems = [qp.items.find((it) => words(it).includes(s.pick))];
                    if (s.button) qp.trigger();
                    else qp.accept();
                    if (!qp.disposed) queueMicrotask(next);
                };
                next();
            };
        };
        const pwTurn = async (steps) => {
            pages.length = 0;
            executed.length = 0;
            plan(steps);
            fs.rmSync(path.join(work, "fake-ok.js.argv"), { force: true });
            const st = stream();
            const r = await global.__handler({ prompt: "", command: "parallel" }, {}, st.response, st.token);
            quickPickScript = undefined;
            return { r, text: st.chatMarkdown.join(""), buttons: st.buttons };
        };
        const insertedQuery = () => executed.filter((c) => c[0] === "workbench.action.chat.open").map((c) => c[1]);

        const w1 = await pwTurn([{ type: "review auth", pick: "Tundra" }, { type: "list deps" }, { button: true }]);
        const q1 = insertedQuery();
        add("PW page 1: the default model is first and active, no Submit yet", pages[0].items[0].includes("Default model") && pages[0].active.includes("Default model") && pages[0].buttons === 0 && !pages[0].items.some((l) => /Submit/.test(l)));
        add("PW every item is alwaysShow: typing a task never filters the models away", pages.length >= 3 && pages.every((p) => p.shown));
        add("PW pages count lanes (step 1, 2, 3)", pages.slice(0, 3).map((p) => p.step).join() === "1,2,3" && /lane 2/.test(pages[1].title));
        add("PW Submit appears from two lanes on, as a button and as the last item", pages[1].buttons === 0 && !pages[1].items.some((l) => /Submit/.test(l)) && pages[2].buttons === 1 && /Submit — insert 2 lanes/.test(pages[2].items[pages[2].items.length - 1]));
        add("PW Submit inserts the command into the chat input and sends nothing", q1.length === 1 && q1[0].isPartialQuery === true && !fs.existsSync(path.join(work, "fake-ok.js.argv")) && w1.r.metadata.kind === "composed");
        const lanesBack = ext.__test.splitLanes(q1[0].query.replace(/^@opencode \/parallel /, "")).map((l) => ext.__test.splitModelPrefix(l));
        add("PW the inserted command splits back into exactly those lanes and models", q1[0].query.startsWith("@opencode /parallel ") && lanesBack.length === 2 && lanesBack[0].model === "acme-gateway/Tundra" && lanesBack[0].task === "review auth" && !lanesBack[1].model && lanesBack[1].task === "list deps");
        const chipsOf = (r) => global.__participant.followupProvider.provideFollowups(r, {}, stream().token);
        const w1Chips = chipsOf(w1.r);
        add("PW the reply shows the command; its one chip runs those lanes, and there is no button", w1.text.includes(q1[0].query) && w1.buttons.length === 0 && w1Chips.length === 1 && w1Chips[0].command === "parallel" && w1Chips[0].prompt === q1[0].query.replace(/^@opencode \/parallel /, ""));
        add("PW the composed metadata carries its text as composedLanes, never lanes", typeof w1.r.metadata.composedLanes === "string" && w1.r.metadata.lanes === undefined);
        add("RV every composer label is an icon alone, so a typed task never matches or reorders it", pages.length >= 3 && pages.every((p) => p.iconOnly) && !pages.some((p) => p.items.some((l) => l.includes("`"))));

        const w2 = await pwTurn([{ type: "grep a | wc -l" }, { type: "grep `a | wc -l`" }, { type: "list deps" }, { type: "and a third", pick: "Submit" }]);
        const lanes2 = ext.__test.splitLanes(insertedQuery()[0].query.replace(/^@opencode \/parallel /, ""));
        add("PW a task that would split is refused on its page, and the lane is not added", /would split this into 2 lanes/.test(pages[1].title) && pages[1].step === 1);
        add("PW backticks make it one lane; the Submit item also takes the lane typed on its page", lanes2.length === 3 && lanes2[0] === "grep `a | wc -l`" && lanes2[2] === "and a third" && w2.r.metadata.kind === "composed");

        const w3 = await pwTurn([{ type: "only one lane" }]);
        add("PW Esc before Submit inserts nothing", insertedQuery().length === 0 && /No lanes composed/.test(w3.text));
        executed.length = 0;
        plan([{ type: "a" }, { type: "b" }, { button: true }]);
        await registeredCommands.get("opencodeCopilotBridge.composeParallel")();
        quickPickScript = undefined;
        add("PW the palette command composes and inserts the same way", insertedQuery().length === 1 && /^@opencode \/parallel a\n---\nb$/.test(insertedQuery()[0].query));
        add("PW lane text that starts with a model prefix is refused", Boolean(ext.__test.laneProblem("m:tundra x")) && !ext.__test.laneProblem("review the models: list"));

        // RV: a model id holding a colon survives the composer's round trip.
        await pwTurn([{ type: "review auth", pick: "qwen2.5-coder:7b" }, { type: "list deps" }, { button: true }]);
        const rvBack = ext.__test.splitLanes(insertedQuery()[0].query.replace(/^@opencode \/parallel /, "")).map((l) => ext.__test.splitModelPrefix(l));
        const smp = ext.__test.splitModelPrefix;
        add("RV a model id with a colon is kept whole, with its task", rvBack[0].model === "ollama/qwen2.5-coder:7b" && rvBack[0].task === "review auth" && smp("m:openrouter/x/deepseek-r1:free go").model === "openrouter/x/deepseek-r1:free");
        add("RV a trailing colon or comma after the model is still punctuation", smp("m:tundra: review").model === "tundra" && smp("m:tundra: review").task === "review" && smp("m:tundra,review").model === "tundra" && smp("m:tundra,review").task === "review");

        // RV: too few lanes offers the composer as a chip, not a button.
        const rvSt = stream();
        const rvOne = await global.__handler({ prompt: "just one lane", command: "parallel" }, {}, rvSt.response, rvSt.token);
        const rvOneChips = chipsOf(rvOne);
        add("RV too few lanes: a Compose chip (bare /parallel), no button", rvSt.buttons.length === 0 && rvOneChips.length === 1 && rvOneChips[0].command === "parallel" && rvOneChips[0].prompt === "" && /Compose/.test(rvOneChips[0].label));

        // RV: Stop while the composer waits on a cold model list (a CLI run of
        // seconds) ends the turn at once, and no quick pick opens afterwards.
        globalMemento.clear();
        const rvSlow = writeFake("fake-slow-models.js", [], "setTimeout(() => {}, 4000);\n");
        const rvSaved = { exe: settings.executable, transport: settings.transport };
        settings.executable = rvSlow;
        settings.transport = "cli";
        pages.length = 0;
        plan([{ type: "x" }]);
        const rvStop = stream();
        const rvT0 = Date.now();
        const rvTurn = global.__handler({ prompt: "", command: "parallel" }, {}, rvStop.response, rvStop.token);
        setTimeout(() => rvStop.token.cancel(), 300);
        await rvTurn;
        const rvTook = Date.now() - rvT0;
        await new Promise((r) => setTimeout(r, 4500));
        quickPickScript = undefined;
        settings.executable = rvSaved.exe;
        settings.transport = rvSaved.transport;
        add("RV Stop during the composer's cold model list ends the turn within the second", rvTook < 1300);
        add("RV …and no quick pick opens once the list arrives", pages.length === 0);

        // RV: Stop while a /parallel turn waits on a cold server boot (a serve
        // that never listens; ensureServer polls for 20 s) ends the turn at once.
        const bootPort = await new Promise((resolve) => {
            const probe = http.createServer().listen(0, "127.0.0.1", () => {
                const p = probe.address().port;
                probe.close(() => resolve(p));
            });
        });
        const bootSaved = { exe: settings.executable, transport: settings.transport, port: settings.serverPort };
        settings.executable = writeFake("fake-slow-serve.js", [], "if (process.argv.includes('serve')) setTimeout(() => {}, 4000);\n");
        settings.transport = "server";
        settings.serverPort = bootPort;
        const bootStop = stream();
        const bootT0 = Date.now();
        const bootTurn = global.__handler({ prompt: "a | b", command: "parallel" }, {}, bootStop.response, bootStop.token);
        setTimeout(() => bootStop.token.cancel(), 300);
        await bootTurn;
        const bootTook = Date.now() - bootT0;
        await new Promise((r) => setTimeout(r, 4500));
        settings.executable = bootSaved.exe;
        settings.transport = bootSaved.transport;
        settings.serverPort = bootSaved.port;
        add("RV Stop during a parallel turn's cold server boot ends the turn within the second", bootTook < 1300);

        vscodeStub.commands.executeCommand = realExec;
        globalMemento.clear();
    }

    let failed = 0;
    for (const [name, ok] of checks) {
        console.log(`${ok ? "  ok  " : "FAIL  "} ${name}`);
        if (!ok) failed += 1;
    }
    console.log("\n--- chat A (full) ---\n" + chat.slice(0, 400));
    console.log("\n--- chat (compact) ---\n" + chatU.slice(0, 400));
    console.log("\n--- chat (minimal) ---\n" + chatU2.slice(0, 200));
    console.log("\n--- parallel ---\n" + chatX.slice(0, 700));
    console.log(failed === 0 ? `\nALL ${checks.length} CHECKS PASSED` : `\n${failed} CHECK(S) FAILED`);
    // Best-effort. On Windows `work` is still some just-exited child's cwd and
    // rmSync throws EBUSY, which used to turn an all-green run into exit 1. The
    // startup sweep is what actually reclaims those, so a failure here is noise.
    // The rest are never a child's cwd, so they do come away cleanly.
    for (const dir of [work, path.join(os.tmpdir(), "ocb-root-b"), shimDir, envRoot, emptyRoot, globalRoot]) {
        try {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
            // Swept on the next run.
        }
    }
    // process.exit() truncates stdout when it is a PIPE: writes are asynchronous
    // there and exit does not drain them. The ship gate spawns this file and
    // greps the captured output for the pass banner, so a hard exit dropped the
    // last ~7 KB and the gate reported "verify printed the pass banner: FAIL" on
    // a run where all 305 checks passed. Setting exitCode lets the event loop
    // drain and exit on its own with the same status.
    process.exitCode = failed === 0 ? 0 : 1;
})().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
