# worktrees

One git worktree per branch: `worktrees/<app>/<branch>/`, with `/` in the branch name turned into `-`. Builders work here and nowhere else.

- Make one: `workbench worktree <app> <branch>` (fetches, branches from `origin/<integration>` with `--no-track`, links `node_modules`).
- Remove it at close-out: `workbench done <app> <branch>`.
- A mod is changed in a plain copy at `worktrees/mods/<mod>-v<N>/`, since `mods/` has no git.
