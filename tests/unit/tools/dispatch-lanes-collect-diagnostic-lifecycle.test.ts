import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
	appendDelegationTransition,
	findByCorrelationId,
} from '../../../src/background/pending-delegations';
import {
	_internals,
	_test_exports,
	executeCollectLaneResults,
} from '../../../src/tools/dispatch-lanes';
import { createCollectLaneTimeoutFixture } from './dispatch-lanes-collect-host-timeout.fixtures';

/**
 * Issue #2381: the LIFECYCLE of collection diagnostics.
 *
 * A lane the observer could not read must be left pending AND say why — silence
 * is the wedge class this issue closes. Equally, a diagnostic must describe
 * CURRENT state, not history: once a lane recovers or settles, its reason has to
 * be retired, or a successful collection ends up reporting "lane left pending"
 * beside `success: true`.
 *
 * Both diagnostic sets are keyed by MESSAGE with differently-shaped producers
 * (a bare lane label from `collectOnce`, full sentences from
 * `settleCollectedLane` and the transport-error sites), which is why clearing
 * matches on the quoted lane label rather than exact string equality.
 *
 * Split from `dispatch-lanes-collect-nondestructive-observer.test.ts` to stay
 * under the FR-006 500-line cap.
 */

const {
	assistantMessage,
	baseOps,
	cleanupTempDirs,
	makeTempDir,
	recordPending,
	restoreInternals,
} = createCollectLaneTimeoutFixture();

afterEach(async () => {
	restoreInternals();
	_test_exports.resetDeliveredLaneOutputs();
	await cleanupTempDirs();
});

const PR_WORKSPACE = (directory: string) => ({
	directory,
	gitHead: 'head-1',
	dirtyHash: null,
	prHeadSha: 'head-1',
	scope: 'complete PR diff base-1...head-1',
});

function laneState(directory: string, correlationId: string) {
	const record = findByCorrelationId(directory, correlationId);
	return { status: record?.status, result: record?.result };
}

describe('collection diagnostics report and then retire (#2381)', () => {
	test('a transcript-fetch TRANSPORT ERROR leaves the lane pending AND reports a diagnostic', async () => {
		// Issue #2381 required case 4, error half. The timeout half already routed
		// through `hostTimeouts`; the ERROR half recorded into a set whose only
		// reader was the deleted wait-deadline terminalizer, so it reported nothing
		// at all — a silent pending lane, the exact class this issue closes.
		const directory = makeTempDir();
		const batchId = 'observer-transport-error';
		await recordPending({
			directory,
			batchId,
			laneId: 'lane-a',
			correlationId: `${batchId}-lane-a`,
			mode: 'swarm-pr-review:base',
			workflowLane: 'correctness-state',
			workspace: PR_WORKSPACE(directory),
		});
		const before = laneState(directory, `${batchId}-lane-a`);

		const status = mock(async () => ({
			data: { [`${batchId}-lane-a`]: { type: 'idle' } },
			error: undefined,
		}));
		const messages = mock(async () => {
			throw new Error('ECONNRESET talking to the host');
		});
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false, include_pending: true },
			directory,
		);

		expect(result.pending).toBe(1);
		expect(result.failed).toBe(0);
		expect(
			result.errors?.some(
				(entry) =>
					entry.includes('transport error') && entry.includes('lane-a'),
			),
		).toBe(true);

		const after = laneState(directory, `${batchId}-lane-a`);
		expect(after.status).toBe('pending');
		expect(after.result).toEqual(before.result);
	});

	test('a messages error PAYLOAD with no transcript is reported rather than swallowed', async () => {
		const directory = makeTempDir();
		const batchId = 'observer-transport-error-payload';
		await recordPending({
			directory,
			batchId,
			laneId: 'lane-b',
			correlationId: `${batchId}-lane-b`,
		});

		const status = mock(async () => ({
			data: { [`${batchId}-lane-b`]: { type: 'idle' } },
			error: undefined,
		}));
		const messages = mock(async () => ({
			data: undefined,
			error: { message: 'host refused the transcript read' },
		}));
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false, include_pending: true },
			directory,
		);

		expect(result.pending).toBe(1);
		expect(result.failed).toBe(0);
		expect(result.errors?.some((entry) => entry.includes('lane-b'))).toBe(true);
		expect(laneState(directory, `${batchId}-lane-b`).status).toBe('pending');
	});

	test('a RECOVERED transport error does not leave a stale diagnostic on a completed collection', async () => {
		// Issue #2381, second staleness hole (same shape as the settleFailureLogs
		// one, through the other producer). `collectionResourceFailures` is keyed by
		// MESSAGE and was never retired, so a lane whose transcript fetch failed on
		// one poll and succeeded on the next still reported "lane left pending"
		// alongside completed:1 / pending:0 / success:true.
		const directory = makeTempDir();
		const batchId = 'observer-transport-recovery';
		await recordPending({
			directory,
			batchId,
			laneId: 'lane-a',
			correlationId: `${batchId}-lane-a`,
		});

		let calls = 0;
		const status = mock(async () => ({
			data: { [`${batchId}-lane-a`]: { type: 'idle' } },
			error: undefined,
		}));
		const messages = mock(async () => {
			calls += 1;
			if (calls === 1) throw new Error('ECONNRESET talking to the host');
			return {
				data: [assistantMessage('output that arrived on the retry')],
				error: undefined,
			};
		});
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		// Real clock and real poll sleeps: a mocked clock far from the record's
		// `updatedAt` would trip the stale sweep and mask what is under test.
		const result = await executeCollectLaneResults(
			{
				batch_id: batchId,
				wait: true,
				timeout_ms: 2_000,
				include_pending: true,
			},
			directory,
		);

		expect(calls).toBe(2);
		expect(result.completed).toBe(1);
		expect(result.pending).toBe(0);
		expect(result.success).toBe(true);
		expect(
			result.errors?.some((entry) => entry.includes('lane left pending')),
		).toBeFalsy();
	});

	test('a sentence-shaped diagnostic is retired by the collectOnce terminal-settle path', async () => {
		// Covers the CONFIRMED-WRITE clear site on the collectOnce terminal-error
		// path (the sibling test below covers the already-terminal race site, and
		// the settleCollectedLane success-path site is covered in the
		// revision-snapshot suite).
		// This MUST span polls of a SINGLE wait:true invocation: `settleFailureLogs`
		// is allocated per invocation, so a second `executeCollectLaneResults` call
		// starts with an empty set and there would be nothing stale to clear.
		//
		// Poll 1 fails the digest, so settleCollectedLane records a SENTENCE-shaped
		// entry naming the lane. Poll 2 sees a terminal provider error, so the lane
		// settles through collectOnce — where the old exact-match
		// `delete(laneLabel)` could not clear a sentence-shaped entry, stranding a
		// "lane left pending" reason on a settled collection.
		const directory = makeTempDir();
		const batchId = 'observer-settle-retire';
		await recordPending({
			directory,
			batchId,
			laneId: 'lane-a',
			correlationId: `${batchId}-lane-a`,
			workspace: PR_WORKSPACE(directory),
		});

		_internals.resolvePrWorkflowRevisionDigestAsync = mock(async () => {
			throw new Error('transient git failure');
		});
		const status = mock(async () => ({
			data: { [`${batchId}-lane-a`]: { type: 'idle' } },
			error: undefined,
		}));
		let messageCalls = 0;
		const messages = mock(async () => {
			messageCalls += 1;
			return {
				data: [
					messageCalls === 1
						? assistantMessage('lane output')
						: assistantMessage('', {
								error: {
									name: 'APIError',
									data: { message: 'quota exceeded' },
								},
							}),
				],
				error: undefined,
			};
		});
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		// Real clock and real poll sleeps: a mocked clock far from the record's
		// `updatedAt` would trip the stale sweep and mask what is under test.
		const result = await executeCollectLaneResults(
			{
				batch_id: batchId,
				wait: true,
				timeout_ms: 2_000,
				include_pending: true,
			},
			directory,
		);

		expect(messageCalls).toBeGreaterThan(1);
		expect(result.pending).toBe(0);
		expect(
			result.errors?.some((entry) => entry.includes('lane left pending')),
		).toBeFalsy();
	});

	test('a sentence-shaped diagnostic is retired when a CONCURRENT writer settled the lane first', async () => {
		// The second `clearLaneDiagnostics` site on the collectOnce terminal-error
		// path: the already-terminal race. A concurrent writer (an explicit cancel,
		// the stale sweep, another collect on the same batch) settles the record
		// between this invocation's `findByBatchId` snapshot and its CAS append, so
		// the append is rejected and returns the UNCHANGED terminal record. The lane
		// is settled either way, so its stale reason must still be retired — an
		// exact-match delete could not clear a sentence-shaped entry here.
		const directory = makeTempDir();
		const batchId = 'lifecycle-concurrent-settle';
		const correlationId = `${batchId}-lane-a`;
		await recordPending({
			directory,
			batchId,
			laneId: 'lane-a',
			correlationId,
			workspace: PR_WORKSPACE(directory),
		});

		// Poll 1 records a SENTENCE-shaped entry by failing the digest.
		_internals.resolvePrWorkflowRevisionDigestAsync = mock(async () => {
			throw new Error('transient git failure');
		});
		const status = mock(async () => ({
			data: { [correlationId]: { type: 'idle' } },
			error: undefined,
		}));
		let messageCalls = 0;
		const messages = mock(async () => {
			messageCalls += 1;
			if (messageCalls === 1) {
				return { data: [assistantMessage('lane output')], error: undefined };
			}
			// The concurrent writer lands BEFORE collectOnce attempts its own
			// terminal settle, so the CAS rejects and hands back a terminal record
			// whose status differs from the one this pass tried to write.
			await appendDelegationTransition(directory, correlationId, {
				status: 'cancelled',
			});
			return {
				data: [
					assistantMessage('', {
						error: { name: 'APIError', data: { message: 'quota exceeded' } },
					}),
				],
				error: undefined,
			};
		});
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		const result = await executeCollectLaneResults(
			{
				batch_id: batchId,
				wait: true,
				timeout_ms: 2_000,
				include_pending: true,
			},
			directory,
		);

		expect(messageCalls).toBeGreaterThan(1);
		expect(result.pending).toBe(0);
		expect(
			result.errors?.some((entry) => entry.includes('lane left pending')),
		).toBeFalsy();
	});
});
