import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
	computeLearningMetrics,
	formatLearningMarkdown,
	formatLearningJSON,
	formatLearningSummary,
} from '../../../src/services/learning-metrics';

// ---------------------------------------------------------------------------
// Deterministic "now" for all tests — 2026-06-11T12:00:00.000Z
// ---------------------------------------------------------------------------
const NOW = new Date('2026-06-11T12:00:00.000Z');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function seedKnowledgeEvents(
	dir: string,
	events: Record<string, unknown>[],
): void {
	const swarmDir = path.join(dir, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
	writeFileSync(path.join(swarmDir, 'knowledge-events.jsonl'), lines, 'utf-8');
}

function seedKnowledge(dir: string, entries: Record<string, unknown>[]): void {
	const swarmDir = path.join(dir, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
	writeFileSync(path.join(swarmDir, 'knowledge.jsonl'), lines, 'utf-8');
}

/** ISO timestamp N days before NOW. */
function daysAgo(n: number): string {
	return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

/** Minimal knowledge entry with required fields. */
function makeEntry(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: 'e1',
		tier: 'swarm',
		lesson: 'Always run tests before committing',
		category: 'testing',
		tags: ['testing', 'ci'],
		scope: 'global',
		confidence: 0.9,
		status: 'established',
		confirmed_by: [
			{
				phase_number: 1,
				confirmed_at: '2026-06-01T00:00:00.000Z',
				project_name: 'test-proj',
			},
		],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-06-01T00:00:00.000Z',
		updated_at: '2026-06-05T00:00:00.000Z',
		project_name: 'test-proj',
		directive_priority: 'medium',
		phases_alive: 1,
		...overrides,
	};
}

/** Minimal receipt-style event. */
function makeReceipt(
	type: string,
	knowledgeId: string,
	sessionId: string,
	timestamp: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		type,
		event_id: `evt-${Math.random().toString(36).slice(2, 8)}`,
		trace_id: 'tr-1',
		timestamp,
		session_id: sessionId,
		knowledge_id: knowledgeId,
		agent: 'coder',
		...extra,
	};
}

/** Minimal retrieved event. */
function makeRetrieved(
	resultIds: string[],
	sessionId: string,
	timestamp: string,
): Record<string, unknown> {
	const ranks: Record<string, number> = {};
	const scores: Record<string, number> = {};
	for (let i = 0; i < resultIds.length; i++) {
		ranks[resultIds[i]] = i + 1;
		scores[resultIds[i]] = 0.9 - i * 0.1;
	}
	return {
		type: 'retrieved',
		event_id: `evt-${Math.random().toString(36).slice(2, 8)}`,
		trace_id: 'tr-1',
		timestamp,
		session_id: sessionId,
		agent: 'architect',
		query: 'test',
		retrieval_mode: 'auto_injection',
		result_ids: resultIds,
		ranks,
		scores,
	};
}

/** Minimal escalation event. */
function makeEscalation(
	entryId: string,
	sessionId: string,
	timestamp: string,
): Record<string, unknown> {
	return {
		type: 'escalation',
		event_id: `evt-${Math.random().toString(36).slice(2, 8)}`,
		timestamp,
		entry_id: entryId,
		from: 'medium',
		to: 'critical',
		reason: 'repeat_violation',
		enforcement_mode: 'enforce',
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('learning-metrics', () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(path.join(os.tmpdir(), 'swarm-learning-'));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// -----------------------------------------------------------------------
	// Empty data
	// -----------------------------------------------------------------------

	describe('empty data', () => {
		it('returns empty metrics when .swarm/ exists but is empty', async () => {
			mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
			const m = await computeLearningMetrics(tmp, { now: NOW });
			expect(m.violationTrends).toEqual([]);
			expect(m.overallViolationRate).toEqual({ window7d: 0, window30d: 0 });
			expect(m.applicationRateByPriority).toEqual({});
			expect(m.timeToFirstApplication).toEqual([]);
			expect(m.escalationFrequency).toEqual({
				total: 0,
				last7d: 0,
				last30d: 0,
			});
			expect(m.unacknowledgedCriticalCount).toBe(0);
			expect(m.entryROI).toEqual([]);
			expect(m.neverApplied).toEqual([]);
			expect(m.learningSummary).toBe('No learning data yet');
			expect(m.sessionCount).toBe(0);
		});

		it('returns empty metrics when .swarm/ directory does not exist', async () => {
			const m = await computeLearningMetrics(tmp, { now: NOW });
			expect(m.learningSummary).toBe('No learning data yet');
			expect(m.sessionCount).toBe(0);
			expect(m.violationTrends).toEqual([]);
			expect(m.entryROI).toEqual([]);
		});
	});

	// -----------------------------------------------------------------------
	// Violation trends
	// -----------------------------------------------------------------------

	describe('violation trends', () => {
		it('detects worsening trend when 7d rate exceeds 30d rate', async () => {
			// 2 violations in last 7d, plus 3 violations and 5 acks in the 8-30d window
			const events = [
				// Within 7d
				makeReceipt('violated', 'e1', 'sess-1', daysAgo(1)),
				makeReceipt('violated', 'e1', 'sess-1', daysAgo(3)),
				// Within 30d but outside 7d — lower violation rate due to acks
				makeReceipt('violated', 'e1', 'sess-1', daysAgo(10)),
				makeReceipt('violated', 'e1', 'sess-1', daysAgo(15)),
				makeReceipt('violated', 'e1', 'sess-1', daysAgo(20)),
				makeReceipt('acknowledged', 'e1', 'sess-1', daysAgo(12)),
				makeReceipt('acknowledged', 'e1', 'sess-1', daysAgo(14)),
				makeReceipt('acknowledged', 'e1', 'sess-1', daysAgo(18)),
				makeReceipt('acknowledged', 'e1', 'sess-1', daysAgo(22)),
				makeReceipt('acknowledged', 'e1', 'sess-1', daysAgo(25)),
			];
			seedKnowledgeEvents(tmp, events);
			seedKnowledge(tmp, [
				makeEntry({ id: 'e1', directive_priority: 'critical' }),
			]);

			const m = await computeLearningMetrics(tmp, { now: NOW });
			expect(m.violationTrends.length).toBe(1);
			const t = m.violationTrends[0];
			expect(t.entryId).toBe('e1');
			// 7d: 2 violations / 2 total receipts = 1.0
			expect(t.violationRate7d).toBe(1.0);
			// 30d: 5 violations / 10 total receipts = 0.5
			expect(t.violationRate30d).toBe(0.5);
			expect(t.trend).toBe('worsening');
		});

		it('detects improving trend when violations are only outside 7d window', async () => {
			const events = [
				// No violations in 7d, but an ack so 7d has data
				makeReceipt('acknowledged', 'e1', 'sess-1', daysAgo(2)),
				// Violations only outside 7d but within 30d
				makeReceipt('violated', 'e1', 'sess-1', daysAgo(10)),
				makeReceipt('violated', 'e1', 'sess-1', daysAgo(15)),
			];
			seedKnowledgeEvents(tmp, events);
			seedKnowledge(tmp, [makeEntry({ id: 'e1' })]);

			const m = await computeLearningMetrics(tmp, { now: NOW });
			expect(m.violationTrends.length).toBe(1);
			expect(m.violationTrends[0].violationRate7d).toBe(0);
			expect(m.violationTrends[0].violationRate30d).toBeGreaterThan(0);
			expect(m.violationTrends[0].trend).toBe('improving');
		});
	});

	// -----------------------------------------------------------------------
	// Overall violation rate
	// -----------------------------------------------------------------------

	describe('overall violation rate', () => {
		it('computes overall rates from a mix of receipt types', async () => {
			const events = [
				// 7d window: 1 violation, 2 applied = 3 total receipts → rate = 1/3
				makeReceipt('violated', 'e1', 'sess-1', daysAgo(1)),
				makeReceipt('applied', 'e1', 'sess-1', daysAgo(2)),
				makeReceipt('applied', 'e1', 'sess-1', daysAgo(5)),
				// outside 7d but within 30d: 2 more applied → 5 total 30d, 1 violation → 1/5
				makeReceipt('applied', 'e1', 'sess-1', daysAgo(10)),
				makeReceipt('applied', 'e1', 'sess-1', daysAgo(20)),
			];
			seedKnowledgeEvents(tmp, events);
			seedKnowledge(tmp, [makeEntry({ id: 'e1' })]);

			const m = await computeLearningMetrics(tmp, { now: NOW });
			// 7d: 1 violation / 3 receipts
			expect(m.overallViolationRate.window7d).toBeCloseTo(1 / 3, 5);
			// 30d: 1 violation / 5 receipts
			expect(m.overallViolationRate.window30d).toBeCloseTo(1 / 5, 5);
		});
	});

	// -----------------------------------------------------------------------
	// Application rate by priority
	// -----------------------------------------------------------------------

	describe('application rate by priority', () => {
		it('groups application rates by directive priority', async () => {
			const entries = [
				makeEntry({ id: 'e1', directive_priority: 'critical' }),
				makeEntry({
					id: 'e2',
					directive_priority: 'medium',
					lesson: 'Use linter',
				}),
				makeEntry({
					id: 'e3',
					directive_priority: 'low',
					lesson: 'Format code',
				}),
			];
			const events = [
				// e1 (critical): shown 2x, applied 1x
				makeRetrieved(['e1'], 'sess-1', daysAgo(1)),
				makeRetrieved(['e1'], 'sess-1', daysAgo(2)),
				makeReceipt('applied', 'e1', 'sess-1', daysAgo(1)),
				// e2 (medium): shown 3x, applied 2x
				makeRetrieved(['e2'], 'sess-1', daysAgo(1)),
				makeRetrieved(['e2'], 'sess-1', daysAgo(2)),
				makeRetrieved(['e2'], 'sess-1', daysAgo(3)),
				makeReceipt('applied', 'e2', 'sess-1', daysAgo(1)),
				makeReceipt('applied', 'e2', 'sess-1', daysAgo(2)),
				// e3 (low): shown 1x, applied 0x
				makeRetrieved(['e3'], 'sess-1', daysAgo(1)),
			];
			seedKnowledgeEvents(tmp, events);
			seedKnowledge(tmp, entries);

			const m = await computeLearningMetrics(tmp, { now: NOW });
			expect(m.applicationRateByPriority.critical).toEqual({
				applied: 1,
				total: 2,
				rate: 0.5,
			});
			expect(m.applicationRateByPriority.medium).toEqual({
				applied: 2,
				total: 3,
				rate: expect.closeTo(2 / 3, 5),
			});
			expect(m.applicationRateByPriority.low).toEqual({
				applied: 0,
				total: 1,
				rate: 0,
			});
		});
	});

	// -----------------------------------------------------------------------
	// Time to first application
	// -----------------------------------------------------------------------

	describe('time to first application', () => {
		it('computes daysToApply from created_at to last_applied_at in rollup', async () => {
			// Entry created 10 days ago; applied 5 days ago → daysToApply ≈ 5
			const entry = makeEntry({
				id: 'e1',
				created_at: daysAgo(10),
			});
			const events = [makeReceipt('applied', 'e1', 'sess-1', daysAgo(5))];
			seedKnowledgeEvents(tmp, events);
			seedKnowledge(tmp, [entry]);

			const m = await computeLearningMetrics(tmp, { now: NOW });
			expect(m.timeToFirstApplication.length).toBe(1);
			expect(m.timeToFirstApplication[0].entryId).toBe('e1');
			expect(m.timeToFirstApplication[0].daysToApply).toBeCloseTo(5, 0);
		});

		it('returns null daysToApply for entries never applied', async () => {
			const entry = makeEntry({ id: 'e1' });
			// Only a retrieved event, no applied
			const events = [makeRetrieved(['e1'], 'sess-1', daysAgo(1))];
			seedKnowledgeEvents(tmp, events);
			seedKnowledge(tmp, [entry]);

			const m = await computeLearningMetrics(tmp, { now: NOW });
			expect(m.timeToFirstApplication.length).toBe(1);
			expect(m.timeToFirstApplication[0].daysToApply).toBeNull();
		});
	});

	// -----------------------------------------------------------------------
	// Escalation frequency
	// -----------------------------------------------------------------------

	describe('escalation frequency', () => {
		it('counts total and windowed escalation events', async () => {
			const events = [
				makeEscalation('e1', 'sess-1', daysAgo(2)), // within 7d and 30d
				makeEscalation('e2', 'sess-1', daysAgo(10)), // within 30d but not 7d
				makeEscalation('e3', 'sess-1', daysAgo(40)), // outside 30d
			];
			seedKnowledgeEvents(tmp, events);
			seedKnowledge(tmp, [makeEntry({ id: 'e1' })]);

			const m = await computeLearningMetrics(tmp, { now: NOW });
			expect(m.escalationFrequency.total).toBe(3);
			expect(m.escalationFrequency.last7d).toBe(1);
			expect(m.escalationFrequency.last30d).toBe(2);
		});
	});

	// -----------------------------------------------------------------------
	// Unacknowledged critical
	// -----------------------------------------------------------------------

	describe('unacknowledged critical', () => {
		it('counts critical entries shown but never acknowledged or applied', async () => {
			const entries = [makeEntry({ id: 'e1', directive_priority: 'critical' })];
			// Show e1 3 times, never ack/apply
			const events = [
				makeRetrieved(['e1'], 'sess-1', daysAgo(1)),
				makeRetrieved(['e1'], 'sess-1', daysAgo(2)),
				makeRetrieved(['e1'], 'sess-1', daysAgo(3)),
			];
			seedKnowledgeEvents(tmp, events);
			seedKnowledge(tmp, entries);

			const m = await computeLearningMetrics(tmp, { now: NOW });
			expect(m.unacknowledgedCriticalCount).toBe(1);
		});

		it('does not count critical entries that have been acknowledged', async () => {
			const entries = [makeEntry({ id: 'e1', directive_priority: 'critical' })];
			const events = [
				makeRetrieved(['e1'], 'sess-1', daysAgo(1)),
				makeReceipt('acknowledged', 'e1', 'sess-1', daysAgo(1)),
			];
			seedKnowledgeEvents(tmp, events);
			seedKnowledge(tmp, entries);

			const m = await computeLearningMetrics(tmp, { now: NOW });
			expect(m.unacknowledgedCriticalCount).toBe(0);
		});
	});

	// -----------------------------------------------------------------------
	// Entry ROI
	// -----------------------------------------------------------------------

	describe('entry ROI', () => {
		it('classifies roi=high when applied + succeeded > failed', async () => {
			const events = [
				makeRetrieved(['e1'], 'sess-1', daysAgo(1)),
				makeReceipt('applied', 'e1', 'sess-1', daysAgo(1)),
				{
					type: 'outcome',
					event_id: 'evt-o1',
					timestamp: daysAgo(1),
					knowledge_id: 'e1',
					outcome: 'success',
					evidence_summary: 'ok',
				},
			];
			seedKnowledgeEvents(tmp, events);
			seedKnowledge(tmp, [makeEntry({ id: 'e1' })]);

			const m = await computeLearningMetrics(tmp, { now: NOW });
			const roi = m.entryROI.find((r) => r.entryId === 'e1');
			expect(roi).toBeDefined();
			expect(roi!.roi).toBe('high');
			expect(roi!.appliedCount).toBe(1);
			expect(roi!.succeededCount).toBe(1);
		});

		it('classifies roi=medium when applied but succeeded <= failed', async () => {
			const events = [
				makeRetrieved(['e1'], 'sess-1', daysAgo(1)),
				makeReceipt('applied', 'e1', 'sess-1', daysAgo(1)),
				{
					type: 'outcome',
					event_id: 'evt-o1',
					timestamp: daysAgo(1),
					knowledge_id: 'e1',
					outcome: 'failure',
					evidence_summary: 'broke',
				},
			];
			seedKnowledgeEvents(tmp, events);
			seedKnowledge(tmp, [makeEntry({ id: 'e1' })]);

			const m = await computeLearningMetrics(tmp, { now: NOW });
			const roi = m.entryROI.find((r) => r.entryId === 'e1');
			expect(roi!.roi).toBe('medium');
		});

		it('classifies roi=low when shown but never applied', async () => {
			const events = [makeRetrieved(['e1'], 'sess-1', daysAgo(1))];
			seedKnowledgeEvents(tmp, events);
			seedKnowledge(tmp, [makeEntry({ id: 'e1' })]);

			const m = await computeLearningMetrics(tmp, { now: NOW });
			const roi = m.entryROI.find((r) => r.entryId === 'e1');
			expect(roi!.roi).toBe('low');
		});

		it('classifies roi=unused when entry has no events', async () => {
			// Entry exists but no events reference it
			seedKnowledgeEvents(tmp, [
				makeRetrieved(['other'], 'sess-1', daysAgo(1)),
			]);
			seedKnowledge(tmp, [makeEntry({ id: 'e1' })]);

			const m = await computeLearningMetrics(tmp, { now: NOW });
			const roi = m.entryROI.find((r) => r.entryId === 'e1');
			expect(roi!.roi).toBe('unused');
		});
	});

	// -----------------------------------------------------------------------
	// Never applied
	// -----------------------------------------------------------------------

	describe('never applied', () => {
		it('includes entry with phases_alive >= threshold and no applications', async () => {
			const entry = makeEntry({ id: 'e1', phases_alive: 5 });
			// Show it but never apply
			const events = [makeRetrieved(['e1'], 'sess-1', daysAgo(1))];
			seedKnowledgeEvents(tmp, events);
			seedKnowledge(tmp, [entry]);

			const m = await computeLearningMetrics(tmp, { now: NOW });
			expect(m.neverApplied.length).toBe(1);
			expect(m.neverApplied[0].entryId).toBe('e1');
			expect(m.neverApplied[0].phasesAlive).toBe(5);
		});

		it('excludes entry with phases_alive below threshold', async () => {
			// Default threshold is 3; phases_alive=1 should not appear
			const entry = makeEntry({ id: 'e1', phases_alive: 1 });
			const events = [makeRetrieved(['e1'], 'sess-1', daysAgo(1))];
			seedKnowledgeEvents(tmp, events);
			seedKnowledge(tmp, [entry]);

			const m = await computeLearningMetrics(tmp, { now: NOW });
			expect(m.neverApplied.length).toBe(0);
		});

		it('excludes entry that has been applied even with high phases_alive', async () => {
			const entry = makeEntry({ id: 'e1', phases_alive: 10 });
			const events = [
				makeRetrieved(['e1'], 'sess-1', daysAgo(1)),
				makeReceipt('applied', 'e1', 'sess-1', daysAgo(1)),
			];
			seedKnowledgeEvents(tmp, events);
			seedKnowledge(tmp, [entry]);

			const m = await computeLearningMetrics(tmp, { now: NOW });
			expect(m.neverApplied.length).toBe(0);
		});
	});

	// -----------------------------------------------------------------------
	// Session count
	// -----------------------------------------------------------------------

	describe('session count', () => {
		it('counts distinct session_id values across events', async () => {
			const events = [
				makeReceipt('applied', 'e1', 'sess-1', daysAgo(1)),
				makeReceipt('applied', 'e1', 'sess-2', daysAgo(2)),
				makeReceipt('acknowledged', 'e1', 'sess-3', daysAgo(3)),
				// Duplicate sess-1 — should not double-count
				makeReceipt('violated', 'e1', 'sess-1', daysAgo(4)),
			];
			seedKnowledgeEvents(tmp, events);
			seedKnowledge(tmp, [makeEntry({ id: 'e1' })]);

			const m = await computeLearningMetrics(tmp, { now: NOW });
			expect(m.sessionCount).toBe(3);
		});
	});

	// -----------------------------------------------------------------------
	// Learning summary format
	// -----------------------------------------------------------------------

	describe('learning summary', () => {
		it('produces a 3-line summary with trend, top improvement, watch', async () => {
			const events = [
				// Overall: 7d has 1 violation / 2 receipts = 50%; 30d has 1/4 = 25% → worsening
				makeReceipt('violated', 'e1', 'sess-1', daysAgo(1)),
				makeReceipt('applied', 'e1', 'sess-1', daysAgo(2)),
				makeReceipt('applied', 'e1', 'sess-1', daysAgo(15)),
				makeReceipt('applied', 'e1', 'sess-1', daysAgo(20)),
			];
			seedKnowledgeEvents(tmp, events);
			seedKnowledge(tmp, [makeEntry({ id: 'e1' })]);

			const m = await computeLearningMetrics(tmp, { now: NOW });
			const lines = m.learningSummary.split('\n');
			expect(lines.length).toBe(3);
			expect(lines[0]).toContain('Learning trend:');
			expect(lines[0]).toContain('sessions');
		});

		it('shows stable trend when no violations exist', async () => {
			const events = [
				makeReceipt('applied', 'e1', 'sess-1', daysAgo(1)),
				makeReceipt('applied', 'e1', 'sess-1', daysAgo(15)),
			];
			seedKnowledgeEvents(tmp, events);
			seedKnowledge(tmp, [makeEntry({ id: 'e1' })]);

			const m = await computeLearningMetrics(tmp, { now: NOW });
			expect(m.learningSummary).toContain('stable');
		});
	});

	// -----------------------------------------------------------------------
	// Formatting functions
	// -----------------------------------------------------------------------

	describe('formatting', () => {
		it('formatLearningMarkdown produces markdown with expected section headers', async () => {
			const events = [
				makeRetrieved(['e1'], 'sess-1', daysAgo(1)),
				makeReceipt('applied', 'e1', 'sess-1', daysAgo(1)),
			];
			seedKnowledgeEvents(tmp, events);
			seedKnowledge(tmp, [makeEntry({ id: 'e1' })]);

			const m = await computeLearningMetrics(tmp, { now: NOW });
			const md = formatLearningMarkdown(m);
			expect(md).toContain('## Learning Summary');
			expect(md).toContain('## Violation Trends');
			expect(md).toContain('## Application Rates by Priority');
			expect(md).toContain('## Escalation Activity');
			expect(md).toContain('## Entry ROI');
			expect(md).toContain('## Never Applied');
			expect(md).toContain('## Time to First Application');
		});

		it('formatLearningJSON returns the metrics object unchanged', async () => {
			mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
			const m = await computeLearningMetrics(tmp, { now: NOW });
			const json = formatLearningJSON(m);
			expect(json).toEqual(m);
		});

		it('formatLearningSummary returns just the summary string', async () => {
			mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
			const m = await computeLearningMetrics(tmp, { now: NOW });
			expect(formatLearningSummary(m)).toBe(m.learningSummary);
		});
	});

	// -----------------------------------------------------------------------
	// Multi-session trends
	// -----------------------------------------------------------------------

	describe('multi-session trends', () => {
		it('tracks events from multiple sessions correctly', async () => {
			const events = [
				makeReceipt('violated', 'e1', 'sess-1', daysAgo(1)),
				makeReceipt('applied', 'e1', 'sess-2', daysAgo(2)),
				makeReceipt('acknowledged', 'e1', 'sess-2', daysAgo(3)),
			];
			seedKnowledgeEvents(tmp, events);
			seedKnowledge(tmp, [makeEntry({ id: 'e1' })]);

			const m = await computeLearningMetrics(tmp, { now: NOW });
			expect(m.sessionCount).toBe(2);
			// 1 violation out of 3 receipts in 7d
			expect(m.overallViolationRate.window7d).toBeCloseTo(1 / 3, 5);
			expect(m.violationTrends.length).toBe(1);
		});
	});
});
