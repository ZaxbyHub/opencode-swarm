/**
 * Eager lane sessions are PARENTED and then MOVED into the lane worktree.
 *
 * OpenCode >= 2.1 derives a parented child's location from its parent and
 * ignores `location` on create, and its native `subagent` tool refuses to
 * resume a session whose host-side `parentID` is not the calling session. The
 * previous parentless eager create therefore produced lane sessions the coder
 * dispatch could never resume. These pins model the 2.1.x host rules in the
 * fake below:
 *  - a parented create lands in the PARENT's directory and ignores `location`;
 *  - `move` relocates the session and preserves `parentID`;
 *  - `move` may be applied asynchronously (get reports the old directory for N
 *    polls);
 *  - variant: a host whose parented create already honours `location` (no
 *    move call is made);
 *  - move rejection, missing move, poll timeout and caller abort all remove
 *    the created session and return the typed error that feeds the existing
 *    STANDARD_WORKTREE_SESSION_CREATE_FAILED degradation.
 *
 * Also pins that the host's `location-switched` timeline entry (appended by
 * `move`, so it always precedes the lane's first prompt) does not disturb the
 * shim's context() translation.
 *
 * bun:test, fakes only (no mock.module); poll pacing through the
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

interface HostSession {
	parentID?: string;
	directory: string;
	/** Directory a pending move will apply once `pendingPolls` reaches 0. */
	pendingDirectory?: string;
	pendingPolls: number;
}

interface FakeHostOptions {
	/**
	 * Hypothetical/later host shape: a parented create honours `location`.
	 * (OpenCode 2.0.26 and 2.1.x do NOT: the child lands in the parent's
	 * directory.)
	 */
	parentedCreateHonoursLocation?: boolean;
	/** Number of `get` polls that still report the old directory after a move. */
	moveLagPolls?: number;
	/** `move` resolves but never relocates (drives the poll timeout). */
	moveNeverApplies?: boolean;
	moveRejects?: boolean;
	omitMove?: boolean;
	onMove?: () => void;
	contextEntries?: unknown[];
}

function makeFakeHost(parentDirectory: string, options: FakeHostOptions = {}) {
	const calls: Array<{ op: string; arg: unknown }> = [];
	const sessions = new Map<string, HostSession>([
		[PARENT, { directory: parentDirectory, pendingPolls: 0 }],
	]);
	let next = 0;
	const info = (id: string, s: HostSession) => ({
		id,
		...(s.parentID !== undefined ? { parentID: s.parentID } : {}),
		location: { directory: s.directory },
	});
	const domain: Record<string, unknown> = {
		async hook() {
			calls.push({ op: 'hook', arg: undefined });
			return { dispose: async () => {} };
		},
		async create(input: {
			parentID?: string;
			title?: string;
			location?: { directory: string };
		}) {
			calls.push({ op: 'create', arg: input });
			next += 1;
			const id = `ses_lane_${next}`;
			const parent =
				input.parentID !== undefined ? sessions.get(input.parentID) : undefined;
			// The 2.1.x rule: a parented child inherits the parent's location.
			const directory =
				parent !== undefined && options.parentedCreateHonoursLocation !== true
					? parent.directory
					: (input.location?.directory ?? parentDirectory);
			const session: HostSession = {
				...(input.parentID !== undefined ? { parentID: input.parentID } : {}),
				directory,
				pendingPolls: 0,
			};
			sessions.set(id, session);
			return info(id, session);
		},
		async get({ sessionID }: { sessionID: string }) {
			calls.push({ op: 'get', arg: sessionID });
			const s = sessions.get(sessionID);
			if (s === undefined) throw new Error('no such session');
			if (s.pendingDirectory !== undefined) {
				if (s.pendingPolls <= 0) {
					s.directory = s.pendingDirectory;
					s.pendingDirectory = undefined;
				} else {
					s.pendingPolls -= 1;
				}
			}
			return info(sessionID, s);
		},
		async move(input: { sessionID: string; directory: string }) {
			calls.push({ op: 'move', arg: input });
			options.onMove?.();
			if (options.moveRejects) throw new Error('move refused by host');
			const s = sessions.get(input.sessionID);
			if (s === undefined) throw new Error('no such session');
			if (options.moveNeverApplies) return;
			// parentID is deliberately untouched: the host preserves it.
			s.pendingDirectory = input.directory;
			s.pendingPolls = options.moveLagPolls ?? 0;
		},
		async remove({ sessionID }: { sessionID: string }) {
			calls.push({ op: 'remove', arg: sessionID });
			sessions.delete(sessionID);
		},
		async prompt(input: unknown) {
			calls.push({ op: 'prompt', arg: input });
			return {};
		},
		async wait(input: unknown) {
			calls.push({ op: 'wait', arg: input });
		},
		async context(input: unknown) {
			calls.push({ op: 'context', arg: input });
			return options.contextEntries ?? [];
		},
		async interrupt(input: unknown) {
			calls.push({ op: 'interrupt', arg: input });
		},
		async switchAgent(input: unknown) {
			calls.push({ op: 'switchAgent', arg: input });
		},
		async switchModel(input: unknown) {
			calls.push({ op: 'switchModel', arg: input });
		},
	};
	if (options.omitMove) delete domain.move;
	return { calls, sessions, domain };
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

interface ShimClient {
	session: {
		create: (args: {
			body?: { parentID?: string; title?: string };
			query: { directory: string };
			signal?: AbortSignal;
		}) => Promise<{
			data: { id: string } | null;
			error?: { message?: string; sessionID?: string };
		}>;
		prompt: (args: {
			path: { id: string };
			body: Record<string, unknown>;
		}) => Promise<{
			data: {
				info: Record<string, unknown>;
				parts: Array<{ text: string }>;
			} | null;
		}>;
	};
}

function shimFor(parentDirectory: string, domain: unknown): ShimClient {
	return createV2SessionClient(
		makeCtx(parentDirectory, domain),
	) as unknown as ShimClient;
}

const ops = (calls: Array<{ op: string }>) => calls.map((c) => c.op);

describe('v2 session-client eager lane: parented create + move', () => {
	let parentDir: string;
	let laneDir: string;
	const defaults = { ..._internals };

	beforeEach(() => {
		resetSwarmState();
		clearV2SessionClientState();
		parentDir = canonicalMkdtemp('swarm-v2-move-parent-');
		laneDir = canonicalMkdtemp('swarm-v2-move-lane-');
		_internals.laneMovePollAttempts = 5;
		_internals.laneMovePollDelayMs = 1;
	});

	afterEach(() => {
		Object.assign(_internals, defaults);
		safeRmAllRecursive([parentDir, laneDir]);
	});

	test('2.1.x host: create carries parentID, then move, then get confirms the lane (order pinned)', async () => {
		const host = makeFakeHost(parentDir);
		const result = await shimFor(parentDir, host.domain).session.create({
			body: { parentID: PARENT, title: 'lane (worktree lane)' },
			query: { directory: laneDir },
		});
		expect(result.error).toBeUndefined();
		expect(result.data?.id).toBe('ses_lane_1');
		const createArg = host.calls.find((c) => c.op === 'create')?.arg as {
			parentID?: string;
			title?: string;
		};
		expect(createArg.parentID).toBe(PARENT);
		expect(createArg.title).toBe('lane (worktree lane)');
		// Delivery is deliberately omitted (see the move comment in the shim).
		expect(host.calls.find((c) => c.op === 'move')?.arg).toEqual({
			sessionID: 'ses_lane_1',
			directory: laneDir,
		});
		const sequence = ops(host.calls).filter((op) =>
			['create', 'move', 'get', 'remove'].includes(op),
		);
		const createAt = sequence.indexOf('create');
		const moveAt = sequence.indexOf('move');
		expect(createAt).toBeGreaterThanOrEqual(0);
		expect(moveAt).toBeGreaterThan(createAt);
		expect(sequence.lastIndexOf('get')).toBeGreaterThan(moveAt);
		expect(sequence).not.toContain('remove');
		// The host-side session is a REAL child, now in the lane.
		const hostSession = host.sessions.get('ses_lane_1');
		expect(hostSession?.parentID).toBe(PARENT);
		expect(hostSession?.directory).toBe(laneDir);
	});

	test('an asynchronously applied move is polled until get reports the lane', async () => {
		const host = makeFakeHost(parentDir, { moveLagPolls: 3 });
		const result = await shimFor(parentDir, host.domain).session.create({
			body: { parentID: PARENT },
			query: { directory: laneDir },
		});
		expect(result.data?.id).toBe('ses_lane_1');
		const getsAfterMove = ops(host.calls)
			.slice(ops(host.calls).indexOf('move'))
			.filter((op) => op === 'get');
		expect(getsAfterMove).toHaveLength(4);
		expect(ops(host.calls)).not.toContain('remove');
	});

	test('a host whose parented create honours location (hypothetical shape) skips the move', async () => {
		const host = makeFakeHost(parentDir, {
			parentedCreateHonoursLocation: true,
		});
		const result = await shimFor(parentDir, host.domain).session.create({
			body: { parentID: PARENT },
			query: { directory: laneDir },
		});
		expect(result.data?.id).toBe('ses_lane_1');
		expect(ops(host.calls)).not.toContain('move');
		expect(host.sessions.get('ses_lane_1')?.parentID).toBe(PARENT);
	});

	test('a rejected move removes the created session and returns the typed error', async () => {
		const host = makeFakeHost(parentDir, { moveRejects: true });
		const result = await shimFor(parentDir, host.domain).session.create({
			body: { parentID: PARENT },
			query: { directory: laneDir },
		});
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('#3169 Phase 3 placement guard');
		expect(result.error?.message).toContain('move refused by host');
		expect(
			host.calls.some((c) => c.op === 'remove' && c.arg === 'ses_lane_1'),
		).toBe(true);
		expect(host.sessions.has('ses_lane_1')).toBe(false);
	});

	test('a host without move fails closed and removes the parent-placed session', async () => {
		const host = makeFakeHost(parentDir, { omitMove: true });
		const result = await shimFor(parentDir, host.domain).session.create({
			body: { parentID: PARENT },
			query: { directory: laneDir },
		});
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('#3169 Phase 3 placement guard');
		expect(result.error?.message).toContain('no session.move');
		expect(host.sessions.has('ses_lane_1')).toBe(false);
	});

	test('a move that never lands times out after the bounded polls and removes the session', async () => {
		const host = makeFakeHost(parentDir, { moveNeverApplies: true });
		const result = await shimFor(parentDir, host.domain).session.create({
			body: { parentID: PARENT },
			query: { directory: laneDir },
		});
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain(
			`landed in ${parentDir}, not the requested ${laneDir}`,
		);
		const getsAfterMove = ops(host.calls)
			.slice(ops(host.calls).indexOf('move'))
			.filter((op) => op === 'get');
		expect(getsAfterMove).toHaveLength(_internals.laneMovePollAttempts);
		expect(host.sessions.has('ses_lane_1')).toBe(false);
	});

	test('a caller abort during the move compensates: session removed, create refused', async () => {
		const controller = new AbortController();
		const host = makeFakeHost(parentDir, {
			moveLagPolls: 2,
			onMove: () => controller.abort(),
		});
		const result = await shimFor(parentDir, host.domain).session.create({
			body: { parentID: PARENT },
			query: { directory: laneDir },
			signal: controller.signal,
		});
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('aborted');
		expect(host.sessions.has('ses_lane_1')).toBe(false);
	});
});

describe('location-switched timeline entry vs the eager prompt translation', () => {
	let parentDir: string;
	let laneDir: string;

	beforeEach(() => {
		resetSwarmState();
		clearV2SessionClientState();
		parentDir = canonicalMkdtemp('swarm-v2-move-parent-');
		laneDir = canonicalMkdtemp('swarm-v2-move-lane-');
	});

	afterEach(() => {
		safeRmAllRecursive([parentDir, laneDir]);
	});

	// The live entry shape is not captured, so both plausible shapes are pinned:
	// a typed timeline entry and a user-role synthetic notice. Either precedes
	// the lane's first prompt because `move` runs before any prompt.
	for (const [label, switched] of [
		['typed entry', { type: 'location-switched', directory: '/lane' }],
		[
			'user-role notice',
			{ role: 'user', type: 'synthetic', text: 'Location switched to /lane' },
		],
	] as const) {
		test(`a leading ${label} does not change the translated reply`, async () => {
			const host = makeFakeHost(parentDir, {
				contextEntries: [
					switched,
					{ role: 'user', text: 'lane task' },
					{
						role: 'assistant',
						text: 'lane reply',
						model: { id: 'm', providerID: 'p' },
					},
					{ type: 'idle', outcome: 'succeeded' },
				],
			});
			const client = shimFor(parentDir, host.domain);
			const created = await client.session.create({
				body: { parentID: PARENT },
				query: { directory: laneDir },
			});
			const id = created.data?.id as string;
			const result = await client.session.prompt({
				path: { id },
				body: { parts: [{ type: 'text', text: 'lane task' }] },
			});
			expect(result.data?.parts.map((p) => p.text)).toEqual(['lane reply']);
			expect(result.data?.info.error).toBeUndefined();
			expect(result.data?.info.modelID).toBe('m');
		});
	}

	// Live 2.1.4 and 2.2.5 lane timelines: `location-switched` is followed by an
	// `idle` (outcome succeeded) BEFORE the delegation's user message. A turn
	// that yields no reply and no idle of its own must still take the error
	// path; previously the last-idle scan read that pre-prompt idle and
	// reported an empty success.
	test('a pre-prompt idle left by the move does not turn a silent turn into success', async () => {
		const host = makeFakeHost(parentDir, {
			contextEntries: [
				{
					type: 'location-switched',
					location: { directory: laneDir },
					previous: { location: { directory: parentDir } },
				},
				{ type: 'idle', outcome: 'succeeded' },
				{ type: 'agent-switched' },
				{ role: 'user', text: 'lane task' },
			],
		});
		const client = shimFor(parentDir, host.domain);
		const created = await client.session.create({
			body: { parentID: PARENT },
			query: { directory: laneDir },
		});
		const result = await client.session.prompt({
			path: { id: created.data?.id as string },
			body: { parts: [{ type: 'text', text: 'lane task' }] },
		});
		expect(result.data?.parts).toEqual([]);
		expect(result.data?.info.error).toBeDefined();
	});
});
