// `/worktree <task>` — opt-in isolation.
//
// The default is cooperative: @opencode edits the checkout you and Copilot are
// already in. `/worktree` is the explicit exception: a fresh git worktree + branch
// NEXT TO the repo (never inside it — Rule 5), so the run cannot touch your
// checkout. What it guarantees and what it does not is stated once, here, and
// echoed in the README under the same claim tag.
//
// claim:worktree-command
// GUARANTEES: a worktree at <parent>/<repo>.worktrees/<slug> on branch
//   ai/<slug>, created from your current HEAD — or, for a follow-up in the same
//   chat, the one it already made (reopenWorktree); the dev run's cwd and --dir
//   are that folder, so tracked files in your checkout are not written. A new
//   worktree says how many uncommitted changes it left behind.
// DOES NOT: commit; copy untracked files (.env, node_modules); separate ports or
//   OpenCode's global session store; merge anything back.
//
// Git is run with execFile and an argument array — no shell, and the only
// user-derived argument (the slug) is reduced to [a-z0-9-]. This is not an
// OpenCode process, so Rule 3 (spawnOpenCode) does not apply; the BF tripwire
// pins execFile to this file and forbids enabling a shell.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface GitResult {
    code: number;
    stdout: string;
    stderr: string;
}

export const git = (cwd: string, args: string[], timeoutMs = 30000, maxBufferMB = 16): Promise<GitResult> =>
    new Promise((resolve) => {
        execFile("git", args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: maxBufferMB * 1024 * 1024 }, (error, stdout, stderr) => {
            const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
            resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (error && !stderr ? String(error.message) : "") });
        });
    });

// "Implement the redirect fix!" -> "implement-the-redirect-fix"; empty -> "task".
export const slugify = (task: string, max = 32): string =>
    task
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, max)
        .replace(/-+$/g, "") || "task";

const stampSlug = (d = new Date()): string => {
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export interface Worktree {
    root: string;
    path: string;
    branch: string;
    baseRef: string;
    baseSha: string;
}

/** `uncommitted`: the checkout's `git status` entries, which the worktree does not get. */
export type WorktreeResult = { ok: true; worktree: Worktree; uncommitted: number } | { ok: false; reason: string };

export const createWorktree = async (cwd: string, task: string): Promise<WorktreeResult> => {
    const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) {
        return { ok: false, reason: `\`${cwd}\` is not inside a git repository (${top.stderr.trim() || "git rev-parse failed"}).` };
    }
    const root = path.normalize(top.stdout.trim());
    const sha = await git(root, ["rev-parse", "HEAD"]);
    if (sha.code !== 0) {
        return { ok: false, reason: "the repository has no commits yet — a worktree needs a commit to start from." };
    }
    const ref = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    // The worktree starts from HEAD: edits not yet committed stay behind, and a
    // task about them finds nothing to do there.
    const uncommitted = (await uncommittedPaths(root)).length;
    const slug = `${slugify(task)}-${stampSlug()}`;
    const branch = `ai/${slug}`;
    const wtPath = path.join(path.dirname(root), `${path.basename(root)}.worktrees`, slug);
    const add = await git(root, ["worktree", "add", "-b", branch, wtPath, "HEAD"], 120000);
    if (add.code !== 0) {
        return { ok: false, reason: `git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}` };
    }
    return {
        ok: true,
        worktree: { root, path: wtPath, branch, baseRef: ref.stdout.trim() || "HEAD", baseSha: sha.stdout.trim() },
        uncommitted
    };
};

/** `<repo>.worktrees/<slug>`: what chat shows; the log keeps the full path. */
export const worktreeLabel = (wtPath: string): string => `${path.basename(path.dirname(wtPath))}/${path.basename(wtPath)}`;

/** The checkout's `git status` entries as repo-relative paths (`/`, a rename's
 * new name): what a worktree from HEAD does not have. Empty when git fails. */
export const uncommittedPaths = async (root: string): Promise<string[]> => {
    const status = await git(root, ["status", "--porcelain", "-z"]);
    if (status.code !== 0) {
        return [];
    }
    const out: string[] = [];
    const entries = status.stdout.split("\0");
    for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        if (entry.length < 4) {
            continue;
        }
        out.push(entry.slice(3));
        // `-z` puts a rename's or copy's old name in the next entry.
        if (/^[RC]/.test(entry)) {
            i += 1;
        }
    }
    return out;
};

// A worktree an earlier turn made, named by chat metadata (untrusted): continued
// only if it is this repo's, at the path createWorktree gives its branch, and
// still on that branch. Anything else gets a fresh worktree.
export const reopenWorktree = async (cwd: string, wt: Worktree): Promise<boolean> => {
    if (!/^ai\/[a-z0-9-]+$/.test(wt.branch)) {
        return false;
    }
    const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const root = top.code === 0 ? path.normalize(top.stdout.trim()) : "";
    if (!root || root !== path.normalize(wt.root)) {
        return false;
    }
    const expected = path.join(path.dirname(root), `${path.basename(root)}.worktrees`, wt.branch.slice(3));
    if (path.normalize(wt.path) !== expected || !fs.existsSync(expected)) {
        return false;
    }
    const head = await git(expected, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return head.code === 0 && head.stdout.trim() === wt.branch;
};

// Uncommitted edits AND new files, against the commit the worktree started from.
// `git diff main...branch` shows nothing here: the agent does not commit.
export const worktreeDiff = async (wt: { path: string; baseSha: string }, stat = true, maxBufferMB = 16): Promise<string> => {
    await git(wt.path, ["add", "-N", "."]);
    const out = await git(wt.path, ["diff", ...(stat ? ["--stat"] : []), wt.baseSha], 30000, maxBufferMB);
    return out.stdout.trim();
};

/** A file the worktree changed against its base: Added, Modified or Deleted. */
export interface ChangedFile {
    path: string;
    status: "A" | "M" | "D";
}

// The same changes as worktreeDiff, per file, for VS Code's multi-file diff.
export const changedFiles = async (wt: { path: string; baseSha: string }, maxBufferMB = 16): Promise<ChangedFile[]> => {
    await git(wt.path, ["add", "-N", "."]);
    const out = await git(wt.path, ["-c", "core.quotepath=false", "diff", "--name-status", "--no-renames", "-z", wt.baseSha], 30000, maxBufferMB);
    if (out.code !== 0) {
        return [];
    }
    const parts = out.stdout.split("\0");
    const files: ChangedFile[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
        const code = parts[i].charAt(0);
        if (parts[i + 1]) {
            files.push({ path: parts[i + 1], status: code === "A" ? "A" : code === "D" ? "D" : "M" });
        }
    }
    return files;
};

// A file as the base commit has it, for the diff's left side. The URI that
// names it is untrusted: a commit id only, a folder that is a git worktree, and
// `<sha>:<path>` as one argument (git reads no option from it).
export const baseText = async (wtPath: string, base: string, rel: string): Promise<string> => {
    if (!/^[0-9a-f]{7,64}$/.test(base) || !rel || !fs.existsSync(path.join(wtPath, ".git"))) {
        return "";
    }
    const out = await git(wtPath, ["show", `${base}:${rel}`], 30000, 16);
    return out.code === 0 ? out.stdout : "";
};

/** A `/worktree` worktree as git lists it: `changed` uncommitted entries, `commits` its branch has past the fork point. */
export interface ListedWorktree {
    path: string;
    branch: string;
    base: string;
    changed: number;
    commits: number;
}

const sameDir = (a: string, b: string): boolean => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

// This repo's `/worktree` worktrees: `ai/*` branches checked out under
// `<repo>.worktrees/`, never another worktree of the repo. The base is where the
// branch forked from the checkout's HEAD (the agent does not commit, so its work
// is uncommitted there). Undefined outside a git repository.
export const listWorktrees = async (cwd: string): Promise<{ root: string; worktrees: ListedWorktree[] } | undefined> => {
    const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) {
        return undefined;
    }
    const root = path.normalize(top.stdout.trim());
    const parent = path.join(path.dirname(root), `${path.basename(root)}.worktrees`);
    const list = await git(root, ["worktree", "list", "--porcelain"]);
    const worktrees: ListedWorktree[] = [];
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
        const fork = await git(root, ["merge-base", "HEAD", branch]);
        const head = fork.code === 0 ? fork : await git(wtPath, ["rev-parse", "HEAD"]);
        const base = head.stdout.trim();
        const ahead = base ? await git(root, ["rev-list", "--count", `${base}..${branch}`]) : undefined;
        worktrees.push({
            path: wtPath,
            branch,
            base,
            changed: (await uncommittedPaths(wtPath)).length,
            commits: ahead?.code === 0 ? Number(ahead.stdout.trim()) || 0 : 0
        });
    }
    return { root, worktrees };
};

/** "2 uncommitted · 1 commit", or "no changes": what a worktree holds that the checkout does not. */
export const worktreeChanges = (wt: ListedWorktree): string =>
    [wt.changed ? `${wt.changed} uncommitted` : "", wt.commits ? `${wt.commits} commit${wt.commits === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || "no changes";

export const removeWorktree = async (root: string, wtPath: string, branch: string): Promise<GitResult> => {
    const rm = await git(root, ["worktree", "remove", "--force", wtPath], 60000);
    if (rm.code === 0) {
        await git(root, ["branch", "-D", branch]);
    }
    return rm;
};
