/**
 * Issue #2473 — AC6/AC7 (NEW-SURFACE): the frozen per-scenario launch budget
 * manifest (tests/unit/tools/dispatch-lanes-launch-budget-manifest.ts) and
 * its validators.
 *
 * AC6: every scenario row carries explicit INTEGER bounds (max_host_launches,
 * max_attempts, wall_clock_ms); observed launch totals from the PRODUCTION
 * entry points stay within the frozen bounds; a row with an unspecified
 * (missing / non-integer / non-positive) bound FAILS validation.
 *
 * AC7: same-model transient retry, model fallback, collection observation,
 * and response wake are accounted in SEPARATE rows with distinct
 * mechanism-qualified owners and their own integer bounds — never conflated.
 *
 * NEW-SURFACE at base: the manifest module statically imports
 * MAX_SESSION_CREATE_GENERATIONS from src/tools/dispatch-lanes.js, which the
 * base commit does not export — this file fails to LOAD at base (intentional;
 * the fix must export the existing contract constant, not a re-hardcoded copy).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import { getAgentConfigs } from '../../../src/agents/index.js';
import { findByBatchId } from '../../../src/background/pending-delegations.js';
import type { PluginConfig } from '../../../src/config/index.js';
import {
	_internals,
	executeDispatchLanes,
	executeDispatchLanesAsync,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import {
	assertWithinBudget,
	CONTRACT_COLLECT_POLL_CEILING_MS,
	CONTRACT_MAX_SESSION_CREATE_GENERATIONS,
	CONTRACT_SAME_MODEL_TRANSIENT_RETRIES_AT_LAUNCH,
	CONTRACT_WAKE_PROMPT_TIMEOUT_MS,
	getScenarioBudget,
	LAUNCH_MECHANISM_KEYS,
	LAUNCH_MECHANISM_OWNERS,
	LAUNCH_SCENARIO_BUDGETS,
	type ScenarioBudgetRow,
	validateScenarioBudget,
} from './dispatch-lanes-launch-budget-manifest.js';

const originalInternals = { ..._internals };
const tempDirs: string[] = [];

function tempProject(): string {
	const directory = canonicalMkdtemp('dispatch-lanes-budget-2473-');
	tempDirs.push(directory);
	return directory;
}

function seedReviewerFallback(): void {
	getAgentConfigs({
		agents: {
			reviewer: {
				model: 'prov/primary-reviewer',
				fallback_models: ['prov/fb1'],
			},
		},
	} as unknown as PluginConfig);
}

async function awaitSignal(
	signal: Promise<unknown>,
	what: string,
): Promise<void> {
	const outcome = await Promise.race([
		signal.then(() => 'signaled' as const),
		new Promise<'timeout'>((resolve) =>
			setTimeout(() => resolve('timeout'), 5_000),
		),
	]);
	if (outcome !== 'signaled') {
		throw new Error(`expected signal not observed within 5000ms: ${what}`);
	}
}

async function waitFor(
	predicate: () => boolean,
	what: string,
	budgetMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(`condition not observed within ${budgetMs}ms: ${what}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function hostLaunchCount(ops: SessionOps): number {
	return (
		ops.create.mock.calls.length +
		ops.prompt.mock.calls.length +
		(ops.promptAsync ? ops.promptAsync.mock.calls.length : 0)
	);
}

/** Same-model transient retries observed at launch (bounded to 0 by contract). */
const OBSERVED_SAME_MODEL_RETRIES_AT_LAUNCH = 0;

afterEach(() => {
	Object.assign(_internals, originalInternals);
	getAgentConfigs({ agents: {} } as unknown as PluginConfig);
	for (const directory of tempDirs.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe('launch budget manifest (issue 2473 AC6)', () => {
	test('exports the configured contract constant the fix must surface', () => {
		expect(CONTRACT_MAX_SESSION_CREATE_GENERATIONS).toBe(2);
		expect(Number.isInteger(CONTRACT_MAX_SESSION_CREATE_GENERATIONS)).toBe(
			true,
		);
	});

	test('every frozen scenario row validates with explicit integer bounds', () => {
		expect(LAUNCH_SCENARIO_BUDGETS.length).toBeGreaterThanOrEqual(6);
		for (const row of LAUNCH_SCENARIO_BUDGETS) {
			expect(() => validateScenarioBudget(row)).not.toThrow();
			expect(Number.isInteger(row.max_host_launches)).toBe(true);
			expect(Number.isInteger(row.max_attempts)).toBe(true);
			expect(Number.isInteger(row.wall_clock_ms)).toBe(true);
			expect(typeof row.retry_owner).toBe('string');
			expect(Object.keys(row.effective_configuration).length).toBeGreaterThan(
				0,
			);
		}
	});

	test('a scenario row with an unspecified or non-integer bound fails validation', () => {
		const valid = getScenarioBudget('create-transient-retry');
		const clone = (): ScenarioBudgetRow => structuredClone(valid);

		const missingBound = clone();
		delete (missingBound as Record<string, unknown>).max_attempts;
		expect(() => validateScenarioBudget(missingBound)).toThrow(
			/max_attempts is unspecified or non-integer/,
		);

		const nonInteger = clone();
		nonInteger.max_host_launches = 1.5;
		expect(() => validateScenarioBudget(nonInteger)).toThrow(
			/max_host_launches is unspecified or non-integer/,
		);

		const nonIntegerWallClock = clone();
		nonIntegerWallClock.wall_clock_ms = Number.NaN;
		expect(() => validateScenarioBudget(nonIntegerWallClock)).toThrow(
			/wall_clock_ms is unspecified or non-integer/,
		);

		const zeroBound = clone();
		zeroBound.max_attempts = 0;
		expect(() => validateScenarioBudget(zeroBound)).toThrow(
			/max_attempts must be a positive integer/,
		);

		const missingMechanism = clone();
		delete missingMechanism.mechanisms.response_wake;
		expect(() => validateScenarioBudget(missingMechanism)).toThrow(
			/mechanism accounting row missing for response_wake/,
		);

		const missingOwner = clone();
		missingOwner.retry_owner = '';
		expect(() => validateScenarioBudget(missingOwner)).toThrow(
			/retry owner is missing/,
		);
	});

	test('create-transient-retry: observed launches stay within the frozen bounds', async () => {
		const directory = tempProject();
		let attempt = 0;
		const ops: SessionOps = {
			create: mock(async () =>
				++attempt === 1
					? { error: { status: 503 } }
					: { data: { id: 'budget-create-retry-session' } },
			),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text', text: 'done' }] },
			})),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const startedAt = Date.now();
		const result = await executeDispatchLanes(
			{ lanes: [{ id: 'budget-create-lane', agent: 'explorer', prompt: 'x' }] },
			directory,
		);
		expect(result.lane_results[0]).toMatchObject({
			status: 'completed',
			generation: 2,
		});

		const hostLaunches = hostLaunchCount(ops);
		assertWithinBudget(getScenarioBudget('create-transient-retry'), {
			host_launches: hostLaunches,
			attempts: hostLaunches + OBSERVED_SAME_MODEL_RETRIES_AT_LAUNCH,
			wall_clock_ms: Date.now() - startedAt,
		});
		expect(hostLaunches).toBe(3);
	});

	test('ambiguous-transport-single-shot: observed launches stay within the frozen bounds', async () => {
		seedReviewerFallback();
		const directory = tempProject();
		let abortSignal!: (value: unknown) => void;
		const aborted = new Promise((resolve) => {
			abortSignal = resolve;
		});
		const ops: SessionOps = {
			create: mock(async () => ({ data: { id: 'budget-ambiguity-session' } })),
			prompt: mock(async () => ({ data: { parts: [] } })),
			promptAsync: mock(async () => {
				throw new Error('fetch failed: ECONNRESET');
			}),
			abort: mock(async () => {
				abortSignal(null);
			}),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		await executeDispatchLanesAsync(
			{
				batch_id: 'budget-ambiguity',
				launch_timeout_ms: 5_000,
				lanes: [
					{ id: 'budget-ambiguity-lane', agent: 'reviewer', prompt: 'x' },
				],
			},
			directory,
		);
		await awaitSignal(aborted, 'ambiguous launch abort');

		const hostLaunches = hostLaunchCount(ops);
		assertWithinBudget(getScenarioBudget('ambiguous-transport-single-shot'), {
			host_launches: hostLaunches,
			attempts: hostLaunches + OBSERVED_SAME_MODEL_RETRIES_AT_LAUNCH,
		});
		expect(hostLaunches).toBe(2);
		expect(findByBatchId(directory, 'budget-ambiguity')[0]?.status).toBe(
			'error',
		);
	});

	test('definitive-rejection-fallback: observed launches stay within the frozen bounds', async () => {
		seedReviewerFallback();
		const directory = tempProject();
		const ops: SessionOps = {
			create: mock(async () => ({ data: { id: 'budget-fallback-session' } })),
			prompt: mock(async () => ({ data: { parts: [] } })),
			promptAsync: mock(async (input) => {
				if (input.body.model?.modelID === 'primary-reviewer') {
					return {
						error: { message: '429 rate_limit_exceeded: too many requests' },
					};
				}
				return { data: { accepted: true } };
			}),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		await executeDispatchLanesAsync(
			{
				batch_id: 'budget-definitive',
				launch_timeout_ms: 5_000,
				lanes: [{ id: 'budget-fallback-lane', agent: 'reviewer', prompt: 'x' }],
			},
			directory,
		);
		await waitFor(
			() =>
				findByBatchId(directory, 'budget-definitive')[0]?.status === 'running',
			'fallback-launched record reaches running',
		);

		const hostLaunches = hostLaunchCount(ops);
		assertWithinBudget(getScenarioBudget('definitive-rejection-fallback'), {
			host_launches: hostLaunches,
			attempts: hostLaunches + OBSERVED_SAME_MODEL_RETRIES_AT_LAUNCH,
		});
		expect(hostLaunches).toBe(3);
	});

	test('timeout-no-retry: observed launches stay within the frozen bounds', async () => {
		seedReviewerFallback();
		const directory = tempProject();
		let abortSignal!: (value: unknown) => void;
		const aborted = new Promise((resolve) => {
			abortSignal = resolve;
		});
		const ops: SessionOps = {
			create: mock(async () => ({ data: { id: 'budget-timeout-session' } })),
			prompt: mock(async () => ({ data: { parts: [] } })),
			promptAsync: mock(async () => await new Promise<never>(() => undefined)),
			abort: mock(async () => {
				abortSignal(null);
			}),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		await executeDispatchLanesAsync(
			{
				batch_id: 'budget-timeout',
				launch_timeout_ms: 10,
				lanes: [{ id: 'budget-timeout-lane', agent: 'reviewer', prompt: 'x' }],
			},
			directory,
		);
		await awaitSignal(aborted, 'timeout launch abort');

		const hostLaunches = hostLaunchCount(ops);
		assertWithinBudget(getScenarioBudget('timeout-no-retry'), {
			host_launches: hostLaunches,
			attempts: hostLaunches + OBSERVED_SAME_MODEL_RETRIES_AT_LAUNCH,
		});
		expect(hostLaunches).toBe(2);
	});

	test('create-cap-exhaustion: observed launches stay within the frozen bounds', async () => {
		const directory = tempProject();
		const ops: SessionOps = {
			create: mock(async () => ({ error: { status: 503 } })),
			prompt: mock(async () => ({ data: { parts: [] } })),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{ lanes: [{ id: 'budget-cap-lane', agent: 'explorer', prompt: 'x' }] },
			directory,
		);
		expect(result.lane_results[0]).toMatchObject({ status: 'failed' });

		const hostLaunches = hostLaunchCount(ops);
		assertWithinBudget(getScenarioBudget('create-cap-exhaustion'), {
			host_launches: hostLaunches,
			attempts: hostLaunches + OBSERVED_SAME_MODEL_RETRIES_AT_LAUNCH,
		});
		expect(hostLaunches).toBe(CONTRACT_MAX_SESSION_CREATE_GENERATIONS);
	});

	test('late-stale-generation-ignored: observed launches stay within the frozen bounds', async () => {
		const directory = tempProject();
		let resolveFirst!: (value: { data: { id: string } }) => void;
		const firstCreate = new Promise<{ data: { id: string } }>((resolve) => {
			resolveFirst = resolve;
		});
		let attempt = 0;
		const ops: SessionOps = {
			create: mock(() =>
				++attempt === 1
					? firstCreate
					: Promise.resolve({ data: { id: 'budget-late-gen2-session' } }),
			),
			prompt: mock(async () => ({ data: { parts: [] } })),
			promptAsync: mock(async () => ({ data: { accepted: true } })),
			abort: mock(async () => undefined),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const launched = await executeDispatchLanesAsync(
			{
				batch_id: 'budget-late-stale',
				launch_timeout_ms: 10,
				lanes: [{ id: 'budget-late-lane', agent: 'explorer', prompt: 'x' }],
			},
			directory,
		);
		expect(launched.lane_results[0]).toMatchObject({ generation: 2 });
		await waitFor(
			() =>
				findByBatchId(directory, 'budget-late-stale')[0]?.status === 'running',
			'generation-2 record reaches running',
		);
		resolveFirst({ data: { id: 'budget-late-gen1-session' } });
		await waitFor(
			() =>
				ops.delete.mock.calls.some(
					(call) => call[0].path.id === 'budget-late-gen1-session',
				),
			'late generation-1 session deleted',
		);

		const hostLaunches = hostLaunchCount(ops);
		assertWithinBudget(getScenarioBudget('late-stale-generation-ignored'), {
			host_launches: hostLaunches,
			attempts: hostLaunches + OBSERVED_SAME_MODEL_RETRIES_AT_LAUNCH,
		});
		expect(hostLaunches).toBe(3);
	});
});

describe('mechanism accounting is separate (issue 2473 AC7)', () => {
	test('mechanism accounting: all four mechanisms carry distinct owners and integer bounds in every scenario', () => {
		for (const row of LAUNCH_SCENARIO_BUDGETS) {
			const keys = Object.keys(row.mechanisms);
			expect(keys.sort()).toEqual([...LAUNCH_MECHANISM_KEYS].sort());
			const owners = keys.map(
				(key) =>
					row.mechanisms[key as (typeof LAUNCH_MECHANISM_KEYS)[number]].owner,
			);
			expect(new Set(owners).size).toBe(LAUNCH_MECHANISM_KEYS.length);
			for (const key of LAUNCH_MECHANISM_KEYS) {
				const mechanism = row.mechanisms[key];
				expect(mechanism.owner).toBe(LAUNCH_MECHANISM_OWNERS[key]);
				expect(Number.isInteger(mechanism.bound)).toBe(true);
				expect(mechanism.bound).toBeGreaterThanOrEqual(0);
			}
			expect(row.mechanisms.same_model_transient_retry.bound).toBe(
				CONTRACT_SAME_MODEL_TRANSIENT_RETRIES_AT_LAUNCH,
			);
			expect(row.mechanisms.collection_observation.bound).toBe(
				CONTRACT_COLLECT_POLL_CEILING_MS,
			);
			expect(row.mechanisms.response_wake.bound).toBe(
				CONTRACT_WAKE_PROMPT_TIMEOUT_MS,
			);
		}
	});

	test('mechanism accounting: same-model retry and fallback bounds are never conflated', () => {
		// On a fallback-configured scenario the four mechanism bounds are
		// pairwise-distinct integers (0 / chain-length / poll ceiling / wake ms).
		const fallbackRow = getScenarioBudget('definitive-rejection-fallback');
		expect(fallbackRow.mechanisms.model_fallback.bound).toBe(1);
		expect(fallbackRow.mechanisms.same_model_transient_retry.bound).toBe(0);
		const bounds = LAUNCH_MECHANISM_KEYS.map(
			(key) => fallbackRow.mechanisms[key].bound,
		);
		expect(new Set(bounds).size).toBe(LAUNCH_MECHANISM_KEYS.length);

		// A no-fallback scenario still accounts model fallback (bound 0) in its
		// OWN row — distinct field, distinct owner — never folded into the
		// same-model retry row.
		const noFallbackRow = getScenarioBudget('create-cap-exhaustion');
		expect(noFallbackRow.mechanisms.model_fallback.bound).toBe(0);
		expect(noFallbackRow.mechanisms.same_model_transient_retry.bound).toBe(0);
		expect(noFallbackRow.mechanisms.model_fallback.owner).not.toBe(
			noFallbackRow.mechanisms.same_model_transient_retry.owner,
		);
	});
});
