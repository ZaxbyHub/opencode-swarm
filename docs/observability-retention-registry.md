# Retention and Read-Amplification Registry

Issue: #2036. This is PR 08 of 23 in the observability sequence (#2029–#2051),
the documentation/policy gate that ratifies the complete retention and
read-amplification matrix for every durable stream under `.swarm/` and the
platform-data roots. It blocks PRs 09–23 until every row below carries an
owner-approved final disposition.

**The canonical, field-complete record is machine-readable** (registry data schema version: `RETENTION_REGISTRY_SCHEMA_VERSION`, currently 1, exported alongside the rows)**:**
`scripts/retention-registry.data.ts` (`RETENTION_REGISTRY`). Every row there
carries ALL issue-required columns — path grammar, canonical root, writer
symbols, reader symbols, schema/version, state class, privacy class,
byte/age/count limits with global-vs-per-trigger/per-key scope, read byte
bound with sync/async behavior, lock/concurrency model, crash behavior,
close/archive/reset policy, legacy compatibility, health signal, owner, and
final disposition. The CI gate `bun run check:retention`
(`scripts/check-retention-registry.ts`) enforces: every durable-writing
module under `src/` is registered (or on the explicit plumbing exemption
list), every disposition is one of the three allowed kinds with a resolvable
citation, and every row id appears in this document as a backtick-wrapped
slug. This document renders the matrix per category and records the evidence.
**Provenance and canonicity:** the tables below are a hand-maintained
rendering of the data module — no committed generator exists; when a row
changes, update the matching table cell by hand. The mechanically enforced
doc↔data contract is row-id presence, NOT table-cell equality; the data
module is canonical wherever the two disagree.

Companion documents: `docs/observability-event-contract.md` (the 17-store
producer/consumer matrix at correlation granularity, PR 01) and
`docs/engineering-invariants.md` (the #2036 invariant entry). Sequence
context: parents #1823/#2025; amendment issue #2309 (residual unowned
streams).

---

## Method (how this registry was built)

Base tree `main` @ `79fbf3ae` (PRs 01–07, #2029–#2035, merged); citations
were verified against the source tree during the gate's localization passes
(8 parallel subsystem lanes + a gap lane + main-thread conflict resolution)
and re-verified through independent review — including every "no reader"
claim, one of which was corrected during review. The writer universe was enumerated mechanically (Appendix A)
and cross-checked against PR 07's `WRITER_CLASSIFICATION`
(`src/utils/atomic-write.ts:358-450`). Dispositions were validated against the
open issues' own "independently verified cause" sections — the sequence issues
(#2037–#2042, #2046) confirm the same root causes independently.

## Legends

- **State class** — `authoritative` (the record IS the domain fact),
  `operational` (telemetry/diagnostic signal), `derived-rebuildable`
  (projection of authoritative state or rebuildable cache),
  `governed-content` (knowledge/evidence artifacts under retention governance).
- **Privacy class** — `metadata` (structured/discriminator-only records: ids,
  counters, event kinds, timing — no free-text payload), `content` (streams
  whose primary payload is free text: lessons, reports, skills, messages,
  agent work product), `mixed` (both). The line is the payload, not the file
  type: an insight candidate awaiting promotion carries the same lesson bytes
  the knowledge store does, so the feeder queue is `content` exactly like its
  destination (issue #2036 scenario 5 forbids reclassifying content as
  metadata to sample it freely).
- **Limit scope** — `global` (one ceiling for the whole store),
  `per-trigger` (bounded only per invocation), `per-key` (per task/skill/file
  etc. — **must also declare `writeLimits.keyspaceBound`**, see the keyspace
  rule below), `session-scoped` (bounded by the close/finalize lifecycle),
  `none` (verified unbounded → always a fix-in-issue row).
- **Keyspace bound** (`writeLimits.keyspaceBound`) — for `per-key` rows, what
  makes the *set of keys* finite, with a `path:line` citation. Optional on the
  TypeScript type because it is meaningless for the other scopes; **required by
  the gate** for every `per-key` row whose disposition is not `fix-in-issue`.
- **Disposition** (issue #2036 rule — no owner waiver):
  - **fix in #NNNN** — a linked implementation issue in the sequence, or the
    sequence-amendment issue #2309 opened under #2036's amendment clause;
  - **retain by design** — cites the authoritative durability/lifecycle
    requirement plus the bounded reader/close proof;
  - **not a defect** — cites the source proof (bounded queue, batch-scoped
    artifact, or hard byte bound).
  - `defer` / `TBD` / `unknown` / "future issue" are not completed rows; the
    check rejects them.

## The three-way rule for full-file readers (acceptance criterion)

Every current full-file reader in the registry satisfies exactly one of:
(1) a **hard source-proven byte bound** — e.g. telemetry rotation caps both
generations at ≤20 MiB; `skill-usage` is now a hard global byte/age/count
bound (`SKILL_USAGE_LIMITS`, issue #2038) backed by the authoritative
`skill-usage-pending` sidecar, not a FIFO cap; changelog/knowledge lists are
FIFO-capped;
(2) a **linked fix PR** — #2039 (events), #2040 (shell-audit), #2037
(context-telemetry), #2041 (PRM), #2042 (subscriptions);
(3) an **authoritative lifecycle rationale** — plan-ledger replay, receipts-v2
queries, evaluation-store integrity reads, memory-store loads (all
cap-bounded or authoritative-by-contract).
No correctness state is classified as sampleable operational telemetry, and no
content-bearing stream is reclassified as metadata (privacy classes are
recorded per row in the data module).

## The keyspace rule for `per-key` limits (issue #2038 recurrence guardrail)

**The defect class.** A retention policy scoped *per key* was mistaken for a
global bound. A per-key cap bounds each key's history but **not the store**:
steady-state size is `O(distinct-keys × per-key-cap)`, which is a ceiling only
when the *keyspace* is finite. In issue #2038 the keyspace was `skillPath` —
one key per distinct skill name, with no limit on how many exist — so a
500-entry-per-skill prune produced growth with no ceiling. The row passed CI
because the gate constrained only `scope: 'none'` and said nothing whatsoever
about `per-key`.

**The rule.** A row with `writeLimits.scope === 'per-key'` whose disposition is
**not** `fix-in-issue` MUST declare `writeLimits.keyspaceBound`. The value names
what makes the keyspace finite and cites `path:line` evidence. A keyspace is
finite iff **either**

1. the key domain is a **closed set** — a TypeScript enum/union, or an index
   bounded by a max-concurrency constant; **or**
2. something **deletes keys** and that deleter's trigger is **global**, not
   per-key.

A per-key cap is never an answer to this field — it is the thing the field
exists to qualify. `fix-in-issue` rows are exempt: they already declare the
stream a defect under a named owning issue, so there is nothing to whitewash.

**The gate rejects two failures**, both in `collectKeyspaceBoundErrors`
(`scripts/check-retention-registry.ts`), and both name #2038 in the message:

- the field is **missing or empty** on a non-`fix-in-issue` `per-key` row; or
- the field is present but **declares the keyspace not finite** (matching
  `unbounded`, `no … ceiling`, `nothing deletes/reaps/removes/prunes`) while the
  disposition still claims the stream is fine. Admitting the defect in prose is
  not a way to keep a `not-a-defect` disposition — such a row must become
  `fix-in-issue`. The `skill-changelogs` row is the reference example of that
  admission carried honestly, under #2309.

`keyspaceBound` is also swept for the no-owner-waiver strings (`TBD`, `defer`,
`unknown`, "future issue") and its cited paths are rot-checked like every other
citation.

**Why a CI check and not a stronger rung.** The obligation is a *conjunction*
across sibling fields — `writeLimits.scope === 'per-key'` **and**
`disposition.kind !== 'fix-in-issue'` — and `disposition` is a sibling of
`writeLimits`, not a member of it, so no discriminated union on `scope` can
express it; narrowing `scope` alone would force the field onto the
`fix-in-issue` rows the rule deliberately exempts. A type can also require
presence but check neither non-emptiness nor whether the prose answers the
question (`keyspaceBound: ''` typechecks). A lint rule is the wrong tool: this
is a cross-field semantic property of one project data file, keyed on values
rather than code shape. And there is no runtime rung — the registry lives under
`scripts/` and is deliberately never loaded by the plugin (AGENTS.md invariants
1 and 2). A CI check over the data artifact is the strongest available rung, and
it is the same rung the sibling `scope: 'none'` rule already occupies.

**Applying the rule to the existing registry found two live instances of the
#2038 class**, both previously carrying a `not-a-defect` disposition whose only
proof was a per-key cap. Both are now `fix-in-issue` under #2309, and each keeps
its `keyspaceBound` field as the source evidence behind that disposition:

- `test-history` (`.swarm/cache/test-history.jsonl`) — `MAX_HISTORY_PER_TEST`
  = 20 is a per-key FIFO over a `(testFile, testName)` key; the prune re-emits
  the newest 20 of *every* key it finds, so keys for renamed or deleted tests
  are never evicted; there is no global count/byte/age cap; and `.swarm/cache/`
  is in no close or reset list. This row's read bound previously stated the
  fallacy outright — "bounded transitively by 20/test cap × test population" —
  which is the clearest illustration in this registry of why the rule exists.
- `pr-feedback-event-queues` (`.swarm/pr-feedback-events/{session-stem}.json`)
  — one file per session id; the `MAX_TRACKED_SESSIONS` = 200 FIFO evicts from
  an in-process `Map` and deletes no file, claiming an event rewrites the record
  in place rather than removing it, and the directory is in no close or reset
  list.

They are filed under #2309 rather than a new issue because it already owns this
exact shape for `skill-changelogs` (a per-key cap with no bound on the key
population) under #2036's amendment clause. That routing is an inference from
the `skill-changelogs` precedent, not a pre-existing assignment — if #2309 is
the wrong owner, the disposition is the thing to change, not the evidence.

## Close/reset/archive reconciliation (acceptance criterion)

`/swarm close` (finalize) semantics are recorded per row. The reconciled sets
(read from `src/commands/close.ts` on the gate tree): `ARCHIVE_ARTIFACTS`
(:370-421), `ACTIVE_STATE_TO_CLEAN` (:474-503), `ACTIVE_STATE_DIRS_TO_CLEAN`
(:565-574 — coder-settlements, council, evidence, session, scopes,
spec-archive, task-repairs, task-terminals), dynamic artifacts
(post-mortem-*.md :1418-1477/:1709-1728; drift-report-phase-*.json :1423/:1712;
config-backup-* :1754-1762; plan-ledger siblings :1775-1795; SWARM_PLAN
checkpoints :1808-1833), deliberate exclusions (locks/ :1480-1481;
knowledge.jsonl archived-not-cleaned :452-454; swarm.db -wal/-shm :500-502).
Nothing in this registry is simultaneously "deleted" and "needed for
recovery": every destructive path has a preservation mechanism — close
archives before cleaning (archive-first guard :1637-1671), reset-session
backs up to `.swarm/reset-backups/` (retention 5), ledger truncation archives
the original before replacement, residue and receipt tails are quarantined
with rollback, and the #2309 rows are precisely the streams whose lifecycle
decision is *missing today* (they are untouched, never deleted-and-needed).

---

## The registry

### Category 1 — Core telemetry and event streams (6 rows)

| Row id | Path grammar | State class | Write limit (scope) | Read bound | Close policy | Disposition → owner |
|---|---|---|---|---|---|---|
| `telemetry-jsonl` | .swarm/telemetry.jsonl (+ single rotated .1) | operational | ROTATION_CHECK_INTERVAL=50 emits; rotate at 10 MiB (rotateTelemetryIfNeeded maxBytes, src… (global) | full-file: ≤ 2×10 MiB — both readers full-read but the rotation i… | archived+cleaned — flush (close.ts:1274), ARCHIVE_ARTI… | retain by design — #2051 (legacy-path retirement/migration owner); this gate (ratification) |
| `events-jsonl` | .swarm/events.jsonl | operational | CORE_EVENT_LIMITS: ACTIVE_MAX_BYTES=2 MiB / ACTIVE_MAX_ENTRIES=20k / AGE_MAX_MS=7d on the retained window (authority set exempt — indexed); compact pass 512 KiB; checkInterval 25 (global) | manifest+retained-window (tail-bounded): READ_MAX_BYTES=3 MiB, manifest-stripped, coverage disclosed; lifetime counts from the manifest header | finalized validated cut (finalizeCoreEventsForClose) then archived+cleaned together with events-authority-index.json | retain by design — #2039 (shipped PR) |
| `events-authority-index` | .swarm/events-authority-index.json | authoritative | AUTHORITY_INDEX_MAX_ENTRIES=20k FIFO (~2 MiB worst case); eviction counted + disclosed via core_events_health (global) | indexed: whole-file JSON read of the capped index; misses fall back to the bounded retained-window scan | archived+cleaned together with events.jsonl (same boundary as the WAL dirs it dedupes for) | retain by design — #2039 (shipped PR) |
| `context-telemetry` | .swarm/context-telemetry.jsonl | operational | ACTIVE_MAX_BYTES=256KiB / ACTIVE_MAX_ENTRIES=10k / AGE_MAX_MS=30d on the retained raw window; lifetime folded aggregate in the manifest header (global) | manifest+retained-window: bounded — READ_MAX_BYTES=280KiB, independent of total history | archived as a validated cut — finalizeContextTelemetry before copy, ARCHIVE_ARTIFACTS (close.ts); NOT cleaned (persists; compaction is retention) | retain by design — #2037 (shipped PR) |
| `skill-usage` | .swarm/skill-usage.jsonl | derived-rebuildable | HARD GLOBAL: SKILL_USAGE_LIMITS maxEntries=5,000/maxBytes=1.5MiB/maxAgeMs=90d, floorPerSkill=20 (global) | mixed full-file + tail: full readers bounded at readMaxBytes=1,677,722 B (truncatedRead reported); tail 64 KiB | untouched — persists across sessions | retain by design — #2038 (implemented) |
| `skill-usage-pending` | .swarm/skill-usage-pending.json | authoritative | queueMaxRecords=5,000/queueMaxBytes=512KiB/maxAgeMs=90d/maxAttempts=5 (global) | indexed: single JSON doc bounded at readMaxBytes=1,677,722 B; oversized reads quarantined | untouched — persists across sessions | retain by design — #2038 (implemented) |

### Category 2 — Background delegation, PR monitor/feedback, lane sidecars (10 rows)

| Row id | Path grammar | State class | Write limit (scope) | Read bound | Close policy | Disposition → owner |
|---|---|---|---|---|---|---|
| `background-delegations-ledger` | .swarm/background-delegations.jsonl (+ .checkpoint.json + .manifest.j… | authoritative | compaction high-water 1 MiB / low 256 KiB (:82-83); MAX_RECOVERY_LEDGER_BYTES 4 MiB; MAX_… (global) | indexed (checkpoint+tail) with full-fold fallback: legacy/tail reads hard-bounded at 4 MiB (MAX_RECOVERY_… | archived-only — ARCHIVE_ARTIFACTS (close.ts:417-419); … | not a defect — #2034 (merged) |
| `background-delegations-health` | .swarm/background-delegations-health.json | derived-rebuildable | bounded by described data (checkpoint/ledger bounds above) (global) | indexed: single small JSON artifact | archived-only — ARCHIVE_ARTIFACTS (close.ts:420), not … | not a defect — #2034 (merged) |
| `background-delegations-fallback` | .swarm/background-delegation-fallback/*.json + .swarm/background-code… | authoritative | MAX_LIVE_BACKGROUND_FALLBACKS 256 (:64); per-file 1 MiB (:75); reservations ≤256 entries … (global) | directory-scan: ≤256 files × 1 MiB | untouched (cross-session recovery state) | not a defect — #2034 (merged) |
| `pr-monitor-subscriptions` | .swarm/pr-monitor/subscriptions.jsonl | operational | maxSubscriptions caller parameter on subscribe ONLY (:99,:265-274); NO global byte/count/… (per-trigger) | full-file: unbounded fold on every poll/update/list/sweep | untouched | **fix in #2042** — #2042 |
| `pr-feedback-event-queues` | .swarm/pr-feedback-events/{session-stem}.json (+ .lock) | operational | MAX_PR_FEEDBACK_MONITOR_EVENTS 20 per queue (:14); MAX_QUEUE_BYTES 512 KiB per file (:15)… (per-key; keyspace NOT finite — one file per session id, nothing unlinks it) | indexed: ≤512 KiB hard read bound | untouched | **fix in #2309** — #2309 |
| `lane-results-outputs` | .swarm/lane-results/{batchDigest}/{laneDigest}/{outputDigest}.json + … | governed-content | MAX_LANE_OUTPUT_STORED_BYTES 10 MiB PER-FILE (lane-output-store.ts:15, degraded beyond); … (per-key) | indexed: per-artifact 10 MiB write ceiling; candidates full-par… | untouched — accumulates across batches | **fix in #2045** — #2045 |
| `lane-delivery-cache` | .swarm/lane-delivery-cache.json | operational | MAX_DELIVERED_LANE_OUTPUT_KEYS 1024 (:35); MAX_TRACKED_SESSIONS 16 (:36); MAX_TRACKED_DIR… (global) | indexed: single bounded JSON | untouched | not a defect — this-gate |
| `pr-review-run-artifacts` | .swarm/pr-review/{run_id}/{findings.jsonl, feedback-handoff.json, tri… | governed-content | per-run: findings ≤1000 records/call + 10 MiB read guard; run directories accumulate with… (per-key) | line-bounded: 10 MiB read guard | untouched — accumulates across review runs | **fix in #2309** — #2309 |
| `status-artifacts` | .swarm/automation-status.json + .swarm/evidence-summary.json | operational | single rewritten snapshot (filename ≤255 chars :66) (global) | indexed: single small JSON | untouched | not a defect — this-gate |
| `locks-dir` | .swarm/locks/{sha256|.base64}.lock + .meta sidecars | operational | LOCK_TIMEOUT_MS 5 min stale expiry; cleanupExpiredLocks sweep (:250-297) (global) | directory-scan: live locks only (expired filtered) | untouched — deliberately excluded from close (close.ts… | not a defect — #2035 (merged) |

### Category 3 — Evidence trajectories, PRM, insight, postmortems, consensus, epic/turbo (12 rows)

| Row id | Path grammar | State class | Write limit (scope) | Read bound | Close policy | Disposition → owner |
|---|---|---|---|---|---|---|
| `task-evidence-trajectory` | .swarm/evidence/{taskId}/trajectory.jsonl | derived-rebuildable | max_lines (now prm-coupled, default 1000) PER-FILE enforced at write time; truncation keeps newest floor(max_lines/2) (:114-… (per-key) | full-file: ≤max_lines lines per file by write-side truncation | cleaned — evidence/ dir archived+cleaned (ACTIVE_STATE… | not a defect — this-gate |
| `prm-session-trajectories` | .swarm/trajectories/{sessionId}.jsonl (+ .meta.json checkpoint; transient .lock/*.tmp) | derived-rebuildable | ONE knob prm.max_trajectory_lines (default 1000) governs cache AND disk compaction (newest floor(maxLines/2)); sovereign byte ceiling max(64 KiB… (per-key) | tail-bounded-window: readMaxBytes 1 MiB (steps 64 KiB), coverage disclosed; never whole-file | untouched (bounded at write; age 7 d + count 200/dir sweep reaps) | retain by design — #2041 (shipped PR) |
| `prm-replays` | .swarm/replays/{sessionId}-{timestamp}.jsonl | operational | per-artifact 1 MiB byte cap at write (REPLAY_LIMITS; skip + one-time warn at cap); shared age 7 d + count 200/dir sweep (per-key) | write-only: n/a | untouched (age/count sweep only) | retain by design — #2041 (shipped PR) |
| `insight-candidates` | .swarm/insight-candidates.jsonl | operational | INSIGHT_CANDIDATES_MAX_ENTRIES 500 GLOBAL FIFO (micro-reflector.ts:291,333-335) (global) | full-file: ≤500 lines by the global FIFO cap | untouched (bounded queue) | not a defect — this-gate |
| `postmortems` | .swarm/post-mortem-{planId}.md | governed-content | one bounded-input report per plan (inputs capped :38-43); idempotent dedup (per-key) | full-file: single report per plan | archived+cleaned — dynamic artifacts (close.ts:1418-14… | not a defect — this-gate |
| `epic-promotions-evidence` | .swarm/evidence/epic-promotions.jsonl | operational | no per-file cap; bounded by session — evidence/ dir archived+cleaned at close (close.ts:5… (session-scoped) | full-file: session-scoped file (close-cleaned) | cleaned — evidence/ dir lifecycle | not a defect — this-gate |
| `knowledge-promotion-evidence` | .swarm/knowledge-promotion-evidence.jsonl | derived-rebuildable | MAX_PROMOTION_EVIDENCE_ENTRIES 2000 GLOBAL FIFO (:41,92-105) (global) | indexed: authoritative reader queries the receipt ledger (bound… | untouched (derived, bounded) | not a defect — this-gate |
| `epic-turbo-state` | .swarm/epic-state.json + .swarm/epic/{calibration.json,divergence.jso… | operational | calibration map monotonic; divergence.jsonl no write cap; session maps uncapped; epic/ + … (none) | mixed full-file + tail: divergence reader tail-bounded 16 MiB; state readers f… | untouched — epic/, recovery/, turbo-state.json, epic-s… | **fix in #2309** — #2309 |
| `lean-turbo-evidence` | .swarm/evidence/{phase}/lean-turbo/{laneId}.json + lean-turbo-phase.j… | governed-content | per-phase/per-lane artifacts; evidence/ dir archived+cleaned at close (session-scoped) | indexed: session-scoped evidence dir | cleaned — evidence/ dir lifecycle | not a defect — this-gate |
| `evidence-gate-artifacts` | .swarm/evidence/{phase}/{drift-verifier,hallucination-guard,mutation-… | governed-content | per-phase overwrite or bounded per-run artifacts; whole tree archived+cleaned at close (session-scoped) | indexed: single small JSON per gate | cleaned — evidence/ dir lifecycle | not a defect — this-gate |
| `drift-reports` | .swarm/drift-report-phase-{N}.json | governed-content | one report per phase; archived+cleaned as close dynamic artifacts (session-scoped) | indexed: per-phase files | archived+cleaned — dynamic artifact regex at close.ts:… | not a defect — this-gate |
| `doc-drift-signals` | .swarm/doc-drift-phase-{N}.json | operational | one signal per phase; NOT in close clean lists — accumulates across phases/plans (none) | indexed: per-phase small JSON | untouched — accumulates | **fix in #2309** — #2309 |

### Category 4 — Guardrail audit, attestations, scope evidence (9 rows)

| Row id | Path grammar | State class | Write limit (scope) | Read bound | Close policy | Disposition → owner |
|---|---|---|---|---|---|---|
| `shell-audit` | .swarm/session/shell-audit.jsonl (+ transient .lock) | operational | SHELL_AUDIT_LIMITS: activeMaxBytes 1 MiB sovereign / securityMaxEntries 4,000 (typed, never age-folded) / allowedMaxEntries 2,000 + 72 h / compact 256 KiB/pass / maxLineBytes 64 KiB (global) | manifest+retained-window (tail-bounded): READ_MAX_BYTES=256 KiB, manifest-stripped, coverage disclosed; render capped at 200 entries | finalized validated cut (finalizeShellAuditForClose) before the session/ dir archive copy, then archived+cleaned; lock released by finalize | retain by design — #2040 (shipped PR) |
| `attestations` | .swarm/evidence/attestations.jsonl (+ attestation_rejected events in … | governed-content | one line per attestation decision; evidence/ dir archived+cleaned at close (session-scoped) | write-only: n/a | cleaned — evidence/ dir lifecycle | not a defect — this-gate |
| `scopes-family` | .swarm/scopes/{scope-{taskId}.json, binding-*.json, *.generation-lock… | authoritative | MAX_FILES_PER_SCOPE 10k (:87); MAX_SCOPE_BYTES 2 MiB (:89); MAX_BINDING_FILES_TO_SCAN 10k… (global) | directory-scan: ≤10k files scanned, ≤2 MiB per scope read | cleaned-only — clearAllScopes rmSync, NOT archived ("s… | not a defect — this-gate |
| `task-workflow-evidence` | .swarm/evidence/{taskId}.json | authoritative | retryHistory ≤3 (schema :295); per-task file; evidence/ archived+cleaned at close (per-key) | full-file: single per-task JSON | cleaned — evidence/ dir lifecycle | not a defect — this-gate |
| `evaluation-store` | .swarm/evolution/** (gate-audit/{runId}/, runs/, decisions/, task-set… | governed-content | immutable write-once (no rewrite, divergent rewrite throws); consensus retention config-d… (global) | directory-scan: enumeration caps (1000/2000); per-artifact full reads | untouched — evolution/ is in no close clean list (held… | retain by design — this-gate |
| `harness-evolution-store` | .swarm/evolution/harness/{current.json,candidates/{candidateId}/**,versions/{versionId}.json,ledger/{active-generation.json,generation-*/NNNNNN.jsonl}} | authoritative | max_versions 100; max_inactive_candidates 32 plus newest handoff; 8 MiB candidate cap; 256 KiB ledger segments compacted at max_replay_records (global) | indexed + line-bounded: single artifacts; replay default 10,000; explicit history/audit bounds | untouched — durable activation and rollback substrate | retain by design — #1825 |
| `task-gate-evidence` | .swarm/evidence/task-gate-requirements/{taskId}.jsonl (+ repaired tas… | authoritative | MAX_TASK_GATE_REQUIREMENTS_BYTES 256 KiB per task file (:13, hard-fails OVERSIZED); repai… (per-key) | line-bounded: reads reject files over 256 KiB (typed error) | cleaned — evidence/ dir archived+cleaned at close | not a defect — this-gate |
| `sast-baseline` | .swarm/evidence/{phase}/sast-baseline.json | governed-content | MAX_BASELINE_FINDINGS 2000 (:37); MAX_BASELINE_BYTES 2 MiB (:40) with truncation :413-433 (per-key) | full-file: ≤2 MiB by write-side cap | cleaned — evidence/ dir lifecycle | not a defect — this-gate |
| `review-receipts` | .swarm/review-receipts/{YYYY-MM-DD}-{id}.json + index.json | governed-content | one small file per review receipt; NOT in close clean lists — accumulates (none) | indexed: manifest lookup + per-file reads | untouched — accumulates across reviews | **fix in #2309** — #2309 |


### Category 5 — Plan durability, evidence bundles, council (12 rows)

| Row id | Path grammar | State class | Write limit (scope) | Read bound | Close policy | Disposition → owner |
|---|---|---|---|---|---|---|
| `plan-ledger` | .swarm/plan-ledger.jsonl (+ archived-*.jsonl siblings, reconcile-arch… | authoritative | append-only by contract — NO cap, NO sampling, NO truncation (verified: only corruption-r… (global) | full-file: authoritative-lifecycle rationale: the ledger IS the p… | archived + terminal-state REMOVED unconditionally so a… | retain by design — this-gate |
| `plan-projections` | .swarm/plan.json + .swarm/plan.md | derived-rebuildable | single rewritten files derived from the ledger (rebuildable by replay) (global) | full-file: single plan document | archived+cleaned (plan.json/plan.md in both close list… | not a defect — this-gate |
| `plan-checkpoints-exports` | .swarm/plan-export/SWARM_PLAN.{json,md} (+ legacy .swarm/SWARM_PLAN.*… | governed-content | bounded export set; checkpoints.json FIFO 20 default (checkpoint.max_retention) (global) | full-file: single checkpoint document / ≤20-entry log | archived + removed from all three locations (close.ts:… | not a defect — this-gate |
| `evidence-bundles` | .swarm/evidence/{taskId}/evidence.json | governed-content | ≤100 entries + ≤500 KiB per bundle; retention 30 d / 10 bundles; evidence/ close-scoped (per-key) | full-file: ≤500 KiB per bundle by write-side enforcement | cleaned — evidence/ dir lifecycle (after retention arc… | not a defect — this-gate |
| `phase-participation` | .swarm/evidence/phase-participation.json (+ phase-participation-quara… | authoritative | MAX_PHASE_PARTICIPATION_BYTES 256 KiB (:36); PENDING ≤128; RECEIPTS ≤128 (:37-38); quaran… (global) | full-file: ≤256 KiB by write-side trim | cleaned — evidence/ dir lifecycle | not a defect — this-gate |
| `council-round-state-attempts` | .swarm/council/round-state/{token}.json + .swarm/council/attempts/{to… | authoritative | MAX_ROUND 10 (:18); audit-tail read ≤256 KiB; council/ dir archived+cleaned at close (per-key) | line-bounded: ≤256 KiB audit tail | cleaned — council/ dir lifecycle | **fix in #2046** — #2046 |
| `council-criteria` | .swarm/council/{safeId(taskId)}.json | governed-content | one criteria file per task; council/ dir close-scoped (per-key) | indexed: single JSON per task | cleaned — council/ dir lifecycle | not a defect — this-gate |
| `council-evidence-files` | .swarm/evidence/{phase}/phase-council.json + .swarm/evidence/final-co… | governed-content | per-phase/per-final single artifacts; evidence/ close-scoped (session-scoped) | indexed: single JSON | cleaned — evidence/ dir lifecycle | not a defect — this-gate |
| `record-receipt-artifacts` | .swarm/{implementation-review,issue-publication,reproduction,recurren… | governed-content | single rewritten receipt files; bounded fields (global) | indexed: single small JSONs | untouched (cross-run receipts by design — issue-tracer… | not a defect — this-gate |
| `spec-drift-artifacts` | .swarm/spec.md + .swarm/spec-staleness.json + .swarm/spec-snapshot.md… | authoritative | single-session drift state; spec-archive/ + spec.md + staleness + snapshot all in close c… (session-scoped) | full-file: bounded spec reads (effective-spec.ts:11-14) | archived+cleaned — unconditional removal so next sessi… | not a defect — this-gate |
| `workflow-wal-dirs` | .swarm/coder-settlements/{taskId}.json + .swarm/task-repairs/{taskId}… | authoritative | per-task WAL files; all four dirs in ACTIVE_STATE_DIRS_TO_CLEAN (session-scoped) | indexed: single JSON per task | cleaned — all four dirs archived+cleaned | not a defect — this-gate |
| `summaries` | .swarm/summaries/{S*}.json | governed-content | per-summary files; NO production retention — cleanupSummaries is unwired; summaries/ in n… (none) | indexed: per-file reads; directory listing unbounded | untouched — accumulates | **fix in #2309** — #2309 |

### Category 6 — Knowledge family (10 rows)

| Row id | Path grammar | State class | Write limit (scope) | Read bound | Close policy | Disposition → owner |
|---|---|---|---|---|---|---|
| `knowledge-store` | .swarm/knowledge.jsonl (+ linked/hive store roots via link.json) | governed-content | caller-configured maxEntries (swarm_max_entries default 100) enforced by enforceKnowledge… (global) | full-file: bounded transitively by the configured entry cap | archived-only — ARCHIVE_ARTIFACTS (close.ts:381,452-45… | not a defect — this-gate |
| `knowledge-events` | .swarm/knowledge-events.jsonl + .swarm/knowledge-counter-baseline.jso… | operational | MAX_EVENT_LOG_ENTRIES 5000 GLOBAL FIFO; evicted rows folded into knowledge-counter-baseli… (global) | full-file: ≤5000 lines by FIFO + baseline folding | untouched (bounded diagnostic stream) | not a defect — this-gate |
| `knowledge-application-legacy` | .swarm/knowledge-application.jsonl + .swarm/.knowledge-shown.json | derived-rebuildable | MAX_LEGACY_APPLICATION_LOG_ENTRIES 5000 FIFO (:40,143-145) (global) | full-file: ≤5000 lines by FIFO | untouched (bounded compatibility stream) | not a defect — #2051 (retirement owner) |
| `knowledge-receipts-v2` | .swarm/knowledge-receipts-v2.jsonl (+ .snapshot.json + -archive.jsonl… | authoritative | MAX_JOURNAL_RECORDS 2000 / 32 MiB; MAX_ARCHIVE_RECORDS 10000 / 16 MiB; grace DEFAULT_RECE… (global) | indexed: journal ≤2000 records; archive ≤10000 — both hard-capp… | close may copy for forensics but NEVER deletes live or… | not a defect — #2031 (merged) |
| `knowledge-aux-lists` | .swarm/knowledge-{rejected,quarantined,unactionable,rewrites}.jsonl | governed-content | rejected FIFO 20 (default); quarantined FIFO 100; unactionable FIFO 200 (deduped); rewrit… (global) | full-file: ≤ cap per list (20/100/200/2000) | knowledge-rejected.jsonl archived+cleaned (ACTIVE_STAT… | not a defect — this-gate |
| `knowledge-retractions` | .swarm/knowledge-retractions.jsonl | governed-content | NONE (none) | full-file: unbounded | untouched | **fix in #2309** — #2309 |
| `hive-stores` | <hive-data-dir>/shared-learnings.jsonl (+ -rejected.jsonl, -events.js… | governed-content | store cap via HiveMutationOutcome.maxEntries under the same transaction; events FIFO 5000… (global) | full-file: store capped by configured maxEntries; events ≤5000; r… | untouched (cross-project hive) | retain by design — #2033 (merged) |
| `synonym-map` | .swarm/synonym-map.json | derived-rebuildable | DEFAULT_MAX_PAIRS 500 LRU (:40); MAX_TOKEN_LENGTH 64 (:38) (global) | indexed: read ceiling ≈ maxPairs×512 B | untouched | not a defect — this-gate |
| `recommendation-ledger` | <knowledgeStore>/learning/recommendation-ledger.jsonl | operational | MAX_RECOMMENDATION_LEDGER_ENTRIES 500 FIFO; MAX_ENTRY_BYTES 4096; ceiling ≈2 MiB (:131,14… (global) | full-file: ≤500 entries × 4 KiB | untouched (bounded) | not a defect — this-gate |
| `link-pointers` | .swarm/link.json + .swarm/memory-link.json | authoritative | single pointer files (global) | indexed: single JSON | untouched (cross-session link state) | not a defect — this-gate |

### Category 7 — SQLite, memory stores, caches, repo graph (13 rows)

| Row id | Path grammar | State class | Write limit (scope) | Read bound | Close policy | Disposition → owner |
|---|---|---|---|---|---|---|
| `project-db` | .swarm/swarm.db (+ transient -wal/-shm sidecars) | authoritative | small config/profile tables; DB archived (WAL-consistent, #2030) + cleaned at close (session-scoped) | indexed: SQL queries | archived+cleaned — closeProjectDb releases Windows loc… | not a defect — #2030 (merged) |
| `global-db` | <platformConfigDir>/global-rules.db | governed-content | user-authored global rules content (bounded by user input, not traffic) (global) | indexed: SQL queries | untouched (cross-project user content) | retain by design — this-gate |
| `memory-sqlite` | .swarm/memory/memory.db (+ cohort roots) | authoritative | no auto-eviction (explicit delete/compactMaintenance); reflection-service asserts total s… (global) | indexed: SQL LIMIT queries; 16 MiB store assertion | untouched (cross-session memory; close does not archiv… | not a defect — this-gate |
| `memory-jsonl-provider` | .swarm/memory/{memories,proposals,audit,reward-events,outcome-events}… | derived-rebuildable | outcome events ≤1000 per memory (:252-260,322-330); memory entries capped by configured m… (global) | full-file: in-memory store bounded by configured cap | untouched (legacy store; migrated forward) | not a defect — this-gate |
| `consolidation-log` | .swarm/memory/consolidation-log.jsonl | operational | NONE (none) | full-file: unbounded | untouched | **fix in #2309** — #2309 |
| `memory-run-logs` | .swarm/runs/{runId}/memory.jsonl + .swarm/memory/unitid-probe.jsonl | operational | per-run files, NO cap; runs/ in no close clean list (unitid-probe is opt-in diagnostics) (none) | full-file: unbounded per run | untouched — runs/ accumulates | **fix in #2309** — #2309 |
| `reflections` | .swarm/reflections/lessons.{json,md} | derived-rebuildable | MAX_REFLECTION_ENTRIES 2000 (:39); artifacts ≤256 KiB (:40); graph read ≤16 MiB (:42) (global) | indexed: ≤256 KiB read bound | untouched | not a defect — this-gate |
| `run-memory` | .swarm/run-memory.jsonl | operational | no per-file cap; bounded by session — archived+cleaned at close (ACTIVE_STATE_TO_CLEAN cl… (session-scoped) | full-file: session-scoped (close-cleaned) | archived+cleaned | not a defect — this-gate |
| `documents-cache` | .swarm/evidence-cache/documents.jsonl | derived-rebuildable | config cache_max_bytes (512 B–50 MiB) / cache_max_records (10–100k); no-op when unset (do… (per-trigger) | line-bounded: streamed ≤100 MiB read cap | pruned via close retention forwarding | not a defect — this-gate |
| `repo-graph` | .swarm/repo-graph.json | derived-rebuildable | rebuildable from source (buildImpactMap/graph builder); archived+cleaned at close (ACTIVE… (session-scoped) | full-file: cached + validated; reflection reader hard-bounded 16 … | archived+cleaned | retain by design — this-gate |
| `repo-graph-fingerprint` | .swarm/repo-graph.fingerprint.json | derived-rebuildable | bounded read (24 MiB); BUT repo-graph.json is close-cleaned while the fingerprint sidecar… (session-scoped) | indexed: ≤24 MiB / ≤100,256 entries | untouched — orphaned after close cleans the graph | **fix in #2309** — #2309 |
| `test-history` | .swarm/cache/test-history.jsonl | operational | MAX_HISTORY_PER_TEST 20 FIFO per (file,test) key (:19); bounded error/stack/changed-files… (per-key; keyspace NOT finite — no key is ever evicted) | full-file: NOT bounded — the whole file is read; the former "20/test cap × test population" claim is the #2038 fallacy | untouched (cache/) | **fix in #2309** — #2309 |
| `impact-map` | .swarm/cache/impact-map.json | derived-rebuildable | rebuildable via buildImpactMap (:449-455); size bounded by repository file population (session-scoped) | full-file: rebuildable cache; stale entries rejected by mtime che… | untouched (cache/) | not a defect — this-gate |

### Category 8 — Close/reset, worktree, doctor, session, warnings/automation, skills (25 rows)

| Row id | Path grammar | State class | Write limit (scope) | Read bound | Close policy | Disposition → owner |
|---|---|---|---|---|---|---|
| `close-archive-bundles` | .swarm/archive/swarm-{timestamp}-{suffix}/ | governed-content | one bundle per finalize; each bundle bounded by the per-session caps of its contents; NO … (per-trigger) | directory-scan: filename-only scans; contents never re-read | IS the close archive | retain by design — #2030 (merged) |
| `reset-backups` | .swarm/reset-backups/{kind}-{timestamp}/ | governed-content | RESET_BACKUP_RETENTION 5 GLOBAL (:20, prune :125) (global) | write-only: n/a | untouched | not a defect — this-gate |
| `worktree-status-owners` | Bounded merge-status, provisioning-owner/lifecycle, and recovery-authority/journal/credential stores under `.swarm/` | authoritative | hard global byte, entry, and file-count caps declared in the owning modules | directory-scan/indexed: bounded strict recovery scans | untouched (cross-session recovery state) | not a defect — this-gate |
| `worktree-lane-profiles` | <worktree>/.swarm/lanes/{laneIndex}.env | operational | one bounded env file per lane per worktree; removed at lane teardown (:219) (per-key) | write-only: n/a | worktree-scoped — removed with the worktree | not a defect — this-gate |
| `config-doctor-artifacts` | .swarm/config-doctor.json + .swarm/config-backup-{timestamp}.json | operational | single rewritten artifact + timestamped backups deleted by close (close.ts:1754-1762) (global) | indexed: single JSON | doctor artifact untouched; config backups cleaned at c… | not a defect — this-gate |
| `session-state-snapshot` | .swarm/session/{state.json, budget-state.json, session-start.jsonl, s… | authoritative | single snapshot per session; session/ dir archived+cleaned at close; session-start.jsonl … (session-scoped) | full-file: session-scoped files | cleaned — session/ dir lifecycle | not a defect — this-gate |
| `full-auto-state` | .swarm/full-auto-state.json (+ .bak) | authoritative | single rewritten state; denialHistory capped 100; bounded by run lifecycle (global) | indexed: single JSON | untouched (cross-session automation state) | not a defect — this-gate |
| `write-approval-ledger` | .swarm/authority/write-approvals.jsonl | authoritative | single atomically rewritten ledger capped at 512 issued/consumed entries (global) | full-file: at most the write-side 512-entry cap | untouched; expiry, one-shot consumption, and tail compaction bound retained authority | not a defect — #1824 |
| `version-check-cache` | <XDG_CACHE_HOME>/opencode-swarm/version-check.json | operational | single rewritten cache; 24 h interval; HTTP response ≤256 KiB (:35) (global) | indexed: single JSON | outside project .swarm — unaffected | not a defect — this-gate |
| `unacknowledged-criticals` | .swarm/unacknowledged-criticals.jsonl | governed-content | NONE (none) | write-only: n/a | untouched | **fix in #2309** — #2309 |
| `curation-proposals` | <knowledgeStore>/curation-proposals.jsonl (default .swarm/) | operational | NONE (none) | full-file: unbounded — the diagnostics reader parses the whole fi… | untouched | **fix in #2309** — #2309 |
| `context-snapshot` | .swarm/context-snapshot.md | operational | NONE (tier hysteresis +5% governs triggers, not size) (none) | write-only: n/a | untouched | **fix in #2309** — #2309 |
| `capsules` | .swarm/capsules/{task_id}.json | governed-content | one file per task; NO aggregate prune — capsules/ in no close clean list; deleteCapsule i… (none) | indexed: per-task reads; directory accumulates | untouched — accumulates across plans | **fix in #2309** — #2309 |
| `context-map` | .swarm/context-map.json | derived-rebuildable | single rewritten map derived from repository structure (rebuildable) (global) | full-file: single derived map proportional to working set | untouched | not a defect — this-gate |
| `curator-summary` | .swarm/curator-summary.json | operational | single rewritten summary; embedded recommendations deduped/capped (global) | indexed: single JSON | untouched | not a defect — this-gate |
| `close-session-outputs` | .swarm/{close-summary.md, context.md, session-reflection.md, handoff.… | governed-content | single rewritten session documents (close-summary/handoff atomic; context.md sectioned) (session-scoped) | full-file: single documents | archived+cleaned (close-summary.md deliberately writte… | not a defect — this-gate |
| `command-reports` | .swarm/simulate-report.{json,md} + .swarm/handoff-continuation.json | governed-content | single rewritten report files (global) | indexed: single files | untouched (operator artifacts / continuation pointers) | not a defect — this-gate |
| `project-init-configs` | .opencode/opencode-swarm.json + .swarm/config.example.json (+ CLI-man… | governed-content | wx-once init artifacts + operator-edited config (global) | indexed: single config files | unaffected (outside close scope by design) | not a defect — this-gate |
| `bundled-skills` | .swarm/bundled-skills/{slug}/SKILL.md | governed-content | fixed slug set from BUNDLED_PROJECT_SKILLS (:6-50) — no growth dimension (global) | indexed: fixed set of small files | untouched (plugin-owned runtime root) | not a defect — this-gate |
| `skills-proposals` | .swarm/skills/proposals/{slug}.md + .swarm/skills/evals/{slug}/auto-s… | governed-content | evals bounded (MAX_EVAL_FILES 50 / 64 KiB / 100 cases, skill-evaluator.ts:26-31); proposa… (per-key) | directory-scan: eval loads capped; proposal listing unbounded | untouched — pending proposals survive close | **fix in #2309** — #2309 |
| `skill-changelogs` | .swarm/skill-changelogs/{slug}.jsonl | governed-content | MAX_CHANGELOG_ENTRIES_PER_SKILL 200 FIFO per skill; NO global ceiling across skills (veri… (per-key) | full-file: ≤200 lines per skill file | untouched | **fix in #2309** — #2309 |
| `skills-rejected-edits` | .swarm/skills/rejected-edits.jsonl | operational | MAX_REJECTED_EDIT_RECORDS 200 FIFO (:31-32) (global) | full-file: ≤200 records | untouched | not a defect — this-gate |
| `skill-improver-proposals` | .swarm/skill-improver/proposals/{timestamp}.md + .swarm/skill-improve… | governed-content | quota + consolidation: single bounded state files (daily quota caps writes); proposals: N… (none) | directory-scan: proposal listing unbounded; states single files | untouched | **fix in #2309** — #2309 |
| `skill-optimizer-evolution` | .swarm/evolution/skills/{slug}/{candidateId}/{lifecycle.jsonl, state.… | authoritative | NO compaction/close lifecycle (unlike plan-ledger sibling cap); quarantine sidecars unbou… (none) | full-file: per-candidate ledger replay (uncapped) | untouched — evolution/ never cleaned | **fix in #2309** — #2309 |
| `outside-swarm-tool-outputs` | .mutation_patch_{id}.diff (workdir) + extract_code_blocks outputs (us… | governed-content | batch-scoped or user-directed outputs outside swarm state; apply-patch temps always clean… (per-trigger) | write-only: n/a | outside .swarm — out of swarm retention scope by defin… | not a defect — this-gate |
| `residue-quarantine` | .swarm/quarantine/{batch}/ (+ per-batch manifest with sha256/original… | governed-content | bounded by verified stale-residue discovery (old, unlocked, untracked, exact-grammar matc… (per-trigger) | indexed: manifest-driven reads | untouched — recoverable quarantine is preserved across… | retain by design — #2035 (merged) |

### Category 9 — Planned streams (PRs 19-23) (5 rows)

| Row id | Path grammar | State class | Write limit (scope) | Read bound | Close policy | Disposition → owner |
|---|---|---|---|---|---|---|
| `planned-observability-sink` | .swarm/observability/v1/ (planned segments/manifests) | operational | planned: bounded segments with deterministic recovery and measurable loss (#2047 Required… (global) | indexed: planned bounded segment reads | planned: close/archive defined by #2047 | **fix in #2047** — #2047 |
| `planned-rebuildable-index` | planned derived SQLite index over PR 19 segments | derived-rebuildable | planned: bounded, deletable, deterministic rebuild (#2048 Required 1) (global) | indexed: planned SQL queries | planned: never authoritative | **fix in #2048** — #2048 |
| `planned-otlp-export` | planned bounded export queue/spool (opt-in) | operational | planned: bounded queue/spool with independent failure health (#2049 Required) (global) | indexed: planned bounded drain | planned | **fix in #2049** — #2049 |
| `planned-training-vault` | planned consented training vault + derivatives + dataset exports | governed-content | planned: quotas/expiry/withdrawal; content OFF by default, human-only consent (#2050 Trus… (global) | indexed: planned authorized reads only | planned: withdrawal removes lineage-tracked content | **fix in #2050** — #2050 |
| `planned-legacy-retirement` | legacy stream retirement map (telemetry.jsonl, knowledge-application,… | derived-rebuildable | planned: controlled dual-write/read shadowing with kill switches (global) | indexed: planned parity comparisons | planned: archived-session compatibility | **fix in #2051** — #2051 |

---

## Appendix A — committed enumeration evidence

Commands run from the repo root on `main` @ `79fbf3ae` (deterministic;
re-runnable):

```bash
# Durable-write API call sites in src/ (excluding tests)
rg -n "writeFileSync|appendFileSync|appendFile\(|createWriteStream" src --type ts \
  -g '!**/__tests__/**' -g '!*.test.ts'
# Result: 190 matches across 103 files

# fs/promises-style writers (critic-required probe — closes the bare-writeFile hole)
rg -n "\.writeFile\(|[^A-Za-z]writeFile\(" src --type ts -g '!*.test.ts' \
  | grep -v "atomicWriteFile\|writeFileSync\|writeFileAtomic\|writeFileFsynced"
# Result: 20 sites — all registered rows (see the data module writerModules)

# SQLite schema/open sites
rg -n "CREATE TABLE" src --type ts -g '!**/__tests__/**' -g '!*.test.ts'
# Result: 18 sites — db/global-db.ts (3), db/project-db.ts (5),
# memory/sqlite-provider.ts (9), memory/memory-family-migration.ts (1)

# The gate's own enumeration (single source of truth going forward)
bun run scripts/check-retention-registry.ts
# Result: "Retention registry check passed: 99 rows … every enumerated writer
# module is registered or exempt."
```

The enumerator's pattern set (write APIs + atomic-write helper calls + SQLite
open/acquire seams) and the complete writer-module-to-row mapping live in
`scripts/retention-registry.data.ts` (`writerModules` per row plus
`EXEMPT_WRITER_MODULES`, 7 plumbing entries). **Known limitation:** a module
that only mutates a SQLite handle acquired elsewhere is not flagged; the DB
open/acquire seam (`getProjectDb`/`getGlobalDb`/`Database` construction) is
the enforced boundary. Further, deliberately documented seams: (a)
**helper indirection** — a handful of modules write only through shared
transaction helpers (`transactKnowledge`/`transactFile` and friends) and are
registered by OWNERSHIP in `writerModules` rather than by a literal write-call
match in their own source; (b) **copy/rename materialization** — a durable
stream can be materialized by `copyFileSync`/`renameSync` without any write-API
call (the known instance, `src/commands/skill-opt.ts:231` copying eval inputs
under `.swarm/evolution/skills/_eval-input/`, is registered on the
skill-optimizer-evolution row). `copyFileSync` is deliberately NOT a ratchet
pattern because read-side snapshot copies (e.g. cost-accounting's telemetry
temp copy) would be false positives; (c) **raw Bun-native write APIs** —
`Bun.write(`, `Bun.file(...).writer(`, and fd-level `fs.writeSync` are not
matched (zero instances in `src/` today; AGENTS.md already bars direct
`Bun.*` calls outside `src/utils/bun-compat.ts`, and the wrapper's `bunWrite`
IS matched); and (d) **comment/string-literal false positives** — the
line-comment stripper only removes lines that START with `//`, so write APIs
mentioned inside block comments, string literals, or trailing comments still
match. That direction is fail-closed (a non-writer gets flagged and must be
registered or exempted with a reason) — the safe failure mode for a coverage
gate. Finally, citation existence checks are case-sensitive exactly like the
Linux CI that enforces the gate; a case-mismatched citation could pass a
case-insensitive local filesystem and fail only in CI. Line citations in the
data module were verified against
the gate tree and are ungated "verified as of" pointers (the same caveat the
PR 01 matrix carries); the mechanical guarantees are the coverage ratchet and
the disposition rules.

## Appendix B — issue link index (all disposition owners)

Verified resolvable on 2026-08-22 via `gh issue view`:

- Sequence (merged; cited as retain/not-defect proof or context): #2029,
  #2030, #2031, #2032, #2033, #2034, #2035.
- Sequence (open; fix-in-issue owners): #2037, #2038, #2039, #2040, #2041,
  #2042, #2045, #2046, #2047, #2048, #2049, #2050, #2051.
- Amendment issue (open; opened by this gate under #2036's amendment clause):
  #2309 — residual unowned durable streams (knowledge-retractions,
  unacknowledged-criticals, curation-proposals, consolidation-log, runs/,
  context-snapshot.md, epic/calibration + divergence + state maps,
  skill-improver proposals, evolution/skills lifecycle ledgers, capsules,
  summaries, repo-graph fingerprint orphan, pr-review run artifacts,
  review receipts, doc-drift signals; verify items: skill-changelog global
  ceiling, skills proposals/evals/candidates accumulation). Extended by the
  issue #2038 keyspace guardrail with two rows reclassified out of
  `not-a-defect`: `test-history` and `pr-feedback-event-queues` — both per-key
  caps over a keyspace nothing bounds, the same shape as the pre-existing
  skill-changelog verify item.
- Parents: #1823, #2025. This gate: #2036.

## Appendix C — full-resolution contract checklist

- Fresh-main inventory (main @ `79fbf3ae`, PRs 01-07 merged): yes — Appendix A.
- Unique release fragment:
  `docs/releases/pending/2036-retention-read-amplification-registry.md`.
- No missing/ambiguous/deferred row: enforced by `check:retention`
  (disposition kinds, forbidden strings, citation resolution).
- No cleanup authorization based on size alone: the retain-by-design rows
  that resist deletion (archive bundles, evolution store, hive quarantine)
  cite durability requirements, not size; no row authorizes new deletion.
- No unowned legacy reader: every row's legacy compatibility is recorded in
  the data module; retirement ownership for the two legacy streams is #2051.
- Independent reviewer + final critic approval: recorded in the PR.
