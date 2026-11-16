# workbench (the control pane)

A Claude Code plugin for a workbench workspace: the folder run by one orchestrator session, with builders in their own worktrees. It shows, beside the chat, what the orchestrator has running, what needs the owner, and what Claude itself said it would do and has not.

It is active only inside a workspace: a folder holding `workbench.json`, found by walking up from the session's folder. Anywhere else it does nothing: no pane, band, status line, toast, polling or tools, and no prompt text. If the marker appears while a session is running (the auto-init hook writes it into an empty folder), the next 15-second check wakes it. The model's tools are registered at session start only, and only in a workspace or in an empty folder the auto-init hook would turn into one, so other projects pay nothing in prompt tokens.

Left undone, the context card, the cache timer and the card layout draw on terminal-desk by Doonminus2 (MIT, github.com/Doonminus2/claude-code-TerminalDesk-Plugin). Adapted code is marked in the source and the licence is in NOTICE. The handover brief and the door draw on context-watch by spychiatrist (MIT, github.com/spychiatrist/context-watch). Ideas only; no code copied.

## Where it gets its facts

`workbench.json` at the workspace root:

```json
{
  "owner": "Sam",
  "apps": [
    { "name": "web", "repo": "acme/web-app", "integration": "staging", "production": "main" }
  ]
}
```

- `owner` names the person in the waiting card heading and the handover brief. Missing: "you".
- Each app's `repo` is read with `gh`. `integration` is the branch builders branch from and open PRs into; `production` is the branch releases go into (`integration` defaults to `production`, `production` to `main`). An optional `noRunner` list names CI jobs with no runner, which are left out of the CI counts.
- A malformed or unreadable file still makes a workspace, with no owner and no apps. An app with a bad repo or branch name is skipped. The file is re-read every 15 seconds, so `workbench add-app` shows up without a restart.

## What it shows

The pane (`/workbench`) is a column of boxed cards, most urgent first. A card's border is red only when a person must act now.

| Card | What is in it | Border |
|---|---|---|
| Context nearly full | Only at the urgent level (80% by default): `/clear` and `/compact` buttons | red, heavy |
| Waiting on `<owner>` | The numbered bold lines under `## Waiting on <owner>` (or `## Waiting on you`) in `notes/STATE.md`, nine rows then "and N more" | red when any |
| Left undone | Claude's own open commitments (below). Not the owner's | amber when any |
| Workers | Every subagent, its age and worktree, a warning when one has gone quiet for 10 minutes; then `claude-worker` workers | amber if one is quiet, silent or failed |
| Pull requests | Every app's PRs by next step (approved, CI red, needs review, CI running, green, draft). Only a PR into an app's production branch needs a review and a release. Bots collapse to one line. A `hold` label beats "ready to merge" | red for approved, red CI or changes requested; amber while CI runs |
| Production | Per app: how many commits its integration branch is ahead of its production branch | grey |
| Context | Tokens used, a bar by category, `/clear` and `/compact` at the warning level, `b` handover brief, `n` compact now | grey, amber at 60%, red at 80% |
| Prompt cache | Warm or cold, a countdown, the size of the next message, the hit ratio | green when warm |
| Accounts | This session's account (by email), its 5-hour and weekly meters, the model line, other known accounts, swap buttons | green, amber at 80%, red at 95% or after a billing, auth or rate-limit error |
| Swap account / Account changed | Only when open: what is at risk, what changes, the move button | red while held, amber when free |

Above the prompt, the band shows `Workbench 3 working · PRs 4✓ 1◌ 0✗ · 2 for you · 5 undone` with Pane and Hide. The status line carries the same counts in under 80 characters. Toasts cover a PR opened, CI green, a PR merged or closed, a worker done, the context getting full and `+3 left undone`. macOS notifications are for CI failed, a PR approved, changes requested and a worker that failed.

## claude-worker workers

`claude-worker` runs builders as separate Claude processes. The mod reads their state files, view only: `~/.claude/workers/w/<id>/state.json` (`state.json.prev` when that does not parse) and the `name` from `spec.json`. No other file is opened and nothing is written. Running workers add to the working count; a running worker whose state has not been rewritten for over a minute is marked `!` and `no heartbeat`.

## Left undone

Claude's own promises and loose ends, kept across `/clear` and restarts. The owner's waiting list is separate: the two are never merged, and a candidate that restates a waiting line is dropped.

It reads a builder's final report (the headings `Not done`, `Couldn't run it`, `Noticed, left alone`), the orchestrator's own final answer (a promise with a deferral cue, or a plain admission), new `TODO` and `FIXME` lines in edits, and Claude's own `left_undone_add` calls. It never reads the transcript. Items are de-duplicated, capped, clipped to 200 characters, and masked for emails and long opaque strings. They live in `$.store` on this machine and are written nowhere else.

`✓ done` resolves an item, `– drop` blocks the same words for 14 days, `x` twice clears all, `f` puts a request to finish them in the prompt box (it sends only with `finishSends` on). Claude resolves with `left_undone_resolve`; those show in a fold with a reopen button for 7 days.

Five tools are registered once at session start (`left_undone_add`, `left_undone_resolve`, `left_undone_list`, `handover_brief`, `handover_clear`) and one static section is added to the system prompt, the same text on every request, so the prompt cache is never broken by this plugin.

## Accounts, usage and the swap

Which account is this session on, how full are its limits, where could it move to. Identity comes from `claude auth status --json` (email, plan and organisation id only, kept in memory); other accounts are read with `claude -p /usage --no-session-persistence` (no model call), at most every 15 minutes by default and only while the pane is on screen or a warning is live. The default account (`~/.claude`) is read with `CLAUDE_CONFIG_DIR` removed, never set to it.

Warnings come once per level per window. A move needs a `claude` wrapper that reads `~/.claude/swap-requests/<wrapper pid>.json` and sets `CLAUDE_WRAPPER_PID`; without one the button fills `/exit` and the sheet says to start `claude` on the other account afterwards. The automatic move (`autoMovePct`, 94, 0 is off) happens only when nothing is at risk. The mod never runs `/login`, reads a login file, or reads shell start-up files.

## Handover and the door

`b` on the Context card fills the prompt with a request to Claude: call `handover_brief` with `last_ask` (the last thing the owner asked, verbatim, 600 characters), then `handover_clear`. The brief is built from pointers (the `briefFiles` list, never contents), running workers, open PRs, the waiting list, left undone and static rules. `handover_clear` refuses while a worker is running unless it is named in `carry`, and while a PR into a production branch is open unless it is named in `watchers`; `b` twice lifts the door for 2 minutes. A prompt from the owner cancels a queued clear.

## Settings

Stored in `~/.claude/settings.json` as `pluginConfigs["workbench@workbench"].options`.

| Setting | Default | |
|---|---|---|
| `autoOpen` | on | Open the pane when a session starts in a workspace |
| `warnPercent` / `urgentPercent` | 60 / 80 | Context amber and red |
| `cacheTtl` | `1h` | `5m` or `1h`. The engine does not report which |
| `finishSends` | off | `f` sends instead of filling the prompt |
| `undoneRetentionDays` | 14 | Stale tag, and how long a dropped item's words stay blocked |
| `accounts` | `main=~/.claude` | `label=folder` list the usage probe reads, comma separated |
| `accountNotes` | empty | `label=note`, shown until a reading replaces it |
| `usageProbeMinutes` | 15 | How often another account is read |
| `usageWarnPercent` / `weekWarnPercent` / `usageUrgentPercent` | 80 / 90 / 95 | Account warnings |
| `autoMovePct` | 94 | Automatic move at this fill of either meter. 0 is off |
| `briefFiles` | `notes/STATE.md, CLAUDE.md, .claude/memory/MEMORY.md` | Pointers in the handover brief |
| `handoverClear` | off | The handover runs `/clear` itself |
| `connectorProbe` | empty | `server|tool`, one read-only call to check a connector after a swap |

## How it gets its data

- Workers: the `agent.spawn` event and `$.agent.list()` every 5 seconds; `claude-worker` state files every 15 seconds.
- GitHub: `gh pr list` and `gh api repos/<repo>/compare/<production>...<integration>` for each app, every 90 seconds and 5 seconds after any `gh pr`, `gh run` or `git push` command. `gh` and `claude` are found on the session's PATH.
- `notes/STATE.md`: the numbered bold items under the owner's waiting heading.
- Context, cost and session time: `$.session.usage()` and `session.measure`.
- Cache: the time the last main-loop reply finished and the token counts it reported. An estimate, not a reading from Anthropic.

It reads only. It never writes to GitHub or the repos.

## Working on it

- Layout: `hooks/register.tsx` has the hooks and atoms; `hooks/lib/` has the pure parts (`undone.ts`, `usage.ts`, `summary.ts`, `format.ts`, `github.ts`, `workspace.ts`) and the drawing (`cards.tsx`, `view.tsx`, `usageview.tsx`, `band.tsx`).
- Check: `claude plugin validate .`, `tsc -p .` (the engine writes `.claude-plugin/types/` when it loads the plugin, which `tsc` needs; it is not committed) and `claude plugin test .`. Then `grep -rnE '\.credentials|security |printenv|keychain|authorize|\.zshrc|claude-use' hooks` must print nothing.
- The engine refuses `$` held in an object, a state atom read from a file that does not declare it, and (for `tsc`) a `tool.call` matcher that names an MCP tool. Each file declares the atoms it uses.
- Tools the plugin registers return `{ result: <plain text>, isError }`.
