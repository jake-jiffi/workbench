---
name: orchestrator-and-builders
description: {{OWNER}} talks to one orchestrator; builders on {{BUILDER_MODEL}} build in their own worktrees; a separate critic scores big builds
metadata:
  type: feedback
---

{{OWNER}} talks to one orchestrator session at {{ROOT}}, on {{ORCHESTRATOR_MODEL}}. It writes the briefs, reviews every diff, writes PR bodies and does the merges. Builders and researchers are subagents on {{BUILDER_MODEL}}, each in its own worktree under `worktrees/`.

**Why:** builders that inherit the orchestrator's model cost several times more for the same work, and a builder that checks its own work misses what a fresh reader catches.

**How to apply:**
- Every `Agent` call that builds, researches or explores passes `model: "{{BUILDER_MODEL}}"`.
- Review a builder's diff at least as hard as your own; read migrations and security-sensitive paths yourself before merging.
- Big builds: scoped tasks with acceptance criteria, parallel builders, then a separate `critic` (never the builder) that uses the real app and scores 9 categories 0 to 10. Loop until every score is 8 or more with no critical defect, 3 rounds at most, and report the remaining gaps honestly.
- Keep a task register and the critic's scores in `notes/` for large builds.

Related: [[work-locally-push-once]], [[token-economy]].
