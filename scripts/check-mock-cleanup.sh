#!/usr/bin/env bash
# Check that test files using mock.module have proper cleanup.
# Cross-module mock.module is permitted per two-tier convention,
# but must have afterEach(mock.restore()) or documented exception.
set -euo pipefail

violations=0

# Scan both tests/ and src/ for test files with mock.module
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
done < <(grep -rl "mock\.module(" tests/ src/ --include="*.test.ts" || true)

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "$violations file(s) missing mock.module cleanup. See errors above."
  echo "Cross-module mock.module is allowed per two-tier convention, but requires cleanup."
  exit 1
fi

echo "All test files with mock.module have proper cleanup."
