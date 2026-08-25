#!/usr/bin/env bash
set -euo pipefail

# Merge-queue coverage gate — FINALIZE + THRESHOLD ENFORCEMENT (issue #2341).
#
# Runs in the `coverage` merge job after the `coverage-shard` matrix. Fails
# closed, strictly in this order, so no path can silently weaken the gate
# (issue #2341 acceptance: "no path where a missing shard report weakens it"):
#
#   1. SHARD_JOB_RESULT must be 'success'. The matrix job's aggregate result is
#      'failure' when ANY shard cell fails and 'skipped'/'cancelled' otherwise
#      fail — this check runs FIRST because a failed shard can still upload a
#      partial part, and a part-count check alone must never let that pass.
#   2. Exactly EXPECTED_SHARDS part files must exist in the parts dir.
#   3. Every part must be non-empty AND contain at least one DA: record (a
#      header-only part would silently measure nothing for that shard).
#   4. merge-lcov.mjs max-merges all parts into coverage/lcov.info and writes
#      the line-coverage percentage to coverage-value.txt. Max-merge is
#      associative, so merging the shards' concatenated parts computes the
#      same value the pre-#2341 per-file-part merge did.
#   5. The value must be >= COVERAGE_THRESHOLD (default 65.00 — unchanged from
#      the pre-sharding gate; recalibrated for issue #1778 H4 on the expanded
#      test set with ~8pt headroom for run-to-run variance. The 41.48% figure
#      still present in some older release fragments describes the pre-#1778
#      tests/unit-only era).
#
# The order of checks 1-3 is pinned by
# tests/unit/scripts/ci/coverage-shard-graph.test.ts; the behavior matrix is
# pinned by tests/unit/scripts/ci/finalize-coverage-gate.test.ts.

shard_result="${SHARD_JOB_RESULT:-}"
expected="${EXPECTED_SHARDS:-6}"
parts_dir="${COVERAGE_PARTS_DIR:-coverage-parts}"
case "$expected" in
	'' | *[!0-9]*)
		echo "::error::EXPECTED_SHARDS must be a positive integer, got '${expected}'"
		exit 1
		;;
esac

# 1. Shard job result.
if [ "$shard_result" != "success" ]; then
	echo "::error::coverage-shard job result was '${shard_result}', not 'success'"
	exit 1
fi

# 2. Part count: a dropped or never-uploaded shard part must fail the gate
#    rather than silently shrink the measured set.
part_count=0
for f in "$parts_dir"/coverage-part-*.info; do
	[ -f "$f" ] || continue
	part_count=$((part_count + 1))
done
if [ "$part_count" -ne "$expected" ]; then
	echo "::error::Expected ${expected} coverage shard parts in ${parts_dir}, found ${part_count}"
	ls -la "$parts_dir" 2>/dev/null || true
	exit 1
fi

# 3. Part integrity: non-empty and at least one DA: record each.
for f in "$parts_dir"/coverage-part-*.info; do
	if [ ! -s "$f" ]; then
		echo "::error::Coverage shard part ${f} is empty"
		exit 1
	fi
	if ! grep -q '^DA:' "$f"; then
		echo "::error::Coverage shard part ${f} contains no DA: records"
		exit 1
	fi
done

# 4. Merge. merge-lcov.mjs imports only node:* builtins and runs from source,
#    but bun itself is not preinstalled on GitHub runners — the merge job keeps
#    its setup-bun step. Anchor the script to this file's repo so the finalize
#    step works from any cwd (the functional tests run it from a temp dir).
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
mkdir -p coverage
bun "$repo_root/scripts/ci/merge-lcov.mjs" "$parts_dir" coverage/lcov.info coverage-value.txt

if [ ! -s coverage-value.txt ]; then
	echo "::error::Could not parse coverage output (coverage-value.txt missing or empty)"
	echo "0" > coverage-value.txt
	exit 1
fi
read -r coverage_value < coverage-value.txt || coverage_value="0"
threshold="${COVERAGE_THRESHOLD:-65.00}"
echo "Coverage: ${coverage_value}% (threshold: ${threshold}%)"
if awk "BEGIN {exit !($coverage_value < $threshold)}"; then
	echo "::error::Coverage gate failed: ${coverage_value}% < ${threshold}%"
	exit 1
fi
echo "Coverage gate passed: ${coverage_value}% >= ${threshold}%"
