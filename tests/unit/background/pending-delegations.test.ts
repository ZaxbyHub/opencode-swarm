/**
 * Issue #1151 PR 2 (Stage A) — durable pending-delegation store tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	appendDelegationTransition,
	BACKGROUND_DELEGATIONS_FILE,
	type BackgroundDelegationRecord,
	findByBatchId,
	findByCorrelationId,
	type RecordPendingInput,
	readDelegations,
	recordPendingDelegation,
	type SweepableDelegationStatus,
	sweepStaleDelegations,
} from '../../../src/background/pending-delegations';
import { freezeClock } from '../../helpers/test-clock.js';

function makeTempProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-bg-'));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
	return real;
}

function input(over: Partial<RecordPendingInput> = {}): RecordPendingInput {
	return {
		correlationId: 'ses_1',
		jobId: 'job_1',
		subagentSessionId: 'ses_1',
		parentSessionId: 'parent_1',
		callID: 'call_1',
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: '1.1',
		evidenceTaskId: '1.1',
		...over,
	};
}

describe('pending-delegations store', () => {
	let dir: string;
	let restoreClock: () => void = () => {};

	/**
	 * Append a record backdated 10 minutes so a 1-minute sweep timeout makes it
	 * reliably overdue without depending on real elapsed time.
	 */
	function seedBackdated(
		correlationId: string,
		status: BackgroundDelegationRecord['status'],
	): void {
		const tenMinAgo = Date.now() - 10 * 60_000;
		fs.appendFileSync(
			path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_FILE),
			`${JSON.stringify({
				...input({ correlationId, subagentSessionId: correlationId }),
				schemaVersion: 1,
				status,
				createdAt: tenMinAgo,
				updatedAt: tenMinAgo,
			})}\n`,
		);
	}

	beforeEach(() => {
		// Staleness here is a pure function of Date.now() minus updatedAt, and the
		// backdated fixtures below derive their timestamps from the same clock, so
		// freezing it makes every age margin exact (issue #1782).
		restoreClock = freezeClock();
		dir = makeTempProject();
	});
	afterEach(() => {
		restoreClock();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('records a pending delegation and reads it back', async () => {
		const rec = await recordPendingDelegation(dir, input());
		expect(rec).not.toBeNull();
		expect(rec?.status).toBe('pending');

		const all = readDelegations(dir);
		expect(all).toHaveLength(1);
		expect(all[0].correlationId).toBe('ses_1');
		expect(all[0].normalizedAgent).toBe('reviewer');

		// File is under .swarm/ with the expected name.
		expect(
			fs.existsSync(path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_FILE)),
		).toBe(true);
	});

	it('conditionally rejects a stale transition after a concurrent completion', async () => {
		await recordPendingDelegation(
			dir,
			input({ correlationId: 'ses_atomic', subagentSessionId: 'ses_atomic' }),
		);
		await appendDelegationTransition(dir, 'ses_atomic', {
			status: 'completed',
			result: {
				text: 'durable result',
				chars: 14,
				truncated: false,
				digest: 'digest',
			},
		});

		const guarded = await appendDelegationTransition(dir, 'ses_atomic', {
			status: 'stale',
			expectedCurrentStatuses: ['pending', 'running', 'ingestion_error'],
		});

		expect(guarded?.status).toBe('completed');
		expect(guarded?.result?.text).toBe('durable result');
		expect(findByCorrelationId(dir, 'ses_atomic')?.status).toBe('completed');
	});

	it('round-trips immutable coder task-change provenance', async () => {
		const baseline = {
			directory: dir,
			gitHead: 'abc123',
			dirtyHash: 'clean-hash',
			changedFiles: [],
			prHeadSha: null,
			scope: '1.1',
		};
		await recordPendingDelegation(
			dir,
			input({
				normalizedAgent: 'coder',
				swarmPrefixedAgent: 'coder',
				taskChangeContext: {
					declaredFiles: ['README.md'],
					baseline,
				},
			}),
		);

		const restored = readDelegations(dir)[0];
		expect(restored.taskChangeContext).toEqual({
			declaredFiles: ['README.md'],
			baseline,
		});
	});

	it('returns empty for a missing store (no throw)', () => {
		expect(readDelegations(dir)).toEqual([]);
		expect(findByCorrelationId(dir, 'nope')).toBeNull();
	});

	it('keeps the first pending snapshot authoritative for a correlationId', async () => {
		await recordPendingDelegation(
			dir,
			input({
				correlationId: 'ses_a',
				evidenceTaskId: '1.1',
				planTaskId: '1.1',
			}),
		);
		// Second snapshot for the same correlationId with a different task id.
		const duplicate = await recordPendingDelegation(
			dir,
			input({
				correlationId: 'ses_a',
				evidenceTaskId: '9.9',
				planTaskId: '9.9',
			}),
		);
		await recordPendingDelegation(dir, input({ correlationId: 'ses_b' }));

		const folded = readDelegations(dir);
		// Two distinct correlationIds; a duplicate pending launch cannot replace
		// the first durable owner.
		expect(folded).toHaveLength(2);
		expect(duplicate).toBeNull();
		expect(findByCorrelationId(dir, 'ses_a')?.evidenceTaskId).toBe('1.1');
	});

	it('sweeps overdue pendings to stale (deterministic via backdated record)', async () => {
		// Seed a backdated pending record directly so staleness does not depend on real
		// elapsed time (avoids flakiness on slow/loaded CI runners). updatedAt is 10 min
		// in the past; sweeping with a 1 min timeout makes it reliably overdue.
		const tenMinAgo = Date.now() - 10 * 60_000;
		const backdated = {
			schemaVersion: 1,
			correlationId: 'ses_stale',
			jobId: 'job_stale',
			subagentSessionId: 'ses_stale',
			parentSessionId: 'parent_1',
			callID: 'call_1',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			status: 'pending',
			createdAt: tenMinAgo,
			updatedAt: tenMinAgo,
		};
		fs.writeFileSync(
			path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_FILE),
			`${JSON.stringify(backdated)}\n`,
		);

		const swept = await sweepStaleDelegations(dir, 60_000);
		expect(swept).toBe(1);
		expect(findByCorrelationId(dir, 'ses_stale')?.status).toBe('stale');
	});

	it('findByCorrelationId returns the folded record', async () => {
		await recordPendingDelegation(dir, input({ correlationId: 'ses_find' }));
		const found = findByCorrelationId(dir, 'ses_find');
		expect(found?.correlationId).toBe('ses_find');
		expect(found?.status).toBe('pending');
	});

	it('skips malformed/partial lines without throwing', async () => {
		await recordPendingDelegation(dir, input({ correlationId: 'ses_ok' }));
		const file = path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_FILE);
		fs.appendFileSync(file, 'not json\n');
		fs.appendFileSync(file, '{"partial": \n');
		fs.appendFileSync(file, `${JSON.stringify({ bogus: true })}\n`);
		const all = readDelegations(dir);
		expect(all).toHaveLength(1);
		expect(all[0].correlationId).toBe('ses_ok');
	});

	it('the DEFAULT sweep scope still finalizes overdue ingestion_error records', async () => {
		// Pins the default for the lazy-maintenance caller
		// (`recordPendingDelegation`). The PR-workflow gate narrows this sweep to
		// pending/running; that narrowing must never leak into the default.
		seedBackdated('ses_ingest_err', 'ingestion_error');

		expect(await sweepStaleDelegations(dir, 60_000)).toBe(1);
		expect(findByCorrelationId(dir, 'ses_ingest_err')?.status).toBe('stale');
	});

	it('an explicitly narrowed sweep spares statuses outside the restriction', async () => {
		seedBackdated('ses_ingest_err', 'ingestion_error');
		seedBackdated('ses_pending', 'pending');
		const narrowed = new Set<SweepableDelegationStatus>(['pending', 'running']);

		expect(
			await sweepStaleDelegations(dir, 60_000, { statuses: narrowed }),
		).toBe(1);
		expect(findByCorrelationId(dir, 'ses_pending')?.status).toBe('stale');
		expect(findByCorrelationId(dir, 'ses_ingest_err')?.status).toBe(
			'ingestion_error',
		);
	});

	it('excludeCorrelationIds spares a named overdue record and sweeps the rest', async () => {
		// Issue #2251: status narrowing cannot express "this SPECIFIC overdue
		// record was verified alive". The PR-workflow gate's liveness probe makes
		// exactly that per-record decision, and this directory-wide sweep runs
		// immediately afterwards on the same store — without the exclusion it flips
		// the record the probe just spared, one line later.
		seedBackdated('ses_probed_alive', 'pending');
		seedBackdated('ses_really_stale', 'pending');

		expect(
			await sweepStaleDelegations(dir, 60_000, {
				excludeCorrelationIds: new Set(['ses_probed_alive']),
			}),
		).toBe(1);
		expect(findByCorrelationId(dir, 'ses_probed_alive')?.status).toBe(
			'pending',
		);
		expect(findByCorrelationId(dir, 'ses_really_stale')?.status).toBe('stale');
	});

	it('excludeCorrelationIds spares a named record regardless of its status', async () => {
		// The documented contract is "spared regardless of status or age". What this
		// pins is STATUS-INDEPENDENCE, not the source order of the two guards: both
		// the exclusion and the status filter are `continue` guards in the same loop,
		// so swapping them is semantically inert and no test can distinguish them.
		// The test above seeds only `pending`, so it cannot tell status-independent
		// exclusion from an exclusion that happens to work for one status.
		// `ingestion_error` can: it sits inside the DEFAULT sweepable set used here,
		// so an exclusion narrowed to `pending` would finalize it — and
		// `ingestion_error` is a RETRYABLE state, so flipping it to terminal `stale`
		// discards work the caller explicitly asked to keep.
		seedBackdated('ses_excluded_retryable', 'ingestion_error');
		seedBackdated('ses_excluded_pending', 'pending');
		seedBackdated('ses_really_stale', 'pending');

		expect(
			await sweepStaleDelegations(dir, 60_000, {
				excludeCorrelationIds: new Set([
					'ses_excluded_retryable',
					'ses_excluded_pending',
				]),
			}),
		).toBe(1);
		expect(findByCorrelationId(dir, 'ses_excluded_retryable')?.status).toBe(
			'ingestion_error',
		);
		expect(findByCorrelationId(dir, 'ses_excluded_pending')?.status).toBe(
			'pending',
		);
		// The un-excluded control: the sweep really did run and really was overdue,
		// so the two spares above are the exclusion at work, not a no-op sweep.
		expect(findByCorrelationId(dir, 'ses_really_stale')?.status).toBe('stale');
	});

	it('includeCorrelationIds narrows the sweep to exactly the named records', async () => {
		// Issue #2251: the human-only PR-workflow force override finalizes the
		// handful of lanes it just overrode. A directory-wide pass would also
		// finalize a neighbouring session's overdue records — and retryable
		// `ingestion_error` records — that no operator reasoned about.
		seedBackdated('ses_overridden', 'pending');
		seedBackdated('ses_someone_else', 'pending');
		seedBackdated('ses_other_retryable', 'ingestion_error');

		expect(
			await sweepStaleDelegations(dir, 60_000, {
				statuses: new Set<SweepableDelegationStatus>(['pending', 'running']),
				includeCorrelationIds: new Set(['ses_overridden']),
			}),
		).toBe(1);
		expect(findByCorrelationId(dir, 'ses_overridden')?.status).toBe('stale');
		expect(findByCorrelationId(dir, 'ses_someone_else')?.status).toBe(
			'pending',
		);
		expect(findByCorrelationId(dir, 'ses_other_retryable')?.status).toBe(
			'ingestion_error',
		);
	});

	it('includeCorrelationIds does not force a named record that already went terminal', async () => {
		// The race guard. A lane the caller decided to finalize is alive BY
		// HYPOTHESIS, so it can complete between that decision and this call.
		// Narrowing to a correlationId must not bypass the status filter:
		// `completed` -> `stale` would make the collector skip a record whose output
		// exists, which is the very discard issue #2251 exists to prevent.
		seedBackdated('ses_raced_done', 'completed');

		expect(
			await sweepStaleDelegations(dir, 60_000, {
				statuses: new Set<SweepableDelegationStatus>(['pending', 'running']),
				includeCorrelationIds: new Set(['ses_raced_done']),
			}),
		).toBe(0);
		expect(findByCorrelationId(dir, 'ses_raced_done')?.status).toBe(
			'completed',
		);
	});

	it('omitting excludeCorrelationIds preserves the historical sweep scope', async () => {
		// The default must stay byte-identical for the lazy-maintenance caller in
		// `recordPendingDelegation`, which passes no options at all.
		seedBackdated('ses_a', 'pending');
		seedBackdated('ses_b', 'pending');

		expect(await sweepStaleDelegations(dir, 60_000)).toBe(2);
	});

	it('sweep marks only overdue pendings stale (fresh ones survive)', async () => {
		await recordPendingDelegation(dir, input({ correlationId: 'ses_old' }));
		// Large timeout → nothing overdue.
		const swept = await sweepStaleDelegations(dir, 10 * 60_000);
		expect(swept).toBe(0);
		expect(findByCorrelationId(dir, 'ses_old')?.status).toBe('pending');
	});

	it('handles concurrent pending appends under lock', async () => {
		await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				recordPendingDelegation(dir, input({ correlationId: `ses_${i}` })),
			),
		);
		const all = readDelegations(dir);
		expect(all).toHaveLength(8);
		const ids = new Set(all.map((r) => r.correlationId));
		expect(ids.size).toBe(8);
	});

	it('records async lane metadata and finds records by batch id', async () => {
		await recordPendingDelegation(
			dir,
			input({
				correlationId: 'ses_async',
				batchId: 'batch-1',
				laneId: 'security',
				mode: 'deep-dive',
				promptHash: 'hash-1',
				workspace: {
					directory: dir,
					gitHead: null,
					dirtyHash: null,
					prHeadSha: 'abc123',
					scope: 'src/security.ts',
				},
				generation: 1,
			}),
		);

		const records = findByBatchId(dir, 'batch-1');
		expect(records).toHaveLength(1);
		expect(records[0].schemaVersion).toBe(2);
		expect(records[0].laneId).toBe('security');
		expect(records[0].workspace?.prHeadSha).toBe('abc123');
	});

	it('appends terminal completion exactly once', async () => {
		await recordPendingDelegation(dir, input({ correlationId: 'ses_done' }));
		const first = await appendDelegationTransition(dir, 'ses_done', {
			status: 'completed',
			result: {
				text: 'done',
				chars: 4,
				truncated: false,
				digest: 'digest-1',
			},
		});
		const second = await appendDelegationTransition(dir, 'ses_done', {
			status: 'error',
			result: {
				error: 'late',
				chars: 4,
				truncated: false,
				digest: 'digest-2',
			},
		});

		expect(first?.status).toBe('completed');
		expect(second?.status).toBe('completed');
		expect(findByCorrelationId(dir, 'ses_done')?.result?.text).toBe('done');
	});

	it('round-trips salvagedWorkflowLanes instead of dropping the whole record', async () => {
		// ResultSchema is .strict() and readDelegations safeParse-skips records it
		// rejects, while appendRecord writes without validating. An undeclared
		// result field is therefore written to disk and then silently invisible to
		// every reader — which would make a successfully salvaged PR-review lane
		// look like one that never reached a terminal state.
		await recordPendingDelegation(
			dir,
			input({ correlationId: 'ses_salvaged' }),
		);
		await appendDelegationTransition(dir, 'ses_salvaged', {
			status: 'completed',
			result: {
				text: 'salvaged output',
				chars: 15,
				truncated: false,
				digest: 'd'.repeat(64),
				workflowLaneFailureClass: 'contract',
				salvagedWorkflowLanes: ['correctness-state'],
				salvagedWorkflowLaneRecoveries: [
					{
						workflowLane: 'correctness-state',
						kind: 'parser-normalization',
						reason: 'structural repairs applied: synthesized-header',
					},
				],
			},
		});

		const record = findByCorrelationId(dir, 'ses_salvaged');
		expect(record?.status).toBe('completed');
		expect(record?.result?.salvagedWorkflowLanes).toEqual([
			'correctness-state',
		]);
		expect(record?.result?.workflowLaneFailureClass).toBe('contract');
		expect(record?.result?.salvagedWorkflowLaneRecoveries).toEqual([
			{
				workflowLane: 'correctness-state',
				kind: 'parser-normalization',
				reason: 'structural repairs applied: synthesized-header',
			},
		]);
	});
});
