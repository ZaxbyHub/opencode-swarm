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
	rm -rf coverage
	mkdir -p coverage
	tmpout="$tmpdir/coverage-out-$$-$index.txt"
	exit_code=0
	bun test --isolate --coverage --timeout 60000 "$test_file" > "$tmpout" 2>&1 || exit_code=$?
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
