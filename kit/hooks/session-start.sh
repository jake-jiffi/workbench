#!/bin/bash
# workbench SessionStart hook (matcher startup|clear). Reads the hook JSON on stdin (source, cwd).
#  1. startup in an empty, eligible folder: create a workspace there (workbench init) and print a short brief.
#  2. inside a workspace: print the status (apps fetched, PRs, what to look at). Output becomes session context.
#  3. startup in an existing project (a folder directly inside a project root, ~/dev by default) with no workspace:
#     brief Claude to set one up beside it, in <root>/workspaces/<name>. The hook itself changes no file.
#  4. anywhere else: print nothing, fast.
# Every start also hands `workbench update --if-due` to the background: at most once a day it fast-forwards the
# install, and it never delays or fails the session. Off: WORKBENCH_AUTOUPDATE=0 or "autoUpdate": false.
# It never fails the session: every path exits 0.
# Off switches: WORKBENCH_AUTO=0, or "autoInit": false (anything but true) in the private config. Existing projects
# alone: "adoptExisting": false, "projectRoots": [], or the project's path on its own line in <config dir>/adopt-skip.
# Regression suite: test-session-start.sh beside this file.
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd) || exit 0
. "$here/../lib/common.sh" 2>/dev/null || exit 0
. "$here/../lib/status.sh" 2>/dev/null || exit 0
[ -n "${WORKBENCH_HOME:-}" ] || WORKBENCH_HOME=$(cd "$here/../.." 2>/dev/null && pwd -P)
export WORKBENCH_HOME

brief() { # brief <root> <init output>
  local text mods=""
  case "$2" in *"marketplace: "*registered*) mods=" The workspace's own mods marketplace (mods/) is registered." ;; esac
  text="workbench just turned this empty folder ($1) into a workspace, before the owner's first message. You are its orchestrator.
1. Read $1/CLAUDE.md now and follow it: it did not load at session start. Then read notes/STATE.md and .claude/memory/MEMORY.md.
2. Open your first reply with a short welcome (four lines at most): the workspace is ready; you are the one session they talk to, with builders on their own worktrees; /workbench opens the live pane; the guard hooks and the left-undone gate are on.
3. Offer the next step: connect a repo with \`workbench add-app <owner/repo>\`, or describe the project and you will plan it.
4. Mention once that the shared memory folder and project settings load from the next session, so a restart here (or /clear) picks them up. The pane, guard hooks and left-undone tools already work.
Created: workbench.json, CLAUDE.md, AGENTS.md, apps/, ops/, worktrees/, stacks/, data/ (mode 700), notes/ (STATE.md, specs, briefs, archive), mods/, .claude/ (memory with six seed rules, builder and critic agents, left-undone-review skill, settings), .codex/ and .agents/ (Codex parity).$mods"
  jq -n --arg c "$text" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}'
}

auto_init() { # auto_init <physical dir>
  local d=$1 lock sum out rc w
  sum=$(printf '%s' "$d" | cksum | cut -d' ' -f1)
  lock="${TMPDIR:-/tmp}/workbench-init-$sum.lock"
  lock=${lock//\/\//\/}
  if ! wb_lock "$lock" 0; then
    # Another session is creating the workspace right now: wait for its marker, then show status.
    w=0; while [ "$w" -lt 75 ]; do [ -f "$d/workbench.json" ] && break; w=$((w + 1)); sleep 0.2; done
    [ -f "$d/workbench.json" ] && wb_status "$d"
    return 0
  fi
  trap 'wb_unlock "$lock"' EXIT
  # Re-check under the lock: the folder may have changed since the first look.
  if wb_eligible "$d"; then
    out=$("$here/../bin/workbench" init "$d" --quiet 2>/dev/null); rc=$?
    [ "$rc" = 0 ] && brief "$d" "$out"
  fi
  wb_unlock "$lock"; trap - EXIT
  return 0
}

# ---- existing projects ----
adopt_slug() { # owner/repo from a git url or path, the way `workbench add-app` records it
  local s=${1%/}; s=${s%.git}
  case "$s" in *://*|*@*:*) s=${s#*://}; s=${s#*@}; s=${s#*:}; s=${s#*/} ;; esac
  case "$s" in */*) printf '%s/%s' "$(basename "$(dirname "$s")")" "$(basename "$s")" ;; *) printf '%s' "$s" ;; esac
}
adopt_roots() { # the project roots, one per line: "projectRoots" in the config, default ~/dev
  jq -r 'if (.projectRoots|type) == "array" then .projectRoots[] else "~/dev" end' "$(wb_cfg_file)" 2>/dev/null \
    || printf '%s\n' "~/dev"
}
adopt_say() { jq -n --arg c "$1" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}'; }

# adopt_brief <physical dir>: an existing project with no workspace gets a brief, nothing else. Silent otherwise.
adopt_brief() {
  local phys=$1 proj r rp root="" name ws_p origin sl f hit="" dirty ahead br ws n own="" who
  jq -e '.adoptExisting == false' "$(wb_cfg_file)" >/dev/null 2>&1 && return 0
  case "${CLAUDE_CODE_ENTRYPOINT:-}" in sdk*) return 0 ;; esac          # scripted runs aren't someone starting a project
  proj=$(git -C "$phys" rev-parse --show-toplevel 2>/dev/null) && proj=$(wb_physical "$proj")
  [ -n "$proj" ] || proj=$phys
  [ -n "$(find "$proj" -mindepth 1 -maxdepth 1 ! -name .DS_Store 2>/dev/null | head -n 1)" ] || return 0   # empty: auto-init's job
  while IFS= read -r r; do
    case "$r" in "~") r=$HOME ;; "~/"*) r="$HOME/${r#\~/}" ;; esac
    rp=$(wb_physical "$r"); [ -n "$rp" ] || continue
    [ "${proj%/*}" = "$rp" ] && { root=$rp; break; }
  done < <(adopt_roots)
  [ -n "$root" ] || return 0
  name=${proj##*/}; ws_p="$root/workspaces"
  case "$name" in .*|workspaces) return 0 ;; esac
  grep -qxF "$proj" "$(dirname "$(wb_cfg_file)")/adopt-skip" 2>/dev/null && return 0
  who=$(wb_cfg_get '.owner' "the owner")
  local skip="To leave this project out for good, add its path as one line to $(dirname "$(wb_cfg_file)")/adopt-skip."

  if [ "$(git -C "$proj" rev-parse --is-inside-work-tree 2>/dev/null)" = true ]; then
    origin=$(git -C "$proj" remote get-url origin 2>/dev/null)
    if [ -z "$origin" ]; then
      adopt_say "workbench: $proj is a git repo with no origin remote, so it can't join a workspace yet. In your first reply, say so in one line and ask $who whether to put it on GitHub first, and under which account or organisation. Don't create a repo or a workspace yourself. $skip"
      return 0
    fi
    sl=$(adopt_slug "$origin")
    for f in "$ws_p"/*/workbench.json; do
      [ -f "$f" ] || continue
      jq -e --arg s "$sl" '[.apps[]? | select(.repo == $s)] | length > 0' "$f" >/dev/null 2>&1 && { hit=${f%/workbench.json}; break; }
    done
    if [ -n "$hit" ]; then
      adopt_say "workbench: this project already has a workspace at $hit (app $sl). Tell $who in one line that the orchestrator, builders and guards run there: cd \"$hit\" && claude. Then carry on here if they want."
      return 0
    fi
    dirty=$(wb_timeout 5 git -C "$proj" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    ahead=$(git -C "$proj" rev-list --count '@{u}..HEAD' 2>/dev/null) || ahead="an unknown number of"
    br=$(git -C "$proj" branch --show-current 2>/dev/null)
    ws="$ws_p/$name"; n=2; while [ -e "$ws" ]; do ws="$ws_p/$name-$n"; n=$((n + 1)); done
    case "$origin" in *github.com*) origin=$sl ;; esac
    adopt_say "workbench isn't set up for this project yet ($proj, origin $sl). Every project runs on workbench, so do this first, before anything $who asks, without asking:
1. workbench init \"$ws\" --quiet
2. cd \"$ws\" && workbench add-app $origin --name $name
Leave $proj exactly as it is: don't move, delete, commit or push anything in it.
3. It has $dirty uncommitted file(s) and $ahead unpushed commit(s) on branch ${br:-(detached)}. The new checkout only has what is on origin. If either isn't 0, tell $who plainly. Don't commit or push them yourself.
4. If a step fails, show the exact error and stop the setup, then help with the request here.
5. When it worked, tell $who in two lines that the workspace is at $ws, and that the orchestrator, its memory and the guard hooks load only after they quit and run: cd \"$ws\" && claude. Then do the request here, or wait for the restart if they prefer.
$skip If this is a scripted or non-interactive run, ignore this note."
    return 0
  fi

  [ -f "$proj/CLAUDE.md" ] && own=" It already has a CLAUDE.md, which init keeps, so the orchestrator playbook won't be written. Say so and ask whether to merge the two."
  adopt_say "workbench isn't set up for this folder yet ($proj, no git). Every project runs on workbench, so first, without asking, run: workbench init \"$proj\" --force --quiet. It only adds missing files beside the ones here and never overwrites one.$own Then read $proj/CLAUDE.md and follow it, and tell $who in one line that the shared memory and project settings load from the next session (a restart or /clear). $skip If this is a scripted or non-interactive run, ignore this note."
}

main() {
  command -v jq >/dev/null 2>&1 || return 0
  [ "${WORKBENCH_AUTOUPDATE:-1}" = 0 ] || ( nohup "$here/../bin/workbench" update --if-due --quiet </dev/null >/dev/null 2>&1 & )
  local input parsed src cwd phys root
  input=$(cat)
  parsed=$(printf '%s' "$input" | jq -r '(.source // ""), (.cwd // "")' 2>/dev/null) || return 0
  src=${parsed%%$'\n'*}
  case "$parsed" in *$'\n'*) cwd=${parsed#*$'\n'} ;; *) cwd="" ;; esac
  [ -z "$cwd" ] && cwd=$PWD
  phys=$(wb_physical "$cwd"); [ -n "$phys" ] || return 0
  root=$(wb_find_root "$phys")
  if [ -n "$root" ]; then
    case "$src" in startup|clear|"") wb_status "$root" ;; esac
    return 0
  fi
  [ "$src" = startup ] || return 0
  [ "${WORKBENCH_AUTO:-1}" = 0 ] && return 0
  jq -e '.autoInit == true' "$(wb_cfg_file)" >/dev/null 2>&1 || return 0
  if wb_eligible "$phys"; then auto_init "$phys"; else adopt_brief "$phys"; fi
}
main 2>/dev/null
exit 0
