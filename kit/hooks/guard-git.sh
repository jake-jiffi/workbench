#!/bin/bash
# workbench PreToolUse guard for Bash. Inside a workspace (a folder holding workbench.json) it blocks what
# no session or builder should do: push to a protected branch, force-push, or commit in a main checkout
# (apps/) or a deploy checkout (ops/). Merges go through PRs. Outside a workspace it does nothing.
# Exit 2 blocks the command and shows the message to Claude. Any other outcome allows it (fail open).
# Regression suite: test-guard-git.sh beside this file. Run it after any edit.
input=$(cat)
case "$input" in *git*) ;; *) exit 0 ;; esac
command -v jq >/dev/null 2>&1 || exit 0
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd) || exit 0
. "$here/../lib/common.sh" 2>/dev/null || exit 0

parsed=$(printf '%s' "$input" | jq -r '(.cwd // ""), (.tool_input.command // "")' 2>/dev/null) || exit 0
case "$parsed" in *$'\n'*) ;; *) exit 0 ;; esac
cwd=${parsed%%$'\n'*}; cmd=${parsed#*$'\n'}
[ -z "$cmd" ] && exit 0
case "$cmd" in *git*) ;; *) exit 0 ;; esac
case "$cmd" in *push*|*commit*) ;; *) exit 0 ;; esac
[ -z "$cwd" ] && cwd=$PWD

block() { echo "Blocked by workbench guard-git: $1" >&2; exit 2; }

# git's global options may sit between "git" and the subcommand.
OPT='(-[Cc][[:space:]]+[^[:space:]]+|--(git-dir|work-tree|namespace|exec-path)[[:space:]]+[^[:space:]]+|--[a-z][a-z-]*(=[^[:space:]]+)?|-[pP])'
GIT="(^|[(/\`[:space:]])git(([[:space:]]+${OPT})*)[[:space:]]+"

# Fast exit: cwd is not in a workspace and the command cannot move anywhere else.
start=$(wb_physical "$cwd"); [ -z "$start" ] && start=$cwd
case "$start" in /*) ;; *) start="?" ;; esac
if ! wb_find_root "$start" >/dev/null; then
  case "$cmd" in *cd*|*-C*|*pushd*) ;; *) exit 0 ;; esac
fi

# Quoted text becomes inert (see wb_sanitise); unbalanced quotes fall back to the raw command.
san=$(printf '%s' "$cmd" | wb_sanitise)
case "$san" in OK*) text=${san#OK$'\n'} ;; *) text=$cmd ;; esac
vars=""
expand() { # replace $NAME and ${NAME} set earlier in this command; an unknown one makes the path unknown
  local p=$1 name val n=0
  while [[ "$p" =~ \$\{?([A-Za-z_][A-Za-z0-9_]*)\}? ]]; do
    n=$((n + 1)); [ "$n" -gt 20 ] && { printf '%s' "?"; return; }
    name=${BASH_REMATCH[1]}
    if [ "$name" = HOME ]; then val=$HOME
    elif [ "$name" = PWD ] && [ "${dir:-?}" != "?" ]; then val=$dir
    else val=$(printf '%s\n' "$vars" | sed -n "s/^${name}=//p" | tail -1); fi
    [ -z "$val" ] && { printf '%s' "?"; return; }
    p=${p/"${BASH_REMATCH[0]}"/$val}
  done
  printf '%s' "$p"
}
resolve() { # resolve <path> <relative-to>; prints ? when it can't be known
  local p ph; p=$(wb_unmask "$(expand "$1")"); p=${p//\"/}; p=${p//\'/}; p=${p//\\/}; p=${p/#\~/$HOME}
  case "$p" in \?|*'`'*|*'$'*) printf '?'; return ;; esac
  [ "$2" = "?" ] && case "$p" in /*) ;; *) printf '?'; return ;; esac
  case "$p" in /*) ;; *) p="$2/$p" ;; esac
  p=$(wb_normpath "$p")
  if [ -d "$p" ]; then ph=$(wb_physical "$p"); [ -n "$ph" ] && p=$ph; fi
  printf '%s' "$p"
}

re_sh='^(ba|z|da)?sh[[:space:]]+(-[a-z]*c|--command)[[:space:]]+(.*)$'
alt_cache_root=""; alt_cache=""
prot_alt() { # prot_alt <root>
  if [ "$1" != "$alt_cache_root" ]; then alt_cache=$(wb_alt "$(wb_protected "$1")"); alt_cache_root=$1; fi
  printf '%s' "$alt_cache"
}

scan() { # scan <text>: check every command in it
  local segments seg target sub pre re where want_c tok root alt after npos head_ref cur extras c r e unresolved newargs rawseg after_raw bt
  # One command per line: split on newlines, &&, ||, ; and single & and |.
  segments=$(printf '%s\n' "$1" | awk '{ gsub(/&&|\|\||;|&|\|/, "\n"); print }')
  vars=""; dir=$start; genv=""
  while IFS= read -r seg; do
  seg="${seg#"${seg%%[![:space:]({!]*}"}"
  # A shell or eval wrapping the rest ("bash -c cd apps/web"): look at what it runs.
  if [[ "$seg" =~ $re_sh ]]; then seg=${BASH_REMATCH[3]}; seg="${seg#"${seg%%[![:space:]({!]*}"}"; fi
  case "$seg" in eval\ *) seg=${seg#eval }; seg="${seg#"${seg%%[![:space:]({!]*}"}" ;; esac
  rawseg=$seg
  # Closing brackets and backticks end a command: drop them so they cannot hide the last word.
  case "$seg" in *'${'*)   # keep ${NAME} whole while the other brackets go
    while [[ "$seg" =~ \$\{([A-Za-z_][A-Za-z0-9_]*)\} ]]; do seg=${seg/"${BASH_REMATCH[0]}"/$'\016'${BASH_REMATCH[1]}$'\017'}; done ;;
  esac
  seg=${seg//[\)\}\`]/ }; seg=${seg//$'\016'/'${'}; seg=${seg//$'\017'/'}'}
  case "$seg" in export\ *) seg=${seg#export } ;; esac
  case "$seg" in
    cd|cd\ *|pushd\ *)
      target=${seg#* }; [ "$seg" = cd ] && target='~'
      dir=$(resolve "${target%% *}" "$dir") ;;
    [A-Za-z_]*=*) if [[ "$seg" =~ ^([A-Za-z_][A-Za-z0-9_]*)=([^[:space:]]+)$ ]]; then
        vars="$vars
${BASH_REMATCH[1]}=$(expand "${BASH_REMATCH[2]}")"
        case "${BASH_REMATCH[1]}" in GIT_DIR|GIT_WORK_TREE) genv="$genv"$'\n'"$(resolve "${BASH_REMATCH[2]}" "$dir")" ;; esac
      fi ;;
  esac

  sub=""
  printf '%s' "$seg" | grep -Eq "${GIT}push([[:space:]]|$)" && sub=push
  printf '%s' "$seg" | grep -Eq "${GIT}commit([[:space:]]|$)" && sub=commit
  [ -z "$sub" ] && continue

  # Where does this git run? cwd/cd, then each -C in order (a relative -C is relative to the one before).
  # --git-dir, --work-tree, GIT_DIR= and GIT_WORK_TREE= name further folders it acts on.
  pre=""; re="${GIT}${sub}([[:space:]]|\$)"
  [[ "$seg" =~ $re ]] && pre=${BASH_REMATCH[2]}
  where=$dir; want_c=""; extras="$genv"
  for tok in ${seg%%git*}; do
    case "$tok" in GIT_DIR=*|GIT_WORK_TREE=*) extras="$extras"$'\n'"$(resolve "${tok#*=}" "$dir")" ;; esac
  done
  for tok in $pre; do
    if [ -n "$want_c" ]; then
      case "$want_c" in C) where=$(resolve "$tok" "$where") ;; *) extras="$extras"$'\n'"$(resolve "$tok" "$where")" ;; esac
      want_c=""
    else
      case "$tok" in
        -C) want_c=C ;;
        --git-dir|--work-tree) want_c=X ;;
        --git-dir=*|--work-tree=*) extras="$extras"$'\n'"$(resolve "${tok#*=}" "$where")" ;;
      esac
    fi
  done

  if [ "$sub" = commit ]; then
    for c in "$where" $extras; do
      [ -n "$c" ] || continue
      r=$(wb_find_root "$c") || continue
      case "$c" in
        "$r"/apps|"$r"/apps/*|"$r"/ops|"$r"/ops/*)
          block "never commit in apps/ (main checkouts) or ops/ (deploy checkouts). Make a worktree under worktrees/<app>/ with: workbench worktree <app> <branch>." ;;
      esac
    done
    continue
  fi

  # A push whose folder can't be worked out (a variable set in an earlier command) is still checked against the
  # session's workspace: the protected branch list doesn't depend on the folder.
  root=$(wb_find_root "$where") || root=$(wb_find_root "$start") || continue

  # push (quote marks dropped so "main" and 'main' read as main)
  seg=${seg//\"/}; seg=${seg//\'/}
  # Arguments that are variables set earlier are expanded; ones that cannot be known are refused below.
  unresolved=0; newargs=""
  after_raw=${rawseg#*push}; bt=${after_raw//[!\`]/}
  { [ "${#bt}" -ge 2 ] || case "$after_raw" in *'$('*) true ;; *) false ;; esac; } && unresolved=1
  for tok in ${seg#*push}; do
    case "$tok" in
      *'$'*|*'`'*) e=$(expand "$(wb_unmask "$tok")"); case "$e" in \?|*'$'*|*'`'*) unresolved=1 ;; esac; tok=$e ;;
    esac
    newargs="$newargs $tok"
  done
  seg="${seg%%push*}push$newargs"
  printf '%s' "$seg" | grep -Eq '[[:space:]](-f|--force|--force-with-lease)([=[:space:]]|$)|[[:space:]]-[a-eg-zA-Z]*f[a-zA-Z]*([[:space:]]|$)|[[:space:]]\+[^[:space:]]' \
    && block "no force pushes. Push a new commit instead."
  printf '%s' "$seg" | grep -Eq '[[:space:]](--all|--mirror|--branches)([=[:space:]]|$)' \
    && block "no --all or --mirror pushes: they can send protected branches. Push one named branch."
  alt=$(prot_alt "$root")
  [ -z "$alt" ] && { [ "$unresolved" = 1 ] && block "this push names its branch with a variable or command substitution that cannot be resolved here. Write the branch name literally."; continue; }
  printf '%s' "$seg" | grep -Eq "([[:space:]]|:)(refs/heads/)?(${alt})([[:space:]]|\$)" \
    && block "never push to a protected branch ($(wb_protected "$root" | paste -sd, - | sed 's/,/, /g')). Open a PR into the integration branch (or a release/hotfix PR into production) and merge it on green CI."
  [ "$unresolved" = 1 ] && block "this push names its branch with a variable or command substitution that cannot be resolved here, so it cannot be checked against the protected branches. Write the branch name literally."
  # A push with no explicit refspec (or HEAD) pushes the current branch: block when that is protected.
  after=${seg#*push}; npos=0; head_ref=0
  for tok in $after; do
    case "$tok" in -*) ;; HEAD|@) head_ref=1; npos=$((npos + 1)) ;; *) npos=$((npos + 1)) ;; esac
  done
  if [ "$npos" -lt 2 ] || [ "$head_ref" = 1 ]; then
    cur=$(git -C "$where" symbolic-ref --short -q HEAD 2>/dev/null)
    if [ -n "$cur" ] && printf '%s\n' "$cur" | grep -Eq "^(${alt})\$"; then
      block "this push would send the checked-out protected branch ($cur). Push a feature branch from a worktree instead."
    fi
  fi
  done <<< "$segments"
}
scan "$text"
# A shell or eval running a quoted string is the one place quoted text is a command: look at the raw text too.
if printf '%s' "$cmd" | grep -Eq '(^|[[:space:];&|(])((ba|z|da)?sh[[:space:]]+(-[a-z]*c|--command)|eval[[:space:]])'; then
  scan "${cmd//[\"\']/ }"
fi
exit 0
