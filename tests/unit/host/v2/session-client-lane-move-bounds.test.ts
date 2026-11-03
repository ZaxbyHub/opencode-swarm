/**
 * Bounds and compensation ordering for the eager lane create's
 * parented-create + `session.move` placement (#3558 review round 1).
 *
 * Pins:
 *  - F1: every placement `get` is bounded by a per-request timeout and the
 *    caller's signal — a `get` that never settles ends in removal and a typed
 *    error, never a hang (initial verification read and confirmation poll);
 *  - F2: `move` is raced against the caller's signal, and on timeout/abort the
 *    removal is NOT issued while the move is still pending — it waits (bounded)
 *    for the move to settle; a move that never settles is removed with the
 *    removal reported as unconfirmed; a late move rejection is not unhandled;
 *  - F3: an abort that lands during the final read returns abort compensation,
 *    not success.
 *
 * Tests that would otherwise hang rely on bun's per-test timeout, so no wall
 * clock is read here. bun:test, fakes only (no mock.module); pacing via the
 * `_internals` seam (restored in afterEach); temp paths via canonicalMkdtemp.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_internals,
	clearV2SessionClientState,
	createV2SessionClient,
} from '../../../../src/host/v2/session-client';
import type { V2PluginContext } from '../../../../src/host/v2/types';
import { resetSwarmState } from '../../../../src/state';
import { safeRmAllRecursive } from '../../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const PARENT = 'ses_parent';
const LANE_ID = 'ses_lane_1';

type Behaviour = {
	/** Echo a location on create (default: the parent's directory). */
	createEcho?: 'parent' | 'none';
	/** How the lane `get` behaves after the move (default: reports the lane). */
	laneGet?: 'lane' | 'never' | 'abort-then-lane';
	/** How `move` behaves (default: resolves at once). */
	move?:
		| { kind: 'now' }
		| { kind: 'never' }
		| { kind: 'late'; afterMs: number; reject?: boolean };
	onMoveCalled?: () => void;
	/** How `remove` behaves (default: resolves). */
	remove?: 'ok' | 'reject' | 'never';
	controller?: AbortController;
};

function makeHost(parentDir: string, laneDir: string, b: Behaviour = {}) {
	const log: string[] = [];
	let moved = false;
	const domain = {
		async hook() {
			return { dispose: async () => {} };
		},
		async create(input: { parentID?: string }) {
			log.push('create');
			return b.createEcho === 'none'
				? { id: LANE_ID, parentID: input.parentID }
				: {
						id: LANE_ID,
						parentID: input.parentID,
						location: { directory: parentDir },
					};
		},
		get({ sessionID }: { sessionID: string }): Promise<unknown> {
			if (sessionID === PARENT) {
				return Promise.resolve({
					id: PARENT,
					location: { directory: parentDir },
				});
			}
			log.push('get');
			if (b.laneGet === 'never') return new Promise(() => {});
			if (b.laneGet === 'abort-then-lane') b.controller?.abort();
			return Promise.resolve({
				id: LANE_ID,
				parentID: PARENT,
				location: { directory: moved ? laneDir : parentDir },
			});
		},
		move(): Promise<void> {
			log.push('move');
			b.onMoveCalled?.();
			const mode = b.move ?? { kind: 'now' };
			if (mode.kind === 'never') return new Promise(() => {});
			if (mode.kind === 'now') {
				moved = true;
				log.push('move-settled');
				return Promise.resolve();
			}
			return new Promise((resolve, reject) => {
				setTimeout(() => {
					log.push('move-settled');
					if (mode.reject) reject(new Error('late move refusal'));
					else {
						moved = true;
						resolve();
					}
				}, mode.afterMs);
			});
		},
		remove(): Promise<void> {
			log.push('remove');
			if (b.remove === 'reject') {
				return Promise.reject(new Error('host refused removal'));
			}
			if (b.remove === 'never') return new Promise(() => {});
			return Promise.resolve();
		},
		async prompt() {
			return {};
		},
		async wait() {},
		async context() {
			return [];
		},
		async interrupt() {},
	};
	return { log, domain };
}

function makeCtx(directory: string, domain: unknown): V2PluginContext {
	const registration = { dispose: async () => {} };
	return {
		app: { name: 'opencode', version: 'test', channel: 'test' },
		location: {
			directory,
			workspaceID: 'w',
			project: { id: 'p', directory, canonical: directory },
		},
		options: {},
		tool: {
			transform: async () => registration,
			hook: async () => registration,
		},
		agent: { transform: async () => registration },
		command: { transform: async () => registration },
		session: domain,
		event: { subscribe: () => (async function* () {})() },
	} as never;
}

type CreateResult = {
	data: { id: string } | null;
	error?: {
		message?: string;
		sessionID?: string;
		cleanupFailed?: boolean;
		cleanupUnconfirmed?: boolean;
	};
};

function createLane(
	parentDir: string,
	laneDir: string,
	domain: unknown,
	signal?: AbortSignal,
): Promise<CreateResult> {
	const client = createV2SessionClient(
		makeCtx(parentDir, domain),
	) as unknown as {
		session: {
			create: (args: {
				body: { parentID: string };
				query: { directory: string };
				signal?: AbortSignal;
			}) => Promise<CreateResult>;
		};
	};
	return client.session.create({
		body: { parentID: PARENT },
		query: { directory: laneDir },
		...(signal ? { signal } : {}),
	});
}

describe('eager lane placement: bounded reads and serialised move compensation', () => {
	let parentDir: string;
	let laneDir: string;
	const defaults = { ..._internals };

	beforeEach(() => {
		resetSwarmState();
		clearV2SessionClientState();
		parentDir = canonicalMkdtemp('swarm-v2-bounds-parent-');
		laneDir = canonicalMkdtemp('swarm-v2-bounds-lane-');
		_internals.laneMovePollAttempts = 5;
		_internals.laneMovePollDelayMs = 1;
		_internals.laneReadTimeoutMs = 20;
		_internals.laneConfirmBudgetMs = 500;
		_internals.laneMoveTimeoutMs = 20;
		_internals.laneMoveSettleMs = 500;
	});

	afterEach(() => {
		Object.assign(_internals, defaults);
		safeRmAllRecursive([parentDir, laneDir]);
	});

	test('F1: a confirmation get that never settles ends in removal and a typed error', async () => {
		const host = makeHost(parentDir, laneDir, { laneGet: 'never' });
		const result = await createLane(parentDir, laneDir, host.domain);
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('#3169 Phase 3 placement guard');
		expect(result.error?.message).toContain('timed out');
		expect(host.log).toContain('remove');
	});

	test('F1: an initial verification get that never settles ends in removal', async () => {
		const host = makeHost(parentDir, laneDir, {
			createEcho: 'none',
			laneGet: 'never',
		});
		const result = await createLane(parentDir, laneDir, host.domain);
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('timed out');
		expect(host.log).not.toContain('move');
		expect(host.log.at(-1)).toBe('remove');
	});

	test('F2: a move that resolves after the timeout is awaited before removal', async () => {
		const host = makeHost(parentDir, laneDir, {
			move: { kind: 'late', afterMs: 60 },
		});
		const result = await createLane(parentDir, laneDir, host.domain);
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('session.move exceeded');
		const settledAt = host.log.indexOf('move-settled');
		expect(settledAt).toBeGreaterThan(-1);
		expect(host.log.indexOf('remove')).toBeGreaterThan(settledAt);
		// The removal followed a settled move, so it is not reported unconfirmed.
		expect(result.error?.cleanupUnconfirmed).toBeUndefined();
	});

	test('F2: a late move rejection after the timeout is not an unhandled rejection', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		try {
			const host = makeHost(parentDir, laneDir, {
				move: { kind: 'late', afterMs: 40, reject: true },
			});
			const result = await createLane(parentDir, laneDir, host.domain);
			expect(result.data).toBeNull();
			expect(host.log.indexOf('remove')).toBeGreaterThan(
				host.log.indexOf('move-settled'),
			);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(unhandled).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});

	test('F2: a move that never settles is removed after the bounded wait and reported unconfirmed', async () => {
		_internals.laneMoveSettleMs = 30;
		const host = makeHost(parentDir, laneDir, { move: { kind: 'never' } });
		const result = await createLane(parentDir, laneDir, host.domain);
		expect(result.data).toBeNull();
		expect(host.log).toContain('remove');
		expect(result.error?.cleanupUnconfirmed).toBe(true);
		expect(result.error?.sessionID).toBe(LANE_ID);
		expect(result.error?.message).toContain('unconfirmed');
	});

	test('F2: an abort during a pending move is observed without waiting for the move timeout', async () => {
		// One-minute move timeout and a move that never settles: the test can
		// only finish inside its own 2 s timeout if the abort is raced against
		// the pending move and the settle wait stays bounded.
		_internals.laneMoveTimeoutMs = 60_000;
		_internals.laneMoveSettleMs = 30;
		const controller = new AbortController();
		const host = makeHost(parentDir, laneDir, {
			move: { kind: 'never' },
			onMoveCalled: () => setTimeout(() => controller.abort(), 5),
		});
		const result = await createLane(
			parentDir,
			laneDir,
			host.domain,
			controller.signal,
		);
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('aborted');
		expect(result.error?.message).toContain('unconfirmed');
		expect(host.log.at(-1)).toBe('remove');
	}, 2_000);

	test('F3: an abort that lands during the final read returns compensation, not success', async () => {
		const controller = new AbortController();
		const host = makeHost(parentDir, laneDir, {
			laneGet: 'abort-then-lane',
			controller,
		});
		const result = await createLane(
			parentDir,
			laneDir,
			host.domain,
			controller.signal,
		);
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('aborted');
		expect(host.log.at(-1)).toBe('remove');
	});
});

describe('eager lane placement: cleanup-failure reporting', () => {
	let parentDir: string;
	let laneDir: string;
	const defaults = { ..._internals };

	beforeEach(() => {
		resetSwarmState();
		clearV2SessionClientState();
		parentDir = canonicalMkdtemp('swarm-v2-cleanup-parent-');
		laneDir = canonicalMkdtemp('swarm-v2-cleanup-lane-');
		_internals.laneMoveTimeoutMs = 60_000;
		_internals.laneMoveSettleMs = 500;
	});

	afterEach(() => {
		Object.assign(_internals, defaults);
		safeRmAllRecursive([parentDir, laneDir]);
	});

	const expectCleanupFailed = (result: CreateResult) => {
		expect(result.data).toBeNull();
		expect(result.error?.sessionID).toBe(LANE_ID);
		expect(result.error?.cleanupFailed).toBe(true);
		expect(result.error?.message).toContain(LANE_ID);
		expect(result.error?.message).not.toContain('was removed');
		// A failed removal is reported as failed, not as merely unconfirmed.
		expect(result.error?.cleanupUnconfirmed).toBeUndefined();
	};

	test('abort during the move + a rejected removal reports cleanupFailed', async () => {
		const controller = new AbortController();
		const host = makeHost(parentDir, laneDir, {
			move: { kind: 'late', afterMs: 20 },
			onMoveCalled: () => setTimeout(() => controller.abort(), 1),
			remove: 'reject',
		});
		const result = await createLane(
			parentDir,
			laneDir,
			host.domain,
			controller.signal,
		);
		expectCleanupFailed(result);
		expect(result.error?.message).toContain('aborted');
		expect(result.error?.message).toContain('host refused removal');
	});

	test('a rejected move + a rejected removal reports cleanupFailed', async () => {
		const host = makeHost(parentDir, laneDir, {
			move: { kind: 'late', afterMs: 1, reject: true },
			remove: 'reject',
		});
		const result = await createLane(parentDir, laneDir, host.domain);
		expectCleanupFailed(result);
		expect(result.error?.message).toContain('late move refusal');
		expect(result.error?.message).toContain('host refused removal');
	});

	test('a removal that never settles is bounded by the cleanup timeout and reported as failed', async () => {
		// The default 10 s cleanup budget would outlive this test's 2 s
		// timeout; the seam shrinks it.
		_internals.eagerCleanupTimeoutMs = 30;
		const host = makeHost(parentDir, laneDir, {
			move: { kind: 'late', afterMs: 1, reject: true },
			remove: 'never',
		});
		const result = await createLane(parentDir, laneDir, host.domain);
		expectCleanupFailed(result);
		expect(result.error?.message).toContain('exceeded 30ms');
	}, 2_000);
});
