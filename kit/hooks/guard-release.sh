#!/bin/bash
# workbench PreToolUse guard for Bash: nothing ships with critical left-undone steps open.
# Inside a workspace, these are refused unless notes/left-undone-review.md (written by the left-undone-review
# skill) is under 3 hours old and its last line is "Blocking: none":
#   - gh pr create into an app's production branch (only apps whose production branch differs from integration),
#   - gh pr merge of a PR whose base is such a production branch,
#   - any command matching a regex in workbench.json "shipPatterns".
# Outside a workspace it does nothing. Exit 2 blocks and shows the message to Claude; everything else allows.
# Regression suite: test-guard-release.sh beside this file. Run it after any edit.
input=$(cat)
command -v jq >/dev/null 2>&1 || exit 0
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd) || exit 0
. "$here/../lib/common.sh" 2>/dev/null || exit 0

parsed=$(printf '%s' "$input" | jq -r '(.cwd // ""), (.tool_input.command // "")' 2>/dev/null) || exit 0
case "$parsed" in *$'\n'*) ;; *) exit 0 ;; esac
cwd=${parsed%%$'\n'*}; cmd=${parsed#*$'\n'}
[ -z "$cmd" ] && exit 0
[ -z "$cwd" ] && cwd=$PWD

dir=$(wb_physical "$cwd"); [ -z "$dir" ] && dir=$cwd
root=$(wb_find_root "$dir")

# No workspace at cwd: a leading "cd <dir>" may still point into one.
if [ -z "$root" ]; then
  case "$cmd" in *cd\ *)
    while IFS= read -r seg; do
      seg="${seg#"${seg%%[![:space:]({]*}"}"
      case "$seg" in cd\ *)
        t=${seg#cd }; t=${t%% *}; t=${t//\"/}; t=${t//\'/}; t=${t/#\~/$HOME}
        case "$t" in /*) r=$(wb_find_root "$(wb_physical "$t")") && { root=$r; break; } ;; esac ;;
      esac
    done <<< "$(printf '%s\n' "$cmd" | awk '{ gsub(/&&|\|\||;|&|\|/, "\n"); print }')" ;;
  esac
fi
[ -z "$root" ] && exit 0

# Quoted text and heredoc bodies are inert, so a commit message that mentions a deploy is not a deploy.
san=$(printf '%s' "$cmd" | wb_sanitise)
case "$san" in OK*) text=${san#OK$'\n'} ;; *) text=$cmd ;; esac
# A shell or eval running a quoted string is the one place quoted text is a command: look at the raw text too.
raw_too=0
printf '%s' "$cmd" | grep -Eq '(^|[[:space:];&|(])((ba|z|da)?sh[[:space:]]+(-[a-z]*c|--command)|eval[[:space:]])' && raw_too=1
rawq=${cmd//[\"\']/ }
WJ="$root/workbench.json"

has() { printf '%s' "$text" | grep -Eq -e "$1" && return 0; [ "$raw_too" = 1 ] && printf '%s' "$rawq" | grep -Eq -e "$1"; }

# Production branches of apps that have a separate integration branch.
prod=$(jq -r '.apps[]? | select((.production // "") != "" and (.production != (.integration // .production))) | .production' "$WJ" 2>/dev/null | sort -u)
prod_alt=$(wb_alt "$prod")

ships=""
# The base is read with quote marks dropped, so --base "main" and -B 'main' count too.
if [ -n "$prod_alt" ] && has 'gh[[:space:]]+pr[[:space:]]+create' \
   && printf '%s' "$rawq" | grep -Eq -e "(--base|-B)[[:space:]=]+(${prod_alt})([[:space:]]|\$)"; then
  ships="opening a PR into a production branch"
fi
if [ -z "$ships" ]; then
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    has "$pat" && { ships="a ship command (matches shipPatterns)"; break; }
  done <<< "$(jq -r '.shipPatterns[]? | strings' "$WJ" 2>/dev/null)"
fi
if [ -z "$ships" ] && [ -n "$prod_alt" ] && has 'gh[[:space:]]+pr[[:space:]]+merge'; then
  seg=$(printf '%s\n' "$text" | awk '{ gsub(/&&|\|\||;|&|\|/, "\n"); print }' | grep -E 'gh[[:space:]]+pr[[:space:]]+merge' | head -1)
  seg=$(wb_unmask "$seg")
  n=""; repo=""; prev=""
  for tok in ${seg#*merge}; do
    case "$prev" in --repo|-R) repo=$tok ;; esac
    case "$tok" in
      --repo=*) repo=${tok#--repo=} ;;
      */pull/[0-9]*) n=${tok##*/pull/}; n=${n%%[!0-9]*}; [ -z "$repo" ] && repo=$(printf '%s' "$tok" | sed -nE 's#.*github\.com/([^/]+/[^/]+)/pull/.*#\1#p') ;;
      [0-9]*) case "$tok" in *[!0-9]*) ;; *) [ -z "$n" ] && n=$tok ;; esac ;;
    esac
    prev=$tok
  done
  # With no number, gh merges the PR of the current branch: ask for that one.
  base=$(cd "$dir" 2>/dev/null && wb_timeout 12 gh pr view $n ${repo:+--repo "$repo"} --json baseRefName -q .baseRefName 2>/dev/null)
  if [ -n "$base" ] && printf '%s\n' "$prod" | grep -Fxq -- "$base"; then
    ships="merging ${n:+PR #$n }into $base"
  fi
fi
[ -z "$ships" ] && exit 0

REVIEW="${GUARD_RELEASE_REVIEW:-$root/notes/left-undone-review.md}"
MAX_AGE=$((3 * 3600))
block() { echo "Blocked by workbench guard-release: $1 Run the left-undone-review skill first (.claude/skills/left-undone-review)." >&2; exit 2; }
[ -f "$REVIEW" ] || block "$ships needs a left-undone review, and $REVIEW does not exist."
mt=$(wb_mtime "$REVIEW"); [ -n "$mt" ] || block "$ships needs a left-undone review and $REVIEW cannot be dated."
age=$(( $(date +%s) - mt ))
[ "$age" -le "$MAX_AGE" ] || block "$ships needs a left-undone review from the last 3 hours; the last one is $((age / 60)) minutes old."
last=$(grep -v '^[[:space:]]*$' "$REVIEW" | tail -n 1)
case "$last" in
  "Blocking: none") exit 0 ;;
  Blocking:*) block "$ships is held: the last review says \"$last\". Clear those items, or get the owner's deferral in their own words." ;;
  *) block "$ships needs a review that ends with a Blocking: line; $REVIEW does not." ;;
esac
