---
issue: 3265, 3487
---

Merge-queue failure diagnostics: an orphaned-entry detector and a self-hosted
stale-runner classifier.

`scripts/check-merge-queue-progress.mjs --pr <n>` names a stuck merge-queue
entry in one line (`<VERDICT> pr=<n> age=<m> state=<state>`): `ORPHANED`
(accepted past the 150-minute default threshold with zero active queue
builds and an OPEN PR — recovery line printed, exit 2; any other PR state
suppresses the recovery), `BUILDING` (any non-terminal queue build counts —
`queued` runs are active under runner contention), `IDLE`, or `UNKNOWN` (a
removed entry cross-checked against PR state, or a run window that cannot
reach the entry event). The detection authority is the last
`queue|auto_merge` timeline event plus a 100-run merge-group window on the
`gh-readonly-queue/main/pr-<n>-` prefix — never elapsed time alone, which
would force-cycle a healthy in-flight build.

`scripts/ci/merge-group-stale-runner-classifier.ts --run <id>` classifies a
failed merge-group batch from per-job step evidence (exit 0 for every
verdict, 1 for usage/gh errors): routed jobs that died at `actions/checkout`
with hosted legs green (modulo the `unit-passed` cascade) read
`runner-stale-clone` — the 2026-10-27 stale-runner signature that cost six
re-enqueue cycles — while any work-phase failure (Biome, a test, a coverage
threshold) reads `test-failure` and outranks a coexisting checkout death,
never excused by missing logs; unattributable failures read `unknown`.
Malformed job payloads degrade to `unknown` instead of crashing, and echoed
job names are control-character-sanitized.

The ci-fix-monitor protocol gains the orphaned-entry and batch-classification
steps under "Push and monitor".
