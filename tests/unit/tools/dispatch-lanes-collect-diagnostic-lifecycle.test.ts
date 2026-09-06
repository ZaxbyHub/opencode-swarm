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

const { assembleCollectionDiagnostics, addLaneDiagnostic } = _test_exports;

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
	// Real clock deliberately (see the wait:true scenarios below): these tests
	// exercise multi-poll deadline progression against the record's real
	// updatedAt, so the fixture's deterministic collection clock (issue #2572)
	// must stay off here.
} = createCollectLaneTimeoutFixture({ deterministicClock: false });

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

	test('a host error carrying a secret, credential URL, or command is REDACTED out of result.errors', async () => {
		// PR-review FB-1 falsification probe, verbatim from the review: make a
		// pending lane's session.messages reject with an error containing sentinel
		// secrets, then assert the sentinels do not appear in result.errors.
		// `formatError` returns a raw Error.message (unbounded) or a JSON.stringify
		// of an arbitrary payload; truncation is not redaction, so the cause is
		// routed through the repository's failure-evidence redactor.
		const directory = makeTempDir();
		const batchId = 'lifecycle-redaction';
		await recordPending({
			directory,
			batchId,
			laneId: 'lane-a',
			correlationId: `${batchId}-lane-a`,
		});

		const status = mock(async () => ({
			data: { [`${batchId}-lane-a`]: { type: 'idle' } },
			error: undefined,
		}));
		const messages = mock(async () => {
			throw new Error(
				'upstream failed: https://user:hunter2@api.example.com/v1/generate ' +
					'AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE ' +
					'while running `curl -H "Authorization: Bearer sk_live_abcdef123456"`',
			);
		});
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false, include_pending: true },
			directory,
		);

		// The lane is still reported, and still pending — redaction must not cost
		// the diagnostic the issue requires.
		expect(result.pending).toBe(1);
		const joined = (result.errors ?? []).join(' | ');
		expect(joined).toContain('lane-a');
		expect(joined).toContain('transport error');

		// None of the sentinels survive.
		for (const sentinel of [
			'hunter2',
			'AKIAIOSFODNN7EXAMPLE',
			'sk_live_abcdef123456',
			'api.example.com/v1/generate',
		]) {
			expect(joined).not.toContain(sentinel);
		}
	});

	test('one lane error text cannot clear another lane diagnostic', async () => {
		// PR-review FB-2. Diagnostics were message-keyed, so clearing matched on the
		// quoted lane label INSIDE the message — and host error text can literally
		// contain another lane's quoted id. Lane-keyed storage makes clearing an
		// exact delete, so message content can no longer reach another lane.
		const directory = makeTempDir();
		const batchId = 'lifecycle-cross-lane';
		for (const lane of ['lane-a', 'lane-b']) {
			await recordPending({
				directory,
				batchId,
				laneId: lane,
				correlationId: `${batchId}-${lane}`,
			});
		}

		const status = mock(async () => ({
			data: {
				[`${batchId}-lane-a`]: { type: 'idle' },
				[`${batchId}-lane-b`]: { type: 'idle' },
			},
			error: undefined,
		}));
		// lane-a fails with an error whose payload NAMES lane-b in quotes; lane-b
		// then succeeds. Under message-keyed clearing, lane-b's success deleted
		// lane-a's diagnostic.
		const messages = mock(async ({ path }: { path: { id: string } }) => {
			if (path.id === `${batchId}-lane-a`) {
				throw new Error('routing failure for "lane-b" upstream');
			}
			return {
				data: [assistantMessage('lane-b settled output')],
				error: undefined,
			};
		});
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false, include_pending: true },
			directory,
		);

		expect(result.completed).toBe(1);
		expect(result.pending).toBe(1);
		// lane-a's diagnostic SURVIVES lane-b's success.
		expect(result.errors?.some((entry) => entry.includes('"lane-a"'))).toBe(
			true,
		);
	});

	test('a flood of host-call timeouts cannot starve the lane-keyed diagnostics', () => {
		// Closeout-review blocker, pinned directly on the union assembly.
		//
		// An earlier revision used ONE shared cap and spread `hostTimeouts` FIRST.
		// `hostTimeouts` is not bounded by lane count — a lane can time out on
		// abort/status/messages/digest in a single poll, and each entry embeds the
		// remaining budget, so a `wait: true` invocation accrues fresh, never-cleared
		// entries every poll. Spread first into a shared slice, that unbounded
		// channel could consume the whole budget and truncate away the lane-keyed
		// transport diagnostic that #2381 exists to surface.
		//
		// Driving a real timeout flood through the poll loop would need a mocked
		// clock, which trips the stale sweep and masks what is under test. The
		// invariant is a property of the ASSEMBLY, so it is pinned here instead:
		// channels are bounded independently and cannot starve one another.
		const hostTimeouts = new Set<string>(
			Array.from(
				{ length: 500 },
				(_, i) =>
					`session.messages for lane "t${i}" exceeded the remaining collect_lane_results budget (${i}ms)`,
			),
		);
		const settleFailureLogs = new Map<string, Set<string>>();
		const collectionResourceFailures = new Map<string, Set<string>>();
		addLaneDiagnostic(
			collectionResourceFailures,
			'victim',
			'session.messages transport error for lane "victim"; lane left pending: boom',
		);

		const diagnostics = assembleCollectionDiagnostics(
			hostTimeouts,
			settleFailureLogs,
			collectionResourceFailures,
		);

		// The lane-keyed diagnostic survives 500 host timeouts.
		expect(
			diagnostics.some(
				(entry) =>
					entry.includes('"victim"') && entry.includes('transport error'),
			),
		).toBe(true);
		// ...and the union stays bounded rather than echoing all 500.
		expect(diagnostics.length).toBeLessThan(100);
	});
});
