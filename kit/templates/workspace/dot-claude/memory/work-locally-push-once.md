---
name: work-locally-push-once
description: Finish and verify locally, then push once; fewer PRs and pushes because every one triggers slow CI
metadata:
  type: feedback
---

Get a change finished locally (tests, typecheck, build, local stack, the journey it touches) and push once into one PR, rather than a stream of PRs or fix-up pushes.

**Why:** every push runs CI and often a deploy. A one-line change with three fix-ups runs the whole pipeline four times.

**How to apply:**
- Run every check that can run locally before pushing.
- Brief builders to push once at the end, and fold small fixes into a PR already in flight.
- For a big stacked build, propose one integration PR and keep the stacked PRs as read-only references. Never cascade a base branch down a whole stack and push every branch at once.
- CI still has to go green; this rule only cuts how often the cycle runs.
