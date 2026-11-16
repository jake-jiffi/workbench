#!/bin/bash
# Regression suite for guard-git.sh. Run it after any edit: every line must say ok.
G="$(cd "$(dirname "$0")" && pwd)/guard-git.sh"; fails=0
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
R="$(cd -P "$TMP" && pwd -P)/ws"                # a workspace
mkdir -p "$R/apps/web/src" "$R/apps/api" "$R/ops/web-staging" "$R/worktrees/web/x" "$R/worktrees/api/x" "$R/notes" "$R/apps/my app"
echo '{"workbench":1,"name":"ws","protectedBranches":["main","staging"]}' > "$R/workbench.json"
# a second workspace with a custom protected list, one with a malformed marker, and a plain folder
C="$(cd -P "$TMP" && pwd -P)/custom"; mkdir -p "$C/apps/web" "$C/worktrees/web/x"
echo '{"workbench":1,"protectedBranches":["develop","release/1.x"]}' > "$C/workbench.json"
M="$(cd -P "$TMP" && pwd -P)/malformed"; mkdir -p "$M/apps/web"; echo '{not json' > "$M/workbench.json"
O="$(cd -P "$TMP" && pwd -P)/plain"; mkdir -p "$O/apps/web"
# a symlink to the workspace, and a main checkout on a protected branch for the bare-push tests
ln -s "$R" "$TMP/link"
git init -q -b staging "$R/apps/api" && git -C "$R/apps/api" -c user.email=a@b -c user.name=n commit -q --allow-empty -m i
git init -q -b feature/z "$R/worktrees/api/x2" 2>/dev/null

t() { local exp=$1 cwd=$2 cmd=$3 got
  jq -n --arg c "$cmd" --arg d "$cwd" '{tool_name:"Bash",cwd:$d,tool_input:{command:$c}}' | "$G" >/dev/null 2>&1
  [ $? = 2 ] && got=BLOCK || got=allow
  if [ $got = "$exp" ]; then echo "ok   $got  ${cmd:0:90}"; else echo "FAIL $got (wanted $exp)  ${cmd:0:90}"; fails=$((fails+1)); fi; }
NL=$'\n'

# --- ported from the original suite ---
t BLOCK $R "git push origin staging"
t BLOCK $R "git push origin main"
t BLOCK $R "git push origin HEAD:staging"
t BLOCK $R "git -C $R/worktrees/web/x push origin HEAD:refs/heads/main"
t BLOCK $R "cd $R/worktrees/web/x && git push --force"
t BLOCK $R "git push -f origin feature/a"
t BLOCK $R "git push origin +feature/a"
t BLOCK $R "git push --force-with-lease origin fix/b"
t BLOCK $R "git push --all origin"
t BLOCK $R "git -C \"\$PWD/apps/web\" push origin main"
t BLOCK $R "git -C \"\$UNSET_VAR/apps/web\" push origin main"
t BLOCK $R "cd \$SOMEWHERE && git push origin staging"
t allow $R "git -C \"\$UNSET_VAR\" commit -m x"
t BLOCK $R "git push --mirror origin"
t BLOCK $R "git push origin --branches"
t allow $R "git push --tags origin"
t BLOCK $R "git add . && git commit -m x && git push origin staging"
t BLOCK $R/apps/web "git commit -m x"
t BLOCK $R "cd $R/apps/web && git commit -am x"
t BLOCK $R "git -C $R/ops/web-staging commit -m x"
t BLOCK $R "cd apps/api && git add . && git commit -m y"
t BLOCK $R "cd ./ops/web-staging && git commit -m y"
t BLOCK $R "cd $R/apps/web${NL}git commit -m y"
t allow $R "git push -u origin chore/workspace-layout"
t allow $R "git push -u origin fix/main-nav"
t allow $R "git push origin feature/staging-banner"
t allow $R "git push origin v2.2.1"
t allow $R "cd $R/worktrees/web/x && git commit -m 'mentions apps/web and main'"
t allow $R "git -C $R/worktrees/api/x commit -m y"
t allow $R "git -C $R/apps/web fetch origin main:main"
t allow $R "gh pr merge 200 --merge"
t allow $R "git -C $R/apps/web worktree add --no-track -b fix/a $R/worktrees/web/fix-a origin/staging"
t allow $R/apps/web "git status"
t allow $R "echo 'git push origin main' > notes.txt"
t allow $R "cd $R/worktrees/api/x${NL}python3 - <<PY${NL}s = 'lands on staging${NL}not main'${NL}PY${NL}git commit -q -m 'no-track so a push never lands on staging' && git push -q origin chore/x"
t allow /tmp "cd apps/x && git commit -m 'a repo outside the workspace'"
t allow $R "cd $R/worktrees/web/x && git commit -m y"
t BLOCK $R "cd $R/apps/web && git commit -m y"
t allow $R/apps/web "W=$R/worktrees/web/x; cd \$W${NL}git add CLAUDE.md && git commit -q -m y && git push -q origin chore/x"
t BLOCK $R/worktrees/web/x "A=$R/apps/web; cd \$A && git commit -m y"
t BLOCK $R "P=$R; cd \${P}/ops/web-staging && git commit -m y"
t allow $R/apps/web "cd \$UNKNOWN_DIR && git commit -m y"
t BLOCK $R "W=$R/worktrees/x; git -C \$W push origin staging"

# --- outside a workspace: always allowed ---
t allow /tmp "git push origin main"
t allow /tmp "git push --force origin staging"
t allow $O "git push origin main"
t allow $O/apps/web "git commit -m x"

# --- nested app dirs, spaces, unicode, symlinks ---
t BLOCK $R/apps/web/src "git commit -m x"
t BLOCK $R "git -C apps/web/src commit -m x"
t BLOCK $R/worktrees "git -C ../apps/web commit -m x"
t BLOCK $R/worktrees/web "cd ../../apps/web && git commit -m x"
t BLOCK $R "cd \"apps/my app\" && git commit -m x"
t BLOCK $R "git -C 'apps/my app' commit -m x"
t BLOCK $R "git -C apps/my\\ app commit -m x"
t allow $R "cd worktrees/web/x && git commit -m x"
t allow $R/worktrees/web/x "git -C ../../../worktrees/api/x commit -m x"
t BLOCK $TMP/link/apps/web "git commit -m x"
t BLOCK $TMP/link "git push origin main"
t BLOCK $R "git -C $TMP/link/apps/web commit -m x"
t allow $TMP/link/worktrees/web/x "git commit -m x"
t BLOCK $R "cd apps/web/.. && cd apps/api && git commit -m x"
t allow $R "cd apps/web/../../worktrees/web/x && git commit -m x"
t allow $R "git commit -C HEAD -m y"                 # -C after commit is commit's own option, not a directory
t BLOCK $R "git -c commit.gpgsign=false -C apps/web commit -m y"
t BLOCK $R "git --no-pager -C apps/web commit -m y"
t BLOCK $R "git -C apps -C web commit -m y"
t BLOCK $R "(cd apps/web && git commit -m y)"
t BLOCK $R "cd apps/web && git commit -m y &"
t BLOCK $R "false || git -C apps/web commit -m y"
t BLOCK $R "git status | cat; git -C apps/web commit -m y"

# --- quoted text must not trigger, real commands around it must ---
t allow $R/worktrees/web/x "git commit -m 'docs: never git push origin main'"
t allow $R/worktrees/web/x "git commit -m \"fix; git push origin main\""
t allow $R/worktrees/web/x "git commit -m \"a && git push --force origin staging\""
t allow $R/worktrees/web/x "git commit -F - <<'EOF'${NL}git push origin main${NL}and git -C apps/web commit -m x${NL}EOF"
t BLOCK $R/worktrees/web/x "git commit -m 'it works' && git push origin main"
t BLOCK $R/worktrees/web/x "git commit -m \"x\" ; git push origin staging"
t BLOCK $R/worktrees/web/x "git commit -F - <<'EOF'${NL}message${NL}EOF${NL}git push origin main"
t BLOCK $R/worktrees/web/x "git commit -m \"unbalanced; git push origin main"
t allow $R/worktrees/web/x "echo \"git commit -m x\" # git push origin main"
t BLOCK $R/worktrees/web/x "git push origin \"main\""
t BLOCK $R/worktrees/web/x "git push 'origin' 'staging'"
t allow $R/worktrees/web/x "git commit -m 'don'\\''t push to main' && git push origin chore/x"

# --- evasions that must still be caught ---
t BLOCK $R/worktrees/web/x "bash -c 'git push origin main'"
t BLOCK $R "sh -c \"git -C apps/web commit -m x\""
t BLOCK $R/worktrees/web/x "eval 'git push --force origin x'"
t BLOCK $R/worktrees/web/x "git push \\${NL}  origin main"
t BLOCK $R/worktrees/web/x "git push origin \\${NL}  HEAD:staging"
t BLOCK $R/worktrees/web/x "git push origin :main"
t BLOCK $R/worktrees/web/x "git push origin main:main"
t BLOCK $R/worktrees/web/x "git push origin refs/heads/main"
t BLOCK $R/worktrees/web/x "echo hi && command git push origin staging"
t BLOCK $R/worktrees/web/x "x=1 git push origin staging"
t allow $R/worktrees/web/x "echo done # git push origin main"
t allow $R/worktrees/web/x "git push origin feat/a --follow-tags"

# --- critic round: path-qualified git, closing brackets, shells, variable refspecs, git-dir ---
W=$R/worktrees/web/x
t BLOCK $W "/usr/bin/git push origin main"
t BLOCK $W "\$(command -v git) push origin main"
t BLOCK $R "/usr/bin/git -C apps/web commit -m x"
t allow $W "digit push origin main"
t allow $W "echo legit push origin main"
t BLOCK $W "(git push origin main)"
t BLOCK $W "echo \$(git push origin main)"
t BLOCK $W "{ git push origin staging; }"
t BLOCK $W "echo \`git push origin main\`"
t BLOCK $R "(cd apps/web && git commit -m x)"
t BLOCK $R "(cd apps/web && git push origin main)"
t BLOCK $R "P=$R; (cd \${P}/apps/web && git commit -m x)"
t allow $W "(git push origin feat/a)"
t BLOCK $R "bash -c \"cd apps/web && git commit -m x\""
t BLOCK $R "sh -c 'cd apps/web && git commit -m x'"
t BLOCK $R "zsh -c 'cd apps/web; git commit -m x'"
t BLOCK $R "dash -c 'cd apps/web && git commit -m x'"
t BLOCK $R "bash -lc 'cd apps/web && git commit -m x'"
t BLOCK $R "bash --command 'cd apps/web && git commit -m x'"
t BLOCK $R "eval 'cd apps/web && git commit -m x'"
t allow $R "bash -c 'cd worktrees/web/x && git commit -m x'"
t BLOCK $W "b=main; git push origin \$b"
t BLOCK $W "b=staging; git push origin \"\$b\""
t BLOCK $W "b=main; git push origin HEAD:\${b}"
t BLOCK $W "b=main; git push origin \${b}"
t allow $W "b=feat/a; git push origin \$b"
t BLOCK $W "git push origin \$UNKNOWN"
t BLOCK $W "git push origin \$(git branch --show-current)"
t BLOCK $W "git push origin \"\$(git branch --show-current)\""
t BLOCK $W "git push origin \`git branch --show-current\`"
t allow $W "git push origin feat/a 2>&1 | tail -1"
t BLOCK $W "git --git-dir=$R/apps/web/.git commit -m x"
t BLOCK $W "git --git-dir $R/apps/web/.git commit -m x"
t BLOCK $W "git --work-tree=$R/apps/web commit -m x"
t BLOCK $W "git --work-tree $R/apps/web commit -m x"
t BLOCK $R "git --git-dir=apps/web/.git commit -m x"
t BLOCK $W "GIT_DIR=$R/apps/web/.git git commit -m x"
t BLOCK $W "GIT_WORK_TREE=$R/apps/web git commit -m x"
t BLOCK $W "export GIT_DIR=$R/apps/web/.git; git commit -m x"
t BLOCK $W "GIT_DIR=$R/ops/web-staging/.git GIT_WORK_TREE=$R/ops/web-staging git commit -m x"
t allow $W "GIT_DIR=$R/worktrees/api/x/.git git commit -m x"
t allow $W "GIT_AUTHOR_NAME=x git commit -m y"
t allow $O "GIT_DIR=$R/apps/web/.git git status"

# --- a very large command stays fast ---
big=$(printf 'line of a long commit message that mentions git push origin main\n%.0s' $(seq 1 3000))
s0=$(date +%s); t allow $R/worktrees/web/x "git commit -F - <<'EOF'${NL}${big}${NL}EOF"; s1=$(date +%s)
if [ $((s1 - s0)) -le 3 ]; then echo "ok   large heredoc ($(printf '%s' "$big" | wc -c | tr -d ' ') bytes) in $((s1 - s0))s"; else echo "FAIL large heredoc took $((s1 - s0))s"; fails=$((fails+1)); fi

# --- force push variants ---
t BLOCK $R "git push -fu origin fix/b"
t BLOCK $R "git push -uf origin fix/b"
t BLOCK $R "git push --force origin fix/b"
t allow $R "git push --follow-tags origin fix/b"
t allow $R "git push --set-upstream origin fix/b"

# --- protected branch lists come from workbench.json ---
t BLOCK $C "git push origin develop"
t BLOCK $C "git push origin HEAD:release/1.x"
t allow $C "git push origin main"
t allow $C "git push origin staging"
t BLOCK $C/apps/web "git commit -m x"
t allow $C/worktrees/web/x "git commit -m x"
t BLOCK $C "git push -f origin x"
t BLOCK $M "git push origin main"            # malformed marker: default list applies
t BLOCK $M "git push origin staging"
t BLOCK $M/apps/web "git commit -m x"
t allow $M "git push origin feature/x"
t allow $R "git push origin my.main"
t allow $R "git push origin main-nav"
t allow $R "git push origin release/1.x"

# --- bare push of a protected checked-out branch ---
t BLOCK $R/apps/api "git push"
t BLOCK $R/apps/api "git push origin"
t BLOCK $R/apps/api "git push origin HEAD"
t BLOCK $R "git -C apps/api push"
t allow $R/worktrees/api/x2 "git push"
t allow $R/apps/api "git push origin chore/z"

# --- hostile input and failure modes ---
run_raw() { local exp=$1 name=$2 input=$3 got
  printf '%s' "$input" | "$G" >/dev/null 2>&1; got=$?
  if [ "$got" = "$exp" ]; then echo "ok   rc=$got  $name"; else echo "FAIL rc=$got (wanted $exp)  $name"; fails=$((fails+1)); fi; }
run_raw 0 "empty stdin" ""
run_raw 0 "not json" "git push origin main"
run_raw 0 "no command" '{"cwd":"/tmp"}'
run_raw 0 "null command" '{"cwd":"/tmp","tool_input":{"command":null}}'
run_raw 0 "no cwd, unrelated" '{"tool_input":{"command":"git status"}}'
run_raw 0 "cwd does not exist" "{\"cwd\":\"/no/such/dir\",\"tool_input\":{\"command\":\"git push origin main\"}}"
run_raw 2 "cwd with spaces and unicode" "$(mkdir -p "$TMP/Wörk space/ws/apps/x" && echo '{}' > "$TMP/Wörk space/ws/workbench.json" && jq -n --arg d "$TMP/Wörk space/ws/apps/x" '{cwd:$d,tool_input:{command:"git commit -m y"}}')"
# jq missing: fail open
nojq=$(mktemp -d); for b in cat awk sed grep tr dirname head tail date find stat mkdir rm; do ln -s "$(command -v $b)" "$nojq/$b"; done
jq -n --arg d "$R" '{cwd:$d,tool_input:{command:"git push origin main"}}' | PATH="$nojq" /bin/bash "$G" >/dev/null 2>&1; rc=$?
if [ $rc = 0 ]; then echo "ok   rc=0  jq missing fails open"; else echo "FAIL rc=$rc jq missing"; fails=$((fails+1)); fi; rm -rf "$nojq"
# speed outside a workspace
s=$(date +%s); for i in 1 2 3 4 5 6 7 8 9 10; do jq -n '{cwd:"/tmp",tool_input:{command:"git push origin main"}}' | "$G" >/dev/null 2>&1; done; e=$(date +%s)
if [ $((e - s)) -le 3 ]; then echo "ok   10 outside-workspace runs in $((e - s))s"; else echo "FAIL slow outside a workspace: $((e - s))s for 10"; fails=$((fails+1)); fi

echo "$fails failed"; exit $fails
