/**
 * r13 audit repair (P0-3/P1-2/P1-5/P2-2): crash-safe terminal closeout.
 *
 * The immutable terminal claim and the business closeout effects are now
 * SEPARATE durable concerns: a versioned closeout journal on the delegation
 * record acks each effect only after it was durably established. These tests
 * inject controlled crashes at exact points (by constructing the durable
 * intermediate state through the public store APIs, or by injecting the
 * observer's recordIngestionResult seam) and prove that a NEW observer
 * instance — a process restart — re-drives exactly the missing steps.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	buildBackgroundCompletionEventId,
	claimTerminalResult,
	findByCorrelationId,
	initializeTerminalCloseout,
	isTerminalCloseoutStepPending,
	markTerminalCloseoutStepCompleted,
	preparePendingBackgroundAdvisories,
	putTerminalCloseoutAdvisory,
	recordDelegationIngestionResult,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { parseTaskEnvelope } from '../../../src/background/task-envelope';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import type { Plan } from '../../../src/config/plan-schema';
import { loadContextMap } from '../../../src/context-map/persistence';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { telemetry } from '../../../src/telemetry';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';

function writePlan(directory: string): void {
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Closeout Recovery Plan',
		swarm: 'closeout-recovery',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'pending',
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
	mkdirSync(join(directory, '.swarm'), { recursive: true });
	writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

function completionEvent(
	childSessionId: string,
	state: 'completed' | 'error' | 'cancelled',
	body: string,
	parentSessionId = 'ses_recovery_parent',
) {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: parentSessionId,
					text: `<task id="${childSessionId}" state="${state}">\n${body}\n</task>`,
				},
			},
		},
	};
}

async function recordPending(
	directory: string,
	options: { agent?: string; workflowGeneration?: number } = {},
): Promise<void> {
	const agent = options.agent ?? 'reviewer';
	await recordPendingDelegation(directory, {
		correlationId: 'ses_recovery_child',
		jobId: 'job-recovery',
		subagentSessionId: 'ses_recovery_child',
		parentSessionId: 'ses_recovery_parent',
		callID: 'call-recovery-1',
		normalizedAgent: agent,
		swarmPrefixedAgent: agent,
		planTaskId: '1.1',
		evidenceTaskId: '1.1',
		...(options.workflowGeneration !== undefined
			? { workflowGeneration: options.workflowGeneration }
			: {}),
		workspace: captureWorkspaceSnapshot(directory),
	});
}

/**
 * Deterministic manual terminal construction — EXACTLY the envelope→terminal
 * mapping the live observer performs (same digest, chars, truncated, and
 * eventId), so a manually claimed terminal is byte-identical to the one the
 * observer would claim from the same completion event.
 */
function manualTerminal(body: string): {
	eventId: string;
	status: 'completed' | 'error' | 'cancelled';
	recordedAt: number;
	result: {
		text?: string;
		error?: string;
		chars: number;
		truncated: boolean;
		digest: string;
	};
} | null {
	const envelope = parseTaskEnvelope(body);
	if (!envelope) return null;
	const isError = envelope.state !== 'completed';
	const text = isError
		? (envelope.errorText ?? '')
		: (envelope.resultText ?? '');
	const digest = createHash('sha256').update(text).digest('hex');
	return {
		eventId: buildBackgroundCompletionEventId({
			correlationId: 'ses_recovery_child',
			jobId: 'job-recovery',
			status: envelope.state,
			resultDigest: digest,
		}),
		status: envelope.state,
		recordedAt: Date.now(),
		result: {
			...(isError ? { error: text } : { text }),
			chars: envelope.resultChars ?? text.length,
			truncated: envelope.resultTruncated ?? false,
			digest,
		},
	};
}

/** Stub telemetry.delegationEnd, capturing emissions; restored in finally. */
function captureDelegationEnds(): {
	count: () => number;
	restore: () => void;
} {
	let emissions = 0;
	const orig = telemetry.delegationEnd;
	(telemetry as { delegationEnd: unknown }).delegationEnd = () => {
		emissions += 1;
	};
	return {
		count: () => emissions,
		restore: () => {
			(telemetry as { delegationEnd: unknown }).delegationEnd = orig;
		},
	};
}

describe('background completion observer — durable closeout recovery (r13 P0-3)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('bg-closeout-recovery-'));
		writePlan(directory);
		ensureAgentSession('ses_recovery_parent', 'architect', directory);
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('P0-3 special case: crash between terminal claim and the failure advisory — recovery delivers the message', async () => {
		await recordPending(directory, { agent: 'reviewer' });
		// Simulate the crash: the observer claimed the error terminal and
		// emitted delegation_end, then died BEFORE publishing the parent
		// advisory (the r12 duplicate early-return lost it forever).
		const errorBody = `<task id="ses_recovery_child" state="error">\n<task_error>provider blew up</task_error>\n</task>`;
		const terminal = manualTerminal(errorBody);
		expect(terminal).not.toBeNull();
		if (!terminal) return;
		const claim = await claimTerminalResult(
			directory,
			'ses_recovery_child',
			terminal,
		);
		expect(claim?.disposition).toBe('claimed');
		await initializeTerminalCloseout(
			directory,
			'ses_recovery_child',
			terminal.eventId,
			['delegation_end', 'parent_advisory'],
		);
		await markTerminalCloseoutStepCompleted(
			directory,
			'ses_recovery_child',
			terminal.eventId,
			'delegation_end',
		);
		// The crash point: parent_advisory still pending.

		// "Restart": a fresh observer receives the duplicate terminal.
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		const deliveredEvent = completionEvent(
			'ses_recovery_child',
			'error',
			'<task_error>provider blew up</task_error>',
		);
		await observer.event(deliveredEvent);

		const record = findByCorrelationId(directory, 'ses_recovery_child');
		expect(record?.advisoryInbox?.state).toBe('pending');
		expect(record?.advisoryInbox?.message).toContain('failed');
		expect(record?.closeout?.steps.parent_advisory?.state).toBe('completed');

		// A further replay changes nothing: no duplicate advisory.
		await observer.event(deliveredEvent);
		const after = findByCorrelationId(directory, 'ses_recovery_child');
		expect(after?.advisoryInbox?.eventId).toBe(record?.advisoryInbox?.eventId);
		expect(after?.closeout?.steps.parent_advisory?.state).toBe('completed');
	});

	test('P1-5: crash between the terminal claim and delegation_end — recovery emits the pairing end exactly once', async () => {
		await recordPending(directory, { agent: 'reviewer' });
		const body =
			'<task_result>[REVIEWED] | 1.1 | APPROVED | no issues</task_result>';
		const completedBody = `<task id="ses_recovery_child" state="completed">\n${body}\n</task>`;
		const terminal = manualTerminal(completedBody);
		expect(terminal).not.toBeNull();
		if (!terminal) return;
		const claim = await claimTerminalResult(
			directory,
			'ses_recovery_child',
			terminal,
		);
		expect(claim?.disposition).toBe('claimed');
		// Journal initialized, NOTHING acked yet (crash right after init).
		await initializeTerminalCloseout(
			directory,
			'ses_recovery_child',
			terminal.eventId,
			['delegation_end', 'parent_advisory', 'pipeline_advisory'],
		);

		const capture = captureDelegationEnds();
		try {
			const observer = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
			});
			await observer.event(
				completionEvent('ses_recovery_child', 'completed', body),
			);
			expect(capture.count()).toBe(1);
			// Replays (host duplicate + maintenance reconcile) never re-emit.
			await observer.event(
				completionEvent('ses_recovery_child', 'completed', body),
			);
			const record = findByCorrelationId(directory, 'ses_recovery_child');
			if (record) await observer.reconcilePending(record);
			expect(capture.count()).toBe(1);
			const after = findByCorrelationId(directory, 'ses_recovery_child');
			expect(after?.closeout?.steps.delegation_end?.state).toBe('completed');
		} finally {
			capture.restore();
		}
	});

	test('P1-2 recovery: crash after the ingestion commit but before the context-map write — recovery adds the missing summary', async () => {
		const parent = ensureAgentSession(
			'ses_recovery_parent',
			'architect',
			directory,
		);
		parent.taskWorkflowStates.set('1.1', 'coder_delegated');
		const generation = await seedStageAPassed(directory, '1.1');
		await recordPending(directory, {
			agent: 'reviewer',
			workflowGeneration: generation,
		});
		const body =
			'<task_result>[REVIEWED] | 1.1 | APPROVED | no issues</task_result>';

		const capture = captureDelegationEnds();
		try {
			// Crash injection: the observer's recordIngestionResult seam
			// performs the REAL durable commit and then throws — the process
			// died after the commit but before the context-map write.
			let crashed = false;
			const firstObserver = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
				contextMap: { enabled: true },
				recordIngestionResult: (async (
					dir: string,
					correlationId: string,
					claimToken: string,
					consumed: boolean,
				) => {
					const committed = await recordDelegationIngestionResult(
						dir,
						correlationId,
						claimToken,
						consumed,
					);
					if (committed && !crashed) {
						crashed = true;
						throw new Error('injected crash after ingestion commit');
					}
					return committed;
				}) as typeof recordDelegationIngestionResult,
			});
			const outcome = await firstObserver.event(
				completionEvent('ses_recovery_child', 'completed', body),
			);
			expect(outcome).toBeUndefined(); // the wrapper discards the inner result
			// The crash point is observable from its effects: the durable
			// ingestion commit succeeded, but the context-map summary was
			// never written.
			expect(loadContextMap(directory)?.task_history['1.1']).toBeUndefined();
			expect(capture.count()).toBe(1); // delegation_end already emitted

			// "Restart": a fresh observer with no injection replays the terminal.
			const secondObserver = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
				contextMap: { enabled: true },
			});
			await secondObserver.event(
				completionEvent('ses_recovery_child', 'completed', body),
			);

			const map = loadContextMap(directory);
			const summary = map?.task_history['1.1'];
			expect(summary).toBeDefined();
			// r14 (P1-5): the recovered summary is the child-level success —
			// NON-FINAL ('pending') until the authoritative task release; the
			// old 'approved' expectation was exactly the conflation this repair
			// removes (a reviewer approval alone is not a task release).
			expect(summary?.final_status).toBe('pending');
			// No double telemetry across the restart.
			expect(capture.count()).toBe(1);
			// The terminal advisory exists exactly once (single eventId slot).
			const record = findByCorrelationId(directory, 'ses_recovery_child');
			expect(record?.advisoryInbox?.state).toBe('pending');
			expect(record?.closeout?.steps.context_map?.state).toBe('completed');
		} finally {
			capture.restore();
		}
	});

	test('P2-2: sounding-board and pipeline advisories are durable without a live parent session, and never clobber the terminal advisory', async () => {
		// No parent session in memory — the advisories must survive on the
		// record's durable closeout advisory list.
		resetSwarmState();
		await recordPending(directory, { agent: 'critic_sounding_board' });
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(
			completionEvent(
				'ses_recovery_child',
				'completed',
				'<task_result>Verdict: APPROVED\nCategory: architecture\nReasoning: sound</task_result>',
			),
		);

		const record = findByCorrelationId(directory, 'ses_recovery_child');
		// The terminal advisory (single slot) AND the two closeout advisories
		// (sounding-board verdict + pipeline) coexist — no clobbering.
		expect(record?.advisoryInbox).toBeDefined();
		const closeoutAdvisories = record?.closeoutAdvisories ?? [];
		expect(closeoutAdvisories.length).toBe(2);
		const sounding = closeoutAdvisories.find((entry) =>
			entry.message.includes('[SOUNDING_BOARD]'),
		);
		const pipeline = closeoutAdvisories.find((entry) =>
			entry.message.includes('[PIPELINE]'),
		);
		expect(sounding?.message).toContain('Verdict: APPROVED');
		expect(pipeline).toBeDefined();

		// The delivery contract drains them: prepare surfaces one pending
		// durable advisory for the parent, and a replayed completion does not
		// duplicate the stored entries (eventId-deduped).
		const prepared = await preparePendingBackgroundAdvisories(
			directory,
			'ses_recovery_parent',
			{ preparationId: 'prep-1' },
		);
		expect(prepared.length).toBe(1);
		await observer.event(
			completionEvent(
				'ses_recovery_child',
				'completed',
				'<task_result>Verdict: APPROVED\nCategory: architecture\nReasoning: sound</task_result>',
			),
		);
		const afterReplay = findByCorrelationId(directory, 'ses_recovery_child');
		expect((afterReplay?.closeoutAdvisories ?? []).length).toBe(2);
	});

	test('P2-2: putTerminalCloseoutAdvisory dedupes by eventId (idempotent replay)', async () => {
		await recordPending(directory, { agent: 'reviewer' });
		// Establish the trusted terminal first — closeout advisories belong to
		// a terminal, never to an open record.
		const terminal = manualTerminal(
			'<task id="ses_recovery_child" state="completed">\n<task_result>done</task_result>\n</task>',
		);
		expect(terminal).not.toBeNull();
		if (terminal) {
			await claimTerminalResult(directory, 'ses_recovery_child', terminal);
		}
		const first = await putTerminalCloseoutAdvisory(
			directory,
			'ses_recovery_child',
			{
				eventId: 'evt-1:pipeline',
				parentSessionId: 'ses_recovery_parent',
				message: '[PIPELINE] reviewer delegation complete.',
			},
		);
		expect(first).not.toBeNull();
		const second = await putTerminalCloseoutAdvisory(
			directory,
			'ses_recovery_child',
			{
				eventId: 'evt-1:pipeline',
				parentSessionId: 'ses_recovery_parent',
				message: '[PIPELINE] reviewer delegation complete.',
			},
		);
		expect(second?.eventId).toBe(first?.eventId);
		const record = findByCorrelationId(directory, 'ses_recovery_child');
		expect(record?.closeoutAdvisories?.length).toBe(1);
	});

	test('recovery does not re-run a completed closeout step (journal fence)', async () => {
		await recordPending(directory, { agent: 'reviewer' });
		const terminal = manualTerminal(
			'<task id="ses_recovery_child" state="completed">\n<task_result>done</task_result>\n</task>',
		);
		expect(terminal).not.toBeNull();
		if (!terminal) return;
		await claimTerminalResult(directory, 'ses_recovery_child', terminal);
		await initializeTerminalCloseout(
			directory,
			'ses_recovery_child',
			terminal.eventId,
			['delegation_end', 'parent_advisory'],
		);
		await markTerminalCloseoutStepCompleted(
			directory,
			'ses_recovery_child',
			terminal.eventId,
			'delegation_end',
		);
		const record = findByCorrelationId(directory, 'ses_recovery_child');
		expect(record).not.toBeNull();
		if (record) {
			// The completed step is not pending; the unacked one is.
			expect(
				isTerminalCloseoutStepPending(
					record,
					terminal.eventId,
					'delegation_end',
				),
			).toBe(false);
			expect(
				isTerminalCloseoutStepPending(
					record,
					terminal.eventId,
					'parent_advisory',
				),
			).toBe(true);
			// A FOREIGN terminal event id never satisfies the fence.
			expect(
				isTerminalCloseoutStepPending(record, 'evt-foreign', 'delegation_end'),
			).toBe(true);
		}
	});
});
