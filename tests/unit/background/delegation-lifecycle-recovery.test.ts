/**
 * Issue #2045 — durable crash recovery for terminal lane receipts, driven
 * through the PRODUCTION recovery entries (final-critic round-2 challenge):
 * `collect_lane_results` recovers a batch's terminal records after a restart,
 * and the session-close maintenance pass recovers directory-wide (which is
 * what covers BLOCKING lane records that have no collector).
 *
 * The crash state is built exactly as a crash leaves it: the terminal claim
 * landed (durable `terminalResult` with its transcript), the observation pass
 * never ran (receipts open, no diagnostics).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals as lifecycleInternals,
	recoverTerminalLaneReceipts,
} from '../../../src/background/delegation-lifecycle.js';
import {
	buildBackgroundCompletionEventId,
	claimTerminalResult,
	findByBatchId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { readKnowledgeEvents } from '../../../src/hooks/knowledge-events.js';
import { commitDisplayedMembership } from '../../../src/hooks/knowledge-receipt-ledger.js';
import {
	appendKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store.js';
import {
	_internals,
	executeCollectLaneResults,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const NOW = 1_750_000_000_000;
const ENTRY_ID = 'entry-recovery-2045';
const TRACE_ID = 'trace-recovery-2045';
const LANE_SESSION_ID = 'sess-recovery-lane';
const PARENT_SESSION = 'parent-recovery';
const TRANSCRIPT = `lane finished\nKNOWLEDGE_APPLIED:${TRACE_ID}:${ENTRY_ID}`;
const RESULT_TEXT = 'lane output';

async function seedCrashState(directory: string): Promise<void> {
	await appendKnowledge(resolveSwarmKnowledgePath(directory), {
		id: ENTRY_ID,
		tier: 'swarm',
		lesson: 'Cite evidence',
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.85,
		status: 'established',
		confirmed_by: [],
		project_name: 'test-project',
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		directive_priority: 'medium',
	} as never);
	await commitDisplayedMembership(directory, {
		trace_id: TRACE_ID,
		session_id: LANE_SESSION_ID,
		phase: 'Phase 1',
		agent: 'sme',
		exposure_kind: 'delegate_directive',
		entries: [{ entry_id: ENTRY_ID, critical: false }],
	});
	const crashResult = {
		text: TRANSCRIPT,
		chars: TRANSCRIPT.length,
		truncated: false,
		digest: createHash('sha256').update(TRANSCRIPT).digest('hex'),
	};
	// The exact on-disk crash state: terminal claimed, observations never ran.
	const claim = await claimTerminalResult(directory, LANE_SESSION_ID, {
		eventId: buildBackgroundCompletionEventId({
			correlationId: LANE_SESSION_ID,
			jobId: null,
			status: 'completed',
			resultDigest: crashResult.digest,
		}),
		status: 'completed',
		recordedAt: NOW,
		result: crashResult,
	});
	expect(claim?.disposition).toBe('claimed');
}

function idleHost(): SessionOps {
	return {
		create: async () => ({ data: { id: LANE_SESSION_ID }, error: undefined }),
		prompt: async () => ({
			data: { parts: [{ type: 'text' as const, text: RESULT_TEXT }] },
			error: undefined,
		}),
		promptAsync: async () => ({ data: undefined, error: undefined }),
		status: async () => ({
			data: { [LANE_SESSION_ID]: { type: 'idle' } },
			error: undefined,
		}),
		messages: async () => ({
			data: [
				{
					info: { role: 'assistant', time: { completed: NOW } },
					parts: [{ type: 'text', text: RESULT_TEXT }],
				},
			],
			error: undefined,
		}),
		delete: async () => undefined,
		abort: async () => undefined,
	} as never;
}

function appliedCount(directory: string): Promise<number> {
	return readKnowledgeEvents(directory).then(
		(events) =>
			events.filter(
				(e) =>
					e.type === 'applied' &&
					(e as { knowledge_id?: string }).knowledge_id === ENTRY_ID,
			).length,
	);
}

describe('terminal lane receipt recovery (issue #2045)', () => {
	let dir: string;
	let restoreClock: () => void;
	const realGetSessionOps = _internals.getSessionOps;
	let realTelemetry: typeof lifecycleInternals.telemetry;
	let telemetryEnds: string[];

	beforeEach(() => {
		dir = canonicalMkdtemp('lane-receipt-recovery-');
		fs.writeFileSync(path.join(dir, '.git'), 'gitdir: fixture');
		const isolatedHome = path.join(dir, 'home');
		fs.mkdirSync(isolatedHome, { recursive: true });
		process.env.HOME = isolatedHome;
		process.env.LOCALAPPDATA = path.join(dir, 'localappdata');
		process.env.XDG_DATA_HOME = path.join(dir, 'xdg-data');
		restoreClock = freezeClock({ fixedNow: NOW });
		telemetryEnds = [];
		realTelemetry = lifecycleInternals.telemetry;
		lifecycleInternals.telemetry = {
			delegationBegin: () => {},
			delegationEnd: (
				_sessionId: string,
				_agent: string,
				_taskId: string,
				result: string,
			) => {
				telemetryEnds.push(result);
			},
		} as never;
	});

	afterEach(() => {
		_internals.getSessionOps = realGetSessionOps;
		lifecycleInternals.telemetry = realTelemetry;
		restoreClock();
		delete process.env.HOME;
		delete process.env.LOCALAPPDATA;
		delete process.env.XDG_DATA_HOME;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('collect_lane_results recovers an async lane crashed between claim and observations', async () => {
		await recordPendingDelegation(dir, {
			correlationId: LANE_SESSION_ID,
			jobId: null,
			subagentSessionId: LANE_SESSION_ID,
			parentSessionId: PARENT_SESSION,
			callID: 'batch-recovery-1',
			normalizedAgent: 'sme',
			swarmPrefixedAgent: 'mega_sme',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'batch-recovery-1',
			laneId: 'lane-recovery',
		});
		await seedCrashState(dir);
		// Crash left the record terminal with NO receipt:
		expect(await appliedCount(dir)).toBe(0);

		// Restart entry: the architect collects the batch again.
		_internals.getSessionOps = () => idleHost();
		const first = await executeCollectLaneResults(
			{ batch_id: 'batch-recovery-1', wait: false },
			dir,
			{ sessionID: PARENT_SESSION },
		);
		expect(first.completed).toBe(1);
		expect(await appliedCount(dir)).toBe(1);
		// The recovered record IS the durable terminal the crash left.
		const record = findByBatchId(dir, 'batch-recovery-1')[0];
		expect(record.status).toBe('completed');
		expect(record.terminalResult?.result.text).toBe(TRANSCRIPT);

		// A second collection must not duplicate the recovered receipt, and the
		// replay never re-emits diagnostics.
		await executeCollectLaneResults(
			{ batch_id: 'batch-recovery-1', wait: false },
			dir,
			{ sessionID: PARENT_SESSION },
		);
		expect(await appliedCount(dir)).toBe(1);
		expect(telemetryEnds).toHaveLength(0);
	});

	it('the directory-wide pass recovers a BLOCKING lane record with no collector', async () => {
		await recordPendingDelegation(dir, {
			correlationId: LANE_SESSION_ID,
			jobId: null,
			subagentSessionId: LANE_SESSION_ID,
			parentSessionId: PARENT_SESSION,
			callID: `blocking:${LANE_SESSION_ID}`,
			normalizedAgent: 'sme',
			swarmPrefixedAgent: 'mega_sme',
			planTaskId: null,
			evidenceTaskId: null,
			// Deliberately NO batchId — the blocking convention: invisible to
			// every async-only surface, so only the maintenance pass can reach it.
			laneId: 'lane-blocking-recovery',
			mode: 'blocking',
		});
		await seedCrashState(dir);
		expect(await appliedCount(dir)).toBe(0);

		// Session-close maintenance entry (index.ts wiring target):
		const { recovered } = await recoverTerminalLaneReceipts(dir);
		expect(recovered).toBe(1);
		expect(await appliedCount(dir)).toBe(1);

		// Idempotent re-run + no diagnostic re-emission.
		const again = await recoverTerminalLaneReceipts(dir);
		expect(again.recovered).toBe(1);
		expect(await appliedCount(dir)).toBe(1);
		expect(telemetryEnds).toHaveLength(0);
	});

	it('the directory-wide pass makes forward progress past the 64-record cap', async () => {
		// Final-critic round-3: the cap must never permanently starve records
		// beyond the first page. Build 70 crash-state records (70 > cap 64) and
		// prove the LAST record is eventually reconciled across passes, exactly
		// once, with no duplicate diagnostics.
		const { recordPendingDelegation } = await import(
			'../../../src/background/pending-delegations.js'
		);
		const total = 70;
		for (let i = 0; i < total; i++) {
			// correlation == subagentSessionId == the membership session: the
			// recovery queries memberships by subagentSessionId, so all three must
			// agree for record 0 (which owns the shared membership).
			const correlation = `sess-starve-${String(i).padStart(3, '0')}`;
			await recordPendingDelegation(dir, {
				correlationId: correlation,
				jobId: null,
				subagentSessionId: correlation,
				parentSessionId: PARENT_SESSION,
				callID: `call-starve-${i}`,
				normalizedAgent: 'sme',
				swarmPrefixedAgent: 'mega_sme',
				planTaskId: null,
				evidenceTaskId: null,
				batchId: `batch-starve-${i}`,
				laneId: `lane-starve-${i}`,
			});
			const crashText = `KNOWLEDGE_APPLIED:${TRACE_ID}:${ENTRY_ID}`;
			await claimTerminalResult(dir, correlation, {
				eventId: buildBackgroundCompletionEventId({
					correlationId: correlation,
					jobId: null,
					status: 'completed',
					resultDigest: createHash('sha256').update(crashText).digest('hex'),
				}),
				status: 'completed',
				recordedAt: NOW + i,
				result: {
					text: crashText,
					chars: crashText.length,
					truncated: false,
					digest: createHash('sha256').update(crashText).digest('hex'),
				},
			});
		}
		// One shared membership on the shared trace: every replay reconciles
		// against it (the validator idempotently skips after the first accept).
		await commitDisplayedMembership(dir, {
			trace_id: TRACE_ID,
			session_id: 'sess-starve-000',
			phase: 'Phase 1',
			agent: 'sme',
			exposure_kind: 'delegate_directive',
			entries: [{ entry_id: ENTRY_ID, critical: false }],
		});

		const first = await recoverTerminalLaneReceipts(dir);
		expect(first.recovered).toBe(64);
		expect(first.exhaustedBudget).toBe(true);
		const second = await recoverTerminalLaneReceipts(dir);
		// Forward progress: the second pass resumes AFTER the cursor, reaching
		// the tail the first pass could not.
		expect(second.recovered).toBe(6);
		expect(second.exhaustedBudget).toBe(false);
		// The authoritative receipt exists exactly once, and diagnostics were
		// never re-emitted.
		expect(await appliedCount(dir)).toBe(1);
		expect(telemetryEnds).toHaveLength(0);
	});

	it('a wrapped pass that reaches the end resets the cursor to the oldest', async () => {
		// Review finding regression: `processedAll` was a reference comparison
		// and never fired, so the wrap reset was dead. Pin the actual cycle:
		// with a small record set (cap 64 not hit), pass 1 leaves a cursor at
		// the newest record; pass 2 wraps, processes everything, and RESETS
		// (cursor file removed); pass 3 starts from the oldest again.
		const { recordPendingDelegation } = await import(
			'../../../src/background/pending-delegations.js'
		);
		for (let i = 0; i < 3; i++) {
			const correlation = `sess-wrap-${String(i).padStart(3, '0')}`;
			await recordPendingDelegation(dir, {
				correlationId: correlation,
				jobId: null,
				subagentSessionId: correlation,
				parentSessionId: PARENT_SESSION,
				callID: `call-wrap-${i}`,
				normalizedAgent: 'sme',
				swarmPrefixedAgent: 'mega_sme',
				planTaskId: null,
				evidenceTaskId: null,
				batchId: `batch-wrap-${i}`,
				laneId: `lane-wrap-${i}`,
			});
			const crashText = 'wrapped lane transcript';
			await claimTerminalResult(dir, correlation, {
				eventId: buildBackgroundCompletionEventId({
					correlationId: correlation,
					jobId: null,
					status: 'completed',
					resultDigest: createHash('sha256').update(crashText).digest('hex'),
				}),
				status: 'completed',
				recordedAt: NOW + i,
				result: {
					text: crashText,
					chars: crashText.length,
					truncated: false,
					digest: createHash('sha256').update(crashText).digest('hex'),
				},
			});
		}
		const cursorPath = path.join(
			dir,
			'.swarm',
			'lane-receipt-recovery-cursor.json',
		);
		const first = await recoverTerminalLaneReceipts(dir);
		expect(first.recovered).toBe(3);
		expect(fs.existsSync(cursorPath)).toBe(true);
		const second = await recoverTerminalLaneReceipts(dir);
		expect(second.recovered).toBe(3);
		// The wrapped pass reached the end: the cursor RESET (file removed) so
		// the next pass begins from the oldest record again.
		expect(fs.existsSync(cursorPath)).toBe(false);
		const third = await recoverTerminalLaneReceipts(dir);
		expect(third.recovered).toBe(3);
		expect(fs.existsSync(cursorPath)).toBe(true);
	});

	it('a zero deadline processes nothing and leaves the cursor untouched', async () => {
		const { recordPendingDelegation } = await import(
			'../../../src/background/pending-delegations.js'
		);
		await recordPendingDelegation(dir, {
			correlationId: LANE_SESSION_ID,
			jobId: null,
			subagentSessionId: LANE_SESSION_ID,
			parentSessionId: PARENT_SESSION,
			callID: 'batch-deadline-0',
			normalizedAgent: 'sme',
			swarmPrefixedAgent: 'mega_sme',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'batch-deadline-0',
			laneId: 'lane-deadline-0',
		});
		await seedCrashState(dir);
		const result = await recoverTerminalLaneReceipts(dir, undefined, {
			deadlineMs: 0,
		});
		expect(result.recovered).toBe(0);
		expect(result.exhaustedBudget).toBe(true);
		// The record was never attempted: no receipt, cursor still absent.
		expect(await appliedCount(dir)).toBe(0);
		expect(
			fs.existsSync(
				path.join(dir, '.swarm', 'lane-receipt-recovery-cursor.json'),
			),
		).toBe(false);
	});
});
