### Fixed

- Auto-review dispatches now emit a paired `delegation_begin` for every
  `delegation_end`. The review engine's reviewer dispatch, its finding-validation
  attempt replay, and the Stage-B validation replay in the review-receipt
  collector each emitted only the closing half of the delegation lifecycle, so
  every auto-review model call appeared in `.swarm/telemetry.jsonl` as a
  completion with no start that no consumer could pair or attribute to a
  dispatch. A begin is now emitted per **attempt** (matching the per-attempt
  ends that model fallback produces), carrying the same session id, agent name,
  and task id as its end.
- These emissions are genuine delegations, not bookkeeping: the review
  dispatcher creates and prompts a real child session, so the events are now
  typed and paired accordingly rather than being re-labelled. Cost accounting is
  unaffected — it consumes `delegation_end` exclusively, so the added begins
  change no cost, token, or attribution bucket.

### Added

- The event-contract check (`bun run check:events`, also wired into
  `drift:check`) now enforces a **lifecycle-pair producer inventory**, covering
  both the delegation pair (`delegation_begin` / `delegation_end`) and the
  session pair (`session_started` / `session_ended`). A file under `src/` that
  calls the closing half without a paired opening half fails the check, and
  adding or removing any such call site fails until the inventory is
  deliberately updated — including a new unpaired producer added to a file that
  already contains other opening calls, which a file-level check would miss.
  A pair may also record a known gap for a half that has no producers at all;
  the check then fails if one ever appears, so the gap can only be closed on
  purpose.
- The scan is textual and deliberately bounded, and says so in its own
  documentation: it recognises `telemetry.<wrapper>(` and `_internals.<wrapper>(`
  in the non-comment lines of TypeScript files under `src/`. Line comments are
  stripped, so commenting a producer out cannot keep its count and hide a
  regression. It does not see producers reached through a differently-named seam
  object, a destructured alias, a call inside a block comment or string literal,
  or a path outside `src/`.

### Known gaps

- `session_ended` still has no producer anywhere in the codebase, so
  `session_started` events remain unmatched. This is the same defect class and is
  recorded deliberately rather than silently: the new check carries it as the
  session pair's known gap and fails the build if a producer appears for it, so
  the pair can only be closed on purpose. A correct fix must emit only for
  sessions that actually started, because the review dispatcher deletes ephemeral
  child sessions that never emitted a start, and emitting blindly on session
  deletion would create the inverse asymmetry.
