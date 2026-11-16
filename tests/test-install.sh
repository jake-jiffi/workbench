#!/bin/bash
# install.sh tests against throwaway folders: HOME, the config folder, WORKBENCH_CONFIG and a stub `claude`.
# Never touches the real ~/.claude, ~/.config, ~/.workbench or ~/.local/bin.
REPO=$(cd "$(dirname "$0")/.." && pwd -P)
T=$(mktemp -d); T=$(cd -P "$T" && pwd -P); trap 'rm -rf "$T"' EXIT
fails=0; n=0
ok() { n=$((n + 1)); if [ "$1" = 0 ]; then echo "ok   $2"; else echo "FAIL $2"; fails=$((fails + 1)); fi; }
chk() { local d=$1; shift; "$@" >/dev/null 2>&1; ok $? "$d"; }

# stub claude: state in $STUB/state, calls in $STUB/log
STUB="$T/stub"; mkdir -p "$STUB/state"
cat > "$STUB/claude" <<'S'
#!/bin/bash
echo "CFG=${CLAUDE_CONFIG_DIR:-<unset>} $*" >> "$STUB_DIR/log"
S="$STUB_DIR/state"
case "$1 $2 $3" in
  "plugin list "*) [ -f "$S/installed" ] && echo "workbench@workbench" ;;
  "plugin marketplace list") [ -f "$S/market" ] && echo "workbench" ;;
  "plugin marketplace add") touch "$S/market" ;;
  "plugin marketplace remove") rm -f "$S/market" ;;
  "plugin install "*) touch "$S/installed" ;;
  "plugin uninstall "*) rm -f "$S/installed" ;;
  "plugin validate "*) ;;
esac
exit 0
S
chmod +x "$STUB/claude"
export STUB_DIR="$STUB"
NODEDIR=$(dirname "$(command -v node)")
export PATH="$STUB:/usr/bin:/bin:/usr/sbin:/sbin:$NODEDIR"
unset CLAUDE_CONFIG_DIR

new_home() { H="$T/home $1"; rm -rf "$H"; mkdir -p "$H/.claude"; export HOME="$H" WORKBENCH_CONFIG="$H/.config/workbench/config.json"; }
inst() { /bin/bash "$REPO/install.sh" "$@"; }
count_ours() { jq '[.hooks[]?[]?.hooks[]?.command // empty | select(test("/kit/hooks/(session-start|guard-git|guard-release)\\.sh"))] | length' "$1"; }
BASE='{"theme":"dark","env":{"A":"1"},"hooks":{"PreToolUse":[{"matcher":"Write","hooks":[{"type":"command","command":"/x/other.sh","timeout":5}]},{"matcher":"Bash","hooks":[{"type":"command","command":"/x/mine.sh"}]}],"Stop":[{"hooks":[{"type":"command","command":"echo hi"}]}],"SessionStart":[{"matcher":"resume","hooks":[{"type":"command","command":"/x/resume.sh"}]}]},"permissions":{"allow":["Bash(ls)"],"deny":[]},"n":[1,2.5,null,true]}'

# 0. accounts seed the pane's option once, and never over a value already set
new_home acc; mkdir -p "$(dirname "$WORKBENCH_CONFIG")"
printf '%s' '{"owner":"Sam","autoInit":true,"accounts":[{"label":"main","dir":"~/.claude"},{"label":"work","dir":"~/.claude-work"}]}' > "$WORKBENCH_CONFIG"
echo '{}' > "$H/.claude/settings.json"
inst --no-plugin --config-dir "$H/.claude" >/dev/null 2>&1
ok "$([ "$(jq -r '.pluginConfigs["workbench@workbench"].options.accounts' "$H/.claude/settings.json")" = 'main=~/.claude, work=~/.claude-work' ]; echo $?)" "accounts from the config seed the pane's accounts option"
jq '.pluginConfigs["workbench@workbench"].options.accounts = "mine=/x"' "$H/.claude/settings.json" > "$T/s" && mv "$T/s" "$H/.claude/settings.json"
inst --no-plugin --config-dir "$H/.claude" >/dev/null 2>&1
ok "$([ "$(jq -r '.pluginConfigs["workbench@workbench"].options.accounts' "$H/.claude/settings.json")" = 'mine=/x' ]; echo $?)" "a value already set is never overwritten"
inst --uninstall --no-plugin --config-dir "$H/.claude" >/dev/null 2>&1
ok "$(jq -e '(.pluginConfigs // {}) | has("workbench@workbench") | not' "$H/.claude/settings.json" >/dev/null; echo $?)" "uninstall removes the pane's option"

# 1. dry run changes nothing and prints a plan
new_home dry; echo "$BASE" > "$H/.claude/settings.json"; before=$(cat "$H/.claude/settings.json")
out=$(inst --dry-run --no-plugin 2>&1); rc=$?
ok $rc "dry-run exits 0"
ok "$([ "$(cat "$H/.claude/settings.json")" = "$before" ]; echo $?)" "dry-run leaves settings.json byte-identical"
ok "$([ ! -e "$H/.local" ] && [ ! -e "$H/.workbench" ] && [ ! -e "$H/.config" ]; echo $?)" "dry-run creates no links or config"
ok "$(printf '%s' "$out" | grep -q 'ln -s .*kit/bin/workbench' && printf '%s' "$out" | grep -q 'write .*config.json' && printf '%s' "$out" | grep -q 'add the hook entries'; echo $?)" "dry-run plan lists links, config and hooks"
ok "$(ls "$H/.claude" | grep -q backup; echo $((1 - $?)))" "dry-run makes no backup"

# 2. install, twice
new_home main; echo "$BASE" > "$H/.claude/settings.json"; chmod 640 "$H/.claude/settings.json"
inst --no-plugin >"$T/o1" 2>&1; rc=$?; ok $rc "install exits 0 ($(tail -n1 "$T/o1"))"
ok "$([ "$(count_ours "$H/.claude/settings.json")" = 3 ]; echo $?)" "three hook entries after install"
inst --no-plugin >"$T/o2" 2>&1; rc=$?; ok $rc "second install exits 0"
ok "$([ "$(count_ours "$H/.claude/settings.json")" = 3 ]; echo $?)" "still three after a second install (idempotent)"
ok "$([ "$(ls "$H/.claude" | grep -c 'settings.json.workbench-backup-')" = 1 ]; echo $?)" "one backup, none for the no-op second run"
ok "$(jq -e --argjson b "$BASE" '(.theme==$b.theme) and (.env==$b.env) and (.permissions==$b.permissions) and (.n==$b.n) and (.hooks.Stop==$b.hooks.Stop) and (.hooks.PreToolUse[0]==$b.hooks.PreToolUse[0]) and (.hooks.PreToolUse[1]==$b.hooks.PreToolUse[1]) and (.hooks.SessionStart[0]==$b.hooks.SessionStart[0])' "$H/.claude/settings.json" >/dev/null; echo $?)" "every other key and hook is intact"
ok "$([ "$(stat -f %Lp "$H/.claude/settings.json" 2>/dev/null || stat -c %a "$H/.claude/settings.json")" = 640 ]; echo $?)" "file mode kept"
ok "$([ "$(jq -r '.hooks.SessionStart[-1].matcher' "$H/.claude/settings.json")" = 'startup|clear' ] && [ "$(jq '.hooks.PreToolUse[-1].hooks|length' "$H/.claude/settings.json")" = 2 ]; echo $?)" "matchers and grouping as specified"
ok "$(jq -r '.hooks.PreToolUse[-1].hooks[].timeout' "$H/.claude/settings.json" | tr '\n' ' ' | grep -q '^10 15 $'; echo $?)" "timeouts 30/10/15"
ok "$([ -L "$H/.workbench" ] && [ -L "$H/.local/bin/workbench" ]; echo $?)" "links in place"
ok "$([ "$("$H/.local/bin/workbench" version)" = "workbench 1.0.0" ]; echo $?)" "linked CLI runs through the symlink"
ok "$(jq -e '.autoInit==true and (.owner|length>0)' "$WORKBENCH_CONFIG" >/dev/null; echo $?)" "config written"
ok "$(grep -q "$H/.workbench/kit/hooks/guard-git.sh" "$H/.claude/settings.json"; echo $?)" "hook commands use the ~/.workbench path"
ok "$(grep -q 'FAIL' "$T/o1"; echo $((1 - $?)))" "install's own check shows no FAIL"
echo '{"owner":"Kept","autoInit":false}' > "$WORKBENCH_CONFIG"; inst --no-plugin >/dev/null 2>&1
ok "$([ "$(jq -r .owner "$WORKBENCH_CONFIG")" = Kept ]; echo $?)" "existing config never overwritten"

# 3. uninstall restores the original meaning, keeps config
inst --uninstall --no-plugin >"$T/o3" 2>&1; rc=$?; ok $rc "uninstall exits 0"
ok "$([ "$(jq -S . "$H/.claude/settings.json")" = "$(echo "$BASE" | jq -S .)" ]; echo $?)" "uninstall leaves exactly the original settings"
ok "$([ ! -e "$H/.workbench" ] && [ ! -e "$H/.local/bin/workbench" ]; echo $?)" "links removed"
ok "$([ -f "$WORKBENCH_CONFIG" ]; echo $?)" "config kept"
inst --uninstall --no-plugin >/dev/null 2>&1; ok $? "uninstall twice is fine"

# 4. only-ours settings: uninstall leaves no empty hooks key
new_home only; echo '{"a":1}' > "$H/.claude/settings.json"; inst --no-plugin >/dev/null 2>&1; inst --uninstall --no-plugin >/dev/null 2>&1
ok "$([ "$(jq -c . "$H/.claude/settings.json")" = '{"a":1}' ]; echo $?)" "install then uninstall on a bare file round-trips"
# missing settings.json is created
new_home none; rm -rf "$H/.claude"; inst --no-plugin >/dev/null 2>&1
ok "$([ "$(count_ours "$H/.claude/settings.json")" = 3 ]; echo $?)" "creates settings.json when none exists"

# 5. a settings.json that is a symlink (dotfile manager) stays a symlink
new_home sym; mkdir -p "$H/dotfiles"; echo "$BASE" > "$H/dotfiles/settings.json"; ln -s "$H/dotfiles/settings.json" "$H/.claude/settings.json"
inst --no-plugin >/dev/null 2>&1
ok "$([ -L "$H/.claude/settings.json" ] && [ "$(count_ours "$H/dotfiles/settings.json")" = 3 ]; echo $?)" "symlinked settings.json is edited in place, link kept"

# 6. malformed or oddly shaped settings.json: refuse, change nothing
for body in '{"hooks": {oops' '[]' '{"hooks":{"PreToolUse":"x"}}' '{"hooks":[1]}'; do
  new_home bad; printf '%s' "$body" > "$H/.claude/settings.json"
  inst --no-plugin >"$T/ob" 2>&1; rc=$?
  ok "$([ "$rc" != 0 ] && [ "$(cat "$H/.claude/settings.json")" = "$body" ] && ! ls "$H/.claude" | grep -q backup; echo $?)" "refuses and leaves it alone: $body"
done

# 7. several config folders, each with its own settings
new_home multi; mkdir -p "$H/acct2"; echo '{"x":1}' > "$H/acct2/settings.json"
inst --no-plugin --config-dir "$H/.claude" --config-dir "$H/acct2" >/dev/null 2>&1
ok "$([ "$(count_ours "$H/.claude/settings.json")" = 3 ] && [ "$(count_ours "$H/acct2/settings.json")" = 3 ] && [ "$(jq .x "$H/acct2/settings.json")" = 1 ]; echo $?)" "--config-dir repeatable"
inst --uninstall --no-plugin --config-dir "$H/.claude" --config-dir "$H/acct2" >/dev/null 2>&1
ok "$([ "$(count_ours "$H/acct2/settings.json")" = 0 ] && [ "$(jq .x "$H/acct2/settings.json")" = 1 ]; echo $?)" "uninstall on both"

# 8. a name that already resolves elsewhere is not linked over; an existing ~/.workbench directory is never removed
new_home clash; mkdir -p "$H/other-bin" "$H/.workbench/precious"; printf '#!/bin/sh\n' > "$H/other-bin/workbench"; chmod +x "$H/other-bin/workbench"
PATH="$H/other-bin:$PATH" inst --no-plugin >"$T/oc" 2>&1
ok "$([ ! -e "$H/.local/bin/workbench" ] && grep -q 'already resolves to' "$T/oc"; echo $?)" "does not link over a name that resolves elsewhere, and says so"
ok "$(grep -q "$REPO/kit/hooks/guard-git.sh" "$H/.claude/settings.json"; echo $?)" "existing ~/.workbench folder: hooks point at the repo path"
inst --uninstall --no-plugin >/dev/null 2>&1
ok "$([ -d "$H/.workbench/precious" ]; echo $?)" "uninstall never removes a real ~/.workbench folder"

# 9. plugin steps run, are skipped when installed, and are undone
new_home plug; rm -f "$STUB/log" "$STUB/state/"*
inst >"$T/op" 2>&1; rc=$?; ok $rc "install with plugin exits 0"
ok "$(grep -q 'plugin marketplace add' "$STUB/log" && grep -q 'plugin install workbench@workbench --scope user' "$STUB/log"; echo $?)" "plugin marketplace add and install called"
ok "$(grep -q 'CFG=<unset> plugin install' "$STUB/log"; echo $?)" "default folder: CLAUDE_CONFIG_DIR not set for claude"
: > "$STUB/log"; inst >/dev/null 2>&1
ok "$(! grep -q 'plugin install' "$STUB/log"; echo $?)" "second run skips the plugin install"
: > "$STUB/log"; inst --uninstall >/dev/null 2>&1
ok "$(grep -q 'plugin uninstall workbench@workbench' "$STUB/log"; echo $?)" "uninstall removes the plugin"
mkdir -p "$H/acct2"; : > "$STUB/log"; inst --config-dir "$H/acct2" >/dev/null 2>&1
ok "$(grep -q "CFG=$H/acct2 plugin install" "$STUB/log"; echo $?)" "other folders get CLAUDE_CONFIG_DIR"
inst --uninstall --config-dir "$H/acct2" >/dev/null 2>&1

# 10. --check
new_home chk; inst --no-plugin >/dev/null 2>&1
inst --check --no-plugin >/dev/null 2>&1; ok $? "--check passes after install"
inst --uninstall --no-plugin >/dev/null 2>&1
inst --check --no-plugin >/dev/null 2>&1; ok "$((1 - ($? != 0)))" "--check fails after uninstall"

# 11. unknown flag
inst --bogus >/dev/null 2>&1; ok "$((1 - ($? == 2)))" "unknown option exits 2"

echo "$fails failed of $n"; exit $fails
