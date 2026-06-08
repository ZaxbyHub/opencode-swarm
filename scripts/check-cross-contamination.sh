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
coverage_warn=0
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

# ─── CHECK 1: Mock module list completeness ─────────────────────────────────
# Files in tests/unit/hooks/ that use mock.module() but are NOT in the CI
# isolation step list indicate incomplete migration coverage.
isolation_basenames=(
  "knowledge-injector.adversarial.test.ts"
  "knowledge-curator.test.ts"
  "knowledge-curator-evidence-curation.test.ts"
  "knowledge-curator-ttl.test.ts"
  "knowledge-curator.adversarial.test.ts"
  "knowledge-curator-output.test.ts"
  "full-auto-intercept.test.ts"
  "full-auto-intercept.adversarial.test.ts"
  "full-auto-intercept.dispatch.test.ts"
  "utils.test.ts"
  "knowledge-reader.test.ts"
  "system-enhancer-coder-context.test.ts"
  "model-limits-log-reclassification.test.ts"
  "model-limits-adversarial.test.ts"
  "log-level-reclassification.test.ts"
  "context-budget-log-reclassification.test.ts"
)

while IFS= read -r mock_file; do
  basename="${mock_file##*/}"
  found=0
  for iso in "${isolation_basenames[@]}"; do
    if [ "$basename" = "$iso" ]; then
      found=1
      break
    fi
  done
  if [ "$found" -eq 0 ]; then
    echo "::warning title=Mock module not in isolation list::$mock_file uses mock.module() but is not in the CI isolation step file list. Add it to ci.yml isolation step or refactor to use _internals DI seam."
    coverage_warn=1
  fi
done < <(grep -rl 'mock\.module(' tests/unit/hooks/ 2>/dev/null || true)

# ─── CHECK 2: Hook test file coverage ────────────────────────────────────────
# Every *.test.ts in tests/unit/hooks/ must be covered by a CI step glob or
# the isolation list. Unmatched files are advisory (::notice).

# Step globs (basename patterns that map to CI step coverage)
step_globs=(
  "adversarial-detect*"
  "advisory*"
  "agent-activity*"
  "co-change*"
  "compaction*"
  "context-budget*"
  "context-scoring*"
  "curator*"
  "curator-*"
  "dark-matter*"
  "delegation*"
  "delegation-*"
  "destructive-command*"
  "extractors*"
  "full-auto-*"
  "gate-tracking*"
  "guardrails*"
  "hive*"
  "hook-composition*"
  "interpreter-gating*"
  "knowledge-application*"
  "knowledge-contextual-retrieval*"
  "knowledge-curator*"
  "knowledge-curator-*"
  "knowledge-events*"
  "knowledge-injector*"
  "knowledge-migrator*"
  "knowledge-quarantine*"
  "knowledge-reader*"
  "knowledge-registration*"
  "knowledge-schema-v2*"
  "knowledge-store*"
  "knowledge-types*"
  "knowledge-validator*"
  "message*"
  "mode-detection*"
  "model-limits*"
  "phase-complete*"
  "phase-monitor*"
  "pipeline*"
  "plan-cursor*"
  "repo-graph*"
  "review-receipt*"
  "search-knowledge*"
  "self-coding*"
  "skill-*"
  "spec-drift*"
  "steering*"
  "system-enhancer*"
  "system-enhancer-budget*"
  "system-enhancer-lean*"
  "system-enhancer-load-evidence*"
  "system-enhancer-v*"
  "system-message*"
  "telemetry*"
  "tool-summarizer*"
  "trajectory*"
  "utils*"
  "write-lstat*"
)

matches_glob() {
  local file="$1"
  local basename="${file##*/}"
  for glob in "${step_globs[@]}"; do
    if [[ "$basename" == $glob ]]; then
      return 0
    fi
  done
  return 1
}

in_isolation_list() {
  local file="$1"
  local basename="${file##*/}"
  for iso in "${isolation_basenames[@]}"; do
    if [ "$basename" = "$iso" ]; then
      return 0
    fi
  done
  return 1
}

while IFS= read -r test_file; do
  if matches_glob "$test_file" || in_isolation_list "$test_file"; then
    continue
  fi
  echo "::notice title=Hook test file not in CI coverage::$test_file is not covered by any named CI step glob or the isolation list. Consider adding it to an appropriate CI step or the isolation list."
  coverage_warn=1
done < <(find tests/unit/hooks/ -maxdepth 1 -name '*.test.ts' -type f 2>/dev/null || true)

if [ "$coverage_warn" -gt 0 ]; then
  echo ""
  echo "Audit checks completed with warnings (non-blocking)."
fi

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
