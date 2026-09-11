# Summary identity survives restarts (no-overwrite summary store)

## What changed

Tool-output summaries now allocate their `S<n>` IDs durably from the entries that actually exist in `.swarm/summaries/` instead of a per-process counter, and the summary store refuses to replace an existing entry: a colliding ID surfaces as a typed `SummaryIdCollisionError` and the hook reallocates (bounded retries) rather than overwriting.

## Why

Previously every process restart reset the ID counter to `S1`. The first oversized tool output after a restart silently overwrote the persisted `S1` entry, destroying the older full output and making older `[SUMMARY S1]` references resolve to the new content (audit FUNCTIONAL-4, issue #2576).

## Impact

- Restarts, host reloads, and concurrent swarm processes now create distinct, individually retrievable summaries; every reference keeps retrieving its own original output for the entry's lifetime.
- `/swarm retrieve`, the `retrieve_summary` tool, retention cleanup, and the existing short `S1, S2, …` ID format are unchanged.
- The Stage A full-output persistence path benefits from the same no-overwrite guarantee (its astronomically rare same-millisecond ID collision is now a reported error instead of a silent clobber).
- On filesystems without hard-link support (e.g. exFAT), storing a summary now fails open: the original tool output is kept inline and a warning is logged — never a silent overwrite.
