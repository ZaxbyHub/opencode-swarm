# Evidence and Telemetry

Swarm writes two kinds of observability data:

- **Evidence bundles** — structured, per-task records of what reviewers, test engineers, and quality gates found. Stored as JSON.
- **Telemetry** — a line-delimited event stream covering session lifecycle, delegations, gate outcomes, and anomalies. Stored as JSONL.

Both are local-first. No network calls. Query them with `jq`, `grep`, or the built-in `/swarm` commands.

---

## Evidence Bundles

### Location

```
.swarm/evidence/<task_id>/evidence.json
```

One bundle per task. Atomic writes via temp file + rename, so a bundle is never half-written even if the process dies mid-save.

### Schema

Each bundle is a versioned container (`src/config/evidence-schema.ts:343`):

```json
{
  "schema_version": "1.0.0",
  "task_id": "2.1",
  "entries": [ /* up to 100 evidence items */ ],
  "created_at": "2026-04-23T10:15:00.000Z",
  "updated_at": "2026-04-23T10:42:11.000Z"
}
```

### Evidence Types

Thirteen types, each with type-specific fields. Common fields: `task_id`, `type`, `timestamp`, `agent`, `verdict`, `summary`, `metadata`.

| Type | Writer | Key fields |
|------|--------|------------|
| `review` | reviewer | `risk`, `issues[].severity`, `issues[].file`, `issues[].line` |
| `test` | test_engineer | `tests_passed`, `tests_failed`, `failures[]`, `test_file` |
| `diff` | coder | `files_changed`, `additions`, `deletions`, `patch_path` |
| `approval` | reviewer | verdict, summary |
| `note` | any | free-form summary |
| `retrospective` | architect | phase metrics, lessons, error taxonomy |
| `syntax` | quality gates | parse errors per language |
| `placeholder` | quality gates | TODO/FIXME/stub findings |
| `sast` | quality gates | `findings[]`, `engine`, `baseline_used` |
| `sbom` | quality gates | CycloneDX output location |
| `build` | quality gates | `run_type` (build/typecheck/test), `exit_code`, `duration_ms` |
| `quality_budget` | quality gates | complexity, API, duplication, test ratios + violations |
| `secretscan` | quality gates | secret-like patterns found |

Full field definitions live in `src/config/evidence-schema.ts`.

### Retention

Config keys (`src/config/schema.ts` → `EvidenceConfigSchema`):

| Key | Archive default | Finalize default | Range | Purpose |
|-----|:---:|:---:|:---:|---------|
| `enabled` | `true` | `true` | — | Master switch |
| `max_age_days` | `90` | **30** | 1–365 | Age threshold for archiving |
| `max_bundles` | `1000` | **10** | 10–10000 | Count cap |
| `auto_archive` | `false` | `false` | — | Future gate (config-only) |
| `cache_max_bytes` | _unset_ | _unset_ | 512 B–50 MiB | Optional documents-cache byte cap (issue #1184) |
| `cache_max_records` | _unset_ | _unset_ | 10–100 000 | Optional documents-cache record cap (issue #1184) |

`/swarm archive` applies two-tier retention: age first, then count. The same execution report includes ordinary evidence, generic evaluation runs, and gate-audit detail, and lists only successful deletions. `/swarm finalize` applies tighter retention (30 days / 10 bundles) to keep only recent evidence. Configure via `evidence.max_age_days` and `evidence.max_bundles` in your project config. Use `--dry-run` to preview.

#### Documents cache retention (issue #1184)

The web_search / web_fetch evidence cache at `.swarm/evidence-cache/documents.jsonl`
is **append-only by default**. Records are written by `writeEvidenceDocuments`
(`src/evidence/documents.ts`) on every search/fetch capture and are never removed
unless you opt in to one or both of the cache retention caps:

| Key | Default | Range | Effect |
|-----|:---:|:---:|---|
| `evidence.cache_max_bytes` | _unset_ (append-only) | 512 B–50 MiB | Prune oldest rows until the surviving file is at or below this size |
| `evidence.cache_max_records` | _unset_ (append-only) | 10–100 000 | Prune oldest rows (by `capturedAt`) until the surviving record count is at or below this number |

When either cap is set, `/swarm archive` and `/swarm finalize` also sweep the
documents cache (in addition to evidence bundles) and the command report includes
a **Documents cache** section showing inventory, pruned count, and byte size
before/after. The prune is:

- **Bounded:** the cache is streamed line-by-line with a hard 100 MiB read cap;
  on breach the prune aborts and leaves the file byte-identical.
- **Atomic:** surviving rows are written to a temp file, fsynced, then renamed
  over the target with Windows-safe retry (`EPERM`/`EBUSY`/`ENOTEMPTY`/`EACCES`,
  5× / 10 ms backoff). On any rewrite failure the temp file is removed and the
  original is left untouched (fail-safe: no-change over partial-change).
- **Corrupt-row tolerant:** lines that fail `JSON.parse` are dropped from the
  rewrite and reported in the `corrupt` count. They are not relocated to a
  sidecar — the bounded-growth contract requires that corrupt rows stop counting
  toward caps.
- **Project-root contained:** all paths route through `validateSwarmPath`; no
  scan outside `.swarm/`.

> **Append-vs-rewrite race (known, accepted):** the cache is NOT locked during
> a prune. A concurrent `web_search`/`web_fetch` whose `appendFile` write is in
> flight when the prune renames the temp file over the target will, on POSIX,
> complete against the now-unlinked old inode — the appended row is silently
> lost from the cache. On Windows the rename may contend (handled by retry) or
> the appender may write into the replacement file. This data-loss window is
> accepted because (a) evidence refs are content-addressed
> (`evd_<sha256[:16]>`), so a lost row's ref re-materializes on the next capture
> of the same content, and (b) the prune runs only via explicit `/swarm archive`
> / `/swarm finalize`, not on every write. Locking the write path would tax
> every `web_search` call and is deliberately avoided.

**Example** — cap the cache at 5 MiB and 5000 records:

```json
{
  "evidence": {
    "cache_max_bytes": 5242880,
    "cache_max_records": 5000
  }
}
```

---

## Telemetry

### Location

```
.swarm/telemetry.jsonl
```

Line-delimited JSON. Auto-rotated at 10 MB (`src/telemetry.ts:161`).

### Event Schema

Every line is a JSON object with a timestamp, event name, and event-specific payload:

```json
{
  "timestamp": "2026-04-23T10:42:11.234Z",
  "event": "gate_failed",
  "sessionId": "...",
  "agentName": "reviewer",
  "taskId": "2.1",
  "gate": "sast_scan",
  "reason": "critical finding in src/auth.ts:42"
}
```

### Event Types

Forty events across six categories (`src/telemetry.ts:10-40`):

**Core:** `session_started`, `session_ended`, `agent_activated`, `delegation_begin`, `delegation_end`, `task_state_changed`

**Gates:** `gate_passed`, `gate_failed`

**Execution:** `phase_changed`, `budget_updated`, `model_fallback`, `hard_limit_hit`, `revision_limit_hit`

**Anomalies:** `loop_detected`, `scope_violation`, `qa_skip_violation`, `turbo_mode_changed`

**Parallel foundation:** `evidence_lock_acquired`, `evidence_lock_contended`, `plan_ledger_cas_retry`

**PRM:** `prm_pattern_detected`, `prm_course_correction_injected`, `prm_escalation_triggered`, `prm_hard_stop`

**Environment:** `environment_detected`, `auto_oversight_escalation`, `heartbeat`

### Delegation Cost Fields

Every `delegation_end` event includes token and cost fields:

| Field | Description |
|---|---|
| `tokens_input` | Input tokens attributed to the delegation, or `0` when unavailable |
| `tokens_output` | Output tokens attributed to the delegation, or `0` when unavailable |
| `tokens_reasoning` | Reasoning tokens attributed to the delegation, or `0` when unavailable |
| `tokens_cache` | Cache-read/input tokens attributed to the delegation, or `0` when unavailable |
| `cost_usd` | Reported or estimated USD cost, or `null` when unavailable |
| `cost_source` | `reported`, `estimated`, or `unavailable` |
| `model` | Model id used for attribution when known |
| `gate` | Delegation gate/reason when known |
| `retry_index` | Transient retry count for the invocation window when known |

Provider-reported cost wins. If only usage is available, configure `pricing.models` to enable estimates. Older telemetry lines without these fields are still readable and aggregate as unavailable.

### Fire-and-Forget

Telemetry never blocks the caller. Emit errors are silently swallowed — a failed append won't break a phase. This is deliberate: a broken telemetry write must not fail a phase.

For in-process hooks, register a listener with `addTelemetryListener()` (`src/telemetry.ts:151`).

---

## Curator Summary

Written to `.swarm/curator-summary.json` after the curator runs each phase (`src/hooks/curator-types.ts:8`):

```json
{
  "schema_version": 1,
  "session_id": "...",
  "last_updated": "2026-04-23T10:42:11Z",
  "last_phase_covered": 3,
  "digest": "...",
  "phase_digests": [ /* per-phase rollup */ ],
  "compliance_observations": [
    { "type": "missing_reviewer", "task": "2.1" },
    { "type": "skipped_test", "task": "2.3" }
  ],
  "knowledge_recommendations": [
    { "action": "promote", "id": "lesson-abc123" },
    { "action": "archive", "id": "lesson-xyz999" }
  ]
}
```

`knowledge_recommendations` is a bounded persistence surface: semantic
duplicates collapse to their newest occurrence and at most 200 unique entries
are retained. Hive promotion observations are recorded only when promotion state
actually changes. On the first read of an older bloated summary, the curator
deduplicates and caps the array in place so affected projects recover without a
manual cleanup step.

Evidence bundles under `.swarm/evidence/` may contain multiple retrospective
entries. The knowledge curator ingests every eligible entry independently,
preserving its phase metadata and avoiding replay of unchanged earlier entries
when a later entry is appended. Idempotency claims are project-scoped, so
identical relative evidence paths in separate workspaces cannot suppress one
another. Physical project-root aliases, physical evidence-file aliases, and
filesystem-equivalent relative paths share the same claim, preventing unchanged
evidence from replaying through path spelling differences. Aliases that resolve
outside the project's physical `.swarm/evidence/` tree are rejected.

---

## Curator Findings

Written to `.swarm/evidence/{phase}/curator-findings.json` when the curator LLM emits structured `knowledge_application_findings` blocks (`src/hooks/curator.ts`):

```json
{
  "findings": [
    {
      "knowledge_id": "abc-123",
      "expected_behavior": "save_plan requires knowledge directive ack",
      "observed_behavior": "save_plan called without ack",
      "verdict": "violated",
      "evidence_refs": ["task:1.1", "event:save_plan"]
    }
  ]
}
```

Written atomically (tmp+rename) only when findings are present. Verdict values: `applied`, `ignored`, `violated`, `not_applicable`.

---

## Drift Reports

Per-phase plan-vs-reality reports at `.swarm/drift-report-phase-<N>.json` (`src/hooks/curator-types.ts:57`):

```json
{
  "schema_version": 1,
  "phase": 3,
  "timestamp": "2026-04-23T10:42:11Z",
  "alignment": "MINOR_DRIFT",
  "drift_score": 0.28,
  "first_deviation": {
    "phase": 3,
    "task": "3.2",
    "description": "Added retry logic not in original spec"
  },
  "compounding_effects": [ /* cascading deviations */ ],
  "corrections": [ /* suggested reconciliations */ ],
  "requirements_checked": 12,
  "requirements_satisfied": 10,
  "scope_additions": [ /* scope creep entries */ ],
  "injection_summary": "/* truncated, max 500 chars, injected to architect */"
}
```

Alignment values: `ALIGNED`, `MINOR_DRIFT`, `MAJOR_DRIFT`, `OFF_SPEC`.

**Drift scoring logic** (`src/hooks/curator-drift.ts`):

1. Extracts FR-### requirement IDs from `spec.md`, `plan.md`, and the curator digest
2. Computes spec coverage ratio: how many spec requirements appear in the plan and digest
3. Alignment determination:
   - `<50%` spec coverage in plan → `MAJOR_DRIFT`
   - `3+` serious compliance warnings → `MAJOR_DRIFT` (takes priority)
   - `1+` warning or `3+` compliance issues → `MINOR_DRIFT`
   - Plan covers requirements but digest doesn't reference them → `MINOR_DRIFT`
   - No spec present → falls back to compliance-count scoring

When spec requirements are present, `injection_summary` includes a coverage note like `[3/12 FRs covered]`.

---

## Querying

### Built-in Commands

```bash
/swarm evidence                    # list all tasks with evidence
/swarm evidence 2.1                # full evidence for task 2.1
/swarm evidence summary            # phase completion ratios and blockers
/swarm archive --dry-run           # preview archival
/swarm benchmark                   # in-memory perf metrics
/swarm benchmark --cumulative      # scan all evidence, compute pass rates
/swarm benchmark --ci-gate         # non-zero exit if thresholds exceeded
/swarm benchmark --ci-gate --max-cost-usd 1.50
/swarm gate-audit --gates sast,mutation --max-time-ms 120000
/swarm gate-stats --min-samples 6
/swarm benchmark --ci-gate --gate-audit-run audit-abc123
/swarm costs                       # per-agent/task/gate/retry token/cost totals
/swarm costs --json                # machine-readable cost summary
```

`benchmark --cumulative` reads every bundle and computes:

- `review_pass_rate`
- `test_pass_rate`
- Quality metrics: complexity delta, public API delta, duplication ratio, test-to-code ratio

Gate-audit artifacts are immutable, versioned evaluation evidence under
`.swarm/evidence/gate-audit/`. `/swarm archive` applies the configured age and
count retention policy to these nested bundles. Reviewer gate decisions emit a
typed `reviewer_gate_decision` telemetry event so `/swarm gate-stats` can
separate genuine review evidence from fallback, data-quality, and blocked paths.

### Direct Inspection

No DSL. Use standard tools:

```bash
# Count gate failures in the last session
grep '"event":"gate_failed"' .swarm/telemetry.jsonl | wc -l

# Find all tasks with a reviewer rejection
jq 'select(.entries[] | select(.type == "review" and .verdict == "reject")) | .task_id' \
  .swarm/evidence/*/evidence.json

# Pull the PRM pattern timeline
jq -c 'select(.event | startswith("prm_"))' .swarm/telemetry.jsonl

# Drift score per phase
jq -r '[.phase, .alignment, .drift_score] | @tsv' .swarm/drift-report-phase-*.json
```

---

## Evidence Summary Schema

`/swarm evidence summary` writes a machine-readable artifact (`schema_version: 1.0.0`) with per-phase rollups:

```json
{
  "phaseSummaries": [
    {
      "phase": 2,
      "completionRatio": 0.8,
      "tasksWithEvidence": 4,
      "missingEvidenceByType": {
        "review": 1,
        "test": 0
      }
    }
  ],
  "overallCompletionRatio": 0.75,
  "overallBlockers": [
    { "task": "2.5", "reason": "missing reviewer approval" }
  ]
}
```

Per-task: `hasReview`, `hasTest`, `hasApproval`, `missingEvidence[]`, `isComplete`, `blockers`.

---

## Related

- [Commands Reference](commands.md) — `/swarm evidence`, `/swarm archive`, `/swarm benchmark`
- [Architecture Deep Dive](architecture.md) — how evidence flows through the pipeline
- [Configuration](configuration.md) — `evidence.*` keys
