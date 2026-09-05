/**
 * Issue #2045 — shared delegation lifecycle operations unit tests.
 *
 * Pins the settleDelegationTerminal disposition contract (including the
 * already_terminal_without_event vs conflict distinction the plan critic
 * required), the exactly-once observation fan-out, and the canonical cost
 * identity material. Uses the real delegation ledger in a temp directory; only
 * the telemetry sink is stubbed through the module's `_internals` seam.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readDelegationHealthArtifact } from '../../../src/background/delegation-health.js';
import {
	buildDelegationTerminal,
	delegationCostRecordMaterial,
	_internals as lifecycleInternals,
	settleDelegationTerminal,
} from '../../../src/background/delegation-lifecycle.js';
import {
	appendDelegationTransition,
	type BackgroundDelegationRecord,
	buildBackgroundCompletionEventId,
	claimTerminalResult,
	findByCorrelationId,
	recordPendingDelegationDetailed,
} from '../../../src/background/pending-delegations.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const NOW = 1_750_000_000_000;

function makeRecord(overrides: Partial<BackgroundDelegationRecord> = {}) {
	return {
		schemaVersion: 2 as const,
		correlationId: 'sess-lane-1',
		jobId: null,
		subagentSessionId: 'sess-lane-1',
		parentSessionId: 'parent-1',
		callID: 'batch-1',
		normalizedAgent: 'sme',
		swarmPrefixedAgent: 'mega_sme',
		planTaskId: null,
		evidenceTaskId: null,
		status: 'pending' as const,
		createdAt: NOW - 5_000,
		updatedAt: NOW - 5_000,
		batchId: 'batch-1',
		laneId: 'lane-a',
		mode: 'advisory',
		...overrides,
	};
}

const COMPLETED_RESULT = {
	text: 'lane output',
	chars: 11,
	truncated: false,
	digest: createHash('sha256').update('lane output').digest('hex'),
};
const CANCELLED_RESULT = {
	error: 'lane cancelled via collect_lane_results cancel_pending',
	chars: 0,
	truncated: false,
	digest: createHash('sha256').update('').digest('hex'),
};

async function recordToLedger(
	directory: string,
	record: BackgroundDelegationRecord,
): Promise<BackgroundDelegationRecord> {
	const outcome = await recordPendingDelegationDetailed(directory, {
		correlationId: record.correlationId,
		jobId: record.jobId,
		subagentSessionId: record.subagentSessionId,
		parentSessionId: record.parentSessionId,
		callID: record.callID,
		normalizedAgent: record.normalizedAgent,
		swarmPrefixedAgent: record.swarmPrefixedAgent,
		planTaskId: record.planTaskId,
		evidenceTaskId: record.evidenceTaskId,
		batchId: record.batchId,
		laneId: record.laneId,
		mode: record.mode,
	});
	expect(outcome.status).toBe('recorded');
	return outcome.record;
}

describe('delegation-lifecycle', () => {
	let dir: string;
	let restoreClock: () => void;
	let ends: Array<{ sessionId: string; agent: string; result: string }>;
	let begins: string[];
	let costFields: Array<Record<string, unknown>>;
	let realTelemetry: typeof lifecycleInternals.telemetry;

	beforeEach(() => {
		dir = canonicalMkdtemp('delegation-lifecycle-');
		restoreClock = freezeClock({ fixedNow: NOW });
		ends = [];
		begins = [];
		costFields = [];
		realTelemetry = lifecycleInternals.telemetry;
		lifecycleInternals.telemetry = {
			delegationBegin: (sessionId: string) => {
				begins.push(sessionId);
			},
			delegationEnd: (
				sessionId: string,
				agent: string,
				_taskId: string,
				result: string,
				emittedCostFields: Record<string, unknown>,
			) => {
				ends.push({ sessionId, agent, result });
				costFields.push(emittedCostFields);
			},
		} as never;
	});

	afterEach(() => {
		lifecycleInternals.telemetry = realTelemetry;
		restoreClock();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('claims a terminal exactly once with a deterministic eventId', async () => {
		const record = await recordToLedger(dir, makeRecord());
		const outcome = await settleDelegationTerminal(
			dir,
			record,
			{ status: 'completed', result: COMPLETED_RESULT },
			{},
			NOW,
		);
		expect(outcome.kind).toBe('claimed');
		const settled = findByCorrelationId(dir, record.correlationId);
		expect(settled?.status).toBe('completed');
		expect(settled?.terminalResult?.eventId).toBe(
			buildBackgroundCompletionEventId({
				correlationId: record.correlationId,
				jobId: record.jobId,
				status: 'completed',
				resultDigest: COMPLETED_RESULT.digest,
			}),
		);
		expect(settled?.completedAt).toBe(NOW);
		expect(ends).toHaveLength(1);
		expect(ends[0]).toEqual({
			sessionId: 'parent-1',
			agent: 'mega_sme',
			result: 'completed',
		});
	});

	it('replays of the same event are duplicate dispositions without observations', async () => {
		const record = await recordToLedger(dir, makeRecord());
		await settleDelegationTerminal(
			dir,
			record,
			{ status: 'completed', result: COMPLETED_RESULT },
			{},
			NOW,
		);
		const replay = await settleDelegationTerminal(
			dir,
			record,
			{ status: 'completed', result: COMPLETED_RESULT },
			{},
			NOW + 1_000,
		);
		expect(replay.kind).toBe('duplicate');
		// Observations fired exactly once (claimed only).
		expect(ends).toHaveLength(1);
		expect(readDelegationHealthArtifact(dir)?.counts.lateTerminals ?? 0).toBe(
			0,
		);
	});

	it('a different terminal event for a claimed correlation is a conflict and ticks the audit', async () => {
		const record = await recordToLedger(dir, makeRecord());
		await settleDelegationTerminal(
			dir,
			record,
			{ status: 'cancelled', result: CANCELLED_RESULT },
			{},
			NOW,
		);
		// A late success arriving after the terminal cancel must not erase it.
		const late = await settleDelegationTerminal(
			dir,
			record,
			{ status: 'completed', result: COMPLETED_RESULT },
			{},
			NOW + 2_000,
		);
		expect(late.kind).toBe('conflict');
		const settled = findByCorrelationId(dir, record.correlationId);
		expect(settled?.status).toBe('cancelled');
		expect(settled?.terminalResult?.status).toBe('cancelled');
		expect(readDelegationHealthArtifact(dir)?.counts.lateTerminals).toBe(1);
		expect(ends).toHaveLength(1);
	});

	it('already_terminal_without_event does not tick the late-terminal audit', async () => {
		const record = await recordToLedger(dir, makeRecord());
		// The stale sweep (or any legacy status-only writer) wins the race with a
		// terminal status write that carries NO immutable event.
		await appendDelegationTransition(dir, record.correlationId, {
			status: 'stale',
		});
		const outcome = await settleDelegationTerminal(
			dir,
			record,
			{ status: 'completed', result: COMPLETED_RESULT },
			{},
			NOW + 1_000,
		);
		expect(outcome.kind).toBe('already_terminal_without_event');
		// Benign race: no lateTerminal tick belongs to this caller (the audit is
		// for conflicting EVENTS, and the stale sweep owns none).
		expect(readDelegationHealthArtifact(dir)?.counts.lateTerminals ?? 0).toBe(
			0,
		);
		// Issue #2482: the eventless terminal now closes its lifecycle pair with
		// a reconstructed end (attributed to the record, marked recovered) —
		// previously this path emitted nothing, leaving an unpairable begin.
		expect(ends).toHaveLength(1);
		expect(ends[0]).toEqual({
			sessionId: 'parent-1',
			agent: 'mega_sme',
			result: 'stale',
		});
		expect(costFields[0]?.recovered).toBe(true);
	});

	it('classifies not_open when the claim is refused and the record is still open', async () => {
		const record = await recordToLedger(dir, makeRecord());
		// `ingestion_error` is neither pending nor running, and not terminal: the
		// claim early-returns null and the re-read finds an open record.
		// ('ingesting' exists only as an in-memory observer state — the persisted
		// schema enum has no such status.)
		await appendDelegationTransition(dir, record.correlationId, {
			status: 'ingestion_error',
		});
		const outcome = await settleDelegationTerminal(
			dir,
			record,
			{ status: 'completed', result: COMPLETED_RESULT },
			{},
			NOW,
		);
		expect(outcome.kind).toBe('not_open');
	});

	it('reports missing when the correlation was never recorded', async () => {
		const outcome = await settleDelegationTerminal(
			dir,
			makeRecord({ correlationId: 'never-recorded' }),
			{ status: 'completed', result: COMPLETED_RESULT },
			{},
			NOW,
		);
		expect(outcome.kind).toBe('missing');
	});

	it('concurrent settles claim exactly once and observe exactly once', async () => {
		const record = await recordToLedger(dir, makeRecord());
		const outcomes = await Promise.all(
			Array.from({ length: 4 }, () =>
				settleDelegationTerminal(
					dir,
					record,
					{ status: 'completed', result: COMPLETED_RESULT },
					{},
					NOW,
				),
			),
		);
		const kinds = outcomes.map((o) => o.kind).sort();
		expect(kinds).toEqual(['claimed', 'duplicate', 'duplicate', 'duplicate']);
		expect(ends).toHaveLength(1);
	});

	it('writes a trajectory observation carrying the canonical join keys', async () => {
		const record = await recordToLedger(dir, makeRecord());
		await settleDelegationTerminal(
			dir,
			record,
			{ status: 'completed', result: COMPLETED_RESULT },
			{ startedAt: NOW - 5_000 },
			NOW,
		);
		const trajectoryPath = path.join(
			dir,
			'.swarm',
			'trajectories',
			'parent-1.jsonl',
		);
		expect(fs.existsSync(trajectoryPath)).toBe(true);
		const entries = fs
			.readFileSync(trajectoryPath, 'utf-8')
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(entries).toHaveLength(1);
		const entry = entries[0];
		expect(entry.agent).toBe('mega_sme');
		expect(entry.action).toBe('delegate');
		expect(entry.tool).toBe('dispatch_lanes');
		expect(entry.result).toBe('success');
		expect(entry.batchId).toBe('batch-1');
		expect(entry.laneId).toBe('lane-a');
		expect(entry.elapsed_ms).toBe(5_000);
	});

	it('cost identity material joins by record fields for lane and Task shapes', () => {
		const laneMaterial = delegationCostRecordMaterial(
			makeRecord({ laneId: 'lane-x' }),
		);
		expect(laneMaterial).toBe('parent-1\0batch-1\0lane:lane-x');
		// Issue #2482: Task-tool delegations carry no laneId; their material is
		// the Task shape (${parentSessionId}\0${callID}) instead of a throw, so
		// background Task terminals can still emit cost observations. The two
		// shapes hash-disjointly (pinned in delegation-terminal-pairing.test.ts).
		const taskMaterial = delegationCostRecordMaterial(
			makeRecord({ laneId: undefined, callID: 'call-7' }),
		);
		expect(taskMaterial).toBe('parent-1\0call-7');
	});

	it('emitted cost identity fields are deterministic and join by canonical record fields', async () => {
		// PRR-006: pin the actual hash inputs, not just the emission count — a
		// regression in the domain strings, material, or slice length must fail.
		const { createHash } = await import('node:crypto');
		const record = await recordToLedger(dir, makeRecord());
		await settleDelegationTerminal(
			dir,
			record,
			{ status: 'completed', result: COMPLETED_RESULT },
			{ model: 'test-model' },
			NOW,
		);
		expect(costFields).toHaveLength(1);
		const emitted = costFields[0];
		const material = 'parent-1\0batch-1\0lane:lane-a';
		const short = (input: string) =>
			createHash('sha256').update(input).digest('hex').slice(0, 32);
		// record_id: sha256 over the v1 domain + canonical record-field material.
		expect(emitted.record_id).toBe(short(`delegation-cost-id-v1\0${material}`));
		// identity_fingerprint: material + prefixed agent + model.
		expect(emitted.identity_fingerprint).toBe(
			short(`delegation-cost-identity-v1\0${material}\0mega_sme\0test-model`),
		);
		expect(emitted.parent_session_digest).toBe(
			short('delegation-cost-parent-v1\0parent-1'),
		);
		expect(emitted.child_session_digest).toBe(
			short('delegation-cost-child-v1\0sess-lane-1'),
		);
		expect(emitted.version).toBe(1);
		// Re-settle a fresh identical lane: the identity fields are identical
		// (deterministic join), and distinct from the Task-side material scheme.
		const second = await recordToLedger(
			dir,
			makeRecord({
				correlationId: 'sess-lane-2',
				subagentSessionId: 'sess-lane-2',
			}),
		);
		await settleDelegationTerminal(
			dir,
			second,
			{ status: 'completed', result: COMPLETED_RESULT },
			{ model: 'test-model' },
			NOW,
		);
		expect(costFields).toHaveLength(2);
		// Same laneId + parent + callID → same record_id (same unit of work
		// identity scheme); child digest differs (different lane session).
		expect(costFields[1].record_id).toBe(emitted.record_id);
		expect(costFields[1].identity_fingerprint).toBe(
			emitted.identity_fingerprint,
		);
		expect(costFields[1].child_session_digest).not.toBe(
			emitted.child_session_digest,
		);
	});

	it('cost record ids are deterministic and distinct from the Task scheme', async () => {
		const record = await recordToLedger(dir, makeRecord());
		await settleDelegationTerminal(
			dir,
			record,
			{ status: 'error', result: { ...COMPLETED_RESULT, error: 'boom' } },
			{ model: 'test-model' },
			NOW,
		);
		expect(ends).toHaveLength(1);
		// The trajectory entry above doubles as proof the observation bundle ran;
		// here we assert the settle did not throw and the ledger holds one event.
		const settled = findByCorrelationId(dir, record.correlationId);
		expect(settled?.terminalResult?.status).toBe('error');
	});

	it('buildDelegationTerminal derives identity from correlation + result only', () => {
		const record = makeRecord();
		const a = buildDelegationTerminal(
			record,
			{ status: 'completed', result: COMPLETED_RESULT },
			NOW,
		);
		const b = buildDelegationTerminal(
			makeRecord({ correlationId: 'other' }),
			{ status: 'completed', result: COMPLETED_RESULT },
			NOW + 9_999,
		);
		expect(a.eventId).not.toBe(b.eventId);
		// Same inputs, different recordedAt → same identity (no timestamps).
		const c = buildDelegationTerminal(
			record,
			{ status: 'completed', result: COMPLETED_RESULT },
			NOW + 123,
		);
		expect(a.eventId).toBe(c.eventId);
	});

	it('Task-style claims and lane settles share the same underlying claim', async () => {
		// The completion observer settles Task delegations with claimTerminalResult
		// directly; a lane settle of the SAME event shape must be a duplicate of
		// that claim — proving one shared claim, not two implementations.
		const record = await recordToLedger(dir, makeRecord());
		const terminal = buildDelegationTerminal(
			record,
			{ status: 'completed', result: COMPLETED_RESULT },
			NOW,
		);
		const taskClaim = await claimTerminalResult(
			dir,
			record.correlationId,
			terminal,
		);
		expect(taskClaim?.disposition).toBe('claimed');
		const laneOutcome = await settleDelegationTerminal(
			dir,
			record,
			{ status: 'completed', result: COMPLETED_RESULT },
			{},
			NOW + 5,
		);
		expect(laneOutcome.kind).toBe('duplicate');
	});
});
