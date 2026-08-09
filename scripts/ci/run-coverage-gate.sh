#!/usr/bin/env bash
set -euo pipefail

# Recalibrated for issue #1778 H4: the gate now measures the expanded set
# (src/** + tests/adversarial + orphans), which exercises far more source than
# the old tests/unit-only set. Measured 73.41% on the expanded set; floor set to
# 65.00 with ~8pt headroom for run-to-run variance. This is a STRONGER gate than
# the old tests/unit-only 41.48%, not a weakening.
threshold="${COVERAGE_THRESHOLD:-65.00}"
tmpdir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
parts_dir="$tmpdir/opencode-swarm-coverage-parts-$$"
all_tests="${COVERAGE_TEST_LIST:-all-tests.txt}"

rm -rf "$parts_dir" coverage
mkdir -p "$parts_dir" coverage
: > coverage-output.txt
rm -f coverage-value.txt
# flake-annotations-coverage.txt mirrors the UNIT job's per-run annotation
# file (ci.yml's `flake_ann=` assignment and the `>> "$flake_ann"` appends in
# the unit job) so the advisory flake-detection pipeline can see
# coverage-job retries and hard failures too, not just unit shards. The
# integration job is deliberately NOT cited here: it retries in-job but emits
# its markers to the log only — it writes and uploads no annotation file.
# Written to a workspace-relative path so it survives past this script and is
# uploaded by the coverage job `if: always()`.
: > flake-annotations-coverage.txt

if [ -z "${COVERAGE_TEST_LIST:-}" ]; then
	# Mirror the unit job's expanded glob (issue #1778 H4) so the coverage gate
	# measures the same set: src/** + tests/adversarial + the other orphan dirs,
	# EXCLUDING tests/integration, tests/security, tests/smoke, top-level test/
	# (owned by their own jobs).
	{
		find src -name '*.test.ts' -type f
		find tests/unit tests/adversarial tests/architect tests/cli tests/tools tests/helpers -name '*.test.ts' -type f 2>/dev/null
		find tests -maxdepth 1 -name '*.test.ts' -type f 2>/dev/null
	} | sort -u > all-tests.txt
	{ grep -vE '^\s*#|^\s*$' scripts/ci/quarantined-tests.txt || true; } | sort > quarantined.txt
	comm -23 all-tests.txt quarantined.txt > gated-tests.txt
	all_tests="gated-tests.txt"
else
	sort "$COVERAGE_TEST_LIST" > gated-tests.txt
	all_tests="gated-tests.txt"
fi

{ grep -vE '^\s*#|^\s*$' scripts/ci/quarantined-tests.txt || true; } | sort > quarantined.txt
wc -l < quarantined.txt > quarantined-count.txt
read -r quarantined_count < quarantined-count.txt
echo "${quarantined_count} file(s) quarantined repo-wide, issue #1705"

failed=0
index=0
while IFS= read -r test_file; do
	[ -f "$test_file" ] || continue
	index=$((index + 1))
	echo "[coverage] ${index}: ${test_file}"
	tmpout="$tmpdir/coverage-out-$$-$index.txt"
	exit_code=0
	# Bounded retry (max_retries=2, three attempts total), mirroring the unit
	# and integration jobs' in-job retry in ci.yml (both of that file's
	# `max_retries=2` loops — cited by construct, not line number, because
	# editing ci.yml shifts those numbers and stale citations here have
	# already had to be corrected twice).
	#
	# This job is merge-queue-only, and nothing in the workflow depends on it
	# (`needs: [detect-release, quality, unit]`, and no job lists `coverage`
	# in its own `needs`), so it is unordered against its peers rather than
	# "last" — but with `timeout-minutes: 60` and the whole suite run per-file
	# under `--isolate --coverage`, it is typically the long pole. Either way
	# the stake is the same: unlike a PR-branch unit shard, a single transient
	# flake here evicts the whole PR from the queue with no chance to
	# self-heal — a requeue costs a full ~30-60 min re-run.
	# The coverage dir is reset before EVERY attempt (not just once per file)
	# so a retried attempt's lcov output can never be contaminated by debris
	# from that same file's own failed prior attempt — the per-file isolation
	# invariant from issue #1712 (see the per-file isolation note in
	# docs/testing/test-stability.md)
	# must hold across retries, not just across files.
	max_retries=2
	retry_num=0
	rm -rf coverage
	mkdir -p coverage
	bun test --isolate --coverage --timeout 60000 "$test_file" > "$tmpout" 2>&1 || exit_code=$?
	while [ "$exit_code" -ne 0 ] && [ "$retry_num" -lt "$max_retries" ]; do
		retry_num=$((retry_num + 1))
		echo "::warning file=${test_file}::Attempt ${retry_num} failed, retrying (${retry_num}/${max_retries}): ${test_file}"
		exit_code=0
		rm -rf coverage
		mkdir -p coverage
		bun test --isolate --coverage --timeout 60000 "$test_file" > "$tmpout" 2>&1 || exit_code=$?
		if [ "$exit_code" -eq 0 ]; then
			echo "::notice file=${test_file}::Passed on retry ${retry_num} (flaky): ${test_file}"
			echo "::notice file=${test_file}::Passed on retry ${retry_num} (flaky): ${test_file}" >> flake-annotations-coverage.txt
		fi
	done
	{
		echo "### ${test_file}"
		cat "$tmpout"
		echo
	} >> coverage-output.txt
	if [ "$exit_code" -ne 0 ]; then
		echo "::group::Coverage output for ${test_file}"
		cat "$tmpout"
		echo "::endgroup::"
		echo "::error file=${test_file}::Coverage test failed: ${test_file}"
		echo "::error file=${test_file}::FAILED: ${test_file}" >> flake-annotations-coverage.txt
		failed=1
	elif [ -f coverage/lcov.info ]; then
		cp coverage/lcov.info "$parts_dir/part-$index.info"
	else
		echo "::warning file=${test_file}::No lcov.info produced for coverage test"
	fi
	rm -f "$tmpout"
done < "$all_tests"

mkdir -p coverage
if [ "$index" -eq 0 ]; then
	echo "::error::No coverage test files were found"
	echo "0" > coverage-value.txt
	: > coverage/lcov.info
	failed=1
elif ! ls "$parts_dir"/*.info > /dev/null 2>&1; then
	echo "::error::No lcov.info files were produced"
	echo "0" > coverage-value.txt
	: > coverage/lcov.info
	failed=1
else
	bun scripts/ci/merge-lcov.mjs "$parts_dir" coverage/lcov.info coverage-value.txt
fi

if [ ! -s coverage-value.txt ]; then
	echo "::warning::Could not parse coverage output"
	echo "0" > coverage-value.txt
fi
read -r coverage_value < coverage-value.txt || coverage_value="0"
echo "Coverage: ${coverage_value}% (threshold: ${threshold}%)"
if awk "BEGIN {exit !($coverage_value < $threshold)}"; then
	echo "::error::Coverage gate failed: ${coverage_value}% < ${threshold}%"
	failed=1
else
	echo "Coverage gate passed: ${coverage_value}% >= ${threshold}%"
fi

rm -rf "$parts_dir"
exit "$failed"
