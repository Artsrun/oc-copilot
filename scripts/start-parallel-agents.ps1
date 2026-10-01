# claim:worktrees
# GUARANTEES: two git worktrees + branches (ai/opencode, ai/copilot) from one base
#   commit — the `git worktree add -b` lines below. Tracked files edited in one
#   cannot touch the other or your checkout. Refuses to reuse an existing folder.
# DOES NOT: commit; copy untracked files (.env, node_modules); separate ports or
#   OpenCode's global session store; send the task to Copilot; diff or merge.
#   Review:  git -C <worktree> add -N . && git -C <worktree> diff <base>
#   Debug:   Set-PSDebug -Trace 1; .\scripts\start-parallel-agents.ps1 -Task "task"; git worktree list
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string] $Task,

    [string] $BaseRef = "",
    [string] $OpenCodeBranch = "ai/opencode",
    [string] $CopilotBranch = "ai/copilot",
    [string] $OpenCodeDirectory = "",
    [string] $CopilotDirectory = ""
)

$ErrorActionPreference = "Stop"

$root = (git rev-parse --show-toplevel).Trim()
if (-not $root) {
    throw "Run this script from inside a Git repository."
}

if (-not $BaseRef) {
    $BaseRef = (git -C $root rev-parse HEAD).Trim()
}

$repoName = Split-Path -Leaf $root
$parent = Split-Path -Parent $root
if (-not $OpenCodeDirectory) {
    $OpenCodeDirectory = Join-Path $parent "$repoName-opencode"
}
if (-not $CopilotDirectory) {
    $CopilotDirectory = Join-Path $parent "$repoName-copilot"
}

foreach ($directory in @($OpenCodeDirectory, $CopilotDirectory)) {
    if (Test-Path $directory) {
        throw "Worktree directory already exists: $directory"
    }
}

git -C $root worktree add -b $OpenCodeBranch $OpenCodeDirectory $BaseRef
git -C $root worktree add -b $CopilotBranch $CopilotDirectory $BaseRef

Start-Process -FilePath "opencode" `
    -ArgumentList @("run", "--agent", "build", "--auto", $Task) `
    -WorkingDirectory $OpenCodeDirectory
Start-Process -FilePath "code" `
    -ArgumentList @("--new-window", $CopilotDirectory) `
    -WorkingDirectory $CopilotDirectory

Write-Host "OpenCode worktree: $OpenCodeDirectory ($OpenCodeBranch)"
Write-Host "Copilot worktree:  $CopilotDirectory ($CopilotBranch)"
Write-Host ""
Write-Host "Give Copilot the task in the new window. Review each side (includes new files):"
Write-Host "  git -C `"$OpenCodeDirectory`" add -N . ; git -C `"$OpenCodeDirectory`" diff $BaseRef"
Write-Host "  git -C `"$CopilotDirectory`" add -N . ; git -C `"$CopilotDirectory`" diff $BaseRef"
