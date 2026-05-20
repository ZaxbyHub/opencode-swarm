import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// Mock functions at module level
const mockSessionCreate = mock(async () => ({ data: { id: 'session-123' } }));
const mockSessionPrompt = mock(async () => ({
	data: { parts: [{ type: 'text', text: '[]' }] },
}));
const mockSessionDelete = mock(async () => ({ data: {} }));

const mockClient = {
	session: {
		create: mockSessionCreate,
		prompt: mockSessionPrompt,
		delete: mockSessionDelete,
	},
};

describe('generateMutants', () => {
	beforeEach(() => {
		mockSessionCreate.mockReset();
		mockSessionPrompt.mockReset();
		mockSessionDelete.mockReset();
		// restore defaults
		mockSessionCreate.mockImplementation(async () => ({
			data: { id: 'session-123' },
		}));
		mockSessionPrompt.mockImplementation(async () => ({
			data: { parts: [{ type: 'text', text: '[]' }] },
		}));
		mockSessionDelete.mockImplementation(async () => ({ data: {} }));
		mock.module('../../state.js', () => ({
			swarmState: { opencodeClient: mockClient },
		}));
	});

	afterEach(() => {
		mock.restore();
	});

	// 1. Returns [] when ctx is undefined (never throws)
	test('returns empty array when ctx is undefined', async () => {
		mock.module('../../state.js', () => ({
			swarmState: { opencodeClient: mockClient },
		}));
		const { generateMutants } = await import('../generator.js');
		const result = await generateMutants(['src/foo.ts'], undefined);
		expect(result).toEqual([]);
	});

	// 2. Returns [] when opencodeClient is null (never throws)
	test('returns empty array when opencodeClient is null', async () => {
		mock.module('../../state.js', () => ({
			swarmState: { opencodeClient: null },
		}));
		const { generateMutants } = await import('../generator.js');
		const result = await generateMutants(['src/foo.ts'], {
			directory: '/proj',
		} as any);
		expect(result).toEqual([]);
	});

	// 3. Calls session.create with ctx.directory
	test('calls session.create with ctx.directory', async () => {
		mock.module('../../state.js', () => ({
			swarmState: { opencodeClient: mockClient },
		}));
		const { generateMutants } = await import('../generator.js');
		await generateMutants(['src/foo.ts'], { directory: '/test-dir' } as any);
		expect(mockSessionCreate).toHaveBeenCalledWith({
			query: { directory: '/test-dir' },
		});
	});

	// 4. Falls back to process.cwd() when ctx.directory is undefined
	test('falls back to process.cwd() when ctx.directory is undefined', async () => {
		mock.module('../../state.js', () => ({
			swarmState: { opencodeClient: mockClient },
		}));
		const { generateMutants } = await import('../generator.js');
		await generateMutants(['src/foo.ts'], {} as any);
		expect(mockSessionCreate).toHaveBeenCalledWith({
			query: { directory: process.cwd() },
		});
	});

	// 5. Returns [] when session.create fails (data is falsy)
	test('returns empty array when session.create fails', async () => {
		mockSessionCreate.mockImplementation(
			async () =>
				({
					data: null,
					error: 'create-failed',
				}) as any,
		);
		mock.module('../../state.js', () => ({
			swarmState: { opencodeClient: mockClient },
		}));
		const { generateMutants } = await import('../generator.js');
		const result = await generateMutants(['src/foo.ts'], {
			directory: '/proj',
		} as any);
		expect(result).toEqual([]);
	});

	// 6. Returns [] when session.prompt fails (data is falsy)
	test('returns empty array when session.prompt fails', async () => {
		mockSessionPrompt.mockImplementation(
			async () =>
				({
					data: null,
					error: 'prompt-failed',
				}) as any,
		);
		mock.module('../../state.js', () => ({
			swarmState: { opencodeClient: mockClient },
		}));
		const { generateMutants } = await import('../generator.js');
		const result = await generateMutants(['src/foo.ts'], {
			directory: '/proj',
		} as any);
		expect(result).toEqual([]);
	});

	// 7. Returns [] when LLM returns non-JSON text
	test('returns empty array when LLM returns non-JSON text', async () => {
		mockSessionPrompt.mockImplementation(async () => ({
			data: { parts: [{ type: 'text', text: 'not json at all' }] },
		}));
		mock.module('../../state.js', () => ({
			swarmState: { opencodeClient: mockClient },
		}));
		const { generateMutants } = await import('../generator.js');
		const result = await generateMutants(['src/foo.ts'], {
			directory: '/proj',
		} as any);
		expect(result).toEqual([]);
	});

	// 8. Returns [] when LLM returns non-array JSON (e.g., an object)
	test('returns empty array when LLM returns non-array JSON', async () => {
		mockSessionPrompt.mockImplementation(async () => ({
			data: { parts: [{ type: 'text', text: '{"key":"value"}' }] },
		}));
		mock.module('../../state.js', () => ({
			swarmState: { opencodeClient: mockClient },
		}));
		const { generateMutants } = await import('../generator.js');
		const result = await generateMutants(['src/foo.ts'], {
			directory: '/proj',
		} as any);
		expect(result).toEqual([]);
	});

	// 9. Items with valid mut-* id are preserved as-is
	test('items with valid mut-* id are preserved as-is', async () => {
		const item = {
			id: 'mut-123',
			filePath: 'src/foo.ts',
			functionName: 'bar',
			mutationType: 'off-by-one',
			patch: '--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,3 @@\n-old\n+new',
		};
		mockSessionPrompt.mockImplementation(async () => ({
			data: { parts: [{ type: 'text', text: JSON.stringify([item]) }] },
		}));
		mock.module('../../state.js', () => ({
			swarmState: { opencodeClient: mockClient },
		}));
		const { generateMutants } = await import('../generator.js');
		const result = await generateMutants(['src/foo.ts'], {
			directory: '/proj',
		} as any);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('mut-123');
	});

	// 10. Items with missing/non-string id get a generated fallback ID (THE BUG FIX TEST)
	test('items with missing/non-string id get a generated fallback ID', async () => {
		const item = {
			id: 42, // number, not string
			filePath: 'src/foo.ts',
			functionName: 'bar',
			mutationType: 'off-by-one',
			patch: '--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,3 @@\n-old\n+new',
		};
		mockSessionPrompt.mockImplementation(async () => ({
			data: { parts: [{ type: 'text', text: JSON.stringify([item]) }] },
		}));
		mock.module('../../state.js', () => ({
			swarmState: { opencodeClient: mockClient },
		}));
		const { generateMutants } = await import('../generator.js');
		const result = await generateMutants(['src/foo.ts'], {
			directory: '/proj',
		} as any);
		expect(result).toHaveLength(1);
		expect(result[0].id).toMatch(/^mut-/);
		expect(result[0].id).not.toBe('mut-123');
	});

	// 11. Parses JSON wrapped in markdown code fence (```json ... ```)
	test('parses valid JSON array wrapped in markdown code fence', async () => {
		const item = {
			id: 'mut-001',
			filePath: 'src/foo.ts',
			functionName: 'bar',
			mutationType: 'off-by-one',
			patch: '--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-x\n+y',
		};
		const fencedText = '```json\n' + JSON.stringify([item]) + '\n```';
		mockSessionPrompt.mockImplementation(async () => ({
			data: { parts: [{ type: 'text', text: fencedText }] },
		}));
		mock.module('../../state.js', () => ({
			swarmState: { opencodeClient: mockClient },
		}));
		const { generateMutants } = await import('../generator.js');
		const result = await generateMutants(['src/foo.ts'], {
			directory: '/proj',
		} as any);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('mut-001');
	});

	// 12. Parses JSON preceded by natural-language preamble (e.g. "I'll generate...")
	test('parses JSON array preceded by natural-language preamble starting with "I"', async () => {
		const item = {
			id: 'mut-002',
			filePath: 'src/foo.ts',
			functionName: 'baz',
			mutationType: 'null-substitution',
			patch: '--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-x\n+null',
		};
		const prefixedText =
			"I'll generate mutations for the specified files.\n" +
			JSON.stringify([item]);
		mockSessionPrompt.mockImplementation(async () => ({
			data: { parts: [{ type: 'text', text: prefixedText }] },
		}));
		mock.module('../../state.js', () => ({
			swarmState: { opencodeClient: mockClient },
		}));
		const { generateMutants } = await import('../generator.js');
		const result = await generateMutants(['src/foo.ts'], {
			directory: '/proj',
		} as any);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('mut-002');
	});

	// 13. Parses JSON preceded by natural-language preamble starting with "Let"
	test('parses JSON array preceded by natural-language preamble starting with "Let"', async () => {
		const item = {
			id: 'mut-003',
			filePath: 'src/foo.ts',
			functionName: 'qux',
			mutationType: 'operator-swap',
			patch: '--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-+\n-+',
		};
		const prefixedText =
			'Let me analyze the files and generate some mutations:\n' +
			JSON.stringify([item]);
		mockSessionPrompt.mockImplementation(async () => ({
			data: { parts: [{ type: 'text', text: prefixedText }] },
		}));
		mock.module('../../state.js', () => ({
			swarmState: { opencodeClient: mockClient },
		}));
		const { generateMutants } = await import('../generator.js');
		const result = await generateMutants(['src/foo.ts'], {
			directory: '/proj',
		} as any);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('mut-003');
	});

	// 14. Parses JSON when prose contains bare-word bracket (e.g. "[off-by-one]") before the array
	test('parses JSON array when prose contains bare-word brackets before it', async () => {
		const item = {
			id: 'mut-004',
			filePath: 'src/foo.ts',
			functionName: 'fn',
			mutationType: 'off-by-one',
			patch: '--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-x\n+y',
		};
		const prefixedText =
			'Applied [off-by-one] mutation to src/foo.ts:\n' + JSON.stringify([item]);
		mockSessionPrompt.mockImplementation(async () => ({
			data: { parts: [{ type: 'text', text: prefixedText }] },
		}));
		mock.module('../../state.js', () => ({
			swarmState: { opencodeClient: mockClient },
		}));
		const { generateMutants } = await import('../generator.js');
		const result = await generateMutants(['src/foo.ts'], {
			directory: '/proj',
		} as any);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('mut-004');
	});

	// 15. Returns [] when LLM returns only natural-language text with no JSON array
	test('returns empty array when LLM returns only natural-language text with no JSON', async () => {
		mockSessionPrompt.mockImplementation(async () => ({
			data: {
				parts: [
					{
						type: 'text',
						text: "I'm unable to generate mutations for the specified files.",
					},
				],
			},
		}));
		mock.module('../../state.js', () => ({
			swarmState: { opencodeClient: mockClient },
		}));
		const { generateMutants } = await import('../generator.js');
		const result = await generateMutants(['src/foo.ts'], {
			directory: '/proj',
		} as any);
		expect(result).toEqual([]);
	});
});
