## Fixed

- `/swarm close` now reports tasks it completed without QA evidence. When close
  reconciles a task that the plan already marked completed but that has no
  authoritative workflow evidence, the completion is recorded as
  `forcedCompletion` in that task's durable evidence and listed in a close
  warning. Previously such a task was byte-identical in `.swarm/evidence/` to
  one that had genuinely passed the reviewer and test gates, so nothing
  downstream could tell the two apart.
- Plan-epoch resolution now fails closed on a corrupted plan ledger.
  `readPlanEpochIdentity` and `getOrAdoptPlanEpochUnderLock` previously skipped a
  malformed line in `.swarm/plan-ledger.jsonl`, which could hide an existing epoch
  record and mint a duplicate; they now raise `PLAN_LEDGER_TRUNCATED` naming the
  ledger path. Every in-tree caller already fails closed on a truncated ledger
  before reaching them, so this hardens the exported surface rather than changing
  behavior on an existing path.
- Seven workflow WAL state-conflict errors now name the exact task, transition,
  WAL path, and concrete recovery action, matching the WAL corruption errors:
  `CODER_DISPATCH_IN_PROGRESS`, `CODER_SETTLEMENT_IN_PROGRESS`,
  `CODER_SETTLEMENT_RECOVERY_REQUIRED`, `TASK_REPAIR_IN_PROGRESS`,
  `TASK_TERMINAL_RECOVERY_REQUIRED`,
  `TASK_TERMINAL_AUTHORITATIVE_EVIDENCE_REQUIRED`, and
  `TASK_TERMINAL_PLAN_IDENTITY_REQUIRED`. The WAL/task-mismatch errors raised
  while parsing a coder-settlement, task-repair, or task-terminal WAL now name the
  file and a remediation too. Diagnosing a stuck multi-task close no longer
  requires reverse-engineering which task failed. Other pre-existing
  state-conflict codes in those files were left as they were, and several are
  still missing the WAL path and a remediation.
- Exhausting plan-epoch stale-writer retries now reports that explicitly instead
  of surfacing the raw stale-writer error, preserving the original as `cause`.
- Merge provenance recorded in coder-settlement WAL records is now validated as a
  full git object id, and the settlement `git log` lookup passes an explicit
  `--` separator between the revision range and pathspecs.

## Migration

- No configuration change is required. `forcedCompletion` is an optional field:
  evidence written before this release reads as not-forced, and older readers
  ignore it.
- Downgrading is not symmetric. Task evidence written after this change may carry
  `workflow.state: "closed"`, a new value in the workflow-state enum. A build
  older than this release rejects such an evidence file outright rather than
  ignoring the unknown value, so downgrading after a close degrades the
  delegation-gate evidence checks for those tasks until the evidence is
  regenerated (see #2199). Mixed-version reads are most likely from a stale
  plugin cache.
