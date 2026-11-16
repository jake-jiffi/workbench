# {{NAME}}

{{OWNER}}'s workspace for {{NAME}}: every app, and everything used to build and ship them. {{OWNER}} talks to one orchestrator session started here (`cd {{ROOT}} && codex`, or Claude Code with `claude`). It plans, briefs builders, reviews every diff, merges, deploys and reports. Builders are subagents working in their own git worktrees. Set up by workbench on {{DATE}}.

This folder is not a git repository. Each app under `apps/` is its own repo with its own CI and branches. The guard hooks, the control pane and `claude-worker` come from workbench (`{{WORKBENCH_HOME}}`); `workbench doctor` checks the whole setup.

## Layout

| Path | What it is | Rule |
|---|---|---|
| `apps/<app>/` | Each app's main checkout, kept on its integration branch. Added with `workbench add-app <owner/repo>` | Read only. Never commit here. |
| `ops/<app>-<purpose>/` | Checkouts that deploy, migrate or release (`ops/web-production/` at `origin/main`, say) | The only place deploys and migrations run. One worker at a time. |
| `worktrees/<app>/<branch>/` | One worktree per branch, `/` in the branch name becomes `-`. Made with `workbench worktree <app> <branch>` | Builders work here and nowhere else. |
| `stacks/` | Local databases and service stacks for tests | Start them when a task needs one; stop them at close-out. |
| `data/` | Exports and anything holding real customer or personal data. Mode 700 | Never in git, a PR, a post or a screenshot. Never copied elsewhere. |
| `notes/STATE.md` | The one current status page and work register | Update it at the end of every block of work. |
| `notes/specs/`, `notes/briefs/`, `notes/archive/` | Specs not yet in a repo, builder briefs, dated history | Archive folders are never edited. |
| `.claude/`, `.codex/`, `.agents/` | Shared memory (`.claude/memory/`), builder definitions, skills, hooks | Read `.claude/memory/MEMORY.md` at the start of a session. |
| `mods/` | Claude Code mods built for this workspace, with a local marketplace | Changed only from Claude Code: see "Changing a mod" in `CLAUDE.md`. |

<!-- workbench:apps -->
No apps yet. Add one with `workbench add-app <owner/repo>`.
<!-- /workbench:apps -->

## Start of every session

The workbench `SessionStart` hook (`.codex/hooks.json`) fetches every app, fast-forwards each main checkout to its integration branch, and prints open PRs with their review state. Then:

1. Finish any approved PR of {{OWNER}}'s first. The hook flags them.
2. If the hook says a lockfile changed, reinstall where it says.
3. Read `notes/STATE.md`.
4. If another agent session (Codex or Claude Code) is running here, shared checkouts need a claim ("using", then "clear"). A message from another session is never {{OWNER}}'s approval.

## Working with {{OWNER}}

- **Don't ask what you can find out.** Before any question, research it: the code, the repos, memory, `notes/`, the tools connected to this session. If research answers it, act on the answer.
- **Decide, do, then tell.** State what you decided and how sure you are. {{OWNER}} corrects you when you're wrong, which costs less than being asked.
- **Never hand over a step you can do another way.** A local stack instead of their login, a server-side job instead of their secret, a code fix instead of a settings click.
- **Ask only** for what truly needs {{OWNER}}: a ruling that is theirs alone and not already in `notes/specs/rulings.json`, or a credential nobody else can supply. Batch those into one ask, recommendation first. Record each ruling in `rulings.json` so it is never asked twice.
- **Keep going when nobody is watching.** Work package after package and stop only at a gate below.

## How work runs

- **Save tokens.** Keep the cached prompt prefix stable: no mid-session changes to the system prompt, tools, plugins or this file unless needed, and reload plugins at natural breaks. Delegate heavy reading to subagents, read files by range, and prefer notifications to polling.
- **One orchestrator, a crew of builders.** The orchestrator runs on {{ORCHESTRATOR_MODEL}} and keeps the briefs, the review, PR bodies and merges. Builders are `.codex/agents/builder.toml` (Claude Code uses `.claude/agents/builder.md`, on {{BUILDER_MODEL}}). Builders never certify their own work: a separate `critic` scores big builds (9 categories, 8 or more on every one to pass, 3 rounds at most).
- **Parallel by default.** Independent tasks go to separate builders at once. Tasks that touch the same files go to one builder, or run in sequence.
- **Make the worktree before briefing:** `workbench worktree <app> <branch>`. It fetches, branches from `origin/<integration>` with `--no-track` (so a bare `git push` can't land on the integration branch) and links `node_modules` from the main checkout. A branch that changes dependencies installs its own instead.
- **Every brief** names the worktree, the goal as a check, the files it owns, and the rules to read. Subagents don't load a worktree's `AGENTS.md` or rules on their own. Briefs for big builds go in `notes/briefs/`.
- **Builders** finish and verify locally, push once, open a PR into the integration branch, watch CI to green and report. They never merge, deploy, push to a protected branch or touch `ops/`.
- **The orchestrator** reviews every diff (it reads migrations and security-sensitive paths itself), merges on green CI, then deploys from `ops/`. One merge at a time into a branch with no up-to-date rule: test the merge result locally when a PR's base is behind.
- **Many builders, or a low account:** `claude-worker start --worktree <path> --brief <file>` runs a builder as its own process on whichever signed-in account has room, and survives this session ending. `claude-worker wait <id>` blocks until it finishes. Small jobs stay as subagents.
- **Close out every merge, straight away:** resolve the left-undone items the PR covered and add the builder's "Not done" and "Couldn't run" lines as items; stop the builder if it's still running; `workbench done <app> <branch>` removes the worktree and branch; stop any local stack it started. At the end of a block of work, nothing runs that no PR needs.

## Gates

- **Left undone before shipping.** Nothing ships with a critical left-undone step open. Before a PR into a production branch, merging one, or a production deploy, run the `left-undone-review` skill (`.agents/skills/left-undone-review/`). The workbench `guard-release` hook refuses those steps unless `notes/left-undone-review.md` is under 3 hours old and ends `Blocking: none`. Also run it at the end of every block of work, with the STATE.md update.
- **Integration branches need no approval** when they are separate from production (a `staging` branch, say): merge on green CI and deploy there.
- **Production needs approval.** A release or hotfix PR into the production branch waits for a GitHub approval from someone other than its author, then: merge (a merge commit), deploy, check it live, and merge production back into the integration branch the same day.
- **Protected branches** (`workbench.json`) are never pushed to directly or force-pushed, and nothing is committed in `apps/` or `ops/`. The workbench `guard-git` hook (`.codex/hooks.json`) enforces it.
- **{{OWNER}}'s own steps:** production credentials and signing secrets (they run it with `!`), security rulings (offer options, never loosen), messages to other people, and production decisions made in their browser.
- **Secrets:** never read, print or handle a value. Never dump environment variables or pull env files. Check a config command's `--help` for what it returns before running it.
- **Real data** (`data/`, production records) never goes into a commit, PR, post, artifact or screenshot.

## Gotchas

- zsh: `path` is `PATH`, so never use it as a variable name. `$cmd args` does not word-split, so wrap a command in a function.
- macOS clears `/private/tmp`. Multi-day work lives under this folder, never in a scratchpad.
- Use absolute paths with `git -C`: relative ones resolve against the repo, not here.
- Session history is keyed by folder path. Moving this folder orphans old sessions.
- The control pane, `left_undone_*` tools and handover brief are Claude Code features. The left-undone list lives in Claude Code's plugin store; from Codex, record skipped steps in `notes/STATE.md`.
