# Phase 2 finalize changes

## What changed

### Hive promotion eligibility gate in `/swarm finalize`

Hive promotion during finalize now uses a three-route eligibility gate instead of
indiscriminate promotion. Each lesson in `knowledge.jsonl` is evaluated against:

| Route | Trigger |
|-------|---------|
| Explicit | `hive_eligible=true` AND ≥3 distinct phases confirmed |
| Fast-track | Entry tagged `hive-fast-track` (bypasses phase count) |
| Age-based | Entry age ≥ `auto_promote_days` (default 90) |

Entries that fail all three routes are skipped with a warning. This prevents
low-confidence or untested lessons from flooding the hive tier.

### `knowledge.jsonl` is now preserved across finalize cycles

During `/swarm finalize`, `knowledge.jsonl` is no longer deleted from the
active state. It is:

- **Archived** into the timestamped bundle (as part of `ARCHIVE_ARTIFACTS`)
- **Preserved** in `.swarm/knowledge.jsonl` after cleanup

This means cumulative project knowledge (lessons learned) survives across
`/swarm finalize` and `/swarm plan` cycles. Previously, finalize would delete
`knowledge.jsonl` as active-state cleanup, causing knowledge loss between sessions.

### Config loading uses project-level `auto_promote_days`

The age-based promotion threshold now reads from the project's `knowledge.auto_promote_days`
config (default 90 days) instead of a hardcoded fallback. This allows per-project
tuning of how long lessons must age before automatic hive promotion.

## Why

The indiscriminate promotion model promoted every lesson with no quality gate,
diluting hive quality. The three-route model requires either explicit confirmation
(`hive_eligible` + phase diversity), fast-track intent (`hive-fast-track` tag),
or demonstrated staying power (age threshold).

The `knowledge.jsonl` preservation change fixes a data loss bug: finalize would
delete the cumulative knowledge store, so subsequent sessions started with an
empty knowledge base even when the same project had accumulated valuable lessons.

## Migration steps

None. Existing knowledge entries continue to work. Entries promoted before this
change are unaffected. The `auto_promote_days` config key already exists in the
schema — this change only routes the finalize promotion through it.

## Known caveats

- Entries promoted via the age-based route after this change will use the
  project-configured threshold. Projects using the default (90 days) see no
  behavioral change.
- The three-route gate only applies to **automatic** promotion during finalize.
  Manual `/swarm promote` and `/swarm curate` commands bypass this gate.
