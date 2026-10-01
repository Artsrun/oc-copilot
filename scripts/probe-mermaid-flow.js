// Probe (v188): do /flow diagrams parse and render in real mermaid?
// Needs what the extension does not ship:
//   npm i --no-save mermaid@11 playwright   (Chromium: CHROME=/path/to/chrome)
//   npm run compile && node scripts/probe-mermaid-flow.js
// Prints one line per case: ok, the node count, the first labels as drawn.
// Unhealthy on purpose first: MERMAID_RAW=1 skips flowLabel's escaping, and
// the hostile case must then fail.
const path = require("node:path");
const { chromium } = require("playwright");
const F = require(path.join(__dirname, "..", "out", "flow.js"));

if (process.env.MERMAID_RAW) {
    F.flowLabel = (s) => s;
}
const trace = (title, fill) => {
    const t = F.newTrace();
    t.title = title;
    fill(t);
    return t;
};
const cases = {
    plain: trace("plan · explain my_login.ts", (t) => {
        F.flowAdd(t.nodes, "info", "folder", "site");
        for (let i = 0; i < 7; i++) F.flowAdd(t.nodes, "step", "read", `f${i % 3}.ts`);
        F.flowAdd(t.nodes, "handoff", "handoff", "acme/second", "warn");
        t.end = { kind: "end", key: "timed out after 1.2s", parts: [], count: 1, status: "fail" };
        t.chips = ["Run it anyway"];
    }),
    hostile: trace('say "hi" `x` <script>alert(1)</script> #1 %% --> end', (t) => {
        F.flowAdd(t.nodes, "step", "bash", 'echo "a" --> b\n```\nrm -rf / ; %%{init: {"theme":"dark"}}%% ' + "z".repeat(2000));
        F.flowAdd(t.nodes, "info", "model", "a]b[c(d)e{f}g|h;i&amp;");
        F.flowAdd(t.nodes, "info", "");
        t.lanes.push({ title: 'lane "1" end', nodes: [] });
        F.flowAdd(t.lanes[0].nodes, "info", 'x"y');
        t.end = { kind: "end", key: "done", parts: [], count: 1 };
    }),
    big: trace("big", (t) => {
        for (let i = 0; i < 200; i++) F.flowAdd(t.nodes, "step", `t${i}`);
        for (let l = 0; l < 7; l++) {
            t.lanes.push({ title: `lane ${l}`, nodes: [] });
            for (let i = 0; i < 30; i++) F.flowAdd(t.lanes[l].nodes, "step", `s${i}`);
        }
        t.end = { kind: "end", key: "done", parts: [], count: 1 };
    })
};

(async () => {
    const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
    const page = await browser.newPage();
    await page.setContent("<html><body></body></html>");
    await page.addScriptTag({ path: require.resolve("mermaid/dist/mermaid.min.js") });
    for (const [name, t] of Object.entries(cases)) {
        const r = await page.evaluate(async (src) => {
            mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
            try {
                await mermaid.parse(src);
                const { svg } = await mermaid.render(`d${Math.random().toString(36).slice(2)}`, src);
                const div = document.createElement("div");
                div.innerHTML = svg;
                const nodes = [...div.querySelectorAll("g.node")];
                return { ok: true, nodes: nodes.length, scripts: div.querySelectorAll("script").length, first: nodes.slice(0, 3).map((n) => n.textContent.slice(0, 70)) };
            } catch (err) {
                return { ok: false, error: String(err && err.message).split("\n")[0] };
            }
        }, F.toMermaid(t));
        console.log(name, JSON.stringify(r));
    }
    await browser.close();
})();
