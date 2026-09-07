### Advisory headless CI: `swarm ci` evaluates gates read-only with machine exit codes

**What changed**

- New `swarm ci` command (also `bunx opencode-swarm ci` and `/swarm ci`) runs
  the gated pipeline's advisory evaluation in a clean noninteractive
  environment — no TTY, no OpenCode host, no plugin boot. Exit codes: 0 all
  evaluated gates pass; 1 any violation / no-data / corrupt evidence /
  nothing to evaluate; 2 cancelled (SIGINT/SIGTERM); 3 deadline or internal
  error. Output is a Markdown report plus a machine-readable
  `[SWARM_CI_JSON]` block (`--json` for the block only). See `docs/ci.md`.
- New host-decoupled runtime under `src/ci/`: a bounded harness (overall
  deadline via `--timeout-ms`, signal-driven cancellation with exactly-once
  cleanup, capped 200-event run journal) around an evaluation that composes
  the existing authoritative readers — per-task required gates with #2470
  tri-state evidence (valid / missing / corrupt are distinct), a
  terminal-workflow guard (`rework_required` and other non-terminal states
  are never a vacuous pass), plan-critic approval, and the evidence-quality
  thresholds. "No data" is never a pass.
- DB-mediated reads (QA gate profile, plan-critic snapshots) run against a
  bounded, discarded shadow copy of `.swarm/` so the evaluated repo is never
  modified; advisory evaluation is strictly read-only and cannot satisfy or
  bypass any gate. Enabled profile gates without a durable whole-plan reader
  are reported as `not_evaluated` instead of being silently skipped.
- `/swarm benchmark --ci-gate` now computes its evidence-derived quality
  signals through the same shared service as `swarm ci`
  (`src/ci/quality-checks.ts`) — one implementation, byte-compatible
  benchmark output, plus the in-repo guardrails
  (`tests/unit/ci/host-decoupling-ratchet.test.ts` bans host-state tokens and
  durable-writer imports in `src/ci/**`; `tests/unit/ci/wiring-ratchet.test.ts`
  requires every `src/ci` export be reachable from the production entry or a
  test seam).

**Why**

Issue #2497 (Workstream F PR 05, from #1224 phase 1): the plugin's
verification/gate services only executed inside the OpenCode host, and the
closest existing headless surface (`benchmark --ci-gate`) passes checks
vacuously when its live session-state inputs are empty. Teams get "did every
gate pass, with evidence" as a machine check on any CI runner.

**Notes**

- Publishing the composite GitHub Action is deliberately out of scope
  (tracking slot #2498); this command is the surface that Action will wrap.
- The full LLM headless pipeline (`opencode serve`-backed architect loop)
  remains #1224 phase 2; `swarm ci` is advisory-only and spawns no processes.
