/**
 * check_gate_status surfaces the durable workflow lifecycle snapshot and the
 * coder_delegated wedge signature (Stage A never attributed) as structured
 * output fields — the read-side diagnostic for the post-reset
 * TASK_WORKFLOW_STAGE_A_REQUIRED wedge.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import { check_gate_status } from '../../../src/tools/check-gate-status';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let cleanup: () => void;
let directory: string;

beforeEach(() => {
	({ dir: directory, cleanup } = createSafeTestDir('cgs-workflow-hint'));
});

afterEach(() => {
	cleanup();
});

async function execute(taskId: string): Promise<Record<string, unknown>> {
	const raw = await check_gate_status.execute(
		{ task_id: taskId },
		// ToolContext: createSwarmTool resolves the evidence dir from here.
		{ directory },
	);
	return JSON.parse(raw) as Record<string, unknown>;
}

describe('check_gate_status workflow diagnostics', () => {
	test('wedged coder_delegated task exposes workflow state + attribution hint', async () => {
		await transitionTaskWorkflowEvidence(directory, '1.1', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'coder:setup',
		});

		const result = await execute('1.1');

		expect(result.workflow).toEqual({
			state: 'coder_delegated',
			generation: 1,
		});
		expect(typeof result.workflow_attribution_hint).toBe('string');
		expect(String(result.workflow_attribution_hint)).toContain(
			'TASK_WORKFLOW_STAGE_A_REQUIRED',
		);
		expect(String(result.workflow_attribution_hint)).toContain(
			'/swarm recover 1.1',
		);
		expect(String(result.message)).toContain('coder_delegated');
	});

	test('pre_check_passed task carries workflow state without the wedge hint', async () => {
		await transitionTaskWorkflowEvidence(directory, '1.2', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'coder:setup',
		});
		await transitionTaskWorkflowEvidence(directory, '1.2', {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: 'pre-check:c1',
		});

		const result = await execute('1.2');

		expect(result.workflow).toEqual({
			state: 'pre_check_passed',
			generation: 1,
		});
		expect(result.workflow_attribution_hint).toBeUndefined();
	});

	test('no workflow metadata → no workflow fields', async () => {
		fsWriteMinimalLegacyEvidence();
		const result = await execute('2.1');
		expect(result.workflow).toBeNull();
		expect(result.workflow_attribution_hint).toBeUndefined();
	});

	function fsWriteMinimalLegacyEvidence(): void {
		require('node:fs').mkdirSync(`${directory}/.swarm/evidence`, {
			recursive: true,
		});
		require('node:fs').writeFileSync(
			`${directory}/.swarm/evidence/2.1.json`,
			JSON.stringify({
				taskId: '2.1',
				required_gates: [],
				gates: {},
			}),
		);
	}
});
