---
name: workbench
description: Set up and run a workbench workspace, the one-orchestrator, many-builders way of working in Claude Code. Use when someone wants to start a project in this folder, turn a folder into a workspace, add an app or repo to the workspace, make or close a worktree for a builder, check the setup ("workbench doctor", "is everything wired up"), or asks how the workspace, the pane, the guard hooks, left undone or claude-worker work.
---

# workbench

workbench turns a folder into a workspace run by one orchestrator session (you), with builders on their own git worktrees, a live control pane, guard hooks, a left-undone gate before anything ships, shared memory, Codex parity and `claude-worker` for separate builder processes.

An empty folder becomes a workspace on its own: the global `SessionStart` hook runs `workbench init` there when a session starts. Everything below is for the other cases.

## Find out where you are

Run `workbench doctor` first. It says whether this folder is inside a workspace, and checks every part of the setup (files, hooks, plugin, `claude-worker`, apps). Act on any FAIL line before anything else.

## Jobs

| Ask | Do |
|---|---|
| Start a project here, the folder is empty | Normally already done at session start. If not: `workbench init`. |
| Start a project here, the folder has files | Ask once whether to turn it into a workspace (it adds the workbench files beside what's there and never overwrites one), then `workbench init --force`. If the files are one app's repo, recommend instead a new empty folder with `workbench add-app` pointing at that repo. |
| Add an app or repo | `workbench add-app <owner/repo or git URL> [--name <name>]`. Then read the app's own `CLAUDE.md` and rules, and add anything the orchestrator needs to know to the workspace's `CLAUDE.md` row for it. |
| Give a builder a branch | `workbench worktree <app> <branch>`, then brief the builder with that path, the goal as a check, the files it owns and the rules to read. |
| Close out a merged PR | Resolve its left-undone items, then `workbench done <app> <branch>`. |
| Many builders, or this account is low | `claude-worker start --worktree <path> --brief <file>`; `claude-worker accounts` shows which accounts have room. |
| Show what's running | `/workbench` opens the pane. |
| What's the state of everything | `workbench status`, then `notes/STATE.md`. |

## After `init` in a session that is already running

`CLAUDE.md`, the memory folder and the project settings load at session start, so in the session that created the workspace: read `CLAUDE.md` now and follow it, and tell the person that a fresh session (or `/clear`) picks up the rest. The pane, the guard hooks and the left-undone tools already work, since they come from workbench itself.

## Rules

- Never run `init --force` in someone's home folder, a repo's own folder, or a folder you weren't asked about.
- Never edit workbench's own files (`~/.workbench`) from a workspace session. workbench updates with `git -C ~/.workbench pull`.
- Rulings the person gives go in `notes/specs/rulings.json`; anything waiting on them goes under "Waiting on" in `notes/STATE.md` as numbered bold lines.
