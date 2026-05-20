/**
 * Adversarial security and boundary tests for architect whitelist addition of check_gate_status.
 * Tests: duplicate entries, wrong-role exposure, invalid tool-name drift, accidental mutation of other roles.
 */

import { describe, expect, it } from 'bun:test';
import { AGENT_TOOL_MAP, ALL_AGENT_NAMES } from '../../src/config/constants';
import {
	TOOL_NAME_SET,
	TOOL_NAMES,
	type ToolName,
} from '../../src/tools/tool-names';

describe('ADVERSARIAL: Architect whitelist check_gate_status', () => {
	describe('DUPLICATE ENTRIES: check_gate_status should appear exactly once in architect', () => {
		it('should have check_gate_status exactly once in architect tools', () => {
			const architectTools = AGENT_TOOL_MAP['architect'];
			const checkGateStatusCount = architectTools.filter(
				(t) => t === 'check_gate_status',
			).length;
			expect(checkGateStatusCount).toBe(1);
		});

		it('should have no duplicates in architect tool list', () => {
			const architectTools = AGENT_TOOL_MAP['architect'];
			const uniqueTools = new Set(architectTools);
			expect(architectTools.length).toBe(uniqueTools.size);
		});
	});

	describe('WRONG-ROLE EXPOSURE: check_gate_status should NOT leak to other roles', () => {
		const nonArchitectRoles = ALL_AGENT_NAMES.filter(
			(agent) => agent !== 'architect' && agent !== 'critic_oversight',
		);

		it.each(
			nonArchitectRoles,
		)('should NOT expose check_gate_status to $role role', (role) => {
			const roleTools = AGENT_TOOL_MAP[role as keyof typeof AGENT_TOOL_MAP];
			expect(roleTools).not.toContain('check_gate_status');
		});

		it('should only have check_gate_status in architect role', () => {
			const rolesWithCheckGateStatus = (
				Object.keys(AGENT_TOOL_MAP) as Array<keyof typeof AGENT_TOOL_MAP>
			).filter((role) =>
				AGENT_TOOL_MAP[role]?.includes('check_gate_status' as ToolName),
			);
			expect(rolesWithCheckGateStatus).toEqual([
				'architect',
				'critic_oversight',
			]);
		});
	});

	describe('INVALID TOOL-NAME DRIFT: check_gate_status must be valid registered tool', () => {
		it('should have check_gate_status in TOOL_NAME_SET', () => {
			expect(TOOL_NAME_SET.has('check_gate_status')).toBe(true);
		});

		it('should have check_gate_status in TOOL_NAMES array', () => {
			expect(TOOL_NAMES).toContain('check_gate_status');
		});

		it('architect tools should all be registered in TOOL_NAME_SET', () => {
			const architectTools = AGENT_TOOL_MAP['architect'];
			const invalidTools = architectTools.filter(
				(tool) => !TOOL_NAME_SET.has(tool as ToolName),
			);
			expect(invalidTools).toEqual([]);
		});

		it('should not have typosquatting variations of check_gate_status', () => {
			const architectTools = AGENT_TOOL_MAP['architect'];
			const suspiciousTools = architectTools.filter(
				(t) => t.includes('check_gate') && t !== 'check_gate_status',
			);
			expect(suspiciousTools).toEqual([]);
		});
	});

	describe('ACCIDENTAL MUTATION: other role tool lists must remain unchanged', () => {
		it('explorer should retain expected 15 tools', () => {
			const expected = [
				'complexity_hotspots',
				'detect_domains',
				'extract_code_blocks',
				'gitingest',
				'imports',
				'retrieve_summary',
				'schema_drift',
				'search',
				'batch_symbols',
				'symbols',
				'todo_extract',
				'doc_scan',
				'knowledge_recall',
				'repo_map',
				'swarm_command',
			];
			expect(AGENT_TOOL_MAP['explorer']).toEqual(expected);
		});

		it('coder should retain expected 13 tools', () => {
			const expected = [
				'diff',
				'imports',
				'lint',
				'symbols',
				'extract_code_blocks',
				'retrieve_summary',
				'search',
				'build_check',
				'syntax_check',
				'knowledge_add',
				'knowledge_recall',
				'repo_map',
				'swarm_command',
			];
			expect(AGENT_TOOL_MAP['coder']).toEqual(expected);
		});

		it('test_engineer should retain expected 14 tools', () => {
			const expected = [
				'test_runner',
				'test_impact',
				'mutation_test',
				'diff',
				'symbols',
				'extract_code_blocks',
				'retrieve_summary',
				'imports',
				'complexity_hotspots',
				'pkg_audit',
				'build_check',
				'syntax_check',
				'search',
				'swarm_command',
			];
			expect(AGENT_TOOL_MAP['test_engineer']).toEqual(expected);
		});

		it('reviewer should retain expected 21 tools', () => {
			const expected = [
				'diff',
				'diff_summary',
				'imports',
				'lint',
				'pkg_audit',
				'pre_check_batch',
				'secretscan',
				'symbols',
				'complexity_hotspots',
				'retrieve_summary',
				'extract_code_blocks',
				'test_runner',
				'test_impact',
				'sast_scan',
				'placeholder_scan',
				'knowledge_recall',
				'search',
				'batch_symbols',
				'suggest_patch',
				'repo_map',
				'swarm_command',
			];
			expect(AGENT_TOOL_MAP['reviewer']).toEqual(expected);
		});

		it('sme should retain expected 10 tools', () => {
			const expected = [
				'complexity_hotspots',
				'detect_domains',
				'extract_code_blocks',
				'imports',
				'retrieve_summary',
				'schema_drift',
				'search',
				'symbols',
				'knowledge_recall',
				'swarm_command',
			];
			expect(AGENT_TOOL_MAP['sme']).toEqual(expected);
		});

		it('critic should retain expected 10 tools', () => {
			const expected = [
				'complexity_hotspots',
				'detect_domains',
				'imports',
				'retrieve_summary',
				'symbols',
				'knowledge_recall',
				'req_coverage',
				'get_approved_plan',
				'repo_map',
				'swarm_command',
			];
			expect(AGENT_TOOL_MAP['critic']).toEqual(expected);
		});

		it('docs should retain expected 11 tools', () => {
			const expected = [
				'detect_domains',
				'extract_code_blocks',
				'gitingest',
				'imports',
				'retrieve_summary',
				'schema_drift',
				'search',
				'symbols',
				'todo_extract',
				'knowledge_recall',
				'swarm_command',
			];
			expect(AGENT_TOOL_MAP['docs']).toEqual(expected);
		});

		it('designer should retain expected 6 tools', () => {
			const expected = [
				'extract_code_blocks',
				'retrieve_summary',
				'search',
				'symbols',
				'knowledge_recall',
				'swarm_command',
			];
			expect(AGENT_TOOL_MAP['designer']).toEqual(expected);
		});
	});

	describe('BOUNDARY: architect tool count and composition', () => {
		it('architect should have 71 tools', () => {
			expect(AGENT_TOOL_MAP['architect'].length).toBe(71);
		});

		it('architect should include all orchestrator-specific tools', () => {
			const architectTools = AGENT_TOOL_MAP['architect'];
			// Tools that should ONLY be in architect (orchestrator controls)
			// Note: phase_complete is NOT in AGENT_TOOL_MAP - it's a special case
			const orchestratorOnlyTools = [
				'check_gate_status',
				'save_plan',
				'update_task_status',
				'write_retro',
				'declare_scope',
				'evidence_check',
			];
			orchestratorOnlyTools.forEach((tool) => {
				expect(architectTools).toContain(tool);
			});
		});
	});

	describe('IMMUTABILITY: AGENT_TOOL_MAP structure should be stable', () => {
		it('AGENT_TOOL_MAP should be a plain object', () => {
			expect(typeof AGENT_TOOL_MAP).toBe('object');
			expect(Array.isArray(AGENT_TOOL_MAP)).toBe(false);
		});

		it('architect array should not have unexpected length changes', () => {
			const originalLength = AGENT_TOOL_MAP['architect'].length;
			// Verify current state matches expected
			expect(originalLength).toBe(71);
		});
	});
});
