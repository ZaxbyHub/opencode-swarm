import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { JobSummary } from '../../../../scripts/ci/merge-group-stale-runner-classifier';
import {
	AGGREGATE_CASCADE_STEPS,
	AGGREGATE_JOB_NAMES,
	classifyMergeGroupFailure,
	entryMatchesModuleUrl,
	invokedAsMain,
	main,
	runCli,
	SELF_HOSTED_ROUTED_BASE_NAMES,
} from '../../../../scripts/ci/merge-group-stale-runner-classifier';

/*
 * Pins and negative-path coverage added by the pr3490-fb1 feedback round
 * (FB-06/07/13 of the swarm-pr-review handoff): the routing and cascade
 * constants are cross-pinned against ci.yml itself (the #3404 floor test
 * pins ci.yml but knows nothing about this module), and the untested
 * production branches the review's surviving mutants exposed are driven
 * here — malformed payload shapes (FB-13), log-fetch tolerance, guidance
 * lines, usage/gh-failure exit propagation, and the entry-guard helpers.
 */

const CI_YML = readFileSync(
	join(import.meta.dir, '../../../../.github/workflows/ci.yml'),
	'utf8',
).replace(/\r\n/g, '\n');

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

const CHECKOUT_STEP =
	'Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';

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

describe('classifier constants are cross-pinned against ci.yml (FB-06)', () => {
	test('SELF_HOSTED_ROUTED_BASE_NAMES equals the routed job set derived from ci.yml', () => {
		const workflow = yaml.load(CI_YML) as any;
		const routedFromCi = new Set<string>();
		for (const [name, jobDef] of Object.entries<any>(workflow.jobs ?? {})) {
			const runsOn = String(jobDef?.['runs-on'] ?? '');
			if (!runsOn.includes('self-hosted')) continue;
			// Merge-group-only routes: the runbook routes these jobs to the
			// self-hosted pool only on the merge_group event.
			if (!runsOn.includes("github.event_name == 'merge_group'")) continue;
			const osMatrix = jobDef?.strategy?.matrix?.os;
			if (Array.isArray(osMatrix)) {
				for (const os of osMatrix) {
					if (os !== 'windows-latest') routedFromCi.add(name);
				}
			} else {
				routedFromCi.add(name);
			}
		}
		expect([...routedFromCi].sort()).toEqual(
			[...SELF_HOSTED_ROUTED_BASE_NAMES].sort(),
		);
	});

	test('AGGREGATE_CASCADE_STEPS are the exact unit-passed step names in ci.yml', () => {
		for (const stepName of AGGREGATE_CASCADE_STEPS) {
			expect(
				CI_YML.includes(`name: ${stepName}\n`),
				`ci.yml has step "${stepName}"`,
			).toBe(true);
		}
		expect(AGGREGATE_JOB_NAMES).toEqual(['unit-passed']);
	});
});

describe('untested production branches (FB-07/FB-13)', () => {
	test('FB-13: null payload entries and non-array steps degrade to an evidence-gap unknown', () => {
		const jobs = [null, green('detect-release', 1)] as unknown as JobSummary[];
		const result = classifyMergeGroupFailure(jobs, {});
		expect(result.verdict).toBe('unknown');
		// The coerced entry has empty steps, so it surfaces as an evidence gap.
		expect(result.reason).toContain('evidence gap');
		expect(result.reason).toContain('<malformed job entry>');
	});

	test('FB-13: a job without a string name degrades instead of throwing', () => {
		const jobs = [
			{ databaseId: 5, status: 'completed', conclusion: 'failure' },
			green('detect-release', 1),
		] as unknown as JobSummary[];
		const result = classifyMergeGroupFailure(jobs, {});
		expect(result.verdict).toBe('unknown');
	});

	test('FB-13: runCli coerces a steps-not-array payload instead of crashing', () => {
		const io = {
			ghJson: () => ({
				jobs: [
					{
						name: 'quality',
						databaseId: 8,
						status: 'completed',
						conclusion: 'failure',
						steps: 'not-an-array',
					},
				],
			}),
			ghText: () => '',
			log: () => {},
			err: () => {},
		};
		expect(runCli(['--run', '123'], io)).toBe(0);
	});

	test('FB-07: a failing ghText fetch is tolerated — classification continues on step evidence', () => {
		const calls: string[][] = [];
		const out: string[] = [];
		const io = {
			ghJson: () => ({
				jobs: [checkoutDeath('quality', 8), green('detect-release', 1)],
			}),
			ghText(args: string[]) {
				calls.push(args);
				throw new Error('log unavailable');
			},
			log(line: string) {
				out.push(line);
			},
			err: () => {},
		};
		const code = runCli(['--run', '123'], io);
		expect(code).toBe(0);
		expect(calls).toEqual([['run', 'view', '--job', '8', '--log']]);
		expect(out[0]).toBe('runner-stale-clone run=123');
		expect(out.some((line) => line.includes('no log signature fetched'))).toBe(
			true,
		);
	});

	test('FB-07: the test-failure guidance line is printed by the CLI', () => {
		const out: string[] = [];
		const io = {
			ghJson: () => ({
				jobs: [
					job('quality', 'failure', [
						{ name: 'Set up job', conclusion: 'success' },
						{ name: CHECKOUT_STEP, conclusion: 'success' },
						{ name: 'Biome CI', conclusion: 'failure' },
						{ name: 'Complete job', conclusion: 'success' },
					]),
				],
			}),
			ghText: () => '',
			log(line: string) {
				out.push(line);
			},
			err: () => {},
		};
		const code = runCli(['--run', '55'], io);
		expect(code).toBe(0);
		expect(out[0]).toBe('test-failure run=55');
		expect(out.some((line) => line.includes('guidance: real failure'))).toBe(
			true,
		);
	});

	test('FB-07: an unknown-argument usage error exits 1', () => {
		const errors: string[] = [];
		const io = {
			ghJson: () => {
				throw new Error('must not be called');
			},
			ghText: () => '',
			log: () => {},
			err: (line: string) => errors.push(line),
		};
		expect(runCli(['--run', '12', '--bogus'], io)).toBe(1);
		expect(errors[0]).toContain('usage:');
	});

	test('FB-07: a throwing ghJson jobs fetch exits 1 with the gh-call-failed message', () => {
		const errors: string[] = [];
		const io = {
			ghJson: () => {
				throw new Error('rate limited');
			},
			ghText: () => '',
			log: () => {},
			err: (line: string) => errors.push(line),
		};
		expect(runCli(['--run', '77'], io)).toBe(1);
		expect(errors.some((line) => line.includes('gh call failed'))).toBe(true);
	});

	test('FB-07: main() propagates exit code 1 for a usage error through process.exitCode', () => {
		const previous = process.exitCode ?? 0;
		try {
			const io = {
				ghJson: () => {
					throw new Error('must not be called');
				},
				ghText: () => '',
				log: () => {},
				err: () => {},
			};
			main(io, []);
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = previous;
		}
	});

	test('FB-07: the classifier entry-guard helpers mirror the detector contract', () => {
		const scriptUrl = new URL(
			'../../../../scripts/ci/merge-group-stale-runner-classifier.ts',
			import.meta.url,
		).href;
		expect(
			entryMatchesModuleUrl('definitely-not-this-file.ts', scriptUrl),
		).toBe(false);
		// Under Bun the boolean import.meta.main branch decides; imported in
		// this process the guard reads false.
		expect(invokedAsMain()).toBe(false);
	});
});

describe('feedback-round-2 pins (FB-18/19/20)', () => {
	test('FB-20: a hostile conclusion cannot forge lines in the hostedNote reason', () => {
		const ESC = String.fromCharCode(27);
		const NL = String.fromCharCode(10);
		const jobs = [
			checkoutDeath('quality', 8),
			job(
				'unit (windows-latest, 3)',
				`cancelled${NL}forged-reason: runner-stale-clone${ESC}[31m`,
				[],
				13,
			),
			green('detect-release', 1),
		];
		const result = classifyMergeGroupFailure(jobs, {});
		expect(result.verdict).toBe('runner-stale-clone');
		for (let i = 0; i < result.reason.length; i++) {
			const codeUnit = result.reason.charCodeAt(i);
			expect(codeUnit).toBeGreaterThanOrEqual(32);
			expect(codeUnit).not.toBe(127);
		}
	});

	test('FB-18: the evidence-gap reason makes no unverifiable claims', () => {
		const jobs = [job('quality', 'failure', [], 8), green('detect-release', 1)];
		const result = classifyMergeGroupFailure(jobs, {});
		expect(result.verdict).toBe('unknown');
		expect(result.reason).toContain('without attributable step evidence');
		expect(result.reason).toContain('fetched logs, if any, were not consulted');
		// The superseded overclaims must stay gone.
		expect(result.reason).not.toContain('no failing step recorded');
		expect(result.reason).not.toContain('carried no signature');
	});

	test('FB-19: the unknown guidance line prints the runnable run-id form', () => {
		const out: string[] = [];
		const io = {
			ghJson: () => ({
				jobs: [job('quality', 'failure', [], 8), green('detect-release', 1)],
			}),
			ghText: () => '',
			log(line: string) {
				out.push(line);
			},
			err: () => {},
		};
		const code = runCli(['--run', '4242'], io);
		expect(code).toBe(0);
		const guidance = out.find((line) => line.includes('guidance: unknown'));
		expect(guidance).toBeDefined();
		expect(guidance).toContain('gh run view 4242 --log-failed');
	});
});
