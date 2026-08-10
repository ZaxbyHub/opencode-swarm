# Cross-platform FR-006 test-file cap gate + Bash-only-gate recurrence ratchet (issue #2078)

Issue: #2078

## What

`scripts/check-test-file-cap.sh` enforced the FR-006 500-line test-file cap in CI but was Bash-only. On a Windows host without Bash in PATH it could not run, so Windows contributors had no way to verify the cap locally before pushing and fell back to manual line counting.

The ratchet is now implemented once, in TypeScript:

- **`scripts/check-test-file-cap.ts`** — the single source of truth for the cap value (`MAX_LINES = 500`), the `TEST_CAP_ENFORCE` truth table, `wc -l`-equivalent CRLF-normalized line counting, and the new-file / ratchet / pre-existing decision table. The ratchet decision table, the message strings, and the exit codes are byte-for-byte unchanged (verified by running the pre-change script and the port side by side against the real repo). Git plumbing is injected into a pure `evaluateCap()` so the decision table is directly unit-testable. Two deliberate improvements over the Bash original: changed-file lists are read NUL-separated (`git diff -z`), fixing path-quoting fragility; and the gate resolves the repository root via `git rev-parse --show-toplevel`, so running it from a subdirectory no longer produces a silent vacuous pass (previously every file lookup missed and the gate reported "all checks passed").
- **`bun run check:test-file-cap`** — the single command a contributor runs on Windows PowerShell, macOS, or Linux.
- **`scripts/check-test-file-cap.sh`** — retained as a zero-logic shim that `exec`s the TypeScript gate, so every existing reference to the `.sh` path keeps working and the two entry points cannot report different results. A test asserts the shim contains no cap value, no `MAX_LINES`, and no `TEST_CAP_ENFORCE` parsing, which is what prevents the drifting-clone outcome the issue warned against.
- **`.github/workflows/ci.yml`** — the quality-job step now runs `bun run check:test-file-cap` with no `shell: bash` and no `chmod`. CI behavior is otherwise unchanged: it still hard-fails on a cap violation.

## Recurrence guardrail

Fixing the one script does not close the class — the next gate added as a `.sh` reintroduces it silently. **`scripts/check-gate-portability.ts`** (`bun run check:gate-portability`, wired into the CI quality job) fails when any `scripts/**/*.sh` referenced from a `.github/workflows/` file — or, recursively, from a local composite action under `.github/actions/` — is missing from `scripts/gate-portability-baseline.json`. The eight currently-referenced Bash scripts are baselined with a category (`legacy-bash-gate` or `ci-infrastructure`) and a written justification; stale entries and invalid categories also fail, so porting a legacy gate forces its exemption to be removed rather than rotting.

The check announces the roots it scanned (`Scan roots: .github/workflows, .github/actions`) before its summary. That line is load-bearing, not decoration: `.github/actions/` does not exist in this repo today, so a silently narrowed scan set would otherwise be invisible in both CI output and tests. Mutation testing confirms the guardrail's own coverage — ignoring the roots parameter, threading only the first root, dropping the actions entry from the defaults, narrowing the default binding, hardcoding the announcement, and removing the announcement each turn the suite red.

## Docs

`.opencode/skills/writing-tests/SKILL.md` gains a "Local validation (all platforms, including Windows)" subsection covering the command, the `origin/main` fetch prerequisite, the vacuous-pass case when no base branch resolves, the soft-warn exit-code trap, and the fact that the gate takes its file list from `<base>..HEAD` (so uncommitted work is invisible to it). `contributing.md`, `TESTING.md`, and the `test-file-split` skill mirrors point at the new entry point.
