/**
 * Layer 23 — the durable terminal-result INGESTION as its own recoverable
 * closeout step (`ingestion_commit`).
 *
 * Motivating incident (consumer project, 2026-11-27 evening, task 3.8): a
 * coder round whose trusted terminal was claimed and settled, but whose
 * ingestion apply/commit failed once, sat in `ingestion_error` with every
 * journaled closeout step completed — no pending step, so the r13 re-drive
 * machinery never fired — until the stale sweep flipped the record and
 * OVERWROTE the trusted terminal (claimDelegationIngestion then refuses
 * `not_ready` forever). The round's result was stranded with a pending
 * advisory and no in-band completion; the settlement WAL window blocked
 * re-dispatches; the only exit was out-of-band salvage plus a human
 * /swarm recover.
 *
 * These tests pin the three repair surfaces:
 * 1. the ingestion-claim set gets `ingestion_commit` as a required closeout
 *    step, acked ONLY on the durable consumed commit (success or a
 *    terminal-negative outcome) — every failure arm leaves it pending;
 * 2. the stale sweep never flips a record whose ingestion is live or
 *    recoverable (claimed/retryable), preserving the trusted terminal;
 * 3. legacy journals (initialized before the step existed) are upserted on
 *    replay, and such records stay in the recovery set until consumed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	type BackgroundDelegationRecord,
	buildBackgroundCompletionEventId,
	claimCoderSettlement,
	claimDelegationIngestion,
	claimTerminalResult,
	findByCorrelationId,
	hasPendingTerminalCloseout,
	initializeTerminalCloseout,
	markTerminalCloseoutStepCompleted,
	recordDelegationIngestionResult,
	recordPendingDelegation,
	sweepStaleDelegations,
	updateCoderSettlement,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		encoding: 'utf8',
		timeout: 20_000,
		maxBuffer: 128 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(
			result.stderr || result.stdout || `git exited ${result.status}`,
		);
	}
}

function completedEvent(correlationId: string, parentSessionId = 'parent') {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: parentSessionId,
					text:
						`<task id="${correlationId}" state="completed">\n` +
						'<task_result>coder finished</task_result>\n</task>',
				},
			},
		},
	};
}

/** Byte-identical to the terminal the observer claims from completedEvent. */
function completedTerminal(correlationId: string) {
	const text = 'coder finished';
	const digest = createHash('sha256').update(text).digest('hex');
	return {
		eventId: buildBackgroundCompletionEventId({
			correlationId,
			jobId: null,
			status: 'completed',
			resultDigest: digest,
		}),
		status: 'completed' as const,
		recordedAt: Date.now(),
		result: { text, chars: text.length, truncated: false, digest },
	};
}

interface SeededCoder {
	directory: string;
	correlationId: string;
	taskId: string;
}

async function seedCoderRecord(
	directory: string,
	correlationId: string,
	taskId: string,
): Promise<SeededCoder> {
	const session = ensureAgentSession('parent', 'architect');
	session.currentTaskId = taskId;
	session.lastCoderDelegationTaskId = taskId;
	const baseline = captureWorkspaceSnapshot(directory);
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: 'parent',
		callID: `call-${correlationId}`,
		normalizedAgent: 'coder',
		swarmPrefixedAgent: 'coder',
		planTaskId: taskId,
		evidenceTaskId: taskId,
		workspace: baseline,
		taskChangeContext: {
			declaredFiles: ['src/feature.ts'],
			baseline,
		},
	});
	fs.mkdirSync(path.join(directory, 'src'));
	fs.writeFileSync(
		path.join(directory, 'src', 'feature.ts'),
		'export const feature = true;\n',
	);
	return { directory, correlationId, taskId };
}

/**
 * The exact 3.8 evening intermediate state: trusted terminal claimed,
 * settlement settled, closeout journal present, the ingestion claimed once
 * and FAILED once (retryable). `journalSteps` models pre- or post-Layer-23
 * journals.
 */
async function seedFailedIngestionState(
	directory: string,
	correlationId: string,
	journalSteps: readonly (
		| 'delegation_end'
		| 'parent_advisory'
		| 'ingestion_commit'
	)[],
): Promise<void> {
	const terminal = completedTerminal(correlationId);
	const claim = await claimTerminalResult(directory, correlationId, terminal);
	expect(claim?.disposition).toBe('claimed');
	// claimDelegationIngestion refuses a coder record whose settlement is not
	// settled ('not_ready') — the live observer settles through settleCoder
	// before the ingestion claim, so seed the same durable settlement.
	await claimCoderSettlement(directory, correlationId, terminal.eventId);
	await updateCoderSettlement(directory, correlationId, {
		operationId: terminal.eventId,
		state: 'settled',
		observedFiles: ['src/feature.ts'],
		outcome: { kind: 'shared-root', result: 'ready' },
	});
	await initializeTerminalCloseout(
		directory,
		correlationId,
		terminal.eventId,
		journalSteps,
	);
	for (const step of journalSteps) {
		if (step === 'ingestion_commit') continue;
		await markTerminalCloseoutStepCompleted(
			directory,
			correlationId,
			terminal.eventId,
			step,
		);
	}
	const ingestion = await claimDelegationIngestion(directory, correlationId, {
		claimantId: terminal.eventId,
	});
	expect(ingestion?.disposition === 'claimed').toBe(true);
	const claimToken = ingestion?.record.ingestion?.claimToken;
	expect(claimToken).toBeTruthy();
	await recordDelegationIngestionResult(
		directory,
		correlationId,
		claimToken as string,
		false,
	);
}

describe('background delegation ingestion_commit closeout step (Layer 23)', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(() => {
		resetSwarmState();
		const safe = createSafeTestDir('swarm-bg-ingestion-commit-');
		directory = safe.dir;
		cleanup = safe.cleanup;
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		fs.writeFileSync(path.join(directory, 'base.txt'), 'base\n');
		git(directory, ['add', 'base.txt']);
		git(directory, ['commit', '-m', 'test: seed repository']);
		fs.appendFileSync(
			path.join(directory, '.git', 'info', 'exclude'),
			'\n.swarm/\n',
		);
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('fresh coder completion acks ingestion_commit exactly on the durable consumed commit', async () => {
		const seeded = await seedCoderRecord(directory, 'coder-fresh', '1.1');
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(completedEvent(seeded.correlationId));

		const record = findByCorrelationId(directory, seeded.correlationId);
		expect(record?.status).toBe('consumed');
		expect(record?.ingestion?.state).toBe('consumed');
		expect(record?.closeout?.steps.ingestion_commit?.state).toBe('completed');
		expect(record?.closeout?.steps.delegation_end?.state).toBe('completed');
		expect(record?.closeout?.steps.parent_advisory?.state).toBe('completed');
		expect(
			hasPendingTerminalCloseout(record as BackgroundDelegationRecord),
		).toBe(false);
	});

	test('failed ingestion keeps the step pending, keeps the record recoverable, and the stale sweep cannot flip it', async () => {
		const seeded = await seedCoderRecord(directory, 'coder-wedge', '1.1');
		await seedFailedIngestionState(directory, seeded.correlationId, [
			'delegation_end',
			'parent_advisory',
			'ingestion_commit',
		]);

		const wedged = findByCorrelationId(directory, seeded.correlationId);
		expect(wedged?.status).toBe('ingestion_error');
		expect(wedged?.ingestion?.state).toBe('retryable');
		expect(wedged?.terminalResult?.status).toBe('completed');
		expect(wedged?.closeout?.steps.ingestion_commit?.state).toBe('pending');
		// The pending step is exactly what keeps the r13 re-drive machinery
		// armed (previously: every step completed, no candidate, no recovery).
		expect(
			hasPendingTerminalCloseout(wedged as BackgroundDelegationRecord),
		).toBe(true);

		// The liveness sweep must not overwrite the trusted terminal of a
		// record whose ingestion is still recoverable.
		await new Promise((resolve) => setTimeout(resolve, 15));
		const swept = await sweepStaleDelegations(directory, 1);
		expect(swept).toBe(0);
		const afterSweep = findByCorrelationId(directory, seeded.correlationId);
		expect(afterSweep?.status).toBe('ingestion_error');
		expect(afterSweep?.terminalResult?.status).toBe('completed');
	});

	test('duplicate terminal delivery re-drives the failed ingestion to consumed and acks the step', async () => {
		const seeded = await seedCoderRecord(directory, 'coder-recover', '1.1');
		await seedFailedIngestionState(directory, seeded.correlationId, [
			'delegation_end',
			'parent_advisory',
			'ingestion_commit',
		]);

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(completedEvent(seeded.correlationId));

		const record = findByCorrelationId(directory, seeded.correlationId);
		expect(record?.status).toBe('consumed');
		expect(record?.ingestion?.state).toBe('consumed');
		expect(record?.closeout?.steps.ingestion_commit?.state).toBe('completed');
		expect(
			hasPendingTerminalCloseout(record as BackgroundDelegationRecord),
		).toBe(false);
	});

	test('legacy pre-Layer-23 journal is upserted and the record stays a recovery candidate until consumed', async () => {
		const seeded = await seedCoderRecord(directory, 'coder-legacy', '1.1');
		await seedFailedIngestionState(directory, seeded.correlationId, [
			'delegation_end',
			'parent_advisory',
		]);

		// Legacy shape: every journaled step completed, ingestion retryable,
		// no ingestion_commit step — previously NOT a recovery candidate.
		const legacy = findByCorrelationId(directory, seeded.correlationId);
		expect(legacy?.closeout?.steps.ingestion_commit).toBeUndefined();
		expect(
			hasPendingTerminalCloseout(legacy as BackgroundDelegationRecord),
		).toBe(true);

		// The same-terminal journal upsert adds the missing required step as
		// pending while preserving the completed steps.
		const terminal = completedTerminal(seeded.correlationId);
		await initializeTerminalCloseout(
			directory,
			seeded.correlationId,
			terminal.eventId,
			['delegation_end', 'parent_advisory', 'ingestion_commit'],
		);
		const upserted = findByCorrelationId(directory, seeded.correlationId);
		expect(upserted?.closeout?.steps.ingestion_commit?.state).toBe('pending');
		expect(upserted?.closeout?.steps.delegation_end?.state).toBe('completed');
		expect(upserted?.closeout?.steps.parent_advisory?.state).toBe('completed');

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(completedEvent(seeded.correlationId));
		const record = findByCorrelationId(directory, seeded.correlationId);
		expect(record?.status).toBe('consumed');
		expect(record?.closeout?.steps.ingestion_commit?.state).toBe('completed');
	});

	test('crash between commit and ack — consumed-disposition replay acks the step without re-applying', async () => {
		const seeded = await seedCoderRecord(directory, 'coder-crash-ack', '1.1');
		const terminal = completedTerminal(seeded.correlationId);
		const claim = await claimTerminalResult(
			directory,
			seeded.correlationId,
			terminal,
		);
		expect(claim?.disposition).toBe('claimed');
		await claimCoderSettlement(
			directory,
			seeded.correlationId,
			terminal.eventId,
		);
		await updateCoderSettlement(directory, seeded.correlationId, {
			operationId: terminal.eventId,
			state: 'settled',
			observedFiles: ['src/feature.ts'],
			outcome: { kind: 'shared-root', result: 'ready' },
		});
		await initializeTerminalCloseout(
			directory,
			seeded.correlationId,
			terminal.eventId,
			['delegation_end', 'parent_advisory', 'ingestion_commit'],
		);
		await markTerminalCloseoutStepCompleted(
			directory,
			seeded.correlationId,
			terminal.eventId,
			'delegation_end',
		);
		await markTerminalCloseoutStepCompleted(
			directory,
			seeded.correlationId,
			terminal.eventId,
			'parent_advisory',
		);
		// The crash point: the ingestion committed durably (consumed) but the
		// step ack never ran.
		const ingestion = await claimDelegationIngestion(
			directory,
			seeded.correlationId,
			{ claimantId: terminal.eventId },
		);
		const claimToken = ingestion?.record.ingestion?.claimToken;
		await recordDelegationIngestionResult(
			directory,
			seeded.correlationId,
			claimToken as string,
			true,
		);
		const crashed = findByCorrelationId(directory, seeded.correlationId);
		expect(crashed?.status).toBe('consumed');
		expect(crashed?.closeout?.steps.ingestion_commit?.state).toBe('pending');
		expect(
			hasPendingTerminalCloseout(crashed as BackgroundDelegationRecord),
		).toBe(true);

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(completedEvent(seeded.correlationId));
		const record = findByCorrelationId(directory, seeded.correlationId);
		expect(record?.status).toBe('consumed');
		expect(record?.closeout?.steps.ingestion_commit?.state).toBe('completed');
		expect(
			hasPendingTerminalCloseout(record as BackgroundDelegationRecord),
		).toBe(false);
	});

	test('the stale sweep still flips records without a live/recoverable ingestion (guard is scoped)', async () => {
		// A pending record with no terminal and no ingestion claim is the
		// sweep's original purpose — it must still be swept.
		const session = ensureAgentSession('parent', 'architect');
		session.currentTaskId = '1.1';
		const baseline = captureWorkspaceSnapshot(directory);
		await recordPendingDelegation(directory, {
			correlationId: 'plain-pending',
			jobId: null,
			subagentSessionId: 'plain-pending',
			parentSessionId: 'parent',
			callID: 'call-plain',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			workspace: baseline,
		});
		await new Promise((resolve) => setTimeout(resolve, 15));
		const swept = await sweepStaleDelegations(directory, 1);
		expect(swept).toBe(1);
		expect(findByCorrelationId(directory, 'plain-pending')?.status).toBe(
			'stale',
		);
	});

	test('an authorized operator override sweep still terminalizes a recoverable ingestion (#2971 scoping)', async () => {
		const seeded = await seedCoderRecord(directory, 'coder-force', '1.1');
		await seedFailedIngestionState(directory, seeded.correlationId, [
			'delegation_end',
			'parent_advisory',
			'ingestion_commit',
		]);
		await new Promise((resolve) => setTimeout(resolve, 15));
		// The Layer 23 immunity belongs to the AUTOMATIC liveness sweep; an
		// authorized operator finalization (failureClass override, e.g.
		// /swarm abort-pr-workflow) may deliberately terminalize the record.
		const swept = await sweepStaleDelegations(directory, 1, {
			failureClass: 'operator_cancelled',
		});
		expect(swept).toBe(1);
		const record = findByCorrelationId(directory, seeded.correlationId);
		expect(record?.status).toBe('stale');
		expect(record?.result?.workflowLaneFailureClass).toBe('operator_cancelled');
	});

	test('hasPendingTerminalCloseout — pure predicate pinning (Layer 23 boundary cases)', () => {
		const base = {
			batchId: undefined,
			terminalResult: {
				eventId: 'evt-1',
				status: 'completed',
			},
			closeout: {
				terminalEventId: 'evt-1',
				steps: {
					delegation_end: { state: 'completed' },
					parent_advisory: { state: 'completed' },
				},
			},
		} as unknown as BackgroundDelegationRecord;
		// Legacy wedge shape: non-consumed ingestion, no step → candidate.
		expect(
			hasPendingTerminalCloseout({
				...base,
				ingestion: { state: 'retryable' },
			} as BackgroundDelegationRecord),
		).toBe(true);
		expect(
			hasPendingTerminalCloseout({
				...base,
				ingestion: { state: 'claimed' },
			} as BackgroundDelegationRecord),
		).toBe(true);
		// Consumed ingestion without the step → not a candidate.
		expect(
			hasPendingTerminalCloseout({
				...base,
				ingestion: { state: 'consumed' },
			} as BackgroundDelegationRecord),
		).toBe(false);
		// No ingestion field at all (outside the claim set) → not a candidate
		// via the Layer 23 arm.
		expect(hasPendingTerminalCloseout(base)).toBe(false);
		// Pending step on a completed terminal → candidate (progressable).
		expect(
			hasPendingTerminalCloseout({
				...base,
				ingestion: { state: 'retryable' },
				closeout: {
					terminalEventId: 'evt-1',
					steps: {
						delegation_end: { state: 'completed' },
						parent_advisory: { state: 'completed' },
						ingestion_commit: { state: 'pending' },
					},
				},
			} as BackgroundDelegationRecord),
		).toBe(true);
		// Flipped (non-completed) terminal: a pending ingestion_commit step
		// can never progress (claimDelegationIngestion refuses) and must not
		// keep the record in the recovery set forever.
		expect(
			hasPendingTerminalCloseout({
				...base,
				terminalResult: { eventId: 'evt-1', status: 'stale' },
				ingestion: { state: 'retryable' },
				closeout: {
					terminalEventId: 'evt-1',
					steps: {
						delegation_end: { state: 'completed' },
						parent_advisory: { state: 'completed' },
						ingestion_commit: { state: 'pending' },
					},
				},
			} as BackgroundDelegationRecord),
		).toBe(false);
		// Lane records settle elsewhere — never candidates.
		expect(
			hasPendingTerminalCloseout({
				...base,
				batchId: 'batch-1',
				ingestion: { state: 'retryable' },
			} as BackgroundDelegationRecord),
		).toBe(false);
	});
});
