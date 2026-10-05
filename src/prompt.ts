// How a prompt becomes a run plan: the timeout budget (the same for every agent
// and kind), and the "is this worth a full model run at all" vague-prompt gate.
// These share only `config`, so they are a file of their own rather than more
// of the runner.

import { config } from "./core";

export interface TimeoutPlan {
    timeoutMs: number;
    idleTimeoutMs: number;
    reason: string;
}

export function planTimeout(): TimeoutPlan {
    const settings = config();
    // `timeoutMs` defaults to 0 — no wall-clock cap. A run that is still
    // streaming is by definition not hung, so `idleTimeoutMs` is the cap that
    // decides hung-vs-slow and the one left armed by default. A positive
    // `timeoutMs` is a hard ceiling on turn length and cost, for anyone who
    // wants one.
    const raw = settings.get<number>("timeoutMs", 0);
    const base = raw > 0 ? Math.max(1000, raw) : 0;
    // 5 minutes, because a long run that legitimately goes quiet (a big read,
    // the model thinking before acting) must not be killed — that reads as "the
    // session broke". Set 0 to disable; with timeoutMs also 0 nothing stops a
    // hung run.
    const idle = Math.max(0, settings.get<number>("idleTimeoutMs", 300000));
    if (base === 0) {
        return { timeoutMs: 0, idleTimeoutMs: idle, reason: "no wall-clock cap — idle timeout only" };
    }
    return { timeoutMs: base, idleTimeoutMs: idle, reason: "fixed cap" };
}

// Vague-prompt clarification. `@opencode ping` costs a full model run to learn
// nothing, so asking first is cheaper — with a one-click "run it anyway".

const CONNECTIVITY_WORDS = /^(ping|test|hello|hi|hey|yo|check|status|are you (there|alive|up)|you there)\W*$/i;

// `prompt` is trimmed on the way in, so a trailing-space marker cannot survive.
// Remember the last prompt we asked about instead: sending it again — whether by
// retyping or via "Run it anyway" — means the user meant it, so it runs.
let lastClarifiedPrompt = "";

export function markClarifiedPrompt(prompt: string): void {
    lastClarifiedPrompt = prompt;
}

export function insistedOn(prompt: string): boolean {
    return prompt.length > 0 && prompt === lastClarifiedPrompt;
}

// Deliberately narrower than "two words or fewer": `run tests`, `fix build`
// and `review PR` are all actionable. Only a BARE SINGLE WORD qualifies — at
// most 12 characters, no whitespace, and nothing that marks a symbol or a
// filename (. / \ @ # : ( ) _ - or a digit).
const BARE_WORD = /^[^\s./\\@#:()_\-\d]{1,12}$/;

export function isVaguePrompt(task: string): boolean {
    const trimmed = task.trim();
    return !trimmed || CONNECTIVITY_WORDS.test(trimmed) || BARE_WORD.test(trimmed);
}