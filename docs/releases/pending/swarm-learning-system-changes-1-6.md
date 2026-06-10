# Swarm Learning System: per-agent directives, enforcement, escalation, actionability, reflection, retrieval

## What changed

- **Per-agent directive injection (Change 1).** Every delegated subagent
  (coder, reviewer, test_engineer, sme, docs, designer, critic, curator) now
  receives the subset of knowledge directives scoped to its role and expected
  tools, prepended to its delegation prompt as a
  `<delegate_knowledge_directives>` block with an explicit ack contract
  (`KNOWLEDGE_APPLIED/IGNORED/N_A:<id>`). Acks are parsed when the delegate
  returns; spoofed acks for never-shown directives are dropped, and an
  unacknowledged critical directive is recorded as `violated/unacknowledged`
  and audited to `.swarm/unacknowledged-criticals.jsonl`. New config:
  `knowledge.delegate_max_inject_count` (default 8).

- **Per-directive reviewer verdicts + phase gate (Change 2).** The reviewer
  must emit a `DIRECTIVE_COMPLIANCE` section with one
  `VERIFIED/VIOLATED/N-A:<id>` verdict per directive shown during the phase
  (existing `SKILL_COMPLIANCE` unchanged). Directives may carry a
  `verification_predicate` executed by a new fail-closed runner
  (`grep:` / `tool:` / `file_modified:` / `file_not_modified:` — shell-free,
  allowlisted binaries, path-traversal blocked, 15s timeout, stdin ignored,
  child killed on every exit path). `phase_complete` now blocks while a
  critical directive lacks a terminal outcome or carries an unremediated
  violation; only the architect can override via `accept_violations` + a
  written justification, logged as `override` events.

- **Repeat-mistake escalator (Change 3).** A directive violated twice within
  30 days (across sessions) auto-escalates to
  `directive_priority:'critical'` + `enforcement_mode:'enforce'` with an
  `escalation_history` record and an `escalation` event — exactly once
  (idempotent, race-safe via atomic store transactions). Recent escalations
  surface in the architect briefing and `/swarm status`.

- **Mandatory v3 actionability schema (Change 4).** No new knowledge entry
  reaches the active store without at least one machine-checkable predicate
  (`forbidden_actions` / `required_actions` / `verification_checks` /
  `verification_predicate`) AND one scope tag (`applies_to_agents` /
  `applies_to_tools`). Prose lessons are enriched to that schema by a
  quota-gated curator LLM call (one retry); entries that still fail are
  quarantined to `.swarm/knowledge-unactionable.jsonl` (never silently lost)
  and re-processed by a bounded hardening loop in the skill-improver, which
  promotes hardened entries back to active (append-before-dequeue, so a store
  failure can never lose an entry) or flags `retire_candidate`. All
  entry-minting paths are gated: phase-complete curation, `/swarm close`,
  architecture-supervisor recommendations, curator phase recommendations,
  `knowledge_add` (which now accepts the v3 fields and returns a quarantine
  hint), dark-matter co-change entries (made actionable deterministically),
  and the system-enhancer append path. Hive promotion now carries the
  actionability fields onto promoted entries.

- **Three-cadence reflection (Change 5).** The swarm now captures learning
  signals at three time granularities. *Micro* reflection fires after every
  tool call and classifies outcomes into `success`, `partial`, `failure`,
  `blocked`, `skipped`, or `inapplicable`; short-lived insight candidates are
  emitted to `.swarm/insight-candidates.jsonl`. *Meso* reflection folds
  insight candidates at phase boundaries using the curator's existing LLM
  budget, deduplicating against the active store before any candidate is
  promoted. *Macro* reflection proposes trajectory motifs (recurring failure
  themes across phases) as structured proposals in `.swarm/motif-proposals/`.
  All three cadences are additive and fail-open; no existing curation path is
  blocked if they fail.

- **Retrieval recall upgrades (Change 6).** The `searchKnowledge` core (used
  by both the architect injection path and the new delegate injection path)
  gains four improvements. (a) **MMR rerank** replaces simple score-sort:
  `λ=0.7` relevance–diversity tradeoff ensures diverse directives rather than
  the top-N most similar ones. (b) The `≥0.8` confidence pre-filter is
  removed; low-confidence entries can now surface when they are relevant. (c)
  **Cold-start bonus** (+0.08) is awarded to recently-minted entries
  (`applied_count==0 AND age < 3 phases`) so new lessons get a fair shot
  before their retrieval history accumulates. (d) **Trigger-recall union** adds
  a +0.3 boost for directives whose declared trigger phrase (≥3 tokens) appears
  verbatim in the task title, regardless of corpus-level TF-IDF similarity. (e)
  **Tag co-occurrence synonym map** (`.swarm/synonym-map.json`) learns synonym
  pairs from co-occurring token clusters across entries; the curator rebuilds
  the map after each phase_complete, and retrieval expands query tokens with up
  to 4 synonyms per token for a +0.15 score boost. The map is read-guarded by
  a stat-based byte ceiling and a tamper-resistant coerce path that re-sanitises
  every token and enforces an LRU cap, preventing adversarial entries from
  inflating retrieval cost.

## Why

The knowledge system existed but was operationally bypassed: subagents never
saw lessons, enforcement had teeth only for the architect, and the
applied/violated loop was open. These changes close the loop so the swarm
actually learns from its mistakes — directives reach the agent about to make
the mistake, violations are caught at phase boundaries, repeat offenses
escalate automatically, and every stored lesson is machine-checkable.

## Impact

- Delegation prompts grow by up to `delegate_max_inject_count` directives when
  matching knowledge exists; zero-match delegations are unchanged.
- Phase completion can newly block on unresolved critical directives; the
  error lists the exact IDs and missing verdicts, and the architect override
  path is available for justified acceptance.
- Knowledge curation now performs up to one small LLM call per new lesson at
  phase end (shared `skill_improver.max_calls_per_day` budget, default 10).
  Without an LLM available, lessons queue as unactionable instead of
  activating — recoverable, not lost.
- Retrieval now surfaces more relevant directives for both architect and
  delegate injection paths; the MMR rerank also reduces repetition when
  multiple correlated directives exist.
- The synonym map adds a `.swarm/synonym-map.json` file that is
  auto-maintained by the curator; it is gitignored-by-default (like other
  `.swarm/` files) and grows only up to `synonym_map_max_pairs` (default 500).

## Migration

No migration required. All new config keys have defaults that match prior
behavior. The synonym map is created lazily on first curator run.

## Breaking changes

None.
