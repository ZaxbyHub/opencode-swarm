/**
 * Tests for handleWriteRetroCommand
 * Verifies the command handler for /swarm write-retro
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// Mock the write-retro tool module
const mockExecuteWriteRetro = mock(
	async (_args: unknown, _directory: string) => '',
);

mock.module('../../../src/tools/write-retro.js', () => ({
	executeWriteRetro: mockExecuteWriteRetro,
	write_retro: {},
}));

// Import AFTER mock setup
const { handleWriteRetroCommand } = await import(
	'../../../src/commands/write-retro.js'
);

describe('handleWriteRetroCommand', () => {
	beforeEach(() => {
		mockExecuteWriteRetro.mockClear();
	});

	afterEach(() => {
		mock.restore();
	});

	describe('Usage instructions (no/empty args)', () => {
		it('should return usage markdown when args is empty array', async () => {
			const result = await handleWriteRetroCommand('/test/dir', []);
			expect(result).toContain('## Usage: /swarm write-retro <json>');
		});

		it('should return usage markdown when args[0] is empty string', async () => {
			const result = await handleWriteRetroCommand('/test/dir', ['']);
			expect(result).toContain('## Usage: /swarm write-retro <json>');
		});

		it('should return usage markdown when args[0] is whitespace-only', async () => {
			const result = await handleWriteRetroCommand('/test/dir', ['   ']);
			expect(result).toContain('## Usage: /swarm write-retro <json>');
		});

		it('usage text contains all required JSON fields', async () => {
			const result = await handleWriteRetroCommand('/test/dir', []);
			expect(result).toContain('"phase": 1');
			expect(result).toContain('"summary"');
			expect(result).toContain('"task_count": 3');
			expect(result).toContain('"total_tool_calls": 20');
			expect(result).toContain('"coder_revisions": 1');
			expect(result).toContain('"reviewer_rejections": 0');
			expect(result).toContain('"test_failures": 0');
			expect(result).toContain('"security_findings": 0');
			expect(result).toContain('"integration_issues": 0');
		});

		it('usage text contains task_complexity hint with all valid values', async () => {
			const result = await handleWriteRetroCommand('/test/dir', []);
			expect(result).toContain('trivial | simple | moderate | complex');
		});
	});

	describe('JSON parse validation', () => {
		it('should return error for invalid JSON string', async () => {
			const result = await handleWriteRetroCommand('/test/dir', ['not-json']);
			expect(result).toContain('Invalid JSON');
		});

		it('should return error when JSON is an array', async () => {
			const result = await handleWriteRetroCommand('/test/dir', ['[1,2,3]']);
			expect(result).toContain('Invalid JSON');
		});

		it('should return error when JSON is null literal', async () => {
			const result = await handleWriteRetroCommand('/test/dir', ['null']);
			expect(result).toContain('Invalid JSON');
		});

		it('should return error when JSON is a number', async () => {
			const result = await handleWriteRetroCommand('/test/dir', ['42']);
			expect(result).toContain('Invalid JSON');
		});
	});

	describe('Success path', () => {
		it('should return success markdown when executeWriteRetro returns success', async () => {
			const mockResult = JSON.stringify({
				success: true,
				phase: 4,
				task_id: 'retro-4',
				message:
					'Retrospective evidence written to .swarm/evidence/retro-4/evidence.json',
			});
			mockExecuteWriteRetro.mockImplementation(async () => mockResult);

			const result = await handleWriteRetroCommand('/test/dir', [
				JSON.stringify({
					phase: 4,
					summary: 'Phase 4 complete',
					task_count: 3,
					task_complexity: 'simple',
					total_tool_calls: 100,
					coder_revisions: 2,
					reviewer_rejections: 1,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
				}),
			]);

			expect(result).toContain('## Retrospective Written');
			expect(result).toContain('Phase **4**');
			expect(result).toContain('.swarm/evidence/retro-4/evidence.json');
		});

		it('should contain task_id twice when executeWriteRetro returns success with custom task_id', async () => {
			const mockResult = JSON.stringify({
				success: true,
				phase: 5,
				task_id: 'retro-5',
				message:
					'Retrospective evidence written to .swarm/evidence/retro-5/evidence.json',
			});
			mockExecuteWriteRetro.mockImplementation(async () => mockResult);

			const result = await handleWriteRetroCommand('/test/dir', [
				JSON.stringify({
					phase: 5,
					summary: 'Phase 5 complete',
					task_count: 2,
					task_complexity: 'moderate',
					total_tool_calls: 50,
					coder_revisions: 1,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_id: 'retro-5',
				}),
			]);

			// task_id appears twice: once in path, once in evidence command
			const taskIdCount = (result.match(/retro-5/g) || []).length;
			expect(taskIdCount).toBe(2);
		});

		it('should contain Phase 5 when executeWriteRetro returns success with phase 5', async () => {
			const mockResult = JSON.stringify({
				success: true,
				phase: 5,
				task_id: 'retro-5',
				message: 'Retrospective evidence written',
			});
			mockExecuteWriteRetro.mockImplementation(async () => mockResult);

			const result = await handleWriteRetroCommand('/test/dir', [
				JSON.stringify({
					phase: 5,
					summary: 'Phase 5 complete',
					task_count: 1,
					task_complexity: 'complex',
					total_tool_calls: 200,
					coder_revisions: 3,
					reviewer_rejections: 2,
					test_failures: 1,
					security_findings: 0,
					integration_issues: 0,
				}),
			]);

			expect(result).toContain('Phase **5**');
		});

		it('should pass through optional lessons_learned field', async () => {
			const mockResult = JSON.stringify({
				success: true,
				phase: 3,
				task_id: 'retro-3',
				message: 'Written',
			});
			mockExecuteWriteRetro.mockImplementation(async () => mockResult);

			await handleWriteRetroCommand('/test/dir', [
				JSON.stringify({
					phase: 3,
					summary: 'Phase 3 summary',
					task_count: 1,
					task_complexity: 'simple',
					total_tool_calls: 10,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					lessons_learned: ['Always test your code', 'Read before edit'],
				}),
			]);

			expect(mockExecuteWriteRetro).toHaveBeenCalledWith(
				expect.objectContaining({
					lessons_learned: ['Always test your code', 'Read before edit'],
				}),
				'/test/dir',
			);
		});
	});

	describe('Error path', () => {
		it('should return error string when executeWriteRetro returns failure', async () => {
			const mockResult = JSON.stringify({
				success: false,
				phase: 4,
				message: 'Invalid phase: must be a positive integer',
			});
			mockExecuteWriteRetro.mockImplementation(async () => mockResult);

			const result = await handleWriteRetroCommand('/test/dir', [
				JSON.stringify({
					phase: 4,
					summary: 'Test phase',
					task_count: 1,
					task_complexity: 'simple',
					total_tool_calls: 10,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
				}),
			]);

			expect(result).toBe('Error: Invalid phase: must be a positive integer');
		});

		it('should return error when executeWriteRetro returns non-JSON string', async () => {
			mockExecuteWriteRetro.mockImplementation(
				async () => 'NOT VALID JSON {{{{' as any,
			);

			const result = await handleWriteRetroCommand('/test/dir', [
				JSON.stringify({
					phase: 1,
					summary: 'Test',
					task_count: 1,
					task_complexity: 'trivial',
					total_tool_calls: 5,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
				}),
			]);

			expect(result).toBe(
				'Error: Failed to parse result from write-retro tool.',
			);
		});
	});

	describe('Argument passthrough', () => {
		it('should call executeWriteRetro with correct parsedArgs', async () => {
			const mockResult = JSON.stringify({
				success: true,
				phase: 2,
				task_id: 'retro-2',
				message: 'Done',
			});
			mockExecuteWriteRetro.mockImplementation(async () => mockResult);

			const argsJson = JSON.stringify({
				phase: 2,
				summary: 'Completed phase 2',
				task_count: 5,
				task_complexity: 'moderate',
				total_tool_calls: 75,
				coder_revisions: 2,
				reviewer_rejections: 1,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
			});

			await handleWriteRetroCommand('/test/dir', [argsJson]);

			expect(mockExecuteWriteRetro).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: 2,
					summary: 'Completed phase 2',
					task_count: 5,
					task_complexity: 'moderate',
					total_tool_calls: 75,
					coder_revisions: 2,
					reviewer_rejections: 1,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
				}),
				'/test/dir',
			);
		});

		it('should call executeWriteRetro with the correct directory', async () => {
			const mockResult = JSON.stringify({
				success: true,
				phase: 1,
				task_id: 'retro-1',
				message: 'Done',
			});
			mockExecuteWriteRetro.mockImplementation(async () => mockResult);

			await handleWriteRetroCommand('/my/custom/directory', [
				JSON.stringify({
					phase: 1,
					summary: 'Test',
					task_count: 1,
					task_complexity: 'simple',
					total_tool_calls: 1,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
				}),
			]);

			expect(mockExecuteWriteRetro).toHaveBeenCalledWith(
				expect.any(Object),
				'/my/custom/directory',
			);
		});

		it('should pass through optional task_id to executeWriteRetro', async () => {
			const mockResult = JSON.stringify({
				success: true,
				phase: 1,
				task_id: 'custom-retro-1',
				message: 'Done',
			});
			mockExecuteWriteRetro.mockImplementation(async () => mockResult);

			await handleWriteRetroCommand('/test/dir', [
				JSON.stringify({
					phase: 1,
					summary: 'Test',
					task_count: 1,
					task_complexity: 'trivial',
					total_tool_calls: 1,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_id: 'custom-retro-1',
				}),
			]);

			expect(mockExecuteWriteRetro).toHaveBeenCalledWith(
				expect.objectContaining({
					task_id: 'custom-retro-1',
				}),
				'/test/dir',
			);
		});

		it('should pass through optional metadata to executeWriteRetro', async () => {
			const mockResult = JSON.stringify({
				success: true,
				phase: 1,
				task_id: 'retro-1',
				message: 'Done',
			});
			mockExecuteWriteRetro.mockImplementation(async () => mockResult);

			await handleWriteRetroCommand('/test/dir', [
				JSON.stringify({
					phase: 1,
					summary: 'Test',
					task_count: 1,
					task_complexity: 'simple',
					total_tool_calls: 1,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					metadata: { author: 'test', version: '1.0.0' },
				}),
			]);

			expect(mockExecuteWriteRetro).toHaveBeenCalledWith(
				expect.objectContaining({
					metadata: { author: 'test', version: '1.0.0' },
				}),
				'/test/dir',
			);
		});

		it('should pass through optional top_rejection_reasons to executeWriteRetro', async () => {
			const mockResult = JSON.stringify({
				success: true,
				phase: 1,
				task_id: 'retro-1',
				message: 'Done',
			});
			mockExecuteWriteRetro.mockImplementation(async () => mockResult);

			await handleWriteRetroCommand('/test/dir', [
				JSON.stringify({
					phase: 1,
					summary: 'Test',
					task_count: 1,
					task_complexity: 'moderate',
					total_tool_calls: 1,
					coder_revisions: 0,
					reviewer_rejections: 3,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					top_rejection_reasons: ['Code style issues', 'Missing tests'],
				}),
			]);

			expect(mockExecuteWriteRetro).toHaveBeenCalledWith(
				expect.objectContaining({
					top_rejection_reasons: ['Code style issues', 'Missing tests'],
				}),
				'/test/dir',
			);
		});
	});
});
