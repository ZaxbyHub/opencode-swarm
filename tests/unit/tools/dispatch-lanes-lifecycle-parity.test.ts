/**
 * Issue #2045 — the Task/lane lifecycle PARITY MATRIX.
 *
 * For every supported terminal outcome (completed, error, cancelled), a
 * Task-style settlement (the completion observer's direct
 * `claimTerminalResult` call) and a lane settlement
 * (`settleDelegationTerminal`) must leave IDENTICAL lifecycle facts on the
 * shared ledger: one terminal, same eventId identity scheme, same
 * duplicate-replay disposition, same conflicting-event rejection + audit, same
 * completedAt/status bookkeeping.
 *
 * Documented transport-only differences (asserted at the bottom):
 *   - `stale` is a status-only presumption written by the sweeps of both
 *     transports (never a claimed event).
 *   - `ingesting`/`consumed`/`coderSettlement`/`advisoryInbox` are Task-only
 *     post-terminal machinery; read-only lane roles never carry them.
 *   - Blocking lanes use the `blocking:${sessionId}` callID convention.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readDelegationHealthArtifact } from '../../../src/background/delegation-health.js';
import {
	buildDelegationTerminal,
	settleDelegationTerminal,
} from '../../../src/background/delegation-lifecycle.js';
import {
	type BackgroundDelegationRecord,
	buildBackgroundCompletionEventId,
	claimTerminalResult,
	findByCorrelationId,
	recordPendingDelegationDetailed,
} from '../../../src/background/pending-delegations.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const NOW = 1_750_000_000_000;

type Outcome = 'completed' | 'error' | 'cancelled';

const RESULTS: Record<Outcome, { text?: string; error?: string }> = {
	completed: { text: 'shared output' },
	error: { error: 'shared failure' },
	cancelled: {
		error: 'lane cancelled via collect_lane_results cancel_pending',
	},
};

function resultFor(outcome: Outcome) {
	const body = RESULTS[outcome];
	const text = body.text ?? body.error ?? '';
	return {
		...(body.text !== undefined ? { text: body.text } : {}),
		...(body.error !== undefined ? { error: body.error } : {}),
		chars: body.text?.length ?? 0,
		truncated: false,
		digest: createHash('sha256')
			.update(body.text ?? '')
			.digest('hex'),
	};
}

function recordInput(correlationId: string, asLane: boolean) {
	return {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: 'parity-parent',
		callID: asLane ? 'batch-parity' : `call-${correlationId}`,
		normalizedAgent: asLane ? 'sme' : 'coder',
		swarmPrefixedAgent: asLane ? 'mega_sme' : 'coder',
		planTaskId: null,
		evidenceTaskId: null,
		// Only the lane record carries batch identity — the Task record mirrors
		// what delegation-gate writes for a Task dispatch.
		...(asLane ? { batchId: 'batch-parity', laneId: 'lane-parity' } : {}),
	};
}

async function recordOutcome(
	directory: string,
	correlationId: string,
	asLane: boolean,
): Promise<BackgroundDelegationRecord> {
	const outcome = await recordPendingDelegationDetailed(
		directory,
		recordInput(correlationId, asLane),
	);
	expect(outcome.status).toBe('recorded');
	return outcome.record;
}

describe('Task/lane lifecycle parity matrix (issue #2045)', () => {
	let dir: string;
	let restoreClock: () => void;

	beforeEach(() => {
		dir = canonicalMkdtemp('lane-parity-');
		restoreClock = freezeClock({ fixedNow: NOW });
	});

	afterEach(() => {
		restoreClock();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	for (const outcome of ['completed', 'error', 'cancelled'] as const) {
		describe(`terminal outcome: ${outcome}`, () => {
			it('Task-style and lane settlements leave identical lifecycle facts', async () => {
				const taskRecord = await recordOutcome(dir, `task-${outcome}`, false);
				const laneRecord = await recordOutcome(dir, `lane-${outcome}`, true);

				// Task side: the completion observer's exact settlement call.
				const taskTerminal = buildDelegationTerminal(
					taskRecord,
					{ status: outcome, result: resultFor(outcome) },
					NOW,
				);
				const taskClaim = await claimTerminalResult(
					dir,
					taskRecord.correlationId,
					taskTerminal,
				);
				expect(taskClaim?.disposition).toBe('claimed');

				// Lane side: the shared settle operation.
				const laneOutcome = await settleDelegationTerminal(
					dir,
					laneRecord,
					{ status: outcome, result: resultFor(outcome) },
					{},
					NOW,
				);
				expect(laneOutcome.kind).toBe('claimed');

				const taskSettled = findByCorrelationId(dir, `task-${outcome}`);
				const laneSettled = findByCorrelationId(dir, `lane-${outcome}`);

				// THE PARITY FACTS — identical across transports.
				expect(laneSettled?.status).toBe(taskSettled?.status);
				expect(laneSettled?.status).toBe(outcome);
				expect(laneSettled?.terminalResult).toBeDefined();
				expect(taskSettled?.terminalResult).toBeDefined();
				expect(laneSettled?.terminalResult?.status).toBe(
					taskSettled?.terminalResult?.status,
				);
				expect(laneSettled?.terminalResult?.recordedAt).toBe(
					taskSettled?.terminalResult?.recordedAt,
				);
				expect(laneSettled?.terminalResult?.result.digest).toBe(
					taskSettled?.terminalResult?.result.digest,
				);
				// Same eventId derivation scheme from the same trusted inputs.
				expect(laneSettled?.terminalResult?.eventId).toBe(
					buildBackgroundCompletionEventId({
						correlationId: laneSettled!.correlationId,
						jobId: laneSettled!.jobId,
						status: outcome,
						resultDigest: resultFor(outcome).digest,
					}),
				);
				expect(laneSettled?.completedAt).toBe(taskSettled?.completedAt);

				// Duplicate replay of the same event: Task gets the durable
				// disposition; the lane settle maps it to its benign kind.
				const taskReplay = await claimTerminalResult(
					dir,
					taskRecord.correlationId,
					taskTerminal,
				);
				expect(taskReplay?.disposition).toBe('duplicate');
				const laneReplay = await settleDelegationTerminal(
					dir,
					laneRecord,
					{ status: outcome, result: resultFor(outcome) },
					{},
					NOW + 1_000,
				);
				expect(laneReplay.kind).toBe('duplicate');

				// Conflicting second event: rejected on both transports and
				// audited exactly once each.
				const conflicting =
					outcome === 'completed'
						? resultFor('cancelled')
						: resultFor('completed');
				const taskConflict = await claimTerminalResult(
					dir,
					taskRecord.correlationId,
					buildDelegationTerminal(
						taskRecord,
						{
							status: outcome === 'completed' ? 'cancelled' : 'completed',
							result: conflicting,
						},
						NOW + 2_000,
					),
				);
				expect(taskConflict).toBeNull();
				const laneConflict = await settleDelegationTerminal(
					dir,
					laneRecord,
					{
						status: outcome === 'completed' ? 'cancelled' : 'completed',
						result: conflicting,
					},
					{},
					NOW + 2_000,
				);
				expect(laneConflict.kind).toBe('conflict');
				// Both conflicts were audited (one tick per transport).
				expect(readDelegationHealthArtifact(dir)?.counts.lateTerminals).toBe(2);
				// First event wins verbatim on both.
				expect(findByCorrelationId(dir, `task-${outcome}`)?.status).toBe(
					outcome,
				);
				expect(findByCorrelationId(dir, `lane-${outcome}`)?.status).toBe(
					outcome,
				);
			});
		});
	}

	it('transport-only difference: post-terminal Task machinery never appears on lane records', async () => {
		const laneRecord = await recordOutcome(dir, 'lane-machinery', true);
		await settleDelegationTerminal(
			dir,
			laneRecord,
			{ status: 'completed', result: resultFor('completed') },
			{},
			NOW,
		);
		const settled = findByCorrelationId(dir, 'lane-machinery');
		// Read-only lane roles never enter coder settlement / ingestion /
		// advisory machinery — those are Task (coder) post-terminal paths.
		expect(settled?.coderSettlement).toBeUndefined();
		expect(settled?.ingestion).toBeUndefined();
		expect(settled?.advisoryInbox).toBeUndefined();
		expect(settled?.schemaVersion).toBeGreaterThanOrEqual(3);
	});

	it('transport-only difference: stale is a presumption, never a claimed event', async () => {
		for (const [correlationId, asLane] of [
			['task-stale', false],
			['lane-stale', true],
		] as const) {
			const record = await recordOutcome(dir, correlationId, asLane);
			// Both transports' sweeps write status-only `stale` (no event).
			const { appendDelegationTransition } = await import(
				'../../../src/background/pending-delegations.js'
			);
			await appendDelegationTransition(dir, record.correlationId, {
				status: 'stale',
			});
			const swept = findByCorrelationId(dir, correlationId);
			expect(swept?.status).toBe('stale');
			expect(swept?.terminalResult).toBeUndefined();
		}
	});
});

describe('Task production-path convergence (final-critic challenge)', () => {
	let dir: string;
	let restoreClock: () => void;

	beforeEach(() => {
		dir = canonicalMkdtemp('lane-parity-observer-');
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		restoreClock = freezeClock({ fixedNow: NOW });
	});

	afterEach(() => {
		restoreClock();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// PRR-008/009: drive the REAL completion observer for EVERY supported
	// outcome — error/cancelled derive their digest from the envelope's
	// <task_error> text (a different code path than completed's
	// <task_result>), so pinning only `completed` left that divergence unpinned.
	for (const outcome of ['completed', 'error', 'cancelled'] as const) {
		it(`the REAL completion observer settles a Task ${outcome} terminal through the same shared claim as a lane settle`, async () => {
			const { createBackgroundCompletionObserver } = await import(
				'../../../src/background/completion-observer.js'
			);
			const { createHash } = await import('node:crypto');
			// Task-side record shaped exactly as delegation-gate records it; the
			// observer resolves the owner from the task envelope's session id.
			const taskRecord = await recordOutcome(
				dir,
				`task-observer-${outcome}`,
				false,
			);
			const observer = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory: dir,
			});
			// Observer body text: <task_result> for completed, <task_error> for
			// error/cancelled (task-envelope.ts grammar).
			const bodyText =
				outcome === 'completed' ? 'shared output' : `shared ${outcome}`;
			const envelope =
				outcome === 'completed'
					? `<task id="${taskRecord.subagentSessionId}" state="completed">\n<task_result>${bodyText}</task_result>\n</task>`
					: `<task id="${taskRecord.subagentSessionId}" state="${outcome}">\n<task_error>${bodyText}</task_error>\n</task>`;
			await observer.event({
				event: {
					type: 'message.part.updated',
					properties: {
						part: {
							type: 'text',
							text: envelope,
							synthetic: true,
							sessionID: taskRecord.parentSessionId,
						},
					},
				},
			});

			const taskSettled = findByCorrelationId(dir, taskRecord.correlationId);
			expect(taskSettled?.status).toBe(outcome);
			expect(taskSettled?.terminalResult).toBeDefined();

			// Lane side through the shared settle wrapper, digest over the SAME
			// body text the observer derived from the envelope.
			const laneRecord = await recordOutcome(
				dir,
				`lane-observer-${outcome}`,
				true,
			);
			const laneDigest = createHash('sha256').update(bodyText).digest('hex');
			const laneResult = {
				...(outcome === 'completed' ? { text: bodyText } : { error: bodyText }),
				chars: bodyText.length,
				truncated: false,
				digest: laneDigest,
			};
			const laneOutcome = await settleDelegationTerminal(
				dir,
				laneRecord,
				{ status: outcome, result: laneResult },
				{},
				NOW,
			);
			expect(laneOutcome.kind).toBe('claimed');
			const laneSettled = findByCorrelationId(dir, laneRecord.correlationId);

			// THE CONVERGENCE FACTS — the production Task observer and the lane
			// settle leave identical terminal facts on the shared ledger, because
			// both derive their eventId from the same
			// buildBackgroundCompletionEventId over the same trusted inputs.
			expect(laneSettled?.status).toBe(taskSettled?.status);
			expect(laneSettled?.terminalResult?.status).toBe(
				taskSettled?.terminalResult?.status,
			);
			expect(laneSettled?.terminalResult?.eventId).toBe(
				buildBackgroundCompletionEventId({
					correlationId: laneSettled!.correlationId,
					jobId: laneSettled!.jobId,
					status: outcome,
					resultDigest: laneDigest,
				}),
			);
			expect(taskSettled?.terminalResult?.eventId).toBe(
				buildBackgroundCompletionEventId({
					correlationId: taskSettled!.correlationId,
					jobId: taskSettled!.jobId,
					status: outcome,
					resultDigest: laneDigest,
				}),
			);
			expect(laneSettled?.completedAt).toBeDefined();
			expect(taskSettled?.completedAt).toBeDefined();
		});
	}
});
