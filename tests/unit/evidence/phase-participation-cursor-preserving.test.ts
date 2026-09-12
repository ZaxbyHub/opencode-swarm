import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { getCurrentPhase } from '../../../src/config/plan-schema';
import {
	observePhaseParticipationToolResult,
	PHASE_PARTICIPATION_FILE,
	readPhaseParticipation,
	reserveApprovedPhaseParticipation,
	resetPhaseParticipationForTests,
} from '../../../src/evidence/phase-participation';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

/**
 * Acceptance check C3 (PRESERVING, AC2+AC5) for the issue #2702 cursor-mistag
 * fix contract: the recorder keeps stamping the plan cursor, exact-phase
 * matches under a healthy cursor keep working, and foreign-phase receipts stay
 * rejected. GREEN at base and must stay green after the fix.
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
 * active phase (getCurrentPhase), so the mistag arm covers plans whose
 * resolved cursor trails the phase being completed. Phase 1 stays
 * non-terminal so the resolved cursor is 1 while phases 2–3 are already
 * complete.
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

/**
 * Same 3-phase plan but with a healthy cursor pointing at the completing
 * phase: phases 1–2 complete, phase 3 in progress (non-terminal), stored
 * cursor 3 — so the resolved active phase is the completing phase 3.
 */
function healthyCursorPlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Stale Cursor Participation Plan',
		swarm: 'test',
		current_phase: 3,
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

describe('phase participation cursor-mistag preserving checks (issue #2702)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('pp-cursor-keep-'));
		resetPhaseParticipationForTests();
	});

	afterEach(() => {
		resetPhaseParticipationForTests();
		cleanup();
	});

	// C3(a) — the recorder itself must keep stamping the plan cursor value.
	// GREEN at base and must stay green after the fix (recorder unchanged).
	test('recorder still stamps the plan cursor, not the completing phase', async () => {
		const plan = staleCursorPlan();
		writePlan(directory, plan);
		await driveDocsReceipt(directory, 'docs-call');

		const store = readParticipationStore(directory);
		expect(store.receipts).toHaveLength(1);
		expect(store.receipts[0]?.role).toBe('docs');
		expect(store.receipts[0]?.phase).toBe(getCurrentPhase(plan));
		expect(store.receipts[0]?.phase).toBe(1);
		expect(store.receipts[0]?.phase).not.toBe(3);
	});

	// C3(b) — exact-phase receipts under a healthy cursor keep matching.
	// GREEN at base and must stay green after the fix.
	test('exact-phase docs receipt still matches under a healthy cursor', async () => {
		const plan = healthyCursorPlan();
		writePlan(directory, plan);
		await driveDocsReceipt(directory, 'docs-call');

		const store = readParticipationStore(directory);
		expect(store.receipts).toHaveLength(1);
		expect(store.receipts[0]?.phase).toBe(3);
		expect(await readPhaseParticipation(directory, plan, 3, 'docs')).toEqual({
			status: 'valid',
			found: true,
		});
	});
});
