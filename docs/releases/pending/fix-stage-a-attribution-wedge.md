# Release Note Fragment — Stage A attribution wedge fix

## Fix: tasks no longer wedge at `coder_delegated` after `/swarm reset-session` (TASK_WORKFLOW_STAGE_A_REQUIRED)

After a mid-plan `/swarm reset-session`, the in-memory chain that attributed
`pre_check_batch` results to a task was destroyed, so no `stage_a_passed`
transition could ever be written: every later reviewer/test_engineer dispatch
was permanently denied with `TASK_WORKFLOW_STAGE_A_REQUIRED ... from
coder_delegated`, while `pre_check_batch` still reported `gates_passed: true`
and its evidence landed as orphaned bundles. The failure was fully silent.

Changes:

- **Durable attribution fallback.** When the in-memory correlation is gone,
  gate calls resolve their task from committed coder-settlement WALs
  (`.swarm/coder-settlements/`, which survive resets), strictly requiring
  exactly one eligible candidate — a task settled with an accepted mutation
  whose store still sits at `coder_delegated`. Multiple eligible candidates
  produce an explicit ambiguity advisory instead of a guess.
- **Stage A write failures are visible.** Attribution/generation misses now
  escalate to a critical warning plus an in-chat advisory naming
  `/swarm recover <task>` instead of an invisible log line.
  `check_gate_status` gains `workflow` state and a
  `workflow_attribution_hint` field so the wedge is readable from the
  read-only tool.
- **Structured dispatch attribution.** The coder task id recorded at
  delegation time now comes from the plan-validated scope binding
  (`args.task_id` / structured resolution) instead of regex-matching prompt
  text, so attribution works regardless of prompt formatting
  (`my_coder` prefixes, odd whitespace, missing `TASK:` lines).
- **Repair path for already-wedged tasks.** `/swarm recover` now also scans
  for tasks wedged at `coder_delegated` with green post-settlement pre-check
  evidence and writes the missing `stage_a_passed` transition directly
  (audit events in `.swarm/events.jsonl`). No re-run of the coder needed.
- **Actionable denial message.** `TASK_WORKFLOW_STAGE_A_REQUIRED` denials now
  name the expected channel (`stage_a_passed` via `pre_check_batch`), the
  current state, and the remediation including `/swarm recover <task>`.

Normal flows without a reset are byte-identical; the fallback only engages
when session correlation is already missing.
