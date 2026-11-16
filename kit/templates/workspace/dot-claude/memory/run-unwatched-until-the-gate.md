---
name: run-unwatched-until-the-gate
description: Keep going through every phase of a build without waiting to be watched; stop only at production, keys, real data and approvals
metadata:
  type: feedback
---

{{OWNER}} often starts a big build and reads the results later. Stopping to ask stalls the work for hours.

**Why:** a question asked while nobody is watching costs the whole gap until they come back.

**How to apply:**
- Before handing {{OWNER}} a step, find the route that doesn't need them: a local stack instead of their login, a server-side job instead of their typing a key, a code fix instead of a settings click.
- Build package after package (builder, independent critic, fix, merge, integration checks) without waiting between waves.
- Steps that truly need a person go on "Waiting on {{OWNER}}" in `notes/STATE.md`, with the decision taken for them recorded so they can veto it.
- Never without {{OWNER}}: production writes, keys, production migrations, real customer data, messages to other people, and merging into a production branch on your own approval.

Related: [[one-human-step-single-ask]], [[left-undone-gates-shipping]].
