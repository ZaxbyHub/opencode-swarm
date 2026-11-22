# `fix(sast)`: a non-code-only scope with a phase baseline no longer fails SAST with `failure_kind: coverage`

## What changed

- `sast_scan` hard-failed with `failure_kind: 'coverage'` ("SAST requires at least one file to scan; zero files were scanned") whenever EVERY input in the scope had no SAST language profile ("non-code") **and** a phase baseline had been captured earlier in the same phase. Markdown is the headline case (e.g. a documentation task editing only `AGENTS.md`), but any input with no language profile qualifies: `.json`, `.yml`, `.toml`, `.tf`, `.sql`, and so on.
- The non-code-only pass now applies in legacy AND baseline diff mode (legacy mode already passed; baseline mode is now aligned). It passes with `summary.files_skipped_non_code`, empty `new_findings`, and no `error`/`failure_kind`.
- The hard fail remains for empty input, for capture mode with nothing scannable, and for scopes containing a scannable file that was oversized or binary. A missing or deleted input is counted as skipped, not as non-code, so a scope containing one (including a deleted `.md`) still hard-fails.

## Why

The issue #2271 bug 3 fix (non-code-only diffs are a legitimate nothing-to-scan PASS) was guarded by `!baselineUsed`. `pre_check_batch` always passes `phase` to `sast_scan`, so as soon as any earlier task in the phase captured a SAST baseline, every subsequent non-code-only task fell into the zero-coverage hard fail instead of the non-code pass. A baseline cannot make non-code files scannable, and zero scannable inputs cannot produce new findings, so the guard had no protective value. Secrets scanning is a separate hard gate and is unchanged.

Found in the Wirtschaftssimulation loop (session `43d6d1c3-a28f-42f0-851c-056ecc216587`, task 1.8): the task's scope was exclusively `AGENTS.md`, earlier phase-1 code tasks had captured a SAST baseline, and `pre_check_batch` scanned 0 files, giving `failure_kind: coverage` and `gates_passed: false`.

## Migration steps

None required.

## Known caveats

- Documentation tasks in a swarm loop no longer wedge in `workflow.state: rework_required` once a phase SAST baseline exists.
- Pinned by tests in `tests/unit/tools/sast-scan-zero-coverage-error.test.ts` (baseline-mode non-code pass; mixed Markdown + missing code file failing closed in baseline mode; capture mode with only non-code inputs still hard-failing with `failure_kind: invalid_input`; a deleted `.md` still hard-failing with `failure_kind: coverage`).
