---
issue: 3265, 3487
---

Merge-queue failure diagnostics: an orphaned-entry detector and a self-hosted
stale-runner classifier.

`scripts/check-merge-queue-progress.mjs --pr <n>` names a stuck merge-queue
entry in one line: `ORPHANED` (accepted past the threshold with zero active
queue builds — recovery line printed, exit 2), `BUILDING`, `IDLE`, or
`UNKNOWN` (a removed entry cross-checked against PR state, so a merged PR is
never power-cycled). The detection authority is the last `queue|auto_merge`
timeline event plus a ≥100-run window on the
`gh-readonly-queue/main/pr-<n>-` prefix — never elapsed time alone, which
would force-cycle a healthy in-flight build.

`scripts/ci/merge-group-stale-runner-classifier.ts --run <id>` classifies a
failed merge-group batch from per-job step evidence: routed jobs that died at
`actions/checkout` with hosted legs green (modulo the `unit-passed` cascade)
read `runner-stale-clone` — the 2026-10-27 stale-runner signature that cost
six re-enqueue cycles — while any work-phase failure (Biome, a test, a
coverage threshold) reads `test-failure` and can never be excused by missing
logs; unattributable failures read `unknown`.

The ci-fix-monitor protocol gains the orphaned-entry and batch-classification
steps under "Push and monitor".
