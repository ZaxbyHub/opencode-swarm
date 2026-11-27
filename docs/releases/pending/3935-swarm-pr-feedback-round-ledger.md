# swarm-pr-feedback: round ledger, round-2 checkpoint, open-issue corpus check

## What changed

- The `swarm-pr-feedback` skill now records every gate verdict in a verdict
  table inside the task-gates artifact, so a re-dispatched gate can find what
  changed since an item's last verdict. The table is a navigation aid only;
  every gate still reviews the full current diff.
- Added a round-2 checkpoint: when an item's second closeout-critic verdict is
  `NEEDS_REVISION` or `BLOCKED`, the agent stops before a third round and asks
  the user to fix the remaining edges, accept them as a documented limitation,
  or keep iterating.
- Added an open-issue corpus check that runs before the closeout gate, so an
  `ABSORB` disposition is found and reviewed instead of being retrofitted after
  `RECORD` rows are published.

## Why

Multi-round closeout gates rebuilt their history from the whole ledger on every
re-dispatch, and one low-severity item could loop through four critic rounds.
These rules keep the rounds bounded and the dispositions complete.

## Migration

No user migration is required. This is skill guidance only; the `.claude` and
`.agents` adapters point at the canonical skill and are unchanged.

## Known caveats

The verdict table and round count rely on the agent following the skill. No
runtime hook enforces them.
