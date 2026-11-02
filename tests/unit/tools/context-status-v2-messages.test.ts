/**
 * Regression: context_status on OpenCode v2 must read session.context.
 * The v2 shim keeps session.messages absent so lane tools stay on their
 * typed no-client path. An absent messages() method used to yield 0%.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	clearV2SessionClientState,
	createV2SessionClient,
	readV2SessionContextMessages,
	readV2SessionContextModelIdentity,
} from '../../../src/host/v2/session-client';
import type { V2PluginContext } from '../../../src/host/v2/types';
import { resetSwarmState, swarmState } from '../../../src/state';
import { _internals } from '../../../src/tools/context-status';

function domain() {
	return {
		async hook() {
			return { dispose: async () => {} };
		},
		async create(input: { location?: { directory: string } }) {
			return { id: 'ses_live', location: input.location ?? { directory: '/tmp' } };
		},
		async get({ sessionID }: { sessionID: string }) {
			return { id: sessionID, location: { directory: '/tmp' } };
		},
		async remove() {},
		async prompt() {
			return {};
		},
		async wait() {},
		async context(input: { sessionID: string }) {
			expect(input.sessionID).toBe('ses_live');
			return [
				{ type: 'user', text: 'hello' },
				{
					type: 'assistant',
					text: 'done',
					model: { id: 'MiniMax-M3', providerID: 'minimax' },
					tokens: {
						input: 1200,
						output: 40,
						reasoning: 0,
						cache: { read: 300, write: 10 },
					},
				},
				{ type: 'idle', outcome: 'succeeded' },
			];
		},
		async interrupt() {},
	};
}

function ctx(session: unknown): V2PluginContext {
	return {
		app: { name: 'opencode', version: 'test', channel: 'test' },
		location: { directory: '/tmp', workspaceID: 'w' },
		options: {},
		tool: {},
		agent: {},
		command: {},
		session,
		event: {},
	} as never;
}

afterEach(() => {
	clearV2SessionClientState();
	resetSwarmState();
});

describe('context_status v2 session context', () => {
	test('reads provider tokens from session.context and leaves session.messages absent', async () => {
		const client = createV2SessionClient(ctx(domain()))!;
		expect(
			typeof (client.session as { messages?: unknown }).messages,
		).toBe('undefined');
		swarmState.opencodeClient = client as never;

		const messages = await _internals.fetchSessionMessages(
			'ses_live',
			'/tmp',
			100,
		);

		expect(messages).toHaveLength(2);
		expect(messages?.[1]?.info.role).toBe('assistant');
		expect(messages?.[1]?.info.modelID).toBe('MiniMax-M3');
		expect(messages?.[1]?.info.providerID).toBe('minimax');
		expect(messages?.[1]?.info.tokens).toEqual({
			input: 1200,
			cache: { read: 300, write: 10 },
		});
		expect(messages?.[1]?.parts).toEqual([{ type: 'text', text: 'done' }]);
	});

	test('reads model.modelID shape from v2 context (OpenCode 2.x prompt model ref)', async () => {
		const domainWithModelId = {
			...domain(),
			async context(input: { sessionID: string }) {
				expect(input.sessionID).toBe('ses_live');
				return [
					{
						type: 'assistant',
						text: 'ok',
						model: { modelID: 'MiniMax-M3', providerID: 'minimax' },
						tokens: {
							input: 500,
							output: 1,
							reasoning: 0,
							cache: { read: 0, write: 0 },
						},
					},
				];
			},
		};
		const client = createV2SessionClient(ctx(domainWithModelId))!;
		swarmState.opencodeClient = client as never;
		const messages = await _internals.fetchSessionMessages('ses_live', '/tmp');
		expect(messages?.[0]?.info.modelID).toBe('MiniMax-M3');
		expect(messages?.[0]?.info.providerID).toBe('minimax');
	});

	test('returns null when no v2 session domain is installed', async () => {
		expect(await _internals.fetchSessionMessages('ses_live', '/tmp')).toBeNull();
	});

	test('coalesces one session.context RPC for identity and messages', async () => {
		let contextCalls = 0;
		const session = {
			...domain(),
			async context(input: { sessionID: string }) {
				contextCalls += 1;
				expect(input.sessionID).toBe('ses_live');
				return [
					{
						type: 'assistant',
						text: 'ok',
						tokens: {
							input: 100,
							output: 1,
							reasoning: 0,
							cache: { read: 0, write: 0 },
						},
					},
					{
						type: 'idle',
						outcome: 'succeeded',
						model: { id: 'MiniMax-M3', providerID: 'minimax' },
					},
				];
			},
		};
		const client = createV2SessionClient(ctx(session))!;
		swarmState.opencodeClient = client as never;
		await Promise.all([
			readV2SessionContextModelIdentity('ses_live'),
			readV2SessionContextMessages('ses_live'),
		]);
		expect(contextCalls).toBe(1);
	});

	test('readV2SessionContextModelIdentity scans entries when assistant rows omit model', async () => {
		const domainTokensOnly = {
			...domain(),
			async context(input: { sessionID: string }) {
				expect(input.sessionID).toBe('ses_live');
				return [
					{
						type: 'assistant',
						text: 'ok',
						tokens: {
							input: 150_000,
							output: 1,
							reasoning: 0,
							cache: { read: 6_000, write: 0 },
						},
					},
					{
						type: 'idle',
						outcome: 'succeeded',
						model: { id: 'MiniMax-M3', providerID: 'minimax' },
					},
				];
			},
		};
		const client = createV2SessionClient(ctx(domainTokensOnly))!;
		swarmState.opencodeClient = client as never;
		expect(await readV2SessionContextModelIdentity('ses_live')).toEqual({
			modelID: 'MiniMax-M3',
			providerID: 'minimax',
		});
	});
});
