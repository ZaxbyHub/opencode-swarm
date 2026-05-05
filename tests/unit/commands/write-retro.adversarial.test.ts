/**
 * Adversarial security/robustness tests for handleWriteRetroCommand
 * Tests various attack vectors including JSON injection, oversized payloads,
 * malformed JSON, and error handling edge cases.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// Mock the write-retro tool module
const mockExecuteWriteRetro = mock(
	async (_args: any, _directory: string) => '',
);

mock.module('../../../src/tools/write-retro.js', () => ({
	executeWriteRetro: mockExecuteWriteRetro,
	write_retro: {},
}));

afterEach(() => mock.restore());

// Import AFTER mock setup
const { handleWriteRetroCommand } = await import(
	'../../../src/commands/write-retro.js'
);

describe('handleWriteRetroCommand adversarial', () => {
	beforeEach(() => {
		mockExecuteWriteRetro.mockClear();
		// Default: successful response
		mockExecuteWriteRetro.mockImplementation(async () =>
			JSON.stringify({
				success: true,
				phase: 1,
				task_id: 'retro-1',
				message: 'ok',
			}),
		);
	});

	describe('JSON Injection / Prototype Pollution', () => {
		it('should handle __proto__ pollution attempt without throwing', async () => {
			const args = ['{"__proto__": {"polluted": true}, "phase": 1}'];
			const result = await handleWriteRetroCommand('/test/dir', args);
			// Should call executeWriteRetro normally (proto pollution on parsed object
			// does not affect command output)
			expect(mockExecuteWriteRetro).toHaveBeenCalled();
			expect(result).toContain('Retrospective Written');
		});

		it('should handle constructor.prototype pollution attempt without throwing', async () => {
			const args = [
				'{"constructor": {"prototype": {"polluted": true}}, "phase": 1}',
			];
			const result = await handleWriteRetroCommand('/test/dir', args);
			expect(mockExecuteWriteRetro).toHaveBeenCalled();
			expect(result).toContain('Retrospective Written');
		});
	});

	describe('Oversized payloads', () => {
		it('should handle extremely large summary string without hanging', async () => {
			const args = ['{"phase": 1, "summary": "' + 'A'.repeat(100000) + '"}'];
			const result = await handleWriteRetroCommand('/test/dir', args);
			// Should either call executeWriteRetro or return error without throwing
			expect(result).toMatch(/Retrospective Written|Error:/);
		});

		it('should handle large array of lessons_learned without throwing', async () => {
			const args = [
				'{"phase": 1, "lessons_learned": [' +
					Array(1000).fill('"lesson"').join(',') +
					']}',
			];
			const result = await handleWriteRetroCommand('/test/dir', args);
			// Large arrays should be passed to tool (validation is tool's responsibility)
			expect(mockExecuteWriteRetro).toHaveBeenCalled();
			expect(result).toMatch(/Retrospective Written|Error:/);
		});
	});

	describe('Malformed/boundary JSON', () => {
		it('should handle empty JSON object (valid JSON)', async () => {
			const args = ['{}'];
			const result = await handleWriteRetroCommand('/test/dir', args);
			// Valid JSON object - calls executeWriteRetro (validation is in the tool)
			expect(mockExecuteWriteRetro).toHaveBeenCalled();
		});

		it('should handle negative phase value without throwing', async () => {
			const args = ['{"phase": -999}'];
			const result = await handleWriteRetroCommand('/test/dir', args);
			// Passes through to executeWriteRetro (validation is tool's responsibility)
			expect(mockExecuteWriteRetro).toHaveBeenCalled();
		});

		it('should handle null phase without throwing', async () => {
			const args = ['{"phase": null}'];
			const result = await handleWriteRetroCommand('/test/dir', args);
			// Passes through without throwing
			expect(mockExecuteWriteRetro).toHaveBeenCalled();
		});

		it('should return error for incomplete JSON', async () => {
			const args = ['{'];
			const result = await handleWriteRetroCommand('/test/dir', args);
			expect(result).toContain('Invalid JSON');
		});

		it('should return error for JSON with undefined value', async () => {
			const args = ['{"key": undefined}'];
			const result = await handleWriteRetroCommand('/test/dir', args);
			// undefined is not valid in JSON - should return error
			expect(result).toContain('Invalid JSON');
		});

		it('should not contain XSS script tags in success output', async () => {
			const args = ['{"phase": 1, "summary": "<script>alert(1)</script>"}'];
			const result = await handleWriteRetroCommand('/test/dir', args);
			// Output is markdown - verify no script tags appear literally in success markdown
			expect(result).not.toContain('<script>alert(1)</script>');
		});
	});

	describe('Directory traversal in args', () => {
		it('should pass directory through to executeWriteRetro without modification', async () => {
			const args = ['{"phase": 1}'];
			const result = await handleWriteRetroCommand('../../../etc', args);
			// Command should pass directory through to executeWriteRetro without modification
			expect(mockExecuteWriteRetro).toHaveBeenCalledWith(
				expect.any(Object),
				'../../../etc',
			);
			expect(result).toContain('Retrospective Written');
		});

		it('should handle empty directory string', async () => {
			const args = ['{"phase": 1}'];
			const result = await handleWriteRetroCommand('', args);
			// Empty directory string is passed through, executeWriteRetro handles it
			expect(mockExecuteWriteRetro).toHaveBeenCalledWith(
				expect.any(Object),
				'',
			);
			expect(result).toMatch(/Retrospective Written|Error:/);
		});
	});

	describe('Output content safety', () => {
		it('should use task_id correctly when present', async () => {
			mockExecuteWriteRetro.mockImplementation(async () =>
				JSON.stringify({ success: true, phase: 1, task_id: 'retro-1' }),
			);
			const args = ['{"phase": 1}'];
			const result = await handleWriteRetroCommand('/test/dir', args);
			// task_id present → no 'unknown'
			expect(result).not.toContain('unknown');
			expect(result).toContain('retro-1');
		});

		it('should fallback to unknown when task_id is missing in success response', async () => {
			mockExecuteWriteRetro.mockImplementation(async () =>
				JSON.stringify({ success: true }),
			);
			const args = ['{"phase": 1}'];
			const result = await handleWriteRetroCommand('/test/dir', args);
			// task_id is undefined → output contains 'unknown' (fallback triggered)
			expect(result).toContain('unknown');
		});

		it('should handle undefined message in error response', async () => {
			mockExecuteWriteRetro.mockImplementation(async () =>
				JSON.stringify({ success: false }),
			);
			const args = ['{"phase": 1}'];
			const result = await handleWriteRetroCommand('/test/dir', args);
			// message is undefined → Error: undefined
			expect(result).toBe('Error: undefined');
		});
	});

	describe('Multiple args (whitespace splitting behavior)', () => {
		it('should only read args[0] - split JSON should fail', async () => {
			const args = ['{"phase":', '1}'];
			const result = await handleWriteRetroCommand('/test/dir', args);
			// args[0] is '{"phase":' which is invalid JSON → returns "Invalid JSON" error
			expect(result).toContain('Invalid JSON');
		});
	});

	describe('Numeric JSON edge cases', () => {
		it('should handle huge float without throwing', async () => {
			const args = ['{"phase": 1e308}'];
			const result = await handleWriteRetroCommand('/test/dir', args);
			// Huge float passes to executeWriteRetro without throwing
			expect(mockExecuteWriteRetro).toHaveBeenCalled();
			expect(result).toMatch(/Retrospective Written|Error:/);
		});

		it('should handle negative zero', async () => {
			const args = ['{"phase": -0}'];
			const result = await handleWriteRetroCommand('/test/dir', args);
			// Negative zero passes through
			expect(mockExecuteWriteRetro).toHaveBeenCalled();
		});
	});

	describe('Error propagation from executeWriteRetro', () => {
		it('should handle malformed JSON response from executeWriteRetro', async () => {
			mockExecuteWriteRetro.mockImplementation(async () => 'not valid json {');
			const args = ['{"phase": 1}'];
			const result = await handleWriteRetroCommand('/test/dir', args);
			// Returns parse error message
			expect(result).toBe(
				'Error: Failed to parse result from write-retro tool.',
			);
		});

		it('should propagate error message from executeWriteRetro failure', async () => {
			mockExecuteWriteRetro.mockImplementation(async () =>
				JSON.stringify({
					success: false,
					phase: 2,
					message: 'Database locked',
				}),
			);
			const args = ['{"phase": 1}'];
			const result = await handleWriteRetroCommand('/test/dir', args);
			// Command returns Error: Database locked
			expect(result).toBe('Error: Database locked');
		});
	});
});
