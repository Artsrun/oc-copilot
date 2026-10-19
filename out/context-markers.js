"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONTEXT_HOLD_BYTES = exports.PROBLEM_BYTES_CAP = exports.PROBLEMS_MAX_ITEMS = exports.TOTAL_EXCERPT_BYTES_CAP = exports.EXCERPT_BYTES_CAP = exports.CONTEXT_NOTE = exports.CONTEXT_END = exports.CONTEXT_INLINE = exports.CONTEXT_SELECTION = exports.CONTEXT_PROBLEMS = exports.CONTEXT_EXCERPTS = exports.CONTEXT_FILES = exports.CONTEXT_RULE = void 0;
exports.CONTEXT_RULE = "---\n";
exports.CONTEXT_FILES = "Files the user attached:";
exports.CONTEXT_EXCERPTS = "Attached text excerpts:";
exports.CONTEXT_PROBLEMS = "Attached problems:";
exports.CONTEXT_SELECTION = "Active selection — ";
exports.CONTEXT_INLINE = "Inline chat — ";
exports.CONTEXT_END = "(Context only.";
exports.CONTEXT_NOTE = `${exports.CONTEXT_END} Do not repeat or summarize this block.)`;
exports.EXCERPT_BYTES_CAP = 16 * 1024;
exports.TOTAL_EXCERPT_BYTES_CAP = 48 * 1024;
exports.PROBLEMS_MAX_ITEMS = 30;
exports.PROBLEM_BYTES_CAP = 1024;
exports.CONTEXT_HOLD_BYTES = exports.TOTAL_EXCERPT_BYTES_CAP + (exports.PROBLEMS_MAX_ITEMS + 1) * exports.PROBLEM_BYTES_CAP + 32 * 1024;
//# sourceMappingURL=context-markers.js.map