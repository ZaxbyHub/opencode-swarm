/**
 * #3169 Phase 2 — v2 session-client shim: install, create, prompt (AC1-AC4).
 *
 * Fakes only (no mock.module, no clock reads, no subprocess). The fake v2
 * Context's session domain records every call; the fake `runInit` mirrors the
 * shared init core's single client write site (`swarmState.opencodeClient =
 * input.client`, src/index.ts) so the install seam is exercised end-to-end
 * through the real `openCodeSwarmV2Setup`.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	clearV2SessionClientState,
	createV2SessionClient,
} from '../../../../src/host/v2/session-client';
import { openCodeSwarmV2Setup } from '../../../../src/host/v2/setup';
import type { V2PluginContext } from '../../../../src/host/v2/types';
import { createReviewModelDispatcher } from '../../../../src/review/contracts';
import { resetSwarmState, swarmState } from '../../../../src/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

interface RecordedCreate {
	parentID?: string;
	title?: string;
	agent?: string;
	model?: { id: string; providerID: string };
	location?: { directory: string };
	permissions?: Array<{ action: string; resource: string; effect: string }>;
}

interface FakeSessionDomain {
	calls: Array<{ op: string; arg: unknown }>;
	createdSessions: Array<{
		id: string;
		input: RecordedCreate;
		removed: boolean;
	}>;
	sessionInfos: Map<string, { location?: { directory: string } }>;
	contextEntries: Map<string, unknown[]>;
	removedSessions: Set<string>;
	contextHandlers: Array<(event: unknown) => Promise<void>>;
}

const DEFAULT_CONTEXT_ENTRIES: unknown[] = [
	{ role: 'user', text: 'ignored prompt' },
	{
		role: 'assistant',
		text: 'review verdict text',
		model: { id: 'review-model', providerID: 'opencode' },
	},
	{ type: 'idle', outcome: 'succeeded' },
];

function makeFakeSessionDomain(
	directory: string,
	overrides: Partial<Pick<FakeSessionDomain, 'sessionInfos'>> = {},
): FakeSessionDomain {
	const fake: FakeSessionDomain = {
		calls: [],
		createdSessions: [],
		sessionInfos:
			overrides.sessionInfos ??
			new Map([['ses_parent', { location: { directory } }]]),
		contextEntries: new Map([['default', DEFAULT_CONTEXT_ENTRIES]]),
		removedSessions: new Set(),
		contextHandlers: [],
	};
	let nextId = 0;
	return {
		...fake,
		async hook(name: string, callback: (event: unknown) => Promise<void>) {
			fake.calls.push({ op: `hook:${name}`, arg: undefined });
			fake.contextHandlers.push(callback);
			return { dispose: async () => {} };
		},
		async create(input: RecordedCreate) {
			fake.calls.push({ op: 'create', arg: input });
			nextId += 1;
			const id = `ses_real_${nextId}`;
			fake.createdSessions.push({ id, input, removed: false });
			return {
				id,
				location: { directory: input.location?.directory ?? directory },
			};
		},
		async get({ sessionID }: { sessionID: string }) {
			fake.calls.push({ op: 'get', arg: sessionID });
			if (fake.removedSessions.has(sessionID))
				throw new Error('no such session');
			const info = fake.sessionInfos.get(sessionID);
			if (info) return { id: sessionID, ...info };
			return { id: sessionID, location: { directory } };
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
			return fake.contextEntries.get('default') ?? [];
		},
		async interrupt(input: { sessionID: string }) {
			fake.calls.push({ op: 'interrupt', arg: input });
		},
		async switchAgent(input: { sessionID: string; agent: string }) {
			fake.calls.push({ op: 'switchAgent', arg: input });
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

function mirrorRunInit(seen: unknown[]) {
	return {
		runInit: async (input: unknown) => {
			const client = (input as { client?: unknown }).client;
			seen.push(client);
			swarmState.opencodeClient = client as never;
			return { event: async () => {}, dispose: async () => {} };
		},
	};
}

async function withDir(
	fn: (directory: string) => Promise<void>,
): Promise<void> {
	const directory = canonicalMkdtemp('swarm-v2-sc-');
	try {
		await fn(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function flipOneLetterCase(value: string): string {
	const chars = value.split('');
	for (let i = value.length - 1; i >= 0; i -= 1) {
		const char = chars[i]!;
		if (char >= 'a' && char <= 'z') {
			chars[i] = char.toUpperCase();
			return chars.join('');
		}
		if (char >= 'A' && char <= 'Z') {
			chars[i] = char.toLowerCase();
			return chars.join('');
		}
	}
	return value;
}

afterEach(() => {
	resetSwarmState();
	clearV2SessionClientState();
});

describe('v2 session-client shim (issue #3169 Phase 2)', () => {
	test('AC1 full-surface install: opencodeClient truthy and review dispatch completes end-to-end', async () => {
		await withDir(async (directory) => {
			const session = makeFakeSessionDomain(directory);
			const seen: unknown[] = [];
			const cleanup = await openCodeSwarmV2Setup(
				makeFakeCtx(directory, session),
				mirrorRunInit(seen),
			);
			try {
				expect(seen[0]).toBeTruthy();
				expect(swarmState.opencodeClient).toBeTruthy();
				const result = await createReviewModelDispatcher(
					swarmState.opencodeClient as never,
				).dispatch({
					directory,
					agentName: 'mega_reviewer',
					model: {
						providerID: 'requested-provider',
						modelID: 'requested-model',
					},
					system: 'replacement system',
					prompt: 'inspect this diff',
					timeoutMs: 5_000,
				});
				expect(result.status).toBe('completed');
				expect(result.text).toBe('review verdict text');
				expect(result.modelId).toBe('opencode/review-model');
				const created = session.createdSessions[0]?.input;
				expect(created?.agent).toBe('mega_reviewer');
				expect(created?.model).toEqual({
					id: 'requested-model',
					providerID: 'requested-provider',
				});
				expect(created?.location).toEqual({ directory });
				const ops = session.calls.map((c) => c.op);
				expect(ops).toContain('prompt');
				expect(ops).toContain('wait');
				expect(ops).toContain('context');
				expect(ops).toContain('interrupt');
				expect(ops).toContain('remove');
			} finally {
				await cleanup();
			}
		});
	}, 30_000);

	test('AC2 partial hosts: each missing required member keeps the client undefined', () => {
		const directory = canonicalMkdtemp('swarm-v2-sc-');
		try {
			for (const member of [
				'create',
				'get',
				'remove',
				'prompt',
				'wait',
				'context',
				'interrupt',
			] as const) {
				const session = makeFakeSessionDomain(directory) as unknown as Record<
					string,
					unknown
				>;
				delete session[member];
				expect(
					createV2SessionClient(makeFakeCtx(directory, session)),
				).toBeUndefined();
			}
			expect(
				createV2SessionClient(
					makeFakeCtx(directory, makeFakeSessionDomain(directory)),
				),
			).toBeTruthy();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('AC2 setup still completes on a partial host (missing wait)', async () => {
		await withDir(async (directory) => {
			const session = makeFakeSessionDomain(directory) as unknown as Record<
				string,
				unknown
			>;
			delete session.wait;
			const seen: unknown[] = [];
			const cleanup = await openCodeSwarmV2Setup(
				makeFakeCtx(directory, session),
				mirrorRunInit(seen),
			);
			await cleanup();
			expect(seen[0]).toBeUndefined();
		});
	}, 30_000);

	test('AC3 create maps body/query and mints a placeholder without a host call (parentless)', async () => {
		await withDir(async (directory) => {
			const session = makeFakeSessionDomain(directory);
			const client = createV2SessionClient(makeFakeCtx(directory, session))!;
			const result = await client.session.create({
				body: { title: 'bounded review' },
				query: { directory },
			});
			expect(result.data?.id).toMatch(/^v2shim-/);
			expect(session.calls.filter((c) => c.op === 'create')).toHaveLength(0);
		});
	});

	test('AC3 matching parent directory passes the placement precheck', async () => {
		await withDir(async (directory) => {
			const session = makeFakeSessionDomain(directory);
			const client = createV2SessionClient(makeFakeCtx(directory, session))!;
			const result = await client.session.create({
				body: { parentID: 'ses_parent' },
				query: { directory },
			});
			expect(result.data?.id).toMatch(/^v2shim-/);
			expect(session.calls.some((c) => c.op === 'create')).toBe(false);
		});
	});

	// #3169 Phase 3 contract flip (full pins in session-client-lane-3169.test.ts).
	test('AC3 divergent parent directory takes the Phase 3 eager PARENTED real create', async () => {
		await withDir(async (directory) => {
			const laneDirectory = canonicalMkdtemp('swarm-v2-lane-');
			try {
				const session = makeFakeSessionDomain(directory);
				const client = createV2SessionClient(makeFakeCtx(directory, session))!;
				await client.session.create({
					body: { parentID: 'ses_parent' },
					query: { directory: laneDirectory },
				});
				const createCalls = session.calls.filter((c) => c.op === 'create');
				expect(createCalls).toHaveLength(1);
				// Parented create (2.1 resume rule); move pins: *-lane-parent-move.
				expect(createCalls[0].arg).toEqual({
					parentID: 'ses_parent',
					location: { directory: laneDirectory },
				});
			} finally {
				rmSync(laneDirectory, { recursive: true, force: true });
			}
		});
	});

	test('AC3 unverifiable parent placement fails closed with the named assumption', async () => {
		await withDir(async (directory) => {
			const session = makeFakeSessionDomain(directory);
			session.sessionInfos.set('ses_parent', {});
			const client = createV2SessionClient(makeFakeCtx(directory, session))!;
			const result = await client.session.create({
				body: { parentID: 'ses_parent' },
				query: { directory },
			});
			expect(result.data).toBeNull();
			expect(String((result.error as { message: string }).message)).toContain(
				'placement unverifiable',
			);
		});
	});

	test.skipIf(process.platform !== 'win32')(
		'AC3 case-differing identical directories succeed on win32 (lexical key)',
		async () => {
			const directory = canonicalMkdtemp('swarm-v2-case-');
			try {
				const session = makeFakeSessionDomain(directory);
				session.sessionInfos.set('ses_parent', {
					location: { directory: flipOneLetterCase(directory) },
				});
				const client = createV2SessionClient(makeFakeCtx(directory, session))!;
				const result = await client.session.create({
					body: { parentID: 'ses_parent' },
					query: { directory },
				});
				expect(result.data?.id).toMatch(/^v2shim-/);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	test('AC4 prompt translation: deferred create carries agent/model/permissions, hook replaces system fence-aware and deletes denied tools', async () => {
		await withDir(async (directory) => {
			const session = makeFakeSessionDomain(directory);
			const client = createV2SessionClient(makeFakeCtx(directory, session))!;
			const created = await client.session.create({
				body: { title: 'bounded review' },
				query: { directory },
			});
			const placeholderId = created.data!.id;
			const result = await client.session.prompt({
				path: { id: placeholderId },
				body: {
					agent: 'mega_reviewer',
					model: {
						providerID: 'requested-provider',
						modelID: 'requested-model',
					},
					system: 'replacement system',
					tools: { write: false, bash: false } as const,
					parts: [{ type: 'text', text: 'inspect this' }],
				},
			});
			expect(result.data?.parts).toEqual([
				{ type: 'text', text: 'review verdict text' },
			]);
			const createCall = session.createdSessions[0];
			expect(createCall?.input.title).toBe('bounded review');
			expect(createCall?.input.agent).toBe('mega_reviewer');
			expect(createCall?.input.model).toEqual({
				id: 'requested-model',
				providerID: 'requested-provider',
			});
			expect(createCall?.input.permissions).toEqual([
				{ action: 'tool', resource: 'write', effect: 'deny' },
				{ action: 'tool', resource: 'bash', effect: 'deny' },
			]);
			expect(session.calls.find((c) => c.op === 'prompt')?.arg).toEqual({
				sessionID: createCall?.id,
				text: 'inspect this',
			});
			const handler =
				session.contextHandlers[session.contextHandlers.length - 1]!;
			const event = {
				sessionID: createCall?.id,
				system: [
					{ type: 'text', text: 'original host system' },
					{
						type: 'text',
						text: '<swarm_system_directive source="opencode-swarm" kind="guidance">keep me</swarm_system_directive>',
					},
				],
				tools: {
					write: { description: 'w', input: {} },
					read: { description: 'r', input: {} },
				},
				messages: [],
			};
			await handler(event);
			expect(event.system).toEqual([
				{
					type: 'text',
					text: '<swarm_system_directive source="opencode-swarm" kind="guidance">keep me</swarm_system_directive>',
				},
				{ type: 'text', text: 'replacement system' },
			]);
			expect(Object.keys(event.tools)).toEqual(['read']);
			const foreign = {
				sessionID: 'ses_other',
				system: [{ type: 'text', text: 'untouched' }],
				tools: { write: { description: 'w', input: {} } },
			};
			await handler(foreign);
			expect(foreign.system).toEqual([{ type: 'text', text: 'untouched' }]);
			expect(Object.keys(foreign.tools)).toEqual(['write']);
		});
	});

	test('AC4 real-session direct path prompts without re-creating and honors agent switch', async () => {
		await withDir(async (directory) => {
			const session = makeFakeSessionDomain(directory);
			const client = createV2SessionClient(makeFakeCtx(directory, session))!;
			const result = await client.session.prompt({
				path: { id: 'ses_host_existing' },
				body: { agent: 'waker', parts: [{ type: 'text', text: 'wake up' }] },
			});
			expect(result.data?.parts).toEqual([
				{ type: 'text', text: 'review verdict text' },
			]);
			expect(session.calls.filter((c) => c.op === 'create')).toHaveLength(0);
			expect(session.calls.find((c) => c.op === 'switchAgent')?.arg).toEqual({
				sessionID: 'ses_host_existing',
				agent: 'waker',
			});
			expect(session.calls.find((c) => c.op === 'prompt')?.arg).toEqual({
				sessionID: 'ses_host_existing',
				text: 'wake up',
			});
		});
	});

	test('AC4 succeeded turn with empty assistant text stays a completed-empty result (bash-retry signal)', async () => {
		await withDir(async (directory) => {
			const session = makeFakeSessionDomain(directory);
			session.contextEntries.set('default', [
				{ role: 'user', text: 'refused-style prompt' },
				{ type: 'idle', outcome: 'succeeded' },
			]);
			const seen: unknown[] = [];
			const cleanup = await openCodeSwarmV2Setup(
				makeFakeCtx(directory, session),
				mirrorRunInit(seen),
			);
			try {
				const result = await createReviewModelDispatcher(
					swarmState.opencodeClient as never,
				).dispatch({
					directory,
					agentName: 'mega_reviewer',
					system: 's',
					prompt: 'p',
					timeoutMs: 5_000,
				});
				expect(result.status).toBe('completed');
				expect(result.text).toBe('');
				expect(result.providerError).toBeUndefined();
			} finally {
				await cleanup();
			}
		});
	}, 30_000);
});
