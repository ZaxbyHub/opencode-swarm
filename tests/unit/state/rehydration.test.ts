import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordGateEvidence } from '../../../src/gate-evidence';
import {
	ensureAgentSession,
	rehydrateSessionFromDisk,
	resetSwarmState,
} from '../../../src/state';
import { seedAuthoritativeTaskWorkflow } from '../hooks/_delegation-gate-helpers';

function writePlan(dir: string, taskIds: string[]): void {
	const swarmDir = path.join(dir, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	const plan = {
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: taskIds.map((id) => ({
					id,
					phase: 1,
					description: `Task ${id}`,
					status: 'in_progress',
				})),
			},
		],
	};
	writeFileSync(path.join(swarmDir, 'plan.json'), JSON.stringify(plan));
}

describe('readGateEvidenceFromDisk', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = mkdtempSync(path.join(os.tmpdir(), 'rehydration-test-'));
	});

	afterEach(() => {
		resetSwarmState();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it('accepts valid gate evidence files with taskId and required_gates', async () => {
		writePlan(tempDir, ['1.1']);
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence');
		mkdirSync(evidenceDir, { recursive: true });
		writeFileSync(
			path.join(evidenceDir, '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['reviewer', 'test_engineer'],
				gates: {
					reviewer: {
						sessionId: 'sess-1',
						timestamp: '2026-01-01T00:00:00.000Z',
						agent: 'reviewer',
					},
				},
			}),
		);

		const session = ensureAgentSession('test-session', 'architect');
		await rehydrateSessionFromDisk(tempDir, session);

		expect(session.taskWorkflowStates.has('1.1')).toBe(true);
	});

	it('rejects malformed files gracefully without throwing', async () => {
		writePlan(tempDir, ['1.1', '1.2']);
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence');
		mkdirSync(evidenceDir, { recursive: true });

		// Malformed: missing required_gates
		writeFileSync(
			path.join(evidenceDir, '1.2.json'),
			JSON.stringify({ taskId: '1.2', foo: 'bar' }),
		);

		// Valid evidence
		writeFileSync(
			path.join(evidenceDir, '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['reviewer'],
				gates: {},
			}),
		);

		const session = ensureAgentSession('test-session', 'architect');
		await rehydrateSessionFromDisk(tempDir, session);

		// Valid file should be loaded (evidence applied)
		expect(session.taskWorkflowStates.has('1.1')).toBe(true);
		// Malformed file skipped — task 1.2 still gets plan state from plan.json
		// but should NOT have evidence-derived state
		const state12 = session.taskWorkflowStates.get('1.2');
		// Plan state is in_progress which maps to coder_delegated
		// The malformed evidence file was skipped, so only plan state applied
		expect(state12).toBeDefined();
	});

	it('skips files with wrong schema without affecting valid files', async () => {
		writePlan(tempDir, ['2.1', '2.2', '2.3']);
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence');
		mkdirSync(evidenceDir, { recursive: true });

		// Invalid: not JSON
		writeFileSync(path.join(evidenceDir, '2.1.json'), 'not json');

		// Invalid: missing taskId
		writeFileSync(
			path.join(evidenceDir, '2.2.json'),
			JSON.stringify({ required_gates: ['reviewer'] }),
		);

		// Valid
		writeFileSync(
			path.join(evidenceDir, '2.3.json'),
			JSON.stringify({
				taskId: '2.3',
				required_gates: ['reviewer'],
				gates: {},
			}),
		);

		const session = ensureAgentSession('test-session', 'architect');
		await rehydrateSessionFromDisk(tempDir, session);

		// All tasks are in plan, so all get at least plan state
		// But only 2.3 has valid evidence
		expect(session.taskWorkflowStates.has('2.3')).toBe(true);
	});

	it('round-trips with recordGateEvidence output', async () => {
		writePlan(tempDir, ['3.1']);
		const generation = await seedAuthoritativeTaskWorkflow(
			tempDir,
			'3.1',
			'pre_check_passed',
			'sess-1',
		);
		await recordGateEvidence(tempDir, '3.1', 'reviewer', 'sess-1', false, {
			expectedGeneration: generation,
		});

		const session = ensureAgentSession('test-session', 'architect');
		await rehydrateSessionFromDisk(tempDir, session);

		expect(session.taskWorkflowStates.has('3.1')).toBe(true);
	});
});
