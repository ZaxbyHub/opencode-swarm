---
issue: 3260
---

fix(tests): teardown/retry hardening — one schedule, bounded stages, non-stranding teardown, run-wide seam guard (#3260, #3252)

- `safeRmRecursive` now consumes the PRODUCTION unlink retry schedule
  (`ACTIVE_STATE_UNLINK_RETRY_DELAYS_MS`, ~15.2 s over 20 delays plus one final
  attempt) instead of its own ~9.9 s literal — the two budgets were sized for
  the same windows-latest handle-release tail but written in different PRs, and
  the shorter teardown window hard-failed merge-group shards the production
  schedule survived. Both constants now live in one import-free leaf module
  (`src/commands/close/unlink-schedule.ts`, re-exported by `constants.ts`).
- `/swarm close` clean stage: a configurable admission deadline
  (`CLEAN_STAGE_DEADLINE_MS`, default 60 s; `SWARM_CLEAN_STAGE_DEADLINE_MS`
  override) stops admitting further active-state artifacts once elapsed —
  skipped artifacts stay in place (archive copies exist) with ONE bounded
  warning; terminal-state removal still runs unconditionally. A write-denied
  artifact (EACCES/EPERM from a W_OK probe — ACL-denied class) now fails fast
  instead of burning the full 15.2 s schedule; ENOENT and locked-but-writable
  holds keep the full retry.
- New `safeRmAllRecursive(dirs)` teardown helper attempts EVERY directory and
  throws after collecting per-dir failures (AggregateError naming each path) —
  a `for (...) safeRmRecursive(d)` loop rethrew on the first stuck dir and
  stranded the rest.
- Run-wide `_internals` restorer guard: the safe-test-dir seam snapshot is
  checked in the aggregated preload afterAll, so a suite that swaps a seam
  member (e.g. `wait`) and leaks it fails its own run instead of silently
  collapsing every later consumer's retry budget.
- `scripts/ci/run-coverage-gate.sh` now removes the `.swarm/coverage-gate/`
  directory it creates (exit trap) — a local run on a fresh checkout no longer
  leaves `.swarm/` behind silently disabling checkout-drift enforcement for
  later local `bun test` runs.
- #3252: all 28 flagged raw recursive-`rmSync` cleanup sites routed through
  the hardened helpers (27 converted; `check-host-contract-2902` individually
  justified on the issue — its corpus deliberately lives under the repo root),
  and the four Windows forensics files dispositioned on the issue
  (DISPOSITION-3252): reentry-bypass root-fixed out-of-band, j04 git-spawn
  single-hit recorded, archive.test.ts aged-bundle divergence recorded under
  the #2973 ledger policy, evidence-summary #2973 budget-widening stands.
