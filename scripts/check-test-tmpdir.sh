#!/usr/bin/env bash
# Issue #1737 FR-011 — lint for the macOS /var -> /private/var symlink gap.
# `os.tmpdir()` returns a path under `/var/...` on macOS, but `/var` is itself
# a symlink to `/private/var`; production code that canonicalizes paths (e.g.
# containment guards) compares against the resolved `/private/var/...` form.
# A test that creates a fixture via the raw path and checks it via the
# canonicalized path silently diverges on macOS CI. tests/helpers/tmpdir.ts
# (canonicalTmpDir / canonicalMkdtemp) exists so new tests don't reintroduce
# this bug piecemeal.
#
# LINE-SCOPED (not file-scoped, unlike check-mock-cleanup.sh/check-test-clock.sh):
# ingest found ~250 pre-existing raw os.tmpdir()/mkdtempSync() occurrences
# across 30+ test files; retrofitting them is explicitly out of scope (FR-011
# scope decision). A file-scoped check (flag the whole file if ANY PR touches
# it) would false-fail on unrelated changes to those files. This check instead
# diffs at the line level (`git diff --unified=0`) and only flags lines
# ADDED by the current diff, so pre-existing raw calls elsewhere in a touched
# file never trip it.
#
# A violation is an ADDED line calling `tmpdir()` — matching both `os.tmpdir()`
# and the bare `tmpdir()` form used via `import { tmpdir } from 'node:os'`
# (both idioms are in active use across tests/) — that does NOT also contain
# `realpathSync` on the same line (the repo's established one-line idiom, e.g.
# `fs.realpathSync(os.tmpdir())`). Prefer `canonicalTmpDir()` /
# `canonicalMkdtemp(prefix)` from tests/helpers/tmpdir.ts instead of
# hand-rolling the wrap.
#
# Project-relative temp roots are also rejected. Tests that create `tmp/` below
# the checkout can leave runtime `.swarm/` state in the repository and couple
# otherwise-isolated files through a shared directory. The line-scoped check
# catches both direct calls and the historical `const baseDir = 'tmp'` helper
# shape while leaving pre-existing occurrences outside the diff untouched.
#
# KNOWN LIMITATION: Plain-text substring match, not syntax-aware, so `tmpdir()`
# in string literals/comments also trips it. Accepted tradeoff for a portable bash
# script (no JS/TS parser) — fails safe (over-flags) rather than silently missing
# violations. Rephrase any false-positive string/comment to avoid the substring.
#
# Portability (issue #1729 merge_group macOS): bash 3.2 on macOS — no
# associative arrays, no `grep -P`. Plain indexed arrays + grep -E only.
set -euo pipefail

violations=0

# Resolve base branch (mirrors check-mock-cleanup.sh / check-test-clock.sh).
base_branch=""
for branch in origin/main origin/master main master; do
    if git rev-parse "$branch" >/dev/null 2>&1; then
        base_branch="$branch"
        break
    fi
done

if [ -z "$base_branch" ]; then
    echo "check-test-tmpdir: no base branch found (no PR context) — skipping (non-blocking)."
    exit 0
fi

# Unified=0 diff restricted to test files (tests/**/*.test.ts AND src/**/*.test.ts
# both carry raw os.tmpdir()/mkdtempSync() usage per grep survey), so hunk
# headers give exact added-line numbers with no surrounding context lines to
# filter out.
diff_output="$(git diff --unified=0 "$base_branch" HEAD -- '*.test.ts' 2>/dev/null || true)"

if [ -z "$diff_output" ]; then
    echo "check-test-tmpdir: no test file changes in diff — nothing to check."
    exit 0
fi

current_file=""
current_lineno=0

while IFS= read -r line; do
    case "$line" in
        "+++ "*)
            # "+++ b/path/to/file.ts" (or "+++ /dev/null" for deletions).
            current_file="${line#+++ }"
            current_file="${current_file#b/}"
            continue
            ;;
        "@@ "*)
            # "@@ -a,b +c,d @@ ..." — extract the new-file starting line c.
            hunk_new="$(echo "$line" | grep -oE '\+[0-9]+' | head -1 | tr -d '+' || true)"
            current_lineno="${hunk_new:-0}"
            continue
            ;;
        "--- "*)
            continue
            ;;
    esac

    case "$line" in
        "+"*)
            content="${line#+}"
            if echo "$content" | grep -qE 'tmpdir\(\)'; then
                if ! echo "$content" | grep -q 'realpathSync'; then
                    echo "ERROR: ${current_file}:${current_lineno} adds a raw tmpdir() call not wrapped in realpathSync."
                    echo "       Use canonicalTmpDir() / canonicalMkdtemp(prefix) from tests/helpers/tmpdir.ts"
                    echo "       (or wrap with fs.realpathSync(...) on the same line) to close the macOS"
                    echo "       /var -> /private/var symlink gap. See FR-011 (issue #1737)."
                    violations=$((violations + 1))
                fi
            fi
            if echo "$content" | grep -qE "(baseDir|tempDir|tmpDir)[[:space:]]*=[[:space:]]*['\"]tmp['\"]|(mkdtemp|mkdtempSync|mkdir|mkdirSync)\([^)]*['\"]tmp['\"]"; then
                echo "ERROR: ${current_file}:${current_lineno} adds a project-relative test temp root."
                echo "       Use canonicalMkdtemp(prefix) from tests/helpers/tmpdir.ts so fixtures"
                echo "       remain outside the repository and are realpath-canonicalized."
                violations=$((violations + 1))
            fi
            current_lineno=$((current_lineno + 1))
            ;;
    esac
done <<< "$diff_output"

echo ""
echo "=== Summary ==="
echo "New violations (blocking): $violations"

if [ "$violations" -gt 0 ]; then
    exit 1
fi

echo "All new/changed test temp roots are external and canonicalized."
