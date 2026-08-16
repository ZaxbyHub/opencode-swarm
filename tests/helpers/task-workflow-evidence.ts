import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	recordAgentDispatch,
	recordGateEvidence,
	transitionTaskWorkflowEvidence,
} from '../../src/gate-evidence';
import { ensureAgentSession } from '../../src/state';

/** Seed the exact accepted-mutation + Stage A state required by Stage B/council fixtures. */
export async function seedStageAPassed(
	directory: string,
	taskId: string,
	context: Parameters<typeof recordAgentDispatch>[4] = {},
): Promise<number> {
	await recordAgentDispatch(directory, taskId, 'coder', false, context);
	const generation = getTaskWorkflowSnapshot(
		await readTaskEvidence(directory, taskId),
	).generation;
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'stage_a_passed',
		expectedGeneration: generation,
		transitionId: `test-seed-stage-a:${taskId}:${generation}`,
	});
	return generation;
}

/** Seed Stage A and bind the council launch generation to the caller session. */
export async function seedCouncilLaunch(
	directory: string,
	taskId: string,
	sessionId: string,
): Promise<number> {
	const generation = await seedStageAPassed(directory, taskId);
	const session = ensureAgentSession(sessionId);
	if (!session.taskCouncilWorkflowGeneration) {
		session.taskCouncilWorkflowGeneration = new Map();
	}
	session.taskCouncilWorkflowGeneration.set(taskId, generation);
	return generation;
}

/** Seed Stage A, then record the requested Stage B gates at that generation. */
export async function seedStageBGates(
	directory: string,
	taskId: string,
	gates: readonly string[] = ['reviewer', 'test_engineer'],
): Promise<number> {
	const generation = await seedStageAPassed(directory, taskId);
	for (const gate of gates) {
		await recordGateEvidence(directory, taskId, gate, `test-${gate}`, false, {
			expectedGeneration: generation,
		});
	}
	return generation;
}
