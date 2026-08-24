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
- Workflow WAL records are now shape-validated whenever they are parsed. A branch
  name must match a bounded allowlist and a worktree path must be non-empty,
  bounded, free of control characters, and must not begin with `-`. A tampered
  WAL can therefore no longer smuggle a leading `-` into `git merge`/`git
  rebase`/`git branch -D` or `git worktree remove`, none of which pass a `--`
  separator before the operand today. Two deliberate scope limits: the branch
  allowlist is not expressed in terms of `git check-ref-format --branch` and is
  neither a subset nor a superset of it (it rejects `release+1`, which git
  accepts, and accepts `HEAD`, which git rejects) — it is an argv-safety
  allowlist sized for the names `buildSwarmBranchName` actually produces. And
  this is argv shape safety, not path containment: the worktree path may still
  point outside the project, because the Windows path-budget fallback
  legitimately relocates lanes under the system temp directory. Containment
  continues to be enforced where it matters, at the `git worktree remove
  --force` sink.
  Known gap, not closed here, and wider than the WAL path this bullet fixes.
  The invariant that does NOT hold today: a branch name read back from the
  pending-delegations ledger is bounded only by length
  (`z.string().min(1).max(1_024)`, so a leading `-` passes) and is not shape-
  validated anywhere between that read and git argv.
  `src/background/completion-observer.ts` lifts `descriptor.branchName` out of
  the ledger at more than one site — the two in the coder-settlement path and at
  least one more in the failed/cancelled terminal handler — and those sites fan
  out through `mergeLaneBranch` and `postMergeCleanup` in
  `src/worktree/merge.ts` to `git merge`, `git rebase`, `git cherry-pick`,
  `git merge-base` and `git branch -D`, each taking the name as a bare operand
  with no `--` separator present today. Successive reviews of this note each found
  another lift site or sink, so treat any enumeration here as a starting point
  and re-derive the full set before relying on it. `git rebase` is the sharp
  edge: a leading-`-` name there reaches `--exec`, which runs a command per
  replayed commit. The precondition is the same as for the WAL path — something
  must already be able to write arbitrary content into on-disk `.swarm` state —
  and no in-process path mints such a name today, since `buildSwarmBranchName`
  is the only producer of new lane branch names (names recovered from an
  existing git worktree listing already exist as refs). Three ways to close it,
  none free. (a) Sink-side argv hardening: `git merge`, `git rebase`,
  `git merge-base` and `git branch -D` all accept `--` (or
  `--end-of-options`) before the operand, which the repo already relies on
  elsewhere, so adding it at those call sites covers every route to them no
  matter how many lift sites exist — the one option immune to the enumeration
  problem above. `git cherry-pick` does NOT accept that position, so it still
  needs a shape check. (b) A single check on `WorktreeDescriptorSchema.branchName`
  dominates every ledger-read route, but inherits the objection that kept the
  merge-provenance head fields loose in the ledger record schema — a zod failure
  there drops the whole delegation record, turning "decline to resume" into
  "ledger entry unreadable" (a regression this codebase has shipped once
  already). (c) Validating at each lift avoids that but only works if every lift
  site is covered, which is precisely what this note kept getting wrong.
  Validating inside `settlementResume` alone is insufficient under any of them:
  it returns early unless the settlement is in the `settling` state, while the
  merge and cleanup paths run regardless.
- An unreadable plan ledger is now reported as unreadable. Previously any read
  failure on a ledger that exists (EACCES, EIO) was indistinguishable from an
  absent one, so `readPlanEpochIdentity` reported `Plan ledger is empty; missing
  plan_created root` — it did already fail closed, but with a misleading cause.
  It now raises `PLAN_LEDGER_UNREADABLE`, naming the path and telling the
  operator to preserve the file and check permissions. This is a diagnostic
  change at that reader, not a new fail-closed guarantee. The wider
  `replayFromLedger` callers intentionally keep their tolerant plan.json
  fallback; see the note on `readLedgerEventsForEpoch` for why.

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
