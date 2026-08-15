import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import {
	ensureAgentSession,
	rehydrateSessionFromDisk,
	resetSwarmState,
} from '../../../src/state';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

function writePlan(
	directory: string,
	taskId: string,
	status: 'pending' | 'in_progress' | 'completed' | 'blocked',
): void {
	const swarmDir = path.join(directory, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Workflow rehydration plan',
			swarm: 'test',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: taskId,
							phase: 1,
							description: `Task ${taskId}`,
							status,
						},
					],
				},
			],
		}),
	);
}

describe('state rehydration workflow generations', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = mkdtempSync(path.join(canonicalTmpDir(), 'state-rehydrate-gen-'));
	});

	afterEach(() => {
		resetSwarmState();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it('lets a newer authoritative generation override a stale stronger in-memory state', async () => {
		writePlan(tempDir, '1.1', 'completed');
		await transitionTaskWorkflowEvidence(tempDir, '1.1', {
			type: 'accepted_mutation',
			agentType: 'coder',
			transitionId: 'mut-1',
		});
		await transitionTaskWorkflowEvidence(tempDir, '1.1', {
			type: 'stage_a_failed',
			expectedGeneration: 1,
			transitionId: 'stage-a-failed',
		});

		const session = ensureAgentSession('rehydrate-session', 'architect');
		session.taskWorkflowStates.set('1.1', 'complete');

		await rehydrateSessionFromDisk(tempDir, session);

		expect(session.taskWorkflowStates.get('1.1')).toBe('rework_required');
		expect(session.taskWorkflowCache?.get('1.1')).toMatchObject({
			generation: 1,
			retryCount: 1,
			lastOutcome: 'stage_a_failed',
			lastTransitionId: 'stage-a-failed',
		});
	});

	it('treats legacy evidence without workflow metadata as non-authoritative', async () => {
		writePlan(tempDir, '1.2', 'in_progress');
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence');
		mkdirSync(evidenceDir, { recursive: true });
		writeFileSync(
			path.join(evidenceDir, '1.2.json'),
			JSON.stringify({
				taskId: '1.2',
				required_gates: ['reviewer', 'test_engineer'],
				gates: {
					reviewer: {
						sessionId: 'legacy-reviewer',
						timestamp: '2026-08-13T12:00:00.000Z',
						agent: 'reviewer',
					},
					test_engineer: {
						sessionId: 'legacy-test',
						timestamp: '2026-08-13T12:01:00.000Z',
						agent: 'test_engineer',
					},
				},
			}),
		);

		const session = ensureAgentSession('legacy-session', 'architect');
		await rehydrateSessionFromDisk(tempDir, session);

		expect(session.taskWorkflowStates.get('1.2')).toBe('idle');
		expect(session.taskWorkflowCache?.get('1.2')).toBeUndefined();
	});
});
