"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planTimeout = planTimeout;
exports.markClarifiedPrompt = markClarifiedPrompt;
exports.insistedOn = insistedOn;
exports.isVaguePrompt = isVaguePrompt;
const core_1 = require("./core");
function planTimeout() {
    const settings = (0, core_1.config)();
    const raw = settings.get("timeoutMs", 0);
    const base = raw > 0 ? Math.max(1000, raw) : 0;
    const idle = Math.max(0, settings.get("idleTimeoutMs", 300000));
    if (base === 0) {
        return { timeoutMs: 0, idleTimeoutMs: idle, reason: "no wall-clock cap — idle timeout only" };
    }
    return { timeoutMs: base, idleTimeoutMs: idle, reason: "fixed cap" };
}
const CONNECTIVITY_WORDS = /^(ping|test|hello|hi|hey|yo|check|status|are you (there|alive|up)|you there)\W*$/i;
let lastClarifiedPrompt = "";
function markClarifiedPrompt(prompt) {
    lastClarifiedPrompt = prompt;
}
function insistedOn(prompt) {
    return prompt.length > 0 && prompt === lastClarifiedPrompt;
}
const BARE_WORD = /^[^\s./\\@#:()_\-\d]{1,12}$/;
function isVaguePrompt(task) {
    const trimmed = task.trim();
    return !trimmed || CONNECTIVITY_WORDS.test(trimmed) || BARE_WORD.test(trimmed);
}
//# sourceMappingURL=prompt.js.map