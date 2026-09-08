import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const CI_YML_PATH = join(REPO_ROOT, '.github/workflows/ci.yml');
const POLICY_PATH = join(REPO_ROOT, 'docs/ci/merge-queue-policy.md');

function readText(path: string): string {
	return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function extractJob(yml: string, job: string): string {
	const match = yml.match(
		new RegExp(
			`^ {2}${job}:[\\s\\S]*?(?=^ {2}[A-Za-z][\\w-]*:|(?![\\s\\S]))`,
			'm',
		),
	);
	return match?.[0] ?? '';
}

function extractReceipt(policy: string, identifier: string): string {
	const match = policy.match(
		new RegExp(`${identifier}\\n[\\s\\S]*?(?=\\n\\n|\\nidentifier=|\\n## )`),
	);
	return match?.[0] ?? '';
}

describe('Stage-A policy and six-way CI agreement (issue #2552)', () => {
	const workflow = readText(CI_YML_PATH);
	const policy = readText(POLICY_PATH);
	// Workflow assertions below protect live CI topology from drift. Policy
	// assertions protect the committed decision record's internal consistency;
	// they intentionally do not claim to re-prove the historical evidence.

	test('unit keeps six-way matrix and runtime partition denominator', () => {
		const unit = extractJob(workflow, 'unit');

		expect(unit).toContain('shard: [1, 2, 3, 4, 5, 6]');
		expect(unit).toContain('num_shards=6');
		expect(unit).toContain(
			'awk -v s="$SHARD" -v n="$num_shards" \'(NR - 1) % n == (s - 1)\'',
		);
		expect(unit).not.toContain('num_shards=10');
		expect(unit).not.toContain('shard_count: 10');
	});

	test('coverage remains six-way with six-file loops and a fail-closed count', () => {
		const coverageShard = extractJob(workflow, 'coverage-shard');
		const coverage = extractJob(workflow, 'coverage');
		const sixLoops = coverage.match(/for n in 1 2 3 4 5 6; do/g) ?? [];

		expect(coverageShard).toContain('shard: [1, 2, 3, 4, 5, 6]');
		expect(coverageShard).toContain('COVERAGE_SHARD_COUNT: 6');
		expect(sixLoops).toHaveLength(2);
		expect(coverage).toContain(
			'::error::Fail closed: not all 6 coverage shard reports are present',
		);
		expect(coverage).not.toMatch(/for n in 1 2 3 4 5 6 7 8 9 10; do/);
	});

	test('unit-passed remains the required aggregate gate', () => {
		const unitPassed = extractJob(workflow, 'unit-passed');

		expect(unitPassed).toContain('needs: [unit]');
		expect(unitPassed).toContain('if: always()');
		expect(unitPassed).toContain('UNIT_RESULT: ${{ needs.unit.result }}');
		expect(policy).toContain('Required Ubuntu unit cells 1 through 4');
	});

	test('policy records the current evidence and a capacity-risk retain-six decision', () => {
		expect(policy).toContain('### Stage A decision window');
		expect(policy).toContain('**56 `merge_group` runs**');
		expect(policy).toContain('**39 successful and 17 failed**');
		expect(policy).toContain('P50 `30m36s`, P95 `51m25s`');
		expect(policy).toContain('maximum `58m47s`');
		expect(policy).toContain(
			'**39m41s** figure is end-to-end merge-group queue',
		);
		expect(policy).toContain('Windows runner queue');
		expect(policy).toContain('**20.4–22.7m**');
		expect(policy).toContain('about **21m** of divisible');
		expect(policy).toContain('about **1.6m** of fixed');
		expect(policy).toContain('approximately **8m** service-time benefit');
		expect(policy).toContain('from **30 to 50**');
		expect(policy).toContain(
			'account-level concurrency capacity remains unknown',
		);
		expect(policy).toMatch(/\*\*Decision:\*\* Retain six Windows unit shards/);
		expect(policy).not.toContain(
			'Stage A Windows10 decision is planned separately',
		);
		expect(policy).not.toContain('planned Stage A decision');
		expect(policy).not.toMatch(/concurrency[^\n]*\b0\b/i);
	});

	test('policy pins the numeric reopening gate and retained gates', () => {
		expect(policy).toMatch(
			/median Windows test-step duration \*\*>=18m AND P95 runner queue <=5m\*\*/,
		);
		expect(policy).toMatch(
			/\*\*>=5m P95 merge-group wall-time gain without >5m marginal\s+runner-queue growth\*\*/,
		);
		expect(policy).toContain('six-way coverage matrix and six-file loops');
		expect(policy).toContain('No Windows-ten workflow or ruleset change');
	});

	test('C9 defines timeline eviction evidence and records Stage-D receipts', () => {
		const contractStart = policy.indexOf('## C9 post-land receipt contract');
		const contractEnd = policy.indexOf(
			'## Cross-contamination warning language',
		);
		const contract = policy.slice(contractStart, contractEnd);

		for (const field of [
			'eviction=none',
			'eviction_evidence=timeline:add→terminal-merge/remove-pair',
			'timeline_added_at=ISO Z',
			'timeline_merged_at=ISO Z',
			'timeline_removed_at=ISO Z',
			'unit_shards_executed=6',
			'terminal_pair_evidence=adjacent terminal merge/remove pair; no intervening re-add',
		]) {
			expect(contract).toContain(field);
		}

		const receipts = [
			{
				identifier: 'stage-d-post-land-1',
				run: '34051617672',
				duration: '1841000',
				completed: '2026-09-06T18:55:17Z',
				added: '2026-09-06T18:24:18Z',
				merged: '2026-09-06T18:55:43Z',
				removed: '2026-09-06T18:55:43Z',
			},
			{
				identifier: 'stage-d-post-land-2',
				run: '34060659584',
				duration: '1781000',
				completed: '2026-09-06T21:48:07Z',
				added: '2026-09-06T21:18:08Z',
				merged: '2026-09-06T21:48:11Z',
				removed: '2026-09-06T21:48:11Z',
			},
			{
				identifier: 'stage-d-post-land-3',
				run: '34061223031',
				duration: '2435000',
				completed: '2026-09-06T22:10:05Z',
				added: '2026-09-06T21:29:16Z',
				merged: '2026-09-06T22:10:31Z',
				removed: '2026-09-06T22:10:30Z',
			},
		] as const;

		expect(
			policy.match(/^identifier=stage-d-post-land-\d+$/gm) ?? [],
		).toHaveLength(3);
		for (const receipt of receipts) {
			const block = extractReceipt(policy, `identifier=${receipt.identifier}`);
			expect(block).not.toBe('');
			expect(block).toContain(
				`actions=https://github.com/ZaxbyHub/opencode-swarm/actions/runs/${receipt.run}`,
			);
			expect(block).toContain(`run_duration_ms=${receipt.duration}`);
			expect(block).toContain('queue_wait_ms=unavailable');
			expect(block).not.toContain('queue_wait_ms=0');
			expect(block).toContain('eviction=none');
			expect(block).toContain(
				'eviction_evidence=timeline:add→terminal-merge/remove-pair',
			);
			expect(block).toContain(`timeline_added_at=${receipt.added}`);
			expect(block).toContain(`timeline_merged_at=${receipt.merged}`);
			expect(block).toContain(`timeline_removed_at=${receipt.removed}`);
			expect(block).toContain('unit_shards_executed=6');
			expect(block).toContain(`completed_at=${receipt.completed}`);
			expect(block).toContain('preserved_checks=');
			expect(block).toContain('no intervening re-add');
		}
	});

	test('Stage-A receipt accounting — regression: excludes a skipped release matrix (FB-002/FB-003)', () => {
		const stageAStart = policy.indexOf('### Stage-A post-land receipts');
		const stageAEnd = policy.indexOf('## Cross-contamination warning language');
		const stageAReceiptsSection = policy.slice(stageAStart, stageAEnd);

		// Previously, the record counted a release-please short-circuit with a
		// skipped CI matrix as the third full-matrix receipt.
		expect(stageAReceiptsSection).toContain(
			'Three qualifying full-matrix runs below',
		);
		expect(stageAReceiptsSection).not.toMatch(
			/A third\s+qualifying Stage-A receipt remains pending\./,
		);
		expect(stageAReceiptsSection).not.toContain('remains pending');
		expect(stageAReceiptsSection).toContain(
			'Run `34121635625` is explicitly excluded',
		);
		expect(stageAReceiptsSection).toContain(
			'release-please short-circuit skipped the CI matrix',
		);

		const stageAReceipts = [
			{
				identifier: 'stage-a-post-land-1',
				run: '34091796997',
				duration: '4351000',
				completed: '2026-09-07T07:51:44Z',
				added: '2026-09-07T06:38:55Z',
				merged: '2026-09-07T07:52:10Z',
				removed: '2026-09-07T07:52:10Z',
			},
			{
				identifier: 'stage-a-post-land-2',
				run: '34092376492',
				duration: '4251000',
				completed: '2026-09-07T07:57:59Z',
				added: '2026-09-07T06:46:59Z',
				merged: '2026-09-07T07:58:25Z',
				removed: '2026-09-07T07:58:25Z',
			},
			{
				identifier: 'stage-a-post-land-3',
				run: '34162959243',
				duration: '2113000',
				completed: '2026-09-07T21:58:42Z',
				added: '2026-09-07T21:23:12Z',
				merged: '2026-09-07T21:59:07Z',
				removed: '2026-09-07T21:59:07Z',
			},
		] as const;

		expect(
			stageAReceiptsSection.match(/^identifier=stage-a-post-land-\d+$/gm) ?? [],
		).toHaveLength(3);
		for (const receipt of stageAReceipts) {
			const block = extractReceipt(
				stageAReceiptsSection,
				`identifier=${receipt.identifier}`,
			);
			expect(block).not.toBe('');
			expect(block).toContain(
				`actions=https://github.com/ZaxbyHub/opencode-swarm/actions/runs/${receipt.run}`,
			);
			expect(block).toContain(`run_duration_ms=${receipt.duration}`);
			expect(block).toContain('queue_wait_ms=unavailable');
			expect(block).toContain('eviction=none');
			expect(block).toContain(
				'eviction_evidence=timeline:add→terminal-merge/remove-pair',
			);
			expect(block).toContain(`timeline_added_at=${receipt.added}`);
			expect(block).toContain(`timeline_merged_at=${receipt.merged}`);
			expect(block).toContain(`timeline_removed_at=${receipt.removed}`);
			expect(block).toContain('unit_shards_executed=6');
			expect(block).toContain(`completed_at=${receipt.completed}`);
			expect(block).toContain('preserved_checks=');
			expect(block).toContain('no intervening re-add');
		}
	});
});
