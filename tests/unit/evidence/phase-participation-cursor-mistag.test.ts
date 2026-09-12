import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	observePhaseParticipationToolResult,
	readPhaseParticipation,
	reserveApprovedPhaseParticipation,
	resetPhaseParticipationForTests,
} from '../../../src/evidence/phase-participation';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

/**
 * Acceptance check C1 (DISCRIMINATING, AC1) for the issue #2702 cursor-mistag
 * fix contract.
 *
 * `reserveApprovedPhaseParticipation` stamps receipts with
 * `getCurrentPhase(plan)` (the never-advanced `current_phase` cursor), while
 * the `phase_complete` gate looks receipts up by the phase being completed.
 * When the cursor (1) is not the completing phase (3), genuine docs receipts
 * are tagged 1 and the phase-3 lookup misses them forever.
 */

function completedTask(
	id: string,
	phase: number,
): Plan['phases'][number]['tasks'][number] {
	return {
		id,
		phase,
		status: 'completed',
		size: 'small',
		description: `Completed task ${id}`,
		depends: [],
		files_touched: [],
	};
}

/** 3-phase plan whose cursor was authored once at plan creation and never advanced. */
function staleCursorPlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Stale Cursor Participation Plan',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Foundation',
				status: 'complete',
				tasks: [completedTask('1.1', 1)],
			},
			{
				id: 2,
				name: 'Hardening',
				status: 'complete',
				tasks: [completedTask('2.1', 2)],
			},
			{
				id: 3,
				name: 'Documentation',
				status: 'in_progress',
				required_agents: ['docs'],
				tasks: [],
			},
		],
	};
}

function writePlan(directory: string, plan: Plan): void {
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

/** Real docs Task dispatch drive: reserve at dispatch, observe a successful completion. */
async function driveDocsReceipt(
	directory: string,
	callId: string,
	parentSessionId = 'parent',
): Promise<void> {
	await reserveApprovedPhaseParticipation({
		directory,
		tool: 'Task',
		parentSessionId,
		callId,
		args: { subagent_type: 'docs' },
		policy: { require_docs: true },
	});
	await observePhaseParticipationToolResult({
		directory,
		tool: 'Task',
		parentSessionId,
		callId,
		output: {
			output: 'Documentation was checked and updated.',
			metadata: { status: 'completed', sessionId: 'docs-child' },
		},
	});
}

describe('phase participation cursor-mistag tolerance (issue #2702)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('pp-cursor-mistag-'));
		resetPhaseParticipationForTests();
	});

	afterEach(() => {
		resetPhaseParticipationForTests();
		cleanup();
	});

	// C1 (DISCRIMINATING — AC1). RED at base: the gate only matches
	// receipt.phase === 3, but the recorder stamped the cursor value 1.
	test('cursor-mistagged docs receipt satisfies the completing-phase lookup', async () => {
		const plan = staleCursorPlan();
		writePlan(directory, plan);
		await driveDocsReceipt(directory, 'docs-call');

		expect(await readPhaseParticipation(directory, plan, 3, 'docs')).toEqual({
			status: 'valid',
			found: true,
		});
	});
});
