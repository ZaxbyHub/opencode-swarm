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

Config keys (`src/config/schema.ts:179`):

| Key | Default | Range | Purpose |
|-----|:---:|:---:|---------|
| `enabled` | `true` | — | Master switch |
| `max_age_days` | `90` | 1–365 | Age threshold for archiving |
| `max_bundles` | `1000` | 10–10000 | Count cap |
| `auto_archive` | `false` | — | Future gate (config-only) |

`/swarm archive` applies two-tier retention: age first, then count. Oldest bundles go first when the count cap is hit. Use `--dry-run` to preview.

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
```

`benchmark --cumulative` reads every bundle and computes:

- `review_pass_rate`
- `test_pass_rate`
- Quality metrics: complexity delta, public API delta, duplication ratio, test-to-code ratio

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
