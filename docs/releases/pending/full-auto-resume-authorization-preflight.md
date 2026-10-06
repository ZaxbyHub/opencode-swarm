---
issue: 2948
---

# /swarm full-auto resume now runs the same authorization preflight as on

## Summary

- `/swarm full-auto resume` re-armed a paused Full-Auto run without consulting
  the authorization checks that `/swarm full-auto on` runs: the
  `configHadErrors` fail-closed guard and the `full_auto.locked`
  administrative hard-off. On a project whose config was locked or unreadable,
  `on` was correctly refused while `resume` still re-armed the run — defeating
  the lock exactly where it was supposed to refuse activation.
- The enable path's preflight is now a single shared predicate in
  `src/commands/full-auto.ts` that both activation paths consult: `resume` is
  activation for lock purposes and is refused identically to `on` when the
  config is locked or cannot be parsed. A refused resume leaves the durable
  run paused and the session flag untouched.
- Refusal precedence and ordering are pinned by tests: an unreadable config
  wins over a user-level lock (the lock cannot be verified in an unreadable
  config), and the authorization preflight runs before any resume-eligibility
  check, so the fail-closed message cannot be masked by a stale or invalid
  recovery probe.
- `retry-oversight` (a transport-only health probe that never activates), the
  full-auto escalation paths, and `off`/`status`/`abort` behavior are
  unchanged: a locked project keeps its documented recovery controls.
