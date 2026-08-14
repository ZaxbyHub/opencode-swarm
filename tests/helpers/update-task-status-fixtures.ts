import * as fs from 'node:fs';
import * as path from 'node:path';

type FixtureGateValue = unknown;

export function buildExactTaskEvidence(
	taskId: string,
	gates: Record<string, FixtureGateValue>,
	requiredGates: string[],
): Record<string, unknown> {
	const normalizedGates = Object.fromEntries(
		Object.entries(gates).map(([gate, value]) => [
			gate,
			{
				sessionId: `session-${gate}`,
				timestamp: '2026-08-14T00:00:00.000Z',
				agent: gate,
				...(typeof value === 'object' && value !== null ? value : {}),
			},
		]),
	);
	const gateNames = new Set(Object.keys(normalizedGates));
	const state = gateNames.has('test_engineer')
		? 'tests_run'
		: gateNames.has('reviewer')
			? 'reviewer_run'
			: gateNames.has('coder')
				? 'coder_delegated'
				: 'idle';
	return {
		taskId,
		required_gates: requiredGates,
		gates: normalizedGates,
		workflow: {
			schema: 'exact-task-v1',
			generation: gateNames.size > 0 ? 1 : 0,
			state,
			retryCount: 0,
			retryHistory: [],
			retryEpoch: 0,
			lastOutcome: state === 'idle' ? 'none' : 'gate_recorded',
			lastTransitionId: null,
			updatedAt: '2026-08-14T00:00:00.000Z',
		},
	};
}

export function writeExactTaskEvidence(
	directory: string,
	taskId: string,
	gates: Record<string, FixtureGateValue>,
	requiredGates: string[],
): void {
	const evidenceDir = path.join(directory, '.swarm', 'evidence');
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, `${taskId}.json`),
		JSON.stringify(buildExactTaskEvidence(taskId, gates, requiredGates)),
	);
}

export function readPlanWithTaskStatus(
	directory: string,
	status: 'blocked' | 'completed' | 'in_progress' | 'pending',
): Record<string, unknown> {
	const plan = JSON.parse(
		fs.readFileSync(path.join(directory, '.swarm', 'plan.json'), 'utf-8'),
	);
	plan.phases[0].tasks[0].status = status;
	return plan;
}
