### Fixed

- `delegation_begin` telemetry is now actually emitted in production. Previously
  its only producer lived inside guardrails invocation-window bookkeeping
  (`beginInvocation`), whose every call site is gated on guardrails being
  enabled — so with `guardrails.enabled: false` a session emitted
  `delegation_end` events with no `delegation_begin` ever (measured: 12 end /
  0 begin over 33 days of multi-agent use). The event is now emitted at the
  Task-delegation boundary in `tool.execute.before`, after every fail-closed
  gate has admitted the call, independent of guardrails configuration.
- `delegation_begin` / `delegation_end` pairs are now symmetric: both events
  carry the identical `sessionId` and `agentName` (the dispatched
  `subagent_type`), correlated per Task call, and the same `taskId` whenever a
  task was current at dispatch (a begin with no current task carries an empty
  `taskId`, and its end reports the task id populated during that completion,
  when one exists). Previously
  `delegation_end` labeled every delegation with the parent session's active
  agent — always the architect, since subagents run in child sessions — so
  the delegated agent name in `delegation_end` was wrong in production.
- Because the Task handoff now knows the real delegated agent, per-delegation
  cost fields resolve the delegated agent's configured model (previously the
  architect's), and `delegation_end` cost buckets attribute to the actual
  subagent. The reviewer / test_engineer / critic pipeline-continuation
  advisories and the critic-sounding-board verdict parsing (which keyed on
  that agent name and therefore never triggered) are queued correctly again —
  note their delivery surface is the guardrails messages-transform, so with
  `guardrails.enabled: false` they are queued but not rendered (pre-existing
  behavior of that renderer). Sounding-board completions also set the
  `critic_consultation` delegation reason again, which flows into
  `delegation_end` cost-gate attribution.
- A background Task's "running" placeholder now emits `delegation_begin` when
  the delegation is dispatched. Its `delegation_end` remains deferred to the
  trusted terminal completion, which is correlated through the durable
  pending-delegation path and does not currently emit a `delegation_end`
  telemetry event — a pre-existing gap that is unchanged by this fix.
