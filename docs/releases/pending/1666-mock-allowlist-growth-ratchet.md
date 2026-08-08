# mock.module allowlist growth ratchet (issue #1666, item 3)

Issue: #1666

## What

Closes the one remaining open sub-item of issue #1666. The `mock.module` allowlist (`scripts/mock-allowlist.txt`) was a *membership* check only: `scripts/check-invariants.sh` Check 3 verified each mocked target was listed, but nothing prevented the list from growing — running `scripts/generate-mock-allowlist.sh` silently expanded it. The maintainer's own close-out comment on #1666 flagged exactly this gap ("the specific 'baseline-count growth ratchet' with `APPROVED-NEW` escape hatch isn't implemented").

A new **Check 4** in `scripts/check-invariants.sh` adds a diff-scoped growth-direction ratchet:

- Compares the working-tree allowlist against the PR base via `git show <base>:scripts/mock-allowlist.txt` (no parallel baseline file to keep in sync).
- For each entry present at HEAD but not at base (i.e. *added in this PR*), requires a matching standalone marker line `# APPROVED-NEW: <normalized-target>` somewhere in the allowlist.
- Mirrors the established `scripts/check-test-file-cap.sh` (FR-006) shape: `MOCK_ALLOWLIST_ENFORCE` env var defaults to **enforce** when unset; `MOCK_ALLOWLIST_ENFORCE=0` (or `false`/`no`/`off`) soft-warns (prints violations, exits 0) for a deliberate growth PR.
- Shrinking the allowlist is always allowed; the ratchet only fires on growth.
- Bash 3.2-portable (indexed arrays, `grep -E` with POSIX `[[:space:]]`, no `declare -A`, no `grep -P`); CRLF-normalized on both base and head reads so a Windows contributor with `core.autocrlf=true` does not false-fire (issue #1781 re-critic B6 landmine).

`scripts/generate-mock-allowlist.sh` now **preserves `# APPROVED-NEW:` markers across regeneration** — without this, the documented workflow ("run this script to update the list") would silently erase every approval marker and re-open the gap.

The issue's other two items (checked-in coverage threshold, 500-line test-file cap) were already addressed by prior work and are out of scope for this PR — the coverage gate reads `COVERAGE_THRESHOLD` from env (`scripts/ci/run-coverage-gate.sh:9`, superseded the old hardcoded 41.48% literal), and the test-file cap is enforced by `scripts/check-test-file-cap.sh`.

## Why

`mock.module` is a legacy pattern (AGENTS.md invariant 7 prefers the `_internals` DI seam). Without a growth ratchet, the allowlist could only ever grow, and the membership check could not distinguish "this target was approved" from "this target was added and the list was regenerated."

## Migration

No action required for existing PRs. Only PRs that add new `mock.module` targets need to add a `# APPROVED-NEW: <normalized-target>` line to `scripts/mock-allowlist.txt` (convention: immediately above the new entry; the line is preserved by the regenerator). For a deliberate bulk-growth PR (e.g. migrating a test suite that legitimately needs many new mocks), set `MOCK_ALLOWLIST_ENFORCE=0` on the quality job or run locally with that env var.

`AGENTS.md` invariant 7, `docs/engineering-invariants.md`, `contributing.md`, and `TESTING.md` were each updated with a short note pointing at Check 4 and the escape hatch. The allowlist header itself now documents the convention.

## Known caveats

- The marker is **standalone-line only**: `# APPROVED-NEW: src/path/to/target` on its own line. Inline trailing comments on the entry are not accepted (the regenerator would not preserve them).
- The marker target is normalized through `scripts/lib/normalize-mock-target.sh`, so `# APPROVED-NEW: ../../../src/foo/bar.js` matches the entry `src/foo/bar`.
- The marker may appear **anywhere** in the allowlist (the checker does flat set-membership, not adjacency). Convention places it immediately above the entry it approves, and `scripts/generate-mock-allowlist.sh` preserves that placement across regeneration.
- The no-base-branch path (local-dev clone without `origin/main` fetched) is non-blocking: Check 4 prints a `NOTE:` and skips. This requires the calling job's `actions/checkout` to use `fetch-depth: 0` (or another depth deep enough to include the merge base) — a shallow default-depth-1 checkout never resolves `origin/main`, silently no-ops every diff-scoped ratchet in that job, and is not itself guaranteed by "real CI" in general (see PR #2062 F-003: the `quality` job's checkout previously had no `fetch-depth` set at all).

## Test plan

- New `tests/unit/scripts/check-mock-allowlist-ratchet.test.ts` (11 cases: no-growth pass, growth+marker pass, growth−marker fail, growth+mismatched-marker fail, marker normalization pass, multi-target partial approval fail, shrink pass, simultaneous grow+shrink pass, soft-warn escape hatch, no-base-branch skip, CRLF head / LF base pass). Pattern mirrors `check-test-file-cap.test.ts` with explicit `timeout: 30000` on every spawn.
- Extended `tests/unit/scripts/generate-mock-allowlist.test.ts` with a marker-preservation case.
- Extended `tests/unit/scripts/check-invariants.test.ts` with a Check 4 header smoke test and renamed the stale sibling test to "should run all four checks".
- `scripts/check-bash-portability.sh` confirms no bash4+-only constructs were introduced, and now also detects the empty-array `"${arr[@]}"`-under-`set -u` class (the bug class that originally failed macOS CI on this PR's first push — see revision 2).
