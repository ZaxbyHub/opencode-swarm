#!/usr/bin/env bash
set -euo pipefail

# Recalibrated for issue #1778 H4: the gate now measures the expanded set
# (src/** + tests/adversarial + orphans), which exercises far more source than
# the old tests/unit-only set. Measured 73.41% on the expanded set; floor set to
# 65.00 with ~8pt headroom for run-to-run variance. This is a STRONGER gate than
# the old tests/unit-only 41.48%, not a weakening.
threshold="${COVERAGE_THRESHOLD:-65.00}"
# Issue #2341: the merge queue's check_response_timeout budget starts at
# ENQUEUE, and this script's single serial per-file loop (~48 min for the full
# gated set) consumed nearly all of it. CI therefore runs this script as the
# coverage-shard matrix: set both COVERAGE_SHARD_INDEX and COVERAGE_SHARD_COUNT
# to measure only this shard's partition (the SAME round-robin as the unit
# job's "Collect and partition test files" step) and merge it into a single
# coverage/lcov.info for upload. In shard mode the threshold is NOT enforced
# here — a shard's local percentage is meaningless in isolation — the dependent
# `coverage` aggregator job enforces it once over the merged union of all
# shards' reports, failing closed if any shard report is missing. Unsharded
# invocations behave exactly as before (full set + inline threshold).
shard_index="${COVERAGE_SHARD_INDEX:-}"
shard_count="${COVERAGE_SHARD_COUNT:-}"
sharded=0
if [ -n "$shard_index" ] || [ -n "$shard_count" ]; then
	if [ -z "$shard_index" ] || [ -z "$shard_count" ]; then
		echo "::error::COVERAGE_SHARD_INDEX and COVERAGE_SHARD_COUNT must be set together"
		exit 2
	fi
	case "$shard_index" in
		*[!0-9]*)
			echo "::error::COVERAGE_SHARD_INDEX must be a positive integer (got '${shard_index}')"
			exit 2
			;;
	esac
	case "$shard_count" in
		*[!0-9]*)
			echo "::error::COVERAGE_SHARD_COUNT must be a positive integer (got '${shard_count}')"
			exit 2
			;;
	esac
	if [ "$shard_index" -lt 1 ] || [ "$shard_index" -gt "$shard_count" ]; then
		echo "::error::COVERAGE_SHARD_INDEX must be between 1 and COVERAGE_SHARD_COUNT (got ${shard_index}/${shard_count})"
		exit 2
	fi
	sharded=1
fi
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
# In shard mode the filename carries the shard index: flake-detection.yml
# downloads every flake-annotations-* artifact with merge-multiple: true, so
# same-named files from different shards would collide on extraction.
flake_ann="flake-annotations-coverage.txt"
if [ "$sharded" -eq 1 ]; then
	flake_ann="flake-annotations-coverage-shard-${shard_index}.txt"
fi
: > "$flake_ann"

if [ -z "${COVERAGE_TEST_LIST:-}" ]; then
	# Mirror the unit job's expanded glob (issue #1778 H4) so the coverage gate
	# measures the same set: src/** + tests/adversarial + the other orphan dirs,
	# EXCLUDING tests/integration, tests/security, tests/smoke, top-level test/
	# (owned by their own jobs).
	{
		find src -name '*.test.ts' -type f
		# '|| true': a branch may legitimately empty one of these trees (git
		# drops the directory, e.g. tests/cli after #2420/#2421) and the find
		# failure is silent under set -e with stderr already suppressed.
		find tests/unit tests/adversarial tests/architect tests/cli tests/tools tests/helpers -name '*.test.ts' -type f 2>/dev/null || true
		find tests -maxdepth 1 -name '*.test.ts' -type f 2>/dev/null || true
	} | sort -u > all-tests.txt
	{ grep -vE '^\s*#|^\s*$' scripts/ci/quarantined-tests.txt || true; } | sort > quarantined.txt
	comm -23 all-tests.txt quarantined.txt > gated-tests.txt
	all_tests="gated-tests.txt"
else
	sort "$COVERAGE_TEST_LIST" > gated-tests.txt
	all_tests="gated-tests.txt"
fi

if [ "$sharded" -eq 1 ]; then
	# Same round-robin over the same sorted gated set as the unit job's
	# "Collect and partition test files" step, so coverage shard N measures
	# exactly the files of unit (ubuntu-latest, N) and a failing file maps
	# back to one debuggable shard pair. This script intentionally applies
	# ONLY the base quarantined-tests.txt — it must never branch on the
	# runner OS or consult a per-OS quarantine file — because coverage
	# shards run ubuntu-only; an OS branch here would silently diverge the
	# partition from the ubuntu unit cells (pinned by
	# tests/unit/scripts/ci/ci-coverage-sharding.test.ts).
	awk -v s="$shard_index" -v n="$shard_count" '(NR - 1) % n == (s - 1)' gated-tests.txt > shard-tests.txt
	if [ ! -s shard-tests.txt ]; then
		echo "::error::No test files found for coverage shard ${shard_index}/${shard_count}"
		exit 1
	fi
	mv shard-tests.txt gated-tests.txt
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
	# This shard is merge-queue-only, and the only workflow dependency on it
	# is the trivial `coverage` aggregator (which consumes the lcov artifact);
	# nothing serializes it behind the unit matrix (CI-004, issue #2341), so
	# it runs in parallel with the unit matrix after quality rather than
	# extending the merge-group critical path beyond the queue deadline.
	# With the shard matrix's `timeout-minutes: 30` and the whole partition
	# run per-file under `--isolate --coverage`, each shard is typically
	# ~12 min. Either way
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
	coverage_ready=0
	while true; do
		rm -rf coverage
		mkdir -p coverage
		exit_code=0
		bun test --isolate --coverage --timeout 60000 "$test_file" > "$tmpout" 2>&1 || exit_code=$?
		coverage_ready=0
		if [ "$exit_code" -eq 0 ]; then
			# Bun can flush lcov.info just after the test process exits. Wait a
			# bounded 5 seconds for that asynchronous write before treating a
			# passing test as a missing-coverage failure (CI coverage race).
			lcov_wait=0
			while [ "$lcov_wait" -lt 20 ] && [ ! -s coverage/lcov.info ]; do
				sleep 0.25
				lcov_wait=$((lcov_wait + 1))
			done
			if [ -s coverage/lcov.info ]; then
				coverage_ready=1
			fi
		fi
		if [ "$exit_code" -eq 0 ] && [ "$coverage_ready" -eq 1 ]; then
			if [ "$retry_num" -gt 0 ]; then
				echo "::notice file=${test_file}::Passed on retry ${retry_num} (flaky): ${test_file}"
				echo "::notice file=${test_file}::Passed on retry ${retry_num} (flaky): ${test_file}" >> "$flake_ann"
			fi
			break
		fi
		if [ "$retry_num" -ge "$max_retries" ]; then
			break
		fi
		retry_num=$((retry_num + 1))
		if [ "$exit_code" -ne 0 ]; then
			echo "::warning file=${test_file}::Attempt ${retry_num} failed, retrying (${retry_num}/${max_retries}): ${test_file}"
		else
			echo "::warning file=${test_file}::Attempt ${retry_num} produced no non-empty lcov.info, retrying (${retry_num}/${max_retries}): ${test_file}"
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
		echo "::error file=${test_file}::FAILED: ${test_file}" >> "$flake_ann"
		failed=1
	elif [ "$coverage_ready" -eq 1 ]; then
		cp coverage/lcov.info "$parts_dir/part-$index.info"
	else
		echo "::error file=${test_file}::No non-empty lcov.info produced for coverage test: ${test_file}"
		failed=1
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
if [ "$sharded" -eq 1 ]; then
	# Shard-local percentage is informational only. The threshold is enforced
	# ONCE by the coverage aggregator job over the merged union of all shards'
	# lcov reports (issue #2341) — enforcing it per shard would be wrong (a
	# shard's file mix skews its ratio) and un-fixable from here (a missing
	# sibling shard must fail closed in the aggregator, not silently shrink
	# the measured set).
	echo "Shard ${shard_index}/${shard_count} local coverage: ${coverage_value}% (informational; threshold ${threshold}% is enforced by the aggregator over the merged union — issue #2341)"
else
	echo "Coverage: ${coverage_value}% (threshold: ${threshold}%)"
	if awk "BEGIN {exit !($coverage_value < $threshold)}"; then
		echo "::error::Coverage gate failed: ${coverage_value}% < ${threshold}%"
		failed=1
	else
		echo "Coverage gate passed: ${coverage_value}% >= ${threshold}%"
	fi
fi

rm -rf "$parts_dir"
exit "$failed"
