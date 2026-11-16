#!/bin/bash
# workbench installer.
#   install.sh [--dry-run] [--no-plugin] [--config-dir D]...      install
#   install.sh --uninstall [--dry-run] [--no-plugin] [--config-dir D]...
#   install.sh --check [--no-plugin] [--config-dir D]...          run the install checks only
# Installs: ~/.workbench link (when the repo lives elsewhere), links for `workbench` and `claude-worker` in
# ~/.local/bin, the private config (once, never overwritten), the global hooks in each Claude config folder's
# settings.json (backed up first, idempotent, every other key kept), and the Claude Code plugin.
# Uninstall removes the hook entries, the links and the plugin. It keeps your config and every workspace.
# Test overrides: HOME, WORKBENCH_CONFIG, --config-dir, --bin-dir, --no-plugin.
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P) || exit 1
MODE=install; DRY=0; PLUGIN=1; CONFIG_DIRS=(); BIN_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) MODE=uninstall; shift ;;
    --check) MODE=check; shift ;;
    --dry-run) DRY=1; shift ;;
    --no-plugin) PLUGIN=0; shift ;;
    --config-dir) [ $# -ge 2 ] || { echo "install.sh: --config-dir needs a folder" >&2; exit 2; }; CONFIG_DIRS+=("${2%/}"); shift 2 ;;
    --bin-dir) [ $# -ge 2 ] || { echo "install.sh: --bin-dir needs a folder" >&2; exit 2; }; BIN_DIR=${2%/}; shift 2 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option $1 (try --help)" >&2; exit 2 ;;
  esac
done
[ -n "$BIN_DIR" ] || BIN_DIR="$HOME/.local/bin"
[ ${#CONFIG_DIRS[@]} -gt 0 ] || CONFIG_DIRS=("${CLAUDE_CONFIG_DIR:-$HOME/.claude}")
CFG_FILE="${WORKBENCH_CONFIG:-$HOME/.config/workbench/config.json}"
WB_LINK="$HOME/.workbench"
PROBLEMS=0
say() { echo "$*"; }
warn() { echo "warn: $*" >&2; }
bad() { echo "FAILED: $*" >&2; PROBLEMS=$((PROBLEMS + 1)); }
plan() { echo "  [dry-run] $*"; }
phys() { ( unset CDPATH; cd -P -- "$1" 2>/dev/null && pwd -P ); }
real_file() { # follow symlinks to the file that really holds the content
  local f=$1 d
  while [ -L "$f" ]; do d=$(cd "$(dirname "$f")" && pwd); f=$(readlink "$f"); case "$f" in /*) ;; *) f="$d/$f" ;; esac; done
  printf '%s' "$f"
}
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null; }

# ---- 1. requirements ----
say "Checking requirements"
command -v git >/dev/null 2>&1 && say "  ok   git" || bad "git is required"
command -v jq >/dev/null 2>&1 && say "  ok   jq" || bad "jq is required (brew install jq)"
if command -v node >/dev/null 2>&1; then
  nv=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
  if [ "${nv:-0}" -ge 20 ] 2>/dev/null; then say "  ok   node $nv"; else warn "node 20+ is needed for claude-worker (found ${nv:-unknown})"; fi
else warn "node not found: claude-worker needs node 20+"; fi
if command -v claude >/dev/null 2>&1; then say "  ok   claude"
else warn "claude not found: the plugin step is skipped"; PLUGIN=0; fi
command -v gh >/dev/null 2>&1 && say "  ok   gh" || warn "gh not found (optional: PR status and add-app by owner/repo use it)"
if [ "$PROBLEMS" -gt 0 ] && [ "$DRY" = 0 ]; then echo "Fix the above and run again." >&2; exit 1; fi
command -v jq >/dev/null 2>&1 || exit 1

# ---- where the hooks will point ----
link_ok=0
if [ "$(phys "$WB_LINK")" = "$REPO" ]; then link_ok=1; fi
if [ "$link_ok" = 0 ] && [ ! -e "$WB_LINK" ] && [ ! -L "$WB_LINK" ] && [ "$MODE" = install ]; then link_ok=1; fi
if [ "$link_ok" = 1 ]; then WBH="$WB_LINK"; else WBH="$REPO"; fi
CMD_SS="\"$WBH/kit/hooks/session-start.sh\""
CMD_GG="\"$WBH/kit/hooks/guard-git.sh\""
CMD_GR="\"$WBH/kit/hooks/guard-release.sh\""

OURS_RE='/kit/hooks/(session-start|guard-git|guard-release)\\.sh'
# strip our entries from a settings.json (stdin to stdout)
JQ_STRIP='
def ours: ((.command // "") | test("'"$OURS_RE"'"));
def strip: if type=="object" and ((.hooks|type)=="array") then ((.hooks|length) as $n | .hooks |= map(select(((type=="object") and ours)|not)) | if $n>0 and (.hooks|length)==0 then empty else . end) else . end;
(.hooks // {}) as $h0
| .hooks = ($h0 | with_entries(.value |= (if type=="array" then map(strip) else . end))
            | with_entries(select((.value|type)!="array" or (.value|length)>0 or (($h0[.key]|type)=="array" and ($h0[.key]|length)==0))))
| if (.hooks == {}) and (($h0|length) > 0) then del(.hooks) else . end'
JQ_ADD="$JQ_STRIP"'
| .hooks.SessionStart = ((.hooks.SessionStart // []) + [{matcher:"startup|clear", hooks:[{type:"command", command:$ss, timeout:30}]}])
| .hooks.PreToolUse = ((.hooks.PreToolUse // []) + [{matcher:"Bash", hooks:[{type:"command", command:$gg, timeout:10},{type:"command", command:$gr, timeout:15}]}])'

# settings_apply <config dir> <add|remove>
settings_apply() {
  local dir=$1 what=$2 sf real new cur ts bak mode
  sf="$dir/settings.json"; real=$(real_file "$sf")
  if [ ! -e "$real" ]; then
    if [ "$what" = remove ]; then say "  --   $sf does not exist: nothing to remove"; return 0; fi
    if [ "$DRY" = 1 ]; then plan "create $sf with the three hook entries"; return 0; fi
    mkdir -p "$(dirname "$real")" || { bad "cannot create $(dirname "$real")"; return 1; }
    echo '{}' > "$real"
  fi
  if ! jq -e 'type=="object" and ((has("hooks")|not) or (.hooks|type=="object" and ((.SessionStart // [])|type=="array") and ((.PreToolUse // [])|type=="array")))' "$real" >/dev/null 2>&1; then
    bad "$sf is not valid JSON or has an unexpected hooks shape: left untouched. Fix it, then run again."; return 1
  fi
  if [ "$what" = add ]; then
    new=$(jq --arg ss "$CMD_SS" --arg gg "$CMD_GG" --arg gr "$CMD_GR" "$JQ_ADD" "$real") || { bad "jq failed on $sf"; return 1; }
  else
    new=$(jq "$JQ_STRIP" "$real") || { bad "jq failed on $sf"; return 1; }
  fi
  cur=$(jq -S . "$real"); if [ "$(printf '%s' "$new" | jq -S .)" = "$cur" ]; then
    say "  ok   $sf already up to date"; return 0
  fi
  if [ "$DRY" = 1 ]; then plan "$what the hook entries in $sf (backup first)"; return 0; fi
  ts=$(date +%Y%m%d-%H%M%S); bak="$real.workbench-backup-$ts"
  [ -e "$bak" ] && bak="$bak-$$"
  cp -p "$real" "$bak" || { bad "cannot back up $sf"; return 1; }
  mode=$(mode_of "$real")
  printf '%s\n' "$new" > "$real.workbench-tmp.$$" || { bad "cannot write next to $sf"; return 1; }
  [ -n "$mode" ] && chmod "$mode" "$real.workbench-tmp.$$"
  mv "$real.workbench-tmp.$$" "$real" || { bad "cannot replace $sf"; return 1; }
  say "  done $what hooks in $sf (backup: $bak)"
}

claude_for() { # claude_for <config dir> args...: run claude against that config folder
  local dir=$1; shift
  if [ "$dir" = "$HOME/.claude" ]; then env -u CLAUDE_CONFIG_DIR claude "$@"; else CLAUDE_CONFIG_DIR="$dir" claude "$@"; fi
}
plugin_apply() { # plugin_apply <config dir> <add|remove>
  local dir=$1 what=$2 list
  [ "$PLUGIN" = 1 ] || return 0
  list=$(claude_for "$dir" plugin list 2>/dev/null)
  if [ "$what" = add ]; then
    case "$list" in *workbench@workbench*) say "  ok   plugin already installed ($dir)"; return 0 ;; esac
    if [ "$DRY" = 1 ]; then plan "claude plugin marketplace add \"$WBH\" ; claude plugin install workbench@workbench --scope user  ($dir)"; return 0; fi
    case "$(claude_for "$dir" plugin marketplace list 2>/dev/null)" in *workbench*) ;; *)
      claude_for "$dir" plugin marketplace add "$WBH" >/dev/null 2>&1 || { bad "claude plugin marketplace add failed ($dir)"; return 1; } ;;
    esac
    claude_for "$dir" plugin install workbench@workbench --scope user >/dev/null 2>&1 && say "  done plugin installed ($dir)" || bad "claude plugin install failed ($dir)"
  else
    case "$list" in *workbench@workbench*) ;; *) say "  --   plugin not installed ($dir)"; return 0 ;; esac
    if [ "$DRY" = 1 ]; then plan "claude plugin uninstall workbench@workbench ; claude plugin marketplace remove workbench  ($dir)"; return 0; fi
    claude_for "$dir" plugin uninstall workbench@workbench --scope user >/dev/null 2>&1 || warn "claude plugin uninstall failed ($dir)"
    claude_for "$dir" plugin marketplace remove workbench >/dev/null 2>&1
    say "  done plugin removed ($dir)"
  fi
}

# link_apply <name> <target> <add|remove>
link_apply() {
  local name=$1 target=$2 what=$3 dest="$BIN_DIR/$1" cur other
  if [ "$what" = remove ]; then
    if [ -L "$dest" ] && [ "$(real_file "$dest")" = "$target" ]; then
      [ "$DRY" = 1 ] && { plan "remove link $dest"; return 0; }
      rm -f "$dest" && say "  done removed $dest"
    else say "  --   $dest is not our link: left alone"; fi
    return 0
  fi
  if [ ! -e "$target" ]; then warn "$target does not exist yet: link for $name skipped"; return 0; fi
  if [ -L "$dest" ]; then
    cur=$(real_file "$dest")
    if [ "$cur" = "$target" ] || [ "$(phys "$(dirname "$cur")")/$(basename "$cur")" = "$target" ]; then say "  ok   $dest already linked"; return 0; fi
    warn "$dest already links to $cur: left alone, so $name is not linked"; return 0
  fi
  if [ -e "$dest" ]; then warn "$dest exists and is not our link: left alone"; return 0; fi
  other=$(PATH="${PATH}" command -v "$name" 2>/dev/null)
  if [ -n "$other" ]; then warn "'$name' already resolves to $other on PATH: not linking over it"; return 0; fi
  if [ "$DRY" = 1 ]; then plan "ln -s $target $dest"; return 0; fi
  mkdir -p "$BIN_DIR" && ln -s "$target" "$dest" && say "  done linked $dest" || bad "cannot link $dest"
}

home_link() { # home_link <add|remove>
  if [ "$1" = remove ]; then
    if [ -L "$WB_LINK" ] && [ "$(phys "$WB_LINK")" = "$REPO" ]; then
      [ "$DRY" = 1 ] && { plan "remove link $WB_LINK"; return 0; }
      rm -f "$WB_LINK" && say "  done removed $WB_LINK"
    else say "  --   $WB_LINK is not a link to this repo: left alone"; fi
    return 0
  fi
  if [ "$(phys "$WB_LINK")" = "$REPO" ]; then say "  ok   $WB_LINK is this repo"; return 0; fi
  if [ -e "$WB_LINK" ] || [ -L "$WB_LINK" ]; then warn "$WB_LINK exists and is not this repo: hooks will point at $REPO instead"; return 0; fi
  [ "$DRY" = 1 ] && { plan "ln -s $REPO $WB_LINK"; return 0; }
  ln -s "$REPO" "$WB_LINK" && say "  done linked $WB_LINK -> $REPO" || bad "cannot link $WB_LINK"
}

write_config() {
  if [ -e "$CFG_FILE" ]; then say "  ok   $CFG_FILE exists (never overwritten)"; return 0; fi
  local owner; owner=$(git config --get user.name 2>/dev/null | awk '{print $1}'); [ -n "$owner" ] || owner=$(id -un 2>/dev/null)
  [ "$DRY" = 1 ] && { plan "write $CFG_FILE (owner: $owner)"; return 0; }
  mkdir -p "$(dirname "$CFG_FILE")" || { bad "cannot create $(dirname "$CFG_FILE")"; return 1; }
  jq -n --arg o "$owner" '{owner:$o, autoInit:true, accounts:[{label:"main", dir:"~/.claude"}], protectedBranches:["main","staging"], models:{orchestrator:"opus", builder:"sonnet"}}' > "$CFG_FILE" \
    && say "  done wrote $CFG_FILE" || bad "cannot write $CFG_FILE"
}

run_check() {
  local args=() d f
  for d in "${CONFIG_DIRS[@]}"; do args+=(--config-dir "$d"); done
  [ "$PLUGIN" = 1 ] || args+=(--no-plugin)
  [ -e "$REPO/bin/claude-worker" ] || args+=(--skip worker)
  say "Checking the install"
  PATH="$BIN_DIR:$PATH" WORKBENCH_HOME="$WBH" "$REPO/kit/bin/workbench" doctor --global "${args[@]}"
}

[ "$DRY" = 1 ] && say "Dry run: nothing will be changed. Plan for '$MODE':"
case "$MODE" in
  check)
    run_check; exit $? ;;
  install)
    chmod +x "$REPO"/kit/hooks/*.sh "$REPO/kit/bin/workbench" "$REPO/bin/claude-worker" 2>/dev/null
    say "Links"; home_link add
    link_apply workbench "$REPO/kit/bin/workbench" add
    link_apply claude-worker "$REPO/bin/claude-worker" add
    case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "$BIN_DIR is not on your PATH. Add: export PATH=\"$BIN_DIR:\$PATH\"" ;; esac
    say "Private config"; write_config
    for d in "${CONFIG_DIRS[@]}"; do say "Claude config folder $d"; settings_apply "$d" add; plugin_apply "$d" add; done
    [ "$DRY" = 1 ] && exit 0
    run_check || PROBLEMS=$((PROBLEMS + 1))
    if [ "$PROBLEMS" = 0 ]; then say "Installed. Open a new Claude session; in an empty folder the workspace sets itself up."
    else echo "Installed with problems (see above)." >&2; exit 1; fi ;;
  uninstall)
    say "Claude config folders"
    for d in "${CONFIG_DIRS[@]}"; do say "  $d"; settings_apply "$d" remove; plugin_apply "$d" remove; done
    say "Links"
    link_apply workbench "$REPO/kit/bin/workbench" remove
    link_apply claude-worker "$REPO/bin/claude-worker" remove
    home_link remove
    say "Kept: $CFG_FILE and every workspace."
    [ "$PROBLEMS" = 0 ] || exit 1 ;;
esac
exit 0
