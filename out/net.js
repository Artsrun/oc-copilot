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
exports.PREWARM_DELAY_MS = exports.currentServerGeneration = exports.lastServeFailure = exports.forgetDataFolderClash = exports.isDataFolderClash = exports.plainError = exports.isNotOpenCode1 = exports.openCode1Refusal = exports.isIdentityUnknown = exports.serverVersion = exports.TESTED_OPENCODE2 = exports.TESTED_OPENCODE = exports.openCode2Allowed = exports.serverAuth = void 0;
exports.withDirectory = withDirectory;
exports.httpRequestJson = httpRequestJson;
exports.httpGetJson = httpGetJson;
exports.httpPostJson = httpPostJson;
exports.setStartupDeadline = setStartupDeadline;
exports.versionNotice = versionNotice;
exports.ensureCliIdentity = ensureCliIdentity;
exports.markNotOpenCode1 = markNotOpenCode1;
exports.noteDataFolderClash = noteDataFolderClash;
exports.dataFolderRefusal = dataFolderRefusal;
exports.majorVersionNote = majorVersionNote;
exports.knownServerBase = knownServerBase;
exports.stopServer = stopServer;
exports.ensureServer = ensureServer;
exports.warmServer = warmServer;
exports.prewarmServer = prewarmServer;
exports.lastServeLine = lastServeLine;
exports.sessionIdFromEvent = sessionIdFromEvent;
exports.connectSse = connectSse;
const vscode = __importStar(require("vscode"));
const http = __importStar(require("node:http"));
const net = __importStar(require("node:net"));
const core_1 = require("./core");
const enforce_1 = require("./enforce");
const proc_1 = require("./proc");
const v2_events_1 = require("./v2-events");
function withDirectory(url, cwd) {
    if (!cwd) {
        return url;
    }
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}directory=${encodeURIComponent(cwd)}`;
}
function httpRequestJson(method, url, body, timeoutMs, token, auth) {
    return new Promise((resolve, reject) => {
        const data = body !== undefined ? Buffer.from(JSON.stringify(body), "utf8") : undefined;
        const headers = { ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...auth };
        const req = http.request(url, { method, headers }, (res) => {
            let raw = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (raw += c));
            res.on("error", reject);
            res.on("end", () => {
                const code = res.statusCode ?? 0;
                if (code >= 200 && code < 300) {
                    try {
                        resolve((raw ? JSON.parse(raw) : {}));
                    }
                    catch (error) {
                        reject(error);
                    }
                }
                else {
                    reject(new Error(`HTTP ${code}: ${(0, core_1.truncate)(raw, 200)}`));
                }
            });
        });
        let timer;
        if (timeoutMs && timeoutMs > 0) {
            timer = setTimeout(() => {
                req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT_BRIDGE" }));
            }, timeoutMs);
        }
        const cancel = token?.onCancellationRequested(() => {
            req.destroy(Object.assign(new Error("cancelled"), { code: "ECANCELLED_BRIDGE" }));
        });
        req.on("error", (err) => {
            if (timer) {
                clearTimeout(timer);
            }
            cancel?.dispose();
            reject(err);
        });
        req.on("close", () => {
            if (timer) {
                clearTimeout(timer);
            }
            cancel?.dispose();
        });
        if (data) {
            req.write(data);
        }
        req.end();
    });
}
function httpGetJson(url, timeoutMs = 5000, auth) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, { headers: auth ?? {} }, (res) => {
            let data = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (data += chunk));
            res.on("error", reject);
            res.on("end", () => {
                try {
                    resolve(JSON.parse(data));
                }
                catch (error) {
                    reject(Object.assign(error, { code: "ENOTJSON", status: res.statusCode }));
                }
            });
        });
        request.setTimeout(timeoutMs, () => {
            request.destroy(new Error(`GET ${url} timed out after ${timeoutMs} ms`));
        });
        request.on("error", reject);
    });
}
function httpPostJson(url, body, timeoutMs = 30000, auth) {
    return new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(body ?? {}), "utf8");
        const request = http.request(url, {
            method: "POST",
            headers: { "content-type": "application/json", "content-length": data.length, ...auth }
        }, (res) => {
            res.on("data", () => undefined);
            res.on("error", reject);
            res.on("end", () => resolve(res.statusCode ?? 0));
        });
        if (timeoutMs > 0) {
            request.setTimeout(timeoutMs, () => {
                request.destroy(new Error(`POST ${url} timed out after ${timeoutMs} ms`));
            });
        }
        request.on("error", reject);
        request.write(data);
        request.end();
    });
}
let serveProcess;
let serveSpawnError;
const adoptedServers = new Set();
let managedPort;
let fallbackPort;
let serveTail = "";
let servePassword;
const serverAuths = new Map();
const serverAuth = (base) => serverAuths.get(base);
exports.serverAuth = serverAuth;
const openCode2Allowed = () => (0, core_1.config)().get("opencode2", false) === true;
exports.openCode2Allowed = openCode2Allowed;
let servePort;
const serveAlive = () => Boolean(serveProcess && serveProcess.exitCode === null);
function portTaken(host, port, timeoutMs = 1000) {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const done = (taken) => {
            socket.destroy();
            resolve(taken);
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
    });
}
const POLL_HEALTH_MS = 3000;
const STARTUP_DEADLINE_MS = 45000;
let startupDeadlineMs = STARTUP_DEADLINE_MS;
function setStartupDeadline(ms) {
    startupDeadlineMs = ms ?? STARTUP_DEADLINE_MS;
}
const SLOW_START_MS = 1500;
exports.TESTED_OPENCODE = { min: "1.18.27", max: "1.19.0" };
exports.TESTED_OPENCODE2 = { min: "2.0.18", max: "2.2.0" };
const serverVersions = new Map();
const serverVersion = (base) => serverVersions.get(base);
exports.serverVersion = serverVersion;
const versionsNoted = new Set();
const semver = (v) => {
    const m = v.match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};
const below = (a, b) => a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];
function versionNotice(base) {
    const version = serverVersions.get(base);
    const v = version ? semver(version) : undefined;
    if (!version || !v || versionsNoted.has(version)) {
        return undefined;
    }
    const range = v[0] >= 2 ? exports.TESTED_OPENCODE2 : exports.TESTED_OPENCODE;
    const lo = semver(range.min);
    const hi = semver(range.max);
    if (!below(v, lo) && !below(hi, v)) {
        return undefined;
    }
    versionsNoted.add(version);
    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] OpenCode ${version} on ${base} is outside the tested ${range.min}–${range.max}`);
    return `OpenCode ${version} is outside the versions this bridge was tested with (${range.min}–${range.max}). It runs; if something misbehaves, the debug log and REFS.md name what each version was measured on.`;
}
const notOpenCode1 = new Map();
const cliIdentity = new Map();
const IDENTITY_TIMEOUT_MS = 6000;
const isIdentityUnknown = (error) => error?.code === "EOPENCODEIDENTITY";
exports.isIdentityUnknown = isIdentityUnknown;
const identityUnknown = (executable, why) => Object.assign(new Error(`Nothing was run: \`${executable}\` is not confirmed as OpenCode 1 — its \`--version\` ${why}. ` +
    "`/ping` shows what it prints; the next message checks again."), { code: "EOPENCODEIDENTITY" });
const fileOf = (executable, forget = false) => {
    try {
        return (0, proc_1.executableStamp)(executable, forget);
    }
    catch {
        return "";
    }
};
function ensureCliIdentity(executable, cwd) {
    const v2 = (0, exports.openCode2Allowed)();
    const refusal = (0, exports.openCode1Refusal)(executable);
    if (refusal && !v2) {
        return Promise.reject(refusal);
    }
    const hit = cliIdentity.get(executable);
    let file = fileOf(executable);
    if (hit && hit.file === file && hit.v2 === v2 && !refusal) {
        return hit.check;
    }
    if (hit) {
        file = fileOf(executable, true);
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${executable} changed on disk since its identity check — checking it again`);
    }
    const started = Date.now();
    const check = (0, proc_1.runCapture)(executable, ["--version"], cwd, IDENTITY_TIMEOUT_MS, true).then((output) => {
        majorVersionNote(executable, output);
        const unsupported = (0, exports.openCode1Refusal)(executable);
        if (unsupported) {
            throw unsupported;
        }
        if (!new RegExp(`(?:^|\\s)v?${v2 ? "[1-9]\\d*" : "1"}\\.\\d+\\.\\d+(?:\\s|$|[-+])`).test(output.trim())) {
            throw identityUnknown(executable, `printed no 1.x version (\`${(0, core_1.truncate)(output.trim().replace(/\s+/g, " ").replace(/`/g, "'"), 40)}\`)`);
        }
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] CLI identity verified in ${Date.now() - started}ms`);
    }).catch((error) => {
        if (cliIdentity.get(executable)?.check === check) {
            cliIdentity.delete(executable);
        }
        const code = error?.code;
        if ((0, exports.isNotOpenCode1)(error) || (0, exports.isIdentityUnknown)(error) || code === "ENOENT") {
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw identityUnknown(executable, /timed out/.test(message) ? `did not answer within ${IDENTITY_TIMEOUT_MS / 1000} s` : `failed (${(0, core_1.truncate)(message.replace(/\s+/g, " ").replace(/`/g, "'"), 80)})`);
    });
    cliIdentity.set(executable, { file, v2, check });
    return check;
}
function markNotOpenCode1(executable, evidence) {
    const error = Object.assign(new Error(`\`opencode\` here is not OpenCode 1: ${evidence}. The bridge drives OpenCode 1 only so far (its server API and permission rules), so nothing was run. ` +
        "To keep OpenCode 2 and use @opencode, give the bridge its own 1.x: `npm i --prefix ~/.opencode1 opencode-ai@1`, set " +
        "`opencodeCopilotBridge.executable` to `~/.opencode1/node_modules/.bin/opencode` (`opencode.cmd` on Windows), then run `/ping`. " +
        "Or try `opencodeCopilotBridge.opencode2` (experimental): OpenCode 2 through its API. The README's *OpenCode 2* section says what the two share."), { code: "ENOTOPENCODE1" });
    if (!notOpenCode1.has(executable)) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${executable}: ${error.message}`);
    }
    notOpenCode1.set(executable, error);
    return error;
}
const openCode1Refusal = (executable) => notOpenCode1.get(executable);
exports.openCode1Refusal = openCode1Refusal;
const isNotOpenCode1 = (error) => error?.code === "ENOTOPENCODE1";
exports.isNotOpenCode1 = isNotOpenCode1;
const plainError = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
exports.plainError = plainError;
const DATA_CLASH = /Database is not empty and has no session table/i;
const dataClash = new Map();
const isDataFolderClash = (error) => error?.code === "EOPENCODEDATA";
exports.isDataFolderClash = isDataFolderClash;
function noteDataFolderClash(executable, output) {
    if (!DATA_CLASH.test((0, exports.plainError)(output))) {
        return undefined;
    }
    const error = Object.assign(new Error("Nothing was run: OpenCode 1 cannot open its data folder — its `opencode.db` was created by OpenCode 2, without 1.x's `session` table. " +
        "Give 1.x its own folder: close VS Code and start it with `XDG_DATA_HOME` set (PowerShell: `$env:XDG_DATA_HOME = \"$HOME\\.opencode1\\data\"; code .`), " +
        "or turn on `opencodeCopilotBridge.opencode2`. `/ping` checks again."), { code: "EOPENCODEDATA" });
    if (!dataClash.has(executable)) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${executable}: OpenCode 1 cannot open its data folder (created by OpenCode 2); nothing more is started until /ping`);
    }
    dataClash.set(executable, { file: fileOf(executable), error });
    return error;
}
function dataFolderRefusal(executable) {
    const hit = dataClash.get(executable);
    if (hit && hit.file !== fileOf(executable)) {
        dataClash.delete(executable);
        return undefined;
    }
    return hit?.error;
}
const forgetDataFolderClash = (executable) => dataClash.delete(executable);
exports.forgetDataFolderClash = forgetDataFolderClash;
let serveFailure;
const lastServeFailure = () => serveFailure;
exports.lastServeFailure = lastServeFailure;
function majorVersionNote(executable, output) {
    const found = output.match(/(?:^|\s)v?(\d+)\.\d+\.\d+/);
    const major = found ? Number(found[1]) : undefined;
    if (major === 1 || (major !== undefined && major >= 2 && (0, exports.openCode2Allowed)())) {
        if (notOpenCode1.has(executable)) {
            cliIdentity.delete(executable);
        }
        notOpenCode1.delete(executable);
        (0, enforce_1.noteExecutableMajor)(executable, major);
        return undefined;
    }
    else if (major !== undefined && major >= 2) {
        markNotOpenCode1(executable, `\`--version\` prints \`${(0, core_1.truncate)(output.trim(), 40)}\``);
        return `OpenCode ${major}: the bridge drives 1.x only so far — README, *OpenCode 2*`;
    }
    return undefined;
}
async function freePort(host) {
    return new Promise((resolve, reject) => {
        const probe = http.createServer();
        probe.once("error", reject);
        probe.listen(0, host, () => {
            const port = probe.address().port;
            probe.close(() => resolve(port));
        });
    });
}
function knownServerBase() {
    const settings = (0, core_1.config)();
    const host = settings.get("serverHostname", "127.0.0.1");
    const port = settings.get("serverPort", 53200);
    if (port > 0) {
        return `http://${host}:${fallbackPort && serveAlive() ? fallbackPort : port}`;
    }
    return managedPort && serveProcess && serveProcess.exitCode === null ? `http://${host}:${managedPort}` : undefined;
}
let serverGeneration = 0;
const currentServerGeneration = () => serverGeneration;
exports.currentServerGeneration = currentServerGeneration;
function stopServer() {
    if (serveProcess && serveProcess.exitCode === null) {
        (0, proc_1.killTree)(serveProcess);
    }
    serveProcess = undefined;
    managedPort = undefined;
    fallbackPort = undefined;
    servePort = undefined;
    servePassword = undefined;
    serverAuths.clear();
    serverGeneration += 1;
    startInFlight = undefined;
}
let startInFlight;
const SLOW_START_TEXT = "Starting the OpenCode server — a first start loads its config, plugins and MCP servers…";
function ensureServer(cwd, onSlowStart) {
    if (startInFlight) {
        const shared = startInFlight;
        if (onSlowStart) {
            const timer = setTimeout(() => {
                try {
                    onSlowStart(SLOW_START_TEXT);
                }
                catch {
                }
            }, SLOW_START_MS);
            timer.unref?.();
            const clear = () => clearTimeout(timer);
            shared.then(clear, clear);
        }
        return shared;
    }
    const start = ensureServerOnce(cwd, onSlowStart);
    startInFlight = start;
    const done = () => {
        if (startInFlight === start) {
            startInFlight = undefined;
        }
    };
    start.then(done, done);
    return start;
}
async function ensureServerOnce(cwd, onSlowStart) {
    const settings = (0, core_1.config)();
    const executable = settings.get("executable", "opencode");
    const host = settings.get("serverHostname", "127.0.0.1");
    const configured = settings.get("serverPort", 53200);
    const own = configured <= 0;
    if (!serveAlive()) {
        fallbackPort = undefined;
        if (own) {
            managedPort = await freePort(host);
        }
    }
    else if (servePort !== undefined) {
        if (own && managedPort === undefined) {
            managedPort = servePort;
        }
        else if (!own && servePort !== configured && fallbackPort === undefined) {
            fallbackPort = servePort;
        }
    }
    let port = own ? managedPort : fallbackPort ?? configured;
    let base = `http://${host}:${port}`;
    const probe = async (timeoutMs) => {
        try {
            const health = await httpGetJson(`${base}/global/health`, timeoutMs);
            const version = typeof health.version === "string" && health.version.trim() ? health.version.trim() : undefined;
            if (health.healthy === true && version) {
                serverVersions.set(base, version);
            }
            return { healthy: health.healthy === true, version };
        }
        catch (error) {
            const { code, status } = error;
            const page = code === "ENOTJSON" && typeof status === "number" && status >= 200 && status < 300;
            if (page && servePassword && serveAlive() && base === `http://${host}:${servePort}` && (0, exports.openCode2Allowed)() && (0, enforce_1.executableMajor)(executable) === 2) {
                const auth = { authorization: "Basic " + Buffer.from(`opencode:${servePassword}`).toString("base64") };
                try {
                    const info = await httpGetJson(`${base}/api/info`, timeoutMs, auth);
                    const version = typeof info.version === "string" ? info.version.trim() : "";
                    if (Number(version.match(/^v?(\d+)\./)?.[1] ?? 0) >= 2) {
                        serverVersions.set(base, version);
                        serverAuths.set(base, auth);
                        return { healthy: true, version };
                    }
                }
                catch {
                }
            }
            return { healthy: false, page };
        }
    };
    const healthy = async (timeoutMs) => (await probe(timeoutMs)).healthy;
    let foreign = false;
    if (!own && !fallbackPort) {
        const first = await probe();
        const startedHere = Boolean(serveProcess && serveProcess.exitCode === null);
        if (first.healthy && (startedHere || first.version)) {
            serveSpawnError = undefined;
            if (!startedHere && !adoptedServers.has(base)) {
                adoptedServers.add(base);
                serverGeneration += 1;
                core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] adopted an OpenCode server already listening on ${base}. ` +
                    `Requests are scoped to ${cwd ?? "this workspace"} via ?directory=.`);
            }
            return base;
        }
        foreign = first.healthy;
    }
    if ((own || fallbackPort) && serveAlive() && (await healthy())) {
        return base;
    }
    if (!own && !serveAlive() && (foreign || (await portTaken(host, configured)))) {
        fallbackPort = await freePort(host);
        core_1.logChannel.appendLine(foreign
            ? `[${(0, core_1.stamp)()}] port ${configured} answers /global/health but names no OpenCode version (a real server sends { healthy, version }) — ` +
                `another program, or an OpenCode too old to say. This window starts its own server on port ${fallbackPort} ` +
                `and sends nothing to ${configured} but that health probe. serverPort 0 always does this.`
            : `[${(0, core_1.stamp)()}] port ${configured} accepts connections but did not answer /global/health — ` +
                `a hung server or another program. This window starts its own server on port ${fallbackPort} ` +
                `and sends nothing to ${configured}. serverPort 0 always does this.`);
        port = fallbackPort;
        base = `http://${host}:${port}`;
    }
    if (!serveAlive()) {
        if ((0, exports.openCode2Allowed)()) {
            await ensureCliIdentity(executable, cwd ?? (0, core_1.resolveFolder)()?.folder.uri.fsPath ?? process.cwd());
        }
        const refused = (0, exports.openCode1Refusal)(executable) ?? dataFolderRefusal(executable);
        if (refused) {
            throw refused;
        }
        const serveCwd = cwd ?? (0, core_1.resolveFolder)()?.folder.uri.fsPath;
        serveSpawnError = undefined;
        serveTail = "";
        servePassword = undefined;
        servePort = port;
        serverGeneration += 1;
        serveProcess = (0, proc_1.spawnOpenCode)(executable, ["serve", "--port", String(port), "--hostname", host], serveCwd);
        serveProcess.stdout?.setEncoding("utf8");
        serveProcess.stderr?.setEncoding("utf8");
        const keep = (d) => {
            const secret = d.match(/\bserver password\s+(\S+)/i)?.[1];
            if (secret) {
                servePassword = secret;
            }
            const said = (0, exports.plainError)(d).replace(/\b(password)(\s*[:=]\s*|\s+)\S+/gi, "$1$2[redacted]");
            core_1.logChannel.appendLine(`[serve] ${said.trim()}`);
            serveTail = (serveTail + said).slice(-600);
        };
        for (const stream of [serveProcess.stdout, serveProcess.stderr]) {
            let line = "";
            let oversized = false;
            stream?.on("data", (chunk) => {
                for (const part of chunk.split(/(?<=\n)/)) {
                    if (!oversized) {
                        if (line.length + part.length > 8192) {
                            line = "";
                            oversized = true;
                            keep("server diagnostic line exceeded 8 KiB; discarded\n");
                        }
                        else {
                            line += part;
                        }
                    }
                    if (part.endsWith("\n")) {
                        if (!oversized) {
                            keep(line);
                        }
                        line = "";
                        oversized = false;
                    }
                }
            });
            stream?.on("end", () => {
                if (line && !oversized) {
                    keep(line);
                }
            });
        }
        serveProcess.on("error", (error) => {
            serveSpawnError = error.message;
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] serve failed to start: ${error.message}`);
        });
        serveProcess.on("close", (code) => core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] serve exited (${code})`));
    }
    const pollMs = Math.max(50, settings.get("serverStartupPollMs", 350));
    let waitMs = 50;
    const waitStarted = Date.now();
    const deadline = waitStarted + startupDeadlineMs;
    let told = false;
    const mine = serveProcess;
    const exited = () => {
        if (serveProcess !== mine) {
            return new Error("OpenCode server was stopped while it was starting.");
        }
        if (!serveProcess || serveProcess.exitCode === null) {
            return undefined;
        }
        if (serveSpawnError) {
            return new Error(`OpenCode server could not be started: ${serveSpawnError}`);
        }
        const clash = noteDataFolderClash(executable, serveTail);
        if (clash) {
            return clash;
        }
        const why = lastServeLine(serveTail);
        return new Error(`OpenCode server process exited (code ${serveProcess.exitCode})${why ? `: ${why}` : "."}`);
    };
    while (Date.now() < deadline) {
        await (0, core_1.delay)(waitMs);
        waitMs = Math.min(pollMs, waitMs * 2);
        const dead = exited();
        if (dead) {
            throw dead;
        }
        const health = await probe(POLL_HEALTH_MS);
        if (health.healthy) {
            serveFailure = undefined;
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] serve on ${base} answered after ${((Date.now() - waitStarted) / 1000).toFixed(1)}s`);
            return base;
        }
        if (health.page && serveProcess === mine && serveAlive() && !((0, exports.openCode2Allowed)() && (0, enforce_1.executableMajor)(executable) === 2)) {
            stopServer();
            throw markNotOpenCode1(executable, "its server answers `/global/health` with a web page, as OpenCode 2 does");
        }
        if (!told && onSlowStart && Date.now() - waitStarted >= SLOW_START_MS) {
            told = true;
            try {
                onSlowStart(SLOW_START_TEXT);
            }
            catch {
            }
        }
    }
    throw exited() ?? new Error(stillStarting(base, configured));
}
async function warmServer(cwd, onSlowStart) {
    try {
        return await ensureServer(cwd, onSlowStart);
    }
    catch (error) {
        const why = (0, exports.plainError)(error instanceof Error ? error.message : String(error));
        serveFailure = (0, core_1.truncate)(why, 200);
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] ${(0, exports.isNotOpenCode1)(error)
            ? "server not started: not OpenCode 1 (logged above)"
            : (0, exports.isDataFolderClash)(error) ? "server not started: its data folder is OpenCode 2's (logged above)" : `server unavailable, dev runs cold: ${why}`}`);
        return undefined;
    }
}
exports.PREWARM_DELAY_MS = 3000;
function prewarmServer() {
    const settings = (0, core_1.config)();
    const trusted = vscode.workspace.isTrusted === true;
    if (!settings.get("prewarmServer", true) || !trusted) {
        return undefined;
    }
    const cwd = (0, core_1.resolveFolder)()?.folder.uri.fsPath;
    if (!cwd) {
        return undefined;
    }
    if (settings.get("transport", "auto") === "cli") {
        const executable = settings.get("executable", "opencode");
        void ensureCliIdentity(executable, cwd).catch((error) => core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] CLI prewarm identity check failed: ${error}`));
        return undefined;
    }
    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] prewarming the OpenCode server for ${cwd}`);
    return warmServer(cwd);
}
function stillStarting(base, configured) {
    const said = lastServeLine(serveTail);
    return (`OpenCode server did not become healthy on ${base} within ${Math.round(startupDeadlineMs / 1000)} s; the process is still running` +
        (said ? ` (it last printed: ${said})` : " and printed nothing") +
        "." +
        (fallbackPort
            ? ` Port ${configured} is held by a listener that does not answer — usually a hung \`opencode serve\` from another window, ` +
                "which can also hold OpenCode's database and keep a new server from starting. End that process and retry."
            : " A first start loads plugins and MCP servers; if it keeps failing, run `opencode serve` in a terminal to see why."));
}
function lastServeLine(output) {
    const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const err = [...lines].reverse().find((l) => /error|EADDRINUSE|failed|cannot|denied/i.test(l));
    return (0, core_1.truncate)(err ?? lines[lines.length - 1] ?? "", 200);
}
function sessionIdFromEvent(ev) {
    const props = ev.properties;
    const info = props?.info;
    const part = (props?.part ?? ev.part);
    return (part?.sessionID ??
        info?.sessionID ??
        props?.sessionID ??
        ev.sessionID ??
        ev.sessionId);
}
function carriesContent(ev) {
    const props = ev.properties;
    const part = (props?.part ?? ev.part);
    return part?.type === "text" || part?.type === "reasoning";
}
const sseConnections = new Map();
function openSharedSse(base) {
    const subscribers = new Set();
    let request;
    let retryTimer;
    let closed = false;
    let backoffMs = 1500;
    const shared = {
        subscribers,
        lastStatus: "",
        close: () => {
            closed = true;
            if (retryTimer) {
                clearTimeout(retryTimer);
            }
            request?.destroy();
        }
    };
    const status = (text) => {
        shared.lastStatus = text;
        for (const sub of [...subscribers]) {
            sub.onStatus(text);
        }
    };
    const dispatch = (payload) => {
        const sid = sessionIdFromEvent(payload);
        const contentful = carriesContent(payload);
        for (const sub of [...subscribers]) {
            if (!sub.sessionId || sid === sub.sessionId || (sid === undefined && !contentful)) {
                sub.onEvent(payload);
            }
        }
    };
    const scheduleRetry = () => {
        if (closed || retryTimer) {
            return;
        }
        status(`reconnecting in ${Math.round(backoffMs / 1000)}s…`);
        retryTimer = setTimeout(() => {
            retryTimer = undefined;
            connect();
        }, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 10000);
    };
    const connect = () => {
        const auth = (0, exports.serverAuth)(base);
        const translate = auth ? (0, v2_events_1.v2Translator)() : undefined;
        request = http.get(`${base}${auth ? "/api/event" : "/global/event"}`, { headers: auth ?? {} }, (res) => {
            if (res.statusCode !== 200) {
                status(`SSE HTTP ${res.statusCode}`);
                res.resume();
                scheduleRetry();
                return;
            }
            backoffMs = 1500;
            status("connected");
            res.setEncoding("utf8");
            let buffer = "";
            res.on("data", (chunk) => {
                buffer += chunk;
                let start = 0;
                let index = buffer.indexOf("\n\n", start);
                while (index >= 0) {
                    const frame = buffer.slice(start, index);
                    const data = frame
                        .split("\n")
                        .filter((line) => line.startsWith("data:"))
                        .map((line) => line.slice(5).trim())
                        .join("");
                    if (data) {
                        try {
                            const parsed = JSON.parse(data);
                            if (translate) {
                                translate(parsed).forEach(dispatch);
                            }
                            else {
                                dispatch(parsed.payload ?? parsed);
                            }
                        }
                        catch {
                        }
                    }
                    start = index + 2;
                    index = buffer.indexOf("\n\n", start);
                }
                buffer = buffer.slice(start);
            });
            res.on("end", () => scheduleRetry());
            res.on("error", (error) => {
                status(`stream error: ${error.message}`);
                scheduleRetry();
            });
        });
        request.on("error", (error) => {
            status(`error: ${error.message}`);
            scheduleRetry();
        });
    };
    connect();
    return shared;
}
function connectSse(base, onEvent, onStatus, sessionId) {
    const subscriber = { sessionId, onEvent, onStatus };
    let shared = sseConnections.get(base);
    if (!shared) {
        shared = openSharedSse(base);
        sseConnections.set(base, shared);
    }
    shared.subscribers.add(subscriber);
    if (shared.lastStatus) {
        onStatus(shared.lastStatus);
    }
    let released = false;
    return {
        close: () => {
            if (released) {
                return;
            }
            released = true;
            const conn = sseConnections.get(base);
            if (!conn) {
                return;
            }
            conn.subscribers.delete(subscriber);
            if (conn.subscribers.size === 0) {
                sseConnections.delete(base);
                conn.close();
            }
        }
    };
}
//# sourceMappingURL=net.js.map