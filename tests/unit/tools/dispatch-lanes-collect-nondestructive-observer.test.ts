import { afterEach, describe, expect, mock, test } from 'bun:test';
import { findByCorrelationId } from '../../../src/background/pending-delegations';
import {
	_internals,
	_test_exports,
	executeCollectLaneResults,
} from '../../../src/tools/dispatch-lanes';
import { createCollectLaneTimeoutFixture } from './dispatch-lanes-collect-host-timeout.fixtures';

/**
 * Issue #2381: `collect_lane_results` is an OBSERVER. Its wait budget, and the
 * availability of the host messages client, bound the OBSERVER CALL ONLY — they
 * must never write a terminal transition for an active PR-review lane.
 *
 * The pending-identity half of this contract lives in the sibling file
 * `dispatch-lanes-collect-pending-identities.test.ts`; the two were split to stay
 * under the FR-006 500-line cap.
 *
 * These tests replace `dispatch-lanes-pr-review-waited-deadline-terminal.test.ts`,
 * which asserted the opposite (now-removed) contract.
 *
 * Guardrail (Phase 4.2): every observer-failure mode below asserts the DURABLE
 * record is unchanged across the collect call. `status` and `result` are compared
 * explicitly rather than the whole record, because `updatedAt` legitimately moves
 * and the delivery cache writes during collection.
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

describe('collect_lane_results is a non-destructive observer (#2381)', () => {
	test('wait:true budget expiry leaves an active PR-review lane pending with no transition', async () => {
		const directory = makeTempDir();
		const batchId = 'observer-expiry';
		await recordPending({
			directory,
			batchId,
			mode: 'swarm-pr-review:base',
			workflowLane: 'correctness-state',
			workspace: PR_WORKSPACE(directory),
		});
		const before = laneState(directory, `${batchId}-session`);

		let now = 2_000_000_000_000;
		_internals.now = () => now;
		_internals.sleep = mock(async (ms: number) => {
			now += ms;
		});
		// Host never reports the turn over, so the lane genuinely is still running.
		const status = mock(async () => ({
			data: { [`${batchId}-session`]: { type: 'busy' } },
			error: undefined,
		}));
		const messages = mock(async () => ({ data: [], error: undefined }));
		const abort = mock(async () => undefined);
		_internals.getSessionOps = () => ({
			...baseOps(),
			status,
			messages,
			abort,
		});

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: true, timeout_ms: 25, include_pending: true },
			directory,
		);

		expect(result.pending).toBe(1);
		expect(result.failed).toBe(0);
		expect(result.all_settled).toBe(false);
		// The observer must not have aborted the child either.
		expect(abort).not.toHaveBeenCalled();

		const after = laneState(directory, `${batchId}-session`);
		expect(after.status).toBe(before.status);
		expect(after.result).toEqual(before.result);
		expect(after.status).toBe('pending');
	});

	test('timeout_ms:0 is an immediate non-destructive snapshot that spends no host calls', async () => {
		const directory = makeTempDir();
		const batchId = 'observer-zero-budget';
		await recordPending({
			directory,
			batchId,
			mode: 'swarm-pr-review:base',
			workflowLane: 'security-trust',
			workspace: PR_WORKSPACE(directory),
		});
		const before = laneState(directory, `${batchId}-session`);

		const status = mock(async () => ({
			data: { [`${batchId}-session`]: { type: 'idle' } },
			error: undefined,
		}));
		const messages = mock(async () => ({
			data: [
				assistantMessage('output that must not be harvested or discarded'),
			],
			error: undefined,
		}));
		const abort = mock(async () => undefined);
		_internals.getSessionOps = () => ({
			...baseOps(),
			status,
			messages,
			abort,
		});

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: true, timeout_ms: 0, include_pending: true },
			directory,
		);

		expect(result.pending).toBe(1);
		expect(result.failed).toBe(0);
		// A zero budget short-circuits before any host call is issued.
		expect(status).not.toHaveBeenCalled();
		expect(messages).not.toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();

		const after = laneState(directory, `${batchId}-session`);
		expect(after.status).toBe('pending');
		expect(after.status).toBe(before.status);
		expect(after.result).toEqual(before.result);
	});

	test('missing messages client returns stored status plus a typed diagnostic, not a terminal write', async () => {
		const directory = makeTempDir();
		const batchId = 'observer-no-client';
		await recordPending({
			directory,
			batchId,
			mode: 'swarm-pr-review:base',
			workflowLane: 'api-contract',
			workspace: PR_WORKSPACE(directory),
		});
		const before = laneState(directory, `${batchId}-session`);

		// No `messages` function at all — the host client is unavailable.
		_internals.getSessionOps = () => ({ ...baseOps(), messages: undefined });

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: true, include_pending: true },
			directory,
		);

		expect(result.failure_class).toBe('no_client');
		// Issue #2385: the diagnostic now carries the reducer-issued
		// collection diagnostic code after the base message.
		expect(result.errors).toContain(
			'OpenCode session messages client is not available (collection_host_unavailable)',
		);
		// Stored status is reported rather than a zeroed/terminalized view.
		expect(result.total).toBe(1);
		expect(result.pending).toBe(1);
		expect(result.failed).toBe(0);
		// The removed behavior announced 'lanes were terminalized locally'.
		expect(result.message).not.toContain('were terminalized locally');
		expect(result.message).toContain('no lane was cancelled or terminalized');

		const after = laneState(directory, `${batchId}-session`);
		expect(after.status).toBe('pending');
		expect(after.status).toBe(before.status);
		expect(after.result).toEqual(before.result);
	});

	test('a NON-PR-review batch is equally non-destructive under a missing client', async () => {
		// Ported from the removed waited-deadline suite, which used this as the
		// negative control proving terminalization was PR-review-specific. The
		// terminalizer is gone, so both modes must now be non-destructive — but the
		// control still earns its place by proving no mode-specific path returned.
		const directory = makeTempDir();
		const batchId = 'observer-no-client-advisory';
		await recordPending({ directory, batchId, mode: 'advisory' });
		const before = laneState(directory, `${batchId}-session`);

		_internals.getSessionOps = () => ({ ...baseOps(), messages: undefined });

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: true, include_pending: true },
			directory,
		);

		expect(result.failure_class).toBe('no_client');
		expect(result.pending).toBe(1);
		expect(result.failed).toBe(0);

		const after = laneState(directory, `${batchId}-session`);
		expect(after.status).toBe('pending');
		expect(after.status).toBe(before.status);
		expect(after.result).toEqual(before.result);
	});

	test('ordinary settled lanes still settle normally', async () => {
		const directory = makeTempDir();
		const batchId = 'observer-normal-settle';
		await recordPending({ directory, batchId });

		const status = mock(async () => ({
			data: { [`${batchId}-session`]: { type: 'idle' } },
			error: undefined,
		}));
		const messages = mock(async () => ({
			data: [assistantMessage('settled advisory output')],
			error: undefined,
		}));
		_internals.getSessionOps = () => ({ ...baseOps(), status, messages });

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: true, include_pending: true },
			directory,
		);

		expect(result.completed).toBe(1);
		expect(result.pending).toBe(0);
		expect(result.all_settled).toBe(true);
		expect(result.lane_results[0]?.output).toBe('settled advisory output');
		// Nothing is pending, so no pending-identity block is emitted.
		expect(result.pending_lanes).toBeUndefined();
	});

	test('a late child completion is collected by a LATER invocation after an expiry', async () => {
		const directory = makeTempDir();
		const batchId = 'observer-late-completion';
		// An advisory lane deliberately: the property under test — that nothing was
		// written on expiry, so the lane is still collectable later — is
		// mode-independent. Using a PR-review lane here would additionally engage
		// discovery-contract validation, which is covered by the host-timeout suite
		// and would obscure what this test is actually asserting.
		await recordPending({ directory, batchId });

		// First pass: the child is still busy and the observer budget expires.
		let now = 2_000_000_000_000;
		_internals.now = () => now;
		_internals.sleep = mock(async (ms: number) => {
			now += ms;
		});
		const busyStatus = mock(async () => ({
			data: { [`${batchId}-session`]: { type: 'busy' } },
			error: undefined,
		}));
		const emptyMessages = mock(async () => ({ data: [], error: undefined }));
		_internals.getSessionOps = () => ({
			...baseOps(),
			status: busyStatus,
			messages: emptyMessages,
		});

		const first = await executeCollectLaneResults(
			{ batch_id: batchId, wait: true, timeout_ms: 25, include_pending: true },
			directory,
		);
		expect(first.pending).toBe(1);
		expect(laneState(directory, `${batchId}-session`).status).toBe('pending');

		// Second pass: the child has since finished. Because the first expiry wrote
		// nothing, the lane is still collectable.
		restoreInternals();
		const idleStatus = mock(async () => ({
			data: { [`${batchId}-session`]: { type: 'idle' } },
			error: undefined,
		}));
		const lateMessages = mock(async () => ({
			data: [assistantMessage('late but valid child output')],
			error: undefined,
		}));
		_internals.getSessionOps = () => ({
			...baseOps(),
			status: idleStatus,
			messages: lateMessages,
		});

		const second = await executeCollectLaneResults(
			{ batch_id: batchId, wait: true, include_pending: true },
			directory,
		);

		expect(second.completed).toBe(1);
		expect(second.pending).toBe(0);
		expect(second.lane_results[0]?.output).toBe('late but valid child output');
	});
});
