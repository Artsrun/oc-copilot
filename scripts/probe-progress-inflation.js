// Probe: how many response.progress() calls does ONE turn make when the model
// streams reasoning, at the SHIPPED default progressHeartbeatMs (1000)?
// Copilot Chat renders each progress() as a "step".
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "oc-probe-"));

// 40 reasoning deltas + 6 tools + final text — a normal thinking run.
const events = [];
for (let i = 0; i < 40; i++) {
    events.push({ type: "reasoning", sessionID: "ses_p", part: { text: `reasoning chunk number ${i} about the auth flow` } });
    if (i % 7 === 0) {
        events.push({
            type: "tool_use",
            sessionID: "ses_p",
            part: { tool: "read", state: { input: { filePath: `src/f${i}.ts` }, output: "x", time: { start: 0, end: 5 } } }
        });
    }
}
events.push({ type: "text", sessionID: "ses_p", part: { text: "Done." } });
events.push({
    type: "step_finish",
    sessionID: "ses_p",
    part: { reason: "stop", cost: 0.001, tokens: { input: 10, output: 10, reasoning: 10, total: 30, cache: { read: 0, write: 0 } } }
});

const fakeJs = path.join(work, "fake-think.js");
fs.writeFileSync(
    fakeJs,
    "#!/usr/bin/env node\nconst events = " +
        JSON.stringify(events) +
        ";\nlet i=0;\nconst t=setInterval(()=>{if(i>=events.length){clearInterval(t);return;}process.stdout.write(JSON.stringify(events[i++])+'\\n');},25);\n"
);
fs.chmodSync(fakeJs, 0o755);
// Windows cannot spawn a shebang .js. Without this wrapper the spawn fails with
// ENOENT, the turn ends in 0.0s, and the probe reports "1 progress() call" —
// a clean bill of health for a run that never happened. verify-chat-output.js
// writeFake() does the same thing for the same reason.
let fake = fakeJs;
if (process.platform === "win32") {
    fake = fakeJs + ".cmd";
    fs.writeFileSync(fake, `@echo off\r\nnode "${fakeJs}" %*\r\n`);
}

const settings = {
    executable: fake,
    model: "",
    timeoutMs: 30000,
    transport: "cli",
    sessionLogDir: "sessions",
    chatDensity: "minimal",
    autoCompact: false,
    clarifyVaguePrompts: false,
    autoCleanSessions: false,
    statusBar: false,
    idleTimeoutMs: 0,
    sessionScope: "thread",
    progressHeartbeatMs: 1000 // SHIPPED DEFAULT — the verify suite runs this at 0
};

const vscodeStub = {
    workspace: {
        workspaceFolders: [{ uri: { fsPath: work }, name: path.basename(work), index: 0 }],
        getWorkspaceFolder: (u) => vscodeStub.workspace.workspaceFolders[0],
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

(async () => {
    const progress = [];
    const response = {
        markdown() {},
        progress: (v) => progress.push(String(v)),
        anchor() {},
        button() {},
        reference() {}
    };
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    const started = Date.now();
    await global.__handler({ prompt: "Explain the auth flow in this repo" }, { history: [] }, response, token);
    const elapsed = Date.now() - started;

    console.log(`run wall time      : ${(elapsed / 1000).toFixed(1)}s`);
    console.log(`progress() calls   : ${progress.length}`);
    console.log(`distinct texts     : ${new Set(progress).size}`);
    console.log(`reasoning-driven   : ${progress.filter((p) => p.includes("💭")).length}`);
    console.log(`tool-driven        : ${progress.filter((p) => /^(read|grep|bash)/.test(p)).length}`);
    console.log("\nfirst 5:");
    for (const p of progress.slice(0, 5)) console.log("  " + p);
    console.log("last 3:");
    for (const p of progress.slice(-3)) console.log("  " + p);
    fs.rmSync(work, { recursive: true, force: true });
})();
