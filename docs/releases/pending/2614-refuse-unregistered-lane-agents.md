# Refuse unregistered lane agents at dispatch time (issue #2614)

## What

- `dispatch_lanes_async` / `dispatch_lanes` now refuse a lane whose `agent` is not a registered generated agent name when the host's generated-name registry is non-empty (multi-swarm hosts that register only prefixed agents). The rejection is a typed `rejected` lane row whose error names the requested agent and lists the registered names, bounded to the first 8 plus ", and N more".
- Bare canonical roles (e.g. `explorer`) remain valid on legacy/default configurations whose registry registers them, and on hosts with an empty registry (the documented legacy launch shape).
- `startAsyncLanePrompt` carries the same registry-aware refusal as defense-in-depth for direct callers: when the registry proves the agent unregistered and no swarm agent entry or model resolves, the lane settles a typed launch error through the exactly-once terminal path instead of launching a `promptAsync` the host cannot run.
- The `dispatch_lanes_async` tool description now states the `agent` contract: each lane agent must be a registered generated agent name; bare canonical roles are refused on multi-swarm hosts that do not register them.

## Why

On the PR #2609 review run (2026-09-06), the built-in `build` agent dispatched 12 `swarm-pr-review:base` lanes with the bare name `explorer` on a multi-swarm host that registers only prefixed agents. `validateLaneAgent` accepted the name (`getCanonicalAgentRole` resolves bare canonical roles before consulting the generated-name registry), the lane launched `promptAsync` with no model, the host accepted and then died in its background fiber (`Die(UnknownError)`), and all 12 lanes stayed `pending` for 41–52 minutes with zero output until the operator cancelled — `complete_pr_workflow(INCOMPLETE)` was refused for lacking a typed terminal failure. The dispatch-time refusal makes this entire failure class unreachable: the caller now receives an immediate, actionable rejection instead of a silent hang.

## Notes

- The existing caller-prefix guard (`does not match caller swarm prefix`) is unchanged and now has direct test coverage.
- New regression suite: `tests/unit/tools/dispatch-lanes-unregistered-agent-refusal.test.ts` (7 tests: refusal + bounded name list, legacy acceptance, mixed-registry acceptance, caller-prefix guard, async row refusal, deep-gate direct refusal).
- Sibling sites that resolve agent names without registry membership (council identity, curator matching, full-auto policy, execution-stall classification) were enumerated in the issue trace; they are out of this change's dispatch path and remain tracked for a follow-up sweep.
