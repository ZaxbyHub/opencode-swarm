# Gate-Aware Injection Policy for Session-State Directive Channels

## What changed

Resolves #3100 ([Workstream G] PR 2 of 2; #3093 shipped first and is absorbed unchanged):

- New pure module `src/hooks/injection-policy.ts` — a channel registry (5 channels) plus a
  gate-mode × content-class suppression matrix and a single decision function,
  `shouldInjectChannel(channel, gateState)`. Decisions are deterministic (gate mode + content
  class, never content heuristics) and fail toward emission.
- #3093's plan-cursor and parallel pre-check suppression migrated into the policy as its first
  registered consumer with **zero behavior change** — the unmodified #3093 behavioral and ratchet
  suites stay green.
- The agent-activity table (`[SWARM AGENT CONTEXT]`) is now suppressed on both context paths while
  a `PR_REVIEW` gate is active for the composing session. It is still emitted under `PR_FEEDBACK`,
  with no gate, and when the gate belongs to a different session.
- The swarm-command banner and the delegation `[NEXT]` steering are registered as structurally
  **never-suppress** channels (empty suppression lists pinned by a ratchet test). Their composers
  are unchanged and do not consult the policy at runtime — see Known caveats.
- The context-budget report no longer counts a policy-suppressed plan cursor (#3161 item 1), so
  `budgetPct` reflects the prompt during gate windows instead of inflating toward a spurious
  over-budget advisory.

## Why

Session-state directive injection was composed by scattered producers with no shared gate
awareness: only #3093's two channels consulted PR-workflow gate state, so agent-activity tables
and other session-state content still reached the model during read-only `PR_REVIEW` gate
windows. One deterministic policy makes the decision auditable in a single place and lets new
channels register as consumers instead of re-implementing gate checks.

## Proposed suppression matrix (maintainer gate — not yet confirmed)

| content class | channels | PR_REVIEW | PR_FEEDBACK | no gate |
|---|---|---|---|---|
| plan-execution | plan-cursor, parallel-precheck | suppress | inject | inject |
| agent-activity | agent-activity tables | suppress | inject | inject |
| command-contract | command-banner | inject | inject | inject |
| delegation-steering | delegation steering | inject | inject | inject |

The full matrix is proposed on issue #3100 for maintainer confirmation before merge (issue AC5).
If the maintainer amends it, this fragment must be re-issued — it is the only narrative users see.

## Migration steps

None. No config key, schema, or default changed. The only new public surface is an optional
5th parameter on an internal service function (`getContextBudgetReport(..., planCursorSuppressed
= false)`), which defaults to the previous behavior for every existing caller.

## Breaking changes

None.

## Known caveats

- **Scope of the "batch/advisory" leg.** Issue #3100 AC3 asks for agent-activity tables *and*
  batch/advisory content classes to be suppressed under `PR_REVIEW`. This change suppresses the
  agent-activity tables. The batch/advisory leg is satisfied only by the parallel pre-check hint,
  which #3093 already suppressed — **no new batch/advisory suppression ships here**. The
  remaining advisory producers are still ungated under `PR_REVIEW`: the delegation "BATCH DETECTED"
  warning, the linked-cohort advisory, the spec-drift advisory, the soft-compaction advisory, and
  the pre-flight binary-readiness advisory. Whether any of these belong in AC3's suppression set is
  a maintainer question put to the AC5 gate.
- **`command-banner` and `delegation-steering` are registered but not runtime-wired.** Their
  never-suppress guarantee is structural (empty suppression lists + a ratchet test), not an
  emission-site check. The zero-I/O fallback (wiring each composer through `shouldInjectChannel`)
  is documented in the policy module if emission-path governance is ever wanted.
- **Session-identity asymmetry.** Composition keys the gate read on the raw composing session ID,
  while PR-workflow enforcement resolves the gate-owning ancestor. A pre-gate child session that
  outlives gate activation still receives these directives (#3161 PRR-010) — deliberate, to keep
  #3093's session-scoping pin intact.
- **`hooks.agent_activity` has no escape hatch.** It is still reported as an enabled capability at
  init, but during an active `PR_REVIEW` gate the table is not injected regardless of the setting.
- **Untracked budget-report residuals.** Two budget-report divergences are NOT tracked by #3161:
  mode-blind DISCOVER-mode counting, and Path B ranked-drop counting.