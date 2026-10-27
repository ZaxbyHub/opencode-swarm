#!/usr/bin/env bun
/**
 * Merge-group failure classifier for self-hosted runner incidents (issue #3487).
 *
 * When a self-hosted runner's local clone is stale, the merge-queue batch dies
 * at `actions/checkout` with `fatal: git upload-pack: not our ref <sha>`
 * before any test runs; the job list then shows the routed jobs failed, their
 * aggregate dependents failed by cascade, and downstream jobs skipped — while
 * every GitHub-hosted leg is green. Six re-enqueue cycles were burned on the
 * 2026-10-27 incident because nothing named this signature.
 *
 * The classifier is evidence-based, never log-blind: the `gh run view --json
 * jobs` payload carries per-job `steps[]`, and the CHECKOUT STEP's own
 * conclusion places a failure in the checkout phase or the work phase. A
 * real work-phase failure (Biome, type-check, a test, a coverage threshold)
 * can therefore never be excused as a runner problem, even when its log was
 * not fetched; missing evidence yields `unknown`, never a verdict.
 *
 * Job routing tables follow the security floor pinned by
 * tests/unit/scripts/ci/ci-self-hosted-routing.test.ts (issue #3404): on
 * merge_group, quality/coverage/coverage-shard/integration/package-check/
 * security and the ubuntu+macos memory-recall-regression legs run on the
 * self-hosted pool; the windows memory-recall leg and every other job stay
 * GitHub-hosted. The aggregate whitelist is exact — `unit-passed` verifying
 * the unit matrix reports (`Check unit job result` / `Verify unit validation
 * matrix completeness`, ci.yml) is the only job whose failure can be a pure
 * cascade. Anything else failing after a successful checkout is a real
 * failure.
 */

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface JobStep {
	name: string;
	conclusion: string | null;
}

export interface JobSummary {
	name: string;
	databaseId: number;
	status: string;
	conclusion: string | null;
	steps?: JobStep[];
}

export type FailureVerdict = 'runner-stale-clone' | 'test-failure' | 'unknown';

export interface FailureClassification {
	verdict: FailureVerdict;
	reason: string;
}

/** merge_group self-hosted-routed ci.yml jobs (see the routing floor test). */
export const SELF_HOSTED_ROUTED_BASE_NAMES: readonly string[] = [
	'quality',
	'coverage',
	'coverage-shard',
	'integration',
	'package-check',
	'security',
	'memory-recall-regression',
];

/**
 * The only job whose failure can be a pure cascade: it verifies the unit
 * matrix reports produced by other jobs. The step names are exact literals
 * from ci.yml's unit-passed job — a name-pattern match would swallow real
 * work steps such as coverage's `Merge shard reports and enforce threshold`.
 */
export const AGGREGATE_JOB_NAMES: readonly string[] = ['unit-passed'];
export const AGGREGATE_CASCADE_STEPS: readonly string[] = [
	'Check unit job result',
	'Verify unit validation matrix completeness',
];

/** The runner-side checkout signature from the 2026-10-27 incident logs. */
export const STALE_RUNNER_SIGNATURE = /fatal: git upload-pack: not our ref [0-9a-f]{40}/;

const CHECKOUT_STEP_PREFIX = 'Run actions/checkout@';

/** @param name job display name, possibly with a ` (matrix-os)` suffix */
export function baseJobName(name: string): string {
	return (name.split(' (')[0] ?? name).trim();
}

/**
 * Routed-job test per the AC6 floor: base-name membership, with the
 * memory-recall-regression OS special case (ubuntu/macos legs routed, the
 * windows leg stays GitHub-hosted).
 */
export function isRoutedJob(name: string): boolean {
	const base = baseJobName(name);
	if (!SELF_HOSTED_ROUTED_BASE_NAMES.includes(base)) return false;
	if (base === 'memory-recall-regression' && name.includes('(windows-latest)')) return false;
	return true;
}

function checkoutStepOf(job: JobSummary): JobStep | undefined {
	return (job.steps ?? []).find((step) => step.name.startsWith(CHECKOUT_STEP_PREFIX));
}

function failingStepsOf(job: JobSummary): JobStep[] {
	return (job.steps ?? []).filter((step) => step.conclusion === 'failure');
}

/** Job failed at its checkout step (the runner-side incident shape). */
export function checkoutFailed(job: JobSummary): boolean {
	if (job.conclusion !== 'failure') return false;
	const checkout = checkoutStepOf(job);
	return checkout?.conclusion === 'failure';
}

/**
 * Job failed in its work phase: checkout succeeded and a step OUTSIDE the
 * aggregate cascade whitelist failed. Coverage thresholds, lint, type-check
 * and test failures all land here — logs are not required.
 */
export function realWorkFailure(job: JobSummary): boolean {
	if (job.conclusion !== 'failure') return false;
	const checkout = checkoutStepOf(job);
	if (!checkout || checkout.conclusion === 'failure') return false;
	return failingStepsOf(job).some((step) => !AGGREGATE_CASCADE_STEPS.includes(step.name));
}

/** unit-passed failing at only its whitelisted report-verification steps. */
export function cascadeAggregate(job: JobSummary): boolean {
	if (job.conclusion !== 'failure') return false;
	if (!AGGREGATE_JOB_NAMES.includes(baseJobName(job.name))) return false;
	const checkout = checkoutStepOf(job);
	if (!checkout || checkout.conclusion === 'failure') return false;
	const failing = failingStepsOf(job);
	return failing.length > 0 && failing.every((step) => AGGREGATE_CASCADE_STEPS.includes(step.name));
}

/**
 * A failing job the payload cannot place in either phase (no steps, no
 * checkout step, or no failing step recorded). Evidence gaps never satisfy
 * any verdict.
 */
export function evidenceGap(job: JobSummary): boolean {
	if (job.conclusion !== 'failure') return false;
	const steps = job.steps ?? [];
	if (steps.length === 0) return true;
	if (!checkoutStepOf(job)) return true;
	return failingStepsOf(job).length === 0;
}

/**
 * Classify a merge-group run's failure from its job list and per-job logs.
 *
 * Rule 1 — `test-failure` wins: any real work-phase failure (routed or
 * hosted) is reported as a test failure, and a coexisting checkout death is
 * listed in the reason for manual triage; an infra event never masks a real
 * failure.
 * Rule 2 — `runner-stale-clone`: a failing routed job died at checkout, no
 * failing job has an evidence gap, and every failing hosted job is a
 * recognized cascade aggregate. The not-our-ref log literal, when present
 * for such a job, is quoted as confirmation (step evidence is primary).
 */
export function classifyMergeGroupFailure(
	jobs: JobSummary[],
	logs: Record<string, string> = {},
): FailureClassification {
	const list = Array.isArray(jobs) ? jobs : [];
	const failing = list.filter((job) => job.conclusion === 'failure');
	if (failing.length === 0) {
		return { verdict: 'unknown', reason: 'no failures to classify' };
	}

	const workFailures = failing.filter(realWorkFailure);
	if (workFailures.length > 0) {
		const checkoutDeaths = failing.filter(checkoutFailed).map((job) => job.name);
		const reason =
			checkoutDeaths.length > 0
				? `real work-phase failure in ${workFailures.map((job) => job.name).join(', ')} (routed checkout deaths also present: ${checkoutDeaths.join(', ')} — manual triage)`
				: `real work-phase failure in ${workFailures.map((job) => job.name).join(', ')}`;
		return { verdict: 'test-failure', reason };
	}

	const gaps = failing.filter(evidenceGap);
	if (gaps.length > 0) {
		return {
			verdict: 'unknown',
			reason: `evidence gap: ${gaps.map((job) => job.name).join(', ')} failed with no usable step data and no log`,
		};
	}

	const routedCheckoutDeaths = failing.filter((job) => isRoutedJob(job.name) && checkoutFailed(job));
	const badHosted = failing.filter((job) => !isRoutedJob(job.name) && !cascadeAggregate(job));
	if (routedCheckoutDeaths.length === 0 || badHosted.length > 0) {
		const detail =
			badHosted.length > 0
				? `unexplained hosted failure in ${badHosted.map((job) => job.name).join(', ')}`
				: 'no routed job failed at checkout';
		return { verdict: 'unknown', reason: detail };
	}

	const skippedCount = list.filter((job) => job.conclusion === 'skipped').length;
	const confirmations: string[] = [];
	for (const job of routedCheckoutDeaths) {
		const log = logs[job.name];
		if (typeof log === 'string' && STALE_RUNNER_SIGNATURE.test(log)) {
			const match = log.match(STALE_RUNNER_SIGNATURE);
			confirmations.push(`${job.name}: ${match?.[0] ?? ''}`);
		}
	}
	const confirmation =
		confirmations.length > 0
			? `; confirmed by ${confirmations.join('; ')}`
			: '; no log signature fetched — step evidence only';
	return {
		verdict: 'runner-stale-clone',
		reason: `routed jobs failed at checkout (${routedCheckoutDeaths.map((job) => job.name).join(', ')}), ${skippedCount} downstream jobs skipped, hosted legs green modulo cascade${confirmation}`,
	};
}

/** Injectable I/O surface: parsed-JSON calls, raw-log calls, output sinks. */
export interface ClassifierIo {
	ghJson: (args: string[]) => unknown;
	ghText: (args: string[]) => string;
	log: (line: string) => void;
	err: (line: string) => void;
}

const USAGE = 'usage: merge-group-stale-runner-classifier.ts --run <id>';

/** Injectable CLI. Returns the process exit code. */
export function runCli(argv: string[], io: ClassifierIo): number {
	let runId = '';
	const rest = [...(Array.isArray(argv) ? argv : [])];
	while (rest.length > 0) {
		const arg = rest.shift();
		if (arg === '--run') {
			runId = String(rest.shift() ?? '');
		} else {
			io.err(USAGE);
			return 1;
		}
	}
	if (!/^\d+$/.test(runId)) {
		io.err(USAGE);
		return 1;
	}

	let payload: unknown;
	let jobs: JobSummary[];
	try {
		payload = io.ghJson(['run', 'view', runId, '--json', 'jobs']);
		const raw = (payload as { jobs?: unknown } | null)?.jobs;
		if (!Array.isArray(raw)) {
			io.err('run view payload carried no jobs array');
			return 1;
		}
		jobs = raw as JobSummary[];
	} catch (error) {
		io.err(`gh call failed: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}

	const logs: Record<string, string> = {};
	for (const job of jobs) {
		if (job.conclusion === 'failure' && isRoutedJob(job.name)) {
			try {
				logs[job.name] = io.ghText(['run', 'view', '--job', String(job.databaseId), '--log']);
			} catch {
				// Step evidence alone still classifies; the log is confirmatory.
			}
		}
	}

	const result = classifyMergeGroupFailure(jobs, logs);
	io.log(`${result.verdict} run=${runId}`);
	io.log(`reason: ${result.reason}`);
	if (result.verdict === 'runner-stale-clone') {
		io.log(
			'guidance: runner-side — repair is out-of-band (see issue #3487); after repair, re-enqueue idempotently with gh pr merge --auto. Do NOT gh run rerun --failed an evicted batch.',
		);
	} else if (result.verdict === 'test-failure') {
		io.log('guidance: real failure — read the failing job log; do not treat this batch as runner-side.');
	}
	return 0;
}

/** Wires the real bounded `gh` adapter and propagates the exit code. */
export function main(io: Partial<ClassifierIo> = {}, argv: string[] = process.argv.slice(2)): void {
	const cwd = process.cwd();
	const ghJson = (args: string[]): unknown =>
		JSON.parse(
			execFileSync('gh', args, {
				cwd,
				encoding: 'utf8',
				maxBuffer: 16 * 1024 * 1024,
				timeout: 60_000,
				stdio: ['ignore', 'pipe', 'pipe'],
			}) as string,
		);
	const ghText = (args: string[]): string =>
		execFileSync('gh', args, {
			cwd,
			encoding: 'utf8',
			maxBuffer: 16 * 1024 * 1024,
			timeout: 60_000,
			stdio: ['ignore', 'pipe', 'pipe'],
		}) as string;
	const wired: ClassifierIo = {
		ghJson: io.ghJson ?? ghJson,
		ghText: io.ghText ?? ghText,
		log: io.log ?? ((line) => console.log(line)),
		err: io.err ?? ((line) => console.error(line)),
	};
	process.exitCode = runCli(argv, wired);
}

/**
 * Entry-URL comparison used by the Node fallback of `invokedAsMain`.
 * Exported for the entry-guard contract test (under Bun the boolean
 * `import.meta.main` branch decides and this helper never runs in-process).
 */
export function entryMatchesModuleUrl(entry: string, moduleUrl: string): boolean {
	const entryUrl = pathToFileURL(path.resolve(entry)).href;
	return process.platform === 'win32'
		? moduleUrl.toLowerCase() === entryUrl.toLowerCase()
		: moduleUrl === entryUrl;
}

/**
 * Main-entry guard: `import.meta.main` is Bun-only (undefined before Node
 * 22.18), so fall back to an entry-URL comparison — pattern adopted from
 * scripts/repro-2910-v2-host.mjs.
 */
export function invokedAsMain(): boolean {
	if (typeof import.meta.main === 'boolean') return import.meta.main;
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return entryMatchesModuleUrl(entry, import.meta.url);
	} catch {
		return false;
	}
}

if (invokedAsMain()) {
	main();
}
