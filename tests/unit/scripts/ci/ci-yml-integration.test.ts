import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CI_YML_PATH = join(
	import.meta.dir,
	'../../../../.github/workflows/ci.yml',
);
const COVERAGE_GATE_SCRIPT_PATH = join(
	import.meta.dir,
	'../../../../scripts/ci/run-coverage-gate.sh',
);
const FLAKE_DETECTION_YML_PATH = join(
	import.meta.dir,
	'../../../../.github/workflows/flake-detection.yml',
);
const REPO_ROOT = join(import.meta.dir, '../../../..');
const REQUIRED_RECURSIVE_INTEGRATION_TESTS = [
	'tests/integration/lang/prompt-injection.test.ts',
	'tests/integration/lang/tool-profiles.test.ts',
] as const;

/*
 * Every extractor below ends its lazy match on the same four-alternative
 * lookahead: the next step, a section comment, the next JOB (two-space key),
 * or end of input spelled `(?![\s\S])`.
 *
 * Do NOT "simplify" that last alternative to `$`. These regexes carry the `/m`
 * flag, under which `$` matches at every line end — the lookahead would
 * succeed immediately and collapse each slice to its `- name:` line alone
 * (measured: 3803 chars -> 22). Assertions would still pass, but the negative
 * one below (`not.toContain('bun --smol test "$f"')`) would pass vacuously,
 * which is exactly the guard it exists to provide.
 *
 * The job-boundary alternative matters too: without it the coverage-upload
 * slice ran past the end of its own job into the integration job's steps
 * (measured: 1067 chars -> 547 once bounded).
 */
function extractRunUnitTestsStep(yml: string): string {
	// Normalize CRLF to LF so regex anchors work consistently
	const normalized = yml.replace(/\r\n/g, '\n');
	// The "Run unit tests" step starts at 6-space indentation under the jobs.*.steps key.
	// Its content ends before the next step (also at 6-space indent) or section comment.
	const match = normalized.match(
		/- name: Run unit tests[\s\S]*?(?=\n {6}- name:|\n {6}# ---|\n {2}[A-Za-z][\w-]*:|(?![\s\S]))/m,
	);
	return match ? match[0] : '';
}

function extractCollectAndPartitionStep(yml: string): string {
	const normalized = yml.replace(/\r\n/g, '\n');
	const match = normalized.match(
		/- name: Collect and partition test files[\s\S]*?(?=\n {6}- name:|\n {6}# ---|\n {2}[A-Za-z][\w-]*:|(?![\s\S]))/m,
	);
	return match ? match[0] : '';
}

function extractCoverageMeasurementStep(yml: string): string {
	const normalized = yml.replace(/\r\n/g, '\n');
	const match = normalized.match(
		/- name: Coverage gate enforcement[\s\S]*?(?=\n {6}- name:|\n {6}# ---|\n {2}[A-Za-z][\w-]*:|(?![\s\S]))/m,
	);
	return match ? match[0] : '';
}

function extractIntegrationTestsStep(yml: string): string {
	const normalized = yml.replace(/\r\n/g, '\n');
	const match = normalized.match(
		/- name: Integration tests[\s\S]*?(?=\n {6}- name:|\n {6}# ---|\n {2}[A-Za-z][\w-]*:|(?![\s\S]))/m,
	);
	return match ? match[0] : '';
}

function extractIntegrationFindCommand(step: string): string {
	const matches = step.match(/^\s*find (?:tests\/integration|test) [^\n]*$/gm);
	return matches ? matches.map((line) => line.trim()).join('\n') : '';
}

function extractUnitFlakeAnnotationsUploadStep(yml: string): string {
	const normalized = yml.replace(/\r\n/g, '\n');
	const match = normalized.match(
		/- name: Upload flake annotations[\s\S]*?(?=\n {6}- name:|\n {6}# ---|\n {2}[A-Za-z][\w-]*:|(?![\s\S]))/m,
	);
	return match ? match[0] : '';
}

function extractCoverageFlakeAnnotationsUploadStep(yml: string): string {
	const normalized = yml.replace(/\r\n/g, '\n');
	const match = normalized.match(
		/- name: Upload coverage flake annotations[\s\S]*?(?=\n {6}- name:|\n {6}# ---|\n {2}[A-Za-z][\w-]*:|(?![\s\S]))/m,
	);
	return match ? match[0] : '';
}

describe('ci.yml integration — shared repository-validation authority', () => {
	const yml = readFileSync(CI_YML_PATH, 'utf8');
	const step = extractRunUnitTestsStep(yml);
	const collectStep = extractCollectAndPartitionStep(yml);

	test('"Run unit tests" step calls the shared authority', () => {
		expect(step).toContain('bun scripts/ci/repository-validation.ts');
	});

	test('"Run unit tests" step includes the 180000 ms kill timeout', () => {
		expect(step).toContain('--kill-timeout 180000');
		expect(step.match(/--kill-timeout 180000/g)?.length).toBe(2);
	});

	test('"Run unit tests" step verifies bounded JSON reports', () => {
		expect(step).toContain(
			'bun scripts/ci/verify-repository-validation-reports.ts',
		);
		expect(step).not.toContain('grep -qE');
	});

	test('"Run unit tests" prints bounded failure reports and preserves issue receipts', () => {
		expect(step).toMatch(
			/if \[ \$exit_code -ne 0 \]; then[\s\S]*?cat "\$report_path"[\s\S]*?else[\s\S]*?cat "\$tmp"\s+fi/,
		);
		expect(step).not.toMatch(/grep -E "\^\\\[(?:TIMING|TIMEOUT|ISSUE-)/);
	});

	test('"Run unit tests" step preserves shard file list mechanism', () => {
		expect(step).toContain('shard-tests.txt');
	});

	test('"Run unit tests" binds its matrix shard before constructing report paths (#2701)', () => {
		expect(step).toMatch(/\n\s+env:\s*\n\s+SHARD: \$\{\{ matrix\.shard \}\}/);
		expect(step).toContain('if [ -z "$SHARD" ]; then');
		expect(step).toContain('unit-shard-${SHARD}-${item_index}.json');
		expect(step).toContain('--file-prefix "unit-shard-${SHARD}-"');
	});

	test('unit discovery publishes an independent canonical inventory and shard manifest', () => {
		expect(collectStep).toContain("git ls-files -z -- '*.test.ts'");
		expect(collectStep).toContain('canonical-all-tests.txt');
		expect(collectStep).toContain('cmp -s');
		expect(collectStep).toContain('unit-inventory.txt');
		expect(collectStep).toContain('unit-shard-${SHARD}-expected-files.txt');
	});

	test('canonical test inventory uses a BSD/GNU-portable top-level test filter', () => {
		// Keep the tracked inventory's top-level filter portable across BSD/GNU
		// find/awk implementations by using a shell glob for the filesystem side.
		expect(collectStep).toContain('for f in tests/*.test.ts; do');
		expect(collectStep).not.toContain('find tests -maxdepth 1');
		// BSD awk treats the slash inside an unescaped character class as the
		// end of the regexp literal. Keep the slash escaped without changing
		// the top-level-only ([^/]+) filter semantics.
		expect(collectStep).toContain('/^tests\\/[^\\/]+\\.test\\.ts$/');
		expect(collectStep).not.toContain('/^tests\\/[^/]+\\.test\\.ts$/');
	});

	test('unit discovery creates the validation directory before copying manifests', () => {
		const swarmPreflight =
			'if [ -L .swarm ] || { [ -e .swarm ] && [ ! -d .swarm ]; }; then';
		const mkdirIndex = collectStep.indexOf(
			'mkdir -p .swarm/repository-validation',
		);
		const preflightIndex = collectStep.indexOf(swarmPreflight);
		const inventoryCopyIndex = collectStep.indexOf(
			'write_manifest_atomically "$tmpdir/gated-tests.txt" "$unit_inventory_path" || exit 1',
		);
		expect(preflightIndex).toBeGreaterThanOrEqual(0);
		expect(preflightIndex).toBeLessThan(mkdirIndex);
		expect(mkdirIndex).toBeGreaterThanOrEqual(0);
		expect(inventoryCopyIndex).toBeGreaterThan(mkdirIndex);
	});

	test('manifest writes reject unsafe destinations and atomically replace files (RV-B-002)', () => {
		// Before this guard, cp followed a pre-existing symlink and could overwrite
		// outside .swarm; the atomic same-directory replacement closes the guard/cp
		// race while also avoiding writes through a hardlink or special file.
		expect(collectStep).toContain('check_manifest_target()');
		expect(collectStep).toContain('if [ -L "$target" ]; then');
		expect(collectStep).toContain(
			'if [ -e "$target" ] && [ ! -f "$target" ]; then',
		);
		expect(collectStep).toContain('find "$target" -type f -links +1 -print');
		expect(collectStep).toContain(
			'Could not inspect manifest target link count',
		);
		expect(collectStep).toContain('write_manifest_atomically()');
		expect(collectStep).toContain('mktemp "${target}.tmp.XXXXXX"');
		expect(collectStep).toContain('mv -f "$temp_path" "$target"');

		const inventoryGuardIndex = collectStep.indexOf(
			'check_manifest_target "$unit_inventory_path" || exit 1',
		);
		const inventoryCopyIndex = collectStep.indexOf(
			'write_manifest_atomically "$tmpdir/gated-tests.txt" "$unit_inventory_path" || exit 1',
		);
		const shardGuardIndex = collectStep.indexOf(
			'check_manifest_target "$unit_shard_manifest_path" || exit 1',
		);
		const shardCopyIndex = collectStep.indexOf(
			'write_manifest_atomically "$tmpdir/shard-tests.txt" "$unit_shard_manifest_path" || exit 1',
		);
		expect(inventoryGuardIndex).toBeGreaterThan(-1);
		expect(inventoryGuardIndex).toBeLessThan(inventoryCopyIndex);
		expect(shardGuardIndex).toBeGreaterThan(-1);
		expect(shardGuardIndex).toBeLessThan(shardCopyIndex);
	});

	test('all workflow .swarm writers preflight symlink and non-directory paths', () => {
		const swarmPreflight =
			'if [ -L .swarm ] || { [ -e .swarm ] && [ ! -d .swarm ]; }; then';
		const validationPreflight =
			'if [ -L .swarm/repository-validation ] || { [ -e .swarm/repository-validation ] && [ ! -d .swarm/repository-validation ]; }; then';
		const writerCount = (
			yml.match(/mkdir -p \.swarm\/repository-validation/g) ?? []
		).length;
		const preflightCount = (
			yml.match(
				new RegExp(swarmPreflight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
			) ?? []
		).length;
		const validationPreflightCount = (
			yml.match(
				new RegExp(
					validationPreflight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
					'g',
				),
			) ?? []
		).length;
		expect(writerCount).toBe(3);
		expect(preflightCount).toBe(writerCount);
		expect(validationPreflightCount).toBe(writerCount);
		expect(yml).toContain(
			'symlinks, junctions, and non-directories are rejected',
		);
	});

	test('unit-passed verifies reports on a fresh checkout and rejects partial macOS/Windows artifacts', () => {
		const unitPassed =
			yml.match(
				/\n {2}unit-passed:[\s\S]*?(?=\n {2}[A-Za-z][\w-]*:|$(?![\s\S]))/m,
			)?.[0] ?? '';
		expect(unitPassed).toContain('actions/checkout@');
		expect(unitPassed).toContain('oven-sh/setup-bun@');
		expect(unitPassed).toContain('bun-version: "1.3.13"');
		expect(unitPassed).toContain('bun install --frozen-lockfile');
		expect(unitPassed).toContain('--inventory-file unit-inventory.txt');
		expect(unitPassed).toMatch(/timeout-minutes:\s*\d+/);
		expect(unitPassed).toContain(
			'Install dependencies for the report verifier',
		);
		expect(unitPassed).not.toContain('needs.detect-');
		expect(unitPassed).toMatch(
			/elif \[ -d unit-reports\/repository-validation-unit-macos-latest-1 \] \|\| \[ -d unit-reports\/repository-validation-unit-windows-latest-1 \][\s\S]*?if \[ ! -d unit-reports\/repository-validation-unit-macos-latest-1 \] \|\| \[ ! -d unit-reports\/repository-validation-unit-windows-latest-1 \][\s\S]*?exit 1/,
		);
	});

	test('"Run unit tests" step tolerates empty quarantine files', () => {
		expect(collectStep).toContain(
			'grep -vE \'^\\s*#|^\\s*$\' scripts/ci/quarantined-tests.txt > "$tmpdir/quarantined-raw.txt" || true',
		);
		expect(collectStep).toContain(
			'grep -vE \'^\\s*#|^\\s*$\' scripts/ci/quarantined-tests-macos.txt >> "$tmpdir/quarantined-raw.txt" || true',
		);
		expect(collectStep).toContain(
			'grep -vE \'^\\s*#|^\\s*$\' scripts/ci/quarantined-tests-windows.txt >> "$tmpdir/quarantined-raw.txt" || true',
		);
	});

	test('"Run unit tests" step does NOT contain raw bun --smol test "$f" invocation', () => {
		// The old raw pattern was: bun --smol test "$f" --timeout 120000
		expect(step).not.toContain('bun --smol test "$f"');
	});
});

describe('ci.yml parser helpers — CRLF normalization', () => {
	const yml = readFileSync(CI_YML_PATH, 'utf8').replace(/\r\n/g, '\n');
	const crlfYml = yml.replace(/\n/g, '\r\n');

	test('all YAML extractors produce the same slices for LF and CRLF input', () => {
		expect(extractRunUnitTestsStep(crlfYml)).toBe(extractRunUnitTestsStep(yml));
		expect(extractCollectAndPartitionStep(crlfYml)).toBe(
			extractCollectAndPartitionStep(yml),
		);
		expect(extractCoverageMeasurementStep(crlfYml)).toBe(
			extractCoverageMeasurementStep(yml),
		);
		expect(extractIntegrationTestsStep(crlfYml)).toBe(
			extractIntegrationTestsStep(yml),
		);
		expect(extractUnitFlakeAnnotationsUploadStep(crlfYml)).toBe(
			extractUnitFlakeAnnotationsUploadStep(yml),
		);
		expect(extractCoverageFlakeAnnotationsUploadStep(crlfYml)).toBe(
			extractCoverageFlakeAnnotationsUploadStep(yml),
		);
		expect(
			extractIntegrationFindCommand(extractIntegrationTestsStep(crlfYml)),
		).toBe(extractIntegrationFindCommand(extractIntegrationTestsStep(yml)));
	});
});

describe('ci.yml integration — integration quarantine extraction', () => {
	const yml = readFileSync(CI_YML_PATH, 'utf8');
	const step = extractIntegrationTestsStep(yml);
	const findCommand = extractIntegrationFindCommand(step);

	test('"Integration tests" step uses the shared CLI kill-timeout units', () => {
		expect(step.match(/--kill-timeout 180000/g)?.length).toBe(2);
	});

	test('"Integration tests" step tolerates empty quarantine files', () => {
		expect(step).toContain(
			'grep -vE \'^\\s*#|^\\s*$\' scripts/ci/quarantined-integration-tests.txt | sort > "$tmpdir/int-quarantined.txt" || true',
		);
	});

	test('"Integration tests" prints bounded failure reports and preserves issue receipts', () => {
		expect(step).toMatch(
			/if \[ \$exit_code -ne 0 \]; then[\s\S]*?cat "\$report_path"[\s\S]*?else[\s\S]*?cat "\$tmp"\s+fi/,
		);
		expect(step).not.toMatch(/grep -E "\^\\\[(?:TIMING|TIMEOUT|ISSUE-)/);
	});
});

describe('ci.yml integration — recursive corpus discovery (issue #2552)', () => {
	const yml = readFileSync(CI_YML_PATH, 'utf8');
	const step = extractIntegrationTestsStep(yml);
	const findCommand = extractIntegrationFindCommand(step);

	test('the real integration step discovers both nested security-sensitive fixtures', () => {
		// These exact basenames live below tests/integration/lang/. Pinning their
		// paths against the actual find command catches a regression where a
		// shallow discovery change silently leaves both files out of merge-queue CI.
		expect(step).toContain("find tests/integration -name '*.test.ts' -type f");
		expect(step).toContain("find test -name '*.test.ts' -type f");
		for (const relativePath of REQUIRED_RECURSIVE_INTEGRATION_TESTS) {
			expect(existsSync(join(REPO_ROOT, relativePath))).toBe(true);
			expect(relativePath.startsWith('tests/integration/')).toBe(true);
			expect(relativePath.endsWith('.test.ts')).toBe(true);
		}
	});

	test('integration discovery has no depth cap of any kind', () => {
		// Do not weaken this to a literal `-maxdepth 1` check: any numeric
		// max-depth still drops a nested integration test, including the two
		// files pinned above. The exact command assertion also preserves the
		// existing sort and per-file input contract.
		expect(findCommand).not.toMatch(/\s-(?:maxdepth|mindepth)(?:\s|$)/);
	});
});

describe('ci.yml integration — merge-queue coverage isolation', () => {
	const yml = readFileSync(CI_YML_PATH, 'utf8');
	const step = extractCoverageMeasurementStep(yml);
	const coverageGateScript = readFileSync(COVERAGE_GATE_SCRIPT_PATH, 'utf8');

	// The job-graph invariants (CI-004 "coverage never behind unit", the shard
	// matrix's parity with the unit job, and the fail-closed `coverage`
	// aggregator) moved to tests/unit/scripts/ci/ci-coverage-sharding.test.ts
	// when the single coverage job became a coverage-shard matrix + aggregator
	// (issue #2341). This describe keeps the script-content contracts that are
	// independent of the job graph.

	test('"Coverage gate enforcement" step delegates to the coverage helper', () => {
		expect(step).toContain('bash scripts/ci/run-coverage-gate.sh');
	});

	test('coverage helper runs each file with Bun isolation', () => {
		expect(coverageGateScript).toContain('set -euo pipefail');
		expect(coverageGateScript).toContain(
			'bun test --isolate --coverage --coverage-reporter=lcov --timeout 60000 "$test_file"',
		);
		expect(coverageGateScript).toContain(
			"{ grep -vE '^\\s*#|^\\s*$' scripts/ci/quarantined-tests.txt || true; } | sort > quarantined.txt",
		);
	});

	test('coverage helper merges per-file lcov before enforcing the threshold', () => {
		expect(coverageGateScript).toContain('scripts/ci/merge-lcov.mjs');
		expect(coverageGateScript).toContain('coverage/lcov.info');
		expect(coverageGateScript).toContain('Coverage gate passed');
	});
});

describe('ci.yml integration — coverage gate bounded retry (issue #1782 parity)', () => {
	const yml = readFileSync(CI_YML_PATH, 'utf8');
	// Normalize CRLF to LF so the loop-body slice/index assertions below are
	// stable regardless of the checkout's line-ending config.
	const coverageGateScript = readFileSync(
		COVERAGE_GATE_SCRIPT_PATH,
		'utf8',
	).replace(/\r\n/g, '\n');
	const flakeDetectionYml = readFileSync(FLAKE_DETECTION_YML_PATH, 'utf8');

	test('coverage helper retries up to max_retries=2 (three attempts total)', () => {
		expect(coverageGateScript).toContain('max_retries=2');
		expect(coverageGateScript).toContain('while true; do');
		expect(coverageGateScript).toContain(
			'if [ "$retry_num" -ge "$max_retries" ]; then',
		);
		expect(coverageGateScript).toContain(
			'if [ "$exit_code" -eq 0 ] && [ "$coverage_ready" -eq 1 ]; then',
		);
	});

	test('coverage helper does NOT use `let` for the retry counter (set -euo pipefail would kill the script on a 0 result)', () => {
		expect(coverageGateScript).not.toMatch(/(^|\n)\t*let\s/);
		expect(coverageGateScript).toContain('retry_num=$((retry_num + 1))');
	});

	// Anchored ordering assertion (writing-tests skill "Anchored Content
	// Assertions"): a bare `toContain('rm -rf coverage')` would still pass if
	// someone moved the reset outside the attempt loop. Slicing to the
	// `while true` body specifically, and then checking index order INSIDE that
	// slice, is what actually fails if the reset is relocated outside the loop
	// (issue #1712 per-attempt isolation).
	test('coverage helper resets the coverage dir INSIDE the retry loop, not just once per file', () => {
		const whileStart = coverageGateScript.indexOf('while true; do');
		expect(whileStart).toBeGreaterThan(-1);
		const doneIdx = coverageGateScript.indexOf('\n\tdone\n', whileStart);
		expect(doneIdx).toBeGreaterThan(whileStart);
		const loopBody = coverageGateScript.slice(whileStart, doneIdx);

		const retryIncrementIdx = loopBody.indexOf('retry_num=$((retry_num + 1))');
		const rmIdx = loopBody.indexOf('rm -rf coverage');
		const mkdirIdx = loopBody.indexOf('mkdir -p coverage');
		const bunTestIdx = loopBody.indexOf(
			'bun test --isolate --coverage --coverage-reporter=lcov --timeout 60000 "$test_file"',
		);

		// All four markers must be present inside the loop body itself.
		expect(retryIncrementIdx).toBeGreaterThan(-1);
		expect(rmIdx).toBeGreaterThan(-1);
		expect(mkdirIdx).toBeGreaterThan(-1);
		expect(bunTestIdx).toBeGreaterThan(-1);

		// Every attempt resets the coverage dir before invoking Bun. If the reset
		// were moved outside the loop, rmIdx/mkdirIdx would be -1 inside this
		// slice and the assertions above would already fail; this also guards
		// against a reset that happens after the retried test run.
		expect(mkdirIdx).toBeGreaterThan(rmIdx);
		expect(bunTestIdx).toBeGreaterThan(mkdirIdx);
		expect(retryIncrementIdx).toBeGreaterThan(bunTestIdx);
	});

	test('coverage helper appends the "passed on retry" notice to the flake-annotation file', () => {
		// The annotation filename is a variable since issue #2341 sharded the
		// gate: unsharded runs keep `flake-annotations-coverage.txt`, shard runs
		// write `flake-annotations-coverage-shard-<i>.txt` (distinct internal
		// names are mandatory — flake-detection.yml downloads the
		// flake-annotations-* pattern with merge-multiple: true and same-named
		// files would collide on extraction).
		expect(coverageGateScript).toContain(
			'flake_ann="flake-annotations-coverage.txt"',
		);
		expect(coverageGateScript).toContain(
			'echo "::notice file=${test_file}::Passed on retry ${retry_num} (flaky): ${test_file}" >> "$flake_ann"',
		);
	});

	test('coverage helper appends the hard-failure error to the flake-annotation file', () => {
		expect(coverageGateScript).toContain(
			'echo "::error file=${test_file}::FAILED: ${test_file}" >> "$flake_ann"',
		);
	});

	test('ci.yml uploads the per-shard flake-annotation files from the coverage-shard job (issue #2341)', () => {
		const coverageUploadStep = extractCoverageFlakeAnnotationsUploadStep(yml);
		const unitUploadStep = extractUnitFlakeAnnotationsUploadStep(yml);
		expect(coverageUploadStep).toContain(
			'name: flake-annotations-coverage-shard-${{ matrix.shard }}',
		);
		expect(coverageUploadStep).toContain(
			'path: flake-annotations-coverage-shard-${{ matrix.shard }}.txt',
		);
		expect(coverageUploadStep).toContain('if-no-files-found: ignore');

		// Pinned to the same upload-artifact SHA as the sibling per-shard step,
		// so both artifacts are produced by an identically-audited action version.
		const pinnedShaMatch = unitUploadStep.match(
			/uses: actions\/upload-artifact@([a-f0-9]+) # v[\d.]+/,
		);
		expect(pinnedShaMatch).not.toBeNull();
		expect(coverageUploadStep).toContain(
			`uses: actions/upload-artifact@${pinnedShaMatch?.[1]}`,
		);
	});

	test('flake-detection.yml downloads the broadened flake-annotations-* pattern (covers unit shards AND coverage)', () => {
		expect(flakeDetectionYml).toContain('pattern: flake-annotations-*');
		expect(flakeDetectionYml).not.toContain(
			'pattern: flake-annotations-unit-shard-*',
		);
	});

	test('flake-detection.yml concatenates the downloaded coverage/unit annotations end-to-end', () => {
		expect(flakeDetectionYml).toContain(
			'cat annotations/flake-annotations-*.txt 2>/dev/null > detection-out/flake-annotations.txt || true',
		);
	});
});
