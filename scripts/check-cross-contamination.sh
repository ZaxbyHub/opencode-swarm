#!/usr/bin/env bash
# Check for mock.module / vi.mock REGRESSIONS by running known-problematic
# test file pairs together in the same Bun process. Bun's shared test runner can
# leak vi.mock('node:fs') and vi.mock('node:child_process') across files, causing
# false test failures that don't appear when tests run individually.
#
# KNOWN pre-existing leaks are tracked with an additional "known_expected" field.
# A regression occurs when the pass count drops below the known_expected value.
# This lets us track known issues without blocking CI, while catching new leaks.
set -euo pipefail

# Format: file_a|file_b|individual_pass_a|individual_pass_b|known_expected_co_run
# known_expected_co_run is the current actual pass count when co-run.
# When the _internals DI seam migration fixes the leak, update this value to match
# the expected sum. When it reaches the sum, remove the entry entirely.
PAIRS=(
  "tests/unit/diff/ast-diff.test.ts|src/hooks/__tests__/semantic-diff-injection.test.ts|41|16|33"
)

regression=0
known=0
tmpdir="${RUNNER_TEMP:-${TEMP:-/tmp}}"

for pair in "${PAIRS[@]}"; do
  IFS='|' read -r file_a file_b expected_a expected_b known_expected <<< "$pair"
  expected=$((expected_a + expected_b))

  tmp="$tmpdir/cross-contam-$$-${file_a##*/}-${file_b##*/}"
  exit_code=0
  bun --smol test "$file_a" "$file_b" --timeout 120000 > "$tmp" 2>&1 || exit_code=$?

  if [ $exit_code -ne 0 ]; then
    actual=$(grep -oP '^\s*\d+ pass' "$tmp" | grep -oP '\d+' || echo "0")

    if [ "$actual" -lt "$known_expected" ]; then
      # Pass count dropped below the known baseline — this is a NEW regression
      echo "::error title=Cross-contamination regression::Co-run of $file_a + $file_b: expected ${expected} pass (${expected_a}+${expected_b}), got ${actual} pass. Previously known baseline was ${known_expected}. A new mock.module or vi.mock() leak was introduced."
      echo ""
      echo "Test pair: $file_a + $file_b"
      echo "Expected passes (individual): ${expected}"
      echo "Known baseline (previous co-run): ${known_expected}"
      echo "Actual passes (co-run): ${actual}"
      echo ""
      echo "Tail of output:"
      tail -20 "$tmp"
      regression=1
    elif [ "$actual" -lt "$expected" ]; then
      # Below individual sum but at or above known baseline — known pre-existing issue
      echo "::warning title=Cross-contamination known issue::Co-run of $file_a + $file_b: expected ${expected} pass, got ${actual} pass (known baseline: ${known_expected}). Pre-existing vi.mock() leak — tracked in scripts/check-cross-contamination.sh."
      known=1
    else
      # actual >= expected but exit_code != 0 — unexpected failure
      echo "::error title=Cross-contamination regression::Co-run of $file_a + $file_b exited with code ${exit_code} despite ${actual} >= ${expected} expected passes. Unexpected test failure or process error introduced."
      echo ""
      echo "Tail of output:"
      tail -20 "$tmp"
      regression=1
    fi
  fi
  rm -f "$tmp"
done

if [ "$regression" -gt 0 ]; then
  echo ""
  echo "Cross-contamination REGRESSION detected. New mock leaks were introduced."
  echo "These test files must be refactored before merging."
  exit 1
fi

if [ "$known" -gt 0 ]; then
  echo ""
  echo "Known pre-existing cross-contamination present (non-blocking)."
  echo "Expected passes when fixed: update known_expected in this script."
  exit 0
fi

echo "No cross-contamination detected: all test pairs pass when co-run."
