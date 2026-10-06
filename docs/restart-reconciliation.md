# Restart reconciliation — durable policy vs ephemeral authority (issue #2668)

Every plugin boot (and every host process restart) rehydrates live session
state through the same boundary: `loadSnapshotForInit` → `rehydrateState`
(`src/session/snapshot-reader.ts`). Issue #2668 made that boundary explicit:
**durable runtime policy survives restart; ephemeral execution authority
expires; and the expiry of in-flight authority is recorded, owner-named,
instead of being silent.** Absence of a result is never treated as success.

## Durable versus ephemeral fields at the restart boundary

| State | Class | Restart behavior |
|---|---|---|
| Plan ledger (`plan-ledger.jsonl` + SQLite shadow) | durable | Authoritative; corrupt/partial projections are rebuilt ONLY from the ledger (#2531) |
| QA gate profile (`qa_gate_profile` table) | durable | Plan-scoped gates + lock state survive unchanged; ratchet-only, locked after critic approval |
| Session QA overrides (`qaGateSessionOverrides`, `qa_gate_session_override` table) | durable (policy) | A session's ratchet-tighter overrides are persisted by `/swarm qa-gates override` (durable-first) and restored by `rehydrateState`; effective gates stay tightened across restart. Deleted in lockstep with the session (end / stale eviction / `/swarm reset-session`). Never serialized into snapshot bytes — the DB row is the authority |
| Full-auto run state (`.swarm/full-auto-state.json`) | durable (authority) | `fullAutoMode` is reconciled against the durable run state; cleared unless the run is still `running` |
| Epic Mode lifecycle (coordination row `turbo.epic.lifecycle` + `.swarm/epic/epic.json` sentinel) | durable (authority) | Survives restart unchanged; the active wave stays the coder dispatch authority. A restored session is forced to `turboMode: false` while an epic is open for the project. An interrupted `/swarm epic close` leaves the epic `closing` (`epic_next_wave` refuses and asks for `/swarm epic close` to be rerun). A sentinel without a row means no open epic; `/swarm epic status` repairs sentinel/row drift |
| `delegationActive`, reviewer scope generations, PRM state, invocation windows | ephemeral (authority) | Intentionally expire at rehydrate (`TRANSIENT_SESSION_FIELDS` / `SESSION_TRANSIENT_FIELDS`). A restarted host must never inherit stale execution authority |
| Leases / child handles / in-flight timers / pending promises | ephemeral (authority) | Process-resident; expire with the process. Coder reservation leases are generation-fenced (#2104); a late old-generation release is refused |

The session-level classification is itself compile-time exhaustive:
`SESSION_TRANSIENT_FIELDS` (`src/session/snapshot-writer.ts`) lists every
field that is never serialized, each with its durable/ephemeral rationale,
and `TRANSIENT_SESSION_FIELDS` (`src/session/snapshot-reader.ts`) lists every
serialized field that is reset on rehydration.

## Operator-visible reconciliation states

When a session arrives at the boundary with in-flight execution authority
(serialized `delegationActive: true`), the boundary records an
**owner-named** reconciliation entry and pushes a one-shot advisory into the
restored session:

- `classification: "interrupted"` — the process died mid-execution. The
  outcome is **UNKNOWN**. The entry names the owner (session id + agent name)
  and the task id.
- The durable artifact is `.swarm/session/restart-reconciliation.json` — a
  bounded list (50 entries, FIFO; deduped by session+task so repeated
  restarts refresh rather than duplicate).

Related states owned by other surfaces (composed, not duplicated):

- `uncertain` — a provider effect whose outcome could not be classified;
  retained pending and visible in `/swarm status` (completion observer).
- `stale` / `ambiguous` / `live_wedge` — accepted-then-dead coder work,
  classified by the #2665 vocabulary; `/swarm recover [task_id]` settles
  stale coder-settlement WALs.

## Restart / inspect runbook

1. **Inspect effective policy after a restart** (agent surface): call
   `get_qa_gate_profile` — it returns the spec-level profile, the calling
   session's overrides, and the **effective gates** merged from both.
   Human surface: `/swarm qa-gates` (show).
2. **Inspect what was interrupted**: read
   `.swarm/session/restart-reconciliation.json` (owner, task, observedAt,
   guidance) and the restored session's advisory messages.
3. **Settle uncertain effects**: `/swarm status` for uncertain provider
   effects; `/swarm recover [task_id]` for stale coder settlements.
4. **Repeat restarts are idempotent**: rehydrating again refreshes the same
   reconciliation entry and restores the same effective policy — it never
   duplicates records or clears newer work. Late old-generation results are
   refused (`superseded`, #2667); late Stage A/B receipts are rejected with
   `TASK_WORKFLOW_GENERATION_MISMATCH` and never advance the task (#2666).
5. **Inspect an open epic after a restart** (Epic Mode): `/swarm epic status`
   shows the epic, its waves, phases and recorded merge failures, and repairs
   sentinel/row drift; `--repair-refs` re-adopts task refs a rebase or amend
   made unreachable.

## When a human must resolve an external effect

The reconciliation record names owners and classifies plugin-internal state
only. External effects the plugin cannot observe or reverse always require a
human: pushed commits, opened/published pull requests, deployed artifacts,
messages already sent to users, and any provider-side mutation whose
confirmation was lost. Treat those as `interrupted + unknown` until a person
verifies the external system directly — the plugin deliberately does not
guess success from absence.
