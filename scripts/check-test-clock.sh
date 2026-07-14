#!/usr/bin/env bash
# Check that test files using the real clock (Date.now / new Date() / spyOn(Date))
# also use the freezeClock helper, so time-sensitive assertions don't flake
# under coverage instrumentation (issue #1782, root-cause class 1).
#
# A test file is a VIOLATION if it contains a raw time read
# (Date.now() / no-argument new Date() / spyOn(Date) ) AND does not reference
# the helper. Date constructors with explicit inputs are deterministic fixtures
# and are intentionally excluded.
# (freezeClock / withFrozenClock / withFrozenClockAsync).
#
# The helper reference is a proxy for "the author considered time-sensitivity."
# It is deliberately permissive on the helper side: any reference counts,
# because the lint cannot do call-graph analysis from bash. Most legitimate
# raw-clock uses (fixture IDs, tmp suffixes) are fine in files that ALSO freeze
# the clock for their assertions. Files that use the clock at all but never
# reference the helper are the ones most likely to add a flaky assertion.
#
# This script is DIFFF-SCOPED (mirrors check-mock-cleanup.sh FB-001):
#   - Pre-existing violations (files not in the PR diff) → WARNING, non-blocking.
#   - NEW violations (files added/modified in the PR diff) → ERROR, blocking.
# This avoids the day-1 wall of ~473 pre-existing files (issue #1782 plan
# critic C3) while still forcing every NEW time-touching test to acknowledge
# the helper.
#
# Portability (issue #1729 merge_group macOS): bash 3.2 on macOS — no
# associative arrays, no `grep -P`. Plain indexed arrays + grep -E only.
set -euo pipefail

violations=0
new_violations=0
pre_existing_violations=0

# Get list of files changed in PR diff (compare against main/master)
get_pr_changed_files() {
    local pr_files=""
    local base_branch=""
    for branch in origin/main origin/master main master; do
        if git rev-parse "$branch" >/dev/null 2>&1; then
            base_branch="$branch"
            break
        fi
    done
    if [ -n "$base_branch" ]; then
        pr_files=$(git diff --name-only "$base_branch" HEAD 2>/dev/null || echo "")
    fi
    echo "$pr_files"
}

is_pr_file() {
    local file="$1"
    local pr_files="$2"
    if [ -z "$pr_files" ]; then
        return 1  # No PR context → treat as pre-existing (non-blocking).
    fi
    echo "$pr_files" | grep -qF "$file"
    return $?
}

PR_CHANGED_FILES=$(get_pr_changed_files)

# --- Check: raw clock use in tests must reference freezeClock ---
# Find test files that touch the real clock.
while IFS= read -r file; do
    [ -n "$file" ] || continue
    # Does the file ACTIVELY use a clock-aware helper?
    # Require an import of the helper module OR a call-site (function-call
    # syntax), NOT a bare mention in a comment/string (PR review F-003: a
    # `// TODO: use freezeClock` comment must not satisfy the lint).
    # import-from: matches `from '.../test-clock.js'` or `.../test-isolation.js'`
    # call-site: matches `withFrozenClock(` / `freezeClock(` / `withIsolatedState(` / `setupIsolatedState(`
    has_import=$(grep -cE "from ['\"][^'\"]*(test-clock|test-isolation)\.js['\"]" "$file" || true)
    has_call=$(grep -cE "(withFrozenClock|freezeClock|withFrozenClockAsync|withIsolatedState|setupIsolatedState)\s*\(" "$file" || true)
    if [ "$has_import" -gt 0 ] || [ "$has_call" -gt 0 ]; then
        continue
    fi
    if is_pr_file "$file" "$PR_CHANGED_FILES"; then
        echo "ERROR: $file uses the real clock (Date.now / new Date() / spyOn(Date)) but does not import or call the freezeClock helper."
        echo "       Import from '../../helpers/test-clock.js' (adjust depth) and wrap"
        echo "       time-sensitive assertions in withFrozenClock(() => { ... })."
        echo "       (A comment mentioning the helper does NOT satisfy this check —"
        echo "       you must import or call it.)"
        echo "       See docs/testing/test-stability.md (issue #1782)."
        violations=$((violations + 1))
        new_violations=$((new_violations + 1))
    else
        pre_existing_violations=$((pre_existing_violations + 1))
    fi
done < <(grep -rlE "Date\.now\(\)|new Date[[:space:]]*\([[:space:]]*\)|spyOn\(Date" tests/ --include="*.test.ts" \
    --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null || true)

echo ""
echo "=== Summary ==="
echo "New violations (blocking): $new_violations"
echo "Pre-existing violations (non-blocking warnings): $pre_existing_violations"

if [ "$violations" -gt 0 ]; then
    exit 1
fi

echo "All test-clock checks passed."
