# COVERAGE GATE principle for review skills

## What changed
- Injected a **COVERAGE GATE** principle into 4 review/audit skills: `swarm-pr-review`, `deep-dive`, `swarm-pr-feedback`, and `codebase-review-swarm`.
- The principle establishes zero tolerance for unclosed coverage gaps: every planned coverage dimension (explorer lanes, micro-lanes, deterministic signals, CI, tests) must produce validated output before synthesis.
- Removed permissive language that directed the architect to "state that limitation and continue," "simulate isolated passes," "record unavailable dispatch in the validation gate," or "mark candidates UNVERIFIED and proceed."
- Added PR title/body compliance check to `swarm-pr-review` Phase 0A, including `Closes #N` claim integrity verification.
- Documented the `dispatch_lanes_async` 8-lane cap and Mode B failure mode (lanes report "completed" but produce only intermediate reasoning with zero candidates).
- Added **verdict row contract** to Phase 8: critic responses must end with a parseable `[CRITIC]` row. Missing rows trigger re-dispatch under the COVERAGE GATE (retry max 2 → equivalent → INCOMPLETE).
- Added **skill mirror contract** documentation to `engineering-conventions`: documents the 4 mirror types (identical, divergent, opencode-only, adapter shim) and references `src/config/skill-mirrors.ts` + `drift:check`.

## Why
During a multi-PR review session, `dispatch_lanes_async` consistently failed across two separate PR reviews. The architect fell back to Task-tool dispatch, got results, and issued APPROVE_WITH_NOTES verdicts without ever proving the Task-based coverage was equivalent to what dispatch_lanes would have provided. The existing skills normalized this by directing the architect to "record that limitation and continue." This principle change ensures coverage gaps are always closed (retry → verified equivalent → INCOMPLETE) and never silently accepted.

## Migration
No migration required — skill documentation only. No code, config, or runtime behavior changes.

## Caveats
- The equivalence criteria for alternative dispatch mechanisms are: same agent type, same prompt, same scope, same isolation. Different dispatch mechanism (e.g., Task tool instead of `dispatch_lanes_async`) IS acceptable when these criteria are met and verified.
- 2 pre-existing skill test failures (`swarm-pr-review-dispatch-guidance.test.ts` adapter tests for `retrieve_lane_output`) remain unchanged — they predate this PR on main.
