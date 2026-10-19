#!/usr/bin/env node
// A scripted OpenAI-compatible chat model, so a probe can drive a REAL OpenCode
// binary with no provider account and no cost, and every tool attempt is
// certain (a real model may choose not to try: INCONCLUSIVE, never PASS).
//
// The newest user text — a subagent's task prompt included — carries
// `[[probe:<action>]]`:
//   text                  answer "Hello from the scripted model."
//   write:<path>          call write (or edit/patch) on <path>
//   bash:<command>        call bash (`shell` on 2.x)
//   read:<path>           call read on <path>
//   task@<agent>:<action> call task (`subagent` on 2.x); the child's prompt carries <action>
//   question              call question
//   exec:<base64 JS>      call execute (2.x Code Mode)
//   call:<name>           call the tool named <name>, or `<server>_<name>` (MCP), with {}
//   slow                  stream one chunk every 250 ms for 20 s (cancel tests)
// After a tool result it answers "Done. The tool said: <result>".
//
//   node scripts/probe-model.js [port] [log.jsonl]          standalone
//   const { startScriptedModel, projectConfig } = require("./probe-model")
//
// Used by probe-readonly.js and probe-acp.js. Dev only, never shipped.
"use strict";
const http = require("node:http");
const fs = require("node:fs");

const textOf = (content) =>
    typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("") : "";

function scenario(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === "tool") {
            return { kind: "after-tool", result: textOf(m.content) };
        }
        if (m.role === "user") {
            const found = textOf(m.content).match(/\[\[probe:([^\]]+)\]\]/);
            return found ? { kind: "action", action: found[1] } : { kind: "plain" };
        }
    }
    return { kind: "plain" };
}

// The first offered tool among `names`, in that order (`write` before `edit`).
const toolNamed = (tools, names) => {
    const fns = (tools || []).map((t) => t.function ?? t);
    for (const n of names) {
        const f = fns.find((x) => x?.name === n);
        if (f) {
            return f;
        }
    }
    return undefined;
};

const TOOL_NAMES = {
    write: ["write", "edit", "patch", "apply_patch"],
    bash: ["bash", "shell"],
    read: ["read"],
    task: ["task", "subagent", "agent"],
    question: ["question"],
    exec: ["execute"]
};

function argsFor(tool, action) {
    const props = Object.keys(tool?.parameters?.properties ?? {});
    const pick = (...names) => names.find((n) => props.includes(n)) ?? names[0];
    const [head, ...rest] = action.split(":");
    const [verb, sub] = head.split("@");
    const arg = rest.join(":");
    if (verb === "write") {
        return { [pick("filePath", "path", "file_path")]: arg, [pick("content", "contents", "text")]: "written by the probe model\n" };
    }
    if (verb === "read") {
        return { [pick("filePath", "path", "file_path")]: arg };
    }
    if (verb === "bash") {
        return { [pick("command", "cmd")]: arg, [pick("description")]: "probe command" };
    }
    if (verb === "task") {
        return { [pick("description")]: "probe subagent", [pick("prompt")]: `[[probe:${arg}]]`, [pick("subagent_type", "agent", "subagentType")]: sub || "general" };
    }
    if (verb === "exec") {
        return { code: Buffer.from(arg, "base64").toString("utf8") };
    }
    if (verb === "question") {
        return { questions: [{ question: "Which one?", header: "Pick", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] };
    }
    return {};
}

/** Start the model on 127.0.0.1. `calls`: every request, newest last. */
function startScriptedModel({ port = 0, log } = {}) {
    const calls = [];
    const chunk = (delta, finish, usage) => ({
        id: `probe-${calls.length}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "scripted",
        choices: [{ index: 0, delta, finish_reason: finish ?? null }],
        ...(usage ? { usage } : {})
    });
    const usage = { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 };
    const textChunks = (text) => [chunk({ role: "assistant", content: "" }), ...(text.match(/.{1,12}/gs) ?? [text]).map((p) => chunk({ content: p })), chunk({}, "stop", usage)];
    const toolChunks = (name, args) => [
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${calls.length}`, type: "function", function: { name, arguments: "" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }),
        chunk({}, "tool_calls", usage)
    ];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
            let parsed = {};
            try {
                parsed = JSON.parse(body || "{}");
            } catch {
                // keep {}
            }
            const messages = parsed.messages ?? [];
            const tools = parsed.tools ?? [];
            const sc = scenario(messages);
            const record = { n: calls.length + 1, path: req.url, tools: tools.map((t) => (t.function ?? t).name), scenario: sc };
            calls.push(record);
            if (log) {
                fs.appendFileSync(log, JSON.stringify(record) + "\n");
            }
            if (!/\/chat\/completions$/.test(req.url ?? "")) {
                res.writeHead(404, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: `no route ${req.url}` } }));
                return;
            }
            let chunks;
            let delay = 5;
            if (sc.kind === "after-tool") {
                chunks = textChunks(`Done. The tool said: ${sc.result.replace(/\s+/g, " ").slice(0, 160)}`);
            } else if (sc.kind === "action" && tools.length) {
                const verb = sc.action.split(":")[0].split("@")[0];
                const wanted = sc.action.slice(verb.length + 1);
                const tool = verb === "call" ? (tools.map((t) => t.function ?? t).find((f) => f?.name === wanted || f?.name?.endsWith(`_${wanted}`))) : toolNamed(tools, TOOL_NAMES[verb] ?? []);
                record.called = tool?.name;
                if (verb === "slow") {
                    chunks = textChunks("slow ".repeat(80));
                    delay = 250;
                } else if (verb === "text" || !tool) {
                    chunks = textChunks(verb === "text" ? "Hello from the scripted model." : `No ${verb} tool offered (tools: ${record.tools.join(",")}).`);
                } else {
                    chunks = toolChunks(tool.name, argsFor(tool, sc.action));
                }
            } else {
                // title generation, summaries and anything without an action
                chunks = textChunks("Probe title");
            }
            if (parsed.stream === false) {
                const text = chunks.map((c) => c.choices[0].delta.content ?? "").join("");
                const call = chunks.find((c) => c.choices[0].delta.tool_calls)?.choices[0].delta.tool_calls?.[0];
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: `probe-${calls.length}`,
                    object: "chat.completion",
                    created: Math.floor(Date.now() / 1000),
                    model: "scripted",
                    choices: [{ index: 0, message: { role: "assistant", content: text || null, ...(call ? { tool_calls: [call] } : {}) }, finish_reason: call ? "tool_calls" : "stop" }],
                    usage
                }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
            let i = 0;
            const next = () => {
                if (res.destroyed) {
                    return;
                }
                if (i >= chunks.length) {
                    res.write("data: [DONE]\n\n");
                    res.end();
                    return;
                }
                res.write(`data: ${JSON.stringify(chunks[i++])}\n\n`);
                setTimeout(next, delay);
            };
            next();
        });
    });
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
            const bound = server.address().port;
            resolve({ port: bound, url: `http://127.0.0.1:${bound}`, calls, close: () => new Promise((r) => server.close(() => r())) });
        });
    });
}

/** An opencode.json that makes `probe/scripted` the model (both majors). */
const projectConfig = (url) => ({
    model: "probe/scripted",
    small_model: "probe/scripted",
    provider: {
        probe: {
            npm: "@ai-sdk/openai-compatible",
            name: "Probe",
            options: { baseURL: `${url}/v1`, apiKey: "probe" },
            models: { scripted: { name: "Scripted", tool_call: true, limit: { context: 64000, output: 4096 } } }
        }
    }
});

module.exports = { startScriptedModel, projectConfig };

if (require.main === module) {
    startScriptedModel({ port: Number(process.argv[2] || 0), log: process.argv[3] }).then((m) => process.stdout.write(`${m.port}\n`));
}
