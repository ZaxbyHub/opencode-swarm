# First-turn bundled-skill ordering, full-auto resume mode/CAS, and git-init spawn diagnostics

## What changed

- **First-turn bundled-skill ordering (#3364):** the deferred bundled-skill
  materialization now pre-registers a completion handle at post-resolution-task
  enqueue time, and a gate composed FIRST in the chat messages transform awaits
  it (single 15 s budget) before the first turn proceeds. A fresh project's
  first architect MODE self-load can no longer race the copy — measured 16/16
  live observations had the first turn arriving 1.2–3.6 s before the copy
  finished. **Known bound (owner-disclosed):** three escapes keep today's
  fail-open behavior for that turn (command-path sync backstop intact): a copy
  slower than the 15 s budget, a genuinely failed sync, and registration refusal
  at the internal 8-root cap (practically unreachable — one project root per
  plugin process). The first turn of ANY agent in the project pays the single
  wait; later turns are immediate.
- **Full-Auto resume mode + CAS (#3106):** `/swarm full-auto resume` now
  re-derives the armed mode from live config (`full_auto.mode`, defaulting to
  `supervised`) instead of re-arming the paused-time mode — a post-pause config
  tightening is in force for the resumed run. BEHAVIOR CHANGE (disclosed,
  owner decision at the PR): the parsed config ALWAYS materializes
  `full_auto.mode` (schema default `supervised`), so the config value —
  explicit or defaulted — always wins on resume: a per-run `on strict`
  override pauses and resumes as `supervised` under a default config (the
  pre-fix behavior kept the paused-time mode). A post-pause config LOOSENING
  also applies. The raw-config hybrid (override survives unless the config
  explicitly sets a mode) is the recorded owner follow-up option. Resume also arms through an expected-pauseGeneration CAS under the state
  lock: a second process aborting, disarming, or re-pausing the run inside the
  check-then-arm window is refused (with retry-oversight guidance) instead of
  being silently resurrected.
- **git-init harness diagnostics (#3691):** the delegation-gate test harness's
  `initProject` moved to `tests/helpers/git-init-project.ts` and now throws with
  `result.error`/`status=`/`signal=` plus a bounded stderr tail — the empty
  `Error: ` CI failure class (run 43380165115) is diagnosable from the log line.

## Why

Issue #3364 measured the first-turn window on a real host (16/16 runs); nothing
ordered the architect's MODE self-load read after the deferred copy, so
`SKILL_LOAD_FAILED` was reachable by timing luck. Issue #3106 carried two
verified findings from the PR #3091 review (paused-time mode re-arm asymmetry
with `on`, and the non-atomic check-then-arm window that resurrects terminal
state). Issue #3691 recorded the second episode of the delegation-gate
git-init flake with an undiagnosable empty error.

## Boundaries

- The gate adds NO awaited I/O on the plugin-init path (repro-704 stays green);
  the wait happens at first-turn time only.
- The CAS is opt-in: only the resume command passes the expected generation;
  `on` and the intercept hooks keep the unconditional arm.
- v2 hosts share the fix through the same v1 messages-transform chain — no
  separate v2 wiring. On v2 the gate's 15 s budget runs inside the 30 s
  guidance-chain budget (V2_GUIDANCE_CHAIN_TIMEOUT_MS): only the disclosed
  >15 s copy escape can consume it, and chain exhaustion restores the
  pre-transform messages (guidance dropped for that turn — fail-open).
