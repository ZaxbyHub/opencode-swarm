# Feedback rounds now re-fetch PR comments at every round boundary

## What changed

The `swarm-pr-feedback` skill contract now makes mid-round feedback intake explicit and enforced (issue #3607), with the new contract text pinned by the skills contract tests so a deletion fails the suite:

- **Round-boundary re-fetch.** Intake is no longer one-time: at the start of every fix round and again before the closeout gate, the PR's issue comments, inline review comments, and reviews are re-fetched and every external finding gets a ledger row. Automated reviewers (per-head bot reviews, Copilot inline comments) post findings against intermediate heads mid-round; findings that land after the ledger was built are now structurally caught instead of discovered by luck. The fetch commands and bot markers live in `references/intake-surfaces.md`.
- **Final-critic enumeration challenge.** The closeout gate's final critic now fetches every PR comment and review fresh and reconciles each external finding against the ledger — an approving reviewer delta round is invalid while newer external feedback has no row.
- **Published closure ledger.** Before the final critic runs, the closure ledger is recorded in the runtime session task-gates artifact (bound to the reviewed head SHA and fetch time), which the critic reconciles against its own fresh fetch; the ledger is published as a PR comment only after the reviewed commit is pushed and the remote head verified (PR-comment publication is gated until then in every profile).
- **Gates log from round start.** The runtime session task-gates artifact (durable-session-state, e.g. `.zcode/session/tasks/<slug>/gates.md` on ZCode) is opened at round start and appended after every reviewer/critic verdict, so compaction or handoff re-entry reads state from disk.
- **Probe entry-state guard and attributed kills (issue-tracer).** Mutation/revert probe scripts that restore via `git checkout --` must refuse to run on a tree with uncommitted work (the restore silently reverts the fix and then reads clean), and a mutation counts as killed only with baseline-green → mutation-landed → named-test-red → restored evidence — a generic `(fail)` anywhere in the output is not a kill. Details in the issue-tracer acceptance-check contract and the feedback operational-gotchas reference.

The `swarm-pr-feedback` "what counts as feedback" enumerations moved to `references/intake-surfaces.md` (progressive disclosure); the entry skill stays under its disclosure baseline.

## Why

A session retrospective of the PR #3592 round (2026-11-07) found that two per-head automated reviews (one with a HIGH finding) and a Copilot inline comment landed mid-round with no ledger disposition until the final critic's closure-ledger enumeration caught them — costing an extra fix round. The same retrospective found the feedback round's gate log created only near the end (a compaction mid-round made recovery depend on the summary), and a mutation probe's file restore wiped uncommitted fix work despite the trap being documented three times in memory — knowledge stored but not enforced. These changes turn each of those catches from luck into contract.

Issue: #3607
