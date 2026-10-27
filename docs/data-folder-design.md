# OpenCode 1's own data folder — design note

Dated 2026-10-27 (0.0.227). Status: **not built**. The bridge was switched to
`opencode2` on this machine instead; this note is the fix for when a 1.x is
needed again.

## The problem, measured

- OpenCode 1.19.3 cannot open an `opencode.db` that OpenCode 2 created: every
  spawn exits with "Database is not empty and has no session table" (REFS,
  0.0.224). 0.0.225 refuses before spawning (`dataFolderRefusal`).
- Both majors default to the same folder, `~/.local/share/opencode`. Here it
  holds 2.x's database (15 MB, written 2026-10-27).
- A 1.x folder already exists: `~/.opencode1/data/opencode`, created
  2026-10-20 by a VS Code started with `XDG_DATA_HOME` set; 1.19.3 served from
  it ("answered after 4.0s"). Started without it (unset for user, machine and
  process), 1.x fell back to 2.x's folder and was refused.
- Nothing in the bridge can point only its own processes elsewhere:
  `spawnOpenCode` passes `process.env` through (`src/proc.ts`, plus `PWD` and
  `OPENCODE_CONFIG_CONTENT`).

## Options

| Option | Works | Cost |
| --- | --- | --- |
| Start VS Code with `XDG_DATA_HOME` | today | every launch; forgotten once, refused |
| `XDG_DATA_HOME` user-wide | always | moves OpenCode 2 (and other XDG tools) too; 2.x's history stays behind |
| `dataHome` setting (below) | after one release | small; 2.x untouched |
| `opencode2` (chosen 2026-10-27) | now | experimental; installed 2.x is 2.0.18, below the tested 2.0.29–2.0.32 |

## Design: `opencodeCopilotBridge.dataHome`

1. **Setting**: string, default `""` (Rule 4: `package.json`, the suite's
   base `settings`, same default). Empty: the host's environment, unchanged.
2. **Spawn**: `spawnOpenCode` sets `XDG_DATA_HOME` to the setting, `~/`
   expanded as for `executable`, for every process it starts: `serve`, `run`,
   `models`, `agent list`, `--version`. One place, so no path forgets it (Rule 3).
3. **Clash memory**: changing `dataHome` clears the remembered refusal for
   every executable, as `/ping` does (`forgetDataFolderClash`); otherwise the
   refusal outlives the fix.
4. **Words**: the refusal (`net.ts`, `run-cli.ts`) names the setting instead
   of "close VS Code and start it with `XDG_DATA_HOME`".
5. **Adopted servers**: a server another window started keeps its own folder,
   which the bridge cannot see. It is adopted as today; the README says so.
6. **Rule 5 holds**: the folder is the user's, outside the workspace; the
   bridge never creates it.

### Checks and probe

- The fake records `XDG_DATA_HOME` beside `PWD` (`writeFake`): the managed
  `serve`, a cold `run` and `--version` receive the setting; empty passes the
  host's value through; a changed setting lifts a remembered clash.
- Probe: real 1.19.3 with `dataHome` on a fresh temp folder while the default
  folder holds a 2.x database — the turn runs, nothing is refused.
- Mutants: drop the env line (spawn checks red); skip the clear on change (the
  clash check red).

## If `opencode2` does not hold

Run `scripts/probe-opencode2.js` against the installed 2.x first. Below the
tested range, the cheaper fix may be moving 2.x into it (2.0.29–2.0.32); if
1.x is needed instead, build `dataHome` as above.
