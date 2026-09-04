import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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
 * Structural guard for the sharded merge-queue coverage gate (issue #2341,
 * extending the CI-004 guard class from ci-yml-integration.test.ts).
 *
 * The gate is a `coverage-shard` matrix (one cell per unit-shard partition)
 * plus a `coverage` aggregator job that keeps the required-check name and
 * enforces the threshold ONCE over the merged union, failing closed when any
 * shard report is missing. These tests pin that graph so a future edit cannot
 * re-serialize the long pole behind the unit matrix (CI-004) or silently
 * weaken the gate (dropped shard → smaller measured set → lower percentage).
 */

// CRLF-normalize: Windows checkouts can hold CRLF working copies while the
// committed file is LF (.gitattributes eol=lf); assertions must hold on both.
function readText(path: string): string {
	return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/*
 * Job slicer: lazy match from the job's two-space key to the next two-space
 * job key or EOF. Do NOT "simplify" the EOF alternative to `$` — under /m, `$`
 * matches at every line end and the lookahead succeeds immediately,
 * collapsing each slice (see ci-yml-integration.test.ts's header comment).
 */
function extractJob(yml: string, job: string): string {
	const match = yml.match(
		new RegExp(
			`^ {2}${escapeRegExp(job)}:[\\s\\S]*?(?=^ {2}[A-Za-z][\\w-]*:|(?![\\s\\S]))`,
			'm',
		),
	);
	return match ? match[0] : '';
}

// Step slicer: a named step's content ends before the next step (named or
// uses-only), a step-level comment, the next job, or EOF.
function extractStep(yml: string, name: string): string {
	const match = yml.match(
		new RegExp(
			`- name: ${escapeRegExp(name)}[\\s\\S]*?(?=\\n {6}- name:|\\n {6}- uses:|\\n {6}#|\\n {2}[A-Za-z][\\w-]*:|(?![\\s\\S]))`,
			'm',
		),
	);
	return match ? match[0] : '';
}

describe('ci.yml coverage sharding — CI-004 + issue #2341', () => {
	const yml = readText(CI_YML_PATH);
	const coverageShardJob = extractJob(yml, 'coverage-shard');
	const coverageAggJob = extractJob(yml, 'coverage');
	const unitJob = extractJob(yml, 'unit');
	const gateStep = extractStep(yml, 'Coverage gate enforcement');
	const coverageGateScript = readText(COVERAGE_GATE_SCRIPT_PATH);
	const flakeDetectionYml = readText(FLAKE_DETECTION_YML_PATH);

	const EVENT_GUARD =
		"github.event_name == 'merge_group' && needs.detect-release.outputs.is-release != 'true'";

	test('coverage-shard matrix mirrors the unit job shard list (partition parity)', () => {
		// The coverage shard matrix must partition the gated test set with the
		// same shard count as the unit job so coverage shard N measures exactly
		// the files of unit (ubuntu-latest, N) and failures map to one
		// debuggable shard pair (issue #2341's partition-parity requirement).
		expect(coverageShardJob).toContain('shard: [1, 2, 3, 4, 5, 6]');
		expect(unitJob).toContain('shard: [1, 2, 3, 4, 5, 6]');
	});

	test('coverage shards start after quality instead of waiting for the unit matrix (CI-004)', () => {
		// Previous workflow serialized the 45-minute coverage gate behind the
		// unit matrix, so GitHub's merge-queue timeout evicted green runs
		// seconds before coverage completed (PR #2290). The shard matrix
		// inherits the same invariant.
		expect(coverageShardJob).toContain('needs: [detect-release, quality]');
		expect(coverageShardJob).not.toMatch(/needs: \[[^\]]*\bunit\b/);
	});

	test('coverage shards run ubuntu-only with no OS matrix dimension', () => {
		// Partition parity with unit (ubuntu-latest, N) only holds because the
		// coverage script applies the base quarantine list alone; running
		// coverage shards on macOS/Windows would apply different quarantine
		// lists and silently diverge the partitions.
		expect(coverageShardJob).toContain('runs-on: ubuntu-latest');
		expect(coverageShardJob).not.toMatch(/matrix:\s*\n\s*os:/);
		expect(coverageShardJob).not.toContain('matrix.os');
	});

	test('coverage-shard matrix does not cancel sibling shards on one failure', () => {
		// fail-fast: false keeps a failed shard's siblings uploading their
		// flake annotations and lcov reports (cancelled cells run no steps,
		// so if:always() upload steps would not fire under fail-fast).
		expect(coverageShardJob).toContain('fail-fast: false');
	});

	test('coverage shards get a bounded timeout with requeue-priced headroom', () => {
		// 30m: typical shard ~12 min; a false-positive cancellation costs the
		// whole merge group a requeue (issue #2341 sizing decision).
		expect(coverageShardJob).toContain('timeout-minutes: 30');
	});

	test('"Coverage gate enforcement" step runs the helper in shard mode', () => {
		expect(gateStep).toContain('bash scripts/ci/run-coverage-gate.sh');
		expect(gateStep).toContain('COVERAGE_SHARD_INDEX: ${{ matrix.shard }}');
		expect(gateStep).toContain('COVERAGE_SHARD_COUNT: 6');
	});

	test('coverage aggregator is the dependent single gate over the shard matrix', () => {
		// detect-release MUST be a declared direct dependency: the aggregator's
		// step guards read needs.detect-release.outputs.is-release, and GitHub
		// only exposes outputs of DIRECT dependencies — a dangling reference
		// silently resolves to null, the is-release clause goes inert, and a
		// release-please merge group (shards skipped, zero artifacts) would
		// fail the download step and evict the release (final-critic F1).
		expect(coverageAggJob).toContain('needs: [coverage-shard, detect-release]');
		expect(coverageAggJob).toContain('if: always()');
		expect(coverageAggJob).toContain('timeout-minutes: 10');
	});

	test('coverage aggregator fail-closes on a non-success shard matrix result', () => {
		// Mirrors unit-passed: with if:always() the aggregator still runs when
		// a shard failed, and this check makes it FAIL fast so the required
		// `coverage` check reports failure (immediate queue eviction) instead
		// of being skipped and never reporting (the 60-minute silent-timeout
		// eviction mode observed on PR #2313).
		expect(coverageAggJob).toContain(
			'COVERAGE_SHARD_RESULT: ${{ needs.coverage-shard.result }}',
		);
		expect(coverageAggJob).toContain(
			'if [ "$COVERAGE_SHARD_RESULT" != "success" ]; then',
		);
	});

	test('coverage aggregator fail-closes when any shard report is missing', () => {
		// A dropped shard would silently shrink the measured set and lower the
		// measured percentage's denominator — the issue's explicit
		// non-negotiable. The expected-shard loop must appear twice (presence
		// check + collection) and stay pinned to the same 6 shards as both
		// matrices.
		const loops = coverageAggJob.match(/for n in 1 2 3 4 5 6; do/g);
		expect(loops).not.toBeNull();
		expect(loops?.length).toBe(2);
		expect(coverageAggJob).toContain(
			'shard-reports/coverage-shard-${n}/coverage/lcov.info',
		);
		expect(coverageAggJob).toContain(
			'::error::Missing or empty coverage shard report',
		);
		expect(coverageAggJob).toContain(
			'::error::Fail closed: not all 6 coverage shard reports are present (issue #2341)',
		);
	});

	test('coverage aggregator merges shard reports and enforces the threshold once', () => {
		expect(coverageAggJob).toContain(
			'bun scripts/ci/merge-lcov.mjs merged-parts coverage/lcov.info coverage-value.txt',
		);
		expect(coverageAggJob).toContain('Coverage gate passed');
		expect(coverageAggJob).toContain('Coverage gate failed');
	});

	test('threshold literal is single-sourced between aggregator and helper script', () => {
		expect(coverageAggJob).toContain(
			'threshold="${COVERAGE_THRESHOLD:-65.00}"',
		);
		expect(coverageGateScript).toContain(
			'threshold="${COVERAGE_THRESHOLD:-65.00}"',
		);
	});

	test('every aggregator work step carries the merge_group event guard (PR/release stays green)', () => {
		// On pull_request and release-please runs the shards upload nothing, so
		// an unguarded download (if-no-files-found: error) would fail the
		// required `coverage` check on every PR. All work steps must carry the
		// guard; only the final upload keeps always() alongside it.
		for (const stepName of [
			'Check coverage shard results (fail closed)',
			'Download shard reports',
			'Merge shard reports and enforce threshold',
		]) {
			const step = extractStep(yml, stepName);
			expect(step).toContain(`if: ${EVENT_GUARD}`);
		}
		const uploadStep = extractStep(yml, 'Upload coverage report');
		expect(uploadStep).toContain(`if: always() && ${EVENT_GUARD}`);
	});

	test('EVERY step in both coverage jobs carries the merge_group event guard (PRR-006)', () => {
		// The named-step test above only pins the four load-bearing steps. A
		// dropped guard on any SETUP step (checkout / setup-bun / cache /
		// install / build) would not fail the gate — it would just run those
		// steps on every pull_request: ~6 shards x (install + build) of pure
		// waste per PR. Split each job slice on its step boundaries
		// (6-space "- name:" / "- uses:") and require the guard in every one.
		for (const [jobLabel, jobSlice] of [
			['coverage-shard', coverageShardJob],
			['coverage', coverageAggJob],
		] as const) {
			const stepBlocks = jobSlice
				.split(/\n(?= {6}- (?:name|uses):)/)
				.filter((block) => /^\s*- (?:name|uses):/.test(block));
			// 8 steps in coverage-shard, 6 in the aggregator.
			expect(stepBlocks.length).toBeGreaterThanOrEqual(6);
			// Fail with the offending step heads rather than an opaque slice.
			const unguarded = stepBlocks
				.filter(
					(block) => !block.includes(`github.event_name == 'merge_group'`),
				)
				.map((block) => `${jobLabel}: ${block.split('\n')[0]?.trim()}`);
			expect(unguarded.join('\n')).toBe('');
		}
	});

	test('shard-report download is pinned to the same download-artifact SHA as flake-detection.yml', () => {
		const downloadStep = extractStep(yml, 'Download shard reports');
		const pinnedSha = flakeDetectionYml.match(
			/actions\/download-artifact@([a-f0-9]{40})/,
		)?.[1];
		expect(pinnedSha).toBeDefined();
		expect(downloadStep).toContain(`actions/download-artifact@${pinnedSha}`);
		expect(downloadStep).toContain('pattern: coverage-shard-*');
		expect(downloadStep).toContain('if-no-files-found: error');
	});

	test('all coverage upload steps pin the same upload-artifact SHA as the unit job', () => {
		const unitUploadStep = extractStep(yml, 'Upload flake annotations');
		const pinnedShaMatch = unitUploadStep.match(
			/uses: actions\/upload-artifact@([a-f0-9]+) # v[\d.]+/,
		);
		expect(pinnedShaMatch).not.toBeNull();
		const sha = pinnedShaMatch?.[1];
		for (const stepName of [
			'Upload shard coverage report',
			'Upload coverage flake annotations',
			'Upload coverage report',
		]) {
			const step = extractStep(yml, stepName);
			expect(step).toContain(`uses: actions/upload-artifact@${sha}`);
		}
	});
});

describe('run-coverage-gate.sh shard mode — issue #2341', () => {
	const coverageGateScript = readText(COVERAGE_GATE_SCRIPT_PATH);

	test('shard env contract: both-or-neither with numeric validation', () => {
		expect(coverageGateScript).toContain('COVERAGE_SHARD_INDEX');
		expect(coverageGateScript).toContain('COVERAGE_SHARD_COUNT');
		expect(coverageGateScript).toContain(
			'COVERAGE_SHARD_INDEX and COVERAGE_SHARD_COUNT must be set together',
		);
		expect(coverageGateScript).toContain(
			'COVERAGE_SHARD_INDEX must be between 1 and COVERAGE_SHARD_COUNT',
		);
	});

	test('shard partition uses the unit job round-robin over the gated set', () => {
		expect(coverageGateScript).toContain("'(NR - 1) % n == (s - 1)'");
	});

	test('empty shard partition fails closed with an explicit error', () => {
		// Without this guard an empty partition would fall through to the
		// threshold check and emit a misleading "0% < threshold" failure
		// instead of naming the actual problem (mirrors the unit job's
		// "No test files found for shard" guard).
		expect(coverageGateScript).toContain(
			'No test files found for coverage shard',
		);
	});

	test('each successful test must contribute a non-empty lcov artifact', () => {
		const branchStart = coverageGateScript.indexOf(
			'elif [ "$coverage_ready" -eq 1 ]; then',
		);
		const successBranch = coverageGateScript.slice(
			branchStart,
			coverageGateScript.indexOf('\n\tfi', branchStart),
		);
		expect(successBranch).toContain(
			'::error file=${test_file}::No non-empty lcov.info produced for coverage test: ${test_file}',
		);
		expect(successBranch).toContain('failed=1');
		expect(successBranch).not.toContain('::warning');
	});

	test('a missing lcov report retries before failing closed', () => {
		expect(coverageGateScript).toContain('coverage_ready=0');
		expect(coverageGateScript).toContain(
			'produced no non-empty lcov.info, retrying',
		);
		expect(coverageGateScript).toContain(
			'if [ "$exit_code" -eq 0 ] && [ "$coverage_ready" -eq 1 ]; then',
		);
		expect(coverageGateScript).toContain(
			'if [ "$retry_num" -ge "$max_retries" ]; then',
		);
	});

	test('successful coverage waits boundedly for Bun lcov flush', () => {
		expect(coverageGateScript).toContain('--coverage-reporter=lcov');
		expect(coverageGateScript).toContain('lcov_wait=0');
		expect(coverageGateScript).toContain(
			'while [ "$lcov_wait" -lt 20 ] && [ ! -s coverage/lcov.info ]',
		);
		expect(coverageGateScript).toContain('sleep 0.25');
		expect(coverageGateScript).toContain('lcov_wait=$((lcov_wait + 1))');
	});

	test('shard mode skips threshold enforcement (aggregator owns the union)', () => {
		expect(coverageGateScript).toContain(
			'Shard ${shard_index}/${shard_count} local coverage',
		);
		// PRR-007: pin the REASSIGNMENT of $flake_ann in shard mode, not just
		// the filename string anywhere in the script — a dead variable holding
		// the shard name while $flake_ann keeps the unsharded default would
		// silently collide annotations under merge-multiple extraction and
		// pass a bare substring assertion.
		expect(coverageGateScript).toContain(
			'flake_ann="flake-annotations-coverage-shard-${shard_index}.txt"',
		);
		// PRR-012: anchored slice of the sharded threshold branch — the
		// informational message must be there and the enforcement strings must
		// NOT be, so a future edit cannot keep the message while quietly
		// re-adding per-shard enforcement (which would fail slow shards whose
		// file mix skews the local ratio).
		const readIdx = coverageGateScript.indexOf(
			'read -r coverage_value < coverage-value.txt',
		);
		expect(readIdx).toBeGreaterThan(-1);
		const shardedIfIdx = coverageGateScript.indexOf(
			'if [ "$sharded" -eq 1 ]; then',
			readIdx,
		);
		expect(shardedIfIdx).toBeGreaterThan(readIdx);
		const elseIdx = coverageGateScript.indexOf('\nelse\n', shardedIfIdx);
		expect(elseIdx).toBeGreaterThan(shardedIfIdx);
		const shardedBranch = coverageGateScript.slice(shardedIfIdx, elseIdx);
		expect(shardedBranch).toContain(
			'Shard ${shard_index}/${shard_count} local coverage',
		);
		expect(shardedBranch).not.toContain('Coverage gate failed');
		expect(shardedBranch).not.toContain('failed=1');
	});

	test('helper script never diverges from the ubuntu partition (no OS branches)', () => {
		// The unit job adds macOS/Windows quarantine lists per RUNNER_OS; the
		// coverage helper must NOT, or coverage shard N would stop matching
		// unit (ubuntu-latest, N)'s file set while every parity assertion
		// above still passed.
		expect(coverageGateScript).not.toContain('RUNNER_OS');
		expect(coverageGateScript).not.toContain('quarantined-tests-macos');
		expect(coverageGateScript).not.toContain('quarantined-tests-windows');
	});
});

describe('ci.yml — no dangling needs references (final-critic F1, issue #2341)', () => {
	const yml = readText(CI_YML_PATH);

	test('every needs.<job>. reference is a declared direct dependency of its job', () => {
		// GitHub's needs context only exposes outputs/results of DIRECT
		// dependencies; a needs.<x>. reference to an undeclared job silently
		// resolves to null instead of erroring, so a guard like
		// `needs.detect-release.outputs.is-release != 'true'` quietly goes
		// inert (null != 'true' is always true). Caught concretely on the
		// coverage aggregator, whose event guard would have degenerated and
		// failed the required `coverage` check on release-please merge groups.
		const violations: string[] = [];
		const jobIds = [...yml.matchAll(/^ {2}([A-Za-z][\w-]*):/gm)].map(
			(m) => m[1],
		);
		expect(jobIds.length).toBeGreaterThan(0);
		for (const jobId of jobIds) {
			const slice = extractJob(yml, jobId);
			// Strip comment lines: prose may legitimately cite a needs.<x>.
			// reference it does not use.
			const code = slice
				.split('\n')
				.filter((line) => !/^\s*#/.test(line))
				.join('\n');
			const declared = new Set<string>();
			const inlineList = code.match(/^ {4}needs: \[([^\]]+)\]/m)?.[1] ?? '';
			for (const dep of inlineList
				.split(',')
				.map((d) => d.trim())
				.filter(Boolean)) {
				declared.add(dep);
			}
			const blockList = /^ {4}needs:\n((?: {6}- [^\n]+\n)+)/m.exec(code);
			if (blockList) {
				for (const dep of blockList[1].matchAll(/- ([\w-]+)/g)) {
					declared.add(dep[1]);
				}
			}
			for (const ref of code.matchAll(/needs\.([A-Za-z][\w-]*)\./g)) {
				if (!declared.has(ref[1])) {
					violations.push(
						`${jobId} references needs.${ref[1]}.* but does not declare '${ref[1]}' in its needs: list`,
					);
				}
			}
		}
		expect(violations).toEqual([]);
	});
});
