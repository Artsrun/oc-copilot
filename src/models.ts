import * as vscode from "vscode";
import { config, extensionContext, logChannel, own, resolveFolder, stamp } from "./core";
import { mark } from "./followups";
import { killTree, spawnOpenCode } from "./proc";
import { uniqueModels } from "./context";
import { httpGetJson, knownServerBase, withDirectory } from "./net";
import { openCodeConfigModel } from "./env";

// ---------------------------------------------------------------------------
// model catalog (tiered)
// ---------------------------------------------------------------------------
//
// `opencode models` spawns a process and can take seconds, so it must not be
// paid on every model picker and every turn that names a model. Tiers, in order:
//   1. live      — a running server's GET /config/providers, else `opencode models --verbose`
//   2. cached    — snapshot in globalState, fresh within the TTL
//   3. stale     — the same snapshot past its TTL, clearly labelled
//   4. configured— `model` + `fallbackModels` from settings
// There is deliberately no bundled catalog of model ids: OpenCode points at
// whatever gateway you configured, so shipping a guess (`openai/gpt-4o`…) would
// invent models that do not exist on a private gateway. Last-known-good plus
// your own settings is the honest floor.

// What OpenCode shows for a model: its `name` and its provider's display name.
// Only these are kept — the model JSON's `options` and `headers` may hold
// credentials, and none of that is stored or logged.
export interface ModelInfo {
    id: string;
    name: string;
    provider: string;
    providerName: string;
    context?: number;
    /** OpenCode's variant names (reasoning effort: `low`, `high`, `max`…).
     * Names only: a variant's body is provider options. Undefined: unknown. */
    variants?: string[];
}

interface ModelCatalog {
    models: string[];
    info?: Record<string, ModelInfo>;
    fetchedAt: number;
}

export type CatalogSource = "live" | "cached" | "stale" | "configured" | "empty";

export interface ResolvedCatalog {
    models: string[];
    info: Record<string, ModelInfo>;
    source: CatalogSource;
    fetchedAt?: number;
}

// v2 carries names; v1 (ids only) is read until the first refresh writes v2.
const MODEL_CACHE_KEY = "opencode.models.v2";
const MODEL_CACHE_KEY_V1 = "opencode.models.v1";

const readCache = (): ModelCatalog | undefined =>
    extensionContext?.globalState?.get<ModelCatalog>(MODEL_CACHE_KEY) ??
    extensionContext?.globalState?.get<ModelCatalog>(MODEL_CACHE_KEY_V1);

/** Names from the last catalog, without fetching anything (for /model). */
export const cachedModelInfo = (): Record<string, ModelInfo> => readCache()?.info ?? {};

/** `Tundra (Model-1, …) · \`acme-gateway/Tundra\`` when the name is known and says more. */
export const modelLabel = (id: string, info: Record<string, ModelInfo> = cachedModelInfo()): string => {
    const name = own(info, id)?.name;
    return name && name !== id && name !== id.split("/").slice(1).join("/") ? `${name} · \`${id}\`` : `\`${id}\``;
};

const ID_LINE = /^[\w.@-]+\/\S+$/;

// A model's `variants` is `{ name: providerOptions }` (provider.ts, 1.18.34);
// a `disabled: true` entry is dropped there too. Not an object: unknown.
const variantNames = (raw: unknown): string[] | undefined =>
    raw && typeof raw === "object" && !Array.isArray(raw)
        ? Object.entries(raw as Record<string, unknown>)
            .filter(([, v]) => !(v && typeof v === "object" && (v as { disabled?: unknown }).disabled === true))
            .map(([k]) => k)
        : undefined;

// Lowest to highest, as providers name them (ProviderTransform.variants).
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const effortRank = (name: string): number => {
    const i = EFFORT_ORDER.indexOf(name.toLowerCase());
    return i < 0 ? EFFORT_ORDER.length : i;
};

export type EffortChoice = { variant?: string; problem?: string };

/**
 * The variant to send for `requested` on `model`. OpenCode looks the name up in
 * the model's variants and silently ignores a miss (session/llm/request.ts), so
 * a level the catalog knows is missing is caught here: `strict` (an inline
 * `effort:`) refuses the turn, a setting is dropped with a note. A model the
 * catalog does not describe gets the name as asked. claim:effort
 */
export function effortFor(
    model: string | undefined,
    requested: string | undefined,
    strict: boolean,
    info: Record<string, ModelInfo> = cachedModelInfo()
): EffortChoice {
    const want = (requested ?? "").trim();
    if (!want) {
        return {};
    }
    const levels = model ? own(info, model)?.variants : undefined;
    if (!levels) {
        return { variant: want };
    }
    const hit = levels.find((l) => l.toLowerCase() === want.toLowerCase());
    if (hit) {
        return { variant: hit };
    }
    const list = levels.length ? `Its levels: ${sortEfforts(levels).map((l) => `\`${l}\``).join(", ")}.` : "It has no effort levels.";
    return {
        problem: strict
            ? `\`effort:${want}\` is not a level of \`${model}\`. ${list}`
            : `\`effort: ${want}\` is not a level of \`${model}\`, so it ran at its default. ${list}`
    };
}

/** `context 42k of 200k (21%)` after the last turn; the window only when the catalog knows it. */
export function contextNote(tokens: number | undefined, model: string | undefined, info: Record<string, ModelInfo> = cachedModelInfo()): string {
    if (!tokens) {
        return "";
    }
    const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
    const limit = model ? own(info, model)?.context : undefined;
    return limit ? `context ${k(tokens)} of ${k(limit)} (${Math.round((tokens / limit) * 100)}%)` : `context ${k(tokens)}`;
}

export const sortEfforts = (levels: readonly string[]): string[] => [...levels].sort((a, b) => effortRank(a) - effortRank(b));

/** The next level above `current` that `model` offers (or its highest, from the
 * default); undefined when the catalog does not describe it or it is at the top. */
export function higherEffort(model: string | undefined, current: string | undefined, info: Record<string, ModelInfo> = cachedModelInfo()): string | undefined {
    const levels = model ? sortEfforts(own(info, model)?.variants ?? []) : [];
    if (!levels.length) {
        return undefined;
    }
    if (!current) {
        return levels.find((l) => l.toLowerCase() === "high") ?? levels[levels.length - 1];
    }
    const rank = effortRank(current);
    return levels.find((l) => effortRank(l) > rank && EFFORT_ORDER.includes(l.toLowerCase()));
}

/**
 * `opencode models --verbose`: each `provider/model` line is followed by that
 * model's JSON (cli/cmd/models.ts). Only name, provider and context are kept.
 */
export function parseVerboseModels(raw: string): Record<string, ModelInfo> {
    const info: Record<string, ModelInfo> = {};
    let id = "";
    let body: string[] = [];
    const flush = (): void => {
        if (!id) {
            return;
        }
        let m: Record<string, unknown> = {};
        try {
            m = body.length ? (JSON.parse(body.join("\n")) as Record<string, unknown>) : {};
        } catch {
            // id only
        }
        const provider = typeof m.providerID === "string" && m.providerID ? m.providerID : id.split("/")[0];
        const limit = m.limit as { context?: unknown } | undefined;
        info[id] = {
            id,
            name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : id,
            provider,
            providerName: provider,
            context: typeof limit?.context === "number" && limit.context > 0 ? limit.context : undefined,
            variants: variantNames(m.variants)
        };
    };
    for (const line of raw.split(/\r?\n/)) {
        if (ID_LINE.test(line)) {
            flush();
            id = line;
            body = [];
        } else if (id) {
            body.push(line);
        }
    }
    flush();
    return info;
}

/** `GET /config/providers`: the providers OpenCode can use, each with its models. */
export function parseProviders(raw: unknown): Record<string, ModelInfo> {
    const info: Record<string, ModelInfo> = {};
    const r = raw as { providers?: unknown; all?: unknown; connected?: unknown } | undefined;
    const connected = Array.isArray(r?.connected) ? new Set(r.connected as string[]) : undefined;
    const list = Array.isArray(r?.providers)
        ? r.providers
        : Array.isArray(r?.all)
            ? (r.all as Array<{ id?: string }>).filter((p) => !connected || connected.has(String(p?.id)))
            : [];
    for (const p of list as Array<Record<string, unknown>>) {
        const provider = typeof p?.id === "string" ? p.id : "";
        const models = p?.models && typeof p.models === "object" ? (p.models as Record<string, Record<string, unknown>>) : {};
        if (!provider) {
            continue;
        }
        const providerName = typeof p.name === "string" && p.name.trim() ? p.name.trim() : provider;
        for (const [key, m] of Object.entries(models)) {
            const id = `${provider}/${key}`;
            const limit = m?.limit as { context?: unknown } | undefined;
            info[id] = {
                id,
                name: typeof m?.name === "string" && m.name.trim() ? m.name.trim() : id,
                provider,
                providerName,
                context: typeof limit?.context === "number" && limit.context > 0 ? limit.context : undefined,
                variants: variantNames(m?.variants)
            };
        }
    }
    return info;
}

const PROVIDERS_TIMEOUT_MS = 3000;

// Only when turns may run on a server (transport server/auto) and one already
// answers: a picker never starts one, and a CLI-only user's port may belong to
// something else.
async function catalogFromServer(cwd: string, base?: string): Promise<Record<string, ModelInfo> | undefined> {
    const settings = config();
    if (!base && settings.get<string>("transport", "auto") === "cli") {
        return undefined;
    }
    const url = base ?? knownServerBase();
    if (!url) {
        return undefined;
    }
    try {
        const info = parseProviders(await httpGetJson<unknown>(withDirectory(`${url}/config/providers`, cwd), PROVIDERS_TIMEOUT_MS));
        return Object.keys(info).length ? info : undefined;
    } catch {
        return undefined;
    }
}

export function parseModelList(raw: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
        // Ignore banners and headings; a model id always has a provider prefix.
        const value = line.trim().replace(/^[-*•]\s*/, "");
        if (!value || !/^[\w.@-]+\/\S+$/.test(value) || seen.has(value)) {
            continue;
        }
        seen.add(value);
        out.push(value);
    }
    return out;
}

export function configuredModels(): string[] {
    const settings = config();
    return uniqueModels(
        [settings.get<string>("model", ""), ...(settings.get<string[]>("fallbackModels", []) ?? [])],
        16
    );
}

export async function getModelCatalog(
    executable: string,
    cwd: string,
    opts: { force?: boolean; base?: string } = {}
): Promise<ResolvedCatalog> {
    const ttlMs =
        Math.max(0, config().get<number>("modelCatalogTtlMinutes", 360)) * 60 * 1000;
    const cached = readCache();
    const fresh = cached && ttlMs > 0 && Date.now() - cached.fetchedAt < ttlMs;

    if (fresh && !opts.force) {
        return { models: cached.models, info: cached.info ?? {}, source: "cached", fetchedAt: cached.fetchedAt };
    }
    try {
        // A running server answers with provider names; the CLI
        // with model names (`--verbose`), or ids only on a CLI without the flag.
        let info = await catalogFromServer(cwd, opts.base);
        let models = info ? Object.keys(info) : [];
        if (!models.length) {
            const raw = await listModels(executable, cwd, true).catch(() => listModels(executable, cwd, false));
            models = parseModelList(raw);
            info = parseVerboseModels(raw);
        }
        if (models.length) {
            const snapshot: ModelCatalog = { models, info: info ?? {}, fetchedAt: Date.now() };
            await extensionContext?.globalState?.update(MODEL_CACHE_KEY, snapshot);
            logChannel.appendLine(`[${stamp()}] model catalog refreshed: ${models.length} models`);
            return { models, info: snapshot.info ?? {}, source: "live", fetchedAt: snapshot.fetchedAt };
        }
    } catch (error) {
        logChannel.appendLine(`[${stamp()}] model catalog fetch failed: ${error}`);
    }
    if (cached?.models.length) {
        return { models: cached.models, info: cached.info ?? {}, source: "stale", fetchedAt: cached.fetchedAt };
    }
    const configured = configuredModels();
    return configured.length
        ? { models: configured, info: {}, source: "configured" }
        : { models: [], info: {}, source: "empty" };
}

export function catalogAge(catalog: ResolvedCatalog): string {
    if (!catalog.fetchedAt) {
        return "";
    }
    const mins = Math.round((Date.now() - catalog.fetchedAt) / 60000);
    if (mins < 1) {
        return "just now";
    }
    return mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
}

// Bounded like every other spawn in the bridge. `opencode models` reaches a
// gateway, and a hung request would hang whatever awaits the catalog: /ping,
// Diagnose, the model picker, the composer and a turn resolving `model:`.
const MODELS_TIMEOUT_MS = 15000;

function listModels(executable: string, cwd: string, verbose: boolean): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawnOpenCode(executable, verbose ? ["models", "--verbose"] : ["models"], cwd);
        child.stdin?.end();
        let output = "";
        let error = "";
        let settled = false;
        const done = (fn: () => void): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            fn();
        };
        const timer = setTimeout(() => {
            killTree(child);
            done(() =>
                // Partial output is still a usable catalog; nothing at all is an
                // error, and getModelCatalog falls back to the cached tier.
                output.trim()
                    ? resolve(output)
                    : reject(new Error(`opencode models timed out after ${MODELS_TIMEOUT_MS} ms.`))
            );
        }, MODELS_TIMEOUT_MS);
        timer.unref?.();
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => (output += chunk));
        child.stderr.on("data", (chunk: string) => (error += chunk));
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

export async function setDefaultModel(): Promise<void> {
    const folder = resolveFolder()?.folder;
    const settings = config();
    const executable = settings.get<string>("executable", "opencode");

    const catalog: ResolvedCatalog = folder
        ? await getModelCatalog(executable, folder.uri.fsPath)
        : { models: configuredModels(), info: cachedModelInfo(), source: "configured" };
    const current = settings.get<string>("model", "").trim();
    const sourceNote =
        catalog.source === "live"
            ? "fetched now"
            : catalog.source === "cached"
                ? `cached ${catalogAge(catalog)}`
                : catalog.source === "stale"
                    ? `${mark("warn")} last known good, ${catalogAge(catalog)} — OpenCode is unreachable`
                    : catalog.source === "configured"
                        ? mark("warn") + " from your settings — could not reach OpenCode"
                        : "no models found";

    // Say what "OpenCode default" means here; show names, not ids.
    const set = folder ? openCodeConfigModel(folder.uri.fsPath) : undefined;
    const defaultNote = set ? `${own(catalog.info, set.model)?.name ?? set.model}, from ${set.from}` : "OpenCode picks";
    type ModelItem = vscode.QuickPickItem & { modelId?: string; action?: "clear" | "refresh" };
    const models = current && !catalog.models.includes(current) ? [current, ...catalog.models] : catalog.models;
    const items: ModelItem[] = [
        {
            label: `$(clear-all) Use OpenCode default (${defaultNote})`,
            description: current ? "remove the pin — chat follows OpenCode" : "$(check) current — nothing pinned",
            action: "clear"
        },
        ...models.map((id): ModelItem => {
            const info = own(catalog.info, id);
            const listed = catalog.models.includes(id);
            return {
                label: `$(chip) ${info?.name ?? id}`,
                description: [info?.name && info.name !== id ? id : "", id === current ? "$(check) pinned — chat only" : "", listed ? "" : "(not listed)"]
                    .filter(Boolean)
                    .join(" · "),
                detail: info
                    ? [info.providerName, info.context ? `${Math.round(info.context / 1000)}k context` : "", info.variants?.length ? `effort ${sortEfforts(info.variants).join("/")}` : ""]
                        .filter(Boolean)
                        .join(" · ")
                    : undefined,
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

/** Where the pin lives: "Workspace folder", "Workspace", "User", or undefined. */
export function pinLevel(settings: vscode.WorkspaceConfiguration = config()): string | undefined {
    const where = settings.inspect?.<string>("model");
    return where?.workspaceFolderValue
        ? "Workspace folder"
        : where?.workspaceValue
            ? "Workspace"
            : where?.globalValue
                ? "User"
                : undefined;
}

// ---------------------------------------------------------------------------
// claim:model-names — `m:tundra` means the one catalog model whose id tail
// or first name word is `tundra`, case-insensitive — never a guess: two matches
// are refused with both named. A full `provider/model` passes through as typed
// (OpenCode reports a wrong one itself).
export type ModelRef = { id: string; unlisted?: boolean } | { ambiguous: string[] } | { unknown: string };

const nameWord = (name: string): string => name.split(/[\s(,·]/)[0].toLowerCase();

export function resolveModelRef(ref: string, catalog: { models: readonly string[]; info: Record<string, ModelInfo> }): ModelRef {
    const want = ref.trim();
    if (catalog.models.includes(want)) {
        return { id: want };
    }
    const w = want.toLowerCase();
    const pick = (test: (id: string) => boolean): string[] => catalog.models.filter(test);
    // A model id may itself hold slashes: the gateway lists
    // `acme-gateway/openrouter/moonshotai/kimi-k3` (opencode models
    // --verbose, 2026-09-29), whose own `id` is `openrouter/moonshotai/kimi-k3`.
    // So a ref with a slash may be a SUFFIX of a listed id, and a short name is
    // matched against the last segment as well as everything after the provider.
    if (want.includes("/")) {
        const ci = pick((id) => id.toLowerCase() === w);
        if (ci.length === 1) {
            return { id: ci[0] };
        }
        const suffix = pick((id) => id.toLowerCase().endsWith(`/${w}`));
        return suffix.length === 1 ? { id: suffix[0] } : suffix.length > 1 ? { ambiguous: suffix } : { id: want, unlisted: true };
    }
    const tail = (id: string): string => id.slice(id.indexOf("/") + 1).toLowerCase();
    const last = (id: string): string => id.slice(id.lastIndexOf("/") + 1).toLowerCase();
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

/** Why a model reference cannot run — shown instead of a guess. */
export const modelRefProblem = (ref: string, r: ModelRef): string =>
    "ambiguous" in r
        ? `\`${ref}\` matches ${r.ambiguous.map((id) => modelLabel(id)).join(", ")}. Name one of them: a longer name, or the full id.`
        : "unknown" in r
            ? `\`${ref}\` is not in OpenCode's model list. \`/model\` shows the catalog; a full \`provider/model\` id is sent as typed.`
            : "";

/**
 * Resolve against the cached catalog. An unknown short name refetches it —
 * once per resolver (one turn), whatever the number of lanes, and raced
 * against Stop by `race`.
 */
export function modelResolver(
    executable: string,
    cwd: string,
    race: (work: Promise<ResolvedCatalog>) => Promise<ResolvedCatalog | undefined> = (work) => work
): (ref: string) => Promise<ModelRef> {
    let fresh: Promise<ResolvedCatalog | undefined> | undefined;
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

// The pin is written where it already lives, else in User settings (never a
// new .vscode/settings.json — Rule 5); clearing removes it everywhere.
export async function writeModelPin(settings: vscode.WorkspaceConfiguration, value: string): Promise<string> {
    const where = settings.inspect?.<string>("model");
    const levels: Array<[vscode.ConfigurationTarget, string, unknown]> = [
        [vscode.ConfigurationTarget.WorkspaceFolder, "Workspace folder", where?.workspaceFolderValue],
        [vscode.ConfigurationTarget.Workspace, "Workspace", where?.workspaceValue],
        [vscode.ConfigurationTarget.Global, "User", where?.globalValue]
    ];
    if (value) {
        const [target, name] = levels.find(([, , set]) => set !== undefined) ?? levels[2];
        await settings.update("model", value, target);
        return `Model pinned: ${value} (${name} settings).`;
    }
    const cleared: string[] = [];
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