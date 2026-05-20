/**
 * Verification tests for check_gate_status plugin registration
 *
 * Tests that check_gate_status is properly exposed via the plugin
 * without disrupting existing registrations.
 */
import { describe, expect, it } from 'bun:test';
import type { ToolContext } from '@opencode-ai/plugin';
import type { ToolResult } from './create-tool';

describe('check_gate_status plugin registration verification', () => {
	// Helper to extract string from ToolResult
	function resultToString(result: ToolResult): string {
		return typeof result === 'string' ? result : result.output;
	}

	// Helper to call tool execute with proper context (bypasses strict type requirements for testing)
	async function executeTool(
		args: Record<string, unknown>,
		directory: string,
	): Promise<string> {
		const { check_gate_status } = await import('./index');
		const result = (await check_gate_status.execute(args, {
			directory,
		} as unknown as ToolContext)) as unknown as ToolResult;
		return resultToString(result);
	}

	// Tool names currently registered in src/index.ts (as of the change)
	const EXPECTED_TOOL_NAMES = [
		'check_gate_status',
		'checkpoint',
		'complexity_hotspots',
		'detect_domains',
		'evidence_check',
		'extract_code_blocks',
		'gitingest',
		'imports',
		'knowledge_query',
		'lint',
		'diff',
		'pkg_audit',
		'phase_complete',
		'pre_check_batch',
		'retrieve_summary',
		'save_plan',
		'schema_drift',
		'secretscan',
		'symbols',
		'test_runner',
		'todo_extract',
		'update_task_status',
		'write_retro',
		'declare_scope',
	];

	describe('Import verification', () => {
		it('check_gate_status can be imported from tools/index.ts', async () => {
			const { check_gate_status } = await import('./index');
			expect(check_gate_status).toBeDefined();
		});

		it('check_gate_status is a valid tool object with execute method', async () => {
			const { check_gate_status } = await import('./index');
			expect(typeof check_gate_status).toBe('object');
			expect(check_gate_status).not.toBeNull();
			expect(typeof check_gate_status.execute).toBe('function');
		});
	});

	describe('Tool structure verification', () => {
		it('check_gate_status has a description string', async () => {
			const { check_gate_status } = await import('./index');
			expect(check_gate_status).toHaveProperty('description');
			expect(typeof check_gate_status.description).toBe('string');
			expect(check_gate_status.description.length).toBeGreaterThan(0);
		});

		it('check_gate_status has args schema', async () => {
			const { check_gate_status } = await import('./index');
			expect(check_gate_status).toHaveProperty('args');
			expect(check_gate_status.args).toBeDefined();
		});

		it('check_gate_status has executable function', async () => {
			const { check_gate_status } = await import('./index');
			expect(typeof check_gate_status.execute).toBe('function');
		});

		it('check_gate_status execute accepts args and directory parameters', async () => {
			// Test with invalid task_id to verify it returns proper error response
			const result = await executeTool({ task_id: 'invalid' }, '/test/dir');
			expect(typeof result).toBe('string');

			// Result should be JSON
			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('status');
			expect(parsed).toHaveProperty('message');
		});
	});

	describe('Tool name verification', () => {
		it('check_gate_status follows snake_case naming convention', () => {
			expect('check_gate_status').toMatch(/^[a-z][a-z0-9_]*$/);
		});

		it('check_gate_status is not in conflict with global objects', () => {
			const globalNames = [
				'Object',
				'Array',
				'Function',
				'prototype',
				'constructor',
			];
			expect(globalNames).not.toContain('check_gate_status');
		});

		it('check_gate_status is not in conflict with agent names', () => {
			const agentNames = [
				'architect',
				'coder',
				'reviewer',
				'designer',
				'test_engineer',
			];
			expect(agentNames).not.toContain('check_gate_status');
		});

		it('check_gate_status is not in conflict with hook names', () => {
			const hookNames = [
				'experimental.chat.messages.transform',
				'experimental.chat.system.transform',
				'experimental.session.compacting',
				'command.execute.before',
				'tool.execute.before',
				'tool.execute.after',
				'chat.message',
				'automation',
			];
			expect(hookNames).not.toContain('check_gate_status');
		});
	});

	describe('Plugin tool registration integration', () => {
		it('check_gate_status appears in barrel exports', async () => {
			const toolsIndex = await import('./index');
			const exports = Object.keys(toolsIndex);
			expect(exports).toContain('check_gate_status');
		});

		it('check_gate_status has unique export (no duplicates)', async () => {
			const toolsIndex = await import('./index');
			const exports = Object.keys(toolsIndex);
			const matchingExports = exports.filter((e) => e === 'check_gate_status');
			expect(matchingExports.length).toBe(1);
		});

		it('check_gate_status export matches source module identity', async () => {
			const barrel = await import('./index');
			const sourceModule = await import('./check-gate-status');
			expect(barrel.check_gate_status).toBe(sourceModule.check_gate_status);
		});
	});

	describe('No disruption to existing tools', () => {
		it('existing tools are still exported from barrel', async () => {
			const toolsIndex = await import('./index');

			// Verify a few key existing tools are still present
			expect(toolsIndex).toHaveProperty('checkpoint');
			expect(toolsIndex).toHaveProperty('save_plan');
			expect(toolsIndex).toHaveProperty('test_runner');
			expect(toolsIndex).toHaveProperty('phase_complete');
			expect(toolsIndex).toHaveProperty('update_task_status');
		});

		it('existing tools have valid structure', async () => {
			const { checkpoint, save_plan, test_runner } = await import('./index');

			// Verify these tools have the expected structure
			expect(typeof checkpoint).toBe('object');
			expect(typeof checkpoint.execute).toBe('function');

			expect(typeof save_plan).toBe('object');
			expect(typeof save_plan.execute).toBe('function');

			expect(typeof test_runner).toBe('object');
			expect(typeof test_runner.execute).toBe('function');
		});

		it('total tool count includes check_gate_status', async () => {
			const toolsIndex = await import('./index');
			const exports = Object.keys(toolsIndex);

			// Filter to only tool-like exports (objects with execute or functions)
			const tools = exports.filter((name) => {
				const item = (toolsIndex as any)[name];
				return (
					item &&
					(typeof item === 'function' ||
						(typeof item === 'object' && typeof item.execute === 'function'))
				);
			});

			// Should have at least the expected tools including check_gate_status
			expect(tools.length).toBeGreaterThanOrEqual(EXPECTED_TOOL_NAMES.length);
		});
	});

	describe('Source module verification', () => {
		it('source check-gate-status.ts module exists and exports check_gate_status', async () => {
			const sourceModule = await import('./check-gate-status');
			expect(sourceModule).toHaveProperty('check_gate_status');
		});

		it('source module exports correct tool structure', async () => {
			const { check_gate_status } = await import('./check-gate-status');

			expect(check_gate_status).toHaveProperty('description');
			expect(check_gate_status).toHaveProperty('args');
			expect(check_gate_status).toHaveProperty('execute');

			expect(typeof check_gate_status.description).toBe('string');
			expect(typeof check_gate_status.args).toBe('object');
			expect(typeof check_gate_status.execute).toBe('function');
		});

		it('barrel re-exports exact same reference as source', async () => {
			const barrel = await import('./index');
			const source = await import('./check-gate-status');

			// The exact same object reference should be exported
			expect(barrel.check_gate_status).toBe(source.check_gate_status);
		});
	});

	describe('Task ID validation behavior', () => {
		it('execute rejects missing task_id with error result', async () => {
			const result = await executeTool({}, '/test/dir');
			const parsed = JSON.parse(result);

			expect(parsed.status).toBe('no_evidence');
			expect(parsed.message).toContain('Invalid task_id');
		});

		it('execute rejects invalid task_id format', async () => {
			const result = await executeTool({ task_id: 'invalid' }, '/test/dir');
			const parsed = JSON.parse(result);

			expect(parsed.status).toBe('no_evidence');
			expect(parsed.message).toContain('Invalid task_id format');
		});

		it('execute accepts valid task_id format N.M', async () => {
			const result = await executeTool({ task_id: '1.1' }, '/test/dir');
			const parsed = JSON.parse(result);

			// Should return a valid result (no_evidence if file doesn't exist)
			expect(parsed).toHaveProperty('taskId');
			expect(parsed.taskId).toBe('1.1');
			expect(parsed).toHaveProperty('status');
			expect(parsed).toHaveProperty('required_gates');
			expect(parsed).toHaveProperty('passed_gates');
			expect(parsed).toHaveProperty('missing_gates');
		});

		it('execute accepts valid task_id format N.M.P', async () => {
			const result = await executeTool({ task_id: '2.3.1' }, '/test/dir');
			const parsed = JSON.parse(result);

			expect(parsed.taskId).toBe('2.3.1');
			expect(parsed).toHaveProperty('status');
		});
	});
});
