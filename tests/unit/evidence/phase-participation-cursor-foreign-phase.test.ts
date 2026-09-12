import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	observePhaseParticipationToolResult,
	PHASE_PARTICIPATION_FILE,
	readPhaseParticipation,
	reserveApprovedPhaseParticipation,
	resetPhaseParticipationForTests,
} from '../../../src/evidence/phase-participation';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

/**
 * Acceptance check C5 (PRESERVING, AC5) for the issue #2702 cursor-mistag
 * fix contract: the mistag tolerance must stay narrow — a receipt whose phase
 * matches neither the gate's completing phase nor the plan cursor is still
 * rejected (no phase-agnostic fallback). GREEN at base and must stay green
 * after the fix: phase 2 matches neither the gate phase 3 (exact) nor the
 * plan cursor 1 (tolerance).
 */

interface StoredReceipt {
	role: string;
	phase: number;
	receiptId: string;
	[key: string]: unknown;
}

interface StoredParticipation {
	schemaVersion: number;
	pending: unknown[];
	receipts: StoredReceipt[];
}

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

/**
 * Cursor-lag plan (#2532-adjusted): receipts are stamped with the RESOLVED
 * active phase (getCurrentPhase), so the mistag tolerance arm covers plans
 * whose resolved cursor trails the phase being completed. Phase 1 stays
 * non-terminal so the resolved cursor is 1 while phases 2–3 are already
 * complete — keeping "phase 2 matches neither the gate phase 3 (exact) nor
 * the plan cursor 1 (tolerance)" a live rejection case.
 */
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
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Pending task 1.1',
						depends: [],
						files_touched: [],
					},
				],
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
				status: 'complete',
				required_agents: ['docs'],
				tasks: [completedTask('3.1', 3)],
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

function readParticipationStore(directory: string): StoredParticipation {
	return JSON.parse(
		fs.readFileSync(
			path.join(directory, '.swarm', ...PHASE_PARTICIPATION_FILE.split('/')),
			'utf8',
		),
	);
}

function writeParticipationStore(
	directory: string,
	store: StoredParticipation,
): void {
	fs.writeFileSync(
		path.join(directory, '.swarm', ...PHASE_PARTICIPATION_FILE.split('/')),
		JSON.stringify(store, null, 2),
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

describe('phase participation foreign-phase rejection (issue #2702)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('pp-cursor-foreign-'));
		resetPhaseParticipationForTests();
	});

	afterEach(() => {
		resetPhaseParticipationForTests();
		cleanup();
	});

	// C5 (PRESERVING — AC5). GREEN at base and must stay green after the fix.
	test('foreign-phase docs receipt is still rejected', async () => {
		const plan = staleCursorPlan();
		writePlan(directory, plan);
		// Real drive first so every other receipt field is derived exactly as
		// the module would derive it (schema-valid without reimplementing).
		await driveDocsReceipt(directory, 'docs-call');
		const store = readParticipationStore(directory);
		expect(store.receipts).toHaveLength(1);
		const recorded = store.receipts[0] as StoredReceipt;
		expect(recorded.phase).toBe(1);

		// Deep-copy the recorded receipt and re-stamp it to an unrelated phase.
		// receiptId/resultDigest stay the 64-hex strings the drive produced.
		const foreign: StoredReceipt = { ...recorded, phase: 2 };
		// Replace rather than append: the cursor-tagged phase-1 receipt must not
		// remain in the store, or the cursor tolerance (resolved cursor 1 < 3)
		// would satisfy the phase-3 lookup through it and flip this preserving
		// check red.
		writeParticipationStore(directory, {
			schemaVersion: 1,
			pending: store.pending,
			receipts: [foreign],
		});

		const read = await readPhaseParticipation(directory, plan, 3, 'docs');
		expect(read.status).toBe('valid');
		expect(read.found).toBe(false);
	});
});
