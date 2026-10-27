// Natural follow-ups: the chips under a finished answer are the next
// moves the agent itself offered or asked about, in its own words — or none.
//
// No extra model call or invented intent: no offer and no concrete cue means
// no chips. NF drives the string rules directly; shared utilities import core.

import { plainText, sentencesOf } from "./core";
import { NATURAL_MAX_LABEL, NaturalKey, naturalText } from "./followups";

export interface NaturalChip {
    label: string;
    prompt: string;
    command: "dev" | "plan" | "parallel";
    /** What made it: `offer` and `choice` are the agent's words; the rest are cues (chip backoff counts per kind). */
    kind: string;
}

export interface AnswerFacts {
    agent: string;
    answer: string;
    steps: ReadonlyArray<{ tool: string; detail?: string; filePath?: string }>;
    /** The next effort level the answering model offers above this turn's
     * (models.higherEffort); unset when unknown or already at the top. */
    nextEffort?: string;
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

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** A chip label: cut at a word, else after a path's `/`; only one token longer
 * than the label is cut mid-word. */
const labelOf = (text: string): string => {
    if (text.length <= NATURAL_MAX_LABEL) {
        return text;
    }
    const cut = text.slice(0, NATURAL_MAX_LABEL - 1);
    const at = cut.lastIndexOf(" ");
    const slash = cut.lastIndexOf("/");
    const head = at > 20 ? cut.slice(0, at) : slash > 20 ? cut.slice(0, slash + 1) : cut;
    return `${head.replace(/[,;:—–-]+$/, "")}…`;
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

// ", and" splits only a list of three or more: "run the tests, and fix any
// failures" is one action in two steps.
const splitAlternatives = (body: string): string[] => {
    const parts = body.split(/,\s*(?:or|and\/or|and)\s+|\s+or\s+|,\s+/).map((p) => p.trim()).filter(Boolean);
    const list = parts.length > 2 || !/,\s*and\s+/i.test(body);
    return list && parts.length > 1 && parts.every((p) => isVerb(firstWord(p))) ? parts : [body];
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
    // `Object.hasOwn`, not a bare lookup: "the parser constructor" found the
    // inherited key and offered "function Object() { [native code] } the parser".
    const word = m ? m[2].toLowerCase() : "";
    const verb = Object.hasOwn(PARTICIPLES, word) ? PARTICIPLES[word] : undefined;
    return m && verb ? `${verb}${m[3] ?? ""} ${m[1]}` : undefined;
};

// "the docs updated or the tests added" is two offers; a part that is not a
// participle phrase ("… or something else") voids the whole sentence.
const participleActions = (np: string): string[] => {
    const parts = np.replace(NOT_AN_ACTION, "").split(/,\s*(?:or|and)\s+|\s+or\s+|,\s+/).map((p) => p.trim()).filter(Boolean);
    const actions = parts.map(participleAction);
    return actions.every(Boolean) ? (actions as string[]) : [];
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
// "3 failing", "2 tests failed", "tests are still failing" — never "0 failed".
const TESTS_FAILED = /\b(?:[1-9]\d*) (?:tests? |specs? |checks? )?(?:fail(?:ed|ing|ures?)?)\b|\b(?:tests?|specs?|checks?) (?:are |is |still |now )*fail(?:ed|ing|s)?\b|\bfailing (?:tests?|specs?|checks?)\b/i;
// "0 tests failed", "No tests failed", "no checks are failing": the second
// TESTS_FAILED alternative has no leading count, so a negation must veto it.
const NO_FAILURES = /\b(?:no|zero|0)\s+(?:\d+\s+)?(?:tests?|specs?|checks?)\s+(?:are |is |were |still |now )*(?:fail(?:ed|ing|s|ures?)?)\b/i;
// The agent saying it could not settle the question: worth one more look at a
// higher reasoning effort, when the model has one.
const UNCERTAIN = /\b(?:i(?:'m| am) not (?:sure|certain)|(?:couldn't|could not|can't|cannot) (?:determine|confirm|verify|tell|find out)|unclear (?:whether|why|if|how)|not enough (?:information|context)|hard to say|without (?:more|further) (?:context|information)|i(?:'m| am) guessing)\b/i;
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

// The first contiguous numbered run that starts at 1, fences out.
const NUMBERED_ALL = /^[ \t]*(\d{1,3})[).][ \t]+(\S.*)$/;
const numberedList = (markdown: string): string[] => {
    const items: string[] = [];
    for (const line of markdown.replace(/```[\s\S]*?```/g, "\n").split("\n")) {
        const m = line.match(NUMBERED_ALL);
        if (!m) {
            continue;
        }
        if (Number(m[1]) === items.length + 1) {
            items.push(m[2]);
        } else if (items.length) {
            break;
        }
    }
    return items;
};

const LANE_TARGET = /[\w.-]+\/[\w.-]+|\b[\w-]+\.[a-z]{1,5}\b|\b\w+\(\)/i;
const BARE_BACKREF = /^[a-z]+\s+(?:it|them|this|that|these|those)\b/i;

/** 2-5 read-only steps, each with a concrete target, that the lane splitter
 * keeps as one lane apiece. `splits` is injected: natural may not import chat-boot.
 * The same rule reads a plan answer (the "Run N as lanes" chip) and, under
 * `autoParallel: auto`, the user's own prompt. */
export const laneItems = (markdown: string, splits: (task: string) => string[]): string[] | undefined => {
    const raw = numberedList(markdown);
    if (raw.length < 2 || raw.length > 5) {
        return undefined;
    }
    const items = raw.map((r) => plainText(r).replace(/[\s.:;]+$/, "").trim());
    const ok = items.every(
        (i) => i.length >= 8 && i.length <= 200 && READ_VERBS.has(firstWord(i)) && LANE_TARGET.test(i) && !BARE_BACKREF.test(i) && splits(i).length === 1
    );
    return ok && splits(items.join("\n---\n")).length === items.length ? items : undefined;
};

// A review's findings, ranked by a severity named where a review puts one: a
// heading above the items ("### High"), a tag at an item's start ("**High** —",
// "[P1]", "High:") or a Severity column. "high" inside a sentence is a word,
// not a severity. OpenCode's own /review asks only to "communicate severity"
// (1.19.3), so bullets, `<li>`, table rows and numbered items are all read.
interface Finding {
    rank: number;
    tag: string;
    text: string;
}
const RANKS: Record<string, number> = {
    critical: 4, blocker: 4, blocking: 4, p0: 4,
    high: 3, major: 3, p1: 3,
    medium: 2, moderate: 2, p2: 2,
    low: 1, minor: 1, nit: 1, nitpick: 1, p3: 1
};
const TAG = String.raw`(critical|blocker|blocking|p[0-3]|high|major|medium|moderate|low|minor|nit(?:pick)?)(?:\s+(?:severity|priority|risk|impact))?`;
// The tag, then a mark that ends it: "**High:**", "**[P1]**", "[HIGH]", "(Low)",
// or "**High**" / "High" before a colon, a spaced dash or a code span.
// "High-level design" and "**High** availability" are not tags.
const TAGGED = new RegExp(
    String.raw`^[^\w[(*_]*(?:(?:\*\*|__)\[?${TAG}(?:\]|:)(?:\*\*|__)|[[(]${TAG}[\])]|(?:\*\*|__)?${TAG}(?:\*\*|__)?(?=\s*[:—–]|\s+-\s|\s*\x60))\s*(?:[:—–]|-\s)?\s*(.*)$`,
    "i"
);
const TAG_HEADING = new RegExp(
    String.raw`^[^\w[(]*[[(]?${TAG}[\])]?(?:\s+(?:issues?|findings?|problems?|bugs?|concerns?))?(?:\s*\(\d+\))?(?:(?:\s*[:—–]|\s+-\s).*|\s*)$`,
    "i"
);
const FINDINGS_HEADING = /^[^\w]*(?:(?:code\s+)?review\s+)?(?:findings?|issues?|problems?|bugs?|concerns?)(?:\s+found)?(?:\s*\(\d+\))?\s*:?\s*$/i;
// Top-level items only: an indented one is the detail of the item above.
const FINDING_ITEM = /^ ?(?:[-*+•]|\d{1,3}[.)])\s+(.+)$/;
const NONE_ITEM = /^(?:none|n\/a|nothing|no (?:issues?|findings?|problems?|bugs?))\b/i;
const SEVERITY_COLUMN = /^(?:severity|sev|priority|impact|risk|level)$/i;

const findingText = (raw: string): string => {
    const text = plainText(raw.replace(/<[^>]+>/g, " "))
        .replace(/[*`]/g, "")
        .replace(/\s+\([^)]+\)/g, "")
        .replace(/^[\s:—–-]+|[\s.:;]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return text.length > 200 ? text.slice(0, text.lastIndexOf(" ", 200)) : text;
};

// "### High" and "**High**" set or end a section; a "High:" line only sets one,
// so "Details:" between items does not end it.
const headingOf = (line: string): { text: string; strong: boolean } | undefined => {
    const strong = line.match(/^\s{0,3}#{1,6}\s+(.+?)[\s#]*$/)?.[1] ?? line.match(/^\s*(?:\*\*|__)([^*_]+?)(?:\*\*|__)\s*:?\s*$/)?.[1];
    if (strong !== undefined) {
        return { text: plainText(strong).trim(), strong: true };
    }
    const label = line.match(/^\s*([^\s|<>`*+•-][^:|]{0,48}):\s*$/)?.[1];
    return label === undefined ? undefined : { text: plainText(label).trim(), strong: false };
};

const findingsOf = (markdown: string): Finding[] => {
    const lines = markdown
        .replace(/```[\s\S]*?```/g, "\n")
        .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n### $1\n")
        .replace(/<\/?(?:b|strong)>/gi, "**")
        .replace(/<li[^>]*>/gi, "\n- ")
        .replace(/<\/li>|<\/?(?:ul|ol|p)[^>]*>|<br\s*\/?>/gi, "\n")
        .split("\n");
    const found: Finding[] = [];
    let section: { rank: number; tag: string } | undefined;
    let columns: string[] | undefined;
    const add = (tag: string | undefined, raw: string): void => {
        const text = findingText(raw);
        if (!text || NONE_ITEM.test(text)) {
            return;
        }
        if (tag) {
            found.push({ rank: RANKS[tag.toLowerCase()], tag, text });
        } else if (section) {
            found.push({ ...section, text });
        }
    };
    for (const line of lines) {
        const row = line.match(/^\s*\|(.*)\|\s*$/);
        if (row) {
            const cells = row[1].split("|").map((c) => plainText(c).trim());
            if (cells.every((c) => !c || /^:?-{2,}:?$/.test(c))) {
                continue;
            }
            if (!columns) {
                columns = cells;
                continue;
            }
            const at = columns.findIndex((c) => SEVERITY_COLUMN.test(c));
            const cell = at >= 0 ? (cells[at] ?? "").replace(/^\W+|\W+$/g, "") : "";
            add(
                Object.hasOwn(RANKS, cell.toLowerCase()) ? cell : undefined,
                cells.filter((c, i) => i !== at && c).join(" — ")
            );
            continue;
        }
        columns = undefined;
        const item = line.match(FINDING_ITEM);
        if (item) {
            const tagged = item[1].match(TAGGED);
            add(tagged ? tagged[1] ?? tagged[2] ?? tagged[3] : undefined, tagged ? tagged[4] : item[1]);
            continue;
        }
        const heading = headingOf(line);
        if (heading) {
            const tag = heading.text.match(TAG_HEADING)?.[1];
            const set = tag ? { rank: RANKS[tag.toLowerCase()], tag } : FINDINGS_HEADING.test(heading.text) ? { rank: 0, tag: "" } : undefined;
            section = set ?? (heading.strong ? undefined : section);
        }
    }
    return found;
};

const severityName = (tag: string): string => (/^p\d$/i.test(tag) ? tag.toUpperCase() : capitalize(tag.toLowerCase()));

/** Ranked findings: the worst one, its group when it has two or more, then all.
 * Low only gets nothing; unranked items under a Findings heading read like a
 * numbered issue list. */
const findingChips = (found: readonly Finding[], offersAll: boolean): NaturalChip[] => {
    const top = Math.max(0, ...found.map((f) => f.rank));
    const fixAll = !offersAll ? [cueChip("fixAll", "dev", naturalText("fixAll"))] : [];
    if (top === 0) {
        const first = found[0]?.text ?? "";
        return found.length >= 2 && ISSUE.test(first) && !EDIT_VERBS.has(firstWord(first))
            ? [cueChip("fix1", "dev", naturalText("fix1", { item: first })), ...fixAll]
            : [];
    }
    if (top < 2) {
        return [];
    }
    const group = found.filter((f) => f.rank === top);
    const severity = severityName(group[0].tag);
    const out = [cueChip("fixTop", "dev", naturalText("fixTop", { severity, item: group[0].text }))];
    if (group.length >= 2) {
        out.push(cueChip("fixGroup", "dev", naturalText("fixGroup", { severity, n: String(group.length) })));
    }
    return found.length > group.length ? [...out, ...fixAll] : out;
};

// Bounds on what part of the answer is read: the whole answer can be 250 KB.
const OFFER_TAIL_CHARS = 900; // the tail scanned for the agent's offers
const OFFER_TAIL_SENTENCES = 4; // …sentences of that tail
const OFFER_HEAD_SENTENCES = 3; // …sentences of the head, scanned only when nothing fired
const CUE_TAIL_CHARS = 300; // the shorter tail the unfinished cue reads
const CUE_TEXT_CHARS = 1200; // the tail the other cues read
const ACTION_MAX_CHARS = 140; // one offered action is never longer

/** A cue chip as `naturalFollowups` combines them (the kind is the backoff key). */
const cueChip = (kind: NaturalKey, command: NaturalChip["command"], t: { kao: string; label: string; prompt: string }): NaturalChip => ({
    label: t.kao ? `${t.kao} ${labelOf(t.label)}` : labelOf(t.label),
    prompt: t.prompt,
    command,
    kind
});

/** 1. The agent's own offer in these sentences, newest clause first — inside a
 * sentence, the clause after a dash, semicolon or colon ("…glob — let me know
 * if you want…", "Question: Should I …?"). The first sentence that offers
 * wins; a later one would be the older ask. */
const offerChipsIn = (sentences: readonly string[], turnKind: "dev" | "plan"): NaturalChip[] => {
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
            const t = naturalText("offer", { action: capitalize(action) });
            return { label: labelOf(t.label), prompt: t.prompt, command: commandFor(action, turnKind), kind: "offer" };
        });
    }
    return [];
};

// An offer that already means "do all of it" would make the fixAll and apply
// chips (followups.json) the same click twice.
const OFFERS_ALL = /^(?:apply|implement|fix|make|do|proceed|go ahead|address)\b(?:\s*[.!?]*$|.*\b(?:these|them|this|it|all|those|everything|fixes|changes|steps?|plan)\b)/i;
const offersAllOf = (offers: readonly NaturalChip[]): boolean => offers.some((c) => OFFERS_ALL.test(c.label));

/** 2. A closing either/or question: quick replies in the user's words. */
const choiceChipsIn = (tail: readonly string[], turnKind: "dev" | "plan"): NaturalChip[] => {
    if (!tail.length || !/\?$/.test(tail[tail.length - 1])) {
        return [];
    }
    return choicesOf(tail[tail.length - 1]).map((choice) => {
        const t = naturalText("choice", { choice });
        return { label: labelOf(capitalize(t.label)), prompt: t.prompt, command: turnKind, kind: "choice" };
    });
};

/** 3. Concrete cues, in order: the agent saying it will carry on first, then
 * what this answer did and points at. Offers fill the cap before any cue:
 * three offers leave no room for Continue. */
const cueChipsIn = (
    input: AnswerFacts,
    answer: string,
    text: string,
    turnKind: "dev" | "plan",
    offersAll: boolean,
    splits?: (task: string) => string[]
): NaturalChip[] => {
    const out: NaturalChip[] = [];
    if (UNFINISHED.test(text.slice(-CUE_TAIL_CHARS))) {
        out.push(cueChip("resume", turnKind, naturalText("resume")));
    }
    const edited = [
        ...new Set(input.steps.filter((s) => EDIT_TOOLS.test(s.tool)).map((s) => s.filePath || s.detail || "").filter(Boolean))
    ];
    const tailText = text.slice(-CUE_TEXT_CHARS);
    if (turnKind === "dev" && !edited.length && PLAN_REFUSAL.test(tailText)) {
        out.push(cueChip("applyNow", "dev", naturalText("applyNow")));
    }
    if (turnKind === "plan") {
        // A review's findings take the place of the numbered-list reading below.
        const findings = findingChips(findingsOf(answer), offersAll);
        out.push(...findings);
        // A numbered list is a PLAN when item 1 is an instruction ("Fix …"),
        // an ISSUE LIST when it names a problem, and an explanation otherwise —
        // which gets no chip: "Do #1" under "how does X work" is noise.
        const first = findings.length ? undefined : firstOfNumbered(answer);
        // Drop a spaced aside "(it skips the first item)", keep a call "subtotal()".
        const item = first && first.replace(/\s+\([^)]+\)/g, "").trim();
        // The label is cut by labelOf (word boundary); the PROMPT keeps the whole
        // item, bounded only against a runaway paragraph.
        const shortItem = item && (item.length > 200 ? item.slice(0, item.lastIndexOf(" ", 200)) : item);
        if (shortItem && EDIT_VERBS.has(firstWord(shortItem))) {
            out.push(cueChip("step1", "dev", naturalText("step1", { item: shortItem })));
        } else if (shortItem && ISSUE.test(first ?? "")) {
            out.push(cueChip("fix1", "dev", naturalText("fix1", { item: shortItem })));
            if (!offersAll) {
                out.push(cueChip("fixAll", "dev", naturalText("fixAll")));
            }
        }
        const lanes = splits ? laneItems(answer, splits) : undefined;
        if (lanes) {
            out.push(cueChip("lanes", "parallel", naturalText("lanes", { n: String(lanes.length), lanes: lanes.join("\n---\n") })));
        }
        if (RECOMMENDS.test(tailText) && /\?/.test(tailText)) {
            out.push(cueChip("recommend", "dev", naturalText("recommend")));
        }
        if (!offersAll && ((shortItem && EDIT_VERBS.has(firstWord(shortItem))) || /```diff|^@@ /m.test(answer))) {
            out.push(cueChip("apply", "dev", naturalText("apply")));
        }
    }
    if (turnKind === "dev" && edited.length) {
        const file = edited.length === 1 ? edited[0].split(/[\\/]/).pop() ?? edited[0] : "";
        out.push(cueChip("review1", "plan", file ? naturalText("review1", { file }) : naturalText("reviewN", { n: String(edited.length) })));
        const ranTests = input.steps.some((s) => /\btest/i.test(s.detail ?? "") && /bash|shell|run/i.test(s.tool));
        if (TESTS_FAILED.test(tailText) && !NO_FAILURES.test(tailText)) {
            out.push(cueChip("fixTests", "dev", naturalText("fixTests")));
        } else if (!ranTests && !TESTS_PASSED.test(tailText)) {
            out.push(cueChip("tests", "dev", naturalText("tests")));
        }
    }
    // An unsettled answer, and a level above this turn's: one more look, harder.
    if (input.nextEffort && /^[A-Za-z][\w-]{0,23}$/.test(input.nextEffort) && UNCERTAIN.test(tailText)) {
        const t = naturalText("deeper", { effort: input.nextEffort });
        out.push(cueChip("deeper", turnKind, { ...t, prompt: `effort:${input.nextEffort} ${t.prompt}` }));
    }
    return out;
};

/** `held`: kinds the chip backoff holds back (./chips); they leave room for the next. */
export function naturalFollowups(input: AnswerFacts, max = 3, splits?: (task: string) => string[], held?: ReadonlySet<string>): NaturalChip[] {
    const turnKind: "dev" | "plan" = input.agent === "dev" ? "dev" : "plan";
    const answer = input.answer ?? "";
    const text = plainText(answer);
    const tail = sentencesOf(text.slice(-OFFER_TAIL_CHARS)).slice(-OFFER_TAIL_SENTENCES);
    const offers = offerChipsIn(tail, turnKind);
    const choices = offers.length ? [] : choiceChipsIn(tail, turnKind);
    const cues = cueChipsIn(input, answer, text, turnKind, offersAllOf(offers), splits);
    let all = [...offers, ...choices, ...cues];
    if (!all.length) {
        // Agents state intent up front ("I'll fix A."), and a long plan answer
        // can end in a summary that buries its offer below the tail scan. Only
        // when nothing fired — a live cue or choice always out-ranks the head.
        all = offerChipsIn(sentencesOf(text).slice(0, OFFER_HEAD_SENTENCES), turnKind);
    }
    const seen = new Set<string>();
    const chips: NaturalChip[] = [];
    for (const c of all) {
        if (chips.length >= max || !c.label || held?.has(c.kind) || seen.has(c.prompt)) {
            continue;
        }
        seen.add(c.prompt);
        chips.push(c);
    }
    return chips;
}
