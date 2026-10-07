"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.laneItems = void 0;
exports.naturalFollowups = naturalFollowups;
const core_1 = require("./core");
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
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const labelOf = (text) => {
    if (text.length <= followups_1.NATURAL_MAX_LABEL) {
        return text;
    }
    const cut = text.slice(0, followups_1.NATURAL_MAX_LABEL - 1);
    const at = cut.lastIndexOf(" ");
    const slash = cut.lastIndexOf("/");
    const head = at > 20 ? cut.slice(0, at) : slash > 20 ? cut.slice(0, slash + 1) : cut;
    return `${head.replace(/[,;:—–-]+$/, "")}…`;
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
    const parts = body.split(/,\s*(?:or|and\/or|and)\s+|\s+or\s+|,\s+/).map((p) => p.trim()).filter(Boolean);
    const list = parts.length > 2 || !/,\s*and\s+/i.test(body);
    return list && parts.length > 1 && parts.every((p) => isVerb(firstWord(p))) ? parts : [body];
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
    const word = m ? m[2].toLowerCase() : "";
    const verb = Object.hasOwn(PARTICIPLES, word) ? PARTICIPLES[word] : undefined;
    return m && verb ? `${verb}${m[3] ?? ""} ${m[1]}` : undefined;
};
const participleActions = (np) => {
    const parts = np.replace(NOT_AN_ACTION, "").split(/,\s*(?:or|and)\s+|\s+or\s+|,\s+/).map((p) => p.trim()).filter(Boolean);
    const actions = parts.map(participleAction);
    return actions.every(Boolean) ? actions : [];
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
const TESTS_FAILED = /\b(?:[1-9]\d*) (?:tests? |specs? |checks? )?(?:fail(?:ed|ing|ures?)?)\b|\b(?:tests?|specs?|checks?) (?:are |is |still |now )*fail(?:ed|ing|s)?\b|\bfailing (?:tests?|specs?|checks?)\b/i;
const NO_FAILURES = /\b(?:no|zero|0)\s+(?:\d+\s+)?(?:tests?|specs?|checks?)\s+(?:are |is |were |still |now )*(?:fail(?:ed|ing|s|ures?)?)\b/i;
const UNCERTAIN = /\b(?:i(?:'m| am) not (?:sure|certain)|(?:couldn't|could not|can't|cannot) (?:determine|confirm|verify|tell|find out)|unclear (?:whether|why|if|how)|not enough (?:information|context)|hard to say|without (?:more|further) (?:context|information)|i(?:'m| am) guessing)\b/i;
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
            return (0, core_1.plainText)(first).replace(/[*_`]/g, "").replace(/[:.]\s*$/, "").trim();
        }
    }
    return undefined;
};
const NUMBERED_ALL = /^[ \t]*(\d{1,3})[).][ \t]+(\S.*)$/;
const numberedList = (markdown) => {
    const items = [];
    for (const line of markdown.replace(/```[\s\S]*?```/g, "\n").split("\n")) {
        const m = line.match(NUMBERED_ALL);
        if (!m) {
            continue;
        }
        if (Number(m[1]) === items.length + 1) {
            items.push(m[2]);
        }
        else if (items.length) {
            break;
        }
    }
    return items;
};
const LANE_TARGET = /[\w.-]+\/[\w.-]+|\b[\w-]+\.[a-z]{1,5}\b|\b\w+\(\)/i;
const BARE_BACKREF = /^[a-z]+\s+(?:it|them|this|that|these|those)\b/i;
const laneItems = (markdown, splits) => {
    const raw = numberedList(markdown);
    if (raw.length < 2 || raw.length > 5) {
        return undefined;
    }
    const items = raw.map((r) => (0, core_1.plainText)(r).replace(/[\s.:;]+$/, "").trim());
    const ok = items.every((i) => i.length >= 8 && i.length <= 200 && READ_VERBS.has(firstWord(i)) && LANE_TARGET.test(i) && !BARE_BACKREF.test(i) && splits(i).length === 1);
    return ok && splits(items.join("\n---\n")).length === items.length ? items : undefined;
};
exports.laneItems = laneItems;
const OFFER_TAIL_CHARS = 900;
const OFFER_TAIL_SENTENCES = 4;
const OFFER_HEAD_SENTENCES = 3;
const CUE_TAIL_CHARS = 300;
const CUE_TEXT_CHARS = 1200;
const ACTION_MAX_CHARS = 140;
const cueChip = (kind, command, t) => ({
    label: t.kao ? `${t.kao} ${labelOf(t.label)}` : labelOf(t.label),
    prompt: t.prompt,
    command,
    kind
});
const offerChipsIn = (sentences, turnKind) => {
    const clauses = sentences.flatMap((s) => [s, ...s.split(/\s[—–]\s|;\s|:\s(?=[A-Z])/).slice(1).reverse()]);
    for (const sentence of [...clauses].reverse()) {
        const body = OFFERS.map((re) => sentence.match(re)?.[1]).find(Boolean);
        const noun = !body ? sentence.match(WANT_NOUN)?.[1] : undefined;
        const see = !body && !noun ? sentence.match(WANT_TO_SEE)?.[1] : undefined;
        const wantA = !body && !noun && !see ? sentence.match(WANT_A) : undefined;
        const raw = body
            ? actionsFromOffer(body)
            : noun
                ? participleActions(noun.replace(/[?.!]+$/, ""))
                : see
                    ? [`show me ${see}`]
                    : wantA
                        ? [`${WANT_A_VERB[wantA[1].toLowerCase()]}${wantA[2] ?? ""}`]
                        : [];
        const actions = raw.map(cleanAction).filter((a) => a.length >= 3 && a.length <= ACTION_MAX_CHARS && isVerb(firstWord(a)));
        if (!actions.length) {
            continue;
        }
        return actions.map((action) => {
            const t = (0, followups_1.naturalText)("offer", { action: capitalize(action) });
            return { label: labelOf(t.label), prompt: t.prompt, command: commandFor(action, turnKind), kind: "offer" };
        });
    }
    return [];
};
const OFFERS_ALL = /^(?:apply|implement|fix|make|do|proceed|go ahead|address)\b(?:\s*[.!?]*$|.*\b(?:these|them|this|it|all|those|everything|fixes|changes|steps?|plan)\b)/i;
const offersAllOf = (offers) => offers.some((c) => OFFERS_ALL.test(c.label));
const choiceChipsIn = (tail, turnKind) => {
    if (!tail.length || !/\?$/.test(tail[tail.length - 1])) {
        return [];
    }
    return choicesOf(tail[tail.length - 1]).map((choice) => {
        const t = (0, followups_1.naturalText)("choice", { choice });
        return { label: labelOf(capitalize(t.label)), prompt: t.prompt, command: turnKind, kind: "choice" };
    });
};
const cueChipsIn = (input, answer, text, turnKind, offersAll, splits) => {
    const out = [];
    if (UNFINISHED.test(text.slice(-CUE_TAIL_CHARS))) {
        out.push(cueChip("resume", turnKind, (0, followups_1.naturalText)("resume")));
    }
    const edited = [
        ...new Set(input.steps.filter((s) => EDIT_TOOLS.test(s.tool)).map((s) => s.filePath || s.detail || "").filter(Boolean))
    ];
    const tailText = text.slice(-CUE_TEXT_CHARS);
    if (turnKind === "dev" && !edited.length && PLAN_REFUSAL.test(tailText)) {
        out.push(cueChip("applyNow", "dev", (0, followups_1.naturalText)("applyNow")));
    }
    if (turnKind === "plan") {
        const first = firstOfNumbered(answer);
        const item = first && first.replace(/\s+\([^)]+\)/g, "").trim();
        const shortItem = item && (item.length > 200 ? item.slice(0, item.lastIndexOf(" ", 200)) : item);
        if (shortItem && EDIT_VERBS.has(firstWord(shortItem))) {
            out.push(cueChip("step1", "dev", (0, followups_1.naturalText)("step1", { item: shortItem })));
        }
        else if (shortItem && ISSUE.test(first ?? "")) {
            out.push(cueChip("fix1", "dev", (0, followups_1.naturalText)("fix1", { item: shortItem })));
            if (!offersAll) {
                out.push(cueChip("fixAll", "dev", (0, followups_1.naturalText)("fixAll")));
            }
        }
        const lanes = splits ? (0, exports.laneItems)(answer, splits) : undefined;
        if (lanes) {
            out.push(cueChip("lanes", "parallel", (0, followups_1.naturalText)("lanes", { n: String(lanes.length), lanes: lanes.join("\n---\n") })));
        }
        if (RECOMMENDS.test(tailText) && /\?/.test(tailText)) {
            out.push(cueChip("recommend", "dev", (0, followups_1.naturalText)("recommend")));
        }
        if (!offersAll && ((shortItem && EDIT_VERBS.has(firstWord(shortItem))) || /```diff|^@@ /m.test(answer))) {
            out.push(cueChip("apply", "dev", (0, followups_1.naturalText)("apply")));
        }
    }
    if (turnKind === "dev" && edited.length) {
        const file = edited.length === 1 ? edited[0].split(/[\\/]/).pop() ?? edited[0] : "";
        out.push(cueChip("review1", "plan", file ? (0, followups_1.naturalText)("review1", { file }) : (0, followups_1.naturalText)("reviewN", { n: String(edited.length) })));
        const ranTests = input.steps.some((s) => /\btest/i.test(s.detail ?? "") && /bash|shell|run/i.test(s.tool));
        if (TESTS_FAILED.test(tailText) && !NO_FAILURES.test(tailText)) {
            out.push(cueChip("fixTests", "dev", (0, followups_1.naturalText)("fixTests")));
        }
        else if (!ranTests && !TESTS_PASSED.test(tailText)) {
            out.push(cueChip("tests", "dev", (0, followups_1.naturalText)("tests")));
        }
    }
    if (input.nextEffort && /^[A-Za-z][\w-]{0,23}$/.test(input.nextEffort) && UNCERTAIN.test(tailText)) {
        const t = (0, followups_1.naturalText)("deeper", { effort: input.nextEffort });
        out.push(cueChip("deeper", turnKind, { ...t, prompt: `effort:${input.nextEffort} ${t.prompt}` }));
    }
    return out;
};
function naturalFollowups(input, max = 3, splits, held) {
    const turnKind = input.agent === "dev" ? "dev" : "plan";
    const answer = input.answer ?? "";
    const text = (0, core_1.plainText)(answer);
    const tail = (0, core_1.sentencesOf)(text.slice(-OFFER_TAIL_CHARS)).slice(-OFFER_TAIL_SENTENCES);
    const offers = offerChipsIn(tail, turnKind);
    const choices = offers.length ? [] : choiceChipsIn(tail, turnKind);
    const cues = cueChipsIn(input, answer, text, turnKind, offersAllOf(offers), splits);
    let all = [...offers, ...choices, ...cues];
    if (!all.length) {
        all = offerChipsIn((0, core_1.sentencesOf)(text).slice(0, OFFER_HEAD_SENTENCES), turnKind);
    }
    const seen = new Set();
    const chips = [];
    for (const c of all) {
        if (chips.length >= max || !c.label || held?.has(c.kind) || seen.has(c.prompt)) {
            continue;
        }
        seen.add(c.prompt);
        chips.push(c);
    }
    return chips;
}
//# sourceMappingURL=natural.js.map