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
exports.TESTED_OPENCODE = void 0;
exports.withDirectory = withDirectory;
exports.httpRequestJson = httpRequestJson;
exports.httpGetJson = httpGetJson;
exports.httpPostJson = httpPostJson;
exports.setStartupDeadline = setStartupDeadline;
exports.versionNotice = versionNotice;
exports.knownServerBase = knownServerBase;
exports.stopServer = stopServer;
exports.ensureServer = ensureServer;
exports.warmServer = warmServer;
exports.lastServeLine = lastServeLine;
exports.sessionIdFromEvent = sessionIdFromEvent;
exports.connectSse = connectSse;
const http = __importStar(require("node:http"));
const net = __importStar(require("node:net"));
const core_1 = require("./core");
const proc_1 = require("./proc");
function withDirectory(url, cwd) {
    if (!cwd) {
        return url;
    }
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}directory=${encodeURIComponent(cwd)}`;
}
function httpRequestJson(method, url, body, timeoutMs, token) {
    return new Promise((resolve, reject) => {
        const data = body !== undefined ? Buffer.from(JSON.stringify(body), "utf8") : undefined;
        const headers = data ? { "content-type": "application/json", "content-length": data.length } : {};
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
function httpGetJson(url, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, (res) => {
            let data = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (data += chunk));
            res.on("error", reject);
            res.on("end", () => {
                try {
                    resolve(JSON.parse(data));
                }
                catch (error) {
                    reject(error);
                }
            });
        });
        request.setTimeout(timeoutMs, () => {
            request.destroy(new Error(`GET ${url} timed out after ${timeoutMs} ms`));
        });
        request.on("error", reject);
    });
}
function httpPostJson(url, body, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(body ?? {}), "utf8");
        const request = http.request(url, {
            method: "POST",
            headers: { "content-type": "application/json", "content-length": data.length }
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
exports.TESTED_OPENCODE = { min: "1.18.27", max: "1.18.34" };
const serverVersions = new Map();
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
    const lo = semver(exports.TESTED_OPENCODE.min);
    const hi = semver(exports.TESTED_OPENCODE.max);
    if (!below(v, lo) && !below(hi, v)) {
        return undefined;
    }
    versionsNoted.add(version);
    core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] OpenCode ${version} on ${base} is outside the tested ${exports.TESTED_OPENCODE.min}–${exports.TESTED_OPENCODE.max}`);
    return `OpenCode ${version} is outside the versions this bridge was tested with (${exports.TESTED_OPENCODE.min}–${exports.TESTED_OPENCODE.max}). It runs; if something misbehaves, the debug log and REFS.md name what each version was measured on.`;
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
function stopServer() {
    if (serveProcess && serveProcess.exitCode === null) {
        (0, proc_1.killTree)(serveProcess);
    }
    serveProcess = undefined;
    managedPort = undefined;
    fallbackPort = undefined;
    servePort = undefined;
}
async function ensureServer(cwd, onSlowStart) {
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
        catch {
            return { healthy: false };
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
        const serveCwd = cwd ?? (0, core_1.resolveFolder)()?.folder.uri.fsPath;
        serveSpawnError = undefined;
        serveTail = "";
        servePort = port;
        serveProcess = (0, proc_1.spawnOpenCode)(executable, ["serve", "--port", String(port), "--hostname", host], serveCwd);
        serveProcess.stdout?.setEncoding("utf8");
        serveProcess.stderr?.setEncoding("utf8");
        const keep = (d) => {
            core_1.logChannel.appendLine(`[serve] ${d.trim()}`);
            serveTail = (serveTail + d).slice(-600);
        };
        serveProcess.stdout?.on("data", keep);
        serveProcess.stderr?.on("data", keep);
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
    const exited = () => {
        if (!serveProcess || serveProcess.exitCode === null) {
            return undefined;
        }
        if (serveSpawnError) {
            return new Error(`OpenCode server could not be started: ${serveSpawnError}`);
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
        if (await healthy(POLL_HEALTH_MS)) {
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] serve on ${base} answered after ${((Date.now() - waitStarted) / 1000).toFixed(1)}s`);
            return base;
        }
        if (!told && onSlowStart && Date.now() - waitStarted >= SLOW_START_MS) {
            told = true;
            try {
                onSlowStart("Starting the OpenCode server — a first start loads its config, plugins and MCP servers…");
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
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] server unavailable, dev runs cold: ${error}`);
        return undefined;
    }
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
        request = http.get(`${base}/global/event`, (res) => {
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
                            dispatch(parsed.payload ?? parsed);
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