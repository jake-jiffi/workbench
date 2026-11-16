# claude-worker

Runs Claude Code workers on any of your signed-in accounts, from one main session. Node 20+, no dependencies.
Entry point `bin/claude-worker`, code in `worker/`, state in `~/.claude/workers/` (mode 700, files 600;
`CLAUDE_WORKER_HOME` overrides it). Keep `workers` out of any shared or linked account slot: it is state for this machine.

## Setup

Accounts come from the private config, `~/.config/workbench/config.json` (`WORKBENCH_CONFIG` overrides the path):

```json
{ "accounts": [ { "label": "main", "dir": "~/.claude" }, { "label": "work", "dir": "~/.claude-work" } ] }
```

- `label`: letters, digits, `.`, `_`, `-`. `dir`: the account's Claude config folder; `~` is expanded.
- `dir` equal to the default config folder (`~/.claude`) marks the default account: the worker **removes**
  `CLAUDE_CONFIG_DIR` for it and never sets it to `~/.claude` (pointing it there selects a different Keychain entry and
  loses the sign-in). Every other account gets `CLAUDE_CONFIG_DIR=<dir>`.
- No config file, or no `accounts`, means one account: `main`, the default folder.
- A config that exists but is not valid JSON, or has a bad account entry, is an error naming the file. A folder that does
  not exist is listed as not eligible (`config folder not found`); no `claude` is started on it.
- Sign each account in once, with `CLAUDE_CONFIG_DIR=<dir> claude` then `/login` (the default account: plain `claude`).

Other places it looks, all overridable for tests: the install at `$WORKBENCH_HOME` (default `~/.workbench`), guard hooks at
`$WORKBENCH_HOME/kit/hooks/guard-git.sh` and `guard-release.sh`, the `claude` binary (`CLAUDE_WORKER_BIN`, else `claude` on
PATH, else `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`).

The workspace folder is the first folder at or above the worktree that holds `workbench.json`. A worktree outside any
workspace still works; `start` says no workbench.json was found (the `note` field in `--json`) and the workspace's agents
are not searched.

## Commands (each takes `--json`; an id may be the worker's `--name`)

| Command | What it does |
|---|---|
| `accounts` | Org, plan, 5-hour %, weekly %, reading age, slots used, eligible yes/no with the reason. |
| `start --worktree P --brief F [--agent A] [--model M] [--account L] [--name N] [--force]` | Picks an account, reserves a slot, records the worker, launches a detached supervisor, returns the id. With no room anywhere it queues (`waiting`). `--account` must pass eligibility unless `--force`. |
| `status [id]` | All workers or one. Revives any whose supervisor died. |
| `result <id>` | The final text of a worker that is `done` (exit 1 for failed or stopped, 2 if still running). |
| `wait <id...> [--timeout S]` | Blocks until all are finished, printing each outcome. Run it with `run_in_background`; its exit is the notification. Revives dead supervisors while it waits. Exit 0 only if all are `done`, 124 on timeout. |
| `stop <id>` | Stops the worker's whole process tree and frees its slot. |
| `send <id> --file F [--account L]` | Continues a finished worker's conversation with a follow-up (`--resume`). |
| `recover` | Adopts or resumes workers whose supervisor died. Several at once are safe. |
| `selftest [--only a,b] [--keep]` | Real runs on eligible accounts in a scratch workspace (its own `workbench.json`, an app checkout, a worktree, a local bare remote, a scratch agent; nothing you own): `env-tools` (read-only `git ls-remote` of the local bare remote, `gh auth status` reported only, and the node version, from the child env), `finishes`, `guard`, `agent`, `survives`, `cross-account` (needs two eligible accounts, else skipped). |

## Eligibility and choice

An account takes a new worker only when it is signed in, its reading is at most 5 minutes old (else one probe, one at a
time per account), both meters are below 90 (89 yes, 90 no), it has no recent limit error, and it has a free slot
(4 per account, 20 in total). An unreadable account never has room. The probe is `claude -p /usage
--no-session-persistence` under that account's environment, parsed from its 5-hour and weekly lines. A week line
with no session line means no 5-hour window is open: the session counts as 0 and `accounts` marks it `*`. A fraction rounds
up (89.6 reads as 90).

Choice: most headroom (100 minus the higher meter); the account the calling session is on goes last when another is
eligible. Starts on one account are 2 seconds apart.

## Launch

The child gets an allow-list environment (PATH, rebuilt with the running node's own folder first, per-shell fnm folders removed and the standard system folders always present; HOME, USER, LOGNAME, SHELL, LANG, TMPDIR, TERM, DISABLE_AUTOUPDATER and,
for non-home accounts, `CLAUDE_CONFIG_DIR`). The default account has the variable removed. Nothing else of the
parent's environment, including `CLAUDE_*`, `ANTHROPIC_*` and exported secrets, is passed. The command is
`caffeinate -i claude -p --output-format stream-json --verbose --dangerously-skip-permissions --settings <file> ...` run in
the worktree with the brief on stdin; stdin, stdout and stderr are files, not pipes. The settings file adds `guard-git.sh`
and `guard-release.sh` as PreToolUse Bash hooks (merged over the worktree's own settings). Start refuses if either hook is
missing. `CLAUDE_WORKER_BIN` replaces the binary (tests).

`--agent NAME` is looked up in the worktree and every folder above it (`.claude/agents`), then the workspace's, then
`~/.claude/agents`, and passed as `--agent NAME --agents '{...}'` with its prompt and model, because Claude Code does not
find a definition kept above the worktree on its own. With `--agent` and no `--model`, the agent's own model applies;
otherwise the default is `sonnet`. With no `--agent`, the default agent `builder` is used if the worktree's or the
workspace's `.claude/agents` has one (not the user folder); `--agent none` skips it.

## States

`waiting` (queued, or between legs with no account) -> `running` -> `done` | `failed` | `stopped`. Every terminal state
records `reason` and `onDisk` (HEAD, branch, dirty files). `done` needs a `result` event with `is_error` false from the
stream; an exit 0 without one is a crash.

## Failover

A worker is one conversation run as legs (at most 5 per run; `send` starts a new count).

- **Limit, rate-limit or auth error.** Read from structured fields first: a failed `result`'s `api_error_status` and
  `api_error` (429 or `usage_limit_reached` is a limit, 401 or an authentication error is auth), a rejected
  `rate_limit_event` (its `resetsAt` is the reset), an assistant `error` field. Text is a fallback only when the fields are
  absent, and a bare number never counts: `401` or `429` must follow an API error marker. A non-error result is never
  classified. The account cools until the stated reset, else for 5 minutes and then until a
  probe shows both meters below 90. The session resumes (`--resume`) on another eligible account with a short continuation
  prompt. Ordinary prose that mentions a limit is ignored.
- **Transient API error** (5xx, 529, `overloaded_error`, timeouts): the service, not the account, so nothing is cooled.
  Backoff (5 s, doubling, 60 s at most), same account once, then another, inside the leg cap.
- **94%:** the supervisor re-reads the account every 3 minutes. At 94 or more on either meter, with no tool in flight, and
  another account eligible, it stops the leg and resumes elsewhere. Below 94 the worker carries on even past 90 (the account
  just gets no new workers). With nowhere to go it carries on.
- **No account:** state `waiting`, re-checked with backoff (30 s up to 5 min); `failed: no account` after 8 hours.
- **Crash without a result:** retry on the same account once, then another. Two legs in a row with no progress fail the
  worker.
- **Stall:** no stream output and no tool in flight for 20 minutes, or one tool in flight over 60: the process tree is killed
  and the session resumed once; a second stall fails it.
- **Supervisor died:** `status`, `wait` and `recover` start a new one. It adopts a live child, or resumes if the child is gone.
  Not counted as a crash.

## Supervisor and state

One detached supervisor per worker (own session, survives the main session and account moves). State writes are temp file,
fsync, rename, with `state.json.prev` kept; a per-worker directory lock serialises writers; pid plus process start time
identify every process, so a reused pid is never trusted or killed. `final.json` is written before the last state change so a
damaged state file cannot bring a finished worker back. If both state copies are lost, state is rebuilt from `spec.json`, the
`leg-N.json` files and the streams. Heartbeat every 15 seconds.

## Not covered

- A supervisor killed in the milliseconds between spawning a leg and recording it leaves an unrecorded child that recover
  cannot see.
- A tool process that double-forks out of the worker's tree (reparented to launchd, own group) survives `stop`.
- Resume after a hard kill relies on Claude Code accepting a session whose last message was cut off.
- Reset times are used only when the stream gives an epoch; `/usage` reset text (a local time with a zone name) is not parsed.
- Limit and auth error shapes beyond those seen in fixtures are matched by text; a new wording would count as a crash.
- Nothing watches for a leg that ends inside the 3-minute reading gap and lands on an account that has just filled up.
- Cross-account resume is exercised by `selftest cross-account`, which needs two eligible accounts.
- Each real worker costs a full prompt cache write (about 65-115k tokens) on its account.
