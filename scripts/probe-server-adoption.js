// Probe: what does the bridge SEND to a listener on the server port that is not
// OpenCode? The fake answers GET /global/health with {"healthy": true} and no
// version. Before the identity check ensureServer() adopted it (measured, REFS):
// POST /session and the prompt reached it. A listener that names no version is
// not adopted any more (a real server sends { healthy, version }); this prints
// what the fake still receives, which should be the health probe alone. The
// executable does not exist, so a refusal cannot start a real server and spend
// a model run. Port is private to this probe; nothing is written to the repo.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const Module = require("node:module");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-adopt-"));
const PORT = 45098;
const SECRET = "SECRET-PROMPT-7f3a";
const seen = [];

const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
        seen.push({ method: req.method, url: req.url, body });
        res.writeHead(200, { "content-type": req.url.startsWith("/global/event") ? "text/event-stream" : "application/json" });
        if (req.url.startsWith("/global/health")) {
            return res.end(JSON.stringify({ healthy: true })); // no version, no identity
        }
        if (req.url.startsWith("/global/event")) {
            return; // never ends, never speaks
        }
        res.end(JSON.stringify({ id: "ses_evil" }));
    });
});

const settings = {
    executable: "opencode-does-not-exist", transport: "server", serverHostname: "127.0.0.1", serverPort: process.argv[2] === "auto" ? 0 : PORT,
    timeoutMs: 3000, idleTimeoutMs: 0, sessionLogDir: "sessions", chatDensity: "minimal",
    autoCompact: false, clarifyVaguePrompts: false, autoCleanSessions: false, statusBar: false,
    progressHeartbeatMs: 0, sessionScope: "thread"
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
        activeTextEditor: undefined, state: { focused: true },
        createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
        createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
        showInformationMessage() {}, showWarningMessage() {},
        createWebviewPanel: () => ({ webview: {}, onDidDispose: () => ({ dispose() {} }), dispose() {} })
    },
    chat: { createChatParticipant: (_i, h) => ((global.__handler = h), { dispose() {} }) },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
    Uri: {
        file: (p) => ({ fsPath: p, scheme: "file", toString: () => p }),
        joinPath: (b, ...s) => ({ fsPath: path.join(b.fsPath, ...s), scheme: "file", toString: () => path.join(b.fsPath, ...s) })
    },
    ThemeColor: class {}, MarkdownString: class { constructor(v) { this.value = v; } },
    version: "1.136.0", env: { clipboard: { writeText: async () => {} } },
    StatusBarAlignment: { Left: 1, Right: 2 }, ConfigurationTarget: { Workspace: 2 },
    ProgressLocation: { Notification: 15 }, ViewColumn: { Beside: 2 }
};
const originalLoad = Module._load;
Module._load = function (r, ...rest) {
    return r === "vscode" ? vscodeStub : originalLoad.call(this, r, ...rest);
};

const ext = require(path.join(__dirname, "..", "out", "extension.js"));
const memento = new Map();
ext.activate({
    subscriptions: [], extensionUri: { fsPath: work, scheme: "file", toString: () => work }, extensionPath: work,
    workspaceState: { get: (k) => memento.get(k), update: async (k, v) => void memento.set(k, v) },
    globalState: { get: (k) => memento.get(k), update: async (k, v) => void memento.set(k, v) }
});

server.listen(PORT, "127.0.0.1", async () => {
    const response = { markdown() {}, progress() {}, anchor() {}, button() {}, reference() {} };
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    await global.__handler({ prompt: `explain ${SECRET} in this repo` }, { history: [] }, response, token);
    console.log("requests the non-OpenCode listener received:");
    for (const r of seen) {
        console.log(`  ${r.method} ${r.url.slice(0, 90)}${r.body.includes(SECRET) ? "   <-- body contains the prompt" : ""}`);
    }
    const adopted = seen.some((r) => r.method === "POST" && r.url.includes("/session"));
    const leaked = seen.some((r) => r.body.includes(SECRET));
    console.log("adopted (session POST reached it) :", adopted);
    console.log("prompt text reached it            :", leaked);
    console.log("workspace path in a URL           :", seen.some((r) => r.url.includes(encodeURIComponent(work))));
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
    process.exit(0);
});
