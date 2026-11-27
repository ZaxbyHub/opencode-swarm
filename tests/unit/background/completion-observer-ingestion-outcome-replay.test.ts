/**
 * r14 audit repair (P0-1): negative stage-B outcomes stay negative across
 * replay.
 *
 * The live observer commits a terminal-negative stage-B ingestion (REJECTED /
 * CONCERNS / FAIL / SKIPPED verdict, stale workspace) as `consumed` — the
 * durable semantic outcome rides the SAME atomic commit. These tests inject a
 * process crash directly after that durable negative commit (before the
 * context-map/parent-advisory closeout) and prove that a NEW observer
 * instance — a full restart re-reading the persistent ledger — can never
 * translate the consumed record into an approved context-map summary.
 *
 * Legacy consumed records (pre-r14, no provable semantic outcome) are
 * fail-closed: they never reach the success closeout either.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	type DurableIngestionOutcome,
	findByCorrelationId,
	readDurableIngestionOutcome,
	recordDelegationIngestionResult,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import { loadContextMap } from '../../../src/context-map/persistence';
import { closeAllProjectDbs, getProjectDb } from '../../../src/db/project-db';
import { readTaskEvidence } from '../../../src/gate-evidence';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import {
	ensureAgentSession,
	getTaskState,
	resetSwarmState,
} from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';

const PARENT = 'ses_r14_parent';

function completionEvent(
	childSessionId: string,
	body: string,
	parentSessionId = PARENT,
) {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: parentSessionId,
					text: `<task id="${childSessionId}" state="completed">\n${body}\n</task>`,
				},
			},
		},
	};
}

async function seedReviewer(
	directory: string,
	taskId: string,
	callID: string,
	childSessionId: string,
): Promise<number> {
	const parent = ensureAgentSession(PARENT, 'architect', directory);
	parent.taskWorkflowStates.set(taskId, 'coder_delegated');
	const generation = await seedStageAPassed(directory, taskId);
	await recordPendingDelegation(directory, {
		correlationId: childSessionId,
		jobId: `job-${childSessionId}`,
		subagentSessionId: childSessionId,
		parentSessionId: PARENT,
		callID,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: taskId,
		evidenceTaskId: taskId,
		workflowGeneration: generation,
		workspace: captureWorkspaceSnapshot(directory),
	});
	return generation;
}

async function seedTestEngineer(
	directory: string,
	taskId: string,
	callID: string,
	childSessionId: string,
): Promise<number> {
	const parent = ensureAgentSession(PARENT, 'architect', directory);
	parent.taskWorkflowStates.set(taskId, 'coder_delegated');
	const generation = await seedStageAPassed(directory, taskId);
	await recordPendingDelegation(directory, {
		correlationId: childSessionId,
		jobId: `job-${childSessionId}`,
		subagentSessionId: childSessionId,
		parentSessionId: PARENT,
		callID,
		normalizedAgent: 'test_engineer',
		swarmPrefixedAgent: 'test_engineer',
		planTaskId: taskId,
		evidenceTaskId: taskId,
		workflowGeneration: generation,
		workspace: captureWorkspaceSnapshot(directory),
	});
	return generation;
}

/**
 * Crash-injection seam for the observer's recordIngestionResult dependency:
 * performs the REAL durable commit (forwarding the semantic outcome), then
 * throws ONCE — the process died immediately after the durable negative
 * ingestion commit and before any closeout effect ran.
 */
function crashingCommitSeam() {
	let crashed = false;
	const seam = async (
		dir: string,
		correlationId: string,
		claimToken: string,
		success: boolean,
		options?: { now?: number; outcome?: DurableIngestionOutcome },
	) => {
		const committed = await recordDelegationIngestionResult(
			dir,
			correlationId,
			claimToken,
			success,
			options,
		);
		if (committed && !crashed) {
			crashed = true;
			throw new Error('injected crash after durable ingestion commit');
		}
		return committed;
	};
	return seam as typeof recordDelegationIngestionResult;
}

/**
 * Simulate a pre-r14 ledger: strip the semantic outcome from the record's
 * durable coordination row — the typed r14 writers can no longer produce this
 * shape (same sanctioned raw-SQL pattern as the legacy-deadline-read fixture).
 * This is exactly the durable state an upgraded installation replays.
 */
function stripIngestionOutcome(directory: string, correlationId: string): void {
	const db = getProjectDb(directory);
	const row = db
		.query<{ payload: string }, [string]>(
			`SELECT payload FROM coordination_state
			 WHERE namespace = 'background.pending-delegation' AND entity_key = ?`,
		)
		.get(correlationId);
	if (!row) throw new Error('stripIngestionOutcome: coordination row missing');
	const payload = JSON.parse(row.payload) as {
		ingestion?: Record<string, unknown>;
	};
	if (payload.ingestion?.state !== 'consumed') {
		throw new Error('stripIngestionOutcome: record is not consumed');
	}
	delete payload.ingestion.outcome;
	db.run(
		`UPDATE coordination_state SET payload = ?
		 WHERE namespace = 'background.pending-delegation' AND entity_key = ?`,
		[JSON.stringify(payload), correlationId],
	);
}

describe('background completion observer — negative stage-b outcomes survive replay (r14 P0-1)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('bg-outcome-replay-'));
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('REJECTED reviewer verdict stays rejected across a crash-restart replay', async () => {
		await seedReviewer(directory, '1.1', 'call-r14-rejected', 'ses_r14_child');
		const body =
			'<task_result>[REVIEWED] | 1.1 | REJECTED | broken logic</task_result>';

		// Crash: durable negative commit lands, closeout never runs.
		const firstObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
			recordIngestionResult: crashingCommitSeam(),
		});
		await firstObserver.event(completionEvent('ses_r14_child', body));

		const committed = findByCorrelationId(directory, 'ses_r14_child');
		expect(committed?.status).toBe('consumed');
		expect(committed?.ingestion?.state).toBe('consumed');
		expect(committed?.ingestion?.outcome).toBe('rejected');
		expect(loadContextMap(directory)?.task_history['1.1']).toBeUndefined();

		// Restart: a fresh observer instance replays the same terminal.
		const replayObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await replayObserver.event(completionEvent('ses_r14_child', body));

		const record = findByCorrelationId(directory, 'ses_r14_child');
		expect(record?.status).toBe('consumed');
		expect(record?.ingestion?.outcome).toBe('rejected');
		// THE regression: a consumed replay must never become approved.
		expect(loadContextMap(directory)?.task_history['1.1']).toBeUndefined();
		expect(record?.closeout?.steps.context_map?.state).toBe('completed');
		expect(record?.closeout?.steps.parent_advisory?.state).toBe('completed');
		expect(record?.advisoryInbox?.message).toContain('rejected');
		const session = ensureAgentSession(PARENT, 'architect', directory);
		expect(getTaskState(session, '1.1')).toBe('rework_required');
	});

	test('CONCERNS reviewer verdict produces no approval across a crash-restart replay', async () => {
		await seedReviewer(
			directory,
			'1.2',
			'call-r14-concerns',
			'ses_r14_concerns',
		);
		const body =
			'<task_result>[REVIEWED] | 1.2 | CONCERNS | needs discussion</task_result>';

		const firstObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
			recordIngestionResult: crashingCommitSeam(),
		});
		await firstObserver.event(completionEvent('ses_r14_concerns', body));

		expect(
			findByCorrelationId(directory, 'ses_r14_concerns')?.ingestion?.outcome,
		).toBe('rejected');

		const replayObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await replayObserver.event(completionEvent('ses_r14_concerns', body));

		expect(loadContextMap(directory)?.task_history['1.2']).toBeUndefined();
		const record = findByCorrelationId(directory, 'ses_r14_concerns');
		expect(record?.closeout?.steps.context_map?.state).toBe('completed');
		expect(record?.advisoryInbox?.message).toContain('rejected');
	});

	test('TESTED FAIL (test_engineer) stays failed across a crash-restart replay', async () => {
		await seedTestEngineer(directory, '1.3', 'call-r14-fail', 'ses_r14_fail');
		const body =
			'<task_result>[TESTED] | 1.3 | FAIL | 2 assertions failed</task_result>';

		const firstObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
			recordIngestionResult: crashingCommitSeam(),
		});
		await firstObserver.event(completionEvent('ses_r14_fail', body));

		expect(
			findByCorrelationId(directory, 'ses_r14_fail')?.ingestion?.outcome,
		).toBe('rejected');

		const replayObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await replayObserver.event(completionEvent('ses_r14_fail', body));

		expect(loadContextMap(directory)?.task_history['1.3']).toBeUndefined();
		const record = findByCorrelationId(directory, 'ses_r14_fail');
		expect(record?.ingestion?.outcome).toBe('rejected');
		expect(record?.closeout?.steps.context_map?.state).toBe('completed');
		const session = ensureAgentSession(PARENT, 'architect', directory);
		expect(getTaskState(session, '1.3')).toBe('rework_required');
	});

	test('TESTED SKIPPED (test_engineer) stays skipped across a crash-restart replay', async () => {
		await seedTestEngineer(directory, '1.4', 'call-r14-skip', 'ses_r14_skip');
		const body =
			'<task_result>[TESTED] | 1.4 | SKIPPED | tests not run</task_result>';

		const firstObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
			recordIngestionResult: crashingCommitSeam(),
		});
		await firstObserver.event(completionEvent('ses_r14_skip', body));

		const committed = findByCorrelationId(directory, 'ses_r14_skip');
		expect(committed?.ingestion?.outcome).toBe('skipped');

		const replayObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await replayObserver.event(completionEvent('ses_r14_skip', body));

		expect(loadContextMap(directory)?.task_history['1.4']).toBeUndefined();
		const record = findByCorrelationId(directory, 'ses_r14_skip');
		expect(record?.ingestion?.outcome).toBe('skipped');
		expect(record?.closeout?.steps.context_map?.state).toBe('completed');
		expect(record?.advisoryInbox?.message).toContain('skipped');
	});

	test('a legacy consumed record without a provable outcome is fail-closed across replay', async () => {
		await seedReviewer(directory, '1.5', 'call-r14-legacy', 'ses_r14_legacy');
		const body =
			'<task_result>[REVIEWED] | 1.5 | REJECTED | legacy ledger</task_result>';

		// Produce the durable negative commit, then downgrade the ledger to
		// the pre-r14 shape (no `ingestion.outcome`) — the exact durable state
		// an upgraded installation replays.
		const firstObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
			recordIngestionResult: crashingCommitSeam(),
		});
		await firstObserver.event(completionEvent('ses_r14_legacy', body));
		stripIngestionOutcome(directory, 'ses_r14_legacy');

		const legacyRecord = findByCorrelationId(directory, 'ses_r14_legacy');
		expect(legacyRecord?.status).toBe('consumed');
		expect(legacyRecord?.ingestion?.outcome).toBeUndefined();
		expect(readDurableIngestionOutcome(legacyRecord!)).toEqual({
			kind: 'unverifiable',
		});

		const replayObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await replayObserver.event(completionEvent('ses_r14_legacy', body));

		expect(loadContextMap(directory)?.task_history['1.5']).toBeUndefined();
		const record = findByCorrelationId(directory, 'ses_r14_legacy');
		expect(record?.closeout?.steps.context_map?.state).toBe('completed');
		expect(record?.advisoryInbox?.message).toContain(
			'without a provable semantic outcome',
		);
	});

	test('an accepted outcome still writes the context-map summary across replay (non-final until the task release)', async () => {
		await seedReviewer(directory, '1.6', 'call-r14-accepted', 'ses_r14_ok');
		const body =
			'<task_result>[REVIEWED] | 1.6 | APPROVED | no issues</task_result>';

		const firstObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
			recordIngestionResult: crashingCommitSeam(),
		});
		await firstObserver.event(completionEvent('ses_r14_ok', body));

		const committed = findByCorrelationId(directory, 'ses_r14_ok');
		expect(committed?.ingestion?.outcome).toBe('accepted');
		expect(loadContextMap(directory)?.task_history['1.6']).toBeUndefined();

		const replayObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await replayObserver.event(completionEvent('ses_r14_ok', body));

		const summary = loadContextMap(directory)?.task_history['1.6'];
		expect(summary).toBeDefined();
		// r14 (P1-5): a lone accepted reviewer is a child-level success — the
		// summary is written but stays NON-FINAL ('pending') until the
		// authoritative task release (update_task_status).
		expect(summary?.final_status).toBe('pending');
		const record = findByCorrelationId(directory, 'ses_r14_ok');
		expect(record?.closeout?.steps.context_map?.state).toBe('completed');
	});

	test('double replay creates no duplicate stage-b evidence or advisories', async () => {
		await seedReviewer(directory, '1.7', 'call-r14-double', 'ses_r14_double');
		const body =
			'<task_result>[REVIEWED] | 1.7 | REJECTED | double replay</task_result>';

		const firstObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
			recordIngestionResult: crashingCommitSeam(),
		});
		await firstObserver.event(completionEvent('ses_r14_double', body));

		const replayObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await replayObserver.event(completionEvent('ses_r14_double', body));
		const afterFirstReplay = findByCorrelationId(directory, 'ses_r14_double');
		const evidenceAfterFirst = await readTaskEvidence(directory, '1.7');
		const advisoryEventId = afterFirstReplay?.advisoryInbox?.eventId;

		// Second replay: nothing changes — no duplicate stage-b evidence, no
		// duplicate advisory slot, no success summary.
		await replayObserver.event(completionEvent('ses_r14_double', body));

		const afterSecondReplay = findByCorrelationId(directory, 'ses_r14_double');
		const evidenceAfterSecond = await readTaskEvidence(directory, '1.7');
		expect(evidenceAfterSecond).toEqual(evidenceAfterFirst);
		expect(afterSecondReplay?.advisoryInbox?.eventId).toBe(advisoryEventId);
		expect(afterSecondReplay?.ingestion?.attempt).toBe(
			afterFirstReplay?.ingestion?.attempt,
		);
		expect(loadContextMap(directory)?.task_history['1.7']).toBeUndefined();
	});

	test('competing completions are not crossed: one rejected and one approved record in the same replay', async () => {
		await seedReviewer(directory, '1.8', 'call-r14-a', 'ses_r14_neg');
		await seedReviewer(directory, '1.9', 'call-r14-b', 'ses_r14_pos');
		const rejectedBody =
			'<task_result>[REVIEWED] | 1.8 | REJECTED | broken</task_result>';
		const approvedBody =
			'<task_result>[REVIEWED] | 1.9 | APPROVED | fine</task_result>';

		// The negative record crashes after its durable commit; the positive
		// record processes fully.
		const firstObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
			recordIngestionResult: crashingCommitSeam(),
		});
		await firstObserver.event(completionEvent('ses_r14_neg', rejectedBody));
		await firstObserver.event(completionEvent('ses_r14_pos', approvedBody));

		// Restart: replay BOTH terminals through one fresh observer.
		const replayObserver = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await replayObserver.event(completionEvent('ses_r14_neg', rejectedBody));
		await replayObserver.event(completionEvent('ses_r14_pos', approvedBody));

		const history = loadContextMap(directory)?.task_history ?? {};
		expect(history['1.8']).toBeUndefined(); // rejected stays rejected
		// r14 (P1-5): the accepted record's summary exists but is NON-FINAL
		// ('pending') — a lone reviewer approval is not a task release.
		expect(history['1.9']?.final_status).toBe('pending'); // accepted stays accepted (non-final)
		expect(
			findByCorrelationId(directory, 'ses_r14_neg')?.ingestion?.outcome,
		).toBe('rejected');
		expect(
			findByCorrelationId(directory, 'ses_r14_pos')?.ingestion?.outcome,
		).toBe('accepted');
	});
});
