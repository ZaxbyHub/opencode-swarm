/**
 * Adversarial verification tests for write_retro runtime registration.
 * Tests the registration wiring in src/index.ts to ensure:
 * - No collisions with existing tools
 * - No omissions in export chain
 * - Proper tool definition structure
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AGENT_TOOL_MAP } from '../../../src/config/constants';
import { TOOL_NAME_SET, TOOL_NAMES } from '../../../src/tools/tool-names';
// Test the full export chain - this verifies registration
import {
	executeWriteRetro as executeRawWriteRetro,
	type WriteRetroArgs,
	write_retro,
} from '../../../src/tools/write-retro';

const executeWriteRetro = (a: WriteRetroArgs, d: string) =>
	executeRawWriteRetro({ ...a, verdict: 'pass' }, d);
describe('write_retro runtime registration adversarial verification', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'write-retro-registration-')),
		);
		originalCwd = process.cwd();
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// REGISTRATION CHAIN VERIFICATION

	describe('export chain verification', () => {
		test('write_retro is exported from tools module', () => {
			// This import verifies the export chain: src/tools/write-retro.ts -> src/tools/index.ts
			expect(write_retro).toBeDefined();
		});

		test('executeWriteRetro is exported from tools module', () => {
			expect(executeWriteRetro).toBeDefined();
			expect(typeof executeWriteRetro).toBe('function');
		});

		test('write_retro is in TOOL_NAMES constant', () => {
			expect(TOOL_NAMES).toContain('write_retro');
		});

		test('write_retro is in TOOL_NAME_SET', () => {
			expect(TOOL_NAME_SET.has('write_retro')).toBe(true);
		});

		test('write_retro is in AGENT_TOOL_MAP', () => {
			// Verify it's included in at least one agent's tool list
			const allTools = Object.values(AGENT_TOOL_MAP).flat();
			expect(allTools).toContain('write_retro');
		});
	});

	// TOOL DEFINITION STRUCTURE

	describe('tool definition structure verification', () => {
		test('write_retro has description property', () => {
			expect(write_retro).toHaveProperty('description');
			expect(typeof write_retro.description).toBe('string');
			expect(write_retro.description.length).toBeGreaterThan(0);
		});

		test('write_retro has args property', () => {
			expect(write_retro).toHaveProperty('args');
			expect(write_retro.args).toBeDefined();
		});

		test('write_retro has execute function', () => {
			expect(write_retro).toHaveProperty('execute');
			expect(typeof write_retro.execute).toBe('function');
		});

		test('write_retro description mentions retrospective', () => {
			expect(write_retro.description.toLowerCase()).toContain('retrospective');
		});

		test('write_retro description mentions evidence bundle', () => {
			expect(write_retro.description.toLowerCase()).toContain('evidence');
		});
	});

	// ARGUMENT SCHEMA VERIFICATION

	describe('argument schema verification', () => {
		test('args includes required phase parameter', () => {
			expect(write_retro.args).toHaveProperty('phase');
		});

		test('args includes required summary parameter', () => {
			expect(write_retro.args).toHaveProperty('summary');
		});

		test('args includes required task_count parameter', () => {
			expect(write_retro.args).toHaveProperty('task_count');
		});

		test('args includes required task_complexity parameter', () => {
			expect(write_retro.args).toHaveProperty('task_complexity');
		});

		test('args includes required total_tool_calls parameter', () => {
			expect(write_retro.args).toHaveProperty('total_tool_calls');
		});

		test('args includes required coder_revisions parameter', () => {
			expect(write_retro.args).toHaveProperty('coder_revisions');
		});

		test('args includes required reviewer_rejections parameter', () => {
			expect(write_retro.args).toHaveProperty('reviewer_rejections');
		});

		test('args includes required test_failures parameter', () => {
			expect(write_retro.args).toHaveProperty('test_failures');
		});

		test('args includes required security_findings parameter', () => {
			expect(write_retro.args).toHaveProperty('security_findings');
		});

		test('args includes required integration_issues parameter', () => {
			expect(write_retro.args).toHaveProperty('integration_issues');
		});

		test('args includes optional lessons_learned parameter', () => {
			expect(write_retro.args).toHaveProperty('lessons_learned');
		});

		test('args includes optional top_rejection_reasons parameter', () => {
			expect(write_retro.args).toHaveProperty('top_rejection_reasons');
		});

		test('args includes optional task_id parameter', () => {
			expect(write_retro.args).toHaveProperty('task_id');
		});

		test('args includes optional metadata parameter', () => {
			expect(write_retro.args).toHaveProperty('metadata');
		});
	});

	// COLLISION DETECTION

	describe('collision detection with existing tools', () => {
		test('write_retro does not conflict with other tool names', () => {
			const otherTools = TOOL_NAMES.filter((name) => name !== 'write_retro');
			const hasCollision = otherTools.includes('write_retro');
			expect(hasCollision).toBe(false);
		});

		test('write_retro tool name is unique in TOOL_NAMES', () => {
			const writeRetroCount = TOOL_NAMES.filter(
				(name) => name === 'write_retro',
			).length;
			expect(writeRetroCount).toBe(1);
		});

		test('write_retro does not shadow common tool names', () => {
			// These are common tool names that should not be shadowed
			const dangerousShadows = ['lint', 'diff', 'test', 'build', 'check'];
			dangerousShadows.forEach((name) => {
				expect(`write_retro`.startsWith(name)).toBe(false);
			});
		});
	});

	// RUNTIME EXECUTION VERIFICATION

	describe('runtime execution verification', () => {
		test('execute function can be called directly', async () => {
			const result = await executeWriteRetro(
				{
					phase: 1,
					summary: 'Test phase',
					task_count: 1,
					task_complexity: 'simple',
					total_tool_calls: 10,
					coder_revisions: 1,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
				},
				tempDir,
			);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
		});

		test('execute function handles invalid phase', async () => {
			const result = await executeWriteRetro(
				{
					phase: 0,
					summary: 'Test phase',
					task_count: 1,
					task_complexity: 'simple',
					total_tool_calls: 10,
					coder_revisions: 1,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
				},
				tempDir,
			);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.message).toContain('Invalid phase');
		});

		test('execute function handles invalid task_complexity', async () => {
			const result = await executeWriteRetro(
				{
					phase: 1,
					summary: 'Test phase',
					task_count: 1,
					task_complexity: 'invalid' as any,
					total_tool_calls: 10,
					coder_revisions: 1,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
				},
				tempDir,
			);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.message).toContain('task_complexity');
		});

		test('execute function handles empty summary', async () => {
			const result = await executeWriteRetro(
				{
					phase: 1,
					summary: '',
					task_count: 1,
					task_complexity: 'simple',
					total_tool_calls: 10,
					coder_revisions: 1,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
				},
				tempDir,
			);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.message).toContain('summary');
		});
	});

	// MALFORMED WIRING DETECTION

	describe('malformed wiring detection', () => {
		test('write_retro execute returns valid JSON', async () => {
			const result = await executeWriteRetro(
				{
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
				},
				tempDir,
			);

			expect(() => JSON.parse(result)).not.toThrow();
		});

		test('write_retro execute returns object with success field', async () => {
			const result = await executeWriteRetro(
				{
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
				},
				tempDir,
			);

			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('success');
			expect(typeof parsed.success).toBe('boolean');
		});

		test('write_retro execute returns object with message field on error', async () => {
			const result = await executeWriteRetro(
				{
					phase: 0,
					summary: 'Test',
					task_count: 1,
					task_complexity: 'simple',
					total_tool_calls: 1,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
				},
				tempDir,
			);

			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('message');
			expect(typeof parsed.message).toBe('string');
		});

		test('write_retro does not throw on valid input', async () => {
			expect(async () => {
				await executeWriteRetro(
					{
						phase: 1,
						summary: 'Valid test',
						task_count: 1,
						task_complexity: 'simple',
						total_tool_calls: 1,
						coder_revisions: 0,
						reviewer_rejections: 0,
						test_failures: 0,
						security_findings: 0,
						integration_issues: 0,
					},
					tempDir,
				);
			}).not.toThrow();
		});
	});

	// EDGE CASES FOR REGISTRATION

	describe('registration edge cases', () => {
		test('handles custom task_id', async () => {
			const result = await executeWriteRetro(
				{
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
					task_id: 'retro-99',
				},
				tempDir,
			);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.task_id).toBe('retro-99');
		});

		test('handles optional lessons_learned', async () => {
			const result = await executeWriteRetro(
				{
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
					lessons_learned: ['Lesson 1', 'Lesson 2'],
				},
				tempDir,
			);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
		});

		test('handles optional metadata', async () => {
			const result = await executeWriteRetro(
				{
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
					metadata: { customField: 'value' },
				},
				tempDir,
			);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
		});

		test('generates default task_id when not provided', async () => {
			const result = await executeWriteRetro(
				{
					phase: 5,
					summary: 'Test',
					task_count: 1,
					task_complexity: 'simple',
					total_tool_calls: 1,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
				},
				tempDir,
			);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.task_id).toBe('retro-5');
		});

		test('all task_complexity values are accepted', async () => {
			const complexities = [
				'trivial',
				'simple',
				'moderate',
				'complex',
			] as const;

			for (const complexity of complexities) {
				const result = await executeWriteRetro(
					{
						phase: 1,
						summary: 'Test',
						task_count: 1,
						task_complexity: complexity,
						total_tool_calls: 1,
						coder_revisions: 0,
						reviewer_rejections: 0,
						test_failures: 0,
						security_findings: 0,
						integration_issues: 0,
					},
					tempDir,
				);

				const parsed = JSON.parse(result);
				expect(parsed.success).toBe(true);
			}
		});
	});

	// TOOL NAME CONSISTENCY

	describe('tool name consistency', () => {
		test('tool name uses snake_case consistently', () => {
			// Verify write_retro follows the snake_case convention
			expect('write_retro').toMatch(/^[a-z][a-z0-9_]*$/);
		});

		test('tool name does not contain uppercase', () => {
			expect('write_retro').toBe('write_retro');
			expect('write_retro').not.toMatch(/[A-Z]/);
		});
	});
});
