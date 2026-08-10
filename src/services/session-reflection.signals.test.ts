/**
 * Issue #2077 — session-reflection advisory signal tests.
 *
 * Covers the six signal classes (knowledge delta, skill violations,
 * contradiction candidates, negatives/NOOP, drafted issues) and the
 * post-finalize action menu. Separate from session-reflection.test.ts so
 * neither file approaches the 500-line FR-006 cap.
 *
 * Testing approach: the gather functions call their read-only dependencies
 * through the `_internals` seam, so tests inject fakes by reassigning
 * `_internals.readKnowledge` / `_internals.readSkillUsageEntriesTail` /
 * `_internals.readRejectedLessons` (restored in afterEach) — no mock.module.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir';
import type { SwarmKnowledgeEntry } from '../hooks/knowledge-types';
import type { SkillUsageEntry } from '../hooks/skill-usage-log';
import {
	_internals,
	buildActionMenu,
	buildActionProposals,
	buildSignalsBlock,
	type ContradictionCandidate,
	gatherContradictionCandidates,
	gatherRealtimeAdmissionCounts,
	gatherSkillViolations,
	type KnowledgeDelta,
	type ReflectionActionProposal,
	runSessionReflection,
	type SessionReflectionData,
} from './session-reflection';

setDefaultTimeout(30_000);

// Snapshot the seam so afterEach can restore it exactly.
const realInternals = { ..._internals };

afterEach(() => {
	for (const key of Object.keys(
		realInternals,
	) as (keyof typeof realInternals)[]) {
		(_internals as any)[key] = (realInternals as any)[key];
	}
});

function makeData(
	overrides: Partial<SessionReflectionData> = {},
): SessionReflectionData {
	return {
		timestamp: '2026-08-09T00:00:00.000Z',
		totalToolCalls: 0,
		totalToolFailures: 0,
		toolProblems: [],
		agentDispatches: [],
		gateFailures: [],
		lessonsFromRetros: [],
		errorTaxonomy: {},
		skillViolations: [],
		contradictionCandidates: [],
		...overrides,
	};
}

// ─── gatherSkillViolations ───────────────────────────────────────────

describe('session-reflection #2077 — gatherSkillViolations', () => {
	test('returns [] when sessionId is undefined (cannot claim "this session")', () => {
		const result = gatherSkillViolations('/tmp/whatever');
		expect(result).toEqual([]);
	});

	test('ranks skills by violation count, ignoring non-violated verdicts', () => {
		const entries: SkillUsageEntry[] = [
			{
				id: '1',
				skillPath: '.opencode/skills/a',
				agentName: 'coder',
				taskID: 't1',
				timestamp: '',
				complianceVerdict: 'violated',
				sessionID: 's1',
			},
			{
				id: '2',
				skillPath: '.opencode/skills/a',
				agentName: 'coder',
				taskID: 't2',
				timestamp: '',
				complianceVerdict: 'compliant',
				sessionID: 's1',
			},
			{
				id: '3',
				skillPath: '.opencode/skills/a',
				agentName: 'coder',
				taskID: 't3',
				timestamp: '',
				complianceVerdict: 'violated',
				sessionID: 's1',
			},
			{
				id: '4',
				skillPath: '.opencode/skills/b',
				agentName: 'coder',
				taskID: 't4',
				timestamp: '',
				complianceVerdict: 'violated',
				sessionID: 's1',
			},
			{
				id: '5',
				skillPath: '.opencode/skills/c',
				agentName: 'coder',
				taskID: 't5',
				timestamp: '',
				complianceVerdict: 'compliant',
				sessionID: 's1',
			},
		];
		_internals.readSkillUsageEntriesTail = (() => entries) as any;
		const result = gatherSkillViolations('/tmp/x', 's1');
		// skill c has 0 violations -> excluded; skill a (2) ranks above b (1).
		expect(result.map((r) => r.skillPath)).toEqual([
			'.opencode/skills/a',
			'.opencode/skills/b',
		]);
		expect(result[0].violations).toBe(2);
		expect(result[0].total).toBe(3);
		expect(result[0].scope).toBe('session');
		expect(result[0].tailBounded).toBe(true);
	});

	test('fail-open returns [] on read error', () => {
		_internals.readSkillUsageEntriesTail = (() => {
			throw new Error('read failed');
		}) as any;
		expect(gatherSkillViolations('/tmp/x', 's1')).toEqual([]);
	});
});

// ─── gatherContradictionCandidates ───────────────────────────────────

describe('session-reflection #2077 — gatherContradictionCandidates', () => {
	test('returns [] when sessionStart is undefined', async () => {
		expect(await gatherContradictionCandidates('/tmp/x')).toEqual([]);
	});

	test('detects a sub-dedup-threshold negation-divergent pair (the only production-real shape)', async () => {
		// Two lessons engineered so their Jaccard bigram similarity lands in
		// the [0.45, 0.6) band (5 shared bigrams / 9 union = 0.556) AND they
		// diverge in negation polarity ("always" vs "never"). This is the only
		// shape that can coexist in the active store (the write paths dedup at
		// 0.6), so it is the only shape the band+polarity detector can catch
		// in production (issue #2077 critic item 3).
		const entries: SwarmKnowledgeEntry[] = [
			{
				id: 'new1',
				tier: 'swarm',
				lesson: 'always lock the file before writing data to it',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.5,
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {} as any,
				schema_version: 3,
				created_at: '2026-08-09T01:00:00.000Z',
				updated_at: '',
				project_name: 'p',
			},
			{
				id: 'old1',
				tier: 'swarm',
				lesson: 'never lock the file before writing data',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.5,
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {} as any,
				schema_version: 3,
				created_at: '2026-08-08T01:00:00.000Z',
				updated_at: '',
				project_name: 'p',
			},
		];
		_internals.readKnowledge = (async () => entries) as any;
		const result = await gatherContradictionCandidates(
			'/tmp/x',
			'2026-08-09T00:00:00.000Z',
		);
		expect(result.length).toBe(1);
		expect(result[0].newEntryId).toBe('new1');
		expect(result[0].conflictsWithId).toBe('old1');
		expect(result[0].similarity).toBeGreaterThanOrEqual(0.45);
		expect(result[0].similarity).toBeLessThan(0.6);
	});

	test('does NOT flag a high-similarity non-negation pair (that is a duplicate, not a contradiction)', async () => {
		// Identical lessons -> similarity 1.0 (above the band, and a duplicate),
		// with no negation divergence. Not a contradiction candidate.
		const entries: SwarmKnowledgeEntry[] = [
			{
				id: 'new1',
				tier: 'swarm',
				lesson: 'always run tests after changes',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.5,
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {} as any,
				schema_version: 3,
				created_at: '2026-08-09T01:00:00.000Z',
				updated_at: '',
				project_name: 'p',
			},
			{
				id: 'old1',
				tier: 'swarm',
				lesson: 'always run tests after changes',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.5,
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {} as any,
				schema_version: 3,
				created_at: '2026-08-08T01:00:00.000Z',
				updated_at: '',
				project_name: 'p',
			},
		];
		_internals.readKnowledge = (async () => entries) as any;
		const result = await gatherContradictionCandidates(
			'/tmp/x',
			'2026-08-09T00:00:00.000Z',
		);
		expect(result).toEqual([]);
	});

	test('excludes self and dedups symmetric pairs', async () => {
		// Two session-created negation-divergent entries in the band -> should
		// emit ONE pair (not two symmetric, not a self-match).
		const entries: SwarmKnowledgeEntry[] = [
			{
				id: 'new1',
				tier: 'swarm',
				lesson: 'always lock the file before writing data to it',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.5,
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {} as any,
				schema_version: 3,
				created_at: '2026-08-09T01:00:00.000Z',
				updated_at: '',
				project_name: 'p',
			},
			{
				id: 'new2',
				tier: 'swarm',
				lesson: 'never lock the file before writing data',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.5,
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {} as any,
				schema_version: 3,
				created_at: '2026-08-09T02:00:00.000Z',
				updated_at: '',
				project_name: 'p',
			},
		];
		_internals.readKnowledge = (async () => entries) as any;
		const result = await gatherContradictionCandidates(
			'/tmp/x',
			'2026-08-09T00:00:00.000Z',
		);
		expect(result.length).toBe(1);
	});

	test('fail-open returns [] on read error', async () => {
		_internals.readKnowledge = (async () => {
			throw new Error('read failed');
		}) as any;
		expect(
			await gatherContradictionCandidates('/tmp/x', '2026-08-09T00:00:00.000Z'),
		).toEqual([]);
	});
});

// ─── gatherRealtimeAdmissionCounts ───────────────────────────────────

describe('session-reflection #2077 — gatherRealtimeAdmissionCounts', () => {
	test('returns undefined when sessionStart is undefined', async () => {
		expect(await gatherRealtimeAdmissionCounts('/tmp/x')).toBeUndefined();
	});

	test('counts admitted (insight marker + session created), reinforced (pre-existing confirmed this session), rejected', async () => {
		const entries: SwarmKnowledgeEntry[] = [
			{
				// admitted: created this session with insight marker
				id: 'a1',
				tier: 'swarm',
				lesson: 'lesson one',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.5,
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {} as any,
				schema_version: 3,
				created_at: '2026-08-09T01:00:00.000Z',
				updated_at: '',
				project_name: 'p',
				source_knowledge_ids: ['insight:abc'],
			},
			{
				// reinforced: pre-existing, confirmed this session
				id: 'r1',
				tier: 'swarm',
				lesson: 'lesson two',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.5,
				status: 'established',
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-08-09T02:00:00.000Z',
						project_name: 'p',
					},
				],
				retrieval_outcomes: {} as any,
				schema_version: 3,
				created_at: '2026-08-08T01:00:00.000Z',
				updated_at: '',
				project_name: 'p',
			},
		];
		_internals.readKnowledge = (async () => entries) as any;
		_internals.readRejectedLessons = (async () => [
			{
				id: 'x',
				lesson: 'bad',
				rejection_reason: 'nope',
				rejected_at: '2026-08-09T03:00:00.000Z',
				rejection_layer: 1 as 1,
			},
		]) as any;
		const result = await gatherRealtimeAdmissionCounts(
			'/tmp/x',
			'2026-08-09T00:00:00.000Z',
		);
		expect(result).toEqual({ admitted: 1, reinforced: 1, rejected: 1 });
	});
});
