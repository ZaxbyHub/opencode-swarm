import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	getCoordinationState,
	transitionCoordinationState,
} from '../../src/db/coordination-store.js';
import {
	prWorkflowSessionFileStem,
	workflowGateStateRelativePath,
} from '../../src/pr-review/persistence.js';

const NAMESPACE_PREFIX = 'pr-workflow.state';
const ENTITY_KEY = 'state';

/** Persist a test gate state through the same SQLite authority as production. */
export async function writeAuthoritativePrWorkflowState(
	directory: string,
	state: Record<string, unknown> & {
		sessionID: string;
		revision: number;
		mode: string;
	},
): Promise<void> {
	const namespace = `${NAMESPACE_PREFIX}:${prWorkflowSessionFileStem(state.sessionID)}`;
	const current = getCoordinationState(directory, namespace, ENTITY_KEY);
	const result = transitionCoordinationState(directory, {
		namespace,
		entityKey: ENTITY_KEY,
		expectedRevision: current?.revision ?? null,
		generation: state.revision,
		status: state.mode,
		payload: JSON.stringify(state),
	});
	if (result.outcome !== 'applied') {
		throw new Error(
			`test gate-state authority update failed: ${result.outcome}`,
		);
	}
	const filePath = path.join(
		directory,
		'.swarm',
		workflowGateStateRelativePath(state.sessionID),
	);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
}
