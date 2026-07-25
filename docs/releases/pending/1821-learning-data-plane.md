# `feat(knowledge)`: learning data plane — dedup hygiene, provenance, and shared immutable reports

## Summary

- `knowledge_add` now merges inferred tags with caller-supplied tags. Caller tags are kept first, so when the
  20-tag cap truncates, inferred tags are dropped before anything you asked for.
- Knowledge array fields (tags and the five actionability arrays) are now **deduplicated** before the 20-item
  cap is applied, at every site that builds them. Previously the cap was purely positional, so a run of
  duplicates could push distinct values off the end and silently lose them.
- Deduplication is also enforced on the knowledge **store write path**, so an entry with duplicate or
  over-cap arrays cannot be persisted regardless of which code path produced it.
- New `learning` and `consensus` configuration blocks, and a new
  `knowledge.promotion_require_actionable` setting.

## User-facing changes

- **Tags you pass to `knowledge_add` are preserved in order and de-duplicated**, and relevant tags inferred
  from the lesson text are appended. A lesson that previously stored `["ci","ci","ci"]` now stores `["ci"]`,
  leaving room under the cap for genuinely distinct tags.
- **Duplicate entries in `applies_to_agents`, `applies_to_tools`, `required_actions`, `forbidden_actions`,
  and `verification_checks` are collapsed.** Deduplication is case-insensitive and keeps the first
  occurrence's original casing.
- **Existing stored entries are normalized the next time they are written.** A legacy record holding more
  than 20 tags returns from its next transaction capped at 20. This is intentional — it is the same cap that
  has always applied to new writes — but it means an over-cap legacy record will lose its tail on the next
  update rather than keeping it indefinitely.
- `evidence_refs` recorded by the curator are likewise de-duplicated. Note this is case-insensitive, so
  `plan.md:42` and `PLAN.MD:42` collapse to one reference.

### Promotion now enforces an actionability floor

`/swarm promote` and every hive-promotion path now require a lesson to carry at least one **predicate**
(`--required-actions`, `--forbidden-actions`, `--verification-checks`) and at least one **scope**
(`--applies-to-tools`, `--applies-to-agents`) before it can reach hive knowledge. Previously a lesson could be
promoted as un-actionable prose that no agent could act on.

Those five flags are new on `/swarm promote` — before this change the direct-text path had no way to supply
actionability fields at all, so the floor would have been impossible to satisfy there. A related bug is fixed
in the same path: the direct-text promotion wrote its hive entry without carrying actionability fields
through, so even correctly-supplied predicates were dropped on write.

A lesson that fails the floor is **blocked**, not silently promoted. `--force --reason "<why>"` still
overrides and records a durable audited override naming the failed gate. Set
`knowledge.promotion_require_actionable = false` to restore the previous behavior.

### Lessons are now admitted mid-session, not only at phase boundaries

Previously the only in-session learning signal was a prompt nudge asking the architect to call
`knowledge_add`. Nothing validated or admitted anything until the phase boundary. Now a session-keyed queue
validates and admits (or rejects) candidates while the session is still running, so a lesson captured early
can be retrieved by a later delegation in the same session.

- Every budget is explicit and configurable under `learning.realtime_admission`: queue size, LLM calls,
  tokens, concurrency, retries, per-candidate timeout, and total drain wall time.
- The durable `.swarm/insight-candidates.jsonl` queue is unchanged and remains the backstop. If the
  real-time loop is disabled or the process crashes, phase-boundary curation still picks everything up —
  nothing is lost.
- Repeated PRM patterns are persisted only after they recur across genuinely distinct occurrences, with a
  cooldown, and they store **evidence pointers rather than reasoning text**.
- When real-time admission is active it supersedes the prompt-only nudge (`supersede_nudge`, default true).
  This supersedes the behavior described in the pending `hermes-style-realtime-learning-nudge` fragment.

Double-counting is prevented by identity rather than timing: an admitted candidate is marked in the entry's
`source_knowledge_ids`, and the phase-boundary fold-in skips anything already admitted. This matters because
re-confirming an entry is not a no-op — it raises confidence and counts toward automatic hive promotion, so a
duplicate would have silently inflated both.

### New `consensus_mine` tool (proposals only)

A new `consensus_mine` tool mines the evidence you already have — evaluation runs, gate audits, trajectories,
skill-usage/compliance records, knowledge outcomes, and retros — into evidence-backed *consensus attributes*
and deduplicated improvement proposals.

It **changes no active artifact**. It activates no skills, edits no knowledge, and runs no optimization
rounds; it only writes a versioned, immutable report under `.swarm/evolution/consensus/`.

Guarantees worth knowing:

- **Deterministic first.** All filtering, co-occurrence, support counting, and diversity math run before any
  model call. Summarization is optional and, when no dispatcher is available, falls back to the deterministic
  statement rather than failing.
- **One anecdote is never a proposal.** An attribute supported by a single task (`taskDiversity < 2`) is
  emitted as an investigation note with `proposedTarget: 'none'`.
- **Negative evidence is preserved.** `failureSupport` and `counterexampleRefs` are always retained; an
  attribute is never published with its counterexamples dropped.
- **Reports are reproducible.** The same inputs produce an identical `integrityHash`. Wall-clock fields are
  excluded from the hash so re-running does not fabricate a difference.
- **Excerpts are bounded and secret-redacted**, and no prompt or reasoning text is ever persisted.

`modelDiversity` is `0` when no contributing observation carries a model id — that means "not measurable from
this corpus", not "measured as none", and never blocks emission on its own.

See `docs/consensus-mining.md`.

## Migration notes

None required. All changes are backward compatible: existing knowledge records load unchanged, and
normalization applies only when a record is written. No configuration change is needed — the new `learning`
and `consensus` blocks have working defaults, and `knowledge.promotion_require_actionable` is additive.

## Known limitations

- Normalization runs on write, not on read, so an over-cap legacy record keeps its full tail until something
  next writes it.
- `src/knowledge/family-migration.ts` authors merged tag values and writes them through a path that bypasses
  the store-level normalizer, so a cohort merge can transiently exceed the cap until the next transaction
  normalizes it.
- One further instance of the same positional-cap pattern remains at `src/hooks/curator.ts` on
  `source_knowledge_ids` (cap 50). It is deliberately excluded: that field is used to carry
  deduplication markers, and capping or reordering it would break that mechanism.
