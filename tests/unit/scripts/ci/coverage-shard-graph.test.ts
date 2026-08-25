import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Issue #2341 structural guard — the CI-004 regression class, extended to the
 * sharded coverage graph. These tests exist so a future workflow edit cannot
 * silently re-serialize the merge queue's long pole or weaken the fail-closed
 * merge. They assert GRAPH SEMANTICS (job keys, needs, matrix, env wiring,
 * artifact handoff, check order), never prose comments.
 *
 * Behavior of the fail-closed merge itself is covered functionally by
 * tests/unit/scripts/ci/finalize-coverage-gate.test.ts.
 */

const CI_YML_PATH = join(
	import.meta.dir,
	'../../../../.github/workflows/ci.yml',
);
const SHARD_SCRIPT_PATH = join(
	import.meta.dir,
	'../../../../scripts/ci/run-coverage-gate.sh',
);
const FINALIZE_SCRIPT_PATH = join(
	import.meta.dir,
	'../../../../scripts/ci/finalize-coverage-gate.sh',
);

function normalize(text: string): string {
	return text.replace(/\r\n/g, '\n');
}

function extractJob(yml: string, jobKey: string): string {
	const match = normalize(yml).match(
		new RegExp(
			`^ {2}${jobKey}:[\\s\\S]*?(?=^ {2}[A-Za-z][\\w-]*:|(?![\\s\\S]))`,
			'm',
		),
	);
	return match ? match[0] : '';
}

function extractStep(job: string, stepName: string): string {
	const escaped = stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = normalize(job).match(
		new RegExp(
			`- name: ${escaped}[\\s\\S]*?(?=\\n {6}- name:|\\n {6}- uses:|\\n {2}[A-Za-z][\\w-]*:|(?![\\s\\S]))`,
		),
	);
	return match ? match[0] : '';
}

describe('ci.yml coverage gate shard graph (issue #2341)', () => {
	const yml = readFileSync(CI_YML_PATH, 'utf8');
	const shardJob = extractJob(yml, 'coverage-shard');
	const mergeJob = extractJob(yml, 'coverage');
	const unitJob = extractJob(yml, 'unit');
	const shardScript = normalize(readFileSync(SHARD_SCRIPT_PATH, 'utf8'));
	const finalizeScript = normalize(readFileSync(FINALIZE_SCRIPT_PATH, 'utf8'));

	test('coverage-shard job exists with a 6-way matrix, fail-fast disabled, bounded timeout', () => {
		expect(shardJob).not.toBe('');
		expect(shardJob).toContain('fail-fast: false');
		const matrixMatch = shardJob.match(/shard: \[([^\]]+)\]/);
		expect(matrixMatch).not.toBeNull();
		const shardIds = (matrixMatch?.[1] ?? '')
			.split(',')
			.map((entry) => Number(entry.trim()))
			.filter((n) => Number.isFinite(n));
		expect(shardIds).toEqual([1, 2, 3, 4, 5, 6]);
		// 30m bounds each shard at half the pre-#2341 single-job 60m budget while
		// leaving >2x headroom over the expected ~12-13 min.
		const timeout = Number(
			shardJob.match(/^ {4}timeout-minutes: (\d+)$/m)?.[1],
		);
		expect(timeout).toBeGreaterThan(0);
		expect(timeout).toBeLessThanOrEqual(30);
		expect(shardJob).toContain('runs-on: ubuntu-latest');
	});

	test('coverage-shard starts after quality in parallel with the unit matrix (CI-004 preserved)', () => {
		// The shard matrix keeps the post-quality start so it overlaps `unit`;
		// neither coverage job may wait for `unit` — serializing the coverage
		// leg behind the unit matrix is the CI-004 eviction class.
		expect(shardJob).toContain('needs: [detect-release, quality]');
		expect(shardJob).not.toMatch(/needs: \[[^\]]*\bunit\b/);
	});

	test('coverage-shard has no job-level if (cells always report success/failure, never skipped)', () => {
		// Matches the detect-paths/quality/unit pattern: a job-level `if:` would
		// report cells as skipped (not success) on non-merge_group events and
		// cascade through `needs:` semantics. Job-body keys sit at 4-space
		// indent; step-level `if:` is at 8, so this cannot false-positive.
		expect(shardJob).not.toMatch(/^ {4}if:/m);
	});

	test('shard gate step wires SHARD_INDEX from the matrix and SHARD_COUNT', () => {
		const gateStep = extractStep(shardJob, 'Coverage gate enforcement');
		expect(gateStep).toContain('bash scripts/ci/run-coverage-gate.sh');
		expect(gateStep).toContain('SHARD_INDEX: ${{ matrix.shard }}');
		const shardCount = Number(gateStep.match(/SHARD_COUNT: (\d+)/)?.[1]);
		expect(shardCount).toBeGreaterThan(0);
	});

	test('coverage merge job aggregates the shards with if: always() and never waits for unit', () => {
		// `if: always()` follows the unit-passed pattern: a failed/skipped/
		// timed-out shard cell must produce a RED required check, never a
		// MISSING one — a missing required check reproduces the exact
		// checks_timed_out eviction class issue #2341 exists to close.
		expect(mergeJob).toContain('needs: [detect-release, coverage-shard]');
		expect(mergeJob).toMatch(/^ {4}if: always\(\)$/m);
		expect(mergeJob).not.toMatch(/needs: \[[^\]]*\bunit\b/);
		const timeout = Number(
			mergeJob.match(/^ {4}timeout-minutes: (\d+)$/m)?.[1],
		);
		expect(timeout).toBeGreaterThan(0);
		expect(timeout).toBeLessThanOrEqual(10);
	});

	test('merge job downloads shard parts with merge-multiple and a pinned download-artifact SHA', () => {
		const downloadStep = extractStep(mergeJob, 'Download coverage shard parts');
		expect(downloadStep).toContain('pattern: coverage-part-shard-*');
		expect(downloadStep).toContain('merge-multiple: true');
		expect(downloadStep).toContain('path: coverage-parts');
		// Same audited pin as flake-detection.yml's download step (v4.3.0).
		expect(downloadStep).toContain(
			'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
		);
		expect(downloadStep).toContain("github.event_name == 'merge_group'");
	});

	test('merge job needs neither bun install nor build (merge-lcov.mjs has zero deps)', () => {
		expect(mergeJob).not.toContain('bun install');
		expect(mergeJob).not.toContain('bun run build');
		// bun itself is still set up — it is not preinstalled on runners.
		expect(mergeJob).toContain(
			'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
		);
	});

	test('finalize step wires EXPECTED_SHARDS and the shard matrix result', () => {
		const finalizeStep = extractStep(
			mergeJob,
			'Merge coverage shards and enforce threshold',
		);
		expect(finalizeStep).toContain('bash scripts/ci/finalize-coverage-gate.sh');
		expect(finalizeStep).toContain(
			'SHARD_JOB_RESULT: ${{ needs.coverage-shard.result }}',
		);
		expect(finalizeStep).toContain("github.event_name == 'merge_group'");
	});

	test('matrix cardinality, SHARD_COUNT, and EXPECTED_SHARDS all agree (edit-one-place drift guard)', () => {
		const matrixMatch = shardJob.match(/shard: \[([^\]]+)\]/);
		const shardCount = Number(
			extractStep(shardJob, 'Coverage gate enforcement').match(
				/SHARD_COUNT: (\d+)/,
			)?.[1],
		);
		const expectedShards = Number(
			extractStep(
				mergeJob,
				'Merge coverage shards and enforce threshold',
			).match(/EXPECTED_SHARDS: (\d+)/)?.[1],
		);
		const matrixLength = (matrixMatch?.[1] ?? '')
			.split(',')
			.filter((entry) => entry.trim().length > 0).length;
		expect(matrixLength).toBeGreaterThan(0);
		expect(shardCount).toBe(matrixLength);
		expect(expectedShards).toBe(matrixLength);
		// The finalize script's default must also agree, so a bare local run of
		// the two scripts (SHARD_COUNT=1 / EXPECTED_SHARDS unset) is not the
		// only consistent configuration.
		expect(finalizeScript).toContain('EXPECTED_SHARDS:-6');
	});

	test('every upload step in both coverage jobs carries if: always()', () => {
		// if: always() is load-bearing: a shard that fails or times out mid-way
		// still uploads its partial part, which the merge job's count check
		// turns into a red check with diagnostics instead of a quiet gap.
		for (const stepName of [
			'Upload coverage shard part',
			'Upload coverage flake annotations',
		]) {
			expect(extractStep(shardJob, stepName)).toContain('if: always()');
		}
		expect(extractStep(mergeJob, 'Upload coverage report')).toContain(
			'if: always()',
		);
	});

	test('shard part upload fails loudly when the part file is missing', () => {
		const partUpload = extractStep(shardJob, 'Upload coverage shard part');
		expect(partUpload).toContain('if-no-files-found: error');
		expect(partUpload).toContain(
			'name: coverage-part-shard-${{ matrix.shard }}',
		);
		expect(partUpload).toContain('coverage-part-${{ matrix.shard }}.info');
	});

	test('shard script partitions with the same round-robin formula and find chain as the unit job', () => {
		// The "maps 1:1 onto a unit shard" property (issue #2341 preference)
		// holds only while both sides discover files identically and partition
		// with the same formula. Containment alone would let one side grow a
		// 4th find command the other lacks, silently shifting the mapping and
		// the measured set — so the find-command COUNT is pinned on both sides
		// (exactly 3) in addition to each command's text.
		const partitionStep = extractStep(
			unitJob,
			'Collect and partition test files',
		);
		expect(partitionStep).not.toBe('');
		for (const side of [partitionStep, shardScript]) {
			expect(side).toContain("find src -name '*.test.ts' -type f");
			expect(side).toContain(
				"find tests/unit tests/adversarial tests/architect tests/cli tests/tools tests/helpers -name '*.test.ts' -type f 2>/dev/null",
			);
			expect(side).toContain(
				"find tests -maxdepth 1 -name '*.test.ts' -type f 2>/dev/null",
			);
			expect(side).toContain('(NR - 1) % n == (s - 1)');
			const findCommandCount = (side.match(/^\s*find /gm) ?? []).length;
			expect(findCommandCount).toBe(3);
		}
	});

	test('every step in the coverage-shard job is gated on merge_group', () => {
		// Without this gate on EVERY step, pull_request events would start
		// running full coverage shards on every PR (cost/latency regression),
		// and release-please groups would measure coverage for version bumps.
		// Exact step count: a step that DROPS its `if:` entirely must fail,
		// not just one that keeps an ungated `if:`.
		const normalizedShardJob = normalize(shardJob);
		const stepCount = (
			normalizedShardJob.match(/^ {6}- (?:name|uses):/gm) ?? []
		).length;
		const ifLines = [...normalizedShardJob.matchAll(/^\s+if: (.+)$/gm)].map(
			(m) => m[1],
		);
		expect(stepCount).toBeGreaterThanOrEqual(8);
		expect(ifLines.length).toBe(stepCount);
		for (const condition of ifLines) {
			expect(condition).toContain("github.event_name == 'merge_group'");
		}
	});

	test('shard script writes uniquely-named outputs and fails closed on an empty shard', () => {
		expect(shardScript).toContain('coverage-part-${shard}.info');
		expect(shardScript).toContain('coverage-output-shard-${shard}.txt');
		expect(shardScript).toContain(
			'flake_ann="flake-annotations-coverage-shard-${shard}.txt"',
		);
		expect(shardScript).toContain(
			'No test files found for coverage shard ${shard}/${shard_count}',
		);
		expect(shardScript).toContain('produced no lcov records');
		// Threshold enforcement moved to finalize — single enforcement point.
		expect(shardScript).not.toContain('COVERAGE_THRESHOLD');
	});

	test('finalize script enforces checks in fail-closed order before the threshold', () => {
		// Order is pinned: shard result FIRST (a failed shard can still upload a
		// partial part, so count alone must never be the gate), then part count,
		// then per-part non-empty + DA-record integrity, then merge, then the
		// threshold comparison itself. Comment lines are stripped first — the
		// script's own header comment documents this same order, and matching
		// against it would make the assertion vacuous.
		const executable = finalizeScript
			.split('\n')
			.filter((line) => !line.trimStart().startsWith('#'))
			.join('\n');
		const markers = [
			'if [ "$shard_result" != "success" ]; then',
			'Expected ${expected} coverage shard parts in ${parts_dir}, found ${part_count}',
			'Coverage shard part ${f} is empty',
			'Coverage shard part ${f} contains no DA: records',
			'merge-lcov.mjs',
			// The actual comparison, not just its failure message: the awk
			// expression exits 0 exactly when value < threshold, and bash's
			// `if CMD` takes the then-branch on exit 0 — so a passing gate
			// must NOT print 'Coverage gate failed'.
			'awk "BEGIN {exit !($coverage_value < $threshold)}"',
			'Coverage gate failed',
		];
		let previous = -1;
		for (const marker of markers) {
			const idx = executable.indexOf(marker);
			expect(idx).toBeGreaterThan(-1);
			expect(idx).toBeGreaterThan(previous);
			previous = idx;
		}
	});

	test('finalize script preserves the pre-#2341 threshold semantics', () => {
		expect(finalizeScript).toContain('COVERAGE_THRESHOLD:-65.00');
		expect(finalizeScript).toContain('set -euo pipefail');
		expect(finalizeScript).toContain('Coverage gate passed');
	});
});
