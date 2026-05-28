# Event-sourced knowledge lifecycle

## What changed

### Immutable knowledge event log (`.swarm/knowledge-events.jsonl`)

A new append-only event log records every meaningful knowledge interaction —
retrievals, receipts (applied / ignored / contradicted / acknowledged /
violated), task/phase outcomes, and archival tombstones. The log is the
authoritative history of the knowledge system; per-entry counters
(`retrieval_outcomes.*`) become *derived rollups* recomputed deterministically
from the log rather than the primary record.

- `src/hooks/knowledge-events.ts` (new) — event schema, append/read helpers,
  and a pure, deterministic `recomputeCounters()` rollup. Recording on hot
  paths is fail-open (`recordKnowledgeEvent`) so telemetry never breaks tool or
  hook execution.
- The rollup folds in legacy `.swarm/knowledge-application.jsonl` records that
  predate the event log, so no historical signal is lost during migration,
  while transition-window double-writes are not double-counted.
- A `contradicted_count` counter was added to the entry schema
  (`retrieval_outcomes`) and backfilled by `normalizeEntry()`.

### Retrieval events from manual recall and auto-injection

`knowledge_recall` now mints a `trace_id` per call and records a `retrieved`
event (with `result_ids`, `ranks`, and `scores`), returning the `trace_id`. The
phase-start knowledge injector records an equivalent `retrieved` event so manual
and automatic retrieval share one history.

### New `knowledge_archive` tool (archival-by-default removal)

`knowledge_archive` replaces hard deletion as the recommended removal path. It
defaults to `archive` (reversible status change), supports `quarantine`, and
gates `purge` (hard delete) behind an explicit `allow_purge: true` admin flag.
Every action appends an immutable `archived` tombstone recording the actor,
reason, evidence, and previous status. `knowledge_recall` now also filters
`quarantined` entries (it already filtered `archived`).

### New `knowledge_receipt` tool

`knowledge_receipt` is the stronger successor to `knowledge_ack`. Given a
`trace_id`, an agent reports which entries were `applied` (with evidence),
`ignored` (with a reason), or `contradicted` (with a proposed remediation), plus
any `new_lessons`. Each item becomes an immutable event. When a retrieval
surfaced nothing useful, the receipt can set `no_relevant_knowledge: true`. The
tool is registered for the architect and coder agents.

### Knowledge diagnostics

A new `computeKnowledgeDebug()` helper reports the resolved swarm/hive/event
paths, plugin version, raw-vs-normalized entry counts, schema-version histogram,
status breakdown (active/archived/quarantined/rejected), event volume,
retrievals in the last 7 days, and cache freshness. `/swarm diagnose` gains a
"Knowledge health" check built from it (warning on corrupt lines, entries
missing v2 counters, or a stale plugin cache). `knowledge_recall` accepts an
optional `debug: true` to surface the same block — useful for diagnosing
path/version drift (a stale cache or mismatched resolved directory can make the
store look broken).

### Unified retrieval service (`searchKnowledge`)

Manual recall and automatic injection now share a single hybrid retrieval core
(`src/hooks/search-knowledge.ts`): load → dedup (hive wins) → filter
archived/quarantined → optional scope & agent-role constraints → hybrid score
(text + metadata + directive) → critical force-include → emit a `retrieved`
event → return a `trace_id`. `knowledge_recall` and the phase-start injector both
route through it.

Scoring adapts to the call: with a text query (manual recall) it blends Jaccard
text similarity with the metadata score and applies a status boost; without a
query (injection) it uses the metadata score at full weight with the directive
signal — matching the prior action-aware ranker so injection ordering is
unchanged and critical directives are still force-included. Manual recall opts
out of scope/hive/role gating so an explicit query keeps surfacing all scopes,
hive entries, and role-scoped lessons as before. `normalizeEntry` now defaults
malformed `tags`/`lesson` fields so one corrupt entry can't fail an entire read.

## Why

A learning system needs a tamper-resistant history. If counters are wrong they
can be recomputed from events; if an entry was archived, the reason and prior
status are auditable; if a lesson was promoted, the applications that justified
it can be inspected.

## Migration steps

None. The event log is created on first write. Existing entries are normalized
on read (the new `contradicted_count` defaults to 0). The legacy application
log continues to be written during the transition.

## Known caveats

- The rollup is in-memory; on-disk counters are reconciled separately (see the
  diagnose surface).
