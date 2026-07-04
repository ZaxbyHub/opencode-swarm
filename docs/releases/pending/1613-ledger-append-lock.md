# Serialize plan ledger appends

## What changed

- Wrapped `appendLedgerEvent()` in a project-scoped lock keyed to
  `.swarm/plan-ledger.jsonl`, so concurrent plan/task mutations cannot both
  observe the same latest sequence and rewrite the authoritative ledger from a
  stale snapshot.
- Added focused regression coverage for concurrent ledger appends and
  same-`expectedSeq` contention.

## Why

The plan ledger is the authoritative source of plan state. Two near-simultaneous
append writers could previously assign duplicate sequence numbers, and
cross-process timing could silently drop one writer's event when the later
rename replaced the canonical ledger.

## Migration steps

No manual migration is required. Existing ledgers keep the same JSONL format.

## Known caveats

Lock acquisition now fails closed if the project-scoped ledger lock cannot be
acquired within the bounded timeout.
