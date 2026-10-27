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
    const status = await git(root, ["status", "--porcelain"]);
    const uncommitted = status.code === 0 ? status.stdout.split("\n").filter((l) => l.trim()).length : 0;
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

export const removeWorktree = async (root: string, wtPath: string, branch: string): Promise<GitResult> => {
    const rm = await git(root, ["worktree", "remove", "--force", wtPath], 60000);
    if (rm.code === 0) {
        await git(root, ["branch", "-D", branch]);
    }
    return rm;
};
