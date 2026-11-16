---
name: one-human-step-single-ask
description: When a step needs {{OWNER}} (their token, keychain, terminal), make it one ask that works the first time
metadata:
  type: feedback
---

A step that needs {{OWNER}}'s credential is the most expensive step in any plan: each rerun interrupts them.

**Why:** most failed handovers fail on things that were checkable beforehand: output parsing in their shell, the wrong order of operations, a missing variable.

**How to apply:**
- Run every part of the command that doesn't need their credential first, in the same environment shape (variables set, stdin closed, detached process).
- Follow the documented order (the plan, the ADR, the README) so one run answers every question.
- Log enough on failure that the result is usable without a rerun.
- Say plainly that this is the only ask, and give it as one block they can paste, prefixed with `!` so it runs in the session.
