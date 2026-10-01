"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.flowById = exports.nodeText = exports.flowLabel = exports.newTrace = exports.MAX_NODES = void 0;
exports.flowAdd = flowAdd;
exports.toMermaid = toMermaid;
exports.flowSummary = flowSummary;
exports.rememberFlow = rememberFlow;
exports.noteFlowChips = noteFlowChips;
exports.MAX_NODES = 60;
const LABEL_MAX = 60;
const STORE_CAP = 20;
let seq = 0;
const newTrace = () => ({
    id: `f${Date.now().toString(36)}${(seq++).toString(36)}`,
    title: "",
    nodes: [],
    lanes: []
});
exports.newTrace = newTrace;
const worse = (a, b) => a === "fail" || b === "fail" ? "fail" : a === "warn" || b === "warn" ? "warn" : a ?? b;
function flowAdd(nodes, kind, key, part = "", status) {
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
const oneLine = (s, max) => {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const flowLabel = (s, max = LABEL_MAX) => (oneLine(s, max) || "·").replace(/[#"%&`<>]/g, (c) => `#${c.charCodeAt(0)};`);
exports.flowLabel = flowLabel;
const nodeText = (n) => (n.count > 1 ? `${n.key} ×${n.count}` : n.key) + (n.parts.length ? `: ${n.parts.join(", ")}` : "");
exports.nodeText = nodeText;
const fit = (nodes, budget) => nodes.length <= budget
    ? nodes
    : [
        ...nodes.slice(0, budget - 2),
        { kind: "info", key: `… ${nodes.length - budget + 1} more`, parts: [], count: 1 },
        nodes[nodes.length - 1]
    ];
const SHAPE = {
    info: ["[\"", "\"]"],
    step: ["(\"", "\")"],
    handoff: ["{{\"", "\"}}"],
    end: ["([\"", "\"])"]
};
function toMermaid(trace, max = exports.MAX_NODES) {
    const out = ["flowchart TD", "    classDef warn stroke:#cca700,stroke-width:2px", "    classDef fail stroke:#f14c4c,stroke-width:2px"];
    let n = 0;
    const node = (x) => {
        const id = `n${n++}`;
        const [open, close] = SHAPE[x.kind];
        out.push(`    ${id}${open}${(0, exports.flowLabel)((0, exports.nodeText)(x))}${close}${x.status && x.status !== "ok" ? `:::${x.status}` : ""}`);
        return id;
    };
    const chain = (nodes, from) => {
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
    const head = { kind: "info", key: trace.title || "turn", parts: [], count: 1 };
    const lanes = trace.lanes.length;
    const mainBudget = lanes ? Math.min(20, max - 3 * lanes) : max - 2;
    const laneBudget = lanes ? Math.max(3, Math.floor((max - 2 - Math.min(trace.nodes.length, mainBudget)) / lanes)) : 0;
    const last = chain([head, ...fit(trace.nodes, Math.max(3, mainBudget))]);
    const ends = [];
    trace.lanes.forEach((lane, i) => {
        out.push(`    subgraph L${i}["${(0, exports.flowLabel)(`${i + 1}. ${lane.title}`)}"]`);
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
function flowSummary(trace) {
    const parts = [];
    let steps = 0;
    const flush = () => {
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
        parts.push((0, exports.nodeText)(x));
    }
    flush();
    if (trace.lanes.length) {
        parts.push(`${trace.lanes.length} lanes`);
    }
    if (trace.end) {
        parts.push((0, exports.nodeText)(trace.end));
    }
    if (trace.chips?.length) {
        parts.push(`chips: ${trace.chips.join(", ")}`);
    }
    return parts.map((p) => oneLine(p, LABEL_MAX)).join(" → ");
}
const store = new Map();
function rememberFlow(trace) {
    store.delete(trace.id);
    store.set(trace.id, trace);
    while (store.size > STORE_CAP) {
        store.delete(store.keys().next().value);
    }
}
const flowById = (id) => store.get(id);
exports.flowById = flowById;
function noteFlowChips(id, labels) {
    const trace = typeof id === "string" ? store.get(id) : undefined;
    if (trace && !trace.chips) {
        trace.chips = [...labels];
    }
}
//# sourceMappingURL=flow.js.map