"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.naturalFollowups = naturalFollowups;
const followups_1 = require("./followups");
const EDIT_VERBS = new Set(("add address apply align branch build bump change checkout clean clone close commit complete confirm continue convert " +
    "create delete deploy disable document drop edit enable exclude export extend extract finish fix focus format " +
    "generate go handle harden implement import include inline insert install keep limit make merge migrate move " +
    "open patch pin port post proceed prune relax restrict tighten " +
    "publish pull push rebase refactor release remove rename replace rerun restart restructure resume retry " +
    "revert rewrite rework roll run save scaffold send set ship simplify skip split squash start stash stub " +
    "switch sync tag test try turn update upgrade use validate verify wire wrap write").split(" "));
const READ_VERBS = new Set(("analyse analyze audit benchmark break check clarify compare debug describe diff dig draft elaborate estimate " +
    "expand explain explore fetch find investigate list log look map measure monitor outline plan point print " +
    "profile propose research review search show sketch suggest summarise summarize trace walk watch").split(" "));
const isVerb = (word) => EDIT_VERBS.has(word) || READ_VERBS.has(word);
const PARTICIPLES = {
    added: "add", applied: "apply", checked: "check", covered: "cover", documented: "document", done: "do",
    drafted: "draft", expanded: "expand", explained: "explain", extracted: "extract", fixed: "fix",
    implemented: "implement", listed: "list", made: "make", refactored: "refactor", removed: "remove",
    renamed: "rename", reviewed: "review", run: "run", split: "split", summarized: "summarize", tested: "test",
    updated: "update", walked: "walk", written: "write"
};
const ABBREVIATIONS = /\b(e\.g|i\.e|etc|vs|approx|incl|esp|cf)\./gi;
const plainText = (markdown) => markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,!?;:]|$)/g, "$1$2")
    .replace(/^\s{0,3}(#{1,6}|>)\s*/gm, "")
    .replace(/[ \t]+/g, " ");
const sentencesOf = (text) => text
    .replace(ABBREVIATIONS, (m) => m.replace(/\./g, "․"))
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z("'‘“])/)
    .map((x) => x.replace(/․/g, ".").replace(/^[-*•]\s+/, "").trim())
    .filter(Boolean);
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const labelOf = (text) => {
    if (text.length <= followups_1.NATURAL_MAX_LABEL) {
        return text;
    }
    const cut = text.slice(0, followups_1.NATURAL_MAX_LABEL - 1);
    const at = cut.lastIndexOf(" ");
    return `${(at > 20 ? cut.slice(0, at) : cut).replace(/[,;:—–-]+$/, "")}…`;
};
const toUserVoice = (s) => s
    .replace(/\b(show|walk|tell|give|send|remind|help|ping)\s+you\b/gi, "$1 me")
    .replace(/\bfor you\b/gi, "for me")
    .replace(/\byour\b/gi, "my")
    .replace(/\byours\b/gi, "mine");
const cleanAction = (raw) => toUserVoice(raw
    .replace(/^[\s,:;—–-]+/, "")
    .replace(/^(?:(?:also|just|quickly|then|now|first|actually|still)\s+)+/i, "")
    .replace(/^go ahead,? and\s+/i, "")
    .replace(/\s*\((?:e\.g\.|i\.e\.|such as)[^)]*\)/gi, "")
    .replace(/[\s,;:—–-]*(?:too|as well|for you|next|now|here|instead)?[\s.!?,;:—–-]*$/i, "")
    .replace(/\s+/g, " ")
    .trim());
const firstWord = (s) => (s.match(/^[a-z]+/i)?.[0] ?? "").toLowerCase();
const commandFor = (action, turnKind) => {
    if (/^(?:draft|create|write|make|outline|sketch|prepare|put together)\b[^.]{0,30}\bplan\b/i.test(action)) {
        return "plan";
    }
    const words = action.toLowerCase().match(/[a-z]+/g) ?? [];
    const verb = words[0] ?? "";
    if (EDIT_VERBS.has(verb)) {
        return verb === "go" && /^go (?:deeper|through|over|into)\b/i.test(action) ? "plan" : "dev";
    }
    if (READ_VERBS.has(verb)) {
        return "plan";
    }
    return turnKind;
};
const OFFERS = [
    /^(?:so,?\s+|ok(?:ay)?,?\s+)?(?:do you want|would you like|want|shall|should|can|may|could)\s+(?:me\s+to|i)\s+(.+?)[?.!]*$/i,
    /^(?:if you(?:'d| would)? like|if you want|if (?:it(?:'s| is|'d be| would be) )?(?:helpful|useful)|if that helps),?\s*(?:i can|i could|i'll|i will|i'm happy to|happy to)\s+(.+?)[.!]*$/i,
    /^(?:i can|i could|i'm happy to|happy to|glad to)\s+(.+?),?\s+if\s+(?:you(?:'d| would)? like|you want|(?:it(?:'s| is|'d be) )?(?:helpful|useful)|that helps|needed)[.!]*$/i,
    /^let me know if you(?:'d| would)? like(?: me)? to\s+(.+?)[.!]*$/i,
    /^let me know if you want(?: me)? to\s+(.+?)[.!]*$/i,
    /^(?:possible |suggested )?next steps?\s*[:—–-]\s*(.+?)[.!]*$/i
];
const WANT_NOUN = /^let me know if you(?:'d| would)? (?:like|want)\s+(.+?)[.!]*$/i;
const WANT_TO_SEE = /^(?:do you\s+|would you\s+)?(?:want|like|care) to see\s+(.+?)\?$/i;
const WANT_A = /^(?:do you\s+|would you\s+)?(?:want|like)\s+(?:a|an|the|me to write an?)\s+(plan|patch|fix|test|tests|diff|summary|breakdown|walkthrough|pr|pull request)\b(.*?)\?$/i;
const WANT_A_VERB = {
    plan: "draft a plan", patch: "write a patch", fix: "write a fix", test: "write a test", tests: "write tests",
    diff: "show me the diff", summary: "summarize it", breakdown: "break it down", walkthrough: "walk me through it",
    pr: "open a PR", "pull request": "open a pull request"
};
const NOT_AN_ACTION = /\s*[—–]\s*or\s+.*$|\s*,?\s+or\s+(?:is|are|do|does|should|would|was|were|did|just|leave|stop|not|anything|something|shall|is it|are you)\b.*$/i;
const ANY_OF = /^(.*?)\b(?:any|one|some|all|each|either|both)\s+of\s+(?:these|those|them|the above|the following)\b\s*[—–:(,-]*\s*(?:e\.g\.,?|i\.e\.,?|such as|like|namely)?\s*(.+?)\s*[—–)]*\s*$/i;
const splitAlternatives = (body) => {
    const parts = body.split(/,\s*(?:or|and\/or)\s+|\s+or\s+|,\s+/).map((p) => p.trim()).filter(Boolean);
    return parts.length > 1 && parts.every((p) => isVerb(firstWord(p))) ? parts : [body];
};
const actionsFromOffer = (body) => {
    const any = body.match(ANY_OF);
    if (any) {
        const head = any[1].trim();
        const items = any[2]
            .split(/,\s*(?:or|and)\s+|\s+or\s+|,\s+/)
            .map((x) => x.replace(/[—–)]+$/, "").trim())
            .filter(Boolean);
        if (head && isVerb(firstWord(cleanAction(head))) && items.length) {
            return items.map((item) => `${head} ${item}`);
        }
    }
    return splitAlternatives(body.replace(NOT_AN_ACTION, ""));
};
const participleAction = (np) => {
    const m = np.match(/^(.+?)\s+([a-z]+)(\s+(?:through|out|up|down|over|in))?(?:\s+(?:too|as well|also))?$/i);
    const verb = m && PARTICIPLES[m[2].toLowerCase()];
    return verb ? `${verb}${m[3] ?? ""} ${m[1]}` : undefined;
};
const CHOICE = [
    /^(?:which|what)\b[^?]*?(?:[:,—–]\s*|\b(?:prefer|want|use|pick|choose)\s+)(.+?)\?$/i,
    /^(?:do you (?:want|prefer)|would you (?:rather|prefer)|should (?:i|we) (?:use|go with|keep|pick|choose))\s+(.+?)\?$/i
];
const choicesOf = (sentence) => {
    for (const re of CHOICE) {
        const m = sentence.match(re);
        if (!m) {
            continue;
        }
        const items = m[1].split(/,\s*or\s+|\s+or\s+|,\s+/).map((x) => x.replace(/^(?:the|to)\s+/i, "").trim());
        if (items.length >= 2 &&
            items.length <= 3 &&
            items.every((x) => x && x.length <= 40 && x.split(/\s+/).length <= 6 && !/^(?:not|something|anything)\b/i.test(x))) {
            return items;
        }
    }
    return [];
};
const EDIT_TOOLS = /^(?:edit|write|patch|multiedit|apply_patch)$/i;
const RECOMMENDS = /my recommendation|i(?:'d| would)? recommend|recommended:/i;
const PLAN_REFUSAL = /plan mode|read-only mode|exit plan mode|can(?:'|no)t (?:execute|make|apply) (?:edits|changes)/i;
const TESTS_PASSED = /\b(?:all )?(?:\d+ )?(?:tests?|checks?|specs?) (?:now )?(?:pass(?:ed|es|ing)?|are green|green)\b|\b\d+ passing\b/i;
const ISSUE = /\b(?:bug|issue|problem|incorrect|wrong|broken|fails?|failing|error|off-by-one|missing|leak|race|regression|skips?)\b/i;
const UNFINISHED = /\b(?:i'll (?:now |next )?(?:continue|proceed|move on)|next,? i(?:'ll| will)|remaining (?:steps|items|work)|still (?:need|left) to|to be continued|(?:stopping|stopped) here for now|ran out of (?:time|context|budget))\b/i;
const NUMBERED = /^\s*(?:#{1,4}\s*)?(?:\*\*)?(?:step\s*)?([12])[).:]\s*(?:\*\*)?\s*(?:—\s*)?(.+)$/gim;
const firstOfNumbered = (markdown) => {
    let first;
    for (const m of markdown.replace(/```[\s\S]*?```/g, " ").matchAll(NUMBERED)) {
        if (m[1] === "1" && first === undefined) {
            first = m[2];
        }
        else if (m[1] === "2" && first !== undefined) {
            return plainText(first).replace(/[*_`]/g, "").replace(/[:.]\s*$/, "").trim();
        }
    }
    return undefined;
};
function naturalFollowups(input, max = 3) {
    const turnKind = input.agent === "dev" ? "dev" : "plan";
    const answer = input.answer ?? "";
    const text = plainText(answer);
    const tail = sentencesOf(text.slice(-900)).slice(-4);
    const chips = [];
    const push = (label, promptText, command, kao = "") => {
        if (chips.length < max && label && !chips.some((c) => c.prompt === promptText)) {
            chips.push({ label: kao ? `${kao} ${labelOf(label)}` : labelOf(label), prompt: promptText, command });
        }
    };
    const pushT = (t, command) => push(t.label, t.prompt, command, t.kao);
    const clauses = tail.flatMap((s) => [s, ...s.split(/\s[—–]\s|;\s|:\s(?=[A-Z])/).slice(1).reverse()]);
    for (const sentence of [...clauses].reverse()) {
        const body = OFFERS.map((re) => sentence.match(re)?.[1]).find(Boolean);
        const noun = !body ? sentence.match(WANT_NOUN)?.[1] : undefined;
        const see = !body && !noun ? sentence.match(WANT_TO_SEE)?.[1] : undefined;
        const wantA = !body && !noun && !see ? sentence.match(WANT_A) : undefined;
        const raw = body
            ? actionsFromOffer(body)
            : noun
                ? [participleAction(noun.replace(/[?.!]+$/, "")) ?? ""]
                : see
                    ? [`show me ${see}`]
                    : wantA
                        ? [`${WANT_A_VERB[wantA[1].toLowerCase()]}${wantA[2] ?? ""}`]
                        : [];
        const actions = raw.map(cleanAction).filter((a) => a.length >= 3 && a.length <= 140 && isVerb(firstWord(a)));
        for (const action of actions) {
            const t = (0, followups_1.naturalText)("offer", { action: capitalize(action) });
            push(t.label, t.prompt, commandFor(action, turnKind));
        }
        if (actions.length) {
            break;
        }
    }
    const offersAll = chips.some((c) => /^(?:apply|implement|fix|make|do|proceed|go ahead|address)\b(?:.*\b(?:these|them|this|it|all|those|everything|fixes|changes|steps?|plan)\b)?/i.test(c.label));
    if (!chips.length && tail.length && /\?$/.test(tail[tail.length - 1])) {
        for (const choice of choicesOf(tail[tail.length - 1])) {
            const t = (0, followups_1.naturalText)("choice", { choice });
            push(capitalize(t.label), t.prompt, turnKind);
        }
    }
    if (UNFINISHED.test(text.slice(-300))) {
        pushT((0, followups_1.naturalText)("resume"), turnKind);
    }
    const edited = [
        ...new Set(input.steps.filter((s) => EDIT_TOOLS.test(s.tool)).map((s) => s.filePath || s.detail || "").filter(Boolean))
    ];
    const tailText = text.slice(-1200);
    if (turnKind === "dev" && !edited.length && PLAN_REFUSAL.test(tailText)) {
        pushT((0, followups_1.naturalText)("applyNow"), "dev");
    }
    if (turnKind === "plan") {
        const first = firstOfNumbered(answer);
        const item = first && first.replace(/\s+\([^)]+\)/g, "").trim();
        const shortItem = item && (item.length > 200 ? item.slice(0, item.lastIndexOf(" ", 200)) : item);
        if (shortItem && EDIT_VERBS.has(firstWord(shortItem))) {
            pushT((0, followups_1.naturalText)("step1", { item: shortItem }), "dev");
        }
        else if (shortItem && ISSUE.test(first ?? "")) {
            pushT((0, followups_1.naturalText)("fix1", { item: shortItem }), "dev");
            if (!offersAll) {
                pushT((0, followups_1.naturalText)("fixAll"), "dev");
            }
        }
        if (RECOMMENDS.test(tailText) && /\?/.test(tailText)) {
            pushT((0, followups_1.naturalText)("recommend"), "dev");
        }
        if (!offersAll && ((shortItem && EDIT_VERBS.has(firstWord(shortItem))) || /```diff|^@@ /m.test(answer))) {
            pushT((0, followups_1.naturalText)("apply"), "dev");
        }
    }
    if (turnKind === "dev" && edited.length) {
        const file = edited.length === 1 ? edited[0].split(/[\\/]/).pop() ?? edited[0] : "";
        pushT(file ? (0, followups_1.naturalText)("review1", { file }) : (0, followups_1.naturalText)("reviewN", { n: String(edited.length) }), "plan");
        const ranTests = input.steps.some((s) => /\btest/i.test(s.detail ?? "") && /bash|shell|run/i.test(s.tool));
        if (!ranTests && !TESTS_PASSED.test(tailText)) {
            pushT((0, followups_1.naturalText)("tests"), "dev");
        }
    }
    return chips;
}
//# sourceMappingURL=natural.js.map