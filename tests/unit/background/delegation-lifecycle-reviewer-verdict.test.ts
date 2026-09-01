/**
 * Issue #2045 — reviewer-lane verdict reconciliation, end to end through
 * settleDelegationTerminal (split from delegation-lifecycle.test.ts to stay
 * under the FR-006 500-line cap). Seeding follows the phase-directives test
 * precedent: a real knowledge-store entry + a session-bound delegate_directive
 * membership, so readPhaseDirectivesToVerify resolves the verify set.
 *
 * Grammar note (implementation review): `VERIFIED:<trace>:<entry>` is the
 * reviewer compliance grammar, NOT a KNOWLEDGE_* ack — parseAcknowledgments
 * does not consume it, so the shown-but-unacked non-critical directive also
 * produces the neutral `unacknowledged` delegate observation alongside the
 * reviewer `applied` verdict. Broadening parseAcknowledgments to also parse
 * VERIFIED would change this dual-event expectation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals as lifecycleInternals,
	settleDelegationTerminal,
} from '../../../src/background/delegation-lifecycle.js';
import type { BackgroundDelegationRecord } from '../../../src/background/pending-delegations.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const NOW = 1_750_000_000_000;
const COMPLETED_RESULT_TEXT = 'lane output';
const COMPLETED_RESULT = {
	text: COMPLETED_RESULT_TEXT,
	chars: COMPLETED_RESULT_TEXT.length,
	truncated: false,
	digest: createHash('sha256').update(COMPLETED_RESULT_TEXT).digest('hex'),
};

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

async function recordToLedger(
	directory: string,
	record: BackgroundDelegationRecord,
): Promise<BackgroundDelegationRecord> {
	const { recordPendingDelegationDetailed } = await import(
		'../../../src/background/pending-delegations.js'
	);
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

describe('reviewer-lane verdict reconciliation (issue #2045 end-to-end)', () => {
	let dir: string;
	let prevHome: string | undefined;
	let prevLocalAppData: string | undefined;
	let prevXdgDataHome: string | undefined;
	let restoreClock: () => void;
	let realTelemetry: typeof lifecycleInternals.telemetry;
	let telemetryEnds: string[];

	beforeEach(() => {
		dir = canonicalMkdtemp('delegation-lifecycle-rev-');
		fs.writeFileSync(path.join(dir, '.git'), 'gitdir: fixture');
		// Isolate hive/home resolution (phase-directives test precedent).
		prevHome = process.env.HOME;
		prevLocalAppData = process.env.LOCALAPPDATA;
		prevXdgDataHome = process.env.XDG_DATA_HOME;
		const isolatedHome = path.join(dir, 'home');
		fs.mkdirSync(isolatedHome, { recursive: true });
		process.env.HOME = isolatedHome;
		process.env.LOCALAPPDATA = path.join(dir, 'localappdata');
		process.env.XDG_DATA_HOME = path.join(dir, 'xdg-data');
		restoreClock = freezeClock({ fixedNow: NOW });
		// Stub telemetry: silent for the ledger assertions, counted where the
		// crash-recovery test must prove diagnostics do NOT re-emit.
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
		lifecycleInternals.telemetry = realTelemetry;
		restoreClock();
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
		else process.env.LOCALAPPDATA = prevLocalAppData;
		if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = prevXdgDataHome;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('a reviewer-role lane settle reconciles DIRECTIVE_COMPLIANCE verdicts', async () => {
		const { appendKnowledge, resolveSwarmKnowledgePath } = await import(
			'../../../src/hooks/knowledge-store.js'
		);
		const { commitDisplayedMembership } = await import(
			'../../../src/hooks/knowledge-receipt-ledger.js'
		);
		const { readKnowledgeEvents } = await import(
			'../../../src/hooks/knowledge-events.js'
		);
		const entryId = 'entry-rev-2045';
		await appendKnowledge(resolveSwarmKnowledgePath(dir), {
			id: entryId,
			tier: 'swarm',
			lesson: 'Always cite file:line evidence in reviews',
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
			directive_priority: 'high',
		} as never);
		const committed = await commitDisplayedMembership(dir, {
			trace_id: 'trace-rev-2045',
			session_id: 'sess-lane-1',
			phase: 'Phase 1',
			agent: 'reviewer',
			exposure_kind: 'delegate_directive',
			entries: [{ entry_id: entryId, critical: false }],
		});
		expect(committed.ok).toBe(true);

		const record = await recordToLedger(
			dir,
			makeRecord({
				normalizedAgent: 'reviewer',
				swarmPrefixedAgent: 'mega_reviewer',
			}),
		);
		const outcome = await settleDelegationTerminal(
			dir,
			record,
			{ status: 'completed', result: COMPLETED_RESULT },
			{
				transcript: [
					'Review complete.',
					`VERIFIED:trace-rev-2045:${entryId} evidence=src/foo.ts:12`,
				].join('\n'),
			},
			NOW,
		);
		expect(outcome.kind).toBe('claimed');

		const events = await readKnowledgeEvents(dir);
		const reviewerApplied = events.find(
			(e) =>
				e.type === 'applied' &&
				(e as { knowledge_id?: string }).knowledge_id === entryId &&
				(e as { source?: string }).source === 'reviewer',
		);
		expect(reviewerApplied).toBeDefined();
		// The delegate-ack core ALSO ran over the same shown membership: with no
		// KNOWLEDGE_* marker for the shown non-critical, the neutral
		// unacknowledged observation is recorded alongside the reviewer verdict.
		const unacknowledged = events.find(
			(e) =>
				e.type === 'unacknowledged' &&
				(e as { knowledge_id?: string }).knowledge_id === entryId,
		);
		expect(unacknowledged).toBeDefined();
	});

	it('non-reviewer roles never run verdict reconciliation', async () => {
		const { readKnowledgeEvents } = await import(
			'../../../src/hooks/knowledge-events.js'
		);
		const record = await recordToLedger(dir, makeRecord());
		const outcome = await settleDelegationTerminal(
			dir,
			record,
			{ status: 'completed', result: COMPLETED_RESULT },
			{
				transcript:
					'VERIFIED:trace-rev-2045:entry-rev-2045 evidence=src/foo.ts:12',
			},
			NOW,
		);
		expect(outcome.kind).toBe('claimed');
		const events = await readKnowledgeEvents(dir);
		// No memberships exist for this session either: nothing reconciles at
		// all — and a stray VERIFIED line alone must not mint reviewer events.
		expect(
			events.filter((e) => (e as { source?: string }).source === 'reviewer'),
		).toHaveLength(0);
	});

	it('a crash between claim and observations recovers receipts on replay, without re-emitting diagnostics', async () => {
		// Final-critic crash window: the terminal claim is durable but the
		// process died before any observation ran. Model the on-disk state by
		// claiming DIRECTLY (exactly what the crash leaves behind), then replay
		// the settle — the duplicate disposition must close the authoritative
		// knowledge receipts (ledger-idempotent) while NOT re-emitting the
		// exactly-once-at-emit diagnostics (cost/trajectory).
		const { appendKnowledge, resolveSwarmKnowledgePath } = await import(
			'../../../src/hooks/knowledge-store.js'
		);
		const { commitDisplayedMembership } = await import(
			'../../../src/hooks/knowledge-receipt-ledger.js'
		);
		const { readKnowledgeEvents } = await import(
			'../../../src/hooks/knowledge-events.js'
		);
		const { claimTerminalResult } = await import(
			'../../../src/background/pending-delegations.js'
		);
		const entryId = 'entry-crash-2045';
		await appendKnowledge(resolveSwarmKnowledgePath(dir), {
			id: entryId,
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
		await commitDisplayedMembership(dir, {
			trace_id: 'trace-crash-2045',
			session_id: 'sess-lane-1',
			phase: 'Phase 1',
			agent: 'sme',
			exposure_kind: 'delegate_directive',
			entries: [{ entry_id: entryId, critical: false }],
		});

		const record = await recordToLedger(dir, makeRecord());
		// Crash state: the claim landed, no observations ran.
		const crashedTerminal = {
			text: COMPLETED_RESULT_TEXT,
			chars: COMPLETED_RESULT_TEXT.length,
			truncated: false,
			digest: COMPLETED_RESULT.digest,
		};
		const directClaim = await claimTerminalResult(dir, record.correlationId, {
			eventId: (
				await import('../../../src/background/pending-delegations.js')
			).buildBackgroundCompletionEventId({
				correlationId: record.correlationId,
				jobId: record.jobId,
				status: 'completed',
				resultDigest: crashedTerminal.digest,
			}),
			status: 'completed' as const,
			recordedAt: NOW,
			result: crashedTerminal,
		});
		expect(directClaim?.disposition).toBe('claimed');
		// Nothing reconciled yet (crash):
		expect(
			(await readKnowledgeEvents(dir)).filter(
				(e) => (e as { knowledge_id?: string }).knowledge_id === entryId,
			),
		).toHaveLength(0);

		// Replay (a later collector / restart path settles the same event):
		const replay = await settleDelegationTerminal(
			dir,
			record,
			{ status: 'completed', result: crashedTerminal },
			{
				transcript: `KNOWLEDGE_APPLIED:trace-crash-2045:${entryId}`,
			},
			NOW + 1_000,
		);
		expect(replay.kind).toBe('duplicate');
		const events = await readKnowledgeEvents(dir);
		const applied = events.filter(
			(e) =>
				e.type === 'applied' &&
				(e as { knowledge_id?: string }).knowledge_id === entryId,
		);
		// Receipts recovered EXACTLY once.
		expect(applied).toHaveLength(1);
		// Diagnostics were NOT re-emitted on the replay.
		expect(telemetryEnds).toHaveLength(0);
		const trajectoryPath = path.join(
			dir,
			'.swarm',
			'trajectories',
			'parent-1.jsonl',
		);
		expect(fs.existsSync(trajectoryPath)).toBe(false);
	});
	it('a crash before observations does not double-emit the audit-only unacknowledged observation on replay', async () => {
		const { appendKnowledge, resolveSwarmKnowledgePath } = await import(
			'../../../src/hooks/knowledge-store.js'
		);
		const { commitDisplayedMembership } = await import(
			'../../../src/hooks/knowledge-receipt-ledger.js'
		);
		const { readKnowledgeEvents } = await import(
			'../../../src/hooks/knowledge-events.js'
		);
		const { claimTerminalResult, buildBackgroundCompletionEventId } =
			await import('../../../src/background/pending-delegations.js');
		const entryId = 'entry-crash-noack';
		await appendKnowledge(resolveSwarmKnowledgePath(dir), {
			id: entryId,
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
		await commitDisplayedMembership(dir, {
			trace_id: 'trace-crash-noack',
			session_id: 'sess-lane-1',
			phase: 'Phase 1',
			agent: 'sme',
			exposure_kind: 'delegate_directive',
			entries: [{ entry_id: entryId, critical: false }],
		});
		const record = await recordToLedger(dir, makeRecord());
		const crashedTerminal = {
			text: COMPLETED_RESULT_TEXT,
			chars: COMPLETED_RESULT_TEXT.length,
			truncated: false,
			digest: COMPLETED_RESULT.digest,
		};
		const directClaim = await claimTerminalResult(dir, record.correlationId, {
			eventId: buildBackgroundCompletionEventId({
				correlationId: record.correlationId,
				jobId: record.jobId,
				status: 'completed',
				resultDigest: crashedTerminal.digest,
			}),
			status: 'completed' as const,
			recordedAt: NOW,
			result: crashedTerminal,
		});
		expect(directClaim?.disposition).toBe('claimed');
		// Replay with a transcript that acks NOTHING for the shown non-critical:
		// the first (crash-lost) pass would have emitted one `unacknowledged`
		// observation; the replay must NOT append another.
		const transcript = 'lane finished without acking anything';
		const replay1 = await settleDelegationTerminal(
			dir,
			record,
			{ status: 'completed', result: crashedTerminal },
			{ transcript },
			NOW + 1_000,
		);
		expect(replay1.kind).toBe('duplicate');
		const replay2 = await settleDelegationTerminal(
			dir,
			record,
			{ status: 'completed', result: crashedTerminal },
			{ transcript },
			NOW + 2_000,
		);
		expect(replay2.kind).toBe('duplicate');
		const events = await readKnowledgeEvents(dir);
		const unacknowledged = events.filter(
			(e) =>
				e.type === 'unacknowledged' &&
				(e as { knowledge_id?: string }).knowledge_id === entryId,
		);
		expect(unacknowledged).toHaveLength(0);
	});
});
