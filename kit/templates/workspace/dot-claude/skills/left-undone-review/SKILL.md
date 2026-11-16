---
name: left-undone-review
description: Review the workbench left-undone list and clear it out, so nothing ships with a critical step still open. Use before opening a PR into a production branch, merging one, or a production deploy (the guard-release hook refuses those without a fresh review); after closing out each merge; at the end of a block of work with the STATE.md update; and at session start.
---

# Left-undone review

Nothing ships with a critical step still open. The list is the workbench pane's store: read it with `left_undone_list`, change it with `left_undone_resolve` and `left_undone_add`.

## When

| Moment | Scope | Output |
|---|---|---|
| Before a PR into a production branch, merging one, a production deploy | Everything that ships, plus anything security or data related | `notes/left-undone-review.md`, ending `Blocking: none` or `Blocking: U<n>, …` (the hook reads it) |
| After closing out a merge | Items that PR covered, and the builder's "Not done" and "Couldn't run" lines | Resolve covered items; add new ones |
| End of a block of work | The whole list | Resolve, then update "Waiting on {{OWNER}}" in STATE.md |
| Session start | A glance | Act on anything blocking |

## Steps

1. `left_undone_list`. For a release, also list what ships: the merge commits between the production branch and the integration branch for each app (`git log --merges origin/<production>..origin/<integration>`), with their PR numbers and titles, and any migrations among them.
2. Put every open item in exactly one bucket:
   - **Done**: prove it (a passing check, a merged PR, a live read), then `left_undone_resolve` with a one-line note naming the proof. Never resolve on belief.
   - **Do now**: cheap and within reach (a test run, a check, a doc line). Do it, then resolve it.
   - **Blocking**: tied to something that ships, or to a security, data, consent or vendor condition: a PR in the release, a migration not applied or checked, a test not run, a live check promised, an approval condition. Blocking until done, or until {{OWNER}} defers it in their own words in this conversation.
   - **{{OWNER}}'s**: needs their credential, ruling or clicks. Batch these into one ask, recommendation first. They block only if tied to what ships.
   - **Later**: tied to nothing that ships. Say why in one line.
   An item you cannot place, or one you are unsure is tied to the release, counts as blocking.
3. For a release, write `notes/left-undone-review.md` (replace the file): the time from `date`, the scope (release and PRs), one line per item (`U<n> | bucket | why or proof`), any deferral quoted from {{OWNER}}, and last of all one line: `Blocking: none` or `Blocking: U<n>, U<m>`. Do not open or merge the release while anything blocks.
4. Tell {{OWNER}} in one short block: what was cleared, what blocks, and what you need from them.

## Rules

- A "Not done" or "Couldn't run" line in a builder's report becomes an item at close-out, unless the next step clears it.
- Resolving an item is a claim: the note names the evidence.
- Never write `Blocking: none` to get past the hook. The review is the point; the hook only checks it happened.
