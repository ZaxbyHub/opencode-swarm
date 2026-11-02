fix(delegation-gate): the completion gate no longer wedges OpenCode v2 Code Mode sessions

- On an OpenCode v2 host every plugin tool is reached through the host-owned
  Code Mode `execute` wrapper (`{ code }`), and each nested `tools.<name>()`
  call re-enters `tool.execute.before` under its own name. The completion gate
  judged the wrapper itself as an opaque, non-read-only tool, so once a task
  reached `tests_run` it denied every plugin call — including the
  `update_task_status` remedy its own message prescribes and the exempt
  `check_gate_status` — and the task could never leave the gate. Observed on a
  live session: 11 consecutive `TASK_COMPLETION_GATE_VIOLATION` denials for one
  task over 11 hours.
- The wrapper call that the v2 adapter marked (`execute` with a string `code`
  program) now passes the completion gate; each nested call is still gated
  under its own name, so mutating tools remain blocked while a task awaits
  completion. An unmarked `execute` call stays gated.
- The violation message now also names the audited escape for a task that
  cannot complete: `update_task_status` with `status="blocked"` (a terminal
  transition recorded in the plan ledger and task evidence) releases the gate.
  `/swarm recover` and `/swarm reset-session` do not release it: the awaiting
  state lives in task evidence and `plan.json`, not in session state.
