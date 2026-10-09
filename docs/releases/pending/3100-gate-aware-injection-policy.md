# Gate-Aware Injection Policy for Session-State Directive Channels

## What

Resolves #3100 ([Workstream G] PR 2 of 2): one shared, deterministic
injection policy now governs the session-state directive channels that
previously each decided injection independently, with only the #3093
channels aware of PR-workflow gates.

- New pure policy module `src/hooks/injection-policy.ts`: a channel
  registry plus a gate-mode × content-class suppression matrix and a
  single decision function, `shouldInjectChannel(channel, gateState)`.
  Decisions are deterministic (gate mode + content class, never content
  heuristics) and fail toward emission (no gate, read failure, or a
  foreign session's gate never hides directives).
- #3093's plan-cursor and parallel pre-check suppression migrated into
  the policy as its first registered consumer, with zero behavior change
  (the unmodified #3093 suppression and ratchet suites stay green).
- The agent-activity table (`[SWARM AGENT CONTEXT]`) is now suppressed on
  both context paths while a PR_REVIEW gate is active for the composing
  session — stale activity tables were non-operative noise in the
  read-only gate window. Still emitted under PR_FEEDBACK, with no gate,
  and for a foreign session's gate.
- The swarm-command banner and delegation `[NEXT]` steering are
  registered as structurally never-suppressed channels (empty suppression
  lists pinned by a ratchet test); their composers are unchanged.
- The context-budget report no longer counts a policy-suppressed plan
  cursor (#3161 item 1): both report call sites pass the emission
  decision, so `planCursorTokens` reflects the prompt during gate
  windows instead of inflating `budgetPct` toward a spurious over-budget
  advisory.

## Proposed suppression matrix (maintainer gate)

| content class | channels | PR_REVIEW | PR_FEEDBACK | no gate |
| --- | --- | --- | --- | --- |
| plan-execution | plan-cursor, parallel-precheck | suppress | inject | inject |
| agent-activity | agent-activity tables | suppress | inject | inject |
| command-contract | command-banner | inject | inject | inject |
| delegation-steering | delegation steering | inject | inject | inject |

The full matrix is recorded on issue #3100 for maintainer confirmation
before merge (AC5); the module ships the proposed shape and tests pin it.

## Testing

New `tests/unit/hooks/injection-policy.test.ts`: literal per-channel ×
per-mode policy matrix (including named never-suppress cases for the
command banner and delegation steering), structural registry/matrix
ratchets, real-SQLite consumer integration for the agent-activity
channel on both composition paths (suppression, mode scoping, session
scoping, and a kind-collision control proving the same-model adversarial
advisory stays emitted while the table suppresses), the budget-report
consumer, and the call-site wiring ratchet.
