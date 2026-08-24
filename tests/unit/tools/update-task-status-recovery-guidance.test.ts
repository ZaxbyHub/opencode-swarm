import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetSwarmState, swarmState } from '../../../src/state';
import { checkReviewerGate } from '../../../src/tools/update-task-status';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import { createWorkflowTestSessionWithPassedTask } from '../../helpers/workflow-session-factory';

const PLAN_JSON = JSON.stringify({
	schema_version: '1.0.0',
	title: 'Recovery Guidance Test Plan',
	swarm: 'recovery-guidance-test',
	current_phase: 1,
	migration_status: 'migrated',
	phases: [
		{
			id: 1,
			name: 'Phase 1',
			status: 'in_progress',
			tasks: [
				{
					id: '1.1',
					phase: 1,
					status: 'in_progress',
					size: 'small',
					description: 'Test task',
					depends: [],
					files_touched: [],
				},
			],
		},
	],
});

function evidencePath(tmpDir: string, taskId: string): string {
	return path.join(tmpDir, '.swarm', 'evidence', `${taskId}.json`);
}

describe('checkReviewerGate corrupt evidence guidance', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = canonicalMkdtemp('recovery-guidance-test-');
		fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), PLAN_JSON);
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('names repair_gate_evidence instead of manual deletion for corrupt evidence', () => {
		fs.mkdirSync(path.join(tmpDir, '.swarm', 'evidence'), { recursive: true });
		fs.writeFileSync(evidencePath(tmpDir, '1.1'), '{ invalid json }');

		const session = createWorkflowTestSessionWithPassedTask('1.1');
		swarmState.agentSessions.set('session-1', session);

		const result = checkReviewerGate('1.1', tmpDir);

		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('repair_gate_evidence');
		expect(result.reason).not.toContain('delete it to fall through');
	});
});
