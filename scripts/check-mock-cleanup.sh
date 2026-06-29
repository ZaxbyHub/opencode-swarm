#!/usr/bin/env bash
# Check that test files using mock.module have proper cleanup.
# Cross-module mock.module is permitted per two-tier convention,
# but must have afterEach(mock.restore()) or documented exception.
set -euo pipefail

violations=0

# Scan both tests/ and src/ for test files with mock.module (excluding test infrastructure)
while IFS= read -r file; do
  # Check if file has afterEach with mock.restore
  has_cleanup=$(grep -c "mock\.restore" "$file" || true)
  # Check if file uses file-scoped mock pattern (mockClear/mockReset in beforeEach)
  has_file_scoped=$(grep -c "mockClear\|mockReset" "$file" || true)
  # Check if file has documented exception
  has_exception=$(grep -c "skip.*mock\.restore\|NOT.*mock\.restore\|no.*mock\.restore\|file-scoped\|mockClear\|mockReset" "$file" || true)

  if [ "$has_cleanup" -eq 0 ] && [ "$has_file_scoped" -eq 0 ] && [ "$has_exception" -eq 0 ]; then
    echo "ERROR: $file uses mock.module but has no afterEach(mock.restore()) cleanup"
    echo "       Add afterEach(() => mock.restore()), or use file-scoped pattern"
    echo "       (mock.module at top + mockClear/mockReset in beforeEach),"
    echo "       or document why it's skipped"
    violations=$((violations + 1))
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
                echo "ERROR: $file:$line_num uses mock.module('node:$mod', ...) without spreading real exports"
                echo " Add ...${spread_var} to the returned object, e.g.:"
                echo " mock.module('node:$mod', () => ({ ...${spread_var}, ... }))"
                echo " or:"
                echo " mock.module('node:$mod', async () => { const ${spread_var} = await import('node:$mod'); return { ...${spread_var}, ... } })"
                violations=$((violations + 1))
            fi
        fi
    done
done < <(grep -rlE "mock\.module\(['\"]node:" tests/ src/ --include="*.test.ts" 2>/dev/null | grep -v "tests/unit/scripts/temp-test-files/" | grep -v "tests/unit/scripts/check-mock-cleanup.test.ts" || true)


if [ "$violations" -gt 0 ]; then
  echo ""
  echo "$violations file(s) have mock.module issues. See errors above."
  exit 1
fi

echo "All test files with mock.module have proper cleanup and spread real exports."
