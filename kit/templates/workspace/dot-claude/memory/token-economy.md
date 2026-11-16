---
name: token-economy
description: Save tokens as a core rule. Keep the cached prompt prefix stable, batch anything that rewrites it, and keep the orchestrator's context lean
metadata:
  type: feedback
---

The orchestrator runs for hours with a large context, and prompt caching bills every rewrite of the cached prefix in full.

**Why:** a changed system prompt, tool list, plugin or `CLAUDE.md` mid-session rewrites the whole cached prefix, and an idle gap longer than the cache lifetime lets it lapse.

**How to apply:**
- Keep the prefix stable: change tools, plugins, mods or `CLAUDE.md` mid-session only when needed, batched, and reload at a natural break (session start, after a compaction).
- Keep the orchestrator lean: delegate heavy reading to subagents, read files and logs by grep, tail or a line range, never re-read what is already in context, keep replies short.
- Prefer notifications to polling: background watchers with long intervals (CI at 120 s), acted on when they fire.
- Builders run only the tests their change touches; CI runs the full suite. Several full suites at once overload the machine and make timing tests fail for no code reason.

Related: [[orchestrator-and-builders]].
