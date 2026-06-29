#!/usr/bin/env bash
# Check that test files using mock.module have proper cleanup.
# Cross-module mock.module is permitted per two-tier convention,
# but must have afterEach(mock.restore()) or documented exception.
#
# FB-001: This script is non-blocking for pre-existing violations.
# It only fails if the PR DIFF introduces NEW violations.
# Pre-existing violations are reported as WARNINGS, not errors.
set -euo pipefail

violations=0
new_violations=0
pre_existing_violations=0

# Get list of files changed in PR diff (compare against main/master)
get_pr_changed_files() {
    local pr_files=""
    # Try to detect the base branch
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

# Check if a file is in the PR diff
is_pr_file() {
    local file="$1"
    local pr_files="$2"
    if [ -z "$pr_files" ]; then
        return 1  # No PR context
    fi
    echo "$pr_files" | grep -qF "$file"
    return $?
}

# Get PR changed files
PR_CHANGED_FILES=$(get_pr_changed_files)

# --- Check 1: mock.module cleanup ---
while IFS= read -r file; do
  # Check if file has afterEach with mock.restore
  has_cleanup=$(grep -c "mock\.restore" "$file" || true)
  # Check if file uses file-scoped mock pattern (mockClear/mockReset in beforeEach)
  has_file_scoped=$(grep -c "mockClear\|mockReset" "$file" || true)
  # Check if file has documented exception
  has_exception=$(grep -c "skip.*mock\.restore\|NOT.*mock\.restore\|no.*mock\.restore\|file-scoped\|mockClear\|mockReset" "$file" || true)

  if [ "$has_cleanup" -eq 0 ] && [ "$has_file_scoped" -eq 0 ] && [ "$has_exception" -eq 0 ]; then
    if is_pr_file "$file" "$PR_CHANGED_FILES"; then
      echo "ERROR: $file uses mock.module but has no afterEach(mock.restore()) cleanup"
      echo "       Add afterEach(() => mock.restore()), or use file-scoped pattern"
      echo "       (mock.module at top + mockClear/mockReset in beforeEach),"
      echo "       or document why it's skipped"
      violations=$((violations + 1))
      new_violations=$((new_violations + 1))
    else
      echo "WARNING: $file uses mock.module but has no afterEach(mock.restore()) cleanup (pre-existing)"
      pre_existing_violations=$((pre_existing_violations + 1))
    fi
  fi
done < <(grep -rl "mock\.module(" tests/ src/ --include="*.test.ts" 2>/dev/null | grep -v "tests/unit/scripts/temp-test-files/" | grep -v "tests/unit/scripts/check-mock-cleanup.test.ts" || true)

# --- Check 2: mock.module('node:*', ...) must spread real exports (FR-001 SC-001.1) ---
# Enforces the spread-real-exports pattern for node: module mocks.
# Violation: mock.module('node:fs', () => ({...})) without ...realFs spread
# Allowed: mock.module('node:fs', () => ({ ...realFs, ... }))
# Allowed: mock.module('node:fs', async () => { const realFs = await import('node:fs'); return { ...realFs, ... } })
while IFS= read -r file; do
    # Get unique node: module names being mocked in this file
    mods=()
    while IFS= read -r line; do
        # Extract module name from both single and double quotes using a separate grep call
        mod="$(echo "$line" | grep -oE "mock\.module\(['\"]node:[^'\"]+['\"]" | head -1 | sed -E "s/mock\.module\(['\"]node://;s/['\"]\$//")"
        if [ -n "$mod" ]; then
            mods+=("$mod")
        fi
    done < <(grep -E "mock\.module\(['\"]node:" "$file" 2>/dev/null || true)
    # Remove duplicates and sort
    if [ ${#mods[@]} -gt 0 ]; then
        mods=($(printf "%s\n" "${mods[@]}" | sort -u))
    fi

    for mod in "${mods[@]}"; do
        # Convert snake_case to camelCase and handle subpaths.
        # First letter is uppercased; subsequent letters after _ or / are also uppercased.
        # Examples: fs -> Fs, child_process -> ChildProcess, fs/promises -> FsPromises
        camel_mod=""
        next_upper=1 # Capitalize first letter
        for (( i=0; i<${#mod}; i++ )); do
            char="${mod:$i:1}"
            if [ "$char" = "_" ] || [ "$char" = "/" ]; then
                # Skip the separator, mark next char for uppercase
                next_upper=1
            elif [ "$next_upper" = "1" ]; then
                camel_mod="${camel_mod}$(echo "$char" | tr '[:lower:]' '[:upper:]')"
                next_upper=0
            else
                camel_mod="${camel_mod}${char}"
            fi
        done
        spread_var="real${camel_mod}"

        # Check if the file has the spread pattern for this module with word boundary protection
        # NEW: Also check for spread in async import pattern: const realFs = await import(...); return { ...realFs, ... }
        if ! grep -qE "\.\.${spread_var}[^A-Za-z0-9_]" "$file" && ! grep -qE "\.\.${spread_var}$" "$file"; then
            # Check if the file has an async import of the real module
            if ! grep -qE "const\s+${spread_var}\s*=\s*await\s+import\(['\"]node:${mod}['\"]" "$file"; then
                # Find the line number of the first mock.module call for this module
                line_num=$(grep -nE "mock\.module\(['\"]node:${mod}['\"]" "$file" | head -1 | cut -d: -f1)
                if is_pr_file "$file" "$PR_CHANGED_FILES"; then
                    echo "ERROR: $file:$line_num uses mock.module('node:$mod', ...) without spreading real exports"
                    echo " Add ...${spread_var} to the returned object, e.g.:"
                    echo " mock.module('node:$mod', () => ({ ...${spread_var}, ... }))"
                    echo " or:"
                    echo " mock.module('node:$mod', async () => { const ${spread_var} = await import('node:$mod'); return { ...${spread_var}, ... } })"
                    violations=$((violations + 1))
                    new_violations=$((new_violations + 1))
                else
                    echo "WARNING: $file:$line_num uses mock.module('node:$mod', ...) without spreading real exports (pre-existing)"
                    pre_existing_violations=$((pre_existing_violations + 1))
                fi
            fi
        fi
    done
done < <(grep -rlE "mock\.module\(['\"]node:" tests/ src/ --include="*.test.ts" 2>/dev/null | grep -v "tests/unit/scripts/temp-test-files/" | grep -v "tests/unit/scripts/check-mock-cleanup.test.ts" || true)


if [ "$new_violations" -gt 0 ]; then
  echo ""
  echo "$new_violations NEW violation(s) introduced by this PR. See errors above."
  echo "$pre_existing_violations pre-existing violation(s) also found (non-blocking)."
  exit 1
fi

if [ "$pre_existing_violations" -gt 0 ]; then
  echo ""
  echo "$pre_existing_violations pre-existing violation(s) found (non-blocking)."
  echo "All test files with mock.module have proper cleanup and spread real exports."
  exit 0
fi

echo "All test files with mock.module have proper cleanup and spread real exports."
