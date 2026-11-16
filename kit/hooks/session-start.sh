#!/bin/bash
# workbench SessionStart hook (matcher startup|clear). Reads the hook JSON on stdin (source, cwd).
#  1. startup in an empty, eligible folder: create a workspace there (workbench init) and print a short brief.
#  2. inside a workspace: print the status (apps fetched, PRs, what to look at). Output becomes session context.
#  3. anywhere else: print nothing, fast.
# It never fails the session: every path exits 0.
# Off switches: WORKBENCH_AUTO=0, or "autoInit": false (anything but true) in the private config.
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

main() {
  command -v jq >/dev/null 2>&1 || return 0
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
  wb_eligible "$phys" || return 0
  auto_init "$phys"
}
main 2>/dev/null
exit 0
