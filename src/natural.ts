// Natural follow-ups: the chips under a finished answer are the next
// moves the agent itself offered or asked about, in its own words — or none.
//
// Why this shape (researched 2026-09-26, see CHANGELOG 0.0.183):
//  - xAI's published Grok prompts (github.com/xai-org/grok-prompts, every
//    version through 2025-11-17) never ask the model to suggest follow-ups.
//    Grok's own rule is "the shortest answer you can, while respecting any
//    stated length and comprehensiveness preferences".
//  - The follow-up-chip pattern: few chips, each a concrete next ask from THIS
//    answer, none when nothing fits. Generic always-on chips are the top
//    complaint about ChatGPT's (OpenAI community, "Setting to Disable
//    Follow-up Suggestions").
// Agents nearly always end by offering the next move ("Want me to …?", "Should
// I …?", "I can also … if you'd like."). Those words become the chips: no extra
// model call, no invented intent. No offer and no concrete cue: no chips.
//
// Pure string work — no vscode import — so check NF drives it directly.

import { NATURAL_MAX_LABEL, naturalText } from "./followups";

export interface NaturalChip {
    label: string;
    prompt: string;
    command: "dev" | "plan";
}

export interface AnswerFacts {
    agent: string;
    answer: string;
    steps: ReadonlyArray<{ tool: string; detail?: string; filePath?: string }>;
}

// Verbs that change the checkout run under /dev; reading verbs under plan.
const EDIT_VERBS = new Set(
    ("add address apply align branch build bump change checkout clean clone close commit complete confirm continue convert " +
        "create delete deploy disable document drop edit enable exclude export extend extract finish fix focus format " +
        "generate go handle harden implement import include inline insert install keep limit make merge migrate move " +
        "open patch pin port post proceed prune relax restrict tighten " +
        "publish pull push rebase refactor release remove rename replace rerun restart restructure resume retry " +
        "revert rewrite rework roll run save scaffold send set ship simplify skip split squash start stash stub " +
        "switch sync tag test try turn update upgrade use validate verify wire wrap write").split(" ")
);
const READ_VERBS = new Set(
    ("analyse analyze audit benchmark break check clarify compare debug describe diff dig draft elaborate estimate " +
        "expand explain explore fetch find investigate list log look map measure monitor outline plan point print " +
        "profile propose research review search show sketch suggest summarise summarize trace walk watch").split(" ")
);
const isVerb = (word: string): boolean => EDIT_VERBS.has(word) || READ_VERBS.has(word);

// "let me know if you want X walked through" → "Walk through X".
const PARTICIPLES: Record<string, string> = {
    added: "add", applied: "apply", checked: "check", covered: "cover", documented: "document", done: "do",
    drafted: "draft", expanded: "expand", explained: "explain", extracted: "extract", fixed: "fix",
    implemented: "implement", listed: "list", made: "make", refactored: "refactor", removed: "remove",
    renamed: "rename", reviewed: "review", run: "run", split: "split", summarized: "summarize", tested: "test",
    updated: "update", walked: "walk", written: "write"
};

const ABBREVIATIONS = /\b(e\.g|i\.e|etc|vs|approx|incl|esp|cf)\./gi;

/** Markdown and code out, one sentence per line-ish unit, abbreviations kept whole. */
const plainText = (markdown: string): string =>
    markdown
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`\n]*)`/g, "$1")
        .replace(/\*\*|__/g, "")
        .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,!?;:]|$)/g, "$1$2")
        .replace(/^\s{0,3}(#{1,6}|>)\s*/gm, "")
        .replace(/[ \t]+/g, " ");

const sentencesOf = (text: string): string[] =>
    text
        .replace(ABBREVIATIONS, (m) => m.replace(/\./g, "․"))
        .split(/\n+|(?<=[.!?])\s+(?=[A-Z("'‘“])/)
        .map((x) => x.replace(/․/g, ".").replace(/^[-*•]\s+/, "").trim())
        .filter(Boolean);

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** A chip label: natural cut at a word boundary, never mid-word. */
const labelOf = (text: string): string => {
    if (text.length <= NATURAL_MAX_LABEL) {
        return text;
    }
    const cut = text.slice(0, NATURAL_MAX_LABEL - 1);
    const at = cut.lastIndexOf(" ");
    return `${(at > 20 ? cut.slice(0, at) : cut).replace(/[,;:—–-]+$/, "")}…`;
};

// The user says the chip, so the agent's "you/your" become "me/my".
const toUserVoice = (s: string): string =>
    s
        .replace(/\b(show|walk|tell|give|send|remind|help|ping)\s+you\b/gi, "$1 me")
        .replace(/\bfor you\b/gi, "for me")
        .replace(/\byour\b/gi, "my")
        .replace(/\byours\b/gi, "mine");

const cleanAction = (raw: string): string =>
    toUserVoice(
        raw
            .replace(/^[\s,:;—–-]+/, "")
            .replace(/^(?:(?:also|just|quickly|then|now|first|actually|still)\s+)+/i, "")
            .replace(/^go ahead,? and\s+/i, "")
            .replace(/\s*\((?:e\.g\.|i\.e\.|such as)[^)]*\)/gi, "")
            .replace(/[\s,;:—–-]*(?:too|as well|for you|next|now|here|instead)?[\s.!?,;:—–-]*$/i, "")
            .replace(/\s+/g, " ")
            .trim()
    );

const firstWord = (s: string): string => (s.match(/^[a-z]+/i)?.[0] ?? "").toLowerCase();

const commandFor = (action: string, turnKind: "dev" | "plan"): "dev" | "plan" => {
    // "Create a fix plan", "Write that plan out" — producing a plan is planning.
    if (/^(?:draft|create|write|make|outline|sketch|prepare|put together)\b[^.]{0,30}\bplan\b/i.test(action)) {
        return "plan";
    }
    const words = action.toLowerCase().match(/[a-z]+/g) ?? [];
    const verb = words[0] ?? "";
    if (EDIT_VERBS.has(verb)) {
        // "Go deeper on X" reads; "Go ahead" / "Go with B" acts.
        return verb === "go" && /^go (?:deeper|through|over|into)\b/i.test(action) ? "plan" : "dev";
    }
    if (READ_VERBS.has(verb)) {
        return "plan";
    }
    return turnKind;
};

// "Want me to …?" and its relatives; group 1 is the offered action.
const OFFERS: RegExp[] = [
    /^(?:so,?\s+|ok(?:ay)?,?\s+)?(?:do you want|would you like|want|shall|should|can|may|could)\s+(?:me\s+to|i)\s+(.+?)[?.!]*$/i,
    /^(?:if you(?:'d| would)? like|if you want|if (?:it(?:'s| is|'d be| would be) )?(?:helpful|useful)|if that helps),?\s*(?:i can|i could|i'll|i will|i'm happy to|happy to)\s+(.+?)[.!]*$/i,
    /^(?:i can|i could|i'm happy to|happy to|glad to)\s+(.+?),?\s+if\s+(?:you(?:'d| would)? like|you want|(?:it(?:'s| is|'d be) )?(?:helpful|useful)|that helps|needed)[.!]*$/i,
    /^let me know if you(?:'d| would)? like(?: me)? to\s+(.+?)[.!]*$/i,
    /^let me know if you want(?: me)? to\s+(.+?)[.!]*$/i,
    /^(?:possible |suggested )?next steps?\s*[:—–-]\s*(.+?)[.!]*$/i
];
const WANT_NOUN = /^let me know if you(?:'d| would)? (?:like|want)\s+(.+?)[.!]*$/i;
const WANT_TO_SEE = /^(?:do you\s+|would you\s+)?(?:want|like|care) to see\s+(.+?)\?$/i;
// "Want a plan to fix these?" — an offer phrased as a noun.
const WANT_A = /^(?:do you\s+|would you\s+)?(?:want|like)\s+(?:a|an|the|me to write an?)\s+(plan|patch|fix|test|tests|diff|summary|breakdown|walkthrough|pr|pull request)\b(.*?)\?$/i;
const WANT_A_VERB: Record<string, string> = {
    plan: "draft a plan", patch: "write a patch", fix: "write a fix", test: "write a test", tests: "write tests",
    diff: "show me the diff", summary: "summarize it", breakdown: "break it down", walkthrough: "walk me through it",
    pr: "open a PR", "pull request": "open a pull request"
};

// An alternative that is a question back to the user, not an action to run.
const NOT_AN_ACTION = /\s*[—–]\s*or\s+.*$|\s*,?\s+or\s+(?:is|are|do|does|should|would|was|were|did|just|leave|stop|not|anything|something|shall|is it|are you)\b.*$/i;
// "… any of these — e.g. A, B, or C —": the head applies to each example.
const ANY_OF = /^(.*?)\b(?:any|one|some|all|each|either|both)\s+of\s+(?:these|those|them|the above|the following)\b\s*[—–:(,-]*\s*(?:e\.g\.,?|i\.e\.,?|such as|like|namely)?\s*(.+?)\s*[—–)]*\s*$/i;

const splitAlternatives = (body: string): string[] => {
    const parts = body.split(/,\s*(?:or|and\/or)\s+|\s+or\s+|,\s+/).map((p) => p.trim()).filter(Boolean);
    return parts.length > 1 && parts.every((p) => isVerb(firstWord(p))) ? parts : [body];
};

const actionsFromOffer = (body: string): string[] => {
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

const participleAction = (np: string): string | undefined => {
    const m = np.match(/^(.+?)\s+([a-z]+)(\s+(?:through|out|up|down|over|in))?(?:\s+(?:too|as well|also))?$/i);
    const verb = m && PARTICIPLES[m[2].toLowerCase()];
    return verb ? `${verb}${m[3] ?? ""} ${m[1]}` : undefined;
};

// "Which do you prefer: Postgres or MySQL?" → two quick replies.
const CHOICE = [
    /^(?:which|what)\b[^?]*?(?:[:,—–]\s*|\b(?:prefer|want|use|pick|choose)\s+)(.+?)\?$/i,
    /^(?:do you (?:want|prefer)|would you (?:rather|prefer)|should (?:i|we) (?:use|go with|keep|pick|choose))\s+(.+?)\?$/i
];

const choicesOf = (sentence: string): string[] => {
    for (const re of CHOICE) {
        const m = sentence.match(re);
        if (!m) {
            continue;
        }
        const items = m[1].split(/,\s*or\s+|\s+or\s+|,\s+/).map((x) => x.replace(/^(?:the|to)\s+/i, "").trim());
        if (
            items.length >= 2 &&
            items.length <= 3 &&
            items.every((x) => x && x.length <= 40 && x.split(/\s+/).length <= 6 && !/^(?:not|something|anything)\b/i.test(x))
        ) {
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
// One pass for "a numbered list": the first item's text, once a second exists.
const NUMBERED = /^\s*(?:#{1,4}\s*)?(?:\*\*)?(?:step\s*)?([12])[).:]\s*(?:\*\*)?\s*(?:—\s*)?(.+)$/gim;

const firstOfNumbered = (markdown: string): string | undefined => {
    let first: string | undefined;
    for (const m of markdown.replace(/```[\s\S]*?```/g, " ").matchAll(NUMBERED)) {
        if (m[1] === "1" && first === undefined) {
            first = m[2];
        } else if (m[1] === "2" && first !== undefined) {
            return plainText(first).replace(/[*_`]/g, "").replace(/[:.]\s*$/, "").trim();
        }
    }
    return undefined;
};

export function naturalFollowups(input: AnswerFacts, max = 3): NaturalChip[] {
    const turnKind: "dev" | "plan" = input.agent === "dev" ? "dev" : "plan";
    const answer = input.answer ?? "";
    const text = plainText(answer);
    const tail = sentencesOf(text.slice(-900)).slice(-4);
    const chips: NaturalChip[] = [];
    const push = (label: string, promptText: string, command: "dev" | "plan", kao = ""): void => {
        if (chips.length < max && label && !chips.some((c) => c.prompt === promptText)) {
            chips.push({ label: kao ? `${kao} ${labelOf(label)}` : labelOf(label), prompt: promptText, command });
        }
    };
    const pushT = (t: { kao: string; label: string; prompt: string }, command: "dev" | "plan"): void =>
        push(t.label, t.prompt, command, t.kao);

    // 1. The agent's own offer, newest sentence first — and inside a sentence,
    // the clause after a dash, semicolon or colon ("…glob — let me know if you
    // want…", "Question: Should I …?").
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
            const t = naturalText("offer", { action: capitalize(action) });
            push(t.label, t.prompt, commandFor(action, turnKind));
        }
        if (actions.length) {
            break;
        }
    }

    // An offer that already means "do all of it" would make the fixAll and
    // apply chips (followups.json) the same click twice.
    const offersAll = chips.some((c) =>
        /^(?:apply|implement|fix|make|do|proceed|go ahead|address)\b(?:.*\b(?:these|them|this|it|all|those|everything|fixes|changes|steps?|plan)\b)?/i.test(c.label)
    );

    // 2. A closing either/or question: quick replies in the user's words.
    if (!chips.length && tail.length && /\?$/.test(tail[tail.length - 1])) {
        for (const choice of choicesOf(tail[tail.length - 1])) {
            const t = naturalText("choice", { choice });
            push(capitalize(t.label), t.prompt, turnKind);
        }
    }

    // 3. Concrete cues. The agent saying it will carry on comes first.
    if (UNFINISHED.test(text.slice(-300))) {
        pushT(naturalText("resume"), turnKind);
    }
    const edited = [
        ...new Set(input.steps.filter((s) => EDIT_TOOLS.test(s.tool)).map((s) => s.filePath || s.detail || "").filter(Boolean))
    ];
    const tailText = text.slice(-1200);
    if (turnKind === "dev" && !edited.length && PLAN_REFUSAL.test(tailText)) {
        pushT(naturalText("applyNow"), "dev");
    }
    if (turnKind === "plan") {
        // A numbered list is a PLAN when item 1 is an instruction ("Fix …"),
        // an ISSUE LIST when it names a problem, and an explanation otherwise —
        // which gets no chip: "Do #1" under "how does X work" is noise.
        const first = firstOfNumbered(answer);
        // Drop a spaced aside "(it skips the first item)", keep a call "subtotal()".
        const item = first && first.replace(/\s+\([^)]+\)/g, "").trim();
        // The label is cut by labelOf (word boundary); the PROMPT keeps the whole
        // item, bounded only against a runaway paragraph.
        const shortItem = item && (item.length > 200 ? item.slice(0, item.lastIndexOf(" ", 200)) : item);
        if (shortItem && EDIT_VERBS.has(firstWord(shortItem))) {
            pushT(naturalText("step1", { item: shortItem }), "dev");
        } else if (shortItem && ISSUE.test(first ?? "")) {
            pushT(naturalText("fix1", { item: shortItem }), "dev");
            if (!offersAll) {
                pushT(naturalText("fixAll"), "dev");
            }
        }
        if (RECOMMENDS.test(tailText) && /\?/.test(tailText)) {
            pushT(naturalText("recommend"), "dev");
        }
        if (!offersAll && ((shortItem && EDIT_VERBS.has(firstWord(shortItem))) || /```diff|^@@ /m.test(answer))) {
            pushT(naturalText("apply"), "dev");
        }
    }
    if (turnKind === "dev" && edited.length) {
        const file = edited.length === 1 ? edited[0].split(/[\\/]/).pop() ?? edited[0] : "";
        pushT(file ? naturalText("review1", { file }) : naturalText("reviewN", { n: String(edited.length) }), "plan");
        const ranTests = input.steps.some((s) => /\btest/i.test(s.detail ?? "") && /bash|shell|run/i.test(s.tool));
        if (!ranTests && !TESTS_PASSED.test(tailText)) {
            pushT(naturalText("tests"), "dev");
        }
    }
    return chips;
}
