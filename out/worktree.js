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
exports.removeWorktree = exports.worktreeChanges = exports.listWorktrees = exports.baseText = exports.changedFiles = exports.worktreeDiff = exports.reopenWorktree = exports.uncommittedPaths = exports.worktreeLabel = exports.createWorktree = exports.slugify = exports.git = void 0;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
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
    const uncommitted = (await (0, exports.uncommittedPaths)(root)).length;
    const slug = `${(0, exports.slugify)(task)}-${stampSlug()}`;
    const branch = `ai/${slug}`;
    const wtPath = path.join(path.dirname(root), `${path.basename(root)}.worktrees`, slug);
    const add = await (0, exports.git)(root, ["worktree", "add", "-b", branch, wtPath, "HEAD"], 120000);
    if (add.code !== 0) {
        return { ok: false, reason: `git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}` };
    }
    return {
        ok: true,
        worktree: { root, path: wtPath, branch, baseRef: ref.stdout.trim() || "HEAD", baseSha: sha.stdout.trim() },
        uncommitted
    };
};
exports.createWorktree = createWorktree;
const worktreeLabel = (wtPath) => `${path.basename(path.dirname(wtPath))}/${path.basename(wtPath)}`;
exports.worktreeLabel = worktreeLabel;
const uncommittedPaths = async (root) => {
    const status = await (0, exports.git)(root, ["status", "--porcelain", "-z"]);
    if (status.code !== 0) {
        return [];
    }
    const out = [];
    const entries = status.stdout.split("\0");
    for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        if (entry.length < 4) {
            continue;
        }
        out.push(entry.slice(3));
        if (/^[RC]/.test(entry)) {
            i += 1;
        }
    }
    return out;
};
exports.uncommittedPaths = uncommittedPaths;
const reopenWorktree = async (cwd, wt) => {
    if (!/^ai\/[a-z0-9-]+$/.test(wt.branch)) {
        return false;
    }
    const top = await (0, exports.git)(cwd, ["rev-parse", "--show-toplevel"]);
    const root = top.code === 0 ? path.normalize(top.stdout.trim()) : "";
    if (!root || root !== path.normalize(wt.root)) {
        return false;
    }
    const expected = path.join(path.dirname(root), `${path.basename(root)}.worktrees`, wt.branch.slice(3));
    if (path.normalize(wt.path) !== expected || !fs.existsSync(expected)) {
        return false;
    }
    const head = await (0, exports.git)(expected, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return head.code === 0 && head.stdout.trim() === wt.branch;
};
exports.reopenWorktree = reopenWorktree;
const worktreeDiff = async (wt, stat = true, maxBufferMB = 16) => {
    await (0, exports.git)(wt.path, ["add", "-N", "."]);
    const out = await (0, exports.git)(wt.path, ["diff", ...(stat ? ["--stat"] : []), wt.baseSha], 30000, maxBufferMB);
    return out.stdout.trim();
};
exports.worktreeDiff = worktreeDiff;
const changedFiles = async (wt, maxBufferMB = 16) => {
    await (0, exports.git)(wt.path, ["add", "-N", "."]);
    const out = await (0, exports.git)(wt.path, ["-c", "core.quotepath=false", "diff", "--name-status", "--no-renames", "-z", wt.baseSha], 30000, maxBufferMB);
    if (out.code !== 0) {
        return [];
    }
    const parts = out.stdout.split("\0");
    const files = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
        const code = parts[i].charAt(0);
        if (parts[i + 1]) {
            files.push({ path: parts[i + 1], status: code === "A" ? "A" : code === "D" ? "D" : "M" });
        }
    }
    return files;
};
exports.changedFiles = changedFiles;
const baseText = async (wtPath, base, rel) => {
    if (!/^[0-9a-f]{7,64}$/.test(base) || !rel || !fs.existsSync(path.join(wtPath, ".git"))) {
        return "";
    }
    const out = await (0, exports.git)(wtPath, ["show", `${base}:${rel}`], 30000, 16);
    return out.code === 0 ? out.stdout : "";
};
exports.baseText = baseText;
const sameDir = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
const listWorktrees = async (cwd) => {
    const top = await (0, exports.git)(cwd, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) {
        return undefined;
    }
    const root = path.normalize(top.stdout.trim());
    const parent = path.join(path.dirname(root), `${path.basename(root)}.worktrees`);
    const list = await (0, exports.git)(root, ["worktree", "list", "--porcelain"]);
    const worktrees = [];
    for (const block of list.code === 0 ? list.stdout.split(/\r?\n\r?\n/) : []) {
        const listed = block.match(/^worktree (.+)$/m)?.[1];
        const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
        if (!listed || !branch || !/^ai\/[a-z0-9-]+$/.test(branch)) {
            continue;
        }
        const wtPath = path.normalize(listed);
        if (!sameDir(path.dirname(wtPath), parent) || !fs.existsSync(wtPath)) {
            continue;
        }
        const fork = await (0, exports.git)(root, ["merge-base", "HEAD", branch]);
        const head = fork.code === 0 ? fork : await (0, exports.git)(wtPath, ["rev-parse", "HEAD"]);
        const base = head.stdout.trim();
        const ahead = base ? await (0, exports.git)(root, ["rev-list", "--count", `${base}..${branch}`]) : undefined;
        worktrees.push({
            path: wtPath,
            branch,
            base,
            changed: (await (0, exports.uncommittedPaths)(wtPath)).length,
            commits: ahead?.code === 0 ? Number(ahead.stdout.trim()) || 0 : 0
        });
    }
    return { root, worktrees };
};
exports.listWorktrees = listWorktrees;
const worktreeChanges = (wt) => [wt.changed ? `${wt.changed} uncommitted` : "", wt.commits ? `${wt.commits} commit${wt.commits === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || "no changes";
exports.worktreeChanges = worktreeChanges;
const removeWorktree = async (root, wtPath, branch) => {
    const rm = await (0, exports.git)(root, ["worktree", "remove", "--force", wtPath], 60000);
    if (rm.code === 0) {
        await (0, exports.git)(root, ["branch", "-D", branch]);
    }
    return rm;
};
exports.removeWorktree = removeWorktree;
//# sourceMappingURL=worktree.js.map