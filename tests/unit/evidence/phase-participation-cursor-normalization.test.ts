import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	observePhaseParticipationToolResult,
	PHASE_PARTICIPATION_FILE,
	readPhaseParticipation,
	rebindCursorTaggedReceipts,
	reserveApprovedPhaseParticipation,
	resetPhaseParticipationForTests,
} from '../../../src/evidence/phase-participation';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

/**
 * Acceptance check for the issue #2702 cursor-mistag normalization surface
 * (fix contract point 2). `rebindCursorTaggedReceipts` re-stamps durable
 * docs receipts that were tagged with the never-advanced plan cursor to the
 * phase actually being completed.
 *
 * Before the fix lands this file cannot load: the pinned export does not
 * exist yet and bun fails the file with an export-not-found error. That is
 * the expected base result (ERROR), not a fixture bug.
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

function staleCursorPlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Stale Cursor Normalization Plan',
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

function readDocsReceiptPhases(directory: string): number[] {
	const store = JSON.parse(
		fs.readFileSync(
			path.join(directory, '.swarm', ...PHASE_PARTICIPATION_FILE.split('/')),
			'utf8',
		),
	) as {
		receipts: Array<{ role: string; phase: number }>;
	};
	return store.receipts
		.filter((receipt) => receipt.role === 'docs')
		.map((receipt) => receipt.phase);
}

describe('rebindCursorTaggedReceipts normalization (issue #2702)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('pp-cursor-rebind-'));
		resetPhaseParticipationForTests();
	});

	afterEach(() => {
		resetPhaseParticipationForTests();
		cleanup();
	});

	test('rebinds cursor-tagged docs receipts to the completing phase', async () => {
		const plan = staleCursorPlan();
		writePlan(directory, plan);
		await driveDocsReceipt(directory, 'docs-call');
		// The recorder stamped the never-advanced cursor value (1).
		expect(readDocsReceiptPhases(directory)).toEqual([1]);

		const result = await rebindCursorTaggedReceipts(directory, plan, 3, 'docs');
		expect(result.rebound).toBe(1);
		expect(readDocsReceiptPhases(directory)).toEqual([3]);

		// The re-bound receipt must not leak into an unrelated future phase:
		// a NEW phase still needs fresh participation.
		const futureRead = await readPhaseParticipation(directory, plan, 4, 'docs');
		expect(futureRead.status).toBe('valid');
		expect(futureRead.found).toBe(false);

		// A fresh dispatch is cursor-tagged 1, which the tolerance accepts for
		// phase 4 — a new phase is satisfiable by a new real docs dispatch.
		await driveDocsReceipt(directory, 'docs-call-2');
		const freshRead = await readPhaseParticipation(directory, plan, 4, 'docs');
		expect(freshRead.status).toBe('valid');
		expect(freshRead.found).toBe(true);
	});
});
