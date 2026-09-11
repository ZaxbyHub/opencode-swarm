---
category: Added
---

- The plugin now measures and enforces a complete startup and first-use
  latency contract (issue #2670). Import, server resolution, first turn,
  first tool, readiness (post-resolution queue settle), and per-task
  optional-task outcomes are instrumented SEPARATELY by
  `src/observability/startup-contract.ts` and emitted as single-line
  `STARTUP-CONTRACT <json>` rows under `OPENCODE_SWARM_DEBUG=1` — zero rows
  with the env var unset. Failed optional tasks carry a bounded
  (≤200 chars, no stack) diagnostic; optional work never gates manifest
  delivery.
- New operator harness `bun run repro:2670` (issue-tracer trace
  `2670-startup-latency-contract`): a fresh-process matrix across cold Git
  and non-Git cells with repetitions and hard budgets
  (import ≤ 8000 ms, server ≤ 4000 ms, first turn ≤ 8000 ms,
  first tool ≤ 8000 ms, queue settle ≤ 45 000 ms) evaluated min-of-reps per
  cell so a single cold-runner transient cannot block; the distribution with
  outliers is printed and retained. `--expect-report` validates the report
  contract (stage keys on distinct rows, config-churn and
  readiness-warning columns kept separate from latency intervals);
  `--churn-fixture` proves the degraded cells (pre-existing config backup,
  status artifact as a directory, `.swarm` as a regular file, malformed
  project config) keep delivering the mandatory manifest with bounded
  outcomes and zero new backups. Wired into the CI smoke job on
  ubuntu/macos/windows next to repro-704.
- Deterministic unit coverage: `tests/unit/observability/startup-contract-2670.test.ts`
  (collector semantics, bounded failure diagnostics, queue settle accounting,
  once-only first-use markers, startup-window advisory counting, debug
  emission gate) and `tests/unit/index-startup-contract-outcomes-2670.test.ts`
  (full `server()` boots with the captured scheduler: the structural proof
  that no optional work runs before manifest delivery, typed failed outcomes
  that do not crash the drain, and real first-turn/first-tool markers).
- Documentation: `docs/startup-latency.md` publishes the stage definitions,
  budgets, warm/cold methodology, and interpretation rules — including that
  a Linux pass does not establish a Windows cold-filesystem claim and that
  readiness warnings are separate from server latency.
