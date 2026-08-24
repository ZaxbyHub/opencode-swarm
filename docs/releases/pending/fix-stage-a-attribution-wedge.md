# Release Note Fragment — Stage A attribution wedge fix

## Fix: tasks no longer wedge at `coder_delegated` after `/swarm reset-session` (TASK_WORKFLOW_STAGE_A_REQUIRED)

After a mid-plan `/swarm reset-session`, the in-memory chain that attributed
`pre_check_batch` results to a task was destroyed, so no `stage_a_passed`
transition could ever be written: every later reviewer/test_engineer dispatch
was permanently denied with `TASK_WORKFLOW_STAGE_A_REQUIRED ... from
coder_delegated`, while `pre_check_batch` still reported `gates_passed: true`
and its evidence landed as orphaned bundles. The failure was fully silent.

Changes:

- **Durable attribution fallback, safely bound.** When the in-memory
  correlation is gone, gate calls resolve their task from committed
  coder-settlement WALs (`.swarm/coder-settlements/`, which survive resets).
  A candidate is eligible only if it settled with an accepted mutation and
  its store still sits at `coder_delegated`. The resolved task is attributed
  only when the gate call's own scanned files intersect that task's
  declared/changed files — a task with no overlapping file scope, or a call
  that declares no files at all, is never attributed. Multiple eligible
  candidates, a lane still mid-dispatch (`DISPATCHED`/`PREPARED`) at
  `coder_delegated`, or a settlement-WAL scan large enough to be truncated
  (more than 200 historical settlements) all produce an explicit advisory
  instead of a guess.
- **Stage A write failures are visible.** Attribution misses (the reducer
  codes that indicate the write genuinely couldn't find or bind its task) now
  escalate to a critical warning plus an in-chat advisory naming
  `/swarm recover <task>` instead of an invisible log line. Ordinary
  concurrent-write fencing (a sibling transition legitimately racing the same
  task) stays log-only, since that is expected churn, not a wedge.
  `check_gate_status` gains a `workflow` state snapshot and a
  `workflow_attribution_hint` field so the wedge is readable from the
  read-only tool.
- **Structured dispatch attribution.** The coder task id recorded at
  delegation time now comes from the plan-validated scope binding
  (`args.task_id` / structured resolution) instead of regex-matching prompt
  text, so attribution works regardless of prompt formatting
  (`my_coder` prefixes, odd whitespace, missing `TASK:` lines).
- **Repair path for already-wedged tasks.** `/swarm recover` now always
  attempts to repair tasks wedged at `coder_delegated`, whether or not a
  settlement WAL is listable for them (background-dispatched coder tasks
  never create one). Repair requires BOTH a green secretscan bundle and a
  green SAST bundle newer than the settlement commit (the settlement WAL's
  own recorded time; when no settlement WAL exists — the background-dispatch
  case above — the task's own last-transition timestamp is used instead)
  before writing the missing `stage_a_passed` transition directly (audit
  events in `.swarm/events.jsonl`). No re-run of the coder needed. A project
  running
  with SAST disabled, or whose only SAST run degraded (e.g. a Semgrep process
  crash with zero findings), is not auto-repairable via this path and needs
  manual attention — this is an intentional conservative trade-off, not a
  bug.
- **Actionable denial message.** `TASK_WORKFLOW_STAGE_A_REQUIRED` denials now
  name the expected channel (`stage_a_passed` via `pre_check_batch`), the
  current state, and the remediation including `/swarm recover <task>`.

The fallback only engages when a gate call's session lacks task correlation
(the reset-recovery case, but also any session's first gate call before its
own correlated dispatch) — in every such case, the file-scope binding
requirement above means no attribution occurs unless the call's own scanned
files genuinely match the resolved candidate's declared changes.
