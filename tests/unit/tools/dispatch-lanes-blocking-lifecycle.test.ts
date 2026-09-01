/**
 * Issue #2045 — blocking (synchronous) lanes gain the durable lifecycle:
 * start record at session creation, terminal claim on success/failure/timeout,
 * begin/end cost-event pairing, and a trajectory observation — while staying
 * invisible to every async-only surface (no batchId).
 *
 * Drives the REAL `executeDispatchLanes` with an injected host; the ledger is
 * the real one in a temp directory. Telemetry is captured through the
 * delegation-lifecycle `_internals` seam.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals as lifecycleInternals } from '../../../src/background/delegation-lifecycle.js';
import {
	findByBatchId,
	findByCorrelationId,
	findOpenAsyncLaneBatches,
	recordPendingDelegationDetailed,
} from '../../../src/background/pending-delegations.js';
import {
	_internals,
	executeDispatchLanes,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';
import { freezeClock } from '../../helpers/test-clock.js';

const NOW = 1_750_000_000_000;

function makeTempDir(): string {
	return fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'lane-blocking-lifecycle-')),
	);
}

function blockingHost(options: {
	sessionId: string;
	promptBehavior?: () => Promise<unknown>;
}): SessionOps {
	return {
		create: async () => ({
			data: { id: options.sessionId },
			error: undefined,
		}),
		prompt:
			options.promptBehavior ??
			(async () => ({
				data: { parts: [{ type: 'text' as const, text: 'blocking output' }] },
				error: undefined,
			})),
		delete: async () => undefined,
	} as never;
}

describe('dispatch-lanes blocking lifecycle (issue #2045)', () => {
	let dir: string;
	let restoreClock: () => void;
	const realGetSessionOps = _internals.getSessionOps;
	let ends: string[];
	let begins: string[];
	/** Ordered begin/end event log — proves the begin-before-end invariant. */
	let orderedEvents: string[];
	let realTelemetry: typeof lifecycleInternals.telemetry;

	beforeEach(() => {
		dir = makeTempDir();
		restoreClock = freezeClock({ fixedNow: NOW });
		ends = [];
		begins = [];
		orderedEvents = [];
		realTelemetry = lifecycleInternals.telemetry;
		lifecycleInternals.telemetry = {
			delegationBegin: () => {
				begins.push('begin');
				orderedEvents.push('begin');
			},
			delegationEnd: (
				_sessionId: string,
				_agent: string,
				_taskId: string,
				result: string,
			) => {
				ends.push(result);
				orderedEvents.push(`end:${result}`);
			},
		} as never;
	});

	afterEach(() => {
		_internals.getSessionOps = realGetSessionOps;
		lifecycleInternals.telemetry = realTelemetry;
		restoreClock();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('records a start + claims a completed terminal with begin/end pairing', async () => {
		_internals.getSessionOps = () => blockingHost({ sessionId: 'sess-bl-1' });
		const result = await executeDispatchLanes(
			{
				timeout_ms: 5_000,
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			dir,
			{ sessionID: 'parent-bl-1' },
		);
		expect(result.success).toBe(true);

		const record = findByCorrelationId(dir, 'sess-bl-1');
		expect(record).not.toBeNull();
		expect(record?.status).toBe('completed');
		expect(record?.mode).toBe('blocking');
		expect(record?.batchId).toBeUndefined();
		expect(record?.laneId).toBe('runtime');
		expect(record?.callID).toBe('blocking:sess-bl-1');
		expect(record?.parentSessionId).toBe('parent-bl-1');
		expect(record?.terminalResult?.status).toBe('completed');
		expect(record?.terminalResult?.result.text).toBe('blocking output');
		expect(record?.completedAt).toBeDefined();
		// Cost-event pairing parity with Task delegations.
		expect(begins).toHaveLength(1);
		expect(ends).toEqual(['completed']);
		// Trajectory observation under the PARENT session with join keys.
		const trajectoryPath = path.join(
			dir,
			'.swarm',
			'trajectories',
			'parent-bl-1.jsonl',
		);
		expect(fs.existsSync(trajectoryPath)).toBe(true);
		const entry = JSON.parse(
			fs.readFileSync(trajectoryPath, 'utf-8').split('\n')[0],
		) as Record<string, unknown>;
		expect(entry.laneId).toBe('runtime');
		expect(entry.batchId).toBeUndefined();
		expect(entry.tool).toBe('dispatch_lanes');
	});

	it('claims an error terminal when the prompt fails', async () => {
		_internals.getSessionOps = () =>
			blockingHost({
				sessionId: 'sess-bl-2',
				promptBehavior: async () => ({
					error: { message: 'provider exploded' },
				}),
			});
		const result = await executeDispatchLanes(
			{
				timeout_ms: 5_000,
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			dir,
			{ sessionID: 'parent-bl-2' },
		);
		expect(result.success).toBe(false);
		const record = findByCorrelationId(dir, 'sess-bl-2');
		expect(record?.status).toBe('error');
		expect(record?.terminalResult?.status).toBe('error');
		expect(record?.terminalResult?.result.error).toMatch(/provider exploded/);
		expect(ends).toEqual(['error']);
	});

	it('claims an error terminal for a timeout-shaped failure', async () => {
		// Timeout policy (issue #2045): timeouts settle as `error` terminals with
		// the timeout text preserved — Task has no separate timeout status either.
		_internals.getSessionOps = () =>
			blockingHost({
				sessionId: 'sess-bl-3',
				promptBehavior: () =>
					new Promise((resolve) => {
						// Never resolves; the lane timeout fires.
						setTimeout(resolve, 60_000);
					}),
			});
		const result = await executeDispatchLanes(
			{
				timeout_ms: 50,
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			dir,
			{ sessionID: 'parent-bl-3' },
		);
		expect(result.success).toBe(false);
		const record = findByCorrelationId(dir, 'sess-bl-3');
		expect(record?.status).toBe('error');
		expect(record?.terminalResult?.result.error).toMatch(/timed out/i);
		expect(ends).toEqual(['error']);
	});

	it('stays invisible to async-only surfaces', async () => {
		_internals.getSessionOps = () => blockingHost({ sessionId: 'sess-bl-4' });
		await executeDispatchLanes(
			{
				timeout_ms: 5_000,
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			dir,
			{ sessionID: 'parent-bl-4' },
		);
		expect(findOpenAsyncLaneBatches(dir)).toHaveLength(0);
		expect(findByBatchId(dir, '')).toHaveLength(0);
		expect(findByBatchId(dir, 'blocking:sess-bl-4')).toHaveLength(0);
		expect(findByCorrelationId(dir, 'sess-bl-4')).not.toBeNull();
	});

	it('fails open when the start record cannot land', async () => {
		// Pre-record a CONFLICTING record for the correlation id the host will
		// hand back: recordPendingDelegationDetailed then returns 'conflict' and
		// the blocking dispatch must proceed undiminished (fail-open) — the lane
		// still completes, only without its own durable lifecycle.
		const conflict = await recordPendingDelegationDetailed(dir, {
			correlationId: 'sess-bl-5',
			jobId: null,
			subagentSessionId: 'sess-bl-5',
			parentSessionId: 'someone-else',
			callID: 'other-call',
			normalizedAgent: 'sme',
			swarmPrefixedAgent: 'mega_sme',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'batch-other',
			laneId: 'lane-other',
		});
		expect(conflict.status).toBe('recorded');

		_internals.getSessionOps = () => blockingHost({ sessionId: 'sess-bl-5' });
		const result = await executeDispatchLanes(
			{
				timeout_ms: 5_000,
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			dir,
			{ sessionID: 'parent-bl-5' },
		);
		expect(result.success).toBe(true);
		// The pre-existing conflicting record is untouched (still pending under
		// its original identity); the lane result itself completed normally.
		const record = findByCorrelationId(dir, 'sess-bl-5');
		expect(record?.parentSessionId).toBe('someone-else');
		expect(record?.status).toBe('pending');
		// No begin/end pair was emitted for the unrecorded lane.
		expect(begins).toHaveLength(0);
		expect(ends).toHaveLength(0);
	});

	it('begin always precedes end even when the prompt resolves before the start record', async () => {
		// The start-record promise is fired unawaited and awaited only before
		// the settle, so a prompt that resolves INSTANTLY cannot let the
		// delegation_end observation overtake the begin emitted inside the
		// record chain's .then (implementation-review hardening case).
		_internals.getSessionOps = () =>
			blockingHost({
				sessionId: 'sess-bl-6',
				promptBehavior: async () => ({
					data: { parts: [{ type: 'text' as const, text: 'instant' }] },
					error: undefined,
				}),
			});
		const result = await executeDispatchLanes(
			{
				timeout_ms: 5_000,
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			dir,
			{ sessionID: 'parent-bl-6' },
		);
		expect(result.success).toBe(true);
		expect(orderedEvents).toEqual(['begin', 'end:completed']);
	});
});
