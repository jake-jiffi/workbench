# apps

Each app's main checkout, one repo per folder. Add one with `workbench add-app <owner/repo>`: it clones the repo here, checks out its integration branch (`staging` when the repo has one, else the default branch), points the app's memory at this workspace's `.claude/memory`, and adds a row to `CLAUDE.md`.

Main checkouts are read only. Nobody commits here: the guard hook refuses it. Work happens in `../worktrees/<app>/<branch>/`.
