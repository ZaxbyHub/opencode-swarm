# Epic Mode v2 — close, dispatch, and gating hardening

Epic Mode v2 review follow-ups. Four defects closed on top of the
live-coder close guard, plus a phase-approval binding fix.

## Every epic teardown path now refuses a live coder

The `coders-live` refusal was keyed on `--abandon` and sat below the
`inspection.unreadable` branch, so two of the three paths that reach
`deleteEpicState` never evaluated it:

- `/swarm epic close --abandon` on unreadable state deleted the row
  before the guard ran. That is the documented repair remedy printed by
  `/swarm epic status` and recommended by the delegation gate on
  `EPIC_STATE_UNREADABLE`, and `/swarm close` reaches it too (it always
  abandons).
- A close resumed after an interrupt tore down unguarded: the guard
  keyed on `abandon`, while the teardown keys off `abandoning`
  (`abandon`, or a resumed close whose decided outcome was not
  `completed`). That resume is exactly what `epic_next_wave` tells the
  user to do when an epic is stuck closing.
- A truncated coder-settlement scan is now refused rather than treated
  as "no live coders", matching the start-side guard. The scan
  truncates alphabetically, so a live coder past the cap was invisible.

Either way the hazard is the same: the coder settles after the epic is
gone, finds no Epic context, and merges back onto the branch the close
just stepped off.

## Coder dispatch is refused while an epic is closing

`getOpenEpic` returns null for any row that is not `open`, so a
`closing` row silently ungated dispatch for the whole window between
`markEpicClosing` and `deleteEpicState` — precisely the window in which
a dispatched coder settles with no Epic context. Dispatch now returns
`EPIC_CLOSING` with the same remedy text `epic_next_wave` gives, and
points the user at `/swarm epic close`.

## The epic record refuses to outgrow the store, with a remedy

The lifecycle row grows per wave (frozen file scopes, co-change pairs,
a per-wave component snapshot, merge failures) and the coordination
store rejects any payload over 1 MiB with a bare `payload must contain
1..1048576 characters`. On a long epic that surfaced as a raw store
exception with no remedy, and every later transition — including both
close variants — threw the same way. `updateEpicRecord` now refuses at
768 KiB with a message naming the epic and the way out.

## Also in this round (author-side, kept as-is)

Three further review findings were fixed on the same branch while this
round was in flight and are carried here unchanged: the Epic tool gate
is now strip-then-add so a `tool_filter.overrides` entry cannot re-grant
an Epic tool with Epic off; a phase approval is bound to the epic
instance so it no longer survives an epic restart on the same plan; and
the retention-registry citation anchors were re-anchored.

## Not changed here: the PR-feedback coder bypass

The delegation gate returns for `pr_feedback` coders before the Epic
dispatch seam. That is deliberate, not a hole: the bypass still
publishes a scope binding and runs the settlement WAL, it is rooted at
the project root, and in a worktree-isolated epic the primary checkout
is filesystem-disjoint from the wave coders' worktrees. The behavior is
documented in the code and pinned by
`tests/unit/hooks/delegation-gate-epic-pr-feedback.test.ts`.

A parallel review round reached the same conclusion and recommended
leaving it alone, but the author implemented a narrower version of the
gate in the meantime: a `pr_feedback` coder that *overlaps a running
wave's frozen scope* is now refused. That is a compatible refinement —
it keeps the documented bypass for coders outside an active wave and
only closes the overlap case — so this round did not touch it.

