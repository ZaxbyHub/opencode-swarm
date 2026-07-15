---
issue: 1848
title: Cohort-safe pooled curation with provenance and fair scanning
---

## Cohort-safe knowledge curation (#1848)

When multiple linked worktrees share one pooled knowledge store, curation is now
safe. One worktree can no longer archive, rewrite, retire, quarantine, or purge
another producer's lesson based on incomplete local session evidence, and large
cohorts no longer starve entries beyond the scan window.

### Producer provenance + revision (schema v3)
- Each mutable knowledge entry now carries optional `producer` (cohort id +
  worktree id + session/role), `revision` (monotonic CAS counter), and
  `content_hash`. Legacy entries without provenance are treated as unknown-owner
  and protected from destructive curation by default.
- v1/v2 entries continue to load unchanged (all v3 fields are optional;
  `normalizeEntry` fills defaults without an on-disk migration).

### Cohort-safe authorization policy
- New `authorizeCuration` decision ladder (`src/knowledge/curation-policy.ts`)
  shared by every destructive lifecycle action: config-mismatch guard → owner
  path → unknown-owner protection → not-owner-local-evidence → proposal →
  cohort quorum → override.
- Cohort quorum counts only **negative** outcome events (violated/contradicted);
  positive evidence (applied/shown) never authorizes a destructive action.
- Unauthorized destructive intent is persisted as a non-destructive proposal
  (`curation-proposals.jsonl`) that other cohort members may later confirm.

### Compare-and-swap mutations
- New `transactKnowledgeWithCas` rejects stale curator plans when the entry's
  revision/content-hash changed between plan-generation and apply.
- Immutable before/after rewrite history (`knowledge-rewrites.jsonl`) preserves
  the only copy of prior lesson text for recovery and audit.

### Fair, durable scanning cursor
- The fixed oldest-~500-entry window in the postmortem is replaced by a durable,
  fair cursor (`src/knowledge/scan-cursor.ts`) with atomic batch-claim under the
  directory lock. Every eligible record is eventually visited; progress survives
  restart; concurrent cohort postmortems do not duplicate batches.

### Config fingerprint enforcement
- `cohortConfigFingerprint` is now wired into `/swarm link` and the policy: a
  cohort config mismatch blocks destructive curation with an actionable
  diagnostic.

### Diagnostics
- `/swarm diagnose` surfaces scan generation/remaining, config-fingerprint
  agreement, and provenance coverage.
