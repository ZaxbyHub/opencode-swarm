# Dispatch protection: spawn circuit breaker + token-bucket rate limiting (issue #2507)

Fixes the dead native-task loop detector (HOOKS-2) and adds default-on dispatch
protection for native `task` delegations.

## What changed

- **Loop detector actually fires on the host's tool spelling.** The OpenCode
  host invokes the task tool as lowercase `task`; the plugin's delegation loop
  detector (3x warning / 5x circuit breaker) compared exclusively against
  capitalised `'Task'`, so ten identical native delegations ran through the
  full composed hook chain with zero brakes while the capitalised spelling
  tripped at the fifth. Both guards (`src/hooks/loop-detector.ts`,
  `src/hooks/guardrails/tool-before.ts` `handleLoopDetection`) now route
  through the shared `normalizeToolNameLowerCase` boundary (the primitive
  issue #2529 designates), which also strips namespace prefixes. The 3x/5x
  ladder, the advisory shape, and all existing capitalised-spelling tests are
  unchanged.
- **Action-local spawn-protection circuit (new, `src/dispatch/spawn-circuit.ts`).**
  Repeated ACTUAL dispatch failures of the same semantic action (keyed by
  session + invocation + `createActionIdentity` digest) open a circuit that
  denies only the matching action; read/diagnose/repair/rescope/abort and
  handoff controls remain reachable, and no global breaker exists. After
  `half_open_after_ms` exactly one recovery probe is admitted (a failed probe
  re-opens with a fresh interval); a corrected success clears only the
  matching action. An OPEN episode always denies at least once before any
  probe, so post-failure bookkeeping latency can never silently skip the
  denial phase. The identity is armed from pre-mutation args at
  `tool.execute.before` step 0 and consumed by the after-hook recorder, so
  prompt mutation between the hooks cannot orphan a circuit. One bounded
  `loop_detected` telemetry event fires on the closed-to-open transition
  (structured `dispatch.spawn:<pattern>` payload, no raw prompt text).
- **Token-bucket dispatch rate limiting (new, `src/dispatch/token-bucket.ts`).**
  Native task dispatches are PACED (awaited, never denied) at a configurable
  rate — default 10 per second with a burst of 10, `0` disables the limiter.
  Per-project bucket state persists into the existing `coordination_state`
  table (namespace `dispatch.token-bucket`), and a fresh process rehydrates
  from that row, so an exhausted bucket does not grant a fresh burst after a
  restart. Writes are debounced to paced acquires and fail open.
- **One accounting owner per failure category.** The spawn circuit owns
  repeated native-task dispatch failures only. The gate-denial tracker exempts
  the frozen `SPAWN PROTECTION CIRCUIT OPEN` code so its denials are not
  double-counted as a second policy.gate_denial ladder. Policy denials, shell
  structural failures, PR-review lane provider-terminal failures, #2473 launch
  retry, and #2506 liveness keep their existing owners.
- **Config.** New `dispatch_protection` section (`enabled` default true,
  `spawn_failure_threshold` 3, `half_open_after_ms` 30000, `rate_per_second`
  10, `burst_capacity` 10), documented in `docs/configuration.md` and covered
  by config-doctor's object-type check for the section. Set `enabled: false`
  to opt out entirely.
- **Budget manifest.** `tests/unit/tools/dispatch-protection-budget-manifest.ts`
  freezes the two composed scenarios (threshold-opening, rate-limited sequence)
  with integer max attempts / host launches / wall-clock bounds and
  module-load validation, mirroring the #2473 precedent.

Parameter surface adopted with credit from opencode-ensemble; reimplemented on
this repository's substrate per ADR 0002 — no upstream code is ported.

## Known limitations

- The in-memory bucket paces the live process even when persistence writes
  fail; a restart after persistent write failure sees no row and grants one
  fresh burst (the limiter's purpose is runaway containment within a process).
- Two host processes sharing a project may race on the bucket row;
  last-writer-wins over-permits by at most one burst (refill math is
  monotonic).
- The spawn circuit is process-local by design (the
  `docs/invocation-failures.md` action-circuit contract); only the PR-review
  resilience circuit is durable.
