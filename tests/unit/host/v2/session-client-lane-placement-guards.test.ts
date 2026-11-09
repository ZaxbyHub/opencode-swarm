/**
 * Placement guards for the eager lane create (#3558 review round 3).
 *
 * Pins:
 *  - the post-read abort re-check: a read that SETTLES with the lane while
 *    the caller's signal has flipped to aborted (no event dispatched, so the
 *    bounded call reports `settled`) must return abort compensation;
 *  - the confirmation budget: the poll stops at the `laneConfirmBudgetMs`
 *    deadline even with many attempts left, and a never-settling read is
 *    clamped to the remaining budget rather than `laneReadTimeoutMs`;
 *  - non-conforming hosts: a synchronous throw or a non-promise return from
 *    `session.move` / `session.get` yields the `{data:null,error}` envelope
 *    and removes the created session;
 *  - placement-failure texts are not classified as transient by the
 *    dispatch-lanes create-retry classifier.
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
import { _test_exports as dispatchLanes } from '../../../../src/tools/dispatch-lanes';
import { safeRmAllRecursive } from '../../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const PARENT = 'ses_parent';
const LANE_ID = 'ses_lane_1';

interface Host {
	log: string[];
	moved: boolean;
	/** Lane `get` override; default reports the lane once moved. */
	laneGet?: (host: Host) => unknown;
	/** `move` override; default resolves and relocates. */
	move?: (host: Host) => unknown;
	/** Echo the parent's directory on create (default) or no location. */
	createEcho?: 'parent' | 'none';
	remove?: () => Promise<void>;
}

function makeDomain(parentDir: string, laneDir: string, host: Host) {
	const lane = (h: Host) => ({
		id: LANE_ID,
		parentID: PARENT,
		location: { directory: h.moved ? laneDir : parentDir },
	});
	return {
		async hook() {
			return { dispose: async () => {} };
		},
		async create() {
			host.log.push('create');
			return host.createEcho === 'none'
				? { id: LANE_ID, parentID: PARENT }
				: { id: LANE_ID, parentID: PARENT, location: { directory: parentDir } };
		},
		get({ sessionID }: { sessionID: string }): unknown {
			if (sessionID === PARENT) {
				return Promise.resolve({
					id: PARENT,
					location: { directory: parentDir },
				});
			}
			host.log.push('get');
			return host.laneGet ? host.laneGet(host) : Promise.resolve(lane(host));
		},
		move(): unknown {
			host.log.push('move');
			if (host.move) return host.move(host);
			host.moved = true;
			return Promise.resolve();
		},
		remove(): Promise<void> {
			host.log.push('remove');
			return host.remove ? host.remove() : Promise.resolve();
		},
		async prompt() {
			return {};
		},
		async wait() {},
		async context() {
			return [];
		},
		async interrupt() {},
		lane,
	};
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
	error?: { message?: string; sessionID?: string };
};

function createLane(
	parentDir: string,
	laneDir: string,
	host: Host,
	signal?: unknown,
): Promise<CreateResult> {
	const domain = makeDomain(parentDir, laneDir, host);
	const client = createV2SessionClient(
		makeCtx(parentDir, domain),
	) as unknown as {
		session: { create: (args: unknown) => Promise<CreateResult> };
	};
	return client.session.create({
		body: { parentID: PARENT },
		query: { directory: laneDir },
		...(signal ? { signal } : {}),
	});
}

const newHost = (extra: Partial<Host> = {}): Host => ({
	log: [],
	moved: false,
	...extra,
});
const count = (host: Host, op: string) =>
	host.log.filter((entry) => entry === op).length;

describe('eager lane placement guards (#3558 round 3)', () => {
	let parentDir: string;
	let laneDir: string;
	const defaults = { ..._internals };

	beforeEach(() => {
		resetSwarmState();
		clearV2SessionClientState();
		parentDir = canonicalMkdtemp('swarm-v2-guard-parent-');
		laneDir = canonicalMkdtemp('swarm-v2-guard-lane-');
		_internals.laneMovePollAttempts = 5;
		_internals.laneMovePollDelayMs = 1;
		_internals.laneReadTimeoutMs = 50;
		_internals.laneConfirmBudgetMs = 500;
		_internals.laneMoveTimeoutMs = 50;
		_internals.laneMoveSettleMs = 50;
	});

	afterEach(() => {
		Object.assign(_internals, defaults);
		safeRmAllRecursive([parentDir, laneDir]);
	});

	test('an abort observed only after a read settles with the lane returns compensation', async () => {
		// A signal whose `aborted` flips without dispatching an event: the
		// bounded read reports `settled` (the lane), so only the post-read
		// `signal.aborted` re-check can refuse the placement.
		const signal = {
			aborted: false,
			addEventListener() {},
			removeEventListener() {},
		};
		const host = newHost({
			laneGet: (h) =>
				Promise.resolve().then(() => {
					signal.aborted = true;
					return makeDomain(parentDir, laneDir, h).lane(h);
				}),
		});
		const result = await createLane(parentDir, laneDir, host, signal);
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('aborted');
		expect(host.log.at(-1)).toBe('remove');
	});

	test('the confirmation poll stops at the budget deadline with attempts left', async () => {
		_internals.laneMovePollAttempts = 100_000;
		_internals.laneConfirmBudgetMs = 30;
		// The move "succeeds" but the session never reports the lane.
		const host = newHost({ move: () => Promise.resolve() });
		const result = await createLane(parentDir, laneDir, host);
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('#3169 Phase 3 placement guard');
		expect(count(host, 'get')).toBeLessThan(1_000);
		expect(host.log.at(-1)).toBe('remove');
	});

	test('a never-settling confirmation read is clamped to the remaining budget', async () => {
		_internals.laneReadTimeoutMs = 60_000;
		_internals.laneConfirmBudgetMs = 30;
		const host = newHost({ laneGet: () => new Promise(() => {}) });
		const result = await createLane(parentDir, laneDir, host);
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('time budget');
		expect(host.log.at(-1)).toBe('remove');
	}, 2_000);

	test('a synchronous throw from session.move yields the envelope and removes the session', async () => {
		const host = newHost({
			move: () => {
				throw new Error('sync move failure');
			},
		});
		const result = await createLane(parentDir, laneDir, host);
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('sync move failure');
		expect(host.log.at(-1)).toBe('remove');
	});

	test('a non-promise return from session.move yields the envelope and removes the session', async () => {
		const host = newHost({ move: () => undefined });
		const result = await createLane(parentDir, laneDir, host);
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('non-promise');
		expect(host.log.at(-1)).toBe('remove');
	});

	test('a synchronous throw from session.get in the verification read yields the envelope and removal', async () => {
		const host = newHost({
			createEcho: 'none',
			laneGet: () => {
				throw new Error('sync get failure');
			},
		});
		const result = await createLane(parentDir, laneDir, host);
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('#3169 Phase 3 placement guard');
		expect(host.log.at(-1)).toBe('remove');
	});

	test('a synchronous throw from session.get in the confirmation loop yields the envelope and removal', async () => {
		const host = newHost({
			laneGet: (h) => {
				if (h.moved) throw new Error('sync get failure');
				return Promise.resolve(makeDomain(parentDir, laneDir, h).lane(h));
			},
		});
		const result = await createLane(parentDir, laneDir, host);
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('#3169 Phase 3 placement guard');
		expect(count(host, 'get')).toBeGreaterThan(0);
		expect(host.log.at(-1)).toBe('remove');
	});

	test('a non-promise return from session.get is not trusted as a placement', async () => {
		const host = newHost({
			laneGet: (h) => makeDomain(parentDir, laneDir, h).lane(h),
		});
		const result = await createLane(parentDir, laneDir, host);
		expect(result.data).toBeNull();
		expect(host.log.at(-1)).toBe('remove');
	});
});

describe('placement-failure texts vs the create-retry classifier', () => {
	let parentDir: string;
	let laneDir: string;
	const defaults = { ..._internals };

	beforeEach(() => {
		resetSwarmState();
		clearV2SessionClientState();
		parentDir = canonicalMkdtemp('swarm-v2-classify-parent-');
		laneDir = canonicalMkdtemp('swarm-v2-classify-lane-');
		_internals.laneMovePollAttempts = 3;
		_internals.laneMovePollDelayMs = 1;
		_internals.laneReadTimeoutMs = 20;
		_internals.laneConfirmBudgetMs = 100;
		_internals.laneMoveTimeoutMs = 20;
		_internals.laneMoveSettleMs = 20;
		_internals.eagerCleanupTimeoutMs = 20;
	});

	afterEach(() => {
		Object.assign(_internals, defaults);
		safeRmAllRecursive([parentDir, laneDir]);
	});

	const never = () => new Promise(() => {});
	const cases: Array<[string, () => Host]> = [
		[
			'verification read over budget',
			() => newHost({ createEcho: 'none', laneGet: never }),
		],
		['confirmation read over budget', () => newHost({ laneGet: never })],
		['lane never observed', () => newHost({ move: () => Promise.resolve() })],
		['move over budget and unsettled', () => newHost({ move: never })],
		[
			'removal over budget',
			() => newHost({ move: never, remove: never as () => Promise<void> }),
		],
	];
	for (const [label, build] of cases) {
		test(`${label}: not classified as a transient create failure`, async () => {
			const result = await createLane(parentDir, laneDir, build());
			expect(result.data).toBeNull();
			expect(typeof result.error?.message).toBe('string');
			expect(dispatchLanes.isRetryableSessionCreateFailure(result.error)).toBe(
				false,
			);
		});
	}
});
