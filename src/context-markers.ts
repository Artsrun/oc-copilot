// Shared by the context producer and the answer filter; this leaf has no host dependency.
export const CONTEXT_RULE = "---\n";
export const CONTEXT_FILES = "Files the user attached:";
export const CONTEXT_EXCERPTS = "Attached text excerpts:";
export const CONTEXT_PROBLEMS = "Attached problems:";
export const CONTEXT_SELECTION = "Active selection — ";
export const CONTEXT_INLINE = "Inline chat — ";
export const CONTEXT_END = "(Context only.";
export const CONTEXT_NOTE = `${CONTEXT_END} Do not repeat or summarize this block.)`;

// Bounds of the attached-text sections (context.ts), here so the answer filter
// can hold a whole echoed block (format.ts CONTEXT_HOLD_BYTES).
export const EXCERPT_BYTES_CAP = 16 * 1024;
export const TOTAL_EXCERPT_BYTES_CAP = 48 * 1024;
export const PROBLEMS_MAX_ITEMS = 30;
export const PROBLEM_BYTES_CAP = 1024;
/** Excerpts, problems, and room for headings, fences, paths and the rule lines. */
export const CONTEXT_HOLD_BYTES = TOTAL_EXCERPT_BYTES_CAP + (PROBLEMS_MAX_ITEMS + 1) * PROBLEM_BYTES_CAP + 32 * 1024;
