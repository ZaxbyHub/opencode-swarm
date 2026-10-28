import { describe, expect, test } from 'bun:test';
import type { JobSummary } from '../../../../scripts/ci/merge-group-stale-runner-classifier';
import { classifyMergeGroupFailure } from '../../../../scripts/ci/merge-group-stale-runner-classifier';

/*
 * Stale-runner classifier negative contract (issue #3487 AC2, frozen check
 * C5). The classifier must NEVER read a runner-side cascade as a test
 * failure, and — the sharper edge — must never excuse a REAL failure as a
 * runner problem: every work-phase failure (routed or hosted, with or
 * without logs), every evidence gap, and every log-string coincidence routes
 * to test-failure or unknown instead.
 *
 * The cascade fixture mirrors run 40542293866; the control fixtures mutate
 * one dimension at a time (step where the failure sits, routing of the
 * failing job, log content, step-data presence).
 */

const CHECKOUT_STEP =
	'Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const NOT_OUR_REF_LINE =
	'fatal: git upload-pack: not our ref 67fda011e4611d2824fc4363ae1da1564da1fcb0';

interface Step {
	name: string;
	conclusion: string;
}

function job(
	name: string,
	conclusion: string,
	steps: Step[],
	databaseId = 1,
): JobSummary {
	return { name, databaseId, status: 'completed', conclusion, steps };
}

function green(name: string, databaseId = 1): JobSummary {
	return job(
		name,
		'success',
		[
			{ name: 'Set up job', conclusion: 'success' },
			{ name: CHECKOUT_STEP, conclusion: 'success' },
			{ name: 'Complete job', conclusion: 'success' },
		],
		databaseId,
	);
}

function checkoutDeath(name: string, databaseId = 1): JobSummary {
	return job(
		name,
		'failure',
		[
			{ name: 'Set up job', conclusion: 'success' },
			{ name: CHECKOUT_STEP, conclusion: 'failure' },
			{ name: 'Install dependencies', conclusion: 'skipped' },
			{ name: 'Complete job', conclusion: 'success' },
		],
		databaseId,
	);
}

function workFailure(
	name: string,
	failedStep: string,
	databaseId = 1,
): JobSummary {
	return job(
		name,
		'failure',
		[
			{ name: 'Set up job', conclusion: 'success' },
			{ name: CHECKOUT_STEP, conclusion: 'success' },
			{ name: failedStep, conclusion: 'failure' },
			{ name: 'Complete job', conclusion: 'success' },
		],
		databaseId,
	);
}

/** The 17-job incident cascade (hosted legs green, 7 skipped, no logs). */
function cascadeFixture(): JobSummary[] {
	return [
		green('detect-release', 1),
		green('detect-paths', 2),
		green('memory-recall-regression (macos-latest)', 3),
		green('release-owner-guard', 4),
		checkoutDeath('memory-recall-regression (ubuntu-latest)', 5),
		green('rust-sandbox-runner', 6),
		green('memory-recall-regression (windows-latest)', 7),
		checkoutDeath('quality', 8),
		job(
			'unit-passed',
			'failure',
			[
				{ name: 'Set up job', conclusion: 'success' },
				{ name: CHECKOUT_STEP, conclusion: 'success' },
				{ name: 'Check unit job result', conclusion: 'failure' },
				{
					name: 'Verify unit validation matrix completeness',
					conclusion: 'failure',
				},
				{ name: 'Complete job', conclusion: 'success' },
			],
			9,
		),
		checkoutDeath('coverage', 10),
		job('php-validation', 'skipped', [], 11),
		job('package-check', 'skipped', [], 12),
		job('unit', 'skipped', [], 13),
		job('integration', 'skipped', [], 14),
		job('security', 'skipped', [], 15),
		job('coverage-shard', 'skipped', [], 16),
		job('smoke', 'skipped', [], 17),
	];
}

describe('merge-group stale-runner classifier negative (C5, issue #3487 AC2)', () => {
	test('the incident cascade with no logs reads runner-side, never test-failure', () => {
		const result = classifyMergeGroupFailure(cascadeFixture(), {});
		expect(result.verdict).toBe('runner-stale-clone');
		expect(result.verdict).not.toBe('test-failure');
		// The seven skipped jobs and the unit-passed report-verify failures are
		// cascade evidence, never test evidence.
		expect(result.reason).toContain('7 downstream jobs skipped');
	});

	test('routed quality failing at Biome CI (checkout succeeded, no log) → test-failure', () => {
		const jobs = [
			green('detect-release', 1),
			workFailure('quality', 'Biome CI', 8),
			green('unit-passed', 9),
		];
		const result = classifyMergeGroupFailure(jobs, {});
		expect(result.verdict).toBe('test-failure');
		expect(result.reason).toContain('quality');
	});

	test('routed coverage-threshold failure (Merge shard reports and enforce threshold) → test-failure', () => {
		// PC-10 probe: a step-NAME pattern would classify this real work step as
		// cascade; the explicit whitelist must not contain it.
		const jobs = [
			green('detect-release', 1),
			workFailure('coverage', 'Merge shard reports and enforce threshold', 10),
			green('unit-passed', 9),
		];
		const result = classifyMergeGroupFailure(jobs, {});
		expect(result.verdict).toBe('test-failure');
		expect(result.reason).toContain('coverage');
	});

	test('routed checkout death coexisting with a routed work failure → test-failure wins', () => {
		// A checkout death can never mask a coexisting real failure.
		const jobs = [
			green('detect-release', 1),
			checkoutDeath('quality', 8),
			workFailure('coverage', 'Merge shard reports and enforce threshold', 10),
			job(
				'unit-passed',
				'failure',
				[
					{ name: 'Set up job', conclusion: 'success' },
					{ name: CHECKOUT_STEP, conclusion: 'success' },
					{ name: 'Check unit job result', conclusion: 'failure' },
					{
						name: 'Verify unit validation matrix completeness',
						conclusion: 'failure',
					},
					{ name: 'Complete job', conclusion: 'success' },
				],
				9,
			),
		];
		const result = classifyMergeGroupFailure(jobs, {});
		expect(result.verdict).toBe('test-failure');
		expect(result.reason).toContain('checkout deaths also present');
		expect(result.reason).toContain('quality');
	});

	test('hosted unit shard test failure with assertion output → test-failure', () => {
		const jobs = [
			green('detect-release', 1),
			green('quality', 8),
			workFailure('unit (windows-latest, 3)', 'Run unit shard', 13),
		];
		const result = classifyMergeGroupFailure(jobs, {
			'unit (windows-latest, 3)':
				'(fail) archive.test.ts > retention boundary\nExpected: 1\nReceived: 2',
		});
		expect(result.verdict).toBe('test-failure');
		expect(result.reason).toContain('unit (windows-latest, 3)');
	});

	test('all-green job list with a log quoting the signature → unknown, never runner-stale-clone', () => {
		const jobs = [green('detect-release', 1), green('quality', 8)];
		const result = classifyMergeGroupFailure(jobs, {
			quality: `docs mention ${NOT_OUR_REF_LINE}`,
		});
		expect(result.verdict).toBe('unknown');
		expect(result.reason).toContain('no failures to classify');
	});

	test('failing job with NO step data and no log → unknown with an evidence-gap reason', () => {
		const jobs = [green('detect-release', 1), job('quality', 'failure', [], 8)];
		const result = classifyMergeGroupFailure(jobs, {});
		expect(result.verdict).toBe('unknown');
		expect(result.reason).toContain('evidence gap');
		expect(result.reason).toContain('quality');
	});

	test('routed checkout death + hosted failure with missing steps → unknown (evidence gap blocks)', () => {
		// PC-11 probe: an evidence-less hosted failure must never be treated as
		// green, so the runner-side verdict cannot fire.
		const jobs = [
			checkoutDeath('quality', 8),
			job('unit-passed', 'failure', [], 9),
			green('detect-release', 1),
		];
		const result = classifyMergeGroupFailure(jobs, {});
		expect(result.verdict).toBe('unknown');
		expect(result.reason).toContain('unit-passed');
	});

	test('unit-passed failing at a NON-whitelisted step → test-failure (whitelist exactness)', () => {
		const jobs = [
			green('detect-release', 1),
			job(
				'unit-passed',
				'failure',
				[
					{ name: 'Set up job', conclusion: 'success' },
					{ name: CHECKOUT_STEP, conclusion: 'success' },
					{ name: 'Download unit validation reports', conclusion: 'failure' },
					{ name: 'Complete job', conclusion: 'success' },
				],
				9,
			),
		];
		const result = classifyMergeGroupFailure(jobs, {});
		expect(result.verdict).toBe('test-failure');
		expect(result.reason).toContain('unit-passed');
	});

	test('signature in a work-phase failure log cannot rescue the runner-side verdict', () => {
		// PC-3 probe: a test log that happens to quote the literal still belongs
		// to a job whose checkout SUCCEEDED — the verdict follows the steps.
		const jobs = [
			green('detect-release', 1),
			workFailure('quality', 'Biome CI', 8),
		];
		const result = classifyMergeGroupFailure(jobs, {
			quality: `echo ${NOT_OUR_REF_LINE}`,
		});
		expect(result.verdict).toBe('test-failure');
	});
});

describe('feedback-round regressions (pr3490-fb1: FB-06/09/10/14)', () => {
	test('FB-06: a HOSTED checkout death beside a routed checkout death → unknown, never runner-stale-clone', () => {
		// The badHosted gate: a hosted (non-unit-passed) job that also died at
		// checkout is unexplained — the runner-side verdict must not absorb it.
		const jobs = [
			checkoutDeath('quality', 8),
			checkoutDeath('unit (windows-latest, 3)', 13),
			green('detect-release', 1),
		];
		const result = classifyMergeGroupFailure(jobs, {});
		expect(result.verdict).toBe('unknown');
		expect(result.reason).toContain('unexplained failure');
		expect(result.reason).toContain('unit (windows-latest, 3)');
	});

	test('FB-14: a failing ROUTED job with only whitelisted-named steps is not masked', () => {
		// coverage failing only at a step NAMED like the unit-passed cascade:
		// realWorkFailure=false (whitelisted name), cascadeAggregate=false
		// (wrong job), checkoutFailed=false — the unexplained rule must catch it.
		const jobs = [
			checkoutDeath('quality', 8),
			workFailure('coverage', 'Check unit job result', 10),
			green('detect-release', 1),
		];
		const result = classifyMergeGroupFailure(jobs, {});
		expect(result.verdict).toBe('unknown');
		expect(result.verdict).not.toBe('runner-stale-clone');
		expect(result.reason).toContain('coverage');
	});

	test('FB-10: coverage failing at its fail-closed shard check → test-failure (conservative, not whitelisted)', () => {
		const jobs = [
			green('detect-release', 1),
			workFailure('quality', 'Merge shard reports and enforce threshold', 8),
			workFailure('coverage', 'Check coverage shard results (fail closed)', 10),
		];
		const result = classifyMergeGroupFailure(jobs, {});
		expect(result.verdict).toBe('test-failure');
		expect(result.reason).toContain('coverage');
	});

	test('FB-09: a cancelled hosted leg is named in the reason instead of "hosted legs green"', () => {
		const jobs = [
			checkoutDeath('quality', 8),
			job('unit (windows-latest, 3)', 'cancelled', [], 13),
			green('detect-release', 1),
		];
		const result = classifyMergeGroupFailure(jobs, {});
		expect(result.verdict).toBe('runner-stale-clone');
		expect(result.reason).toContain('hosted legs not green');
		expect(result.reason).toContain('unit (windows-latest, 3) (cancelled)');
	});

	test('FB-12: control characters in job names cannot forge reason lines', async () => {
		const { sanitizeJobName } = await import(
			'../../../../scripts/ci/merge-group-stale-runner-classifier'
		);
		const ESC = String.fromCharCode(27);
		const NL = String.fromCharCode(10);
		const hostile = `quality${NL}runner-stale-clone run=9999${ESC}[31mVERDICT${ESC}[0m`;
		const jobs = [
			checkoutDeath('quality', 8),
			job(hostile, 'failure', [], 99),
			green('detect-release', 1),
		];
		const result = classifyMergeGroupFailure(jobs, {});
		expect(result.verdict).toBe('unknown');
		// No raw control character survives into the echoed reason.
		for (let i = 0; i < result.reason.length; i++) {
			const codeUnit = result.reason.charCodeAt(i);
			expect(codeUnit).toBeGreaterThanOrEqual(32);
			expect(codeUnit).not.toBe(127);
		}
		expect(sanitizeJobName(`a${NL}b`)).toBe('a b');
		expect(sanitizeJobName(`${ESC}[31m`)).toBe(' [31m');
	});
});
