/**
 * Issue #2077 — session-reflection signal REPORT tests (builders + integration).
 *
 * Split from session-reflection.signals.test.ts (FR-006: test files < 500
 * lines). This file covers the pure signal-block/menu builders and the
 * runSessionReflection integration (both-paths signalsReport, realtime
 * admission merge + render, deterministic no-embed regression pin).
 *
 * Uses _internals DI seam. No mock.module.
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
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir';
import {
	_internals,
	buildActionMenu,
	buildActionProposals,
	buildSignalsBlock,
	type ContradictionCandidate,
	type KnowledgeDelta,
	type ReflectionActionProposal,
	runSessionReflection,
	type SessionReflectionData,
} from './session-reflection';

setDefaultTimeout(30_000);

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

// ─── buildSignalsBlock ───────────────────────────────────────────────

describe('session-reflection #2077 — buildSignalsBlock', () => {
	test('emits Knowledge Delta with the NOOP/negative line when nothing captured', () => {
		const kd: KnowledgeDelta = {
			sessionKnowledgeCreated: 0,
			dedupDropped: 0,
			dedupAvailable: true,
			retroLessonTotal: 0,
		};
		const block = buildSignalsBlock(makeData({ knowledgeDelta: kd }));
		expect(block).toContain('## Session Signals');
		expect(block).toContain('0 lessons captured; 0 deduped as already-known.');
	});

	test('emits dedup-unavailable note when dedupAvailable is false', () => {
		const kd: KnowledgeDelta = {
			sessionKnowledgeCreated: 0,
			dedupDropped: 0,
			dedupAvailable: false,
			retroLessonTotal: 0,
		};
		const block = buildSignalsBlock(makeData({ knowledgeDelta: kd }));
		expect(block).toContain('dedup unavailable');
	});

	test('emits dedup count when lessons were deduped', () => {
		const kd: KnowledgeDelta = {
			sessionKnowledgeCreated: 2,
			dedupDropped: 3,
			dedupAvailable: true,
			retroLessonTotal: 5,
		};
		const block = buildSignalsBlock(makeData({ knowledgeDelta: kd }));
		expect(block).toContain('3 retro lesson(s) deduped as already-known.');
	});

	test('emits skill violations with session scope label', () => {
		const block = buildSignalsBlock(
			makeData({
				skillViolations: [
					{
						skillPath: '.opencode/skills/x',
						violations: 2,
						total: 5,
						tailBounded: true,
						scope: 'session',
					},
				],
			}),
		);
		expect(block).toContain('Skill Compliance Signals');
		expect(block).toContain('[this session]');
		expect(block).toContain('.opencode/skills/x: 2 violation(s)');
	});

	test('emits contradiction candidates as advisory', () => {
		const cc: ContradictionCandidate = {
			newLesson: 'always x',
			newEntryId: 'n1',
			conflictsWithId: 'o1',
			conflictsWithLesson: 'never x',
			similarity: 0.5,
		};
		const block = buildSignalsBlock(
			makeData({ contradictionCandidates: [cc] }),
		);
		expect(block).toContain('Contradiction Candidates');
		expect(block).toContain('candidate supersede');
	});

	test('emits issue candidates only when repro evidence exists', () => {
		const block = buildSignalsBlock(
			makeData({
				gateFailures: [{ gate: 'reviewer', taskId: '1.1', count: 2 }],
				toolProblems: [
					{
						tool: 'bash',
						failureCount: 5,
						totalCalls: 10,
						failureRate: 0.5,
						avgDurationMs: 100,
					},
				],
			}),
		);
		expect(block).toContain('Issue Candidates');
		expect(block).toContain('Gate reviewer rejected');
		expect(block).toContain('Tool bash failing');
	});
});

// ─── buildActionMenu + buildActionProposals ─────────────────────────

describe('session-reflection #2077 — buildActionMenu', () => {
	test('returns empty string when no proposals', () => {
		expect(buildActionMenu([], false)).toBe('');
	});

	test('numbered menu with reply prompt when not full-auto', () => {
		const proposals: ReflectionActionProposal[] = [
			{
				kind: 'supersede',
				label: 'SUPERSEDE o1',
				detail: 'd',
				routing: '/swarm curate',
			},
		];
		const menu = buildActionMenu(proposals, false);
		expect(menu).toContain('reply with numbers');
		expect(menu).toContain('[1] SUPERSEDE o1 → /swarm curate');
		expect(menu).not.toContain('reported-only');
	});

	test('reported-only suffix when full-auto (no prompt)', () => {
		const proposals: ReflectionActionProposal[] = [
			{
				kind: 'file_issue',
				label: 'FILE issue',
				detail: 'd',
				routing: 'gh issue create',
			},
		];
		const menu = buildActionMenu(proposals, true);
		expect(menu.toLowerCase()).toContain('reported-only');
		expect(menu).not.toContain('reply with numbers');
	});
});

describe('session-reflection #2077 — buildActionProposals', () => {
	test('never produces a capture proposal (critic item 7)', () => {
		const proposals = buildActionProposals(
			makeData({
				knowledgeDelta: {
					sessionKnowledgeCreated: 0,
					dedupDropped: 0,
					dedupAvailable: true,
					retroLessonTotal: 0,
				},
			}),
		);
		expect(proposals.every((p) => p.kind !== 'capture')).toBe(true);
	});

	test('produces supersede from contradiction candidates', () => {
		const proposals = buildActionProposals(
			makeData({
				contradictionCandidates: [
					{
						newLesson: 'always x',
						newEntryId: 'n1',
						conflictsWithId: 'o1',
						conflictsWithLesson: 'never x',
						similarity: 0.5,
					},
				],
			}),
		);
		expect(proposals.some((p) => p.kind === 'supersede')).toBe(true);
	});
});

// ─── runSessionReflection — critic item 1 regression ────────────────

describe('session-reflection #2077 — signalsReport on both paths', () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = canonicalMkdtemp('session-reflect-2077-');
	});
	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('signalsReport is present on the LLM path (not just deterministic)', async () => {
		const mockDelegate = async () => 'LLM analysis: all clear.';
		_internals.gatherSkillViolations = (() => []) as any;
		_internals.gatherContradictionCandidates = (async () => []) as any;
		_internals.gatherRealtimeAdmissionCounts = (async () => undefined) as any;

		const result = await runSessionReflection({
			directory: tempDir,
			toolAggregates: new Map(),
			agentSessions: new Map(),
			delegate: mockDelegate,
			knowledgeDelta: {
				sessionKnowledgeCreated: 0,
				dedupDropped: 0,
				dedupAvailable: true,
				retroLessonTotal: 0,
			},
		});
		expect(result.source).toBe('llm');
		expect(result.signalsReport).toContain('## Session Signals');
		expect(result.signalsReport).toContain(
			'0 lessons captured; 0 deduped as already-known.',
		);
		expect(Array.isArray(result.actionProposals)).toBe(true);
	});

	test('signalsReport is present on the deterministic path too', async () => {
		_internals.gatherSkillViolations = (() => []) as any;
		_internals.gatherContradictionCandidates = (async () => []) as any;
		_internals.gatherRealtimeAdmissionCounts = (async () => undefined) as any;

		const result = await runSessionReflection({
			directory: tempDir,
			toolAggregates: new Map(),
			agentSessions: new Map(),
			knowledgeDelta: {
				sessionKnowledgeCreated: 1,
				dedupDropped: 2,
				dedupAvailable: true,
				retroLessonTotal: 3,
			},
		});
		expect(result.source).toBe('deterministic');
		expect(result.signalsReport).toContain('## Session Signals');
		expect(result.signalsReport).toContain(
			'2 retro lesson(s) deduped as already-known.',
		);
	});

	test('realtime admission counts merge into knowledgeDelta and render (final-critic item 2)', async () => {
		_internals.gatherSkillViolations = (() => []) as any;
		_internals.gatherContradictionCandidates = (async () => []) as any;
		_internals.gatherRealtimeAdmissionCounts = (async () => ({
			admitted: 2,
			reinforced: 1,
			rejected: 3,
		})) as any;

		const result = await runSessionReflection({
			directory: tempDir,
			toolAggregates: new Map(),
			agentSessions: new Map(),
			knowledgeDelta: {
				sessionKnowledgeCreated: 1,
				dedupDropped: 0,
				dedupAvailable: true,
				retroLessonTotal: 1,
			},
		});
		expect(result.data.knowledgeDelta?.admitted).toBe(2);
		expect(result.data.knowledgeDelta?.reinforcedRealtime).toBe(1);
		expect(result.data.knowledgeDelta?.rejectedCurator).toBe(3);
		expect(result.signalsReport).toContain(
			'Realtime admission: 2 admitted, 1 reinforced, 3 curator-rejected',
		);
		expect(result.signalsReport).toContain('#1821');
	});

	test('deterministic architectReport does NOT embed the signals block (final-critic item 4)', async () => {
		_internals.gatherSkillViolations = (() => []) as any;
		_internals.gatherContradictionCandidates = (async () => []) as any;
		_internals.gatherRealtimeAdmissionCounts = (async () => undefined) as any;

		const result = await runSessionReflection({
			directory: tempDir,
			toolAggregates: new Map(),
			agentSessions: new Map(),
			knowledgeDelta: {
				sessionKnowledgeCreated: 1,
				dedupDropped: 0,
				dedupAvailable: true,
				retroLessonTotal: 1,
			},
		});
		expect(result.source).toBe('deterministic');
		expect(result.architectReport).not.toContain('## Session Signals');
		expect(result.signalsReport).toContain('## Session Signals');
	});
});
