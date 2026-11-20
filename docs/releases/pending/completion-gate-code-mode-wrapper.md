fix(delegation-gate): the completion gate no longer wedges OpenCode v2 Code Mode sessions

- On an OpenCode v2 host every plugin tool is reached through the host-owned
  Code Mode `execute` wrapper (`{ code }`), and each nested `tools.<name>()`
  call re-enters `tool.execute.before` under its own name. The completion gate
  judged the wrapper itself as an opaque, non-read-only tool, so once a task
  reached `tests_run` it denied every plugin call — including the
  `update_task_status` remedy its own message prescribes and the exempt
  `check_gate_status` — and the task could never leave the gate. The PR author
  reported this on a live session (11 consecutive
  `TASK_COMPLETION_GATE_VIOLATION` denials for one task over about 11 hours);
  that observation is not reproducible from the repository.
- The wrapper call that the v2 adapter marked (`execute` with a string `code`
  program) now passes the completion gate. Each nested `tools.<name>()` call is
  still gated under its own name, so hooked mutating tools remain blocked while
  a task awaits completion. An `execute` call the adapter did not mark stays
  gated. Limits: the mark is not proof of provenance (a plugin or MCP tool that
  is also named `execute` and takes a string `code` is marked too), and the gate
  does not inspect the program, so sandbox effects no hook sees (for example
  `fetch`) are not gated by this check. Unlike Full-Auto, this exemption needs
  no `permission_policy.trust_code_mode_wrapper` opt-in; Full-Auto still
  classifies the wrapper separately.
- The violation message now also names the audited escape for a task that
  cannot complete: `update_task_status` with `status="blocked"` (recorded in
  the plan ledger and task evidence) releases the gate. Reopening a blocked
  task takes the audited `blocked` to `in_progress` repair, which requires
  `force: true` with the exact CAS and audit fields (see the recovery runbook).
  `/swarm recover` and `/swarm reset-session` do not release the gate: the
  awaiting state lives in task evidence and `plan.json`, not in session state.
