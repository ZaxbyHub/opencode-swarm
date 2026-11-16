import { describe, expect, test } from 'bun:test';
import {
	AGGREGATE_CASCADE_STEPS,
	baseJobName,
	classifyMergeGroupFailure,
	isRoutedJob,
	main,
	runCli,
	STALE_RUNNER_SIGNATURE,
} from '../../../../scripts/ci/merge-group-stale-runner-classifier';

/*
 * Stale-runner classifier positive contract (issue #3487 AC1, frozen check
 * C4). The fixture reproduces merge-group run 40542293866 (the 2026-10-27
 * incident) verbatim: the three failing routed jobs (quality, coverage,
 * memory-recall-regression ubuntu) each died at their
 * `Run actions/checkout@…` step with every later step skipped, the hosted
 * aggregate unit-passed failed only at its whitelisted report-verification
 * steps, the GitHub-hosted legs succeeded, and seven downstream jobs were
 * skipped. Step names are exact literals from the live payload — any future
 * ci.yml rename that would invalidate the evidence model must fail here.
 */

const CHECKOUT_STEP =
	'Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const NOT_OUR_REF_LINE =
	'fatal: git upload-pack: not our ref 67fda011e4611d2824fc4363ae1da1564da1fcb0';

interface FixtureStep {
	name: string;
	conclusion: string;
}

interface FixtureJob {
	name: string;
	databaseId: number;
	status: string;
	conclusion: string;
	steps: FixtureStep[];
}

function checkoutDeathJob(name: string, databaseId: number): FixtureJob {
	return {
		name,
		databaseId,
		status: 'completed',
		conclusion: 'failure',
		steps: [
			{ name: 'Set up job', conclusion: 'success' },
			{
				name: 'Isolate temp dir on self-hosted runners',
				conclusion: 'success',
			},
			{ name: CHECKOUT_STEP, conclusion: 'failure' },
			{ name: 'Install dependencies', conclusion: 'skipped' },
			{ name: 'Complete job', conclusion: 'success' },
		],
	};
}

function greenJob(name: string, databaseId: number): FixtureJob {
	return {
		name,
		databaseId,
		status: 'completed',
		conclusion: 'success',
		steps: [
			{ name: 'Set up job', conclusion: 'success' },
			{ name: CHECKOUT_STEP, conclusion: 'success' },
			{ name: 'Complete job', conclusion: 'success' },
		],
	};
}

function skippedJob(name: string, databaseId: number): FixtureJob {
	return {
		name,
		databaseId,
		status: 'completed',
		conclusion: 'skipped',
		steps: [],
	};
}

/** The 17-job incident shape (run 40542293866). */
function incidentJobs(): FixtureJob[] {
	return [
		greenJob('detect-release', 1),
		greenJob('detect-paths', 2),
		greenJob('memory-recall-regression (macos-latest)', 3),
		greenJob('release-owner-guard', 4),
		checkoutDeathJob('memory-recall-regression (ubuntu-latest)', 5),
		greenJob('rust-sandbox-runner', 6),
		greenJob('memory-recall-regression (windows-latest)', 7),
		checkoutDeathJob('quality', 8),
		{
			name: 'unit-passed',
			databaseId: 9,
			status: 'completed',
			conclusion: 'failure',
			steps: [
				{ name: 'Set up job', conclusion: 'success' },
				{ name: CHECKOUT_STEP, conclusion: 'success' },
				{
					name: 'Install dependencies for the report verifier',
					conclusion: 'success',
				},
				{ name: 'Check unit job result', conclusion: 'failure' },
				{ name: 'Download unit validation reports', conclusion: 'success' },
				{
					name: 'Verify unit validation matrix completeness',
					conclusion: 'failure',
				},
				{ name: 'Complete job', conclusion: 'success' },
			],
		},
		checkoutDeathJob('coverage', 10),
		skippedJob('php-validation', 11),
		skippedJob('package-check', 12),
		skippedJob('unit', 13),
		skippedJob('integration', 14),
		skippedJob('security', 15),
		skippedJob('coverage-shard', 16),
		skippedJob('smoke', 17),
	];
}

describe('merge-group stale-runner classifier positive (C4, issue #3487 AC1)', () => {
	test('incident shape + not-our-ref log → runner-stale-clone, never test-failure', () => {
		const result = classifyMergeGroupFailure(incidentJobs(), {
			quality: `...\n${NOT_OUR_REF_LINE}\nThe process '/usr/bin/git' failed with exit code 128`,
		});
		expect(result.verdict).toBe('runner-stale-clone');
		expect(result.verdict).not.toBe('test-failure');
		expect(result.reason).toContain(NOT_OUR_REF_LINE);
		expect(result.reason).toContain('quality');
		expect(result.reason).toContain('7 downstream jobs skipped');
	});

	test('same shape with NO logs at all stays runner-stale-clone (step evidence is primary)', () => {
		const result = classifyMergeGroupFailure(incidentJobs(), {});
		expect(result.verdict).toBe('runner-stale-clone');
		expect(result.reason).toContain('no log signature fetched');
	});

	test('signature regex accepts exactly 40 lowercase hex digits', () => {
		expect(STALE_RUNNER_SIGNATURE.test(NOT_OUR_REF_LINE)).toBe(true);
		expect(
			STALE_RUNNER_SIGNATURE.test(
				'fatal: git upload-pack: not our ref 67fda011e4611d2824fc4363ae1da1564da1fcb',
			),
		).toBe(false); // 39 hex
		expect(
			STALE_RUNNER_SIGNATURE.test(
				'fatal: git upload-pack: not our ref 67FDA011E4611D2824FC4363AE1DA1564DA1FCB0',
			),
		).toBe(false); // uppercase
		expect(
			STALE_RUNNER_SIGNATURE.test('fatal: git upload-pack: not our ref main'),
		).toBe(false);
	});

	test('routing table: macos memory-recall leg is routed, windows leg is hosted', () => {
		expect(isRoutedJob('memory-recall-regression (ubuntu-latest)')).toBe(true);
		expect(isRoutedJob('memory-recall-regression (macos-latest)')).toBe(true);
		expect(isRoutedJob('memory-recall-regression (windows-latest)')).toBe(
			false,
		);
		expect(isRoutedJob('quality')).toBe(true);
		expect(isRoutedJob('unit (windows-latest, 3)')).toBe(false);
		expect(baseJobName('unit (windows-latest, 3)')).toBe('unit');
	});

	test('macos routed leg succeeding does not block the verdict (routed ≠ all-failing)', () => {
		// Already asserted structurally by the incident fixture (macos leg is
		// green there); pin the predicate composition explicitly too.
		const jobs = incidentJobs();
		const routed = jobs.filter((job) => isRoutedJob(job.name));
		expect(routed.some((job) => job.conclusion === 'success')).toBe(true);
		expect(classifyMergeGroupFailure(jobs, {}).verdict).toBe(
			'runner-stale-clone',
		);
	});

	test('aggregate whitelist carries the exact ci.yml step literals', () => {
		expect(AGGREGATE_CASCADE_STEPS).toEqual([
			'Check unit job result',
			'Verify unit validation matrix completeness',
		]);
	});

	test('CLI: prints the verdict line and fetches logs for EVERY failing routed job by databaseId', () => {
		const jsonCalls: string[][] = [];
		const textCalls: string[][] = [];
		const out: string[] = [];
		const io = {
			ghJson(args: string[]) {
				jsonCalls.push(args);
				if (args.join(' ') === 'run view 40542293866 --json jobs') {
					return { jobs: incidentJobs() };
				}
				throw new Error(`unexpected ghJson args: ${args.join(' ')}`);
			},
			ghText(args: string[]) {
				textCalls.push(args);
				return `...\n${NOT_OUR_REF_LINE}\n...`;
			},
			log(line: string) {
				out.push(line);
			},
			err(line: string) {
				out.push(`ERR: ${line}`);
			},
		};
		const code = runCli(['--run', '40542293866'], io);
		expect(code).toBe(0);
		expect(jsonCalls).toEqual([
			['run', 'view', '40542293866', '--json', 'jobs'],
		]);
		// Failing routed jobs: quality (8), memory-recall ubuntu (5), coverage (10).
		// unit-passed (9) is hosted — no log fetch for it.
		expect(textCalls).toEqual([
			['run', 'view', '--job', '5', '--log'],
			['run', 'view', '--job', '8', '--log'],
			['run', 'view', '--job', '10', '--log'],
		]);
		expect(out[0]).toBe('runner-stale-clone run=40542293866');
		expect(out.some((line) => line.includes('reason:'))).toBe(true);
	});

	test('main(io, argv) propagates exit code 0 through process.exitCode', () => {
		const previous = process.exitCode;
		process.exitCode = 1;
		try {
			const io = {
				ghJson: () => ({ jobs: incidentJobs() }),
				ghText: () => NOT_OUR_REF_LINE,
				log: () => {},
				err: () => {},
			};
			main(io, ['--run', '40542293866']);
			expect(process.exitCode).toBe(0);
		} finally {
			process.exitCode = previous;
		}
	});

	test('usage: missing or non-numeric --run is an error (exit 1)', () => {
		const errors: string[] = [];
		const io = {
			ghJson: () => {
				throw new Error('must not be called');
			},
			ghText: () => '',
			log: () => {},
			err: (line: string) => errors.push(line),
		};
		expect(runCli([], io)).toBe(1);
		expect(runCli(['--run', 'abc'], io)).toBe(1);
		expect(errors.every((line) => line.includes('usage:'))).toBe(true);
	});
});
