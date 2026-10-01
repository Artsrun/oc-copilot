#!/usr/bin/env bash
# OpenCode Copilot Bridge — macOS helper.
#
#   ./scripts/mac-setup.sh install            install the newest dist/*.vsix into VS Code
#   ./scripts/mac-setup.sh doctor             check everything the extension needs on this Mac
#   ./scripts/mac-setup.sh set-executable     pin opencodeCopilotBridge.executable to an absolute path
#   ./scripts/mac-setup.sh parallel "TASK"    start-parallel-agents.sh with macOS `code` resolution
#
# Written for the bash 3.2 that ships with macOS: no mapfile, no ${x,,},
# no `readlink -f`, no GNU-only flags.
#
# The macOS trap this exists for: VS Code started from the Dock or Spotlight does
# NOT inherit your shell's PATH. `opencode` installed via Homebrew
# (/opt/homebrew/bin) or npm under nvm resolves in Terminal and is missing inside
# VS Code, so every chat turn fails with "Couldn't launch OpenCode". The fix is an
# absolute path in `opencodeCopilotBridge.executable` — `set-executable` writes it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SETTING="opencodeCopilotBridge.executable"
PORT="${OPENCODE_PORT:-4096}"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

require_macos() {
  if [ "$(uname -s)" != "Darwin" ] && [ "${OCB_ALLOW_NON_MAC:-}" != "1" ]; then
    die "this script is for macOS (use start-parallel-agents.sh / .ps1 elsewhere)"
  fi
}

# `code` is only on PATH after "Shell Command: Install 'code' command in PATH".
# Fall back to the CLI inside the app bundle (Stable, then Insiders).
find_code() {
  if command -v code >/dev/null 2>&1; then command -v code; return 0; fi
  for app in \
    "/Applications/Visual Studio Code.app" \
    "$HOME/Applications/Visual Studio Code.app" \
    "/Applications/Visual Studio Code - Insiders.app" \
    "$HOME/Applications/Visual Studio Code - Insiders.app"; do
    for bin in "$app/Contents/Resources/app/bin/code" "$app/Contents/Resources/app/bin/code-insiders"; do
      if [ -x "$bin" ]; then printf '%s\n' "$bin"; return 0; fi
    done
  done
  return 1
}

# Where VS Code keeps user settings for the edition `find_code` picked.
settings_file() {
  case "$1" in
    *Insiders*) printf '%s\n' "$HOME/Library/Application Support/Code - Insiders/User/settings.json" ;;
    *)          printf '%s\n' "$HOME/Library/Application Support/Code/User/settings.json" ;;
  esac
}

# Resolve opencode the way a login shell would, then the usual install spots.
find_opencode() {
  if command -v opencode >/dev/null 2>&1; then command -v opencode; return 0; fi
  for bin in \
    /opt/homebrew/bin/opencode \
    /usr/local/bin/opencode \
    "$HOME/.opencode/bin/opencode" \
    "$HOME/.bun/bin/opencode" \
    "$HOME/.npm-global/bin/opencode"; do
    if [ -x "$bin" ]; then printf '%s\n' "$bin"; return 0; fi
  done
  # nvm: newest node version that has it
  if [ -d "$HOME/.nvm/versions/node" ]; then
    found="$(ls -1d "$HOME"/.nvm/versions/node/*/bin/opencode 2>/dev/null | tail -n 1 || true)"
    if [ -n "$found" ] && [ -x "$found" ]; then printf '%s\n' "$found"; return 0; fi
  fi
  return 1
}

# npm's shim is a symlink into the package; VS Code handles either, but the
# resolved file is what `opencode --version` actually runs.
resolve_link() {
  target="$1"
  while [ -L "$target" ]; do
    link="$(readlink "$target")"
    case "$link" in
      /*) target="$link" ;;
      *)  target="$(cd "$(dirname "$target")" && cd "$(dirname "$link")" && pwd)/$(basename "$link")" ;;
    esac
  done
  printf '%s\n' "$target"
}

newest_vsix() {
  ls -1t "$REPO_DIR"/dist/*.vsix 2>/dev/null | head -n 1 || true
}

cmd_install() {
  require_macos
  code_bin="$(find_code)" || die "VS Code not found. Install it, or run 'Shell Command: Install code command in PATH'."
  vsix="${1:-$(newest_vsix)}"
  [ -n "$vsix" ] && [ -f "$vsix" ] || die "no .vsix found in dist/ (build one with: npm run ship && npx vsce package --out dist/)"
  printf 'Installing %s\n  into %s\n' "$(basename "$vsix")" "$code_bin"
  "$code_bin" --install-extension "$vsix" --force
  ok "installed — reload VS Code windows (Developer: Reload Window)"
  if ! "$code_bin" --list-extensions 2>/dev/null | grep -qi "opencode-copilot"; then
    warn "could not confirm the install via --list-extensions; check the Extensions view"
  fi
  printf '\nNext: ./scripts/mac-setup.sh doctor\n'
}

cmd_set_executable() {
  require_macos
  code_bin="$(find_code)" || die "VS Code not found"
  oc="${1:-}"
  if [ -z "$oc" ]; then oc="$(find_opencode)" || die "opencode not found — install with: brew install sst/tap/opencode  (or npm i -g opencode-ai)"; fi
  [ -x "$oc" ] || die "not executable: $oc"
  file="$(settings_file "$code_bin")"
  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || printf '{}\n' > "$file"
  # settings.json is JSONC. Only rewrite it when it parses as plain JSON;
  # otherwise print the line rather than risk mangling comments.
  if command -v node >/dev/null 2>&1 && node -e '
      const fs = require("fs"); const [file, key, val] = process.argv.slice(1);
      let j; try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(3); }
      fs.copyFileSync(file, file + ".bak-opencode-bridge");
      j[key] = val; fs.writeFileSync(file, JSON.stringify(j, null, 4) + "\n");
    ' "$file" "$SETTING" "$oc"; then
    ok "wrote \"$SETTING\": \"$oc\""
    ok "backup: $file.bak-opencode-bridge"
  else
    warn "settings.json has comments or node is missing — add this line yourself:"
    printf '\n    "%s": "%s",\n\n  in %s\n' "$SETTING" "$oc" "$file"
  fi
}

cmd_doctor() {
  require_macos
  printf 'OpenCode Copilot Bridge — macOS doctor\n\n'
  status=0

  if code_bin="$(find_code)"; then ok "VS Code CLI: $code_bin"; else bad "VS Code CLI not found"; status=1; fi

  if oc="$(find_opencode)"; then
    real="$(resolve_link "$oc")"
    ver="$("$oc" --version 2>/dev/null || true)"
    ok "opencode: $oc${ver:+ ($ver)}"
    [ "$real" != "$oc" ] && ok "  resolves to $real"
  else
    bad "opencode not found — brew install sst/tap/opencode  (or npm i -g opencode-ai)"; status=1
  fi

  # The Dock-launched PATH is launchd's, not your shell's.
  gui_path="$(launchctl getenv PATH 2>/dev/null || true)"
  [ -z "$gui_path" ] && gui_path="/usr/bin:/bin:/usr/sbin:/sbin"
  if [ -n "${oc:-}" ]; then
    oc_dir="$(dirname "$oc")"
    case ":$gui_path:" in
      *":$oc_dir:"*) ok "opencode is on the PATH a Dock-launched VS Code sees" ;;
      *) warn "a Dock-launched VS Code will NOT find $oc_dir on its PATH"
         warn "  fix: ./scripts/mac-setup.sh set-executable   (or start VS Code with 'code .' from Terminal)" ;;
    esac
  fi

  if [ -n "${code_bin:-}" ]; then
    file="$(settings_file "$code_bin")"
    if [ -f "$file" ] && grep -q "\"$SETTING\"" "$file"; then
      pinned="$(grep "\"$SETTING\"" "$file" | head -n 1 | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/')"
      if [ -x "$pinned" ]; then ok "$SETTING = $pinned"; else bad "$SETTING points at a missing file: $pinned"; status=1; fi
    else
      warn "$SETTING not set (fine if VS Code is always started from Terminal)"
    fi
    if "$code_bin" --list-extensions 2>/dev/null | grep -qi "opencode-copilot"; then
      ok "extension installed"
    else
      warn "extension not installed — ./scripts/mac-setup.sh install"
    fi
  fi

  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    who="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | awk 'NR==2{print $1" (pid "$2")"}')"
    if curl -fsS "http://127.0.0.1:$PORT/global/health" >/dev/null 2>&1; then
      ok "port $PORT: healthy OpenCode server — $who (the bridge adopts it)"
    else
      bad "port $PORT is taken by $who and is not OpenCode — set opencodeCopilotBridge.serverPort"; status=1
    fi
  else
    ok "port $PORT free (the bridge starts 'opencode serve' on first use)"
  fi

  logdir="$HOME/.local/share/opencode/log"
  if [ -d "$logdir" ]; then
    latest="$(ls -1t "$logdir" 2>/dev/null | head -n 1 || true)"
    ok "OpenCode logs: $logdir${latest:+ (newest: $latest)}"
  fi

  if [ -n "${oc:-}" ]; then
    printf '\nTiming a model-free call (cold boot cost of every non-attached run):\n'
    start=$(date +%s)
    "$oc" --version >/dev/null 2>&1 || true
    "$oc" models >/dev/null 2>&1 || warn "'opencode models' failed — check provider auth: opencode auth login"
    end=$(date +%s)
    ok "opencode models: $((end - start))s"
  fi

  printf '\n'
  if [ "$status" -eq 0 ]; then ok "all required checks passed"; else bad "fix the ✗ items above"; fi
  return "$status"
}

cmd_parallel() {
  require_macos
  [ $# -gt 0 ] || die 'usage: mac-setup.sh parallel [--base REF] "TASK"'
  if ! command -v code >/dev/null 2>&1; then
    code_bin="$(find_code)" || die "VS Code not found"
    # start-parallel-agents.sh calls plain `code`; put the bundle's CLI first.
    PATH="$(dirname "$code_bin"):$PATH"; export PATH
  fi
  command -v opencode >/dev/null 2>&1 || { oc="$(find_opencode)" && PATH="$(dirname "$oc"):$PATH" && export PATH; } \
    || die "opencode not found"
  exec "$SCRIPT_DIR/start-parallel-agents.sh" "$@"
}

usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; }

case "${1:-}" in
  install)        shift; cmd_install "$@" ;;
  doctor)         shift; cmd_doctor "$@" ;;
  set-executable) shift; cmd_set_executable "$@" ;;
  parallel)       shift; cmd_parallel "$@" ;;
  -h|--help|help|"") usage ;;
  *) usage >&2; exit 2 ;;
esac
