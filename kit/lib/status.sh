# workbench status: what to look at at the start of a session. Sourced after common.sh. Bash 3.2 safe.
# wb_status <root>: fetch each app, fast-forward its main checkout to origin/<integration> when it is on that
# branch, flag a changed lockfile, show how far integration is ahead of production, open PRs and approved PRs.

wb_lockfiles() { git -C "$1" ls-files -s -- '*package-lock.json' '*pnpm-lock.yaml' '*yarn.lock' '*bun.lock' '*bun.lockb' 2>/dev/null | awk '{print $2}' | tr '\n' ' '; }

wb_status() {
  local root=$1 wj="$1/workbench.json" tmp i=0 name repo integ prod d branch before after ahead prs approved line
  local SEP=$'\037' have_gh=0 names=() repos=() integs=() prods=()
  command -v gh >/dev/null 2>&1 && have_gh=1
  echo "## Workspace check ($(date '+%a %d %b %H:%M'))"
  while IFS="$SEP" read -r name repo integ prod; do
    [ -z "$name" ] && continue
    names[$i]=$name; repos[$i]=$repo; integs[$i]=$integ; prods[$i]=$prod; i=$((i + 1))
  done < <(jq -r --arg s "$SEP" '.apps[]? | select(.name != null) | [.name, (.repo // ""), (.integration // .production // "main"), (.production // .integration // "main")] | join($s)' "$wj" 2>/dev/null)
  if [ "$i" = 0 ]; then
    echo "- No apps yet. Add one with: workbench add-app <owner/repo>"
  else
    tmp=$(mktemp -d 2>/dev/null) || tmp=""
    if [ -n "$tmp" ]; then
      # Fetch and list PRs for every app at once; each is time limited.
      local k
      for ((k = 0; k < i; k++)); do
        d="$root/apps/${names[$k]}"
        [ -d "$d/.git" ] || [ -f "$d/.git" ] || continue
        (
          GIT_TERMINAL_PROMPT=0 wb_timeout 20 git -C "$d" fetch --quiet --prune origin >/dev/null 2>&1
          if [ "$have_gh" = 1 ]; then
            if [ -n "${repos[$k]}" ]; then rflag=(--repo "${repos[$k]}"); else rflag=(); fi
            (cd "$d" && wb_timeout 12 gh pr list "${rflag[@]}" --state open --json number,title,author,baseRefName,reviewDecision,isDraft \
              --jq '.[] | "  #\(.number) [\(.baseRefName)] \(.author.login)\(if .isDraft then " draft" else "" end) \(.reviewDecision // "") \(.title)"' > "$tmp/$k.prs" 2>/dev/null)
            (cd "$d" && wb_timeout 12 gh pr list "${rflag[@]}" --author @me --state open --json number,reviewDecision \
              --jq '.[] | select(.reviewDecision=="APPROVED") | "#\(.number)"' > "$tmp/$k.approved" 2>/dev/null)
          fi
        ) &
      done
      wait
    fi
    approved=""
    for ((k = 0; k < i; k++)); do
      name=${names[$k]}; integ=${integs[$k]}; prod=${prods[$k]}; d="$root/apps/$name"
      if [ ! -d "$d/.git" ] && [ ! -f "$d/.git" ]; then echo "- $name: no checkout at apps/$name. Re-add it with: workbench add-app <owner/repo> --name $name"; continue; fi
      before=$(wb_lockfiles "$d")
      branch=$(git -C "$d" branch --show-current 2>/dev/null)
      if [ "$branch" = "$integ" ]; then
        git -C "$d" merge --quiet --ff-only "origin/$integ" >/dev/null 2>&1 || echo "- $name: could not fast-forward the main checkout to origin/$integ. Look at it."
      else
        echo "- $name: main checkout is on '${branch:-detached HEAD}', expected $integ."
      fi
      after=$(wb_lockfiles "$d")
      [ "$before" != "$after" ] && echo "- $name: a lockfile changed. Reinstall dependencies in apps/$name."
      if [ "$integ" != "$prod" ]; then
        ahead=$(git -C "$d" rev-list --count "origin/$prod..origin/$integ" 2>/dev/null)
        echo "- $name: $integ $(git -C "$d" rev-parse --short "origin/$integ" 2>/dev/null), ${ahead:-?} commits ahead of $prod. Open PRs:"
      else
        echo "- $name: $integ $(git -C "$d" rev-parse --short "origin/$integ" 2>/dev/null). Open PRs:"
      fi
      if [ "$have_gh" = 0 ]; then echo "  (gh not installed: PR list unavailable)"
      elif [ -n "$tmp" ] && [ -s "$tmp/$k.prs" ]; then cat "$tmp/$k.prs"
      elif [ -n "$tmp" ] && [ -f "$tmp/$k.prs" ]; then echo "  none"
      else echo "  (unavailable)"; fi
      [ -n "$tmp" ] && [ -s "$tmp/$k.approved" ] && approved="$approved $(sed "s/^/$name /" "$tmp/$k.approved" | tr '\n' ' ')"
    done
    [ -n "$tmp" ] && rm -rf "$tmp"
    [ -n "$approved" ] && echo "- APPROVED and waiting to merge (finish these first):$approved"
  fi
  echo "- Status page: notes/STATE.md. Shared memory: .claude/memory/MEMORY.md."
  return 0
}
