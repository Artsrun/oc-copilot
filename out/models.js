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
exports.modelRefProblem = exports.modelLabel = exports.cachedModelInfo = void 0;
exports.parseVerboseModels = parseVerboseModels;
exports.parseProviders = parseProviders;
exports.parseModelList = parseModelList;
exports.configuredModels = configuredModels;
exports.getModelCatalog = getModelCatalog;
exports.catalogAge = catalogAge;
exports.setDefaultModel = setDefaultModel;
exports.pinLevel = pinLevel;
exports.resolveModelRef = resolveModelRef;
exports.modelResolver = modelResolver;
exports.writeModelPin = writeModelPin;
const vscode = __importStar(require("vscode"));
const core_1 = require("./core");
const followups_1 = require("./followups");
const proc_1 = require("./proc");
const context_1 = require("./context");
const net_1 = require("./net");
const env_1 = require("./env");
const MODEL_CACHE_KEY = "opencode.models.v2";
const MODEL_CACHE_KEY_V1 = "opencode.models.v1";
const readCache = () => core_1.extensionContext?.globalState?.get(MODEL_CACHE_KEY) ??
    core_1.extensionContext?.globalState?.get(MODEL_CACHE_KEY_V1);
const cachedModelInfo = () => readCache()?.info ?? {};
exports.cachedModelInfo = cachedModelInfo;
const modelLabel = (id, info = (0, exports.cachedModelInfo)()) => {
    const name = info[id]?.name;
    return name && name !== id && name !== id.split("/").slice(1).join("/") ? `${name} · \`${id}\`` : `\`${id}\``;
};
exports.modelLabel = modelLabel;
const ID_LINE = /^[\w.@-]+\/\S+$/;
function parseVerboseModels(raw) {
    const info = {};
    let id = "";
    let body = [];
    const flush = () => {
        if (!id) {
            return;
        }
        let m = {};
        try {
            m = body.length ? JSON.parse(body.join("\n")) : {};
        }
        catch {
        }
        const provider = typeof m.providerID === "string" && m.providerID ? m.providerID : id.split("/")[0];
        const limit = m.limit;
        info[id] = {
            id,
            name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : id,
            provider,
            providerName: provider,
            context: typeof limit?.context === "number" && limit.context > 0 ? limit.context : undefined
        };
    };
    for (const line of raw.split(/\r?\n/)) {
        if (ID_LINE.test(line)) {
            flush();
            id = line;
            body = [];
        }
        else if (id) {
            body.push(line);
        }
    }
    flush();
    return info;
}
function parseProviders(raw) {
    const info = {};
    const r = raw;
    const connected = Array.isArray(r?.connected) ? new Set(r.connected) : undefined;
    const list = Array.isArray(r?.providers)
        ? r.providers
        : Array.isArray(r?.all)
            ? r.all.filter((p) => !connected || connected.has(String(p?.id)))
            : [];
    for (const p of list) {
        const provider = typeof p?.id === "string" ? p.id : "";
        const models = p?.models && typeof p.models === "object" ? p.models : {};
        if (!provider) {
            continue;
        }
        const providerName = typeof p.name === "string" && p.name.trim() ? p.name.trim() : provider;
        for (const [key, m] of Object.entries(models)) {
            const id = `${provider}/${key}`;
            const limit = m?.limit;
            info[id] = {
                id,
                name: typeof m?.name === "string" && m.name.trim() ? m.name.trim() : id,
                provider,
                providerName,
                context: typeof limit?.context === "number" && limit.context > 0 ? limit.context : undefined
            };
        }
    }
    return info;
}
const PROVIDERS_TIMEOUT_MS = 3000;
async function catalogFromServer(cwd, base) {
    const settings = (0, core_1.config)();
    if (!base && settings.get("transport", "auto") === "cli") {
        return undefined;
    }
    const url = base ?? `http://${settings.get("serverHostname", "127.0.0.1")}:${settings.get("serverPort", 4096)}`;
    try {
        const info = parseProviders(await (0, net_1.httpGetJson)((0, net_1.withDirectory)(`${url}/config/providers`, cwd), PROVIDERS_TIMEOUT_MS));
        return Object.keys(info).length ? info : undefined;
    }
    catch {
        return undefined;
    }
}
function parseModelList(raw) {
    const seen = new Set();
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
        const value = line.trim().replace(/^[-*•]\s*/, "");
        if (!value || !/^[\w.@-]+\/\S+$/.test(value) || seen.has(value)) {
            continue;
        }
        seen.add(value);
        out.push(value);
    }
    return out;
}
function configuredModels() {
    const settings = (0, core_1.config)();
    return (0, context_1.uniqueModels)([settings.get("model", ""), ...(settings.get("fallbackModels", []) ?? [])], 16);
}
async function getModelCatalog(executable, cwd, opts = {}) {
    const ttlMs = Math.max(0, (0, core_1.config)().get("modelCatalogTtlMinutes", 360)) * 60 * 1000;
    const cached = readCache();
    const fresh = cached && ttlMs > 0 && Date.now() - cached.fetchedAt < ttlMs;
    if (fresh && !opts.force) {
        return { models: cached.models, info: cached.info ?? {}, source: "cached", fetchedAt: cached.fetchedAt };
    }
    try {
        let info = await catalogFromServer(cwd, opts.base);
        let models = info ? Object.keys(info) : [];
        if (!models.length) {
            const raw = await listModels(executable, cwd, true).catch(() => listModels(executable, cwd, false));
            models = parseModelList(raw);
            info = parseVerboseModels(raw);
        }
        if (models.length) {
            const snapshot = { models, info: info ?? {}, fetchedAt: Date.now() };
            await core_1.extensionContext?.globalState?.update(MODEL_CACHE_KEY, snapshot);
            core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] model catalog refreshed: ${models.length} models`);
            return { models, info: snapshot.info ?? {}, source: "live", fetchedAt: snapshot.fetchedAt };
        }
    }
    catch (error) {
        core_1.logChannel.appendLine(`[${(0, core_1.stamp)()}] model catalog fetch failed: ${error}`);
    }
    if (cached?.models.length) {
        return { models: cached.models, info: cached.info ?? {}, source: "stale", fetchedAt: cached.fetchedAt };
    }
    const configured = configuredModels();
    return configured.length
        ? { models: configured, info: {}, source: "configured" }
        : { models: [], info: {}, source: "empty" };
}
function catalogAge(catalog) {
    if (!catalog.fetchedAt) {
        return "";
    }
    const mins = Math.round((Date.now() - catalog.fetchedAt) / 60000);
    if (mins < 1) {
        return "just now";
    }
    return mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
}
const MODELS_TIMEOUT_MS = 15000;
function listModels(executable, cwd, verbose) {
    return new Promise((resolve, reject) => {
        const child = (0, proc_1.spawnOpenCode)(executable, verbose ? ["models", "--verbose"] : ["models"], cwd);
        child.stdin?.end();
        let output = "";
        let error = "";
        let settled = false;
        const done = (fn) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            fn();
        };
        const timer = setTimeout(() => {
            (0, proc_1.killTree)(child);
            done(() => output.trim()
                ? resolve(output)
                : reject(new Error(`opencode models timed out after ${MODELS_TIMEOUT_MS} ms.`)));
        }, MODELS_TIMEOUT_MS);
        timer.unref?.();
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (error += chunk));
        child.on("error", (err) => done(() => reject(err)));
        child.on("close", (code) => {
            done(() => {
                if (code !== 0) {
                    reject(new Error(error.trim() || `opencode models exited with code ${code}.`));
                    return;
                }
                resolve(output);
            });
        });
    });
}
async function setDefaultModel() {
    const folder = (0, core_1.resolveFolder)()?.folder;
    const settings = (0, core_1.config)();
    const executable = settings.get("executable", "opencode");
    const catalog = folder
        ? await getModelCatalog(executable, folder.uri.fsPath)
        : { models: configuredModels(), info: (0, exports.cachedModelInfo)(), source: "configured" };
    const current = settings.get("model", "").trim();
    const sourceNote = catalog.source === "live"
        ? "fetched now"
        : catalog.source === "cached"
            ? `cached ${catalogAge(catalog)}`
            : catalog.source === "stale"
                ? `${(0, followups_1.mark)("warn")} last known good, ${catalogAge(catalog)} — OpenCode is unreachable`
                : catalog.source === "configured"
                    ? (0, followups_1.mark)("warn") + " from your settings — could not reach OpenCode"
                    : "no models found";
    const set = folder ? (0, env_1.openCodeConfigModel)(folder.uri.fsPath) : undefined;
    const defaultNote = set ? `${catalog.info[set.model]?.name ?? set.model}, from ${set.from}` : "OpenCode picks";
    const models = current && !catalog.models.includes(current) ? [current, ...catalog.models] : catalog.models;
    const items = [
        {
            label: `$(clear-all) Use OpenCode default (${defaultNote})`,
            description: current ? "remove the pin — chat follows OpenCode" : "$(check) current — nothing pinned",
            action: "clear"
        },
        ...models.map((id) => {
            const info = catalog.info[id];
            const listed = catalog.models.includes(id);
            return {
                label: info?.name ?? id,
                description: [info?.name && info.name !== id ? id : "", id === current ? "$(check) pinned — chat only" : "", listed ? "" : "(not listed)"]
                    .filter(Boolean)
                    .join(" · "),
                detail: info ? [info.providerName, info.context ? `${Math.round(info.context / 1000)}k context` : ""].filter(Boolean).join(" · ") : undefined,
                modelId: id
            };
        }),
        { label: "$(refresh) Refresh model list", description: "bypass the cache", action: "refresh" }
    ];
    const choice = await vscode.window.showQuickPick(items, {
        placeHolder: `Default model for the OpenCode bridge — ${catalog.models.length} models, ${sourceNote}`,
        matchOnDescription: true,
        matchOnDetail: true
    });
    if (choice?.action === "refresh") {
        if (folder) {
            await getModelCatalog(executable, folder.uri.fsPath, { force: true });
        }
        await setDefaultModel();
        return;
    }
    if (!choice) {
        return;
    }
    const value = choice.action === "clear" ? "" : choice.modelId ?? "";
    void vscode.window.showInformationMessage(await writeModelPin(settings, value));
}
function pinLevel(settings = (0, core_1.config)()) {
    const where = settings.inspect?.("model");
    return where?.workspaceFolderValue
        ? "Workspace folder"
        : where?.workspaceValue
            ? "Workspace"
            : where?.globalValue
                ? "User"
                : undefined;
}
const nameWord = (name) => name.split(/[\s(,·]/)[0].toLowerCase();
function resolveModelRef(ref, catalog) {
    const want = ref.trim();
    if (catalog.models.includes(want)) {
        return { id: want };
    }
    const w = want.toLowerCase();
    const pick = (test) => catalog.models.filter(test);
    if (want.includes("/")) {
        const ci = pick((id) => id.toLowerCase() === w);
        if (ci.length === 1) {
            return { id: ci[0] };
        }
        const suffix = pick((id) => id.toLowerCase().endsWith(`/${w}`));
        return suffix.length === 1 ? { id: suffix[0] } : suffix.length > 1 ? { ambiguous: suffix } : { id: want, unlisted: true };
    }
    const tail = (id) => id.slice(id.indexOf("/") + 1).toLowerCase();
    const last = (id) => id.slice(id.lastIndexOf("/") + 1).toLowerCase();
    for (const found of [
        pick((id) => tail(id) === w || last(id) === w || nameWord(catalog.info[id]?.name ?? "") === w),
        w.length >= 3 ? pick((id) => last(id).startsWith(w) || nameWord(catalog.info[id]?.name ?? "").startsWith(w)) : []
    ]) {
        if (found.length === 1) {
            return { id: found[0] };
        }
        if (found.length > 1) {
            return { ambiguous: found };
        }
    }
    return { unknown: want };
}
const modelRefProblem = (ref, r) => "ambiguous" in r
    ? `\`${ref}\` matches ${r.ambiguous.map((id) => (0, exports.modelLabel)(id)).join(", ")}. Name one of them: a longer name, or the full id.`
    : "unknown" in r
        ? `\`${ref}\` is not in OpenCode's model list. \`/model\` shows the catalog; a full \`provider/model\` id is sent as typed.`
        : "";
exports.modelRefProblem = modelRefProblem;
function modelResolver(executable, cwd, race = (work) => work) {
    let fresh;
    return async (ref) => {
        const cached = readCache();
        const first = resolveModelRef(ref, { models: cached?.models ?? [], info: cached?.info ?? {} });
        if (!("unknown" in first)) {
            return first;
        }
        fresh ??= race(getModelCatalog(executable, cwd, { force: true }));
        const catalog = await fresh;
        return catalog ? resolveModelRef(ref, catalog) : first;
    };
}
async function writeModelPin(settings, value) {
    const where = settings.inspect?.("model");
    const levels = [
        [vscode.ConfigurationTarget.WorkspaceFolder, "Workspace folder", where?.workspaceFolderValue],
        [vscode.ConfigurationTarget.Workspace, "Workspace", where?.workspaceValue],
        [vscode.ConfigurationTarget.Global, "User", where?.globalValue]
    ];
    if (value) {
        const [target, name] = levels.find(([, , set]) => set !== undefined) ?? levels[2];
        await settings.update("model", value, target);
        return `Model pinned: ${value} (${name} settings).`;
    }
    const cleared = [];
    for (const [target, name, set] of levels) {
        if (set !== undefined) {
            await settings.update("model", undefined, target);
            cleared.push(name);
        }
    }
    return cleared.length
        ? `Model pin removed from ${cleared.join(" and ")} settings. OpenCode picks: a new session starts on its default, a running one keeps its model (/new to switch).`
        : "No model was pinned — OpenCode picks.";
}
//# sourceMappingURL=models.js.map