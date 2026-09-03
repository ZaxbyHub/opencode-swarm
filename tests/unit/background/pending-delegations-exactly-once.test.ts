/**
 * Issue #2034 — exactly-once semantics across a compaction boundary: duplicate
 * starts, terminal replays, settlement resumes, advisory delivery, ingestion
 * claims, and closed-correlation eviction must never double-deliver or
 * resurrect completed work. Also guards requirement 9: no circuit/retry state
 * is ever serialized.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	acknowledgeObservedBackgroundAdvisories,
	BACKGROUND_DELEGATIONS_CHECKPOINT_FILE,
	type BackgroundTerminalResult,
	buildBackgroundCompletionEventId,
	claimCoderSettlement,
	claimDelegationIngestion,
	claimTerminalResult,
	compactBackgroundDelegations,
	preparePendingBackgroundAdvisories,
	putPendingBackgroundAdvisory,
	type RecordPendingInput,
	recordDelegationIngestionResult,
	recordPendingDelegationDetailed,
	releasePreparedBackgroundAdvisories,
	scanDelegationsForRecovery,
	updateCoderSettlement,
} from '../../../src/background/pending-delegations';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const { dir, cleanup } = createSafeTestDir('swarm-bg-xonce-');
afterEach(cleanup);
beforeEach(() => {
	fs.rmSync(path.join(dir, '.swarm'), { recursive: true, force: true });
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

let counter = 0;
function pendingInput(agent = 'reviewer'): RecordPendingInput {
	counter += 1;
	const correlationId = `sess_${counter}`;
	return {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: 'sess_parent',
		callID: `call_${counter}`,
		normalizedAgent: agent,
		swarmPrefixedAgent: agent,
		planTaskId: null,
		evidenceTaskId: null,
	};
}

function terminalFor(
	correlationId: string,
	text: string,
): BackgroundTerminalResult {
	return {
		eventId: buildBackgroundCompletionEventId({
			correlationId,
			jobId: null,
			status: 'completed',
			resultDigest: text,
		}),
		status: 'completed',
		recordedAt: 42,
		result: { text, chars: text.length, truncated: false, digest: text },
	};
}

/** Drive a full non-coder lifecycle: pending → terminal → advisory delivered. */
async function dispatchAndComplete(
	agent = 'reviewer',
): Promise<{ correlationId: string; terminal: BackgroundTerminalResult }> {
	const input = pendingInput(agent);
	const outcome = await recordPendingDelegationDetailed(dir, input);
	expect(outcome.status).toBe('recorded');
	const terminal = terminalFor(input.correlationId, 'done output');
	const claim = await claimTerminalResult(dir, input.correlationId, terminal);
	expect(claim?.disposition).toBe('claimed');
	return { correlationId: input.correlationId, terminal };
}

describe('issue #2034 exactly-once across compaction', () => {
	it('duplicate start after compaction is duplicate/conflict, never recorded', async () => {
		const input = pendingInput();
		const first = await recordPendingDelegationDetailed(dir, input);
		expect(first.status).toBe('recorded');
		await compactBackgroundDelegations(dir, { force: true });

		const replay = await recordPendingDelegationDetailed(dir, input);
		expect(replay.status).toBe('duplicate');
		const conflicting = await recordPendingDelegationDetailed(dir, {
			...input,
			planTaskId: 'task_other',
		});
		expect(conflicting.status).toBe('conflict');
	});

	it('host replay of a completed-and-compacted session is duplicate, not conflict (summary-aware identity)', async () => {
		// A completed record becomes a closed summary (prompt/taskChangeContext
		// bodies dropped). Replaying the identical dispatch — WITH the original
		// prompt body — must still be a duplicate: a `conflict` here would send
		// the delegation gate down the fallback-owner path on every
		// post-restart replay.
		const input = pendingInput();
		const prompt = {
			text: 'original dispatch prompt',
			chars: 24,
			truncated: false,
			digest: 'p'.repeat(64),
		};
		await recordPendingDelegationDetailed(dir, { ...input, prompt });
		const terminal = terminalFor(input.correlationId, 'summary replay body');
		await claimTerminalResult(dir, input.correlationId, terminal);
		const compact = await compactBackgroundDelegations(dir, { force: true });
		expect(compact.status).toBe('compacted');
		const checkpoint = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_CHECKPOINT_FILE),
				'utf-8',
			),
		) as { closed: Array<{ correlationId: string; prompt?: unknown }> };
		const summary = checkpoint.closed.find(
			(entry) => entry.correlationId === input.correlationId,
		);
		expect(summary).toBeDefined();
		expect(summary!.prompt).toBeUndefined();

		const replay = await recordPendingDelegationDetailed(dir, {
			...input,
			prompt,
		});
		expect(replay.status).toBe('duplicate');

		// A live (non-summary) record dispatched without a prompt that is
		// re-dispatched WITH one is still a genuine conflict.
		const liveInput = pendingInput();
		await recordPendingDelegationDetailed(dir, liveInput);
		const prompted = await recordPendingDelegationDetailed(dir, {
			...liveInput,
			prompt,
		});
		expect(prompted.status).toBe('conflict');
	});

	it('terminal replay after compaction returns duplicate with the original event', async () => {
		const { correlationId, terminal } = await dispatchAndComplete();
		await compactBackgroundDelegations(dir, { force: true });

		const replay = await claimTerminalResult(dir, correlationId, terminal);
		expect(replay?.disposition).toBe('duplicate');
		expect(replay?.record.terminalResult?.eventId).toBe(terminal.eventId);

		const different = await claimTerminalResult(dir, correlationId, {
			...terminal,
			eventId: 'bgc1:' + 'f'.repeat(64),
		});
		expect(different).toBeNull();
	});

	it('advisory prepare/ack across compaction delivers at most once', async () => {
		const { correlationId, terminal } = await dispatchAndComplete();
		const advisory = await putPendingBackgroundAdvisory(dir, correlationId, {
			eventId: terminal.eventId,
			parentSessionId: 'sess_parent',
			message: 'advisory message one',
		});
		expect(advisory?.state).toBe('pending');
		await compactBackgroundDelegations(dir, { force: true });

		const prepared = await preparePendingBackgroundAdvisories(
			dir,
			'sess_parent',
			{ preparationId: 'prep-1' },
		);
		expect(prepared).toHaveLength(1);

		// A second prepare while leased yields nothing (no double delivery).
		const reprepared = await preparePendingBackgroundAdvisories(
			dir,
			'sess_parent',
			{ preparationId: 'prep-2' },
		);
		expect(reprepared).toHaveLength(0);

		const released = await releasePreparedBackgroundAdvisories(
			dir,
			'sess_parent',
			'prep-1',
			[terminal.eventId],
		);
		expect(released).toBe(true);

		const again = await preparePendingBackgroundAdvisories(dir, 'sess_parent', {
			preparationId: 'prep-3',
		});
		expect(again).toHaveLength(1);
		const acked = await acknowledgeObservedBackgroundAdvisories(
			dir,
			'sess_parent',
			['host history contains advisory message one'],
		);
		expect(acked).toBe(1);
		// Re-ack observes nothing new.
		const reacked = await acknowledgeObservedBackgroundAdvisories(
			dir,
			'sess_parent',
			['host history contains advisory message one'],
		);
		expect(reacked).toBe(0);
	});

	it('expired advisory preparation lease is reclaimable exactly once (timeout racing delivery)', async () => {
		const { correlationId, terminal } = await dispatchAndComplete();
		await putPendingBackgroundAdvisory(dir, correlationId, {
			eventId: terminal.eventId,
			parentSessionId: 'sess_parent',
			message: 'lease expiry message',
		});
		const t0 = 1_000_000;
		const first = await preparePendingBackgroundAdvisories(dir, 'sess_parent', {
			preparationId: 'prep-a',
			now: t0,
			leaseMs: 1_000,
		});
		expect(first).toHaveLength(1);

		// While the lease is live, a different preparer gets nothing.
		const busy = await preparePendingBackgroundAdvisories(dir, 'sess_parent', {
			preparationId: 'prep-b',
			now: t0 + 500,
		});
		expect(busy).toHaveLength(0);

		// After expiry, prep-b reclaims the single pending advisory — once.
		const reclaimed = await preparePendingBackgroundAdvisories(
			dir,
			'sess_parent',
			{ preparationId: 'prep-b', now: t0 + 2_000 },
		);
		expect(reclaimed).toHaveLength(1);
		expect(reclaimed[0]!.preparation?.id).toBe('prep-b');
		// Delivery by the ORIGINAL preparer (racing timeout) cannot commit: its
		// lease is gone, so acknowledging still sees one pending entry, and only
		// a fresh prepare→ack cycle delivers it.
		const staleRelease = await releasePreparedBackgroundAdvisories(
			dir,
			'sess_parent',
			'prep-a',
			[terminal.eventId],
		);
		expect(staleRelease).toBe(false);
		const delivered = await acknowledgeObservedBackgroundAdvisories(
			dir,
			'sess_parent',
			['host history contains lease expiry message'],
		);
		expect(delivered).toBe(1);
	});

	it('ingestion claim across compaction: consumed stays consumed', async () => {
		const { correlationId, terminal } = await dispatchAndComplete();
		const claim = await claimDelegationIngestion(dir, correlationId, {
			claimantId: 'claimant-1',
		});
		expect(claim?.disposition).toBe('claimed');
		const committed = await recordDelegationIngestionResult(
			dir,
			correlationId,
			claim!.record.ingestion!.claimToken,
			true,
		);
		expect(committed?.status).toBe('consumed');
		await compactBackgroundDelegations(dir, { force: true });

		// Replay of the same commit is idempotent; new claims get consumed.
		const replay = await recordDelegationIngestionResult(
			dir,
			correlationId,
			claim!.record.ingestion!.claimToken,
			true,
		);
		expect(replay?.status).toBe('consumed');
		const recl = await claimDelegationIngestion(dir, correlationId, {
			claimantId: 'claimant-2',
		});
		expect(recl?.disposition).toBe('consumed');
		void terminal;
	});

	it('coder settlement resume across compaction keeps the original operationId', async () => {
		const input = pendingInput('coder');
		await recordPendingDelegationDetailed(dir, {
			...input,
			taskChangeContext: {
				declaredFiles: ['src/a.ts'],
				baseline: {
					directory: dir,
					gitHead: null,
					dirtyHash: null,
					changedFiles: null,
					prHeadSha: null,
					scope: null,
				},
			},
		});
		const terminal = terminalFor(input.correlationId, 'coder output');
		await claimTerminalResult(dir, input.correlationId, terminal);
		const claim1 = await claimCoderSettlement(dir, input.correlationId, 'op-1');
		expect(claim1?.disposition).toBe('claimed');
		await compactBackgroundDelegations(dir, { force: true });

		// A different operation cannot steal the settlement after compaction.
		const foreign = await claimCoderSettlement(
			dir,
			input.correlationId,
			'op-2',
		);
		expect(foreign).toBeNull();
		// The original operation resumes.
		const resume = await claimCoderSettlement(dir, input.correlationId, 'op-1');
		expect(resume?.disposition).toBe('resume');

		const settled = await updateCoderSettlement(dir, input.correlationId, {
			operationId: 'op-1',
			state: 'settled',
			observedFiles: ['src/a.ts'],
			outcome: {
				kind: 'shared-root',
				result: 'merged',
			},
		});
		expect(settled?.coderSettlement?.state).toBe('settled');
		await compactBackgroundDelegations(dir, { force: true });

		// Re-computation attempts after compaction return the settled snapshot.
		const replay = await updateCoderSettlement(dir, input.correlationId, {
			operationId: 'op-1',
			state: 'settled',
			observedFiles: ['src/b.ts'],
			outcome: { kind: 'shared-root', result: 'merged' },
		});
		expect(replay?.coderSettlement?.observedFiles).toEqual(['src/a.ts']);
	});

	it('cancel-vs-success ordering survives compaction (first terminal wins)', async () => {
		const input = pendingInput();
		await recordPendingDelegationDetailed(dir, input);
		const success = terminalFor(input.correlationId, 'success body');
		const cancelled: BackgroundTerminalResult = {
			...success,
			eventId: buildBackgroundCompletionEventId({
				correlationId: input.correlationId,
				jobId: null,
				status: 'cancelled',
				resultDigest: 'cancel',
			}),
			status: 'cancelled',
		};
		const first = await claimTerminalResult(dir, input.correlationId, success);
		expect(first?.disposition).toBe('claimed');
		const second = await claimTerminalResult(
			dir,
			input.correlationId,
			cancelled,
		);
		expect(second).toBeNull();
		await compactBackgroundDelegations(dir, { force: true });
		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			const record = scan.owners.find(
				(r) => r.correlationId === input.correlationId,
			);
			expect(record?.status).toBe('completed');
			expect(record?.terminalResult?.status).toBe('completed');
		}
	});

	it('a backdated recordedAt cannot freeze the fold baseline (monotonic updatedAt)', async () => {
		// #2034 review PRR-012: recordedAt is caller-supplied; without the
		// monotonic clamp, a backdated terminal would lose the update-time
		// merge against a checkpoint entry stamped later.
		const input = pendingInput();
		const first = await recordPendingDelegationDetailed(dir, input);
		expect(first.status).toBe('recorded');
		const baseline = first.record!.updatedAt;
		const backdated = terminalFor(input.correlationId, 'backdated body');
		const claim = await claimTerminalResult(dir, input.correlationId, {
			...backdated,
			recordedAt: baseline - 60_000,
		});
		expect(claim?.disposition).toBe('claimed');
		// updatedAt is clamped to the record's baseline, not the backdate.
		expect(claim!.record.updatedAt).toBeGreaterThanOrEqual(baseline);

		await compactBackgroundDelegations(dir, { force: true });
		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			const record = scan.owners.find(
				(r) => r.correlationId === input.correlationId,
			);
			expect(record?.status).toBe('completed');
			expect(record?.updatedAt).toBeGreaterThanOrEqual(baseline);
		}
	});

	it('requirement 9: no circuit-breaker or transient-retry state is serialized', async () => {
		await dispatchAndComplete();
		await compactBackgroundDelegations(dir, { force: true });
		const checkpointRaw = fs.readFileSync(
			path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_CHECKPOINT_FILE),
			'utf-8',
		);
		expect(checkpointRaw).not.toContain('nonTransientCircuit');
		expect(checkpointRaw).not.toContain('transientRetry');
		expect(checkpointRaw).not.toContain('consecutiveErrors');
		expect(checkpointRaw).not.toContain('circuit');
	});
});
