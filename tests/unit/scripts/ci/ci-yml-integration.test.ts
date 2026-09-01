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

describe('ci.yml integration — Task 1.2 wrapper script structural validation', () => {
	const yml = readFileSync(CI_YML_PATH, 'utf8');
	const step = extractRunUnitTestsStep(yml);
	const collectStep = extractCollectAndPartitionStep(yml);

	test('"Run unit tests" step calls the wrapper script', () => {
		expect(step).toContain('bun scripts/ci/run-test-with-timeout.ts');
	});

	test('"Run unit tests" step includes --kill-timeout 180', () => {
		expect(step).toContain('--kill-timeout 180');
	});

	test('"Run unit tests" step preserves error detection with grep -qE', () => {
		expect(step).toContain('grep -qE');
	});

	test('"Run unit tests" step preserves shard file list mechanism', () => {
		expect(step).toContain('shard-tests.txt');
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

describe('ci.yml integration — integration quarantine extraction', () => {
	const yml = readFileSync(CI_YML_PATH, 'utf8');
	const step = extractIntegrationTestsStep(yml);

	test('"Integration tests" step tolerates empty quarantine files', () => {
		expect(step).toContain(
			'grep -vE \'^\\s*#|^\\s*$\' scripts/ci/quarantined-integration-tests.txt | sort > "$tmpdir/int-quarantined.txt" || true',
		);
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
			'bun test --isolate --coverage --timeout 60000 "$test_file"',
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
		expect(coverageGateScript).toContain(
			'while [ "$exit_code" -ne 0 ] && [ "$retry_num" -lt "$max_retries" ]; do',
		);
	});

	test('coverage helper does NOT use `let` for the retry counter (set -euo pipefail would kill the script on a 0 result)', () => {
		expect(coverageGateScript).not.toMatch(/(^|\n)\t*let\s/);
		expect(coverageGateScript).toContain('retry_num=$((retry_num + 1))');
	});

	// Anchored ordering assertion (writing-tests skill "Anchored Content
	// Assertions"): a bare `toContain('rm -rf coverage')` would still pass if
	// someone moved the reset back outside the retry loop, because the
	// pre-loop reset (once per file, before the first attempt) also contains
	// that literal. Slicing to the retry-loop body specifically, and then
	// checking index order INSIDE that slice, is what actually fails if the
	// reset is relocated outside the loop (issue #1712 per-attempt isolation).
	test('coverage helper resets the coverage dir INSIDE the retry loop, not just once per file', () => {
		const whileStart = coverageGateScript.indexOf(
			'while [ "$exit_code" -ne 0 ] && [ "$retry_num" -lt "$max_retries" ]; do',
		);
		expect(whileStart).toBeGreaterThan(-1);
		const doneIdx = coverageGateScript.indexOf('\n\tdone\n', whileStart);
		expect(doneIdx).toBeGreaterThan(whileStart);
		const loopBody = coverageGateScript.slice(whileStart, doneIdx);

		const retryIncrementIdx = loopBody.indexOf('retry_num=$((retry_num + 1))');
		const rmIdx = loopBody.indexOf('rm -rf coverage');
		const mkdirIdx = loopBody.indexOf('mkdir -p coverage');
		const bunTestIdx = loopBody.indexOf(
			'bun test --isolate --coverage --timeout 60000 "$test_file"',
		);

		// All four markers must be present inside the loop body itself.
		expect(retryIncrementIdx).toBeGreaterThan(-1);
		expect(rmIdx).toBeGreaterThan(-1);
		expect(mkdirIdx).toBeGreaterThan(-1);
		expect(bunTestIdx).toBeGreaterThan(-1);

		// And in this order: increment retry counter -> reset coverage dir ->
		// recreate coverage dir -> re-run bun test. If the reset were moved
		// outside the loop, rmIdx/mkdirIdx would be -1 inside this slice and
		// the assertions above would already fail; this also guards against a
		// reset that's present but reordered after the retried bun test run.
		expect(rmIdx).toBeGreaterThan(retryIncrementIdx);
		expect(mkdirIdx).toBeGreaterThan(rmIdx);
		expect(bunTestIdx).toBeGreaterThan(mkdirIdx);
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

describe('ci.yml integration — windows quarantine ledger entry for win32-wrapper-runtime (issue #2185)', () => {
	// Repo root is four levels up from tests/unit/scripts/ci/.
	const REPO_ROOT = join(import.meta.dir, '../../../..');
	const WINDOWS_LEDGER_PATH = join(
		REPO_ROOT,
		'scripts/ci/quarantined-tests-windows.txt',
	);
	const GENERAL_LEDGER_PATH = join(
		REPO_ROOT,
		'scripts/ci/quarantined-tests.txt',
	);
	const MACOS_LEDGER_PATH = join(
		REPO_ROOT,
		'scripts/ci/quarantined-tests-macos.txt',
	);
	const QUARANTINED_PATH = 'tests/unit/sandbox/win32-wrapper-runtime.test.ts';

	// Mirror ci.yml's active-entry extraction exactly:
	//   grep -vE '^\s*#|^\s*$' scripts/ci/quarantined-tests-<os>.txt
	// (CRLF is normalized first so the assertion holds on any checkout config.)
	function activeEntries(ledgerPath: string): string[] {
		const raw = readFileSync(ledgerPath, 'utf8').replace(/\r\n/g, '\n');
		return raw
			.split('\n')
			.filter((line: string) => !/^\s*#/.test(line) && !/^\s*$/.test(line))
			.map((line: string) => line.trim());
	}

	test('win32-wrapper-runtime.test.ts is an active entry in the windows ledger', () => {
		// Regression guard for issue #2185: without the quarantine entry, the
		// windows-latest merge-group shards keep running this file and the
		// flake-detection workflow re-files duplicate issues (rule A only drops
		// candidates already present in a ledger).
		expect(existsSync(WINDOWS_LEDGER_PATH)).toBe(true);
		expect(activeEntries(WINDOWS_LEDGER_PATH)).toContain(QUARANTINED_PATH);
	});

	test('the entry is scoped to the windows ledger only (single-OS evidence)', () => {
		// The #2185 flake was windows-latest-only with green ubuntu/macos
		// siblings, so the entry must NOT suppress the file on other OSes:
		// the general ledger applies on every RUNNER_OS and the macos ledger
		// on macOS runners (see the "Collect and partition test files" step).
		expect(activeEntries(GENERAL_LEDGER_PATH)).not.toContain(QUARANTINED_PATH);
		expect(activeEntries(MACOS_LEDGER_PATH)).not.toContain(QUARANTINED_PATH);
	});

	test('the quarantined path exists and is discovered by the ci.yml find chain', () => {
		// A typo'd ledger path would be a silent no-op: CI's comm -23 gated set
		// would never exclude it (the path never appears in all-tests.txt) and
		// the flake would keep re-filing. The discovery chain globs
		// tests/unit/**/*.test.ts, so the on-disk file must exist at exactly
		// the ledger path relative to the repo root.
		expect(existsSync(join(REPO_ROOT, QUARANTINED_PATH))).toBe(true);
	});

	test('windows ledger STATUS header count matches its active-entry count', () => {
		// The windows ledger's re-add policy tracks its active entry count in a
		// "# STATUS: N active entr(y|ies)" header line. Drift between the
		// declared count and the actual active-entry count (e.g. an entry
		// removed without updating the header, or a count bumped without the
		// matching entries) makes the header lie to triage. Note: this only
		// catches count drift; the presence test above (line 296) is the
		// cross-PR overwrite guard.
		const raw = readFileSync(WINDOWS_LEDGER_PATH, 'utf8').replace(
			/\r\n/g,
			'\n',
		);
		const statusMatches = [
			...raw.matchAll(/^#\s*STATUS:\s*(\d+)\s+active entr/gm),
		];
		expect(statusMatches.length).toBe(1);
		const declared = Number(statusMatches[0]?.[1]);
		expect(declared).toBe(activeEntries(WINDOWS_LEDGER_PATH).length);
	});
});

describe('ci.yml integration — general quarantine ledger entry for dispatch-lanes (issue #2368)', () => {
	// Repo root is four levels up from tests/unit/scripts/ci/.
	const REPO_ROOT = join(import.meta.dir, '../../../..');
	const GENERAL_LEDGER_PATH = join(
		REPO_ROOT,
		'scripts/ci/quarantined-tests.txt',
	);
	const WINDOWS_LEDGER_PATH = join(
		REPO_ROOT,
		'scripts/ci/quarantined-tests-windows.txt',
	);
	const MACOS_LEDGER_PATH = join(
		REPO_ROOT,
		'scripts/ci/quarantined-tests-macos.txt',
	);
	const QUARANTINED_PATH = 'tests/unit/tools/dispatch-lanes.test.ts';

	// Mirror ci.yml's active-entry extraction exactly:
	//   grep -vE '^\s*#|^\s*$' scripts/ci/quarantined-tests-<os>.txt
	// (CRLF is normalized first so the assertion holds on any checkout config.)
	function activeEntries(ledgerPath: string): string[] {
		const raw = readFileSync(ledgerPath, 'utf8').replace(/\r\n/g, '\n');
		return raw
			.split('\n')
			.filter((line: string) => !/^\s*#/.test(line) && !/^\s*$/.test(line))
			.map((line: string) => line.trim());
	}

	test('dispatch-lanes.test.ts is an active entry in the general ledger', () => {
		// Regression guard for issue #2368: the merge-group coverage job
		// (coverage-shard 3, ubuntu-latest) flagged a retry-flake for this file.
		// Coverage shards run ubuntu-only and honor ONLY the general ledger
		// (run-coverage-gate.sh never consults per-OS lists), so the entry must
		// live in the general ledger. Without it, the flake-detection workflow
		// keeps re-filing duplicates (rule A only drops already-quarantined
		// candidates).
		expect(existsSync(GENERAL_LEDGER_PATH)).toBe(true);
		expect(activeEntries(GENERAL_LEDGER_PATH)).toContain(QUARANTINED_PATH);
	});

	test('the general-ledger entry is not duplicated in the per-OS ledgers', () => {
		// Cross-OS duplicates would be harmless but confusing: the general
		// ledger already applies on every RUNNER_OS, so re-listing the file in
		// the windows/macos ledgers would imply OS-specific evidence.
		expect(activeEntries(WINDOWS_LEDGER_PATH)).not.toContain(QUARANTINED_PATH);
		expect(activeEntries(MACOS_LEDGER_PATH)).not.toContain(QUARANTINED_PATH);
	});

	test('the quarantined path exists and is discovered by the ci.yml find chain', () => {
		// A typo'd ledger path would be a silent no-op: CI's comm -23 gated set
		// would never exclude it (the path never appears in all-tests.txt) and
		// the flake would keep re-filing. The discovery chain globs
		// tests/unit/**/*.test.ts, so the on-disk file must exist at exactly
		// the ledger path relative to the repo root.
		expect(existsSync(join(REPO_ROOT, QUARANTINED_PATH))).toBe(true);
	});
});
