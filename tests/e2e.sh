#!/bin/bash
# End to end: install into a throwaway home, auto-init an empty folder through the SessionStart hook, then
# exercise doctor, the guards, add-app, worktree/done and the refusals. Everything lives in
# ~/dev/.workbench-e2e-<random> (not /tmp: auto-init ignores /tmp on purpose) and is removed at the end.
# Never touches the real ~/.claude, ~/.config, ~/.workbench or ~/.local/bin (and checks that it did not).
#   tests/e2e.sh            run everything
#   WORKBENCH_E2E_KEEP=1    keep the scratch folder
REPO=$(cd "$(dirname "$0")/.." && pwd -P)
REAL_HOME=$HOME; REAL_CCD=${CLAUDE_CONFIG_DIR:-}
if [ -d "$REAL_HOME/dev" ]; then PARENT="$REAL_HOME/dev"; else PARENT="$REAL_HOME"; fi
E=$(mktemp -d "$PARENT/.workbench-e2e-XXXXXX") || exit 1; E=$(cd -P "$E" && pwd -P)
cleanup() { [ -n "$WORKBENCH_E2E_KEEP" ] && { echo "kept $E"; return; }; rm -rf "$E"; rm -rf "${XT:-/nonexistent}"; }
trap cleanup EXIT
fails=0; n=0
ok() { n=$((n + 1)); if [ "$1" = 0 ]; then echo "ok   $2"; else echo "FAIL $2"; fails=$((fails + 1)); [ -n "$3" ] && printf '%s\n' "$3" | sed 's/^/       /'; fi; }
t() { local desc=$1; shift; local out; out=$("$@" 2>&1); ok $? "$desc" "$out"; }   # command must succeed
tf() { local desc=$1; shift; local out; out=$("$@" 2>&1); [ $? != 0 ]; ok $? "$desc" "$out"; } # command must fail
snapshot() { { cksum "$REAL_HOME/.claude/settings.json" "${REAL_CCD:-/nonexistent}/settings.json" 2>/dev/null; ls -ld "$REAL_HOME/.workbench" "$REAL_HOME/.config/workbench" "$REAL_HOME/.local/bin/workbench" /opt/homebrew/bin/workbench /usr/local/bin/workbench /opt/homebrew/bin/claude-worker /usr/local/bin/claude-worker 2>&1; ls "$REAL_HOME/.config/workbench" "$REAL_HOME/.local/bin" 2>&1; } | sed 's/ [A-Z][a-z][a-z] .*//' | cksum; }
before_real=$(snapshot)
real_plugin=$(claude plugin list 2>/dev/null | grep -c 'workbench@workbench')

# ---- environment: a fake home, everything else inherited ----
export HOME="$E/home" WORKBENCH_CONFIG="$E/home/.config/workbench/config.json"
unset CLAUDE_CONFIG_DIR WORKBENCH_HOME WORKBENCH_AUTO WORKBENCH_TEMPLATES GUARD_RELEASE_REVIEW
export WORKBENCH_AUTOUPDATE=0
mkdir -p "$HOME/.claude" "$E/remote"
export PATH="$HOME/.local/bin:$PATH"
git config --global user.email e2e@example.com 2>/dev/null; export GIT_CONFIG_GLOBAL="$HOME/.gitconfig"
git config --global user.email e2e@example.com; git config --global user.name "Sam Example"; git config --global init.defaultBranch main
git config --global protocol.file.allow always
if [ -n "$(ls -A "$REPO/kit/templates/workspace" 2>/dev/null)" ]; then echo "templates: kit/templates/workspace"
else export WORKBENCH_TEMPLATES="$REPO/tests/fixtures/templates"; echo "templates: tests/fixtures/templates (kit/templates/workspace is empty)"; fi

# ---- 1. install ----
inst=$("$REPO/install.sh" --no-plugin --config-dir "$HOME/.claude" --bin-dir "$HOME/.local/bin" 2>&1); ok $? "install.sh --no-plugin into the throwaway home" "$inst"
WBH="$HOME/.workbench"
ok "$([ "$(jq '[.hooks[]?[]?.hooks[]?.command] | length' "$HOME/.claude/settings.json")" = 3 ]; echo $?)" "three global hooks wired"
hookcmd() { jq -r --arg n "$1" '.hooks[]?[]?.hooks[]? | select(.command|contains($n)) | .command' "$HOME/.claude/settings.json" | head -n1 | sed 's/^"//; s/"$//'; }
SS=$(hookcmd session-start.sh); GG=$(hookcmd guard-git.sh); GR=$(hookcmd guard-release.sh)
ok "$([ -x "$SS" ] && [ -x "$GG" ] && [ -x "$GR" ]; echo $?)" "the wired hook commands point at executable scripts"
WB="$HOME/.local/bin/workbench"; [ -x "$WB" ] || WB="$REPO/kit/bin/workbench"

# ---- 2. auto-init through the hook ----
WS="$E/my-project"; mkdir -p "$WS"
out=$(jq -n --arg c "$WS" '{hook_event_name:"SessionStart",source:"startup",cwd:$c}' | "$SS" 2>&1); rc=$?
ok $rc "session-start hook on an empty folder exits 0"
ok "$(printf '%s' "$out" | jq -e '.hookSpecificOutput.additionalContext | contains("CLAUDE.md")' >/dev/null; echo $?)" "it printed the brief"
for f in workbench.json CLAUDE.md AGENTS.md .claude/settings.json .claude/memory/MEMORY.md .claude/agents/builder.md .claude/agents/critic.md .claude/skills/left-undone-review/SKILL.md .codex/hooks.json .codex/agents/builder.toml .codex/agents/critic.toml .agents/skills/left-undone-review/SKILL.md apps/README.md ops/README.md worktrees/README.md stacks/README.md data/README.md mods/README.md mods/.claude-plugin/marketplace.json notes/STATE.md notes/specs/rulings.json notes/briefs/.keep notes/archive/.keep; do
  [ -f "$WS/$f" ] || { ok 1 "workspace file $f exists"; }
done
ok 0 "workspace layout checked"
ok "$(grep -q '{{' "$WS/CLAUDE.md" "$WS/AGENTS.md"; echo $((1 - $?)))" "no unreplaced {{ in CLAUDE.md or AGENTS.md"
ok "$([ "$(jq -r .owner "$WS/workbench.json")" = Sam ] && [ "$(jq -r .name "$WS/workbench.json")" = my-project ]; echo $?)" "owner (from git user.name, via config) and name"
ok "$(jq -e --arg m "$WS/.claude/memory" '.autoMemoryDirectory == $m' "$WS/.claude/settings.json" >/dev/null; echo $?)" ".claude/settings.json autoMemoryDirectory"
echo "     mods marketplace in settings: $(jq -c '.extraKnownMarketplaces // "not registered"' "$WS/.claude/settings.json")"
ok "$(jq -r '.. | .command? // empty' "$WS/.codex/hooks.json" | grep -c 'kit/hooks/' | grep -qx 3; echo $?)" ".codex/hooks.json points at the three kit hooks"

# ---- 3. doctor ----
dargs=(--no-plugin --config-dir "$HOME/.claude"); [ -e "$REPO/bin/claude-worker" ] || dargs+=(--skip worker)
doc=$(cd "$WS" && "$WB" doctor "${dargs[@]}" 2>&1); ok $? "workbench doctor passes" "$(printf '%s' "$doc" | grep -v '^PASS')"
doc=$(cd "$WS" && "$WB" doctor --deep "${dargs[@]}" 2>&1); ok $? "workbench doctor --deep (hook suites) passes" "$(printf '%s' "$doc" | grep -v '^PASS')"
if [ "$real_plugin" -ge 1 ]; then ok 0 "plugin workbench@workbench is installed (checked in the real environment, read only)"
else echo "SKIP plugin check: 'claude plugin list' does not show workbench@workbench yet (plugin/ not installed on this machine)"; fi

# ---- 4. add-app against a local bare repo with a staging branch ----
mkrepo() { # mkrepo <name> <with-staging 0|1>
  local seed="$E/seed-$1" bare="$E/remote/acme/$1.git"
  mkdir -p "$seed" "$E/remote/acme"; git init -q "$seed"; ( cd "$seed" && git checkout -q -b main
    echo '{"name":"x"}' > package.json; mkdir -p sub; echo '{"name":"sub"}' > sub/package.json; echo '{}' > package-lock.json
    git add . && git commit -q -m init
    if [ "$2" = 1 ]; then git checkout -q -b staging; echo s > staging.txt; git add . && git commit -q -m "staging work"; git checkout -q main; fi )
  git clone -q --bare "$seed" "$bare"; git -C "$bare" symbolic-ref HEAD refs/heads/main
}
mkrepo web-app 1; mkrepo api 0
out=$(cd "$WS" && "$WB" add-app "$E/remote/acme/web-app.git" --name web 2>&1); ok $? "add-app (repo with staging)" "$out"
ok "$([ "$(git -C "$WS/apps/web" branch --show-current)" = staging ]; echo $?)" "main checkout is on staging"
ok "$(jq -e '.apps[] | select(.name=="web" and .integration=="staging" and .production=="main" and .repo=="acme/web-app")' "$WS/workbench.json" >/dev/null; echo $?)" "workbench.json: integration staging, production main, repo acme/web-app"
ok "$(jq -e --arg m "$WS/.claude/memory" '.autoMemoryDirectory == $m and .worktree.baseRef == "head"' "$WS/apps/web/.claude/settings.local.json" >/dev/null; echo $?)" "apps/web/.claude/settings.local.json keys"
ok "$(grep -q '| `web` | `acme/web-app` | `staging` | `main` |' "$WS/CLAUDE.md" && grep -q '| `web` |' "$WS/AGENTS.md" && ! grep -q 'No apps yet' "$WS/CLAUDE.md"; echo $?)" "CLAUDE.md and AGENTS.md apps tables regenerated"
ok "$(git -C "$WS/apps/web" status --porcelain | grep -q settings.local; echo $((1 - $?)))" "settings.local.json is not shown as untracked in the app"
out=$(cd "$WS/notes" && "$WB" add-app "$E/remote/acme/api.git" 2>&1); ok $? "add-app from a subfolder, name from the repo (no staging)" "$out"
ok "$(jq -e '.apps[] | select(.name=="api" and .integration=="main" and .production=="main")' "$WS/workbench.json" >/dev/null; echo $?)" "no staging: integration is the default branch"
tf "add-app twice is refused" bash -c "cd '$WS' && '$WB' add-app '$E/remote/acme/api.git'"
ok "$([ "$(jq '.apps|length' "$WS/workbench.json")" = 2 ]; echo $?)" "still two apps"
tf "add-app outside a workspace is refused" bash -c "cd '$E' && '$WB' add-app '$E/remote/acme/api.git' --name zz"
tf "add-app with a path-like name is refused" bash -c "cd '$WS' && '$WB' add-app '$E/remote/acme/api.git' --name ../evil"
tf "add-app with a failing clone cleans up" bash -c "cd '$WS' && '$WB' add-app '$E/remote/nope.git' --name ghost"
ok "$([ ! -e "$WS/apps/ghost" ]; echo $?)" "no half-cloned folder left"
doc=$(cd "$WS" && "$WB" doctor "${dargs[@]}" 2>&1); ok $? "doctor passes with apps" "$(printf '%s' "$doc" | grep -v '^PASS')"

# ---- 5. guards, as Claude would call them ----
gitg() { jq -n --arg c "$2" --arg d "$1" '{tool_name:"Bash",cwd:$d,tool_input:{command:$c}}' | "$GG" >/dev/null 2>&1; echo $?; }
relg() { jq -n --arg c "$2" --arg d "$1" '{tool_name:"Bash",cwd:$d,tool_input:{command:$c}}' | "$GR" >/dev/null 2>&1; echo $?; }
ok "$([ "$(gitg "$WS" 'git push origin main')" = 2 ]; echo $?)" "guard-git blocks a push to main"
ok "$([ "$(gitg "$WS" 'git push origin HEAD:staging')" = 2 ]; echo $?)" "guard-git blocks a push to staging"
ok "$([ "$(gitg "$WS/apps/web" 'git commit -m x')" = 2 ]; echo $?)" "guard-git blocks a commit in apps/"
ok "$([ "$(gitg "$WS" 'git -C apps/web commit -m x')" = 2 ]; echo $?)" "guard-git blocks git -C apps/web commit"
ok "$([ "$(gitg "$WS/apps/web" 'git push')" = 2 ]; echo $?)" "guard-git blocks a bare push from the staging checkout"
ok "$([ "$(gitg "$WS" "git commit -m 'git push origin main'")" = 0 ]; echo $?)" "guard-git allows a message that merely mentions it"
ok "$([ "$(gitg "$E" 'git push origin main')" = 0 ]; echo $?)" "guard-git does nothing outside the workspace"

jq '.shipPatterns = ["(^|[[:space:];&|(])npm[[:space:]]+run[[:space:]]+deploy([[:space:]]|$)"]' "$WS/workbench.json" > "$WS/wj.tmp" && mv "$WS/wj.tmp" "$WS/workbench.json"
ok "$([ "$(relg "$WS" 'cd ops/web && npm run deploy')" = 2 ]; echo $?)" "guard-release blocks a deploy with no review"
ok "$([ "$(relg "$WS" 'gh pr create --base main --title r')" = 2 ]; echo $?)" "guard-release blocks a PR into production with no review"
ok "$([ "$(relg "$WS" 'gh pr create --base staging --title r')" = 0 ]; echo $?)" "guard-release allows a PR into staging"
printf 'scope: release\nU1 | blocking | x\nBlocking: U1\n' > "$WS/notes/left-undone-review.md"
ok "$([ "$(relg "$WS" 'npm run deploy')" = 2 ]; echo $?)" "guard-release blocks when the review has blockers"
printf 'scope: release\nU1 | done | proof\n\nBlocking: none\n' > "$WS/notes/left-undone-review.md"
ok "$([ "$(relg "$WS" 'npm run deploy')" = 0 ] && [ "$(relg "$WS" 'gh pr create --base main')" = 0 ]; echo $?)" "guard-release allows with a fresh Blocking: none"
touch -t "$(date -v-4H +%Y%m%d%H%M 2>/dev/null || date -d '4 hours ago' +%Y%m%d%H%M)" "$WS/notes/left-undone-review.md"
ok "$([ "$(relg "$WS" 'npm run deploy')" = 2 ]; echo $?)" "guard-release blocks on a stale review"

# ---- 6. worktree and done ----
mkdir -p "$WS/apps/web/node_modules" "$WS/apps/web/sub/node_modules"
wt=$(cd "$WS" && "$WB" worktree web feat/login 2>"$E/wt.err"); ok $? "worktree web feat/login" "$(cat "$E/wt.err")"
ok "$([ "$wt" = "$WS/worktrees/web/feat-login" ] && [ -d "$wt" ]; echo $?)" "prints the path, / becomes -"
ok "$([ "$(git -C "$wt" rev-parse HEAD)" = "$(git -C "$WS/apps/web" rev-parse origin/staging)" ]; echo $?)" "branched from origin/staging"
ok "$([ -z "$(git -C "$wt" config --get branch.feat/login.remote)" ]; echo $?)" "--no-track: no upstream"
ok "$([ -L "$wt/node_modules" ] && [ -L "$wt/sub/node_modules" ]; echo $?)" "node_modules linked at depth 0 and 1"
ok "$([ "$(gitg "$wt" 'git commit -m x')" = 0 ] && [ "$(gitg "$wt" 'git push -u origin feat/login')" = 0 ]; echo $?)" "guards allow commit and push from the worktree"
( cd "$wt" && echo hi > new.txt && git add new.txt && git commit -q -m "feat" && git push -q -u origin feat/login ) 2>/dev/null
tf "worktree for an existing branch is refused" bash -c "cd '$WS' && '$WB' worktree web feat/login"
tf "worktree for an unknown app is refused" bash -c "cd '$WS' && '$WB' worktree nope x"
echo dirty > "$wt/dirty.txt"
tf "done refuses a dirty worktree" bash -c "cd '$WS' && '$WB' done web feat/login"
ok "$([ -d "$wt" ]; echo $?)" "dirty worktree still there"
rm "$wt/dirty.txt"
out=$(cd "$WS" && "$WB" done web feat/login 2>&1); ok $? "done web feat/login" "$out"
ok "$([ ! -e "$wt" ] && ! git -C "$WS/apps/web" show-ref --verify -q refs/heads/feat/login; echo $?)" "worktree and local branch gone"
ok "$(printf '%s' "$out" | grep -qi 'left-undone'; echo $?)" "done prints the close-out reminders"
wt=$(cd "$WS" && "$WB" worktree web feat/login 2>/dev/null); ok "$([ -d "$wt" ]; echo $?)" "worktree can be made again after done"
( cd "$WS" && "$WB" done web feat/login --force >/dev/null 2>&1 )
ok "$([ "$(git -C "$WS/apps/web" branch --show-current)" = staging ] && [ -z "$(git -C "$WS/apps/web" status --porcelain)" ]; echo $?)" "main checkout still on staging and clean"

# ---- 7. refusals ----
tf "init in the workspace root is refused" "$WB" init "$WS"
tf "init in a folder inside the workspace is refused" bash -c "mkdir -p '$WS/notes/inner' && '$WB' init '$WS/notes/inner'"
mkdir -p "$E/full"; echo mine > "$E/full/keep.txt"
tf "init in a non-empty folder is refused" "$WB" init "$E/full"
ok "$([ ! -e "$E/full/workbench.json" ]; echo $?)" "and nothing was written"
echo mine > "$E/full/CLAUDE.md"
t "init --force in a non-empty folder" "$WB" init "$E/full" --force
ok "$([ "$(cat "$E/full/CLAUDE.md")" = mine ] && [ "$(cat "$E/full/keep.txt")" = mine ] && [ -f "$E/full/workbench.json" ] && [ -f "$E/full/AGENTS.md" ]; echo $?)" "--force added only what was missing, overwrote nothing"
tf "init in \$HOME is refused" bash -c "HOME='$E/home' '$WB' init '$E/home'"

# nested empty folder, an excluded temp folder, and resume
mkdir -p "$WS/apps/nested"
jq -n --arg c "$WS/apps/nested" '{source:"startup",cwd:$c}' | "$SS" >/dev/null 2>&1
ok "$([ ! -e "$WS/apps/nested/workbench.json" ]; echo $?)" "empty folder nested in the workspace is not auto-inited"
XT=$(mktemp -d /tmp/wb-e2e-excl.XXXXXX)
jq -n --arg c "$XT" '{source:"startup",cwd:$c}' | "$SS" >/dev/null 2>&1
ok "$([ ! -e "$XT/workbench.json" ] && [ -z "$(ls -A "$XT")" ]; echo $?)" "empty folder under /tmp is not auto-inited"
mkdir -p "$E/resumed"; jq -n --arg c "$E/resumed" '{source:"resume",cwd:$c}' | "$SS" >/dev/null 2>&1
ok "$([ ! -e "$E/resumed/workbench.json" ]; echo $?)" "resume does not init"
mkdir -p "$E/offswitch"; jq -n --arg c "$E/offswitch" '{source:"startup",cwd:$c}' | WORKBENCH_AUTO=0 "$SS" >/dev/null 2>&1
ok "$([ ! -e "$E/offswitch/workbench.json" ]; echo $?)" "WORKBENCH_AUTO=0 does not init"

# ---- 8. status ----
st=$(cd "$WS" && "$WB" status 2>&1); ok $? "workbench status" "$st"
ok "$(printf '%s' "$st" | grep -q 'web: staging' && printf '%s' "$st" | grep -q 'commits ahead of main' && printf '%s' "$st" | grep -q 'api: main'; echo $?)" "status lists both apps, staging ahead of main"
echo changed > "$E/seed-web-app/pkg.txt"; ( cd "$E/seed-web-app" && git checkout -q staging && echo '{"x":1}' > package-lock.json && git add . && git commit -q -m "lock" && git push -q "$E/remote/acme/web-app.git" staging )
st=$(cd "$WS" && "$WB" status 2>&1); ok "$(printf '%s' "$st" | grep -q 'lockfile changed'; echo $?)" "status fast-forwards and flags a changed lockfile"

# ---- 9. uninstall ----
out=$("$REPO/install.sh" --uninstall --no-plugin --config-dir "$HOME/.claude" --bin-dir "$HOME/.local/bin" 2>&1); ok $? "install.sh --uninstall" "$out"
ok "$([ "$(jq '[.hooks[]?[]?.hooks[]?.command // empty | select(contains("/kit/hooks/"))] | length' "$HOME/.claude/settings.json")" = 0 ] && [ ! -e "$HOME/.local/bin/workbench" ] && [ -f "$WORKBENCH_CONFIG" ] && [ -f "$WS/workbench.json" ]; echo $?)" "hooks and links gone, config and workspace kept"

# ---- the real machine was not touched ----
ok "$([ "$(HOME=$REAL_HOME snapshot)" = "$before_real" ]; echo $?)" "real ~/.claude/settings.json, ~/.workbench, ~/.config/workbench and every bin folder unchanged"

echo "$fails failed of $n"; exit $fails
