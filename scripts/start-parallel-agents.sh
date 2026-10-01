#!/usr/bin/env bash
# claim:worktrees
# GUARANTEES: two git worktrees + branches (ai/opencode, ai/copilot) from one base
#   commit — the `git worktree add -b` lines below. Tracked files edited in one
#   cannot touch the other or your checkout. Refuses to reuse an existing folder.
# DOES NOT: commit; copy untracked files (.env, node_modules); separate ports or
#   OpenCode's global session store; send the task to Copilot; diff or merge.
#   Review:  git -C <worktree> add -N . && git -C <worktree> diff <base>
#   Debug:   bash -x scripts/start-parallel-agents.sh "task"; git worktree list
set -euo pipefail

usage() {
  printf 'Usage: %s [--base REF] [--opencode-branch BRANCH] [--copilot-branch BRANCH] TASK\n' "$0"
}

BASE_REF=""
OPENCODE_BRANCH="ai/opencode"
COPILOT_BRANCH="ai/copilot"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --base) BASE_REF="$2"; shift 2 ;;
    --opencode-branch) OPENCODE_BRANCH="$2"; shift 2 ;;
    --copilot-branch) COPILOT_BRANCH="$2"; shift 2 ;;
    --) shift; break ;;
    -*) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
    *) break ;;
  esac
done

if [[ $# -eq 0 ]]; then
  usage >&2
  exit 2
fi
TASK="$*"

ROOT="$(git rev-parse --show-toplevel)"
REPO_NAME="$(basename "$ROOT")"
PARENT="$(dirname "$ROOT")"
BASE_REF="${BASE_REF:-$(git -C "$ROOT" rev-parse HEAD)}"
OPENCODE_DIR="${PARENT}/${REPO_NAME}-opencode"
COPILOT_DIR="${PARENT}/${REPO_NAME}-copilot"

for directory in "$OPENCODE_DIR" "$COPILOT_DIR"; do
  if [[ -e "$directory" ]]; then
    printf 'Worktree directory already exists: %s\n' "$directory" >&2
    exit 1
  fi
done

git -C "$ROOT" worktree add -b "$OPENCODE_BRANCH" "$OPENCODE_DIR" "$BASE_REF"
git -C "$ROOT" worktree add -b "$COPILOT_BRANCH" "$COPILOT_DIR" "$BASE_REF"

# --agent build: without it OpenCode runs the config's default_agent, and a
# default_agent of "plan" makes no edits. --auto: nobody is at this terminal to
# answer permission prompts for a background run.
(cd "$OPENCODE_DIR" && opencode run --agent build --auto "$TASK") &
code --new-window "$COPILOT_DIR" &

printf 'OpenCode worktree: %s (%s)\n' "$OPENCODE_DIR" "$OPENCODE_BRANCH"
printf 'Copilot worktree:  %s (%s)\n' "$COPILOT_DIR" "$COPILOT_BRANCH"
printf '\nGive Copilot the task in the new window. Review each side (includes new files):\n'
printf '  git -C "%s" add -N . && git -C "%s" diff %s\n' "$OPENCODE_DIR" "$OPENCODE_DIR" "$BASE_REF"
printf '  git -C "%s" add -N . && git -C "%s" diff %s\n' "$COPILOT_DIR" "$COPILOT_DIR" "$BASE_REF"
