# `fix(background)`: one schema-drifted coordination row no longer poisons the whole delegation namespace as "uncertain"

## Summary

- A single coordination row whose payload fails `RecordSchema` validation made **every** reader report "background delegation coordination state is uncertain": `/swarm status` hid all counts and reservations, maintenance failed on every run ("owner evidence uncertain; all reservations retained"), and `/swarm recover` reported FAILED — while the ledger tail was well within its recovery bound (the §3.1 paradox). The trigger is real: a plugin release built from an older source state (npm 7.205.6) lacked vocabulary (`soundingBoardCategory`, the `parent_advisory`/`pipeline_advisory`/`plan_critic_approval` closeout steps) that the previously installed build (7.205.4) had written, so every row written by the newer writer was unreadable to the older reader — forever, with no repair path.
- Fix: the **advisory read** (`readDelegationsDetailed` / `readDelegationLoadAttempt`) is now lenient towards schema-drifted rows: it skips up to 8 drifted rows, names them on the ok outcome (`skippedCoordinationRows`), and records a durable `lastCoordinationSkip` section in the delegation health artifact. `/swarm status` renders counts from the lenient read plus a distinct "Coordination schema drift: N row(s) skipped … writes and destructive cleanup stay fail-closed" notice instead of the global uncertainty lie. A lenient read that skipped rows never rewrites the shadow projection from partial truth and never triggers the legacy import.
- Safety: **write paths, the strict recovery scan (`scanDelegationsForRecovery`), compaction, and destructive cleanup keep the strict fail-closed read** — a drifted row still refuses every mutation until it is repaired or re-read by a build with the correct vocabulary. Authority-binding mismatches (payload vs row columns) and the row bound stay fatal for every reader; more than 8 drifted rows stays uncertain (a systematic regression must remain visible).

## User-facing changes

- `/swarm status` shows real counts plus a named, bounded drift notice when coordination rows fail schema validation, instead of hiding the entire background-work section behind "State uncertain". The health artifact's `lastCoordinationSkip` names the drifted sessions.

## Migration notes

None. The health artifact gains an optional `lastCoordinationSkip` section (schema-validated, backward compatible); the coordination DB and ledger formats are unchanged.

## Discovery context

The Wirtschaftssimulation `swarm_communication_debug.md` §3.1 paradox and §7.5 candidate issue (2026-11-23): `lastUncertainty: "delegation coordination row failed schema validation for ses_df775dbc…"` repeating every maintenance run while `"ledger":{"bytes":…,"band":"ok"}`. Root cause verified against the installed npm builds: the 7.205.6 bundle lacks `soundingBoardCategory` (0 occurrences vs 4 in 7.205.4) and the `parent_advisory`/`pipeline_advisory`/`plan_critic_approval` closeout steps that the 7.205.4 writer had recorded — the same missing `plan_critic_approval` step explains the "dispatch-signal miss" that lost the critic-approval snapshot at 18:34Z. Pinned by the coordination-schema-drift describe-blocks in `tests/unit/services/status-service-background-work.test.ts` and the updated legacy-deadline compatibility pins in `tests/unit/background/pending-delegations-legacy-deadline-read.test.ts`.
