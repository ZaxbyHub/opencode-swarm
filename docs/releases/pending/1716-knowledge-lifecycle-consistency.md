# Knowledge lifecycle/retrieval consistency — status-filter leak, quarantine split, terminal archived, promoted demotion

## What

Closes four state-machine and retrieval-filter inconsistencies in the knowledge
lifecycle (#1716). Each is the smallest patch that closes the gap without
unwired functionality, untested branches, or deferred work.

### G4 — Retrieval status-filter leak (closed)
Retrieval filters in `search-knowledge.ts` and `knowledge-reader.ts` used
deny-lists that enumerated only `'archived'` and `'quarantined'`, missing
`'quarantined_unactionable'`. Any future producer (or a foreign import that
survives `normalizeEntry`) writing such a row to `knowledge.jsonl` would have
leaked into retrieval. The filter points also disagreed with
`getArchivedKnowledgeIds` on what counts as "inactive."

Fixed by centralizing the inactive-status set in a single canonical
`isActiveStatus()` helper (`src/hooks/knowledge-types.ts`) backed by an
allow-list-equivalent deny-list of the three known inactive statuses. The
helper preserves the #828 regression-guard intent: entries with
`undefined`/`null`/unknown statuses still pass through (not silently dropped).
Ten consumer sites now use the helper: `search-knowledge.ts` (retrieval filter),
`knowledge-reader.ts` (merge-layer filter), `knowledge-reinforcement.ts`,
`hive-promoter.ts`, `knowledge-escalator.ts`, `knowledge-store.ts`, plus
the three directive/injection sites (`knowledge-injector.ts`,
`phase-directives.ts`, `phase-complete-directive-gate.ts`) updated in the
follow-up commit `9bed1c866`, and `knowledge-curator.ts` (G7 demotion
counter clearance).

### G5 — Quarantine producers unified (closed)
The `knowledge_archive` tool's `mode:'quarantine'` branch used to flip status
in place in `knowledge.jsonl`, recording no metadata — producing an unrestorable
orphan invisible to `restoreEntry`. The canonical `quarantineEntry` (used by all
five other quarantine producers: CLI, curator-retraction, escalator,
confidence-floor, validator) moves the entry to `knowledge-quarantined.jsonl`
with `original_status` + `quarantine_reason` + `quarantined_at` and is restorable.

Fixed by routing the archive tool's quarantine branch through
`quarantineEntry`, short-circuiting before the events tombstone and the
skill-invalidation `queueMicrotask` (those are archive/purge-only). Hive-tier
quarantine via the archive tool now returns a clear error (the old behavior
silently flipped status in place and was already broken). The canonical
`/swarm knowledge quarantine` command is unaffected.

### G6 — `archived` is no longer terminal (closed)
The `archived` status had no coded exit — terminal until FIFO eviction, and
`/swarm knowledge restore` only handled the quarantine sidecar. An erroneously
archived entry could not be recovered.

Fixed by:
- Recording `archived_from` + `archived_at` on the entry row at all three
  archive producers (the `knowledge_archive` tool, the curator's
  `action:'archive'` recommendation, and the TTL sweep).
- Adding `unarchiveEntry` to the validator, which restores the entry to its
  `archived_from` status (or `'candidate'` for entries archived before this
  change), re-validates the lesson, and resets the G7 demotion counters.
- Wiring `/swarm knowledge restore <id>` to dispatch by current status: an
  `archived` entry in the main store routes to `unarchiveEntry`; a `quarantined`
  entry in the sidecar routes to the existing `restoreEntry`.

### G7 — `promoted` entries can now demote (closed)
The lifecycle had no `promoted → established` transition. A promoted entry with
a sustained negative outcome signal stayed promoted indefinitely — TTL-exempt,
cap-exempt, and still receiving `statusBoost` at recall.

Fixed by adding `runAutoDemotion` (companion to `runAutoPromotion`):
- Increments `recent_negative_phase_count` when a promoted entry's outcome
  signal is at/below `promoted_demotion_signal_threshold` for a phase; resets on
  a non-negative phase.
- Demotes to `established` after `promoted_demotion_min_negative_phases`
  (default 3) consecutive net-negative phases.
- Phase-keyed dedupe via `last_demotion_phase` so multi-caller invocation
  (phase-complete + close in the same logical phase) doesn't double-count.
- Gated on `phaseInfo.phase_number > 0` so close-time curation (which hardcodes
  phase 0) skips demotion; phase-complete is the only caller that knows the real
  phase number.
- Clears `hive_eligible` and the G2 `confidence_floor_demoted` flag on demotion
  (the status change is the stronger signal).

### Boost-table change (behavior change)
The status-boost table was inverted: `promoted` got +0.05 while `established`
got +0.10. With the new G7 demotion path, demoting `promoted → established`
would have *raised* an entry's boost — the opposite of the demotion's intent.
The table is corrected: **`promoted` is now +0.15 (was +0.05); `established`
stays +0.10**. A demoted entry (established, +0.10) now correctly outranks a
`candidate` (+0.0) but is outranked by a still-`promoted` entry (+0.15). The
full recall-ranking suite passes as a regression gate.

## Why
These four gaps were latent inconsistencies in the lifecycle state machine —
each one a place where two code paths disagreed on what a status meant or which
statuses are retrieval-active. The unifying root cause was the absence of a
centralized status definition; G4's canonical helper is the first step toward
that, and G5/G6/G7 were careful not to re-introduce new literal arrays.

## Acceptance criteria — all met
- G4: `quarantined_unactionable`-status entry in `knowledge.jsonl` is NOT
  retrieved, consistently across all filter points.
  Tests: `tests/unit/hooks/search-knowledge.test.ts` (filter parity),
  `tests/unit/hooks/knowledge-reader.test.ts` (merge-layer filtering).
- G5: an entry quarantined via `knowledge_archive mode:'quarantine'` CAN be
  restored via `restoreEntry`.
  Tests: `tests/unit/hooks/knowledge-store.test.ts` (quarantine routing),
  `tests/unit/tools/knowledge-archive.test.ts` (tool path).
- G6: an `archived` entry CAN be un-archived via `/swarm knowledge restore <id>`;
  status returns to its pre-archive status; it's retrievable again.
  Tests: `tests/unit/hooks/knowledge-unarchive.test.ts` (all producers),
  `tests/unit/commands/knowledge.test.ts` (restore dispatch).
- G7: a sustained-net-negative promoted entry demotes to `established` and no
  longer receives the `promoted` statusBoost.
  Tests: `tests/unit/hooks/knowledge-curator-demotion.test.ts`
  (threshold + dedupe),
  `tests/unit/hooks/knowledge-curator-skip-promotion.test.ts` (phase gate).
- Boost-table: recall-ranking suite passes with corrected `promoted` +0.15
  vs `established` +0.10 ordering.
  Tests: `tests/unit/hooks/search-knowledge.test.ts` (recall-ranking suite),
  `tests/unit/knowledge/relevance-scoring-task3-4.test.ts`.

## Out of scope
- Promotion gates and TTL logic are unchanged (the boost-table raise is a
  retrieval-ranking signal, not a promotion gate; the TTL sweep change only
  records metadata).
- Cap-survivor priority is unchanged (the `isActiveStatus` rewrite preserves the
  identical mapping).
- Hive-tier quarantine via the archive tool is rejected with a clear error
  rather than silently flipping status (the old behavior was already
  unrestorable).

Closes #1716.
