/**
 * Verification tests for architect whitelist addition of check_gate_status
 * Tests that AGENT_TOOL_MAP.architect includes check_gate_status and other roles are unchanged
 */
import { describe, expect, it } from 'bun:test';
import type { ToolName } from '../tools/tool-names';
import { TOOL_NAME_SET } from '../tools/tool-names';
import { AGENT_TOOL_MAP } from './constants';

describe('AGENT_TOOL_MAP.architect whitelist verification', () => {
	describe('check_gate_status in architect whitelist', () => {
		it('architect should have check_gate_status in tool list', () => {
			const architectTools = AGENT_TOOL_MAP.architect;
			expect(architectTools).toContain('check_gate_status');
		});

		it('check_gate_status should be a valid ToolName', () => {
			const architectTools = AGENT_TOOL_MAP.architect;
			const hasValidToolName = architectTools.some(
				(t): t is ToolName => t === 'check_gate_status',
			);
			expect(hasValidToolName).toBe(true);
		});

		it('architect should have a reasonable number of tools (> 40)', () => {
			const architectTools = AGENT_TOOL_MAP.architect;
			expect(architectTools.length).toBeGreaterThan(40);
		});
	});

	describe('other role mappings have tools', () => {
		it('explorer should have tools', () => {
			expect(AGENT_TOOL_MAP.explorer.length).toBeGreaterThan(0);
		});

		it('coder should have tools', () => {
			expect(AGENT_TOOL_MAP.coder.length).toBeGreaterThan(0);
		});

		it('test_engineer should have tools', () => {
			expect(AGENT_TOOL_MAP.test_engineer.length).toBeGreaterThan(0);
		});

		it('sme should have tools', () => {
			expect(AGENT_TOOL_MAP.sme.length).toBeGreaterThan(0);
		});

		it('reviewer should have tools', () => {
			expect(AGENT_TOOL_MAP.reviewer.length).toBeGreaterThan(0);
		});

		it('critic should have tools', () => {
			expect(AGENT_TOOL_MAP.critic.length).toBeGreaterThan(0);
		});

		it('docs should have tools', () => {
			expect(AGENT_TOOL_MAP.docs.length).toBeGreaterThan(0);
		});

		it('designer should have tools', () => {
			expect(AGENT_TOOL_MAP.designer.length).toBeGreaterThan(0);
		});

		it('other roles should NOT contain check_gate_status', () => {
			const otherRoles = [
				'explorer',
				'coder',
				'test_engineer',
				'sme',
				'reviewer',
				'critic',
				'docs',
				'designer',
			] as const;
			for (const role of otherRoles) {
				expect(AGENT_TOOL_MAP[role]).not.toContain('check_gate_status');
			}
		});
	});

	describe('architect has valid tools (subset verification)', () => {
		it('architect tools should all be valid ToolNames', () => {
			const architectTools = AGENT_TOOL_MAP.architect;
			const invalidTools = architectTools.filter(
				(tool) => !TOOL_NAME_SET.has(tool as ToolName),
			);
			expect(invalidTools).toHaveLength(0);
		});

		it('architect tools should be a subset of TOOL_NAMES', () => {
			const architectTools = AGENT_TOOL_MAP.architect;
			for (const tool of architectTools) {
				expect(TOOL_NAME_SET.has(tool as ToolName)).toBe(true);
			}
		});
	});

	describe('runtime validation passes (no invalid tools)', () => {
		it('AGENT_TOOL_MAP should have all required agent roles', () => {
			const requiredRoles = [
				'explorer',
				'coder',
				'test_engineer',
				'sme',
				'reviewer',
				'critic',
				'docs',
				'designer',
				'architect',
			];
			const actualRoles = Object.keys(AGENT_TOOL_MAP);
			requiredRoles.forEach((role) => {
				expect(actualRoles).toContain(role);
			});
		});

		it('each role should have at least one tool (except synthesis-only roles)', () => {
			const synthesisOnlyRoles = new Set([
				'council_generalist',
				'council_skeptic',
				'council_domain_expert',
			]);
			Object.entries(AGENT_TOOL_MAP).forEach(([role, tools]) => {
				if (synthesisOnlyRoles.has(role)) {
					// Synthesis-only roles may have no tools (they aggregate/write from existing data)
					return;
				}
				expect(
					tools.length,
					`${role} should have at least one tool`,
				).toBeGreaterThan(0);
			});
		});

		it('all tools in AGENT_TOOL_MAP should be valid ToolNames', () => {
			for (const [agentName, tools] of Object.entries(AGENT_TOOL_MAP)) {
				const invalidTools = tools.filter(
					(tool) => !TOOL_NAME_SET.has(tool as ToolName),
				);
				expect(
					invalidTools,
					`${agentName} has invalid tools: ${invalidTools.join(', ')}`,
				).toHaveLength(0);
			}
		});
	});
});
