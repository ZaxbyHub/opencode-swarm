# Cross-producer recommendation dedup (curator, skill improver, consensus miner)

## What

The curator sweep, the skill improver's macro-reflector, and the consensus miner
all propose learning recommendations. Until now only the miner deduplicated —
and only against its own prior reports — so the same lesson surfacing from all
three producers was emitted three times.

A new shared ledger at `.swarm/learning/recommendation-ledger.jsonl` gives every
producer one memory of what has already been emitted:

- Every emission is keyed by a **cross-producer key** derived from the
  normalized recommendation text plus its scope keys. Because the key excludes
  the producing mechanism, a recommendation one producer already emitted
  suppresses another producer's identical one.
  **One asymmetry worth knowing:** only the curator and the skill improver
  *consult* the ledger before emitting. The consensus miner currently
  **records** into it but does not read from it — it dedupes against its own
  prior reports instead — so the miner is a ledger producer, not yet a
  consumer. A miner proposal therefore suppresses a later curator one, but not
  the reverse.
- The producer-scoped `lrec_…` fingerprint from `computeRecommendationFingerprint`
  is still recorded on each entry for audit.
- The ledger has two halves: a read-only `check` before a producer emits, and a
  locked `record` afterwards, run only for recommendations that actually took
  effect. The record half re-checks under the lock, so two producers racing on
  the same lesson can never grow a duplicate ledger entry.

Wired at three emission sites:

- **Curator** — `applyCuratorKnowledgeUpdates`, which every curator path
  converges on (`phase_complete`, `curator_analyze`, `/swarm curate`, the
  post-mortem). Suppressed recommendations are now counted as `skipped` instead
  of vanishing from both tallies.
- **Skill improver** — `writeMotifProposals` and `writeSuccessMotifProposals`.
  A recurring motif is proposed once rather than rewritten on every improver run,
  and each proposal's frontmatter carries `learning_mechanism` and
  `recommendation_fingerprint`. `/swarm consolidate` reports how many duplicates
  were suppressed.
- **Consensus miner** — the `consensus_mine` tool registers each mined proposal
  in the ledger and returns a `recommendation_ledger` block reporting what it
  recorded, how many were suppressed as
  `duplicate_recommendation_count`, how many entries the append evicted, and —
  because the ledger write is fail-open — whether it was `degraded`, meaning
  nothing was recorded and nothing was compared.

Emitted recommendations are stamped with `LearningProvenanceV1` (mechanism plus
source knowledge/task/evidence/run/model refs and the write origin) on their
ledger entry.

## Why

Issue #1821 AC21 requires stable fingerprints to deduplicate curator, improver,
and miner recommendations. The fingerprint primitive existed but nothing
remembered which fingerprints had already been emitted, so duplicate lessons
still reached the knowledge store and the skill-proposal directory.

## Scope — what this does and does not achieve

The dedup key is an **exact** hash of normalized text, so two producers suppress
each other only when they emit the same sentence. Today the improver and the
miner build their statements from fixed templates while the curator's statement
is a free-form LLM lesson, so a cross-producer collision is possible but
uncommon. The everyday win is therefore:

- **within-producer** dedup, which the curator and the improver previously had
  none of (the miner already deduped against its own reports), and
- one shared, provenance-stamped record of every emitted recommendation that any
  producer can consult.

Making cross-producer suppression routine would need near-duplicate matching
(the machinery behind `findNearDuplicate` and the knowledge dedup sweep) rather
than an exact fingerprint. That is a different mechanism from the one
`src/learning/fingerprint.ts` defines and is not part of this change.

## Migration

No configuration changes and no breaking API changes.

- The ledger is created lazily on first emission, capped at 500 entries with
  oldest-first eviction, and each entry is capped at 4 KB (provenance is dropped
  rather than allowed to blow the bound), so the file has a hard ceiling of about
  2 MB.
- Every failure mode — unreadable ledger, lock timeout, corrupt lines, a
  provenance record the schema rejects — fails open and emits everything, which
  is the previous behaviour.
- A recommendation the curator *defers* rather than applies (cohort-safety not
  yet granted, target entry missing, CAS revision drift, fair-scan generation
  already curated, actionability quarantine pending hardening) is never recorded,
  so the retry those paths are designed around still works.
- Re-promoting an existing knowledge entry is treated as a confidence
  reinforcement, not an emission, so repeated `promote` recommendations keep
  accruing confidence across sweeps as before. Duplicate promotes within a single
  sweep are still collapsed.

## Caveats

- Because the ledger is bounded, a recommendation older than the most recent 500
  emissions can surface again. Bounded state is the deliberate trade.
- The consensus miner participates as a ledger **producer** only. It mines and
  persists its report in a single call, so by the time proposals exist the report
  is already written; the miner therefore keeps its own report-derived
  within-producer dedup and cannot itself be suppressed by a curator or improver
  emission. The `recommendation_ledger.duplicate_recommendation_count` field makes
  that overlap visible rather than silent. It is named for what it counts: the
  ledger key drops both the producing mechanism and the target, so the miner's own
  re-derived proposals land in it too, which is why it is no longer called
  `cross_producer_duplicate_count`.
- A generated **motif or workflow** proposal that is removed from
  `.swarm/skills/proposals/` is no longer regenerated on the next improver run —
  the ledger has already recorded it. The dominant remover is automated, not a
  human: the full-auto `autoApplyProposals` critic and post-mortem triage both
  delete a proposal on a `REJECT` verdict. Before this change the next improver
  run rewrote it and the motif got another chance; now one `REJECT` retires that
  motif until its ledger entry ages out. This is the same "a standing
  recommendation is not re-proposed on every run" semantics the miner already
  had, but it is a real behaviour change for anyone relying on regeneration.
  Knowledge-derived skill drafts (`generateSkills`) are not routed through the
  ledger, so the issue #1717 G10 recompile path for a rejected draft is
  unchanged.
- Proposal bodies are now written once instead of being refreshed every run, so
  a motif proposal's `Observed across N task(s)` count, source task ids, and
  sample verdicts reflect the run that first emitted it rather than the latest
  evidence.
- The ledger's retention (500 entries) is independent of
  `knowledge.swarm_max_entries` (default 100). A lesson the knowledge store has
  already FIFO-evicted can still be suppressed here until its own ledger entry
  ages out.
- `checkRecommendations` and `recordEmittedRecommendations` are separate calls,
  so two producers can both pass the check and both emit. The worst case is one
  duplicate emission — the pre-#1821 behaviour — which is deliberately preferred
  over claiming a key up front and permanently losing a lesson that was never
  emitted.
