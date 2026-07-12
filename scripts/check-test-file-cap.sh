#!/usr/bin/env bash
# Issue #1781 E1 — enforce the FR-006 500-line test-file cap as a diff-scoped
# ratchet. AGENTS.md invariant 7 and contributing.md/TESTING.md document the
# rule; this script makes it bite in CI.
#
# Ratchet semantics (mirrors scripts/check-mock-cleanup.sh FB-001 and
# scripts/check-test-clock.sh):
#   - Pre-existing over-cap files NOT in the PR diff → non-blocking (silent).
#   - NEW test files in the diff over the cap → ERROR (blocking).
#   - MODIFIED test files in the diff that are over the cap AND grew →
#     ERROR (ratchet arm).
#   - MODIFIED over-cap files that shrank or stayed equal → pass.
#   - Pre-existing violators never fail unrelated PRs.
#
# Escape hatch (issue #1781 re-critic B5): TEST_CAP_ENFORCE. Default is ENFORCE
# (unset → hard-fail), the opposite of DRIFT_CHECK_ENFORCE's default, because
# the ratchet is already scoped to new/grown files only. Set
#   TEST_CAP_ENFORCE=0|false|no|off
# to soft-warn (print violations, exit 0) — useful for a deliberate growth PR.
#
# Line-ending handling (issue #1781 re-critic B6): `tr -d '\r' | wc -l`
# normalizes CRLF→LF before counting so a pure line-ending normalization does
# not false-fail "grew by 1".
#
# Rename handling (issue #1781 re-critic B6): `git diff --diff-filter=A
# --find-renames=100%` treats only exact-content renames as renames (R); a
# renamed+grown file falls below 100% similarity → classified as Added →
# flagged by the new-file arm.
#
# Portability (issue #1729 merge_group macOS): bash 3.2 on macOS — no
# associative arrays, no `grep -P`. Plain indexed arrays + grep -E only.
set -euo pipefail

MAX_LINES=500
violations=0
new_file_violations=0
ratchet_violations=0

# --- TEST_CAP_ENFORCE truth table (re-critic B5) ---
# unset OR any value other than 0/false/no/off → hard-fail (default enforce).
# 0/false/no/off → soft-warn (exit 0). This is the OPPOSITE default from
# DRIFT_CHECK_ENFORCE: the ratchet is already scoped to new/grown files only,
# so defaulting to enforce in CI (where the var is unset) is correct.
if [ -z "${TEST_CAP_ENFORCE+x}" ]; then
    is_enforce_resolved=1  # unset → enforce
else
    case "$(echo "${TEST_CAP_ENFORCE}" | tr '[:upper:]' '[:lower:]')" in
        0|false|no|off) is_enforce_resolved=0;;
        *) is_enforce_resolved=1;;
    esac
fi

# --- helpers (verbatim from check-test-clock.sh:33-56) ---
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

# Resolve base branch once (used for both changed-file list and added-file list).
base_branch=""
for branch in origin/main origin/master main master; do
    if git rev-parse "$branch" >/dev/null 2>&1; then
        base_branch="$branch"
        break
    fi
done

PR_CHANGED_FILES="$(get_pr_changed_files)"

# Added-file set: `--find-renames=100%` means only exact-content renames are
# detected as renames (R); a renamed-and-modified file falls below 100%
# similarity and shows as Added (A). This is the desired semantics — a renamed
# file whose content changed should be treated as new for cap purposes.
ADDED_FILES=""
if [ -n "$base_branch" ]; then
    ADDED_FILES=$(git diff --diff-filter=A --name-only --find-renames=100% \
        "$base_branch" HEAD 2>/dev/null || echo "")
fi

is_added_file() {
    local file="$1"
    if [ -z "$ADDED_FILES" ]; then
        return 1
    fi
    echo "$ADDED_FILES" | grep -qFx "$file"
    return $?
}

# Normalized line count: strip CR before counting so CRLF/LF normalization
# cannot false-fail the ratchet comparison.
normalized_wc() {
    tr -d '\r' < "$1" | wc -l | tr -d ' '
}

# Iterate over every test file currently in the tree that is part of the PR
# diff (pre-existing over-cap files not in the diff are skipped silently).
# `while IFS= read -r` (not `for file in $(...)`) so paths with spaces are not
# word-split — matches the sibling pattern in check-test-clock.sh:62.
while IFS= read -r file; do
    [ -n "$file" ] || continue
    [ -f "$file" ] || continue

    now_lines=$(normalized_wc "$file")
    if [ "$now_lines" -le "$MAX_LINES" ]; then
        continue
    fi

    # File is over the cap. Decide NEW vs RATCHET vs pre-existing.
    if is_added_file "$file"; then
        echo "ERROR (new file): $file is $now_lines lines (cap $MAX_LINES, FR-006)."
        echo "  Split it by behavior/feature into focused files under 500 lines."
        violations=$((violations + 1))
        new_file_violations=$((new_file_violations + 1))
        continue
    fi

    # Modified file over the cap: ratchet arm. Compare against base line count.
    if [ -n "$base_branch" ]; then
        base_lines=$(git show "${base_branch}:${file}" 2>/dev/null \
            | tr -d '\r' | wc -l | tr -d ' ' || echo "0")
    else
        base_lines=0
    fi

    if [ "$base_lines" -eq 0 ]; then
        # File did not exist at base under this path (rename/delete-readd) →
        # treat as new.
        echo "ERROR (new path): $file is $now_lines lines (cap $MAX_LINES, FR-006); not present at base."
        violations=$((violations + 1))
        new_file_violations=$((new_file_violations + 1))
        continue
    fi

    if [ "$now_lines" -gt "$base_lines" ]; then
        echo "ERROR (ratchet): $file grew from $base_lines to $now_lines lines (cap $MAX_LINES, FR-006)."
        echo "  Over-cap files must not grow. Split the new behavior into a separate file."
        violations=$((violations + 1))
        ratchet_violations=$((ratchet_violations + 1))
        continue
    fi

    # Over cap but shrank or equal → pass (ratchet allows shrinkage).
    :
done < <(echo "$PR_CHANGED_FILES" | grep -E '\.test\.ts$' || true)

echo ""
echo "=== Test file cap (FR-006) summary ==="
echo "New-file violations: $new_file_violations"
echo "Ratchet violations:  $ratchet_violations"

if [ "$violations" -gt 0 ]; then
    if [ "$is_enforce_resolved" -eq 1 ]; then
        echo "TEST_CAP_ENFORCE is on (default). Failing the build."
        exit 1
    else
        echo "TEST_CAP_ENFORCE is off — soft-warn (non-blocking)."
        exit 0
    fi
fi

echo "All test-file-cap checks passed."
