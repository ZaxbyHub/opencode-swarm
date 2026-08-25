# Hard global bound on skill-usage history, backed by an authoritative pending sidecar

## What

`.swarm/skill-usage.jsonl` — the audit log of skill delegations and their
compliance outcomes — is now bounded by a single **hard global** budget
instead of an unbounded-across-skills, per-skill-only cap:

- `maxEntries=5,000` / `maxBytes=1.5 MiB` / `maxAgeMs=90 days`, with a
  guaranteed `floorPerSkill=20` most-recent entries per surviving skill.
- Compaction distributes the remaining budget by global recency (not by
  group size), and only drops a skill entirely — never starves one skill to
  favor another — when the guaranteed floors alone would already exceed the
  global entry ceiling.

A new authoritative sidecar, `.swarm/skill-usage-pending.json`, now backs the
log. Every actionable compliance verdict (`compliant` / `violated`) is
enqueued into this sidecar **before** it is appended to the JSONL stream, so
**JSONL compaction** evicting an old entry does not lose the not-yet-applied
knowledge-confidence feedback for that entry. (That guarantee is about the
JSONL retention budget specifically; the sidecar has its own, separate budget,
which can itself discard the oldest un-applied verdicts — see Caveats.) The
sidecar carries its own hard bound (`queueMaxRecords=5,000` /
`queueMaxBytes=512 KiB`), a shared stale-breakable lock
(`.swarm/skill-usage.lock`), and quarantines (rather than silently discards) a
corrupt or oversized document.

**Behavior change:** `readSkillUsageEntries` (and the new
`readSkillUsageEntriesWithCoverage`) is now bounded — full reads are capped
at `readMaxBytes` (~1.6 MiB) instead of reading the entire file regardless
of size. A legacy oversized file reads its most recent window and reports
`coverage.truncatedRead: true` rather than silently degrading a caller's
confidence in what it received.

**Behavior change:** compaction now also rewrites the log when it encounters
lines it cannot parse, so unparseable rows are dropped rather than retained
forever. This is what makes the byte ceiling genuinely hard: the trigger
measures every byte on disk, so a log whose bulk is unparseable (torn writes,
crash-truncated tails, rows written in an older or unknown shape) would
otherwise stay permanently over budget with nothing able to bring it back
under. Each dropped line is added to a durable lifetime `corrupt` counter in
the sidecar, so the fact of the loss survives the bytes.

A one-time migration folds any pre-existing legacy log's un-acknowledged
actionable entries into the sidecar on first touch, then drops the
superseded `feedback_applied` marker lines from the JSONL. The migration
buffers candidate entries (bounded by the queue budget) rather than
acknowledgment ids, so an arbitrarily long acknowledgment history migrates in
one pass — there is no size of legacy log that refuses to migrate.

A new counts-only `skill_usage_health` telemetry event is emitted on
compaction, migration, consumption, and pressure, reporting accepted /
compacted / dropped / corrupt / retry / retained counts and byte/coverage
figures — no per-skill identifier, since the adversarial scenario motivating
this change is thousands of distinct one-off skill paths.

## Why

The prior implementation enforced only a per-skill 500-entry FIFO trigger
and no hard ceiling across skills or marker lines, so a project accumulating
history across thousands of distinct skills (or a churn of `feedback_applied`
marker lines) could grow `.swarm/skill-usage.jsonl` without bound, and every
full-file reader on that path scaled with total history. Issue #2038 closes
that gap with a hard global bound plus a bounded deterministic read path,
while the new sidecar guarantees compaction cannot silently drop an
unprocessed compliance signal that would otherwise never reach knowledge
confidence.

## Migration

No action required. Existing installations migrate their legacy
`.swarm/skill-usage.jsonl` automatically on the first write or maintenance
pass after upgrading; the sidecar is created lazily. No public tool or
agent-facing API changed shape.

## Caveats

- `readSkillUsageEntries` callers that previously assumed a full, untruncated
  history should check `coverage.truncatedRead` /
  `coverage.complete` (via `readSkillUsageEntriesWithCoverage`) if they need
  to know whether the window they received is the complete history.
- **The sidecar queue is itself hard-bounded, and the bound can discard
  actionable verdicts.** When un-applied `compliant` / `violated` records fill
  `queueMaxBytes` (512 KiB — on the order of 2,000 records; measured at
  199-302 bytes per serialized record, so between roughly 1,700 and 2,600
  depending on skill-path length and whether the id is a runtime UUID or the
  longer content-hash id minted for a migrated legacy entry), the oldest are
  evicted so the ceiling stays a real ceiling. This is a deliberate divergence
  from the approved plan, which said the budget would never evict a `pending`
  record: a cap that a backlog can pin is not a cap, and pinning it was the
  unbounded-growth failure this change exists to remove. The trade is paid for
  by making it measurable, never silent — every such eviction increments the
  dedicated `pending_evicted` counter (kept separate from `dropped`, which
  age expiry owns) plus `pressure`, both reported on `skill_usage_health`.
  The most likely time to see it is the **one-time upgrade migration** of a
  very large legacy log, where a long-accumulated backlog of un-acknowledged
  actionable entries is folded into the queue in a single pass.
- **A sidecar write failure stops compaction rather than risking the
  acknowledgment record.** If `.swarm/skill-usage-pending.json` cannot be
  written (disk full, permissions, a lock the process cannot take), the legacy
  `feedback_applied` marker lines are deliberately KEPT and
  `.swarm/skill-usage.jsonl` is not compacted on that pass, because dropping
  the markers before the queue is durable would replay already-applied feedback
  into knowledge confidence. A persistent write failure therefore leaves the
  log un-compacted and growing until it is fixed. This is not silent: each
  attempt emits an always-on `CRITICAL-WARN` line to stderr naming the cause.
- The `skill_usage_health` event does not yet have a live consumer; it is
  observability plumbing for a future reporting surface (tracked under the
  observability sink/consumer sequence, issue #2047 — the same owner recorded
  as `futureOwnerIssue` / `retentionOwnerIssue` in
  `src/observability/catalog.ts` and in `docs/observability-event-contract.md`).
