# Memory

One line per memory. The first 200 lines of this file load every session, in this folder and in every app (`autoMemoryDirectory`). workbench seeded the first six on {{DATE}}; edit or delete any that stop being true.

- [One orchestrator, a crew of builders](orchestrator-and-builders.md): {{ORCHESTRATOR_MODEL}} plans, briefs, reviews and merges; builders on {{BUILDER_MODEL}} build in worktrees; a separate critic scores
- [Save tokens](token-economy.md): keep the cached prompt stable, delegate heavy reading, prefer notifications to polling
- [Finish locally, push once](work-locally-push-once.md): every push runs CI; verify locally and push one PR
- [Run unwatched until a gate](run-unwatched-until-the-gate.md): keep going through every phase; stop only at production, keys, real data and approvals
- [One ask, right first time](one-human-step-single-ask.md): when a step truly needs {{OWNER}}, make it a single ask that works on the first run
- [Left undone gates shipping](left-undone-gates-shipping.md): nothing ships with a critical promised step still open
