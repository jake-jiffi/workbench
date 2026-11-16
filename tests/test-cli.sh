#!/bin/bash
# CLI edge cases for `workbench init` and friends: hostile names, concurrent inits, symlinks, templates.
REPO=$(cd "$(dirname "$0")/.." && pwd -P)
WB="$REPO/kit/bin/workbench"
B=$(mktemp -d "$HOME/.workbench-cli.XXXXXX"); B=$(cd -P "$B" && pwd -P); trap 'rm -rf "$B"' EXIT
fails=0; n=0
ok() { n=$((n + 1)); if [ "$1" = 0 ]; then echo "ok   $2"; else echo "FAIL $2"; [ -n "$3" ] && printf '%s\n' "$3" | sed 's/^/       /'; fails=$((fails + 1)); fi; }
export HOME="$B/home" WORKBENCH_CONFIG="$B/home/cfg.json" WORKBENCH_TEMPLATES="$REPO/tests/fixtures/templates"
unset CLAUDE_CONFIG_DIR WORKBENCH_HOME
mkdir -p "$HOME"; echo '{"owner":"Cfg"}' > "$WORKBENCH_CONFIG"
mkdir -p "$B/stub"; printf '#!/bin/sh\nexit 0\n' > "$B/stub/claude"; chmod +x "$B/stub/claude"; export PATH="$B/stub:$PATH"

# hostile owner and name values land verbatim in the files, and workbench.json stays valid JSON
d="$B/hostile"; mkdir "$d"
own='Sam "Q" & Co | \1 $HOME `x` /'; nm='my "proj" & $x'
"$WB" init "$d" --owner "$own" --name "$nm" >/dev/null 2>&1; rc=$?
ok $rc "init with hostile owner and name"
ok "$([ "$(jq -r .owner "$d/workbench.json")" = "$own" ] && [ "$(jq -r .name "$d/workbench.json")" = "$nm" ]; echo $?)" "workbench.json holds them exactly"
ok "$(jq -e '(.shipPatterns | length) >= 2' "$d/workbench.json" >/dev/null; echo $?)" "init writes default ship patterns (deploy scripts, vercel --prod)"
ok "$(grep -qF "$own" "$d/CLAUDE.md" && grep -qF "# $nm (" "$d/CLAUDE.md" && ! grep -q '{{' "$d/CLAUDE.md"; echo $?)" "CLAUDE.md holds them exactly, nothing unreplaced"
ok "$(jq -e . "$d/.claude/settings.json" "$d/.codex/hooks.json" >/dev/null; echo $?)" "generated JSON files valid"
ok "$(grep -q 'my-proj-x-mods\|my-proj' "$d/mods/.claude-plugin/marketplace.json"; echo $?)" "SLUG is kebab-case"
ok "$([ "$(jq -r '.name' "$d/mods/.claude-plugin/marketplace.json")" = "my-proj-x-mods" ]; echo $?)" "slug of '$nm' is my-proj-x"

# dot- naming and the codex hooks point at the kit
ok "$([ -f "$d/notes/briefs/.keep" ] && [ -f "$d/.claude/memory/MEMORY.md" ] && [ -d "$d/.agents" ] && [ ! -e "$d/dot-claude" ]; echo $?)" "dot- segments become dotted names"
ok "$(grep -q "kit/hooks/guard-git.sh" "$d/.codex/hooks.json" && ! grep -q '{{' "$d/.codex/hooks.json"; echo $?)" ".codex/hooks.json rendered"

# init through a symlink; init twice; two inits at once
real="$B/real"; mkdir "$real"; ln -s "$real" "$B/lnk"
"$WB" init "$B/lnk" >/dev/null 2>&1; ok "$([ -f "$real/workbench.json" ] && grep -q "$real" "$real/CLAUDE.md"; echo $?)" "init via a symlink records the real path"
"$WB" init "$real" >/dev/null 2>&1; ok "$((1 - ($? != 0)))" "second init refused"
c="$B/concurrent"; mkdir "$c"
for i in 1 2 3 4; do ( "$WB" init "$c" >"$B/ci.$i" 2>&1; echo $? > "$B/cr.$i" ) & done; wait
wins=$(cat "$B"/cr.* | grep -c '^0$')
ok "$([ "$wins" -ge 1 ]; echo $?)" "at least one concurrent init wins ($wins won)"
ok "$(jq -e . "$c/workbench.json" >/dev/null && ! ls -A "$c" | grep -q workbench-stage && [ "$(grep -c '<!-- workbench:apps -->' "$c/CLAUDE.md")" = 1 ]; echo $?)" "result is one valid workspace, no stage folder, no duplicated text"
ref="$B/ref"; mkdir "$ref"; "$WB" init "$ref" >/dev/null 2>&1
ok "$([ "$(cd "$c" && find . -type f | sort | md5)" = "$(cd "$ref" && find . -type f | sort | md5)" ]; echo $?)" "same files as a single run"

# a template symlink and an executable file survive; a binary file is copied byte for byte
tp="$B/tpl"; mkdir -p "$tp/dot-claude" "$tp/bin"; echo 'x {{OWNER}}' > "$tp/CLAUDE.md"; printf '#!/bin/sh\necho {{OWNER}}\n' > "$tp/bin/run.sh"; chmod +x "$tp/bin/run.sh"
printf '\000\001{{OWNER}}\377' > "$tp/dot-claude/blob.bin"; ln -s CLAUDE.md "$tp/link.md"; : > "$tp/empty.txt"
e="$B/custom"; mkdir "$e"; WORKBENCH_TEMPLATES="$tp" "$WB" init "$e" --owner Zed >/dev/null 2>&1
ok "$([ -x "$e/bin/run.sh" ] && grep -q Zed "$e/bin/run.sh" && cmp -s "$tp/dot-claude/blob.bin" "$e/.claude/blob.bin" && [ -L "$e/link.md" ] && [ -f "$e/empty.txt" ]; echo $?)" "exec bit, binary, symlink and empty file handled"

# unusable template folder, missing templates
tf="$B/none"; mkdir "$tf"; WORKBENCH_TEMPLATES="$B/nope" "$WB" init "$tf" >/dev/null 2>&1; ok "$([ $? != 0 ] && [ -z "$(ls -A "$tf")" ]; echo $?)" "missing templates: refused, folder untouched"

# a half-made folder (no marker) is not a workspace: init --force completes it
h="$B/half"; mkdir -p "$h/.claude"; echo mine > "$h/.claude/keep"; "$WB" init "$h" >/dev/null 2>&1; ok "$((1 - ($? != 0)))" "non-empty folder refused"
"$WB" init "$h" --force >/dev/null 2>&1; ok "$([ -f "$h/workbench.json" ] && [ "$(cat "$h/.claude/keep")" = mine ]; echo $?)" "--force completes it and keeps the file"

# version, help, unknown
ok "$([ "$("$WB" version)" = "workbench 1.0.0" ]; echo $?)" "version"
"$WB" help | grep -q 'add-app'; ok $? "help lists add-app"
"$WB" bogus >/dev/null 2>&1; ok "$([ $? = 2 ]; echo $?)" "unknown command exits 2"
( cd "$B" && "$WB" status ) >/dev/null 2>&1; ok "$((1 - ($? != 0)))" "status outside a workspace fails clearly"
md5() { cksum | cut -d' ' -f1; }
echo "$fails failed of $n"; exit $fails
