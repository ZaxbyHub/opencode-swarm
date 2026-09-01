/**
 * Issue #2045 — async lane terminals flow through the shared exactly-once
 * claim.
 *
 * Drives the REAL `executeDispatchLanesAsync` / `executeCollectLaneResults`
 * entry points with an injected host (`_internals.getSessionOps`, fixture
 * pattern from lane-terminal-error-fixtures) and asserts the durable ledger
 * gains the same immutable `terminalResult` the Task completion-observer
 * writes — eventId identity, duplicate idempotency, conflicting-event
 * rejection + audit, and the stale-sweep reconciliation fence.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readDelegationHealthArtifact } from '../../../src/background/delegation-health.js';
import { settleDelegationTerminal } from '../../../src/background/delegation-lifecycle.js';
import {
	appendDelegationTransition,
	buildBackgroundCompletionEventId,
	findByBatchId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	_internals,
	executeCollectLaneResults,
	executeDispatchLanesAsync,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';
import { freezeClock } from '../../helpers/test-clock.js';

const NOW = 1_750_000_000_000;

function makeTempDir(): string {
	return fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'lane-terminal-claim-')),
	);
}

function completedHost(sessionId: string, text = 'lane output'): SessionOps {
	return {
		create: async () => ({ data: { id: sessionId }, error: undefined }),
		prompt: async () => ({
			data: { parts: [{ type: 'text' as const, text: 'unused' }] },
			error: undefined,
		}),
		promptAsync: async () => ({ data: undefined, error: undefined }),
		status: async () => ({
			data: { [sessionId]: { type: 'idle' } },
			error: undefined,
		}),
		messages: async () => ({
			data: [
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'prompt' }] },
				{
					info: { role: 'assistant', time: { completed: NOW } },
					parts: [{ type: 'text', text }],
				},
			],
			error: undefined,
		}),
		delete: async () => undefined,
		abort: async () => undefined,
	} as never;
}

async function waitForStatus(
	directory: string,
	batchId: string,
	predicate: (status: string) => boolean,
	tries = 50,
): Promise<void> {
	for (let i = 0; i < tries; i++) {
		const records = findByBatchId(directory, batchId);
		if (records.length > 0 && records.every((r) => predicate(r.status))) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error('lane record never reached expected status');
}

describe('dispatch-lanes terminal claims (issue #2045)', () => {
	let dir: string;
	let restoreClock: () => void;
	const realGetSessionOps = _internals.getSessionOps;

	beforeEach(() => {
		dir = makeTempDir();
		restoreClock = freezeClock({ fixedNow: NOW });
	});

	afterEach(() => {
		_internals.getSessionOps = realGetSessionOps;
		restoreClock();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('an async lane settle writes an immutable terminalResult with eventId identity', async () => {
		_internals.getSessionOps = () => completedHost('sess-tc-1');
		await executeDispatchLanesAsync(
			{
				batch_id: 'batch-tc-1',
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			dir,
		);
		const result = await executeCollectLaneResults(
			{ batch_id: 'batch-tc-1', wait: false },
			dir,
		);
		expect(result.completed).toBe(1);

		const record = findByBatchId(dir, 'batch-tc-1')[0];
		expect(record.status).toBe('completed');
		expect(record.terminalResult).toBeDefined();
		expect(record.terminalResult?.eventId).toBe(
			buildBackgroundCompletionEventId({
				correlationId: record.correlationId,
				jobId: record.jobId,
				status: 'completed',
				resultDigest: record.terminalResult?.result.digest,
			}),
		);
		expect(record.terminalResult?.result.text).toBe('lane output');
		expect(record.completedAt).toBeDefined();
	});

	it('a duplicate collect of the same transcript is idempotent', async () => {
		_internals.getSessionOps = () => completedHost('sess-tc-2');
		await executeDispatchLanesAsync(
			{
				batch_id: 'batch-tc-2',
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			dir,
		);
		await executeCollectLaneResults(
			{ batch_id: 'batch-tc-2', wait: false },
			dir,
		);
		const first = findByBatchId(dir, 'batch-tc-2')[0];
		// Second collect: the record is terminal and filtered out of the active
		// set — no second terminal, no error, no audit tick.
		const second = await executeCollectLaneResults(
			{ batch_id: 'batch-tc-2', wait: false },
			dir,
		);
		expect(second.errors ?? []).toHaveLength(0);
		const after = findByBatchId(dir, 'batch-tc-2')[0];
		expect(after.terminalResult?.eventId).toBe(first.terminalResult?.eventId);
		expect(after.updatedAt).toBe(first.updatedAt);
		expect(readDelegationHealthArtifact(dir)?.counts.lateTerminals ?? 0).toBe(
			0,
		);
	});

	it('cancel_pending claims a cancelled terminal with a bounded reason', async () => {
		_internals.getSessionOps = () => completedHost('sess-tc-3');
		await executeDispatchLanesAsync(
			{
				batch_id: 'batch-tc-3',
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			dir,
		);
		const result = await executeCollectLaneResults(
			{ batch_id: 'batch-tc-3', wait: false, cancel_pending: true },
			dir,
		);
		expect(result.cancelled).toBe(1);
		const record = findByBatchId(dir, 'batch-tc-3')[0];
		expect(record.status).toBe('cancelled');
		expect(record.terminalResult?.status).toBe('cancelled');
		expect(record.terminalResult?.result.digest).toBe(
			createHash('sha256').update('').digest('hex'),
		);
		expect(record.terminalResult?.result.error).toMatch(/cancel/i);
	});

	it('a classified terminal error settles through the claim with its typed class', async () => {
		const sessionId = 'sess-tc-4';
		_internals.getSessionOps = () =>
			({
				create: async () => ({ data: { id: sessionId }, error: undefined }),
				prompt: async () => ({
					data: { parts: [{ type: 'text' as const, text: 'unused' }] },
					error: undefined,
				}),
				promptAsync: async () => ({ data: undefined, error: undefined }),
				status: async () => ({
					data: { [sessionId]: { type: 'idle' } },
					error: undefined,
				}),
				messages: async () => ({
					data: [
						{ info: { role: 'user' }, parts: [{ type: 'text', text: 'p' }] },
						{
							info: {
								role: 'assistant',
								time: { completed: NOW },
								error: {
									name: 'APIError',
									message: 'credit balance too low',
									data: { status: 402 },
								},
							},
							parts: [],
						},
					],
					error: undefined,
				}),
				delete: async () => undefined,
				abort: async () => undefined,
			}) as never;
		await executeDispatchLanesAsync(
			{
				batch_id: 'batch-tc-4',
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			dir,
		);
		const result = await executeCollectLaneResults(
			{ batch_id: 'batch-tc-4', wait: false },
			dir,
		);
		expect(result.failed).toBe(1);
		const record = findByBatchId(dir, 'batch-tc-4')[0];
		expect(record.status).toBe('error');
		expect(record.terminalResult?.status).toBe('error');
		expect(record.terminalResult?.result.terminalErrorClass?.kind).toBe(
			'provider',
		);
	});

	it('a promptAsync launch failure claims an error terminal', async () => {
		const sessionId = 'sess-tc-5';
		_internals.getSessionOps = () =>
			({
				create: async () => ({ data: { id: sessionId }, error: undefined }),
				prompt: async () => ({
					data: { parts: [{ type: 'text' as const, text: 'unused' }] },
					error: undefined,
				}),
				promptAsync: async () => ({
					data: undefined,
					error: { message: 'session.promptAsync launch failed: quota' },
				}),
				delete: async () => undefined,
			}) as never;
		const dispatch = await executeDispatchLanesAsync(
			{
				batch_id: 'batch-tc-5',
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			dir,
		);
		// Launch acceptance is asynchronous (queueMicrotask → promptAsync →
		// launch-error settle), so the dispatch itself still reports a pending
		// row; the durable terminal is what proves the claim.
		expect(dispatch.success).toBe(true);
		await waitForStatus(dir, 'batch-tc-5', (s) => s === 'error');
		const record = findByBatchId(dir, 'batch-tc-5')[0];
		expect(record.status).toBe('error');
		expect(record.terminalResult?.status).toBe('error');
		expect(record.terminalResult?.result.error).toMatch(/promptAsync/);
	});

	it('the stale sweep stays status-only; a later settle is benign and un-audited', async () => {
		// Transport-only difference (documented): the 30-minute stale sweep is a
		// PRESUMPTION, not an observed event — it writes `stale` without a
		// terminalResult, exactly like the Task-side sweep.
		await recordPendingDelegation(dir, {
			correlationId: 'sess-tc-6',
			jobId: null,
			subagentSessionId: 'sess-tc-6',
			parentSessionId: 'parent-6',
			callID: 'batch-tc-6',
			normalizedAgent: 'sme',
			swarmPrefixedAgent: 'mega_sme',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'batch-tc-6',
			laneId: 'lane-6',
		});
		await appendDelegationTransition(dir, 'sess-tc-6', {
			status: 'stale',
			expectedCurrentStatuses: ['pending', 'running'],
		});
		const swept = findByBatchId(dir, 'batch-tc-6')[0];
		expect(swept.status).toBe('stale');
		expect(swept.terminalResult).toBeUndefined();

		// A late observed success cannot claim over the presumption — and the
		// routine race must not tick the late-terminal audit.
		const outcome = await settleDelegationTerminal(
			dir,
			swept,
			{
				status: 'completed',
				result: {
					text: 'late output',
					chars: 11,
					truncated: false,
					digest: createHash('sha256').update('late output').digest('hex'),
				},
			},
			{},
			NOW + 1_000,
		);
		expect(outcome.kind).toBe('already_terminal_without_event');
		expect(readDelegationHealthArtifact(dir)?.counts.lateTerminals ?? 0).toBe(
			0,
		);
		const after = findByBatchId(dir, 'batch-tc-6')[0];
		expect(after.status).toBe('stale');
	});

	it('a success arriving after a claimed cancel is rejected and audited', async () => {
		await recordPendingDelegation(dir, {
			correlationId: 'sess-tc-7',
			jobId: null,
			subagentSessionId: 'sess-tc-7',
			parentSessionId: 'parent-7',
			callID: 'batch-tc-7',
			normalizedAgent: 'sme',
			swarmPrefixedAgent: 'mega_sme',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'batch-tc-7',
			laneId: 'lane-7',
		});
		const record = findByBatchId(dir, 'batch-tc-7')[0];
		const cancelSettle = await settleDelegationTerminal(
			dir,
			record,
			{
				status: 'cancelled',
				result: {
					error: 'lane cancelled via collect_lane_results cancel_pending',
					chars: 0,
					truncated: false,
					digest: createHash('sha256').update('').digest('hex'),
				},
			},
			{},
			NOW,
		);
		expect(cancelSettle.kind).toBe('claimed');
		const lateSuccess = await settleDelegationTerminal(
			dir,
			record,
			{
				status: 'completed',
				result: {
					text: 'late output',
					chars: 11,
					truncated: false,
					digest: createHash('sha256').update('late output').digest('hex'),
				},
			},
			{},
			NOW + 500,
		);
		expect(lateSuccess.kind).toBe('conflict');
		expect(readDelegationHealthArtifact(dir)?.counts.lateTerminals).toBe(1);
		const after = findByBatchId(dir, 'batch-tc-7')[0];
		expect(after.status).toBe('cancelled');
		// The explicit reconciliation rule: first event wins, verbatim.
		expect(after.terminalResult?.status).toBe('cancelled');
	});
});
