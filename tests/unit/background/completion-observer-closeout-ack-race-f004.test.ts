/**
 * F-004 (PR #3922): the context_map closeout-ack race on negative ingestion
 * outcomes, exercised as a controlled same-terminal interleaving.
 *
 * A rejected / skipped / stale / unverifiable stage-B ingestion is durably
 * `consumed` with a terminal-negative outcome. The observer then acks the
 * context_map step as closed WITHOUT a lease token, and that pure ack is
 * refused while a live foreign worker holds the step's lease. These tests pin
 * the three facts that make the refusal harmless:
 *   1. the refused ack leaves the step pending and the foreign lease intact;
 *   2. no context-map success summary is written while that lease is held;
 *   3. after the lease is released and recovery replays the terminal, the
 *      step closes as completed and still no success summary exists.
 * Phase 3 is the discriminator: a mutant that falls through from the negative
 * arm into the success closeout would write a summary once the lease is free.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	claimTerminalCloseoutStep,
	findByCorrelationId,
	recordDelegationIngestionResult,
	recordPendingDelegation,
	releaseTerminalCloseoutStepLease,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import { loadContextMap } from '../../../src/context-map/persistence';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';

const PARENT = 'ses_f004_parent';
const LIVE_CHILD = 'ses_f004_live_child';
const REPLAY_CHILD = 'ses_f004_replay_child';
const LIVE_TASK = '1.9';
const REPLAY_TASK = '1.10';
const REJECTED_BODY = (taskId: string) =>
	`<task_result>[REVIEWED] | ${taskId} | REJECTED | broken logic</task_result>`;

/**
 * Explicit bound for both scenarios. Production runs finish in a few seconds;
 * the default five-second cap is too tight under load, and a mutant that
 * falls through must be observed FAILING on its assertion, not on a timeout.
 */
const SCENARIO_TIMEOUT_MS = 60_000;

type IngestionSeam = typeof recordDelegationIngestionResult;
type CloseoutClaim = Awaited<ReturnType<typeof claimTerminalCloseoutStep>>;

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

async function seedReviewer(
	directory: string,
	taskId: string,
	callID: string,
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
		callID,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: taskId,
		evidenceTaskId: taskId,
		workflowGeneration: generation,
		workspace: captureWorkspaceSnapshot(directory),
	});
}

function terminalEventIdOf(directory: string, childSessionId: string): string {
	const eventId = findByCorrelationId(directory, childSessionId)?.terminalResult
		?.eventId;
	if (!eventId) throw new Error('seed failed: no terminal event');
	return eventId;
}

/**
 * Real durable commit first, then `afterCommit` runs INSIDE the observer's
 * ingestion step — the same-terminal interleaving point between the negative
 * outcome becoming durable and the context_map ack that follows it.
 */
function commitThen(
	afterCommit: (directory: string, correlationId: string) => Promise<void>,
): IngestionSeam {
	return (async (dir, correlationId, claimToken, success, options) => {
		const committed = await recordDelegationIngestionResult(
			dir,
			correlationId,
			claimToken,
			success,
			options,
		);
		if (committed) await afterCommit(dir, correlationId);
		return committed;
	}) as IngestionSeam;
}

/** Crash directly after the durable negative commit, before any closeout. */
function crashAfterCommit(): IngestionSeam {
	return (async (dir, correlationId, claimToken, success, options) => {
		await recordDelegationIngestionResult(
			dir,
			correlationId,
			claimToken,
			success,
			options,
		);
		throw new Error('injected crash after durable ingestion commit');
	}) as IngestionSeam;
}

/**
 * Every claimed closeout step the observer attempts, in order. A negative
 * outcome must never reach a context_map claim: the arm returns before the
 * success closeout, so this list is the structural discriminator — it also
 * catches a fall-through into the success arm when a held lease refuses the
 * ack (the claim is then the first point the success effect could run).
 */
let observedClaimSteps: string[] = [];

function observer(directory: string, recordIngestionResult?: IngestionSeam) {
	return createBackgroundCompletionObserver({
		config: { enabled: true },
		directory,
		contextMap: { enabled: true },
		...(recordIngestionResult ? { recordIngestionResult } : {}),
		claimTerminalCloseoutStepImpl: (...args) => {
			observedClaimSteps.push(args[3]);
			return claimTerminalCloseoutStep(...args);
		},
	});
}

describe('background completion observer — F-004 context_map ack race on negative outcomes (PR #3922)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		observedClaimSteps = [];
		({ dir: directory, cleanup } = createSafeTestDir('bg-f004-ack-race-'));
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test(
		'live negative path: a refused tokenless context_map ack leaves the foreign lease held and writes no success summary',
		async () => {
			await seedReviewer(directory, LIVE_TASK, 'call-f004-live', LIVE_CHILD);
			let foreign: CloseoutClaim | undefined;

			// A foreign worker claims the SAME terminal's context_map lease in the
			// window between the durable negative commit and the observer's ack.
			await observer(
				directory,
				commitThen(async (dir, correlationId) => {
					foreign = await claimTerminalCloseoutStep(
						dir,
						correlationId,
						terminalEventIdOf(dir, correlationId),
						'context_map',
						{ claimantId: 'foreign-worker' },
					);
				}),
			).event(completionEvent(LIVE_CHILD, REJECTED_BODY(LIVE_TASK)));

			expect(foreign?.disposition).toBe('claimed');
			const token = foreign?.leaseToken;
			expect(typeof token).toBe('string');
			const eventId = terminalEventIdOf(directory, LIVE_CHILD);

			// The negative outcome is durable; the tokenless ack was refused, so the
			// step is still pending and the foreign lease is intact.
			const held = findByCorrelationId(directory, LIVE_CHILD);
			expect(held?.ingestion?.outcome).toBe('rejected');
			expect(held?.closeout?.steps.context_map?.state).toBe('pending');
			expect(held?.closeout?.steps.context_map?.leaseToken).toBe(token);
			expect(
				loadContextMap(directory)?.task_history[LIVE_TASK],
			).toBeUndefined();

			// Lease released; recovery replays the terminal. The negative arm must
			// close the step without ever writing a success summary.
			expect(
				await releaseTerminalCloseoutStepLease(
					directory,
					LIVE_CHILD,
					eventId,
					'context_map',
					token ?? 'none',
				),
			).toBe(true);
			await observer(directory).event(
				completionEvent(LIVE_CHILD, REJECTED_BODY(LIVE_TASK)),
			);

			const after = findByCorrelationId(directory, LIVE_CHILD);
			expect(after?.ingestion?.outcome).toBe('rejected');
			expect(after?.closeout?.steps.context_map?.state).toBe('completed');
			expect(
				loadContextMap(directory)?.task_history[LIVE_TASK],
			).toBeUndefined();
			// No observer attempt ever claimed the success context_map step.
			expect(observedClaimSteps).not.toContain('context_map');
		},
		SCENARIO_TIMEOUT_MS,
	);

	test(
		'replay negative path: a crash-restart replay under a held context_map lease writes no success summary',
		async () => {
			await seedReviewer(
				directory,
				REPLAY_TASK,
				'call-f004-replay',
				REPLAY_CHILD,
			);

			// Crash after the durable negative commit: context_map is still pending.
			await observer(directory, crashAfterCommit()).event(
				completionEvent(REPLAY_CHILD, REJECTED_BODY(REPLAY_TASK)),
			);
			const crashed = findByCorrelationId(directory, REPLAY_CHILD);
			expect(crashed?.ingestion?.outcome).toBe('rejected');
			expect(crashed?.closeout?.steps.context_map?.state).toBe('pending');
			const eventId = terminalEventIdOf(directory, REPLAY_CHILD);

			// A live foreign worker holds the same terminal's context_map lease
			// when the restarted observer replays the consumed negative outcome.
			const holder = await claimTerminalCloseoutStep(
				directory,
				REPLAY_CHILD,
				eventId,
				'context_map',
				{ claimantId: 'success-worker' },
			);
			expect(holder?.disposition).toBe('claimed');
			const token = holder?.leaseToken;

			await observer(directory).event(
				completionEvent(REPLAY_CHILD, REJECTED_BODY(REPLAY_TASK)),
			);

			const leased = findByCorrelationId(directory, REPLAY_CHILD);
			expect(leased?.closeout?.steps.parent_advisory?.state).toBe('completed');
			expect(leased?.advisoryInbox?.message).toContain('rejected');
			expect(leased?.closeout?.steps.context_map?.state).toBe('pending');
			expect(leased?.closeout?.steps.context_map?.leaseToken).toBe(token);
			expect(
				loadContextMap(directory)?.task_history[REPLAY_TASK],
			).toBeUndefined();
			expect(observedClaimSteps).not.toContain('context_map');

			// Lease released; a further recovery pass closes the step and still
			// produces no success summary for the negative outcome.
			expect(
				await releaseTerminalCloseoutStepLease(
					directory,
					REPLAY_CHILD,
					eventId,
					'context_map',
					token ?? 'none',
				),
			).toBe(true);
			await observer(directory).event(
				completionEvent(REPLAY_CHILD, REJECTED_BODY(REPLAY_TASK)),
			);

			const closed = findByCorrelationId(directory, REPLAY_CHILD);
			expect(closed?.ingestion?.outcome).toBe('rejected');
			expect(closed?.closeout?.steps.context_map?.state).toBe('completed');
			expect(
				loadContextMap(directory)?.task_history[REPLAY_TASK],
			).toBeUndefined();
			expect(observedClaimSteps).not.toContain('context_map');
		},
		SCENARIO_TIMEOUT_MS,
	);
});
