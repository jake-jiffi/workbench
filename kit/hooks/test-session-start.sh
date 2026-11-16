#!/bin/bash
# Regression suite for session-start.sh (auto-init eligibility, status, fail-open). Run after any edit.
# Uses fixture templates, a fake HOME and a stub `claude`; nothing outside its own scratch folder is touched.
here="$(cd "$(dirname "$0")" && pwd -P)"
KIT="$(cd "$here/.." && pwd -P)"; REPO="$(cd "$KIT/.." && pwd -P)"
# Scratch lives under the real home (not /tmp, which auto-init ignores on purpose).
B=$(mktemp -d "$HOME/.workbench-ut.XXXXXX") || exit 1; B=$(cd -P "$B" && pwd -P)
EXTRA=$(mktemp -d /tmp/wbut.XXXXXX); EXTRA=$(cd -P "$EXTRA" && pwd -P)
trap 'rm -rf "$B" "$EXTRA"' EXIT
fails=0; n=0
ok() { n=$((n + 1)); if [ "$1" = 0 ]; then echo "ok   $2"; else echo "FAIL $2"; fails=$((fails + 1)); fi; }

H="$B/home"; mkdir -p "$H/.claude" "$H/.config" "$H/Library" "$B/tmp" "$B/wbhome" "$B/stub" "$B/f"
cat > "$B/stub/claude" <<'S'
#!/bin/bash
[ -n "$RACE_FILE" ] && [ "$1 $2" = "plugin validate" ] && printf 'mine' > "$RACE_FILE"
exit 0
S
chmod +x "$B/stub/claude"
export HOME="$H" TMPDIR="$B/tmp" WORKBENCH_HOME="$B/wbhome" WORKBENCH_CONFIG="$H/cfg.json" \
       WORKBENCH_TEMPLATES="$REPO/tests/fixtures/templates" PATH="$B/stub:$PATH"
unset WORKBENCH_AUTO CLAUDE_CONFIG_DIR RACE_FILE
echo '{"owner":"Sam","autoInit":true}' > "$WORKBENCH_CONFIG"
HOOK="$here/session-start.sh"

hook() { # hook <source> <cwd>: sets OUT and RC
  OUT=$(jq -n --arg s "$1" --arg c "$2" '{hook_event_name:"SessionStart",source:$s,cwd:$c}' | "$HOOK" 2>"$B/err"); RC=$?
}
inited() { [ -f "$1/workbench.json" ]; }
empty_dir() { rm -rf "$1"; mkdir -p "$1"; }

# --- eligible ---
d="$B/f/empty"; empty_dir "$d"; hook startup "$d"
ok $RC "empty folder: exit 0"
ok "$(inited "$d"; echo $?)" "empty folder inits"
ok "$(printf '%s' "$OUT" | jq -e '.hookSpecificOutput.hookEventName=="SessionStart" and (.hookSpecificOutput.additionalContext|contains("CLAUDE.md") and contains("add-app") and contains("next session"))' >/dev/null; echo $?)" "brief is valid hook JSON that says read CLAUDE.md, add-app, next session"
ok "$([ "$(jq -r .owner "$d/workbench.json")" = Sam ] && grep -q "Owner: Sam" "$d/CLAUDE.md" && ! grep -rq '{{' "$d"; echo $?)" "owner from config, no unreplaced variables"
ok "$(ls -A "$d" | grep -q 'workbench-stage'; echo $((1 - $?)))" "no stage folder left behind"
ok "$([ "$(stat -c %a "$d/data" 2>/dev/null || stat -f %Lp "$d/data")" = 700 ]; echo $?)" "data/ is mode 700"
hook startup "$d"
ok "$(printf '%s' "$OUT" | grep -q 'Workspace check' && ! printf '%s' "$OUT" | grep -q 'just created'; echo $?)" "second startup in it shows status, not the brief"

d="$B/f/dsstore"; empty_dir "$d"; : > "$d/.DS_Store"; hook startup "$d"
ok "$(inited "$d"; echo $?)" ".DS_Store-only folder inits"

d="$B/f/Mý prøject é/with space"; empty_dir "$d"; hook startup "$d"
ok "$(inited "$d" && [ "$(jq -r .name "$d/workbench.json")" = "with space" ] && grep -q "$d/.claude/memory" "$d/.claude/settings.json"; echo $?)" "spaces and unicode in the path"

real="$B/f/real-empty"; empty_dir "$real"; ln -sfn "$real" "$B/f/link-empty"; hook startup "$B/f/link-empty"
ok "$(inited "$real"; echo $?)" "symlink to an empty folder inits the real folder"
ok "$(jq -r .name "$real/workbench.json" | grep -qx 'real-empty'; echo $?)" "name comes from the real folder"

# --- not eligible: nothing created, nothing printed ---
no_init() { # no_init <name> <source> <cwd> [env...]
  local name=$1 src=$2 cwd=$3; shift 3
  local before; before=$(find "$cwd" -mindepth 0 -maxdepth 2 2>/dev/null | sort | md5)
  OUT=$(env "$@" jq -n --arg s "$src" --arg c "$cwd" '{source:$s,cwd:$c}' | env "$@" "$HOOK" 2>/dev/null); RC=$?
  local after; after=$(find "$cwd" -mindepth 0 -maxdepth 2 2>/dev/null | sort | md5)
  ok "$([ $RC = 0 ] && [ "$before" = "$after" ] && [ ! -e "$cwd/workbench.json" ] && [ -z "$OUT" ]; echo $?)" "$name: no init, no output, exit 0"
}
md5() { cksum | cut -d' ' -f1; }
d="$B/f/nonempty"; empty_dir "$d"; echo hi > "$d/file.txt"; no_init "non-empty folder" startup "$d"
d="$B/f/hidden"; empty_dir "$d"; mkdir "$d/.git"; no_init "folder holding only .git" startup "$d"
d="$B/f/dsplus"; empty_dir "$d"; : > "$d/.DS_Store"; : > "$d/x"; no_init ".DS_Store plus a file" startup "$d"
H2="$B/emptyhome"; empty_dir "$H2"; no_init "\$HOME itself" startup "$H2" HOME="$H2"
ln -sfn "$H2" "$B/f/link-home"; no_init "symlink to \$HOME" startup "$B/f/link-home" HOME="$H2"
d="$B/f/linknon"; empty_dir "$d"; echo x > "$d/x"; ln -sfn "$d" "$B/f/link-nonempty"; no_init "symlink to a non-empty folder" startup "$B/f/link-nonempty"
no_init "/ (root)" startup /
d="$EXTRA/empty"; empty_dir "$d"; no_init "/tmp" startup "$d"
d="/private/tmp/wbut-$$"; mkdir -p "$d"; no_init "/private/tmp" startup "$d"; rmdir "$d"
d="$B/tmp/x"; empty_dir "$d"; no_init "\$TMPDIR" startup "$d"
d="$H/.claude/x"; empty_dir "$d"; no_init "~/.claude" startup "$d"
d="$H/.config/x"; empty_dir "$d"; no_init "~/.config" startup "$d"
d="$H/Library/x"; empty_dir "$d"; no_init "~/Library" startup "$d"
d="$B/wbhome/x"; empty_dir "$d"; no_init "\$WORKBENCH_HOME" startup "$d"
d="/var/folders/wbut-never-created"; no_init "/var/folders (missing dir)" startup "$d"
d="$B/f/src-resume"; empty_dir "$d"; no_init "source resume" resume "$d"
d="$B/f/src-clear"; empty_dir "$d"; no_init "source clear" clear "$d"
d="$B/f/src-compact"; empty_dir "$d"; no_init "source compact" compact "$d"
d="$B/f/src-none"; empty_dir "$d"; no_init "no source" "" "$d"
d="$B/f/off1"; empty_dir "$d"; echo '{"owner":"Sam","autoInit":false}' > "$H/off.json"; no_init "autoInit false" startup "$d" WORKBENCH_CONFIG="$H/off.json"
d="$B/f/off2"; empty_dir "$d"; echo '{"owner":"Sam"}' > "$H/off.json"; no_init "autoInit missing" startup "$d" WORKBENCH_CONFIG="$H/off.json"
d="$B/f/off3"; empty_dir "$d"; no_init "no config file" startup "$d" WORKBENCH_CONFIG="$H/does-not-exist.json"
d="$B/f/off4"; empty_dir "$d"; echo '{oops' > "$H/off.json"; no_init "malformed config" startup "$d" WORKBENCH_CONFIG="$H/off.json"
d="$B/f/off5"; empty_dir "$d"; echo '{"autoInit":"true"}' > "$H/off.json"; no_init "autoInit as a string" startup "$d" WORKBENCH_CONFIG="$H/off.json"
d="$B/f/off6"; empty_dir "$d"; no_init "WORKBENCH_AUTO=0" startup "$d" WORKBENCH_AUTO=0
d="$B/f/missing-dir-never"; no_init "cwd does not exist" startup "$d"

# --- inside a workspace: nested empty folder is not inited; status prints ---
ws="$B/f/empty"
d="$ws/apps/nested-empty"; empty_dir "$d"
OUT=$(jq -n --arg c "$d" '{source:"startup",cwd:$c}' | "$HOOK" 2>/dev/null); RC=$?
ok "$([ $RC = 0 ] && [ ! -e "$d/workbench.json" ] && printf '%s' "$OUT" | grep -q 'Workspace check'; echo $?)" "empty folder nested in a workspace: not inited, status shown"
hook clear "$ws"; ok "$(printf '%s' "$OUT" | grep -q 'Workspace check'; echo $?)" "clear in a workspace shows status"
hook resume "$ws"; ok "$([ -z "$OUT" ] && [ $RC = 0 ]; echo $?)" "resume in a workspace prints nothing"
hook startup "$ws"; ok "$(printf '%s' "$OUT" | grep -q 'No apps yet' && printf '%s' "$OUT" | grep -q 'notes/STATE.md'; echo $?)" "status: no apps hint and STATE.md pointer"

# --- outside a workspace: nothing, fast ---
d="$B/f/outside"; empty_dir "$d"; echo x > "$d/a"
s=$(date +%s); for i in 1 2 3 4 5 6 7 8 9 10; do hook startup "$d"; done; e=$(date +%s)
ok "$([ -z "$OUT" ] && [ $RC = 0 ] && [ $((e - s)) -le 3 ]; echo $?)" "outside a workspace: silent, 10 runs in $((e - s))s"

# --- fail open ---
printf '' | "$HOOK" >/dev/null 2>&1; ok $? "empty stdin exits 0"
printf 'not json' | "$HOOK" >/dev/null 2>&1; ok $? "garbage stdin exits 0"
printf '{"source":"startup"}' | "$HOOK" >/dev/null 2>&1; ok $? "no cwd exits 0"
d="$B/f/notemplates"; empty_dir "$d"; WORKBENCH_TEMPLATES="$B/nope" "$HOOK" < <(jq -n --arg c "$d" '{source:"startup",cwd:$c}') >"$B/out" 2>/dev/null; rc=$?
ok "$([ $rc = 0 ] && [ -z "$(ls -A "$d")" ] && [ ! -s "$B/out" ]; echo $?)" "init failing (no templates): exit 0, folder untouched, no output"
d="$B/f/badtpl"; empty_dir "$d"; mkdir "$B/tplbad"; : > "$B/tplbad/x"
WORKBENCH_TEMPLATES="$B/tplbad" "$HOOK" < <(jq -n --arg c "$d" '{source:"startup",cwd:$c}') >/dev/null 2>&1; ok $? "odd templates: exit 0"
nojq="$B/nojq"; mkdir -p "$nojq"; for b in cat awk sed grep tr dirname head tail date find stat mkdir rm cksum cut sort; do ln -sf "$(command -v $b)" "$nojq/$b"; done
d="$B/f/nojq"; empty_dir "$d"; jq -n --arg c "$d" '{source:"startup",cwd:$c}' | PATH="$nojq" /bin/bash "$HOOK" >"$B/out" 2>/dev/null; rc=$?
ok "$([ $rc = 0 ] && [ -z "$(ls -A "$d")" ] && [ ! -s "$B/out" ]; echo $?)" "jq missing: exit 0, nothing done"
d="$B/f/malformed-ws"; empty_dir "$d"; echo '{not json' > "$d/workbench.json"; hook startup "$d"; ok $RC "malformed workbench.json: exit 0"
ok "$(printf '%s' "$OUT" | grep -q 'Workspace check'; echo $?)" "malformed workbench.json: status still prints"

# --- a stale lock does not block ---
d="$B/f/stale"; empty_dir "$d"
sum=$(printf '%s' "$d" | cksum | cut -d' ' -f1); mkdir -p "$B/tmp/workbench-init-$sum.lock"; echo 999999 > "$B/tmp/workbench-init-$sum.lock/pid"
hook startup "$d"; ok "$(inited "$d"; echo $?)" "stale lock (dead pid) is cleared"
ok "$([ ! -e "$B/tmp/workbench-init-$sum.lock" ]; echo $?)" "lock released after init"

# --- the folder fills between the check and the init: nothing of the user's is overwritten ---
d="$B/f/race"; empty_dir "$d"
RACE_FILE="$d/CLAUDE.md" hook startup "$d"
ok "$([ "$(cat "$d/CLAUDE.md")" = mine ]; echo $?)" "file created mid-init is never overwritten"
ok "$(inited "$d" && ! ls -A "$d" | grep -q workbench-stage; echo $?)" "init still completes cleanly around it"

# --- two (six) sessions start in the same empty folder at once ---
d="$B/f/concurrent"; empty_dir "$d"; rm -f "$B"/c.out.*
for i in 1 2 3 4 5 6; do ( jq -n --arg c "$d" '{source:"startup",cwd:$c}' | "$HOOK" > "$B/c.out.$i" 2>/dev/null; echo $? > "$B/c.rc.$i" ) & done; wait
brief=$(grep -l 'just turned this empty folder' "$B"/c.out.* 2>/dev/null | wc -l | tr -d ' ')
ok "$([ "$brief" = 1 ]; echo $?)" "exactly one session wrote the workspace and got the brief (got $brief)"
ok "$(cat "$B"/c.rc.* | grep -qv '^0$'; echo $((1 - $?)))" "every session exited 0"
ref="$B/f/ref"; empty_dir "$ref"; hook startup "$ref"
ok "$([ "$(cd "$d" && find . -type f | sort | tr '\n' ' ')" = "$(cd "$ref" && find . -type f | sort | tr '\n' ' ')" ]; echo $?)" "file set identical to a single run: no half or double write"
ok "$(jq -e . "$d/workbench.json" >/dev/null && ! ls -A "$d" | grep -q workbench-stage && ! ls "$B/tmp" | grep -q 'workbench-init'; echo $?)" "valid marker, no stage folder, no lock left"
ok "$(grep -c . "$d/CLAUDE.md" | grep -qx "$(grep -c . "$ref/CLAUDE.md")"; echo $?)" "CLAUDE.md not duplicated"

echo "$fails failed of $n"; exit $fails
