// Probe: runOpenCodeServer subscribes to the server-wide /global/event stream and
// filters by session id. What happens to an event whose session id is not in a
// field sessionIdFromEvent() knows about — e.g. `message.updated` where
// properties.info.id is the MESSAGE id, which is what OpenCode actually sends?
//
// Two questions, both answered by bytes the extension produced:
//   1. does another session's text land in THIS chat's answer?
//   2. does a message.updated whose info.id is a message id get dropped?
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const Module = require("node:module");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "oc-sse-"));
const PORT = 45097;
const MINE = "ses_mine";

let sseRes;
const server = http.createServer((req, res) => {
    const url = req.url || "";
    if (url.startsWith("/global/health")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ healthy: true }));
    }
    if (url.startsWith("/global/event")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        sseRes = res;
        return;
    }
    if (req.method === "POST" && /\/session\/[^/]+\/message/.test(url)) {
        const send = (o) => sseRes?.write(`data: ${JSON.stringify(o)}\n\n`);
        setTimeout(() => {
            // (1) a text part belonging to ANOTHER session, shaped the way
            //     message.part.updated arrives but with no sessionID on the part.
            send({
                type: "message.part.updated",
                properties: { part: { type: "text", id: "prt_other", text: "LEAK: other chat's answer. " } }
            });
            // (2) a message.updated for MY session — info.id is the MESSAGE id.
            send({
                type: "message.updated",
                properties: { info: { id: "msg_abc", sessionID: MINE, role: "assistant" } }
            });
            // (3) my own real answer
            send({
                type: "message.part.updated",
                properties: { part: { type: "text", id: "prt_mine", sessionID: MINE, text: "MINE: the real answer." } }
            });
        }, 60);
        setTimeout(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ info: { sessionID: MINE, cost: 0.001, tokens: { input: 1, output: 1, total: 2, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] }));
        }, 400);
        return;
    }
    if (req.method === "POST" && url.startsWith("/session")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ id: MINE }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
});

const settings = {
    executable: "opencode",
    transport: "server",
    serverHostname: "127.0.0.1",
    serverPort: PORT,
    timeoutMs: 15000,
    idleTimeoutMs: 0,
    sessionLogDir: "sessions",
    chatDensity: "minimal",
    autoCompact: false,
    clarifyVaguePrompts: false,
    autoCleanSessions: false,
    statusBar: false,
    progressHeartbeatMs: 0,
    sessionScope: "thread"
};

const vscodeStub = {
    workspace: {
        workspaceFolders: [{ uri: { fsPath: work }, name: path.basename(work), index: 0 }],
        getWorkspaceFolder: () => vscodeStub.workspace.workspaceFolders[0],
        getConfiguration: () => ({ get: (k, d) => (settings[k] !== undefined ? settings[k] : d), update: async () => {} }),
        fs: {
            createDirectory: async (u) => fs.mkdirSync(u.fsPath, { recursive: true }),
            readFile: async (u) => fs.readFileSync(u.fsPath),
            writeFile: async (u, b) => fs.writeFileSync(u.fsPath, b)
        },
        onDidChangeConfiguration: () => ({ dispose() {} })
    },
    window: {
        activeTextEditor: undefined,
        state: { focused: true },
        createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
        createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
        showInformationMessage() {},
        showWarningMessage() {},
        createWebviewPanel: () => ({ webview: {}, onDidDispose: () => ({ dispose() {} }), dispose() {} })
    },
    chat: { createChatParticipant: (_i, h) => ((global.__handler = h), { dispose() {} }) },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
    Uri: { file: (p) => ({ fsPath: p, scheme: "file", toString: () => p }) },
    ThemeColor: class {},
    MarkdownString: class { constructor(v) { this.value = v; } },
    version: "1.136.0",
    env: { clipboard: { writeText: async () => {} } },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Workspace: 2 },
    ProgressLocation: { Notification: 15 },
    ViewColumn: { Beside: 2 }
};
const originalLoad = Module._load;
Module._load = function (r, ...rest) {
    return r === "vscode" ? vscodeStub : originalLoad.call(this, r, ...rest);
};

const ext = require(path.join(__dirname, "..", "out", "extension.js"));
const memento = new Map();
ext.activate({
    subscriptions: [],
    extensionUri: { fsPath: work, scheme: "file", toString: () => work },
    extensionPath: work,
    workspaceState: { get: (k) => memento.get(k), update: async (k, v) => void memento.set(k, v) },
    globalState: { get: (k) => memento.get(k), update: async (k, v) => void memento.set(k, v) }
});

server.listen(PORT, "127.0.0.1", async () => {
    const md = [];
    const response = {
        markdown: (v) => md.push(String(v?.value ?? v)),
        progress() {},
        anchor() {},
        button() {},
        reference() {}
    };
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    await global.__handler({ prompt: "what does this repo do" }, { history: [] }, response, token);
    const chat = md.join("");
    console.log("--- chat body actually streamed ---");
    console.log(chat.slice(0, 400));
    console.log("-----------------------------------");
    console.log("foreign session text present :", chat.includes("LEAK:"));
    console.log("own session text present     :", chat.includes("MINE:"));
    server.close();
    sseRes?.end();
    fs.rmSync(work, { recursive: true, force: true });
    process.exit(0);
});
