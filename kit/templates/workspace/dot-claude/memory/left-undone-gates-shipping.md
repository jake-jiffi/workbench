---
name: left-undone-gates-shipping
description: Nothing ships with a critical left-undone step open; the left-undone-review skill and the workbench guard-release hook enforce it
metadata:
  type: feedback
---

Promised checks (a live test, a migration check, an approval condition) must not still be open when a feature ships.

**Why:** a build can look finished while the steps that prove it works are still only promised.

**How to apply:**
- Call `left_undone_add` the moment you promise something or skip a check; `left_undone_resolve` with the proof when it's done.
- Run the `left-undone-review` skill before a PR into a production branch, merging one, or a production deploy; after closing out each merge; at the end of each block of work; at session start.
- The workbench `guard-release` hook refuses shipping commands unless `notes/left-undone-review.md` is under 3 hours old and ends `Blocking: none`. Anything tied to what ships, or to a security, consent or vendor condition, blocks until done or deferred by {{OWNER}} in their own words. Never write `Blocking: none` to get past it.
