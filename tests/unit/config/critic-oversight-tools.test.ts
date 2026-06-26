/**
 * critic_oversight tool-map invariants: must contain the read-only verification
 * tools required by the Full-Auto v2 oversight prompt, and must NOT contain
 * any write/edit/patch/plan-mutation tools.
 */
import { describe, expect, test } from 'bun:test';
import { AGENT_TOOL_MAP } from '../../../src/config/constants';

const REQUIRED_READONLY_TOOLS = [
	'diff',
	'diff_summary',
	'evidence_check',
	'check_gate_status',
	'completion_verify',
	'get_approved_plan',
	'req_coverage',
	'test_impact',
	'pkg_audit',
	'secretscan',
	'sast_scan',
	'repo_map',
	'retrieve_summary',
	'knowledge_recall',
	'symbols',
	'batch_symbols',
	'search',
	'imports',
	'complexity_hotspots',
] as const;

const FORBIDDEN_WRITE_TOOLS = [
	'write',
	'edit',
	'patch',
	'apply_patch',
	'swarm_apply_patch',
	'create_file',
	'insert',
	'replace',
	'append',
	'prepend',
	'save_plan',
	'update_task_status',
	'phase_complete',
	'write_retro',
	'write_drift_evidence',
	'write_hallucination_evidence',
	'write_mutation_evidence',
	'set_qa_gates',
	'submit_council_verdicts',
	'submit_phase_council_verdicts',
	'declare_council_criteria',
	'declare_scope',
	'knowledge_add',
	'knowledge_remove',
	'curator_analyze',
] as const;

describe('critic_oversight AGENT_TOOL_MAP', () => {
	const tools = AGENT_TOOL_MAP.critic_oversight;

	test('contains required read-only verification tools', () => {
		for (const t of REQUIRED_READONLY_TOOLS) {
			expect(tools).toContain(t);
		}
	});

	test('contains no write/edit/patch/plan-mutation tools', () => {
		for (const t of FORBIDDEN_WRITE_TOOLS) {
			expect(tools).not.toContain(t);
		}
	});

	test('respects the <=20 subagent tool ceiling', () => {
		expect(tools.length).toBeLessThanOrEqual(20);
	});

	test('is strictly smaller than architect tool list', () => {
		expect(tools.length).toBeLessThan(AGENT_TOOL_MAP.architect.length);
	});
});
