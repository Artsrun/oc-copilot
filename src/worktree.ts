// `/worktree <task>` — opt-in isolation.
//
// The default is cooperative: @opencode edits the checkout you and Copilot are
// already in. `/worktree` is the explicit exception: a fresh git worktree + branch
// NEXT TO the repo (never inside it — Rule 5), so the run cannot touch your
// checkout. What it guarantees and what it does not is stated once, here, and
// echoed in the README under the same claim tag.
//
// claim:worktree-command
// GUARANTEES: a new worktree at <parent>/<repo>.worktrees/<slug> on branch
//   ai/<slug>, created from your current HEAD; the dev run's cwd and --dir are
//   that folder, so tracked files in your checkout are not written.
// DOES NOT: commit; copy untracked files (.env, node_modules); separate ports or
//   OpenCode's global session store; merge anything back.
//
// Git is run with execFile and an argument array — no shell, and the only
// user-derived argument (the slug) is reduced to [a-z0-9-]. This is not an
// OpenCode process, so Rule 3 (spawnOpenCode) does not apply; the BF tripwire
// pins execFile to this file and forbids enabling a shell.

import { execFile } from "node:child_process";
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

export type WorktreeResult = { ok: true; worktree: Worktree } | { ok: false; reason: string };

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
    const slug = `${slugify(task)}-${stampSlug()}`;
    const branch = `ai/${slug}`;
    const wtPath = path.join(path.dirname(root), `${path.basename(root)}.worktrees`, slug);
    const add = await git(root, ["worktree", "add", "-b", branch, wtPath, "HEAD"], 120000);
    if (add.code !== 0) {
        return { ok: false, reason: `git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}` };
    }
    return {
        ok: true,
        worktree: { root, path: wtPath, branch, baseRef: ref.stdout.trim() || "HEAD", baseSha: sha.stdout.trim() }
    };
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
