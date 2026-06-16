import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateMutants } from '../../../src/mutation/generator';
import { swarmState } from '../../../src/state';

// Fix A: the ephemeral mutation-generator session must bind to the calling
// session (parentID) so OpenCode treats it as a child rather than a new TUI
// root. We mutate the real swarmState singleton and restore it afterwards.

type GeneratorCtx = Parameters<typeof generateMutants>[1];

let savedClient: unknown;

beforeEach(() => {
	savedClient = (swarmState as { opencodeClient: unknown }).opencodeClient;
});

afterEach(() => {
	(swarmState as { opencodeClient: unknown }).opencodeClient = savedClient;
});

describe('generateMutants background session parenting', () => {
	test('attaches parentID + background title when ctx.sessionID is present', async () => {
		let capturedBody: { parentID?: string; title?: string } | undefined;
		(swarmState as { opencodeClient: unknown }).opencodeClient = {
			session: {
				create: async (params: {
					body?: { parentID?: string; title?: string };
				}) => {
					capturedBody = params.body;
					return { data: { id: 'mut-sess' } };
				},
				// Returning a non-JSON body makes generateMutants return [],
				// but session.create has already been captured by then.
				prompt: async () => ({
					data: { parts: [{ type: 'text', text: '[]' }] },
				}),
				delete: async () => ({}),
			},
		};

		await generateMutants(['src/a.ts'], {
			sessionID: 'mut-parent',
			directory: '/tmp/mut',
		} as unknown as GeneratorCtx);

		expect(capturedBody?.parentID).toBe('mut-parent');
		expect(capturedBody?.title).toContain('background');
	});

	test('omits body (root session) when ctx has no sessionID', async () => {
		let capturedBody: unknown;
		(swarmState as { opencodeClient: unknown }).opencodeClient = {
			session: {
				create: async (params: { body?: unknown }) => {
					capturedBody = params.body;
					return { data: { id: 'mut-sess' } };
				},
				prompt: async () => ({
					data: { parts: [{ type: 'text', text: '[]' }] },
				}),
				delete: async () => ({}),
			},
		};

		await generateMutants(['src/a.ts'], {
			directory: '/tmp/mut',
		} as unknown as GeneratorCtx);

		expect(capturedBody).toBeUndefined();
	});
});
