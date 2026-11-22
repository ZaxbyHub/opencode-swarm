# `fix(sast)`: docs-only scope with a phase baseline no longer fails SAST with `failure_kind: coverage`

## Summary

- `sast_scan` hard-failed with `failure_kind: 'coverage'` ("SAST requires at least one file to scan; zero files were scanned") whenever EVERY file in the scope was non-code (e.g. a docs-only task editing only `AGENTS.md`) **and** a phase baseline had been captured earlier in the same phase.
- Root cause: the issue #2271 bug 3 fix (non-code-only diffs are a legitimate nothing-to-scan PASS) was guarded by `!baselineUsed`. `pre_check_batch` always passes `phase` to `sast_scan`, so as soon as any earlier task in the phase captured a SAST baseline, every subsequent docs-only task fell into the zero-coverage hard fail instead of the non-code pass. A baseline cannot make markdown scannable, and zero scannable inputs cannot produce new findings, so the guard had no protective value.
- Fix: the non-code-only pass now applies in legacy AND baseline diff mode. A docs-only diff with a loaded baseline passes with `summary.files_skipped_non_code`, empty `new_findings`, and no `error`/`failure_kind`. The hard fail remains for empty input, capture mode with nothing scannable, and mixed scopes where a scannable code file was missing/oversized/binary.

## User-facing changes

- Documentation-only tasks in a swarm loop no longer wedge in `workflow.state: rework_required` with `pre_check`/`reviewer` blocked once a phase SAST baseline exists. `pre_check_batch` and the reviewer dispatch run normally for such tasks.

## Migration notes

None required.

## Discovery context

Found in the Wirtschaftssimulation loop (session `43d6d1c3-a28f-42f0-851c-056ecc216587`, task 1.8): the task's scope was exclusively `AGENTS.md`, earlier phase-1 code tasks had captured a SAST baseline, and `pre_check_batch` scanned 0 files → `failure_kind: coverage` → `gates_passed: false`, blocking the documented documentation-review path. Reproduced deterministically with a capture-then-docs-only scan sequence; pinned by two new tests in `tests/unit/tools/sast-scan-zero-coverage-error.test.ts` (baseline-mode non-code pass, and mixed markdown + missing code file still failing closed in baseline mode).
