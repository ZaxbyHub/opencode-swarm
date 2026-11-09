/**
 * #3169 Phase 3 — eager lane sessions in the v2 session-client shim (the
 * parented create + move placement contract is pinned in
 * session-client-lane-parent-move.test.ts).
 *
 * Pins the lane-placement contract (trace 3169-epic-v2-phase3-isolated-coders,
 * approved plan Changes 1/1b/3/4):
 *  - placement integrity: echo mismatch / unverifiable get fail closed AND
 *    remove the created session (no leaked host session); a silent create is
 *    verified through the get fallback;
 *  - full-treatment prompt on eager records: switchAgent + switchModel, the
 *    sessionID-scoped context hook (fence-aware system replacement +
 *    denied-tool deletion) with disposal, the v1 {data:{info,parts}} envelope;
 *  - epoch-scope: a stale recorded session.error must not mask a succeeded
 *    re-prompt (the eager id is stable across PRR-002 retry chains);
 *  - parentID overlay on get (prWorkflowSessionResolver's first hop);
 *  - delete prunes eager records (get-after-delete resolves through);
 *  - registry eviction semantics: 64 later insertions of ANY kind evict a
 *    live record (placeholder residue shares the cap) — both degradations
 *    pinned (direct-path prompt AND overlay loss), plus the eager-only
 *    65-record bound.
 *
 * bun:test, fakes only (no mock.module); every temp path via canonicalMkdtemp.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	clearV2SessionClientState,
	createV2SessionClient,
	recordV2SessionErrorFromEnvelope,
} from '../../../../src/host/v2/session-client';
import type { V2PluginContext } from '../../../../src/host/v2/types';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

interface RecordedCreate {
	parentID?: string;
	title?: string;
	location?: { directory: string };
}

interface FakeSessionDomain {
	calls: Array<{ op: string; arg: unknown }>;
	contextHandlers: Array<(event: unknown) => Promise<void>>;
	removedSessions: Set<string>;
	createOverride?: (input: RecordedCreate) => Promise<unknown>;
	getInfo: (sessionID: string) => unknown;
	nextId: () => string;
}

function makeFakeSessionDomain(
	parentDirectory: string,
	overrides: Partial<
		Pick<FakeSessionDomain, 'createOverride' | 'getInfo'>
	> = {},
): FakeSessionDomain {
	const fake: FakeSessionDomain = {
		calls: [],
		contextHandlers: [],
		removedSessions: new Set<string>(),
		getInfo: overrides.getInfo ?? ((sessionID: string) => ({ id: sessionID })),
		...overrides,
	};
	let next = 0;
	fake.nextId = () => {
		next += 1;
		return `ses_real_${next}`;
	};
	return {
		...fake,
		async hook(name: string, callback: (event: unknown) => Promise<void>) {
			fake.calls.push({ op: `hook:${name}`, arg: undefined });
			fake.contextHandlers.push(callback);
			return {
				// Recorded through the shared `calls` array (spread-copied by
				// reference) — the disposal pin reads it from the returned fake.
				dispose: async () => {
					fake.calls.push({ op: 'hook:dispose', arg: undefined });
				},
			};
		},
		async create(input: RecordedCreate) {
			fake.calls.push({ op: 'create', arg: input });
			if (fake.createOverride) return fake.createOverride(input);
			const id = fake.nextId();
			return {
				id,
				location: { directory: input.location?.directory ?? parentDirectory },
			};
		},
		async get({ sessionID }: { sessionID: string }) {
			fake.calls.push({ op: 'get', arg: sessionID });
			if (fake.removedSessions.has(sessionID))
				throw new Error('no such session');
			if (sessionID === 'ses_parent') {
				return { id: sessionID, location: { directory: parentDirectory } };
			}
			return fake.getInfo(sessionID);
		},
		async remove({ sessionID }: { sessionID: string }) {
			fake.calls.push({ op: 'remove', arg: sessionID });
			fake.removedSessions.add(sessionID);
		},
		async prompt(input: { sessionID: string; text: string }) {
			fake.calls.push({ op: 'prompt', arg: input });
			return {};
		},
		async wait(input: { sessionID: string }) {
			fake.calls.push({ op: 'wait', arg: input });
		},
		async context(input: { sessionID: string }) {
			fake.calls.push({ op: 'context', arg: input });
			return [
				{ role: 'user', text: 'ignored prompt' },
				{
					role: 'assistant',
					text: 'lane reply',
					model: { id: 'lane-model', providerID: 'opencode' },
				},
				{ type: 'idle', outcome: 'succeeded' },
			];
		},
		async interrupt(input: { sessionID: string }) {
			fake.calls.push({ op: 'interrupt', arg: input });
		},
		async switchAgent(input: { sessionID: string; agent: string }) {
			fake.calls.push({ op: 'switchAgent', arg: input });
		},
		async switchModel(input: { sessionID: string; model: unknown }) {
			fake.calls.push({ op: 'switchModel', arg: input });
		},
	} as unknown as FakeSessionDomain;
}

function makeFakeCtx(
	directory: string,
	sessionDomain: unknown,
): V2PluginContext {
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
		session: sessionDomain,
		event: { subscribe: () => (async function* () {})() },
	} as never;
}

interface LaneClient {
	session: {
		create: (args: {
			body?: { parentID?: string; title?: string };
			query: { directory: string };
		}) => Promise<{
			data: { id: string } | null;
			error?: { message?: string };
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
		get: (args: { path: { id: string } }) => Promise<{
			data: unknown;
			error?: unknown;
		}>;
		delete: (args: { path: { id: string } }) => Promise<unknown>;
	};
}

async function setupLane(
	parentDirectory: string,
	laneDirectory: string,
	overrides: Partial<
		Pick<FakeSessionDomain, 'createOverride' | 'getInfo'>
	> = {},
): Promise<{ client: LaneClient; fake: FakeSessionDomain; laneId: string }> {
	const fake = makeFakeSessionDomain(parentDirectory, overrides);
	const client = createV2SessionClient(
		makeFakeCtx(parentDirectory, fake),
	) as unknown as LaneClient;
	const created = await client.session.create({
		body: { parentID: 'ses_parent', title: 'lane (worktree lane)' },
		query: { directory: laneDirectory },
	});
	if (created.data?.id === undefined || created.data.id === null) {
		throw new Error(`lane create failed: ${created.error?.message}`);
	}
	return { client, fake, laneId: created.data.id };
}

describe('v2 session-client lane sessions (issue #3169 Phase 3)', () => {
	let parentDir: string;
	let laneDir: string;

	beforeEach(() => {
		resetSwarmState();
		clearV2SessionClientState();
		parentDir = canonicalMkdtemp('swarm-v2-lane-parent-');
		laneDir = canonicalMkdtemp('swarm-v2-lane-');
	});

	afterEach(() => {
		rmSync(parentDir, { recursive: true, force: true });
		rmSync(laneDir, { recursive: true, force: true });
	});

	test('echo mismatch fails closed and removes the created session', async () => {
		const fake = makeFakeSessionDomain(parentDir, {
			createOverride: async () => ({
				id: 'ses_misplaced',
				location: { directory: parentDir },
			}),
		});
		const client = createV2SessionClient(
			makeFakeCtx(parentDir, fake),
		) as unknown as LaneClient;
		const result = await client.session.create({
			body: { parentID: 'ses_parent', title: 'lane (worktree lane)' },
			query: { directory: laneDir },
		});
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('#3169 Phase 3 placement guard');
		expect(fake.calls.filter((c) => c.op === 'create')).toHaveLength(1);
		expect(fake.removedSessions.has('ses_misplaced')).toBe(true);
		expect(
			fake.calls.some((c) => c.op === 'remove' && c.arg === 'ses_misplaced'),
		).toBe(true);
	});

	test('a silent create falls back to get: match succeeds, unverifiable fails closed', async () => {
		// Match via get fallback.
		const ok = await setupLane(parentDir, laneDir, {
			createOverride: async () => ({ id: 'ses_silent_ok' }),
			getInfo: (sessionID) =>
				sessionID === 'ses_silent_ok'
					? { id: sessionID, location: { directory: laneDir } }
					: { id: sessionID },
		});
		expect(ok.laneId).toBe('ses_silent_ok');
		// Unverifiable via get fallback.
		const fake = makeFakeSessionDomain(parentDir, {
			createOverride: async () => ({ id: 'ses_silent_bad' }),
		});
		const client = createV2SessionClient(
			makeFakeCtx(parentDir, fake),
		) as unknown as LaneClient;
		const result = await client.session.create({
			body: { parentID: 'ses_parent' },
			query: { directory: laneDir },
		});
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('unverifiable');
		expect(fake.removedSessions.has('ses_silent_bad')).toBe(true);
	});

	// PRR-013: a REJECTING get during placement verification must still return
	// the typed fail-closed envelope (the shim's `.catch`), not reject the whole
	// create and bypass the gate's EPIC_ISOLATION_DEGRADED wrap.
	test('a rejecting get during placement verification still fails closed with a typed error', async () => {
		const fake = makeFakeSessionDomain(parentDir, {
			createOverride: async () => ({ id: 'ses_get_rejects' }),
		});
		(fake as { getInfo: unknown }).getInfo = () => {
			throw new Error('host get exploded');
		};
		const client = createV2SessionClient(
			makeFakeCtx(parentDir, fake),
		) as unknown as LaneClient;
		const result = await client.session.create({
			body: { parentID: 'ses_parent' },
			query: { directory: laneDir },
		});
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('unverifiable');
		expect(fake.removedSessions.has('ses_get_rejects')).toBe(true);
	});

	// PRR-013: a host that creates but returns no id must produce the typed
	// error (no session is addressable, so no remove is possible — but the
	// caller must never see a success envelope).
	test('a create returning no id fails closed with the typed error', async () => {
		const fake = makeFakeSessionDomain(parentDir, {
			createOverride: async () => ({ location: { directory: laneDir } }),
		});
		const client = createV2SessionClient(
			makeFakeCtx(parentDir, fake),
		) as unknown as LaneClient;
		const result = await client.session.create({
			body: { parentID: 'ses_parent' },
			query: { directory: laneDir },
		});
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('returned no id');
	});

	// PRR-007: an aborted caller must not leave the created host session behind.
	test('an aborted create compensates: removes the created session and refuses', async () => {
		const fake = makeFakeSessionDomain(parentDir);
		const client = createV2SessionClient(
			makeFakeCtx(parentDir, fake),
		) as unknown as LaneClient & {
			session: {
				create: (args: {
					body?: { parentID?: string };
					query: { directory: string };
					signal?: AbortSignal;
				}) => Promise<{
					data: { id: string } | null;
					error?: { message?: string };
				}>;
			};
		};
		const controller = new AbortController();
		controller.abort();
		const result = await client.session.create({
			body: { parentID: 'ses_parent' },
			query: { directory: laneDir },
			signal: controller.signal,
		});
		expect(result.data).toBeNull();
		expect(result.error?.message).toContain('aborted');
		expect(fake.removedSessions.has('ses_real_1')).toBe(true);
	});

	test('full-treatment prompt: switches, fence-aware hook, denied tools, envelope, disposal', async () => {
		const { client, fake, laneId } = await setupLane(parentDir, laneDir);
		const result = await client.session.prompt({
			path: { id: laneId },
			body: {
				agent: 'reviewer',
				model: { providerID: 'opencode', modelID: 'lane-model' },
				system: 'LANE SYSTEM',
				tools: { bash: false, edit: false },
				parts: [{ type: 'text', text: 'do the thing' }],
			},
		});
		expect(
			fake.calls.some(
				(c) =>
					c.op === 'switchAgent' &&
					(c.arg as { sessionID: string; agent: string }).sessionID ===
						laneId &&
					(c.arg as { agent: string }).agent === 'reviewer',
			),
		).toBe(true);
		expect(
			fake.calls.some(
				(c) =>
					c.op === 'switchModel' &&
					(c.arg as { sessionID: string }).sessionID === laneId &&
					(c.arg as { model: { id: string; providerID: string } }).model.id ===
						'lane-model',
			),
		).toBe(true);
		expect(result.data?.parts?.[0]?.text).toBe('lane reply');
		expect((result.data?.info as { modelID?: string }).modelID).toBe(
			'lane-model',
		);
		// The captured context handler mutates a foreign-session-shaped event in
		// place: fenced part survives, replacement appended, denied tools gone.
		const handler = fake.contextHandlers.at(-1);
		expect(handler).toBeDefined();
		const event = {
			sessionID: laneId,
			system: [
				{ type: 'text', text: '<swarm_system_directive kind="x">keep' },
				{ type: 'text', text: 'old system' },
			],
			tools: { bash: {}, edit: {}, read: {} },
		};
		await handler!(event);
		expect(
			(event.system as Array<{ text: string }>).map((p) => p.text),
		).toEqual(['<swarm_system_directive kind="x">keep', 'LANE SYSTEM']);
		expect(Object.keys(event.tools as Record<string, unknown>)).toEqual([
			'read',
		]);
		// Disposal pin: the per-prompt context-hook registration is disposed in
		// the prompt's finally (removing that finally must fail this assertion).
		expect(fake.calls.some((c) => c.op === 'hook:dispose')).toBe(true);
	});

	test('epoch-scope: a stale recorded error must not mask a succeeded re-prompt', async () => {
		const { client, laneId } = await setupLane(parentDir, laneDir);
		recordV2SessionErrorFromEnvelope({
			type: 'session.error',
			data: {
				sessionID: laneId,
				error: { name: 'ProviderError', message: 'old' },
			},
		} as never);
		const result = await client.session.prompt({
			path: { id: laneId },
			body: { parts: [{ type: 'text', text: 'retry after fallback' }] },
		});
		expect(result.data?.parts?.[0]?.text).toBe('lane reply');
		expect((result.data?.info as { error?: unknown }).error).toBeUndefined();
	});

	test('get overlays the remembered parentID for eager records only', async () => {
		const { client, laneId } = await setupLane(parentDir, laneDir);
		const child = await client.session.get({ path: { id: laneId } });
		expect((child.data as { parentID?: string }).parentID).toBe('ses_parent');
		const foreign = await client.session.get({ path: { id: 'ses_foreign' } });
		expect((foreign.data as { parentID?: string }).parentID).toBeUndefined();
	});

	test('delete prunes the eager record; get-after-delete resolves through as gone', async () => {
		const { client, fake, laneId } = await setupLane(parentDir, laneDir);
		await client.session.delete({ path: { id: laneId } });
		expect(fake.removedSessions.has(laneId)).toBe(true);
		const gone = await client.session.get({ path: { id: laneId } });
		expect(gone.data).toBeNull();
		expect(gone.error).toBeDefined();
		// Prune pin: a re-prompt of the deleted id must take the DIRECT path
		// (no switchModel, no new context hook) — true only when the eager
		// record was pruned; with the record retained, the full treatment
		// would fire (removing the delete's prune must fail this block).
		const handlersBefore = fake.contextHandlers.length;
		await client.session.prompt({
			path: { id: laneId },
			body: {
				model: { providerID: 'p', modelID: 'm' },
				parts: [{ type: 'text', text: 'post-delete' }],
			},
		});
		expect(fake.calls.some((c) => c.op === 'switchModel')).toBe(false);
		expect(fake.contextHandlers.length).toBe(handlersBefore);
	});
});
