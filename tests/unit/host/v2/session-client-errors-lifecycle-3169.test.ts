/**
 * #3169 Phase 2 — v2 session-client shim: event-sourced provider errors and
 * lifecycle mapping (AC5-AC6). Fakes only; no mock.module, no clock reads.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	clearV2SessionClientState,
	createV2SessionClient,
	recordV2SessionErrorFromEnvelope,
} from '../../../../src/host/v2/session-client';
import type { V2PluginContext } from '../../../../src/host/v2/types';
import { createReviewModelDispatcher } from '../../../../src/review/contracts';
import { resetSwarmState, swarmState } from '../../../../src/state';
import { teardownEphemeralSessionVerified } from '../../../../src/utils/ephemeral-session-teardown';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

interface FakeDomain {
	calls: Array<{ op: string; arg: unknown }>;
	createdSessions: Array<{
		id: string;
		input: { location?: { directory: string } };
		removed: boolean;
	}>;
	contextEntries: unknown[];
	removedSessions: Set<string>;
	contextHandlers: Array<(event: unknown) => Promise<void>>;
	nextId: number;
}

function makeFakeDomain(
	directory: string,
	contextEntries: unknown[],
	hooks: { onWait?: () => void } = {},
): FakeDomain {
	const fake: FakeDomain = {
		calls: [],
		createdSessions: [],
		contextEntries,
		removedSessions: new Set(),
		contextHandlers: [],
		nextId: 0,
	};
	return {
		...fake,
		async hook(_name: string, callback: (event: unknown) => Promise<void>) {
			fake.contextHandlers.push(callback);
			return { dispose: async () => {} };
		},
		async create(input: { location?: { directory: string } }) {
			fake.calls.push({ op: 'create', arg: input });
			fake.nextId += 1;
			const id = `ses_real_${fake.nextId}`;
			fake.createdSessions.push({ id, input, removed: false });
			return { id, location: input.location ?? { directory } };
		},
		async get({ sessionID }: { sessionID: string }) {
			fake.calls.push({ op: 'get', arg: sessionID });
			if (fake.removedSessions.has(sessionID)) {
				throw new Error('no such session');
			}
			return { id: sessionID, location: { directory } };
		},
		async remove({ sessionID }: { sessionID: string }) {
			fake.calls.push({ op: 'remove', arg: sessionID });
			fake.removedSessions.add(sessionID);
		},
		async prompt(input: unknown) {
			fake.calls.push({ op: 'prompt', arg: input });
			return {};
		},
		async wait(input: unknown) {
			fake.calls.push({ op: 'wait', arg: input });
			// The real event pump records the failure envelope while the wait
			// is in flight — mirror that ordering so the epoch-scoped prompt
			// delete does not clear it.
			hooks.onWait?.();
		},
		async context(_input: unknown) {
			fake.calls.push({ op: 'context', arg: _input });
			return fake.contextEntries;
		},
		async interrupt(input: unknown) {
			fake.calls.push({ op: 'interrupt', arg: input });
		},
		async switchAgent(input: unknown) {
			fake.calls.push({ op: 'switchAgent', arg: input });
		},
	} as FakeDomain;
}

function makeFakeCtx(directory: string, domain: unknown): V2PluginContext {
	return {
		app: { name: 'opencode', version: 'test', channel: 'test' },
		location: { directory, workspaceID: 'w' },
		options: {},
		tool: {},
		agent: {},
		command: {},
		session: domain,
		event: {},
	} as never;
}

const OK_ENTRIES = [
	{ role: 'user', text: 'p' },
	{ role: 'assistant', text: 'review verdict text' },
	{ type: 'idle', outcome: 'succeeded' },
];

const FAILED_ENTRIES = [
	{ role: 'user', text: 'p' },
	{ type: 'idle', outcome: 'failed' },
];

function authEnvelope(sessionID: string) {
	return {
		type: 'session.execution.failed',
		data: {
			sessionID,
			error: {
				name: 'APIError',
				data: {
					message: 'Forbidden: tool configuration not allowed',
					statusCode: 403,
					isRetryable: false,
				},
			},
		},
	};
}

afterEach(() => {
	resetSwarmState();
	clearV2SessionClientState();
});

describe('v2 session-client errors + lifecycle (issue #3169 Phase 2)', () => {
	test('AC5 recorded event error classifies to the v1 providerError category', async () => {
		const directory = canonicalMkdtemp('swarm-v2-el-');
		try {
			const domain = makeFakeDomain(directory, FAILED_ENTRIES, {
				onWait: () =>
					recordV2SessionErrorFromEnvelope(authEnvelope('ses_real_1')),
			});
			const client = createV2SessionClient(makeFakeCtx(directory, domain))!;
			const dispatcher = createReviewModelDispatcher(client as never);
			const result = await dispatcher.dispatch({
				directory,
				agentName: 'mega_reviewer',
				system: 's',
				prompt: 'p',
				timeoutMs: 5_000,
			});
			expect(result.status).toBe('error');
			expect(result.providerError).toEqual({
				name: 'APIError',
				statusCode: 403,
				message: 'Forbidden: tool configuration not allowed 403',
				category: 'provider.authentication_configuration',
				retryClass: 'operator_action',
				risk: 'high',
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('AC5 failed outcome without recorded detail yields bounded provider.unknown', async () => {
		const directory = canonicalMkdtemp('swarm-v2-el-');
		try {
			const domain = makeFakeDomain(directory, FAILED_ENTRIES);
			const client = createV2SessionClient(makeFakeCtx(directory, domain))!;
			const dispatcher = createReviewModelDispatcher(client as never);
			const result = await dispatcher.dispatch({
				directory,
				agentName: 'mega_reviewer',
				system: 's',
				prompt: 'p',
				timeoutMs: 5_000,
			});
			expect(result.status).toBe('error');
			expect(result.providerError?.category).toBe('provider.unknown');
			expect(result.providerError?.name).toBe('ProviderError');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 10_000);

	test('AC5 recorded error with partial assistant text and NO idle entry classifies as error', async () => {
		const directory = canonicalMkdtemp('swarm-v2-el-');
		try {
			const domain = makeFakeDomain(
				directory,
				[
					{ role: 'user', text: 'p' },
					{ role: 'assistant', text: 'partial answer' },
				],
				{
					onWait: () =>
						recordV2SessionErrorFromEnvelope(authEnvelope('ses_real_1')),
				},
			);
			const client = createV2SessionClient(makeFakeCtx(directory, domain))!;
			const dispatcher = createReviewModelDispatcher(client as never);
			const result = await dispatcher.dispatch({
				directory,
				agentName: 'mega_reviewer',
				system: 's',
				prompt: 'p',
				timeoutMs: 5_000,
			});
			expect(result.status).toBe('error');
			expect(result.providerError?.category).toBe(
				'provider.authentication_configuration',
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('AC5 a prior turn error does not poison a later prompt (cleared per dispatch)', async () => {
		const directory = canonicalMkdtemp('swarm-v2-el-');
		try {
			recordV2SessionErrorFromEnvelope(authEnvelope('ses_host_1'));
			const domain = makeFakeDomain(directory, OK_ENTRIES);
			const client = createV2SessionClient(makeFakeCtx(directory, domain))!;
			const result = await (
				client.session as never as {
					prompt: (args: unknown) => Promise<{ data: { parts: unknown[] } }>;
				}
			).prompt({
				path: { id: 'ses_host_1' },
				body: { parts: [{ type: 'text', text: 'again' }] },
			});
			expect(result.data.parts).toEqual([
				{ type: 'text', text: 'review verdict text' },
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('AC5 user-only entries never echo as the answer', async () => {
		const directory = canonicalMkdtemp('swarm-v2-el-');
		try {
			const domain = makeFakeDomain(directory, [
				{ role: 'user', text: 'the user said this' },
				{ type: 'idle', outcome: 'succeeded' },
			]);
			const client = createV2SessionClient(makeFakeCtx(directory, domain))!;
			const dispatcher = createReviewModelDispatcher(client as never);
			const result = await dispatcher.dispatch({
				directory,
				agentName: 'mega_reviewer',
				system: 's',
				prompt: 'p',
				timeoutMs: 5_000,
			});
			expect(result.status).toBe('completed');
			expect(result.text).toBe('');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('AC5 two-turn context joins only the final turn assistant entries', async () => {
		const directory = canonicalMkdtemp('swarm-v2-el-');
		try {
			const domain = makeFakeDomain(directory, [
				{ role: 'user', text: 'turn one' },
				{ role: 'assistant', text: 'old answer' },
				{ role: 'user', text: 'turn two' },
				{ role: 'assistant', text: 'new answer a' },
				{ role: 'assistant', text: 'new answer b' },
				{ type: 'idle', outcome: 'succeeded' },
			]);
			const client = createV2SessionClient(makeFakeCtx(directory, domain))!;
			const dispatcher = createReviewModelDispatcher(client as never);
			const result = await dispatcher.dispatch({
				directory,
				agentName: 'mega_reviewer',
				system: 's',
				prompt: 'p',
				timeoutMs: 5_000,
			});
			expect(result.text).toBe('new answer a\nnew answer b');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('AC5 the error store is bounded (oldest entries evicted at the cap)', async () => {
		const directory = canonicalMkdtemp('swarm-v2-el-');
		try {
			for (let i = 0; i < 140; i += 1) {
				recordV2SessionErrorFromEnvelope(authEnvelope(`ses_evict_${i}`));
			}
			const domain = makeFakeDomain(directory, FAILED_ENTRIES, {
				onWait: () =>
					recordV2SessionErrorFromEnvelope(authEnvelope('ses_real_1')),
			});
			const client = createV2SessionClient(makeFakeCtx(directory, domain))!;
			const dispatcher = createReviewModelDispatcher(client as never);
			const result = await dispatcher.dispatch({
				directory,
				agentName: 'mega_reviewer',
				system: 's',
				prompt: 'p',
				timeoutMs: 5_000,
			});
			expect(result.providerError?.name).toBe('APIError');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('AC6 abort maps to interrupt and delete resolves the placeholder to the real session', async () => {
		const directory = canonicalMkdtemp('swarm-v2-el-');
		try {
			const domain = makeFakeDomain(directory, OK_ENTRIES);
			const client = createV2SessionClient(makeFakeCtx(directory, domain))!;
			const session = client.session as never as {
				create: (args: unknown) => Promise<{ data: { id: string } | null }>;
				prompt: (args: unknown) => Promise<unknown>;
				abort: (args: { path: { id: string } }) => Promise<unknown>;
				delete: (args: { path: { id: string } }) => Promise<unknown>;
				get: (args: { path: { id: string } }) => Promise<{ data: unknown }>;
			};
			const created = await session.create({
				body: { title: 't' },
				query: { directory },
			});
			const placeholderId = created.data!.id;
			await session.abort({ path: { id: placeholderId } });
			expect(domain.calls.filter((c) => c.op === 'interrupt')).toHaveLength(0);
			await session.prompt({
				path: { id: placeholderId },
				body: { parts: [{ type: 'text', text: 'p' }] },
			});
			const realId = domain.createdSessions[0]!.id;
			await session.delete({ path: { id: placeholderId } });
			expect(domain.calls.find((c) => c.op === 'remove')?.arg).toBe(realId);
			expect(domain.removedSessions.has(realId)).toBe(true);
			// PRR-006 (#3186 review): the shim get normalizes host rejections to
			// the v1 {data, error} envelope instead of rejecting.
			const postDelete = await session.get({ path: { id: placeholderId } });
			expect(postDelete.data).toBeNull();
			expect(postDelete.error).toBeInstanceOf(Error);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('AC6 unresolved placeholder get reads as gone and verified teardown resolves', async () => {
		const directory = canonicalMkdtemp('swarm-v2-el-');
		try {
			const domain = makeFakeDomain(directory, OK_ENTRIES);
			const client = createV2SessionClient(makeFakeCtx(directory, domain))!;
			const session = client.session as never as {
				create: (args: unknown) => Promise<{ data: { id: string } | null }>;
				prompt: (args: unknown) => Promise<unknown>;
				get: (args: { path: { id: string } }) => Promise<{ data: unknown }>;
			};
			const created = await session.create({
				body: { title: 't' },
				query: { directory },
			});
			const placeholderId = created.data!.id;
			const beforePrompt = await session.get({ path: { id: placeholderId } });
			expect(beforePrompt.data).toBeNull();
			await session.prompt({
				path: { id: placeholderId },
				body: { parts: [{ type: 'text', text: 'p' }] },
			});
			const verification = await teardownEphemeralSessionVerified(
				client.session,
				placeholderId,
			);
			expect(verification.ok).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	// Review round 1 regression: the dispatcher's timeout teardown races the
	// in-flight prompt (its awaitWithAbort rejects without awaiting the shim's
	// promise), so abort/delete arrive before realId is bound. The pending
	// flags must defer the cleanup to the prompt's finally — a never-resolving
	// wait with a short dispatcher timeout is the exact production shape.
	test('AC6 timed-out dispatch teardown still removes the real session (abort-before-resolution race)', async () => {
		const directory = canonicalMkdtemp('swarm-v2-race-');
		try {
			const domain = makeFakeDomain(directory, OK_ENTRIES);
			// Realistic latency: the host interrupt/prompt take a few ticks.
			const hangMs = 50;
			const client = createV2SessionClient(makeFakeCtx(directory, domain))!;
			const realWait = domain.wait;
			(domain as unknown as Record<string, unknown>).wait = async (
				input: unknown,
			) => {
				await new Promise((resolve) => setTimeout(resolve, hangMs * 4));
				return realWait(input);
			};
			const dispatcher = createReviewModelDispatcher(client as never);
			const result = await dispatcher.dispatch({
				directory,
				agentName: 'mega_reviewer',
				system: 's',
				prompt: 'slow prompt',
				timeoutMs: hangMs,
			});
			expect(result.status).toBe('timeout');
			// Give the still-running prompt promise its finally turn.
			await new Promise((resolve) => setTimeout(resolve, hangMs * 8));
			const realId = domain.createdSessions[0]!.id;
			expect(domain.removedSessions.has(realId)).toBe(true);
			expect(
				domain.calls.some(
					(c) =>
						c.op === 'interrupt' &&
						(c.arg as { sessionID?: string } | undefined)?.sessionID === realId,
				),
			).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 10_000);
});
