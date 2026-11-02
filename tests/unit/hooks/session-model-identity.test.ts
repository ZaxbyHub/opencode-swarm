import { afterEach, describe, expect, test } from 'bun:test';
import {
	clearV2SessionClientState,
	createV2SessionClient,
} from '../../../src/host/v2/session-client';
import type { V2PluginContext } from '../../../src/host/v2/types';
import {
	needsV2ModelIdentityScan,
	resolveSessionModelIdentity,
} from '../../../src/hooks/session-model-identity';
import { resetSwarmState, swarmState } from '../../../src/state';

function domainBase() {
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

describe('session-model-identity', () => {
	afterEach(() => {
		clearV2SessionClientState();
		resetSwarmState();
	});

	test('needsV2ModelIdentityScan when provider is set but modelID is missing', () => {
		expect(needsV2ModelIdentityScan({ providerID: 'minimax' })).toBe(true);
		expect(
			needsV2ModelIdentityScan({
				modelID: 'MiniMax-M3',
				providerID: 'minimax',
			}),
		).toBe(false);
	});

	test('resolveSessionModelIdentity fetches v2 when live cache has provider only', async () => {
		const session = {
			...domainBase(),
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
		const client = createV2SessionClient(ctx(session))!;
		swarmState.opencodeClient = client as never;

		const identity = await resolveSessionModelIdentity({
			sessionID: 'ses_live',
			targetModelInfo: { providerID: 'minimax' },
			messages: [
				{
					info: {
						role: 'assistant',
						sessionID: 'ses_live',
						providerID: 'minimax',
					},
					parts: [{ text: 'x' }],
				},
			],
		});

		expect(identity).toEqual({
			modelID: 'MiniMax-M3',
			providerID: 'minimax',
		});
	});
});
