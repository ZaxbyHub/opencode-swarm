/**
 * Issue #2473 — AC5 + AC1 non-retryable half (preserving characterization):
 * cap enforcement and timeout no-retry at the production launch entry points.
 * These pin EXISTING behavior (PR #2091) that must be GREEN on the base
 * commit (08be83096) and stay green after the fix:
 *
 *  - An acceptance TIMEOUT at the prompt/promptAsync launch is never retried
 *    and never re-dispatched — even when a fallback model is configured. A
 *    withTimeout rejection is a plain Error, so the issue-#2473 launch
 *    classify gate (instanceof LanePromptLaunchRejectionError) falls through
 *    to its 'permanent' default — the pre-fix `/timed out/i` special case is
 *    subsumed by that default, because a timed-out acceptance cannot prove
 *    the host never accepted the prompt.
 *  - The session.create retry cap is enforced: an always-transient create
 *    stops after exactly 2 generations (the frozen
 *    MAX_SESSION_CREATE_GENERATIONS = 2, src/tools/dispatch-lanes.ts), never
 *    prompts, and surfaces the terminal failure plus generation on the lane
 *    result (the recovery signal an operator reads).
 *
 * The integer-bound projection of the cap scenario lives in
 * dispatch-lanes-launch-budget-manifest.ts (asserted by
 * dispatch-lanes-launch-budget-2473.test.ts).
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

const originalInternals = { ..._internals };
const tempDirs: string[] = [];

function tempProject(): string {
	const directory = canonicalMkdtemp('dispatch-lanes-timeout-2473-');
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

/** Bounded real-timer wait for a cleanup signal — fails loudly, never hangs. */
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
		throw new Error(
			`expected cleanup signal not observed within 5000ms: ${what}`,
		);
	}
}

/** Bounded attempt-counted poll — fails loudly instead of hanging on a missed condition. */
async function waitFor(
	predicate: () => boolean,
	what: string,
	maxAttempts = 500,
): Promise<void> {
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(
		`condition not observed within ${maxAttempts} attempts: ${what}`,
	);
}

afterEach(() => {
	Object.assign(_internals, originalInternals);
	getAgentConfigs({ agents: {} } as unknown as PluginConfig);
	for (const directory of tempDirs.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe('launch timeout and create cap bounds (issue 2473 AC5)', () => {
	test('promptAsync acceptance timeout is never retried, even with a fallback model configured', async () => {
		seedReviewerFallback();
		const directory = tempProject();
		let abortSignal!: (value: unknown) => void;
		const aborted = new Promise((resolve) => {
			abortSignal = resolve;
		});
		const ops: SessionOps = {
			create: mock(async () => ({ data: { id: 'timeout-async-session' } })),
			prompt: mock(async () => ({ data: { parts: [] } })),
			// Never settles: raced by withTimeout's real 10 ms timer.
			promptAsync: mock(async () => await new Promise<never>(() => undefined)),
			abort: mock(async () => {
				abortSignal(null);
			}),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const launched = await executeDispatchLanesAsync(
			{
				batch_id: 'timeout-no-retry-async',
				launch_timeout_ms: 10,
				lanes: [{ id: 'timeout-lane', agent: 'reviewer', prompt: 'inspect' }],
			},
			directory,
		);
		expect(launched.lane_results[0]).toMatchObject({
			status: 'pending',
			generation: 1,
		});
		await awaitSignal(aborted, 'timeout launch-error abort');

		expect(ops.promptAsync).toHaveBeenCalledTimes(1);
		expect(ops.create).toHaveBeenCalledTimes(1);
		// Launch-error settlement tears the never-accepted session down
		// (abort -> delete); a wedged or skipped delete would strand the host
		// session behind a terminal record. Teardown is fire-and-forget, so
		// poll for the delete rather than assuming it landed with the abort.
		await waitFor(
			() => ops.delete.mock.calls.length > 0,
			'session deleted after launch error',
		);
		expect(ops.delete).toHaveBeenCalledTimes(1);
		const record = findByBatchId(directory, 'timeout-no-retry-async')[0];
		expect(record?.status).toBe('error');
		expect(record?.generation).toBe(1);
	});

	test('a definitive rejection whose message mentions "timed out" WITH a transient token still fails over (clause-removal pin)', async () => {
		// The pre-#2473 classify had a `/timed out/i -> permanent` clause that
		// ran BEFORE the transient-pattern check, so a definitive server
		// rejection (result.error envelope) carrying both "timed out" and a
		// transient token (here: 504) was permanently single-shot. The
		// instanceof-based gate removed that precedence: a rejection class with
		// a transient-matching message is failover-eligible. This test fails on
		// the pre-fix clause (1 launch) and passes on the fix (2 launches).
		seedReviewerFallback();
		const directory = tempProject();
		const seenModels: string[] = [];
		const ops: SessionOps = {
			create: mock(async () => ({ data: { id: 'timeout-504-session' } })),
			prompt: mock(async () => ({ data: { parts: [] } })),
			promptAsync: mock(async (input) => {
				seenModels.push(input.body.model?.modelID ?? '(default)');
				if (input.body.model?.modelID === 'primary-reviewer') {
					return {
						error: { message: '504 gateway timeout: request timed out' },
					};
				}
				return { data: { accepted: true } };
			}),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		await executeDispatchLanesAsync(
			{
				batch_id: 'timeout-504-failover',
				launch_timeout_ms: 5_000,
				lanes: [
					{ id: 'timeout-504-lane', agent: 'reviewer', prompt: 'inspect' },
				],
			},
			directory,
		);
		await waitFor(
			() =>
				findByBatchId(directory, 'timeout-504-failover')[0]?.status ===
				'running',
			'fallback record reaches running',
		);

		expect(ops.promptAsync).toHaveBeenCalledTimes(2);
		expect(seenModels).toEqual(['primary-reviewer', 'fb1']);
		const record = findByBatchId(directory, 'timeout-504-failover')[0];
		expect(record?.status).toBe('running');
	});

	test('blocking prompt timeout is never retried, even with a fallback model configured', async () => {
		seedReviewerFallback();
		const directory = tempProject();
		const ops: SessionOps = {
			create: mock(async () => ({ data: { id: 'timeout-block-session' } })),
			// Never settles: raced by withTimeout's real 10 ms timer.
			prompt: mock(async () => await new Promise<never>(() => undefined)),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{
				timeout_ms: 10,
				lanes: [
					{ id: 'timeout-block-lane', agent: 'reviewer', prompt: 'inspect' },
				],
			},
			directory,
		);

		expect(ops.prompt).toHaveBeenCalledTimes(1);
		expect(ops.create).toHaveBeenCalledTimes(1);
		expect(result.success).toBe(false);
		expect(result.lane_results[0]).toMatchObject({
			status: 'failed',
			generation: 1,
		});
		expect(String(result.lane_results[0]?.error)).toContain('timed out');
	});

	test('create cap: always-transient create stops at exactly 2 generations and never prompts (blocking)', async () => {
		const directory = tempProject();
		const ops: SessionOps = {
			create: mock(async () => ({ error: { status: 503 } })),
			prompt: mock(async () => ({ data: { parts: [] } })),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const result = await executeDispatchLanes(
			{
				lanes: [{ id: 'cap-block-lane', agent: 'explorer', prompt: 'inspect' }],
			},
			directory,
		);

		// Frozen integer cap: MAX_SESSION_CREATE_GENERATIONS = 2.
		expect(ops.create).toHaveBeenCalledTimes(2);
		expect(ops.prompt).not.toHaveBeenCalled();
		expect(result.lane_results[0]).toMatchObject({
			status: 'failed',
			generation: 2,
		});
		// Final failure surfaces the terminal state + recovery path (the
		// operator-visible reason the lane stopped).
		expect(String(result.lane_results[0]?.error)).toContain(
			'session.create failed',
		);
	});

	test('create cap: async exhaustion surfaces the failed generation-2 terminal immediately', async () => {
		const directory = tempProject();
		const ops: SessionOps = {
			create: mock(async () => ({ error: { status: 503 } })),
			prompt: mock(async () => ({ data: { parts: [] } })),
			promptAsync: mock(async () => ({ data: { accepted: true } })),
			delete: mock(async () => undefined),
		};
		_internals.getSessionOps = () => ops;

		const launched = await executeDispatchLanesAsync(
			{
				batch_id: 'cap-async-exhausted',
				lanes: [{ id: 'cap-async-lane', agent: 'explorer', prompt: 'inspect' }],
			},
			directory,
		);

		expect(ops.create).toHaveBeenCalledTimes(2);
		expect(ops.promptAsync).not.toHaveBeenCalled();
		expect(launched.lane_results[0]).toMatchObject({
			status: 'failed',
			generation: 2,
		});
		// No session ever existed, so no ledger record is written — the lane
		// result itself is the surfaced terminal (mirrors the existing
		// create-retry exhaustion test's shape).
		expect(launched.lane_results[0]?.error).toContain('session.create failed');
	});
});
