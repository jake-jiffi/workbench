#!/bin/bash
# Regression suite for guard-release.sh. Run after any edit: bash kit/hooks/test-guard-release.sh
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
tmp=$(cd -P "$tmp" && pwd -P)
R="$tmp/ws"; mkdir -p "$R/notes" "$R/apps/web" "$tmp/plain" "$tmp/stub"
cat > "$R/workbench.json" <<'J'
{"workbench":1,"apps":[
  {"name":"web","repo":"acme/web-app","integration":"staging","production":"main"},
  {"name":"api","repo":"acme/api","integration":"develop","production":"release"},
  {"name":"solo","repo":"acme/solo","integration":"main","production":"main"}],
 "shipPatterns":["(^|[[:space:];&|(])npm[[:space:]]+run[[:space:]]+deploy([[:space:]]|$)","release\\.mjs"]}
J
REVIEW="$R/notes/left-undone-review.md"
# a stub gh that reports the base branch of PR 7 as main, 8 as staging, and fails for anything else
cat > "$tmp/stub/gh" <<'S'
#!/bin/bash
case "$*" in
  *"pr view 7 "*) echo main ;;
  *"pr view 8 "*) echo staging ;;
  *"pr view --json"*) echo main ;;
  *"pr view 9 --repo acme/web-app"*) echo main ;;
  *) exit 1 ;;
esac
S
chmod +x "$tmp/stub/gh"
export PATH="$tmp/stub:$PATH"
pass=0; fail=0
run() { # run <expect 0|2> <name> <command> [cwd]
  local got
  jq -n --arg c "$3" --arg d "${4:-$R}" '{tool_input:{command:$c}, cwd:$d}' | bash "$here/guard-release.sh" >/dev/null 2>&1; got=$?
  if [ "$got" = "$1" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL ($got, wanted $1): $2"; fi
}

# Not shipping: always allowed, review or not.
run 0 "plain git" "git status"
run 0 "PR into integration" "gh pr create --base staging --title x"
run 0 "PR with no base" "gh pr create --title x"
run 0 "npm run deploy-staging is not deploy" "npm run deploy-staging"
run 0 "merge of a staging PR" "gh pr merge 8 --squash"
run 0 "merge of an unknown PR (gh fails)" "gh pr merge 99 --squash"
run 0 "commit message that mentions a deploy" "git commit -m 'fix npm run deploy docs'"
run 0 "heredoc that mentions a deploy" "cat <<EOF > notes.md
npm run deploy
gh pr create --base main
EOF"
run 0 "echo of a ship command" "echo 'npm run deploy'"

# Shipping with no review file: blocked.
run 2 "PR into main, no review" "gh pr create --base main --head release/2026-11-10"
run 2 "PR into main, quoted base" 'gh pr create --base "main" --title x'
run 2 "PR into main, single-quoted -B" "gh pr create -B 'main'"
run 2 "PR into main, -B" "gh pr create -B main --head hotfix/x"
run 2 "PR into main, --base=" "gh pr create --base=main"
run 2 "PR into the api production branch" "gh pr create --base release"
run 2 "deploy pattern, no review" "cd ops/web-production && npm run deploy"
run 2 "second pattern" "node scripts/release.mjs 2.3.6"
run 2 "merge of a PR into main" "gh pr merge 7 --squash"
run 2 "merge by url" "gh pr merge https://github.com/acme/web-app/pull/9 --merge"
run 2 "merge with flags first" "gh pr merge --squash --delete-branch 7"
run 2 "merge of the current branch's PR" "gh pr merge --squash"
run 2 "merge after other commands" "git fetch && gh pr merge 7 --merge"
run 2 "deploy inside sh -c" "bash -c 'npm run deploy'"
run 2 "deploy after a quoted semicolon" "echo 'a;b' && npm run deploy"
run 2 "no workspace at cwd, cd into one" "cd $R/apps/web && npm run deploy" "$tmp/plain"

# Outside a workspace: nothing.
run 0 "outside, deploy" "npm run deploy" "$tmp/plain"
run 0 "outside, PR into main" "gh pr create --base main" "$tmp/plain"
run 0 "cwd missing" "npm run deploy" "/no/such/dir"

# A fresh review with blockers: blocked.
printf 'scope: release\nU5 | blocking | live test\nBlocking: U5\n' > "$REVIEW"
run 2 "fresh review, blocking" "gh pr create --base main"

# A review without the closing line: blocked.
printf 'scope: release\nU5 | done | proof\n' > "$REVIEW"
run 2 "no Blocking line" "gh pr create --base main"

# A fresh review with nothing blocking: allowed.
printf 'scope: release\nU5 | done | proof\n\nBlocking: none\n' > "$REVIEW"
run 0 "fresh review, PR" "gh pr create --base main"
run 0 "fresh review, deploy" "npm run deploy"
run 0 "fresh review, merge" "gh pr merge 7"
printf 'x\nBlocking: none\n\n\n' > "$REVIEW"
run 0 "trailing blank lines after the Blocking line" "npm run deploy"

# A stale review: blocked.
touch -t "$(date -v-4H +%Y%m%d%H%M 2>/dev/null || date -d '4 hours ago' +%Y%m%d%H%M)" "$REVIEW"
run 2 "stale review" "gh pr create --base main"

# GUARD_RELEASE_REVIEW override
printf 'Blocking: none\n' > "$tmp/other.md"; rm -f "$REVIEW"
export GUARD_RELEASE_REVIEW="$tmp/other.md"
run 0 "override path, fresh" "npm run deploy"
unset GUARD_RELEASE_REVIEW

# Malformed workbench.json: no production branches known, shipPatterns unreadable: allow, never crash.
mkdir -p "$tmp/bad"; echo '{oops' > "$tmp/bad/workbench.json"
run 0 "malformed workbench.json" "gh pr create --base main" "$tmp/bad"
# Hostile input
for raw in '' 'not json' '{}' '{"cwd":"/tmp"}' '{"tool_input":{"command":null}}'; do
  printf '%s' "$raw" | bash "$here/guard-release.sh" >/dev/null 2>&1; got=$?
  if [ "$got" = 0 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL ($got): raw input '$raw'"; fi
done

echo "guard-release: $pass passed, $fail failed"
[ "$fail" = 0 ]
