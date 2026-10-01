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
exports.withDirectory = withDirectory;
exports.httpRequestJson = httpRequestJson;
exports.httpGetJson = httpGetJson;
exports.httpPostJson = httpPostJson;
exports.stopServer = stopServer;
exports.ensureServer = ensureServer;
exports.sessionIdFromEvent = sessionIdFromEvent;
exports.connectSse = connectSse;
const http = __importStar(require("node:http"));
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
function stopServer() {
    if (serveProcess && serveProcess.exitCode === null) {
        (0, proc_1.killTree)(serveProcess);
    }
    serveProcess = undefined;
}
async function ensureServer(cwd) {
    const settings = (0, core_1.config)();
    const executable = settings.get("executable", "opencode");
    const host = settings.get("serverHostname", "127.0.0.1");
    const port = settings.get("serverPort", 4096);
    const base = `http://${host}:${port}`;
    const healthy = async () => {
        try {
            const health = await httpGetJson(`${base}/global/health`);
            return health.healthy === true;
        }
        catch {
            return false;
        }
    };
    if (await healthy()) {
        serveSpawnError = undefined;
        const startedHere = Boolean(serveProcess && serveProcess.exitCode === null);
        if (!startedHere && !adoptedServers.has(base)) {
            adoptedServers.add(base);
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] adopted an OpenCode server already listening on ${base}. ` +
                `Requests are scoped to ${cwd ?? "this workspace"} via ?directory=.`);
        }
        return base;
    }
    if (!serveProcess || serveProcess.exitCode !== null) {
        const serveCwd = cwd ?? (0, core_1.resolveFolder)()?.folder.uri.fsPath;
        serveSpawnError = undefined;
        serveProcess = (0, proc_1.spawnOpenCode)(executable, ["serve", "--port", String(port), "--hostname", host], serveCwd);
        serveProcess.stdout?.setEncoding("utf8");
        serveProcess.stderr?.setEncoding("utf8");
        serveProcess.stdout?.on("data", (d) => core_1.logChannel.appendLine(`[serve] ${d.trim()}`));
        serveProcess.stderr?.on("data", (d) => core_1.logChannel.appendLine(`[serve] ${d.trim()}`));
        serveProcess.on("error", (error) => {
            serveSpawnError = error.message;
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] serve failed to start: ${error.message}`);
        });
        serveProcess.on("close", (code) => core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] serve exited (${code})`));
    }
    const pollMs = Math.max(50, settings.get("serverStartupPollMs", 350));
    let waitMs = 50;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        await (0, core_1.delay)(waitMs);
        waitMs = Math.min(pollMs, waitMs * 2);
        if (serveProcess && serveProcess.exitCode !== null) {
            throw new Error(serveSpawnError
                ? `OpenCode server could not be started: ${serveSpawnError}`
                : `OpenCode server process exited (code ${serveProcess.exitCode}).`);
        }
        if (await healthy()) {
            return base;
        }
    }
    throw new Error(`OpenCode server did not become healthy on ${base}.`);
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