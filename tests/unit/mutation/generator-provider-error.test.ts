/**
 * `generateMutants` reads the provider error OpenCode records on the
 * assistant message (`info.error`). `session.prompt` answers HTTP 200 with the
 * failure there and no text; reading only the text parts turned a transient
 * 429 into an empty patch set without a retry.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateMutants } from '../../../src/mutation/generator';
import { swarmState } from '../../../src/state';

type GeneratorCtx = Parameters<typeof generateMutants>[1];

const PATCH = JSON.stringify([
	{
		id: 'mut-001',
		filePath: 'src/a.ts',
		functionName: 'f',
		mutationType: 'operator-swap',
		patch: '--- a/src/a.ts\n+++ a/src/a.ts\n@@ -1 +1 @@\n-a + b\n+a - b',
	},
]);

function infoError(statusCode: number, message: string) {
	return {
		data: {
			info: { error: { name: 'APIError', data: { statusCode, message } } },
			parts: [],
		},
	};
}

let savedClient: unknown;
beforeEach(() => {
	savedClient = (swarmState as { opencodeClient: unknown }).opencodeClient;
});
afterEach(() => {
	(swarmState as { opencodeClient: unknown }).opencodeClient = savedClient;
});

function installClient(responses: unknown[]): { calls: number } {
	const state = { calls: 0 };
	(swarmState as { opencodeClient: unknown }).opencodeClient = {
		session: {
			create: async () => ({ data: { id: 'mut-sess' } }),
			prompt: async () => responses[state.calls++] ?? responses.at(-1),
			delete: async () => ({}),
		},
	};
	return state;
}

describe('generateMutants — provider error on the assistant message', () => {
	test('a 429 recorded as info.error is retried', async () => {
		const state = installClient([
			infoError(429, 'Rate limit exceeded'),
			{ data: { parts: [{ type: 'text', text: PATCH }] } },
		]);
		const patches = await generateMutants(['src/a.ts'], {
			directory: '/tmp/mut',
		} as unknown as GeneratorCtx);
		expect(state.calls).toBe(2);
		expect(patches.map((p) => p.id)).toEqual(['mut-001']);
	});

	test('a permanent provider refusal is not retried and yields no patches', async () => {
		const state = installClient([
			infoError(403, 'free tier refused'),
			{ data: { parts: [{ type: 'text', text: PATCH }] } },
		]);
		const patches = await generateMutants(['src/a.ts'], {
			directory: '/tmp/mut',
		} as unknown as GeneratorCtx);
		expect(state.calls).toBe(1);
		expect(patches).toEqual([]);
	});
});
