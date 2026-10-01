// /flow (claim:flow): what one chat turn did — folder, session, agent, transport,
// model, each tool step, handoffs, the end — as a mermaid flowchart. Chat draws
// a ```mermaid block with the built-in mermaid renderer (chatMarkdownContentPart
// → hasCodeBlockRenderer("mermaid"), microsoft/vscode main@4b24360); elsewhere
// it stays copyable text. Leaf module: no vscode, no local imports.

export type FlowKind = "info" | "step" | "handoff" | "end";
export type FlowStatus = "ok" | "warn" | "fail";

export interface FlowNode {
    kind: FlowKind;
    /** Consecutive nodes with the same key merge: `read ×7: a.ts, b.ts…`. */
    key: string;
    parts: string[];
    count: number;
    status?: FlowStatus;
}

export interface FlowTrace {
    id: string;
    title: string;
    nodes: FlowNode[];
    lanes: { title: string; nodes: FlowNode[] }[];
    end?: FlowNode;
    chips?: string[];
}

export const MAX_NODES = 60;
const LABEL_MAX = 60;
const STORE_CAP = 20;

let seq = 0;
export const newTrace = (): FlowTrace => ({
    id: `f${Date.now().toString(36)}${(seq++).toString(36)}`,
    title: "",
    nodes: [],
    lanes: []
});

const worse = (a?: FlowStatus, b?: FlowStatus): FlowStatus | undefined =>
    a === "fail" || b === "fail" ? "fail" : a === "warn" || b === "warn" ? "warn" : a ?? b;

/** Append to `nodes`, merging into the last node when kind and key repeat. */
export function flowAdd(nodes: FlowNode[], kind: FlowKind, key: string, part = "", status?: FlowStatus): void {
    const last = nodes[nodes.length - 1];
    if (last && last.kind === kind && last.key === key) {
        last.count += 1;
        last.status = worse(last.status, status);
        if (part && !last.parts.includes(part)) {
            last.parts.push(part);
        }
        return;
    }
    nodes.push({ kind, key, parts: part ? [part] : [], count: 1, status });
}

const oneLine = (s: string, max: number): string => {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * Mermaid-safe: `"` `#` `%` `&` `` ` `` `<` `>` become entity codes; one line,
 * bounded, never empty. Measured in mermaid 11 (Chromium, REFS "/flow"): a
 * `%%{…}%%` directive is honoured even inside a quoted label, and `[""]` does
 * not parse.
 */
export const flowLabel = (s: string, max = LABEL_MAX): string =>
    (oneLine(s, max) || "·").replace(/[#"%&`<>]/g, (c) => `#${c.charCodeAt(0)};`);

export const nodeText = (n: FlowNode): string =>
    (n.count > 1 ? `${n.key} ×${n.count}` : n.key) + (n.parts.length ? `: ${n.parts.join(", ")}` : "");

const fit = (nodes: FlowNode[], budget: number): FlowNode[] =>
    nodes.length <= budget
        ? nodes
        : [
            ...nodes.slice(0, budget - 2),
            { kind: "info", key: `… ${nodes.length - budget + 1} more`, parts: [], count: 1 },
            nodes[nodes.length - 1]
        ];

const SHAPE: Record<FlowKind, [string, string]> = {
    info: ["[\"", "\"]"],
    step: ["(\"", "\")"],
    handoff: ["{{\"", "\"}}"],
    end: ["([\"", "\"])"]
};

export function toMermaid(trace: FlowTrace, max = MAX_NODES): string {
    const out = ["flowchart TD", "    classDef warn stroke:#cca700,stroke-width:2px", "    classDef fail stroke:#f14c4c,stroke-width:2px"];
    let n = 0;
    const node = (x: FlowNode): string => {
        const id = `n${n++}`;
        const [open, close] = SHAPE[x.kind];
        out.push(`    ${id}${open}${flowLabel(nodeText(x))}${close}${x.status && x.status !== "ok" ? `:::${x.status}` : ""}`);
        return id;
    };
    const chain = (nodes: FlowNode[], from?: string): string | undefined => {
        let prev = from;
        for (const x of nodes) {
            const id = node(x);
            if (prev) {
                out.push(`    ${prev} --> ${id}`);
            }
            prev = id;
        }
        return prev;
    };
    const head: FlowNode = { kind: "info", key: trace.title || "turn", parts: [], count: 1 };
    const lanes = trace.lanes.length;
    // Lanes share what the main path leaves; at least 3 nodes each.
    const mainBudget = lanes ? Math.min(20, max - 3 * lanes) : max - 2;
    const laneBudget = lanes ? Math.max(3, Math.floor((max - 2 - Math.min(trace.nodes.length, mainBudget)) / lanes)) : 0;
    const last = chain([head, ...fit(trace.nodes, Math.max(3, mainBudget))]);
    const ends: (string | undefined)[] = [];
    trace.lanes.forEach((lane, i) => {
        out.push(`    subgraph L${i}["${flowLabel(`${i + 1}. ${lane.title}`)}"]`);
        const first = n;
        const tail = chain(fit(lane.nodes, laneBudget));
        out.push("    end");
        if (last && tail) {
            out.push(`    ${last} --> n${first}`);
        }
        ends.push(tail ?? last);
    });
    if (trace.end) {
        const id = node(trace.end);
        for (const from of lanes ? ends : [last]) {
            if (from) {
                out.push(`    ${from} --> ${id}`);
            }
        }
        if (trace.chips?.length) {
            out.push(`    ${id} -.-> ${node({ kind: "info", key: "chips", parts: trace.chips, count: 1 })}`);
        }
    }
    return out.join("\n");
}

/** One line for readers without the diagram: `site → new session → plan → 11 steps → done 4.1s`. */
export function flowSummary(trace: FlowTrace): string {
    const parts: string[] = [];
    let steps = 0;
    const flush = (): void => {
        if (steps) {
            parts.push(`${steps} step${steps === 1 ? "" : "s"}`);
            steps = 0;
        }
    };
    for (const x of trace.nodes) {
        if (x.kind === "step") {
            steps += x.count;
            continue;
        }
        flush();
        parts.push(nodeText(x));
    }
    flush();
    if (trace.lanes.length) {
        parts.push(`${trace.lanes.length} lanes`);
    }
    if (trace.end) {
        parts.push(nodeText(trace.end));
    }
    if (trace.chips?.length) {
        parts.push(`chips: ${trace.chips.join(", ")}`);
    }
    return parts.map((p) => oneLine(p, LABEL_MAX)).join(" → ");
}

// The last STORE_CAP traced turns of this window, in memory only: a turn's
// metadata carries its trace id, and /flow finds this chat's ids in history.
const store = new Map<string, FlowTrace>();

export function rememberFlow(trace: FlowTrace): void {
    store.delete(trace.id);
    store.set(trace.id, trace);
    while (store.size > STORE_CAP) {
        store.delete(store.keys().next().value as string);
    }
}

export const flowById = (id: string): FlowTrace | undefined => store.get(id);

/** Follow-up chips are chosen after the turn returns; recorded once. */
export function noteFlowChips(id: unknown, labels: readonly string[]): void {
    const trace = typeof id === "string" ? store.get(id) : undefined;
    if (trace && !trace.chips) {
        trace.chips = [...labels];
    }
}
