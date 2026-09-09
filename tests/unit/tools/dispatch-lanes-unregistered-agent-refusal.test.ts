/**
 * Issue #2614 — refuse unregistered lane agents at dispatch time.
 *
 * A bare canonical role (e.g. `explorer`) dispatched on a multi-swarm host
 * whose registry contains only prefixed names was accepted by
 * `validateLaneAgent` (the exact-canonical-role match in `getCanonicalAgentRole`
 * resolves before the registry membership check), forwarded to
 * `session.promptAsync` with no model, and the host died in its background
 * fiber (PR #2609: 12 lanes pending 41–52 min, `Die(UnknownError)`).
 *
 * Refusal contract:
 *  - non-empty registry + lane agent not a member (case-insensitive) → typed
 *    `rejected` dispatch row naming the agent and the registered names
 *    (bounded to the first 8 + ", and N more")
 *  - legacy bare-name registries (and empty registries) still accept bare
 *    roles — that launch shape is the documented legacy path
 *  - the caller-prefix guard is unchanged
 *  - `startAsyncLanePrompt` carries the same registry-aware refusal as
 *    defense-in-depth for direct callers (validateLaneAgent rejects first on
 *    every launchAsyncLane path)
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from 'bun:test';
import fs from 'node:fs';
import {
	findByCorrelationIdDetailed,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	_internals,
	_test_exports,
	executeDispatchLanes,
	executeDispatchLanesAsync,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';
import { canonicalMkdtemp } from '../../../tests/helpers/tmpdir.js';

const originalInternals = { ..._internals };

// Workaround for Bun #32056 (mirror of dispatch-lanes.test.ts): on Windows, a
// pending promise that leaves the event loop idle prevents bun's per-test
// --timeout from firing. A 1s keepalive interval keeps the loop awake.
let _keepalive: ReturnType<typeof setInterval> | undefined;
beforeAll(() => {
	_keepalive = setInterval(() => {}, 1000);
});
afterAll(() => {
	if (_keepalive) clearInterval(_keepalive);
});

afterEach(() => {
	Object.assign(_internals, originalInternals);
});

function makeTempDir(): string {
	return canonicalMkdtemp('dispatch-lanes-2614-');
}

function stubSyncOps() {
	const promptBodies: Array<{ agent: string; model?: unknown }> = [];
	let createCalls = 0;
	let promptCalls = 0;
	const ops: SessionOps = {
		create: async () => {
			createCalls += 1;
			return { data: { id: 'session-2614' }, error: undefined };
		},
		prompt: async (input: { body: { agent: string; model?: unknown } }) => {
			promptCalls += 1;
			promptBodies.push(input.body);
			return {
				data: {
					parts: [{ type: 'text' as const, text: `ok ${input.body.agent}` }],
				},
				error: undefined,
			};
		},
		delete: async () => undefined,
	};
	return {
		ops,
		promptBodies,
		createCalls: () => createCalls,
		promptCalls: () => promptCalls,
	};
}

function stubAsyncOps(promptAsyncAgents: string[]) {
	const ops = {
		create: async () => ({ data: { id: 'session-2614a' }, error: undefined }),
		promptAsync: async (input: { body: { agent: string } }) => {
			promptAsyncAgents.push(input.body.agent);
			return { data: {}, error: undefined };
		},
		delete: async () => undefined,
	} as never as SessionOps;
	return { ops };
}

describe('issue #2614 — unregistered lane agents are refused at dispatch time', () => {
	test('bare "explorer" + prefixed-only registry + prefix-less caller is rejected with agent and registered names', async () => {
		const directory = makeTempDir();
		const { ops, createCalls, promptCalls } = stubSyncOps();
		_internals.getSessionOps = () => ops;
		_internals.getGeneratedAgentNames = () => [
			'mega_architect',
			'mega_explorer',
			'paid_explorer',
		];

		const result = await executeDispatchLanes(
			{ lanes: [{ id: 'bare', agent: 'explorer', prompt: 'probe' }] },
			directory,
			{ callerAgent: 'build' },
		);

		const lane = result.lane_results[0];
		expect(lane?.status).toBe('rejected');
		expect(lane?.error ?? '').toContain('explorer');
		expect(lane?.error ?? '').toContain('mega_explorer');
		// A rejected lane never reaches the host.
		expect(createCalls()).toBe(0);
		expect(promptCalls()).toBe(0);
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('refusal list is bounded: first 8 registered names then ", and N more"', async () => {
		const directory = makeTempDir();
		const { ops } = stubSyncOps();
		_internals.getSessionOps = () => ops;
		_internals.getGeneratedAgentNames = () => [
			's01_explorer',
			's02_explorer',
			's03_explorer',
			's04_explorer',
			's05_explorer',
			's06_explorer',
			's07_explorer',
			's08_explorer',
			's09_explorer',
			's10_explorer',
		];

		const result = await executeDispatchLanes(
			{ lanes: [{ id: 'bare', agent: 'explorer', prompt: 'probe' }] },
			directory,
			{ callerAgent: 'build' },
		);

		const error = result.lane_results[0]?.error ?? '';
		expect(error).toContain('s08_explorer');
		expect(error).toContain(', and 2 more');
		expect(error).not.toContain('s09_explorer');
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('legacy bare-name registry still accepts bare "explorer" (model path unchanged)', async () => {
		const directory = makeTempDir();
		const { ops, promptBodies } = stubSyncOps();
		_internals.getSessionOps = () => ops;
		_internals.getGeneratedAgentNames = () => [
			'architect',
			'explorer',
			'reviewer',
		];

		const result = await executeDispatchLanes(
			{ lanes: [{ id: 'legacy', agent: 'explorer', prompt: 'probe' }] },
			directory,
			{ callerAgent: 'build' },
		);

		expect(result.lane_results[0]).toEqual(
			expect.objectContaining({ status: 'completed', output: 'ok explorer' }),
		);
		expect(promptBodies[0]?.agent).toBe('explorer');
		expect('model' in (promptBodies[0] ?? {})).toBe(false);
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('mixed bare+prefixed registry accepts the registered bare role', async () => {
		const directory = makeTempDir();
		const { ops } = stubSyncOps();
		_internals.getSessionOps = () => ops;
		_internals.getGeneratedAgentNames = () => ['explorer', 'mega_explorer'];

		const result = await executeDispatchLanes(
			{ lanes: [{ id: 'mixed', agent: 'explorer', prompt: 'probe' }] },
			directory,
			{ callerAgent: 'build' },
		);

		expect(result.lane_results[0]?.status).toBe('completed');
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('caller-prefix guard still rejects cross-swarm dispatch with its specific message', async () => {
		const directory = makeTempDir();
		const { ops, createCalls } = stubSyncOps();
		_internals.getSessionOps = () => ops;
		_internals.getGeneratedAgentNames = () => [
			'mega_architect',
			'mega_reviewer',
			'paid_reviewer',
		];

		const result = await executeDispatchLanes(
			{ lanes: [{ id: 'cross', agent: 'paid_reviewer', prompt: 'cross' }] },
			directory,
			{ callerAgent: 'mega_architect' },
		);

		const lane = result.lane_results[0];
		expect(lane?.status).toBe('rejected');
		expect(lane?.error ?? '').toContain('does not match caller swarm prefix');
		expect(createCalls()).toBe(0);
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('async: unregistered bare role is rejected at the dispatch row and never reaches promptAsync', async () => {
		const directory = makeTempDir();
		const promptAsyncAgents: string[] = [];
		const { ops } = stubAsyncOps(promptAsyncAgents);
		_internals.getSessionOps = () => ops;
		_internals.getGeneratedAgentNames = () => [
			'mega_architect',
			'mega_reviewer',
			'paid_reviewer',
		];

		const dispatch = await executeDispatchLanesAsync(
			{
				batch_id: 'batch-2614-async',
				lanes: [{ id: 'probe', agent: 'reviewer', prompt: 'p' }],
			},
			directory,
			{ callerAgent: 'build' },
		);

		expect(dispatch.lane_results[0]?.status).toBe('rejected');
		expect(promptAsyncAgents).toHaveLength(0);
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('deep gate: startAsyncLanePrompt refuses a provably-unregistered agent before promptAsync', async () => {
		const directory = makeTempDir();
		let promptAsyncCalled = false;
		const ops = {
			create: async () => ({
				data: { id: 'session-2614-deep' },
				error: undefined,
			}),
			promptAsync: async () => {
				promptAsyncCalled = true;
				return { data: {}, error: undefined };
			},
			delete: async () => undefined,
		} as never as SessionOps;
		_internals.getGeneratedAgentNames = () => [
			'mega_architect',
			'mega_explorer',
		];
		// Seed a pending record so the refusal settles through the exactly-once
		// terminal claim with a typed result (the no-record bare-transition
		// fallback leaves no findByCorrelationIdDetailed-readable record).
		await recordPendingDelegation(directory, {
			correlationId: 'session-2614-deep',
			jobId: null,
			subagentSessionId: 'session-2614-deep',
			parentSessionId: 'parent-2614-deep',
			callID: 'call-2614-deep',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'mega_explorer',
			planTaskId: null,
			evidenceTaskId: null,
			mode: 'swarm-pr-review:base',
		});

		await _test_exports.startAsyncLanePrompt({
			session: ops,
			directory,
			sessionId: 'session-2614-deep',
			lane: { id: 'lane-deep', agent: 'explorer', prompt: 'probe' } as never,
			timeoutMs: 5_000,
		});

		expect(promptAsyncCalled).toBe(false);
		const read = findByCorrelationIdDetailed(directory, 'session-2614-deep');
		expect(read.status).not.toBe('uncertain');
		const settled = read.value;
		expect(settled).toBeDefined();
		expect(settled?.status).toBe('error');
		const terminalError = String(
			settled?.terminalResult?.result.error ?? settled?.result?.error ?? '',
		);
		expect(terminalError).toContain('refusing to launch');
		fs.rmSync(directory, { recursive: true, force: true });
	});
});
