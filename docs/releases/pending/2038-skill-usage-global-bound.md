# Hard global bound on skill-usage history

## What

PR 10 of the observability sequence. `src/hooks/skill-usage-log.ts` previously
retained `.swarm/skill-usage.jsonl` with only a per-skill cap (500 entries per
skillPath, rotation trigger near 1 MiB): thousands of distinct skills grew the
file without bound (every rotation pruned nothing), `feedback_applied` marker
lines were preserved unconditionally forever even when every referenced entry
was already gone, nothing evicted by age, and production readers parsed the
whole file. It is now a **bounded single-file store**:

- A versioned manifest header (maintenance-lifetime counters: compacted /
  aged / corrupt / pruned-marker-IDs / pressure state) plus the retained
  window of usage entries and rebuilt feedback markers.
- Hard documented ceilings (`SKILL_USAGE_LIMITS`): 1 MiB global bytes
  (manifest + entries + markers), 5,000 global entries, 90-day age for
  operational entries, per-skill 500-entry selection kept as a policy INSIDE
  the ceilings. Every read path is capped at 2 MiB regardless of file size.
- **Marker lifecycle** (the at-most-once contract): unprocessed
  `compliant`/`violated` entries are correctness-relevant and survive every
  compaction until feedback consumes them; processed markers are rebuilt to
  reference only surviving entries, so marker lines age out with their
  entries and can never grow without bound. `not_checked` entries are
  operational (feedback never acknowledges them, so classifying them as
  correctness data would make them immortal).
- **Pressure semantics** ("stop optional writes"): when the correctness
  backlog alone exceeds the envelope, operational-class appends are rejected
  with a typed error (writer call sites already catch + warn, so skill
  injection fails open), correctness-class appends still land, and the
  `skill_usage_health` event surfaces the pressure until the next
  phase-boundary feedback pass drains it.
- Concurrency: an exclusive `.swarm/skill-usage.lock` (wx create,
  stale-broken) guards appends, compaction, and the whole feedback
  read→bump→marker critical section — concurrent phase-completions can no
  longer double-apply knowledge confidence.
- Crash safety: atomic single-file rewrites (PID-scoped temp + rename with a
  bounded Windows retry), torn-tail re-framing before append, and legacy
  header-less files migrating at the first compaction (the append-path
  migration postpones files above 8 MiB to the phase-boundary pass so
  delegation latency never pays the one-time full parse).
- Readers are deterministic (append order), byte-bounded, and disclose
  coverage via `getSkillUsageCoverage` (`complete` / `truncated` /
  `empty`): the skill index rendered to agents notes when usage stats reflect
  only the retained window, and the curator's usage-derived decisions
  (violation-rate auto-retire, revision, promoted-external staleness) skip
  rather than decide on partial evidence.
- New canonical `skill_usage_health` telemetry event (counts only —
  accepted/compacted/retained/dropped-age/corrupt/preserved-marker/
  pruned-marker-ids/pressure figures, byte totals). Skill paths, agent names,
  and content never enter the stream.

## Why

An unbounded multi-key stream with immortal marker lines violates the
observability programme's retention and read-amplification contract (PR 08
registry #2036, parent #1823). Per-skill selection alone cannot bound a store
whose cardinality dimension — distinct skills — is itself unbounded; the
registry's `skill-usage` row carried disposition fix-in-issue #2038 for
exactly this reason.

## Compatibility

- `appendSkillUsageEntry`, `readSkillUsageEntries` (filters included),
  `readSkillUsageEntriesTail`, `pruneSkillUsageLog(directory, max)` and
  `applySkillUsageFeedback` keep their public signatures and semantics for
  in-window history; scoring, feedback, and phase-complete fixtures are
  unchanged within the documented envelope.
- Legacy header-less files read unchanged and migrate at the first
  compaction; lifetime drop counters begin at the first compaction (the
  stream is derived-rebuildable — the counters are health figures, not data).
- Two pinned unit fixtures were adjusted to the new contract: per-skill
  prune tests now use operational (`not_checked`) entries with recent
  timestamps (unprocessed actionable entries are correctness-relevant and are
  no longer dropped by an operational budget — the new contract is pinned in
  `tests/unit/hooks/skill-usage-global-bound.test.ts`), and the
  controlled-input read test injects through the bounded-read seam
  (`openSync`/`readSync`), which is how every bounded read now goes to disk.
