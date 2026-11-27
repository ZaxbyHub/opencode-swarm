/**
 * r15 audit follow-up (P2): the context-map closeout read-back must prove the
 * CURRENT change persisted — not merely that SOME entry for the task id
 * exists.
 *
 * The r14 (P0-2) verifier `verifyContextMapWrite` checked only
 * `task_history[taskId] !== undefined`. An OLD entry (e.g. a pending summary
 * "OLD" from a previous completion) plus a SUPPRESSED save failure inside
 * `updateContextMapAfterAgent` (which swallows internal errors and returns a
 * fallback map) still read back as "entry present" — the context_map step was
 * acked 'persisted' although the current completion's summary never landed.
 * A later replay then SKIPPED the missing write forever ('closed' step).
 *
 * Required guarantees (r15):
 * - an old entry must NOT ack a new completion,
 * - an identical already-persisted effect counts as idempotent success,
 * - the terminal non-overwrite guard (r14 P1-5) still counts as success (the
 *   preserved terminal verdict IS the intended durable state),
 * - a failed read-back is a retryable error,
 * - a later replay must catch up the missing write.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import type { Plan } from '../../../src/config/plan-schema';
import {
	appendTaskHistory,
	createEmptyContextMap,
	loadContextMap,
	saveContextMap,
} from '../../../src/context-map/persistence';
import { _internals as postAgentInternals } from '../../../src/context-map/post-agent-update';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import type { TaskContextSummary } from '../../../src/types/context-map';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';

const PARENT = 'ses_r15p2_parent';
const NEW_SUMMARY = '[REVIEWED] | 1.1 | APPROVED | fresh work';
const NEW_BODY = `<task_result>${NEW_SUMMARY}</task_result>`;

function writePlan(directory: string): void {
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'P2 Context Map Readback Plan',
		swarm: 'p2-readback',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Do the work',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	} as Plan;
	fs.mkdirSync(join(directory, '.swarm'), { recursive: true });
	fs.mkdirSync(join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	fs.writeFileSync(
		join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ context_map: { enabled: true } }),
	);
}

function completionEvent(childSessionId: string, body: string) {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: PARENT,
					text: `<task id="${childSessionId}" state="completed">\n${body}\n</task>`,
				},
			},
		},
	};
}

function seedOldEntry(
	directory: string,
	summary: Partial<TaskContextSummary>,
): void {
	const map = loadContextMap(directory) ?? createEmptyContextMap();
	saveContextMap(
		appendTaskHistory(map, {
			task_id: '1.1',
			goal: '',
			files_touched: [],
			implementation_summary: 'OLD',
			final_status: 'pending',
			...summary,
		}),
		directory,
	);
}

async function seedReviewer(
	directory: string,
	taskId: string,
	childSessionId: string,
): Promise<void> {
	const parent = ensureAgentSession(PARENT, 'architect', directory);
	parent.taskWorkflowStates.set(taskId, 'coder_delegated');
	const generation = await seedStageAPassed(directory, taskId);
	await recordPendingDelegation(directory, {
		correlationId: childSessionId,
		jobId: `job-${childSessionId}`,
		subagentSessionId: childSessionId,
		parentSessionId: PARENT,
		callID: `call-${childSessionId}`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: taskId,
		evidenceTaskId: taskId,
		workflowGeneration: generation,
		workspace: captureWorkspaceSnapshot(directory),
	});
}

describe('background completion observer — context-map read-back proves the current write (r15 P2)', () => {
	let directory: string;
	let cleanup: () => void;
	let origSave: typeof postAgentInternals.saveContextMap;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('bg-ctxmap-readback-'));
		writePlan(directory);
		origSave = postAgentInternals.saveContextMap;
	});

	afterEach(() => {
		postAgentInternals.saveContextMap = origSave;
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('an old entry plus a suppressed save failure must NOT ack the context_map step; a later replay catches up', async () => {
		seedOldEntry(directory, { implementation_summary: 'OLD' });
		await seedReviewer(directory, '1.1', 'ses_r15p2_rev');
		// Inject a suppressed persistence failure: updateContextMapAfterAgent
		// swallows the throw and returns a fallback map, leaving the OLD
		// entry untouched on disk.
		postAgentInternals.saveContextMap = () => {
			throw new Error('injected disk full');
		};

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await observer.event(completionEvent('ses_r15p2_rev', NEW_BODY));

		// The current completion's summary never persisted — the step must
		// stay pending (retryable), NOT be acked off the stale OLD entry.
		const record = findByCorrelationId(directory, 'ses_r15p2_rev');
		expect(record?.closeout?.steps.context_map?.state).toBe('pending');
		expect(record?.closeout?.steps.context_map?.leaseToken).toBeUndefined();
		expect(
			loadContextMap(directory)?.task_history['1.1']?.implementation_summary,
		).toBe('OLD');

		// Recovery: persistence works again; a replay of the same terminal
		// must catch up the missing write and only then ack the step.
		postAgentInternals.saveContextMap = origSave;
		await observer.event(completionEvent('ses_r15p2_rev', NEW_BODY));
		const recovered = findByCorrelationId(directory, 'ses_r15p2_rev');
		expect(recovered?.closeout?.steps.context_map?.state).toBe('completed');
		const entry = loadContextMap(directory)?.task_history['1.1'];
		expect(entry?.implementation_summary).toBe(NEW_SUMMARY);
		expect(entry?.final_status).toBe('pending');
	});

	test('an identical already-persisted summary is an idempotent success', async () => {
		// The exact summary this completion would write is already on disk
		// (e.g. a replay after the ack was lost) — the step may ack.
		seedOldEntry(directory, { implementation_summary: NEW_SUMMARY });
		await seedReviewer(directory, '1.1', 'ses_r15p2_idem');
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await observer.event(completionEvent('ses_r15p2_idem', NEW_BODY));
		const record = findByCorrelationId(directory, 'ses_r15p2_idem');
		expect(record?.closeout?.steps.context_map?.state).toBe('completed');
		expect(
			loadContextMap(directory)?.task_history['1.1']?.implementation_summary,
		).toBe(NEW_SUMMARY);
	});

	test('the terminal non-overwrite guard still acks: a preserved terminal verdict is the intended state', async () => {
		// r14 P1-5: a pending child-level summary must not clobber a terminal
		// verdict. The guard skipping the write IS the intended durable
		// outcome — the step must ack, not re-drive forever.
		seedOldEntry(directory, {
			implementation_summary: 'OLD-NEGATIVE',
			final_status: 'rejected',
		});
		await seedReviewer(directory, '1.1', 'ses_r15p2_guard');
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await observer.event(completionEvent('ses_r15p2_guard', NEW_BODY));
		const record = findByCorrelationId(directory, 'ses_r15p2_guard');
		expect(record?.closeout?.steps.context_map?.state).toBe('completed');
		const entry = loadContextMap(directory)?.task_history['1.1'];
		expect(entry?.final_status).toBe('rejected');
		expect(entry?.implementation_summary).toBe('OLD-NEGATIVE');
	});
});
