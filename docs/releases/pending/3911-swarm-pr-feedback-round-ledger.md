# docs(skills): open-issue corpus check, verdict table, and round-2 checkpoint in swarm-pr-feedback

The `swarm-pr-feedback` skill gains three rules for multi-round feedback work:

- **Open-issue corpus check before the closeout gate**
  (`references/followup-dispositions.md`). Before the closeout gate reviews
  the planned dispositions, each candidate is checked against the repo's open
  issues. The check searches by the item's terms first, then reads the bodies
  of the hits, because a title match is not coverage. Genuine body coverage
  upgrades the row to `ABSORB`.
- **Per-round verdict table** (`references/followup-dispositions.md`,
  "Round ledger"). Every gate verdict is appended to a `## Verdict table`
  section of the durable task-gates artifact. A re-dispatched gate uses the
  table to find what changed since an item's last verdict, but it still
  reviews the full diff and closure ledger.
- **Round-2 checkpoint** (same section). When an item's second
  closeout-critic verdict is `NEEDS_REVISION` or `BLOCKED`, the run stops
  before round 3 and raises a content-changing `ASK`, which is
  critic-adjudicated first. The user chooses between fixing the remaining
  edges, accepting them as a documented limitation (closed as `RECORD` with
  the decision quoted), or continuing. An unanswered checkpoint ends the run
  without publishing the rejected revision.

`SKILL.md` carries only a two-line pointer to the new section, and the
adjacent round-boundary re-fetch bullet is rewrapped (wording unchanged) to
make room, so it stays within its progressive-disclosure line baseline.
The new rules are pinned in
`tests/unit/skills/swarm-pr-feedback-followup-pins.test.ts`.
