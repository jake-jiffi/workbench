# workbench shared helpers. Sourced by the hooks and the CLI. Bash 3.2 safe.
# No `set -e` here: callers decide what a failure means. Needs jq, sed, awk.

# wb_find_root <abs dir>: walk up to the first folder holding workbench.json.
wb_find_root() {
  local d=$1
  case "$d" in /*) ;; *) return 1 ;; esac
  while :; do
    [ -f "$d/workbench.json" ] && { printf '%s' "$d"; return 0; }
    [ "$d" = "/" ] && return 1
    d=${d%/*}
    [ -z "$d" ] && d=/
  done
}

# wb_physical <dir>: symlink-free absolute path, empty when the dir does not exist.
wb_physical() { ( unset CDPATH; cd -P -- "$1" 2>/dev/null && pwd -P ); }

# wb_normpath <abs path>: collapse . .. and // lexically.
wb_normpath() {
  local IFS=/ part out=""
  set -f
  for part in $1; do
    case "$part" in
      ''|.) ;;
      ..) out=${out%/*} ;;
      *) out="$out/$part" ;;
    esac
  done
  set +f
  printf '%s' "${out:-/}"
}

wb_cfg_file() { printf '%s' "${WORKBENCH_CONFIG:-$HOME/.config/workbench/config.json}"; }

# wb_cfg_get <jq filter> [default]: read the private config, default when absent or malformed.
wb_cfg_get() {
  local f v; f=$(wb_cfg_file)
  v=$(jq -r "$1" "$f" 2>/dev/null)
  if [ -z "$v" ] || [ "$v" = null ]; then printf '%s' "$2"; else printf '%s' "$v"; fi
}

# wb_protected <root>: protected branches, one per line (defaults when missing or malformed).
wb_protected() {
  local out
  out=$(jq -r '(.protectedBranches // []) | if type=="array" then .[] else empty end | strings | select(length>0)' "$1/workbench.json" 2>/dev/null)
  [ -n "$out" ] || out=$'main\nstaging'
  printf '%s\n' "$out"
}

# wb_ere_escape <string>
wb_ere_escape() { printf '%s' "$1" | sed 's/[][\.*^$+?(){}|/-]/\\&/g'; }

# wb_alt <newline separated words>: ERE alternation of the escaped words.
wb_alt() {
  local w out="" e
  while IFS= read -r w; do
    [ -z "$w" ] && continue
    e=$(wb_ere_escape "$w")
    out="${out:+$out|}$e"
  done <<< "$1"
  printf '%s' "$out"
}

# wb_sanitise: stdin command text -> "OK" or "BAD" line, then the text with
#  - heredoc bodies removed,
#  - comments removed,
#  - characters that would split or confuse a command (space ; & | ( ) newline) inside quotes
#    replaced by control bytes \001..\010, so quoted text can never look like a command.
# BAD means unbalanced quotes: callers fall back to the raw text (which errs towards blocking).
wb_sanitise() {
  awk '
function ph(c,   p) { p = index(" \t;&|()", c); return p ? substr("\001\002\004\005\006\007\010", p, 1) : c }
BEGIN { RS = "\001"; ORS = "" }
{ buf = buf $0 }
END {
  gsub(/\\\n/, " ", buf)          # a trailing backslash joins the next line
  nl = split(buf, L, "\n"); q = ""; inhd = 0; nt = 0; hi = 0; out = ""
  for (ln = 1; ln <= nl; ln++) {
    line = L[ln]
    if (inhd) {
      chk = line; if (hdash[hi]) sub(/^\t+/, "", chk)
      if (chk == tag[hi]) { hi++; if (hi > nt) { inhd = 0; nt = 0; hi = 0 } }
      if (ln < nl) out = out "\n"
      continue
    }
    n = length(line); prev = "\n"
    for (i = 1; i <= n; i++) {
      c = substr(line, i, 1)
      if (q == "\047") { if (c == "\047") { q = ""; out = out c } else out = out ph(c); continue }
      if (q == "\"") {
        if (c == "\\") { out = out c; i++; if (i <= n) out = out ph(substr(line, i, 1)) }
        else if (c == "\"") { q = ""; out = out c }
        else out = out ph(c)
        continue
      }
      if (c == "\\") { out = out c; i++; if (i <= n) out = out ph(substr(line, i, 1)); prev = "x"; continue }
      if (c == "\047" || c == "\"") { q = c; out = out c; prev = c; continue }
      if (c == "#" && (prev == " " || prev == "\t" || prev == ";" || prev == "&" || prev == "|" || prev == "(" || prev == "\n")) break
      if (c == "<" && substr(line, i + 1, 1) == "<" && substr(line, i + 2, 1) != "<") {
        rest = substr(line, i + 2); dash = 0
        if (substr(rest, 1, 1) == "-") { dash = 1; rest = substr(rest, 2) }
        sub(/^[ \t]+/, "", rest); f = substr(rest, 1, 1); tg = ""
        if (f == "\047" || f == "\"") { t = substr(rest, 2); e = index(t, f); if (e > 1) tg = substr(t, 1, e - 1) }
        else if (match(rest, /^\\?[A-Za-z_][A-Za-z0-9_.-]*/)) { tg = substr(rest, RSTART, RLENGTH); sub(/^\\/, "", tg) }
        if (tg != "") { nt++; tag[nt] = tg; hdash[nt] = dash }
        out = out "<<"; i++; prev = "<"; continue
      }
      out = out c; prev = c
    }
    if (ln < nl) {
      if (q != "") out = out "\003"
      else { out = out "\n"; if (nt > 0) { inhd = 1; hi = 1 } }
    }
  }
  printf "%s\n", (q != "" ? "BAD" : "OK")
  printf "%s\n", out
}'
}

# wb_unmask: restore the control bytes wb_sanitise put in quoted text.
wb_unmask() { printf '%s' "$1" | tr '\001\002\003\004\005\006\007\010' ' \t\n;&|()'; }

# wb_timeout <secs> cmd...: run a command, kill it after the time limit.
wb_timeout() {
  local t=$1 p w rc; shift
  "$@" & p=$!
  ( sleep "$t"; kill "$p" 2>/dev/null ) >/dev/null 2>&1 & w=$!
  wait "$p" 2>/dev/null; rc=$?
  kill "$w" 2>/dev/null; wait "$w" 2>/dev/null
  return $rc
}

# wb_lock <dir> [wait secs]: mkdir lock with stale detection. wb_unlock <dir>.
wb_lock() {
  local l=$1 w=${2:-30} i=0 p
  while ! mkdir "$l" 2>/dev/null; do
    if [ -f "$l/pid" ]; then
      p=$(cat "$l/pid" 2>/dev/null)
      if [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null; then rm -rf "$l"; continue; fi
    elif [ -d "$l" ] && [ -n "$(find "$l" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
      rm -rf "$l"; continue
    fi
    i=$((i + 1)); [ "$i" -gt $((w * 5)) ] && return 1
    sleep 0.2
  done
  echo $$ > "$l/pid" 2>/dev/null
  return 0
}
wb_unlock() { rm -rf "$1" 2>/dev/null; }

# wb_mtime <file>: epoch seconds (GNU stat first: BSD stat has no -c, GNU stat -f means something else).
wb_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }
wb_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null; }

# wb_eligible <physical dir>: can session-start auto-init this folder? Silent, 0 = yes.
# Never: /, $HOME, a folder inside a workspace, temp and system folders, config folders, any folder with a hidden
# path segment below $HOME (~/.ssh, ~/.local/x), the standard user folders themselves (Desktop, Documents, ...),
# /Volumes and /mnt themselves, anything inside a git work tree, or anything that holds files.
wb_eligible() {
  local d=$1 home_p wh x ex h rel seg
  [ -d "$d" ] || return 1
  [ "$d" = "/" ] && return 1
  home_p=$(wb_physical "$HOME")
  [ "$d" = "$HOME" ] || [ "$d" = "$home_p" ] && return 1
  wb_find_root "$d" >/dev/null && return 1
  wh=${WORKBENCH_HOME:-$HOME/.workbench}
  for x in "${TMPDIR:-}" /tmp /private/tmp /var/tmp /private/var/tmp /var/folders /private/var/folders /dev/shm /run \
           "$HOME/.claude" "$HOME/.config" "$HOME/Library" "$wh"; do
    [ -n "$x" ] || continue
    x=${x%/}; [ -n "$x" ] || continue
    case "$x" in "$HOME"|"$home_p") continue ;; esac   # a TMPDIR of $HOME must not exclude everything
    for ex in "$x" "$(wb_physical "$x")"; do
      [ -n "$ex" ] || continue
      case "$d" in "$ex"|"$ex"/*) return 1 ;; esac
    done
  done
  case "$d" in /Volumes|/mnt) return 1 ;; esac
  for h in "$HOME" "$home_p"; do
    case "$d" in "$h"/*) ;; *) continue ;; esac
    rel=${d#"$h"/}
    case "$rel" in
      Desktop|Documents|Downloads|Movies|Music|Pictures|Public|Library|Applications|Sites|Dropbox|OneDrive|"Google Drive"|"iCloud Drive"|snap) return 1 ;;
    esac
    local IFS=/; set -f
    for seg in $rel; do case "$seg" in .*) set +f; return 1 ;; esac; done
    set +f
  done
  [ -z "$(find "$d" -mindepth 1 -maxdepth 1 ! -name .DS_Store 2>/dev/null | head -n 1)" ] || return 1
  [ "$(git -C "$d" rev-parse --is-inside-work-tree 2>/dev/null)" = true ] && return 1
  return 0
}
