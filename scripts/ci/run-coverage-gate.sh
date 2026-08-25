#!/usr/bin/env bash
set -euo pipefail

# Merge-queue coverage gate — SHARD RUNNER (issue #2341).
#
# ci.yml's `coverage-shard` matrix invokes this once per shard with
# SHARD_INDEX/SHARD_COUNT (both default 1, which selects the full gated set, so
# a local single-process run still approximates the coverage leg). It partitions
# the gated test list with the SAME round-robin formula as the unit job's
# "Collect and partition test files" step — `(NR - 1) % n == (s - 1)` — so
# coverage shard N measures exactly the file set of `unit (ubuntu-latest, N)`.
#
# Why sharded: the pre-#2341 gate ran the whole gated suite (~2700 files) in ONE
# serial per-file loop in ONE job (~45 min clean). The merge queue's
# check_response_timeout budget starts at ENQUEUE, not at check start, so queue
# wait + that serial unit evicted green PRs with `checks_timed_out` (PR #2313,
# 60.6 min). Threshold enforcement no longer happens here — the `coverage`
# merge job runs scripts/ci/finalize-coverage-gate.sh, which unions every shard
# part and enforces the threshold (issue #1778 H4 recalibration, default 65.00)
# exactly once, failing closed when any shard part is missing or empty.
#
# Outputs (all uniquely shard-named so the merge job's merge-multiple artifact
# extraction cannot collide):
#   coverage-part-${SHARD_INDEX}.info                    — concatenated per-file lcov
#   coverage-output-shard-${SHARD_INDEX}.txt             — full per-file bun output
#   flake-annotations-coverage-shard-${SHARD_INDEX}.txt  — advisory flake markers
#
# Concatenating per-file lcov records into one shard part is equivalent to the
# pre-#2341 per-file part files because scripts/ci/merge-lcov.mjs max-merges DA
# hit counts per (file, line) across everything it reads.

shard="${SHARD_INDEX:-1}"
shard_count="${SHARD_COUNT:-1}"
case "$shard" in
	'' | *[!0-9]*)
		echo "::error::SHARD_INDEX must be a positive integer, got '${shard}'"
		exit 1
		;;
esac
case "$shard_count" in
	'' | *[!0-9]*)
		echo "::error::SHARD_COUNT must be a positive integer, got '${shard_count}'"
		exit 1
		;;
esac
if [ "$shard" -lt 1 ] || [ "$shard" -gt "$shard_count" ]; then
	echo "::error::SHARD_INDEX ${shard} out of range 1..${shard_count}"
	exit 1
fi

part_file="coverage-part-${shard}.info"
output_file="coverage-output-shard-${shard}.txt"
# flake-annotations-coverage-shard-<N>.txt mirrors the UNIT job's per-run
# annotation file (ci.yml's `flake_ann=` assignment and the `>> "$flake_ann"`
# appends in the unit job) so the advisory flake-detection pipeline can see
# coverage-shard retries and hard failures too, not just unit shards. The
# integration job is deliberately NOT cited here: it retries in-job but emits
# its markers to the log only — it writes and uploads no annotation file.
# Written to a workspace-relative path so it survives past this script and is
# uploaded by the coverage-shard job `if: always()`.
flake_ann="flake-annotations-coverage-shard-${shard}.txt"
tmpdir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

# Built ONCE, before the discovery branch, so both paths share the identical
# ledger extraction (the pre-#2341 script built it twice — once per branch —
# which was harmless but let the two sites drift apart under future edits).
# Coverage shards run on ubuntu only, so only the general quarantine ledger
# applies (the macos/windows ledgers are per-RUNNER_OS additions in the unit
# job and never match on Linux) — the unit job's ubuntu cells compute their
# gated set identically.
{ grep -vE '^\s*#|^\s*$' scripts/ci/quarantined-tests.txt || true; } | sort > quarantined.txt
wc -l < quarantined.txt > quarantined-count.txt
read -r quarantined_count < quarantined-count.txt
echo "${quarantined_count} file(s) quarantined repo-wide, issue #1705"

if [ -z "${COVERAGE_TEST_LIST:-}" ]; then
	# Mirror the unit job's expanded glob (issue #1778 H4) so the coverage gate
	# measures the same set: src/** + tests/adversarial + the other orphan dirs,
	# EXCLUDING tests/integration, tests/security, tests/smoke, top-level test/
	# (owned by their own jobs). This find chain MUST stay identical to the unit
	# job's partition step in .github/workflows/ci.yml — pinned structurally by
	# tests/unit/scripts/ci/coverage-shard-graph.test.ts.
	{
		find src -name '*.test.ts' -type f
		find tests/unit tests/adversarial tests/architect tests/cli tests/tools tests/helpers -name '*.test.ts' -type f 2>/dev/null
		find tests -maxdepth 1 -name '*.test.ts' -type f 2>/dev/null
	} | sort -u > all-tests.txt
	comm -23 all-tests.txt quarantined.txt > gated-tests.txt
else
	sort "$COVERAGE_TEST_LIST" > gated-tests.txt
fi

# Same round-robin partition as the unit job, so a failing coverage shard maps
# 1:1 onto a unit shard's file set (issue #2341 preference).
awk -v s="$shard" -v n="$shard_count" '(NR - 1) % n == (s - 1)' gated-tests.txt > shard-tests.txt
if [ ! -s shard-tests.txt ]; then
	echo "::error::No test files found for coverage shard ${shard}/${shard_count}"
	exit 1
fi

: > "$output_file"
: > "$flake_ann"
: > "$part_file"
rm -rf coverage
mkdir -p coverage

failed=0
index=0
while IFS= read -r test_file; do
	[ -f "$test_file" ] || continue
	index=$((index + 1))
	echo "[coverage shard ${shard}] ${index}: ${test_file}"
	tmpout="$tmpdir/coverage-out-$$-$index.txt"
	exit_code=0
	# Bounded retry (max_retries=2, three attempts total), mirroring the unit
	# and integration jobs' in-job retry in ci.yml (both of that file's
	# `max_retries=2` loops — cited by construct, not line number, because
	# editing ci.yml shifts those numbers and stale citations here have
	# already had to be corrected twice).
	#
	# This shard is merge-queue-only, and nothing in the workflow depends on
	# the shard jobs beyond the `coverage` merge job, so shards run in parallel
	# with the unit matrix after quality rather than extending the merge-group
	# critical path beyond the queue deadline (issue #2341). With
	# `timeout-minutes: 30` per shard and the shard's files run per-file under
	# `--isolate --coverage`, a single transient flake still costs a requeue —
	# bounded retry keeps that cost rare without weakening per-file isolation.
	# The coverage dir is reset before EVERY attempt (not just once per file)
	# so a retried attempt's lcov output can never be contaminated by debris
	# from that same file's own failed prior attempt — the per-file isolation
	# invariant from issue #1712 (see the per-file isolation note in
	# docs/testing/test-stability.md) must hold across retries, not just
	# across files.
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
			echo "::notice file=${test_file}::Passed on retry ${retry_num} (flaky): ${test_file}" >> "$flake_ann"
		fi
	done
	{
		echo "### ${test_file}"
		cat "$tmpout"
		echo
	} >> "$output_file"
	if [ "$exit_code" -ne 0 ]; then
		echo "::group::Coverage output for ${test_file}"
		cat "$tmpout"
		echo "::endgroup::"
		echo "::error file=${test_file}::Coverage test failed: ${test_file}"
		echo "::error file=${test_file}::FAILED: ${test_file}" >> "$flake_ann"
		failed=1
	elif [ -f coverage/lcov.info ]; then
		cat coverage/lcov.info >> "$part_file"
	else
		echo "::warning file=${test_file}::No lcov.info produced for coverage test"
	fi
	rm -f "$tmpout"
done < shard-tests.txt

# Fail closed when the shard produced no lcov records at all: the merge job's
# part-count and DA-record checks would also catch it, but a red shard check
# run is the clearest signal to the PR author. `failed` (a failed test file)
# already covers the ordinary failure path.
if [ ! -s "$part_file" ]; then
	echo "::error::Coverage shard ${shard}/${shard_count} produced no lcov records (${index} file(s) attempted)"
	failed=1
fi

exit "$failed"
