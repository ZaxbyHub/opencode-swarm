/**
 * Issue #2473 — AC1/AC4 (discriminating half): an AMBIGUOUS transport-level
 * failure at the prompt/promptAsync LAUNCH call (a thrown error with no server
 * response — ECONNRESET / ETIMEDOUT — where host acceptance is unknowable)
 * must keep the launch SINGLE-SHOT. Retrying or re-dispatching to a fallback
 * model would issue a second potentially-accepted prompt from one logical lane
 * launch (duplicate uncertain execution).
 *
 * Drives the production entry points `executeDispatchLanesAsync`
 * (session.promptAsync launch) and `executeDispatchLanes` (session.prompt
 * launch) with a configured fallback chain (getAgentConfigs), makes the launch
 * call THROW, and asserts EXACTLY ONE launch call plus a settled error ledger
 * record. The thrown messages are transport-level failures that match
 * TRANSIENT_MODEL_ERROR_PATTERN but carry no server response — the definitive
 * half (an error RESULT, e.g. 429) staying fallback-eligible is pinned
 * separately in dispatch-lanes-model-fallback.test.ts (PRESERVING).
 *
 * Base behavior (08be83096): the launch classify callbacks
 * (src/tools/dispatch-lanes.ts startAsyncLanePrompt / runLane) route these
 * messages to 'transient', so dispatchWithModelFallback advances the fallback
 * index and launches AGAIN on the same session — 2 launches. These tests are
 * RED at base by design (see 02-reproduction.md command 1).
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

/** Deterministic failure text for the base-run log (grep-anchored by check C1). */
function assertSingleLaunch(
	count: number,
	kind: string,
	models: string[],
): void {
	if (count !== 1) {
		throw new Error(
			`AC1 violated: ambiguous transport failure was re-dispatched ${count} times at ${kind} (models=${JSON.stringify(models)}); expected exactly 1 launch — acceptance by the host is unprovable for a thrown transport failure`,
		);
	}
	expect(count).toBe(1);
}

function tempProject(): string {
	const directory = canonicalMkdtemp('dispatch-lanes-ambiguity-2473-');
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

afterEach(() => {
	Object.assign(_internals, originalInternals);
	getAgentConfigs({ agents: {} } as unknown as PluginConfig);
	for (const directory of tempDirs.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

/** Race a cleanup signal against a real bounded timer so a missing cleanup fails, never hangs. */
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

const AMBIGUOUS_MESSAGES = [
	'fetch failed: ECONNRESET',
	'fetch failed: ETIMEDOUT',
];

describe('dispatch-lanes launch ambiguity (issue 2473 AC1/AC4)', () => {
	for (const message of AMBIGUOUS_MESSAGES) {
		// Unique session/lane/batch ids per test: the scoped model-selection
		// state (model-dispatch-fallback.ts) is keyed by sessionID +
		// invocationID, so reusing ids across tests would let one test's
		// exhausted chain leak into the next (0 launches, wrong failure).
		const slug = message.includes('ECONNRESET') ? 'econnreset' : 'etimedout';
		test(`async lane: thrown "${message}" at promptAsync keeps the launch single-shot`, async () => {
			seedReviewerFallback();
			const directory = tempProject();
			const seenModels: string[] = [];
			let abortSignal!: (value: unknown) => void;
			const aborted = new Promise((resolve) => {
				abortSignal = resolve;
			});
			const ops: SessionOps = {
				create: mock(async () => ({ data: { id: `amb-async-${slug}` } })),
				prompt: mock(async () => ({
					data: { parts: [{ type: 'text', text: 'unused' }] },
				})),
				promptAsync: mock(async (input) => {
					seenModels.push(input.body.model?.modelID ?? '(default)');
					throw new Error(message);
				}),
				abort: mock(async () => {
					abortSignal(null);
				}),
				delete: mock(async () => undefined),
			};
			_internals.getSessionOps = () => ops;

			const launched = await executeDispatchLanesAsync(
				{
					batch_id: `ambiguity-async-${slug}`,
					timeout_ms: 5_000,
					lanes: [
						{
							id: `probe-${slug}`,
							agent: 'reviewer',
							prompt: 'inspect this change',
						},
					],
				},
				directory,
			);
			expect(launched.lane_results[0]).toMatchObject({
				status: 'pending',
				generation: 1,
			});

			// The launch-error path settles the ledger record and then tears the
			// session down (abort->delete); the abort call is the deterministic
			// signal that the whole launch chain (including any fallback advance)
			// has completed.
			await awaitSignal(aborted, 'launch-error abort');

			assertSingleLaunch(
				ops.promptAsync.mock.calls.length,
				'session.promptAsync',
				seenModels,
			);
			expect(seenModels).toEqual(['primary-reviewer']);
			// The launch-error settlement tears the never-accepted session down
			// (abort -> delete); a wedged or skipped delete would strand the host
			// session behind a terminal record. Teardown is fire-and-forget, so
			// poll for the delete rather than assuming it landed with the abort.
			await waitFor(
				() => ops.delete.mock.calls.length > 0,
				'session deleted after launch error',
			);
			expect(ops.delete).toHaveBeenCalledTimes(1);
			const record = findByBatchId(directory, `ambiguity-async-${slug}`)[0];
			expect(record?.status).toBe('error');
			expect(record?.generation).toBe(1);
			expect(ops.create).toHaveBeenCalledTimes(1);
		});
	}

	for (const message of AMBIGUOUS_MESSAGES) {
		const slug = message.includes('ECONNRESET') ? 'econnreset' : 'etimedout';
		test(`blocking lane: thrown "${message}" at prompt keeps the launch single-shot`, async () => {
			seedReviewerFallback();
			const directory = tempProject();
			const seenModels: string[] = [];
			const ops: SessionOps = {
				create: mock(async () => ({ data: { id: `amb-block-${slug}` } })),
				prompt: mock(async (input) => {
					seenModels.push(input.body.model?.modelID ?? '(default)');
					throw new Error(message);
				}),
				delete: mock(async () => undefined),
			};
			_internals.getSessionOps = () => ops;

			const result = await executeDispatchLanes(
				{
					timeout_ms: 5_000,
					lanes: [
						{
							id: `probe-${slug}`,
							agent: 'reviewer',
							prompt: 'inspect this change',
						},
					],
				},
				directory,
			);

			assertSingleLaunch(
				ops.prompt.mock.calls.length,
				'session.prompt',
				seenModels,
			);
			expect(seenModels).toEqual(['primary-reviewer']);
			expect(result.success).toBe(false);
			expect(result.lane_results[0]).toMatchObject({
				status: 'failed',
				generation: 1,
			});
			// Final failure must surface the terminal state (error text carried).
			expect(String(result.lane_results[0]?.error)).toContain(
				message.includes('ECONNRESET') ? 'ECONNRESET' : 'ETIMEDOUT',
			);
			expect(ops.create).toHaveBeenCalledTimes(1);
		});
	}
});
