"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.removeWorktree = exports.worktreeDiff = exports.createWorktree = exports.slugify = exports.git = void 0;
const node_child_process_1 = require("node:child_process");
const path = __importStar(require("node:path"));
const git = (cwd, args, timeoutMs = 30000, maxBufferMB = 16) => new Promise((resolve) => {
    (0, node_child_process_1.execFile)("git", args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: maxBufferMB * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (error && !stderr ? String(error.message) : "") });
    });
});
exports.git = git;
const slugify = (task, max = 32) => task
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "") || "task";
exports.slugify = slugify;
const stampSlug = (d = new Date()) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const createWorktree = async (cwd, task) => {
    const top = await (0, exports.git)(cwd, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) {
        return { ok: false, reason: `\`${cwd}\` is not inside a git repository (${top.stderr.trim() || "git rev-parse failed"}).` };
    }
    const root = path.normalize(top.stdout.trim());
    const sha = await (0, exports.git)(root, ["rev-parse", "HEAD"]);
    if (sha.code !== 0) {
        return { ok: false, reason: "the repository has no commits yet — a worktree needs a commit to start from." };
    }
    const ref = await (0, exports.git)(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const slug = `${(0, exports.slugify)(task)}-${stampSlug()}`;
    const branch = `ai/${slug}`;
    const wtPath = path.join(path.dirname(root), `${path.basename(root)}.worktrees`, slug);
    const add = await (0, exports.git)(root, ["worktree", "add", "-b", branch, wtPath, "HEAD"], 120000);
    if (add.code !== 0) {
        return { ok: false, reason: `git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}` };
    }
    return {
        ok: true,
        worktree: { root, path: wtPath, branch, baseRef: ref.stdout.trim() || "HEAD", baseSha: sha.stdout.trim() }
    };
};
exports.createWorktree = createWorktree;
const worktreeDiff = async (wt, stat = true, maxBufferMB = 16) => {
    await (0, exports.git)(wt.path, ["add", "-N", "."]);
    const out = await (0, exports.git)(wt.path, ["diff", ...(stat ? ["--stat"] : []), wt.baseSha], 30000, maxBufferMB);
    return out.stdout.trim();
};
exports.worktreeDiff = worktreeDiff;
const removeWorktree = async (root, wtPath, branch) => {
    const rm = await (0, exports.git)(root, ["worktree", "remove", "--force", wtPath], 60000);
    if (rm.code === 0) {
        await (0, exports.git)(root, ["branch", "-D", branch]);
    }
    return rm;
};
exports.removeWorktree = removeWorktree;
//# sourceMappingURL=worktree.js.map