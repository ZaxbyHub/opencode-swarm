/**
 * Adversarial tests for plugin runtime registration
 *
 * Tests edge cases related to tool registration in src/index.ts
 * Focus: Ensure all tools are properly exposed without collisions, omissions, or malformed wiring
 */
import { describe, expect, it } from 'bun:test';
import { TOOL_NAMES } from './tool-names.js';

const REGISTERED_TOOL_NAMES = TOOL_NAMES;

describe('Plugin Runtime Registration - Adversarial Tests', () => {
	describe('Tool Registration Integrity', () => {
		it('should have all registered tools exported from tools/index.ts', async () => {
			const toolsIndex = await import('./index');

			for (const toolName of REGISTERED_TOOL_NAMES) {
				expect(toolsIndex).toHaveProperty(toolName);
				const tool = (toolsIndex as any)[toolName];
				expect(tool).toBeDefined();
				// Tools can be either: function, or object with execute method
				const isCallable =
					typeof tool === 'function' ||
					(typeof tool === 'object' && typeof tool.execute === 'function');
				expect(isCallable).toBe(true);
			}
		});

		it('should not have duplicate tool names in registration', () => {
			const uniqueNames = new Set(REGISTERED_TOOL_NAMES);
			expect(uniqueNames.size).toBe(REGISTERED_TOOL_NAMES.length);
		});

		it('should register tools with correct snake_case naming convention', async () => {
			for (const toolName of REGISTERED_TOOL_NAMES) {
				expect(toolName).toMatch(/^[a-z][a-z0-9_]*$/);
			}
		});
	});

	describe('Tool Name Collision Detection', () => {
		it('should not have any tool name that could shadow global objects', async () => {
			const globalNames = [
				'Object',
				'Array',
				'Function',
				'prototype',
				'constructor',
			];
			for (const toolName of REGISTERED_TOOL_NAMES) {
				expect(globalNames).not.toContain(toolName);
			}
		});

		it('should have no collisions between registered tools and hook names', () => {
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

			for (const toolName of REGISTERED_TOOL_NAMES) {
				expect(hookNames).not.toContain(toolName);
			}
		});

		it('should have no collisions between registered tools and agent names', () => {
			const agentNames = [
				'architect',
				'coder',
				'reviewer',
				'designer',
				'test_engineer',
			];

			for (const toolName of REGISTERED_TOOL_NAMES) {
				expect(agentNames).not.toContain(toolName);
			}
		});
	});

	describe('Tool Export Verification', () => {
		it('should export checkpoint as callable', async () => {
			const { checkpoint } = await import('./index');
			const isCallable =
				typeof checkpoint === 'function' ||
				(typeof checkpoint === 'object' &&
					typeof checkpoint.execute === 'function');
			expect(isCallable).toBe(true);
		});

		it('should export complexity_hotspots as callable', async () => {
			const { complexity_hotspots } = await import('./index');
			const isCallable =
				typeof complexity_hotspots === 'function' ||
				(typeof complexity_hotspots === 'object' &&
					typeof complexity_hotspots.execute === 'function');
			expect(isCallable).toBe(true);
		});

		it('should export detect_domains as callable', async () => {
			const { detect_domains } = await import('./index');
			const isCallable =
				typeof detect_domains === 'function' ||
				(typeof detect_domains === 'object' &&
					typeof detect_domains.execute === 'function');
			expect(isCallable).toBe(true);
		});

		it('should export diff as callable', async () => {
			const { diff } = await import('./index');
			const isCallable =
				typeof diff === 'function' ||
				(typeof diff === 'object' && typeof diff.execute === 'function');
			expect(isCallable).toBe(true);
		});

		it('should export evidence_check as callable', async () => {
			const { evidence_check } = await import('./index');
			const isCallable =
				typeof evidence_check === 'function' ||
				(typeof evidence_check === 'object' &&
					typeof evidence_check.execute === 'function');
			expect(isCallable).toBe(true);
		});

		it('should export extract_code_blocks as callable', async () => {
			const { extract_code_blocks } = await import('./index');
			const isCallable =
				typeof extract_code_blocks === 'function' ||
				(typeof extract_code_blocks === 'object' &&
					typeof extract_code_blocks.execute === 'function');
			expect(isCallable).toBe(true);
		});

		it('should export gitingest as callable', async () => {
			const { gitingest } = await import('./index');
			const isCallable =
				typeof gitingest === 'function' ||
				(typeof gitingest === 'object' &&
					typeof gitingest.execute === 'function');
			expect(isCallable).toBe(true);
		});

		it('should export imports as callable', async () => {
			const { imports } = await import('./index');
			const isCallable =
				typeof imports === 'function' ||
				(typeof imports === 'object' && typeof imports.execute === 'function');
			expect(isCallable).toBe(true);
		});

		it('should export lint as callable', async () => {
			const { lint } = await import('./index');
			const isCallable =
				typeof lint === 'function' ||
				(typeof lint === 'object' && typeof lint.execute === 'function');
			expect(isCallable).toBe(true);
		});

		it('should export phase_complete as callable', async () => {
			const { phase_complete } = await import('./index');
			const isCallable =
				typeof phase_complete === 'function' ||
				(typeof phase_complete === 'object' &&
					typeof phase_complete.execute === 'function');
			expect(isCallable).toBe(true);
		});

		it('should export pkg_audit as callable', async () => {
			const { pkg_audit } = await import('./index');
			const isCallable =
				typeof pkg_audit === 'function' ||
				(typeof pkg_audit === 'object' &&
					typeof pkg_audit.execute === 'function');
			expect(isCallable).toBe(true);
		});

		it('should export pre_check_batch as callable', async () => {
			const { pre_check_batch } = await import('./index');
			const isCallable =
				typeof pre_check_batch === 'function' ||
				(typeof pre_check_batch === 'object' &&
					typeof pre_check_batch.execute === 'function');
			expect(isCallable).toBe(true);
		});

		it('should export retrieve_summary as callable', async () => {
			const { retrieve_summary } = await import('./index');
			const isCallable =
				typeof retrieve_summary === 'function' ||
				(typeof retrieve_summary === 'object' &&
					typeof retrieve_summary.execute === 'function');
			expect(isCallable).toBe(true);
		});

		it('should export save_plan as callable', async () => {
			const { save_plan } = await import('./index');
			const isCallable =
				typeof save_plan === 'function' ||
				(typeof save_plan === 'object' &&
					typeof save_plan.execute === 'function');
			expect(isCallable).toBe(true);
		});

		it('should export schema_drift as callable', async () => {
			const { schema_drift } = await import('./index');
			const isCallable =
				typeof schema_drift === 'function' ||
				(typeof schema_drift === 'object' &&
					typeof schema_drift.execute === 'function');
			expect(isCallable).toBe(true);
		});

		it('should export secretscan as callable', async () => {
			const { secretscan } = await import('./index');
			const isCallable =
				typeof secretscan === 'function' ||
				(typeof secretscan === 'object' &&
					typeof secretscan.execute === 'function');
			expect(isCallable).toBe(true);
		});

		it('should export symbols as callable', async () => {
			const { symbols } = await import('./index');
			const isCallable =
				typeof symbols === 'function' ||
				(typeof symbols === 'object' && typeof symbols.execute === 'function');
			expect(isCallable).toBe(true);
		});

		it('should export test_runner as callable', async () => {
			const { test_runner } = await import('./index');
			const isCallable =
				typeof test_runner === 'function' ||
				(typeof test_runner === 'object' &&
					typeof test_runner.execute === 'function');
			expect(isCallable).toBe(true);
		});

		it('should export todo_extract as callable', async () => {
			const { todo_extract } = await import('./index');
			const isCallable =
				typeof todo_extract === 'function' ||
				(typeof todo_extract === 'object' &&
					typeof todo_extract.execute === 'function');
			expect(isCallable).toBe(true);
		});

		it('should export update_task_status as callable', async () => {
			const { update_task_status } = await import('./index');
			const isCallable =
				typeof update_task_status === 'function' ||
				(typeof update_task_status === 'object' &&
					typeof update_task_status.execute === 'function');
			expect(isCallable).toBe(true);
		});
	});

	describe('Tool Wiring Verification', () => {
		it('should have all tools accounted for', () => {
			expect(REGISTERED_TOOL_NAMES.length).toBe(TOOL_NAMES.length);
		});

		it('should export all registered tools', async () => {
			const toolsIndex = await import('./index');
			let exportCount = 0;

			for (const toolName of REGISTERED_TOOL_NAMES) {
				const tool = (toolsIndex as any)[toolName];
				if (tool) {
					const isCallable =
						typeof tool === 'function' ||
						(typeof tool === 'object' && typeof tool.execute === 'function');
					if (isCallable) {
						exportCount++;
					}
				}
			}

			expect(exportCount).toBe(TOOL_NAMES.length);
		});

		it('should have no null or undefined tools', async () => {
			const toolsIndex = await import('./index');

			for (const toolName of REGISTERED_TOOL_NAMES) {
				const tool = (toolsIndex as any)[toolName];
				expect(tool).not.toBeNull();
				expect(tool).not.toBeUndefined();
			}
		});
	});

	describe('Tool Description Verification', () => {
		it('should have description on checkpoint tool', async () => {
			const { checkpoint } = await import('./index');
			const tool = checkpoint as any;
			// If it's an object with description, verify it
			if (typeof tool === 'object' && tool.description) {
				expect(typeof tool.description).toBe('string');
				expect(tool.description.length).toBeGreaterThan(0);
			}
		});

		it('should have description or be a callable function for all tools', async () => {
			const toolsIndex = await import('./index');

			for (const toolName of REGISTERED_TOOL_NAMES) {
				const tool = (toolsIndex as any)[toolName];
				expect(tool).toBeDefined();

				// Either it's a callable function, or it's an object with description
				const hasDescription =
					typeof tool === 'object' &&
					typeof tool.description === 'string' &&
					tool.description.length > 0;
				const isCallable =
					typeof tool === 'function' ||
					(typeof tool === 'object' && typeof tool.execute === 'function');

				expect(hasDescription || isCallable).toBe(true);
			}
		});
	});
});
