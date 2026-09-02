# PR-review typed reducer decomposition and recurrence guardrails

## What changed

- Created the cohesive `src/pr-review/` boundary (issue #2385) with focused
  modules owning every PR-review lifecycle rule previously distributed
  through the 18.5k-line workflow gate and the dispatch tool:
  `types.ts` (closed event/effect unions, state slice), `reducer.ts` (pure
  `(state, event) -> { state, effects }` transition authority),
  `lifecycle.ts` (lane modes, presumed-stale eligibility, generation
  isolation), `circuit.ts` (the v2 circuit machine plus the policy resolver,
  re-enable reset, and rolled-back-probe transitions), `completion.ts`
  (N-of-6 settlement, partial-coverage admission, V1→V2 disclosure
  migration), `critic-routing.ts` (the single severity/impact/tag
  predicate), `authorization.ts` (one-use reviewer re-entry),
  `persistence.ts` (locks, CAS write, bounded parsing, atomic writes), and
  `legacy-transcript-adapter.ts` (the only module allowed to convert
  transcript text into canonical data).
- The workflow gate and `dispatch_lanes` are now orchestration adapters: the
  gate routes its resilience live-disable/re-enable, admission rollback, and
  rolled-back probe settlements through the reducer, and the compile-time
  gate-state-satisfies-slice assertion pins the single state definition.
- Deleted every duplicate authority found by the recurrence sweep: inline
  circuit-record constructions (including the synthetic OPEN fallback), the
  hardcoded policy-default mirror, the mirrored terminal-status sets, the
  raw legacy-transcript flag read, and the synthetic OPEN error fallback.
- Corrected stale guidance that contradicted the current policy: the
  legacy-record circuit message now directs truthful N-of-6 settlement
  instead of "stop without partial findings", and the lane contract card no
  longer claims wait-deadline terminalization.
- Installed mechanical guardrails (source scanners in
  `src/pr-review/guardrails.ts`): transcript conversion may exist only in
  the legacy adapter; the historical wait-deadline terminalizer may never
  reappear and delegation writes in the collect path stay inside the
  sanctioned settlement functions; circuit records may be constructed only
  under `src/pr-review/`. Each scanner is proven to flag its anti-pattern.
- Added the tracker #2380 replay corpus (waited-deadline, no-client,
  consolidated-lane circuit, 4/6 + 5/6 coverage, CLEAN+prose, truncated
  transcript, armed recovery, reviewer re-entry) through registered tool
  paths, reducer transition/invariant model tests, and a registered-path
  matrix suite.

## Why

Issues #2375/#2380 traced the recurring PR-review workflow failures to
cross-module semantic drift: lifecycle rules had no single owner, so each
narrow fix could silently diverge again. PRs 1–4 fixed each behavior; this
change makes those contracts structurally hard to diverge from.

## Migration and compatibility

No configuration or on-disk format change: `GATE_SCHEMA_VERSION` stays 1 and
the state files are byte-compatible (verified by re-reading pre-move-format
state through the new persistence module). `pr_review_resilience.enabled`
stays `false` pending the tracker #2380 host/OS matrix, which stays open
until that evidence is recorded. The delegation ledger, receipts, and
authorization stores are unchanged.

## Breaking changes and caveats

None. The `_test_exports` surface is preserved (moved symbols are re-exposed
under their historical names), so existing suites run unchanged.
