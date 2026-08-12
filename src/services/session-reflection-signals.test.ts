/**
 * Tests for knowledge-delta signal fields on SessionReflectionData.
 *
 * Covers FR-001 (knowledge-delta summary surfacing) and FR-004 (explicit
 * zero-count outcomes). These tests exercise the data-path only — report
 * rendering is tested separately (task 1.6).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals as reflectionInternals,
	runSessionReflection,
	type SessionReflectionData,
} from './session-reflection';

function emptyToolAggregates() {
	return new Map<
		string,
		{
			tool: string;
			count: number;
			successCount: number;
			failureCount: number;
			totalDuration: number;
		}
	>();
}

function emptyAgentSessions() {
	return new Map<
		string,
		{ agentName: string; lastDelegationReason?: string }
	>();
}

describe('session-reflection — knowledge-delta fields', () => {
	let tempDir: string;

	function makeInput(
		overrides: {
			lessonsStored?: number;
			knowledgeCreated?: number;
			dedupDropCount?: number;
			drainAdmitted?: number;
			drainReinforced?: number;
			drainRejected?: number;
		} = {},
	) {
		return {
			directory: tempDir,
			toolAggregates: emptyToolAggregates(),
			agentSessions: emptyAgentSessions(),
			// No delegate — deterministic fallback, no LLM required
			delegate: undefined,
			...overrides,
		};
	}

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-signals-'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('populates knowledge-delta fields when all inputs provided', async () => {
		const result = await runSessionReflection(
			makeInput({
				lessonsStored: 5,
				knowledgeCreated: 8,
				dedupDropCount: 3,
			}),
		);

		expect(result.data.lessonsStored).toBe(5);
		expect(result.data.knowledgeCreated).toBe(8);
		expect(result.data.dedupDropCount).toBe(3);
	});

	test('defaults knowledge-delta fields to 0 when input fields are absent', async () => {
		const result = await runSessionReflection(makeInput());

		expect(result.data.lessonsStored).toBe(0);
		expect(result.data.knowledgeCreated).toBe(0);
		expect(result.data.dedupDropCount).toBe(0);
		expect(result.data.drainAdmitted).toBe(0);
		expect(result.data.drainReinforced).toBe(0);
		expect(result.data.drainRejected).toBe(0);
	});

	test('FR-004: explicit negatives - zero lessonsStored with nonzero dedupDropCount are surfaced', async () => {
		const result = await runSessionReflection(
			makeInput({
				lessonsStored: 0,
				knowledgeCreated: 0,
				dedupDropCount: 4,
			}),
		);

		// FR-004: explicitly report zero-count outcomes rather than omitting
		expect(result.data.lessonsStored).toBe(0);
		expect(result.data.knowledgeCreated).toBe(0);
		expect(result.data.dedupDropCount).toBe(4);
	});

	test('FR-004: all-zero outcomes are surfaced as explicit zeros', async () => {
		const result = await runSessionReflection(
			makeInput({
				lessonsStored: 0,
				knowledgeCreated: 0,
				dedupDropCount: 0,
			}),
		);

		expect(result.data.lessonsStored).toBe(0);
		expect(result.data.knowledgeCreated).toBe(0);
		expect(result.data.dedupDropCount).toBe(0);
	});

	test('knowledgeCreated can exceed lessonsStored', async () => {
		// knowledgeCreated counts ALL entries created this session,
		// while lessonsStored counts only curation results
		const result = await runSessionReflection(
			makeInput({
				lessonsStored: 2,
				knowledgeCreated: 7,
				dedupDropCount: 1,
			}),
		);

		expect(result.data.lessonsStored).toBe(2);
		expect(result.data.knowledgeCreated).toBe(7);
		expect(result.data.dedupDropCount).toBe(1);
	});
	test('populates drain count fields when provided', async () => {
		const result = await runSessionReflection(
			makeInput({
				drainAdmitted: 3,
				drainReinforced: 1,
				drainRejected: 2,
			}),
		);

		expect(result.data.drainAdmitted).toBe(3);
		expect(result.data.drainReinforced).toBe(1);
		expect(result.data.drainRejected).toBe(2);
	});

	test('defaults drain count fields to 0 when absent', async () => {
		const result = await runSessionReflection(makeInput());

		expect(result.data.drainAdmitted).toBe(0);
		expect(result.data.drainReinforced).toBe(0);
		expect(result.data.drainRejected).toBe(0);
	});

	test('FR-001: drain counts surface alongside knowledge-delta fields', async () => {
		const result = await runSessionReflection(
			makeInput({
				lessonsStored: 2,
				knowledgeCreated: 4,
				dedupDropCount: 1,
				drainAdmitted: 3,
				drainReinforced: 1,
				drainRejected: 2,
			}),
		);

		expect(result.data.lessonsStored).toBe(2);
		expect(result.data.knowledgeCreated).toBe(4);
		expect(result.data.dedupDropCount).toBe(1);
		expect(result.data.drainAdmitted).toBe(3);
		expect(result.data.drainReinforced).toBe(1);
		expect(result.data.drainRejected).toBe(2);
	});
});

describe('drain-summary-accumulator', () => {
	let resetDrainCounters: (sessionID?: string) => void;
	let stashDrainSummary: (
		sessionID: string,
		summary: {
			attempted: number;
			admitted: number;
			reinforced: number;
			rejected: number;
			deferred: number;
			failed: number;
			retries: number;
		},
	) => void;
	let getDrainCounters: (sessionID: string) =>
		| {
				admitted: number;
				reinforced: number;
				rejected: number;
		  }
		| undefined;
	let _internals: {
		getTrackedSessionCount: () => number;
		MAX_TRACKED_SESSIONS: number;
	};

	beforeEach(async () => {
		const mod = await import('../learning/drain-summary-accumulator');
		resetDrainCounters = mod.resetDrainCounters;
		stashDrainSummary = mod.stashDrainSummary;
		getDrainCounters = mod.getDrainCounters;
		_internals = mod._internals;
	});

	afterEach(() => {
		resetDrainCounters();
	});

	test('returns undefined for unknown session', () => {
		expect(getDrainCounters('nonexistent')).toBeUndefined();
	});

	test('returns undefined for empty sessionID', () => {
		expect(getDrainCounters('')).toBeUndefined();
	});

	test('ignores stash with empty sessionID', () => {
		stashDrainSummary('', {
			admitted: 1,
			reinforced: 0,
			rejected: 0,
			attempted: 1,
			deferred: 0,
			failed: 0,
			retries: 0,
		});
		expect(getDrainCounters('')).toBeUndefined();
	});

	test('accumulates counters across multiple drain summaries', () => {
		stashDrainSummary('sess-1', {
			admitted: 2,
			reinforced: 1,
			rejected: 0,
			attempted: 3,
			deferred: 0,
			failed: 0,
			retries: 0,
		});
		stashDrainSummary('sess-1', {
			admitted: 1,
			reinforced: 0,
			rejected: 1,
			attempted: 2,
			deferred: 0,
			failed: 0,
			retries: 0,
		});

		const counters = getDrainCounters('sess-1');
		expect(counters).toBeDefined();
		expect(counters!.admitted).toBe(3);
		expect(counters!.reinforced).toBe(1);
		expect(counters!.rejected).toBe(1);
	});

	test('tracks multiple sessions independently', () => {
		stashDrainSummary('sess-a', {
			admitted: 5,
			reinforced: 0,
			rejected: 2,
			attempted: 7,
			deferred: 0,
			failed: 0,
			retries: 0,
		});
		stashDrainSummary('sess-b', {
			admitted: 1,
			reinforced: 3,
			rejected: 0,
			attempted: 4,
			deferred: 0,
			failed: 0,
			retries: 0,
		});

		expect(getDrainCounters('sess-a')!.admitted).toBe(5);
		expect(getDrainCounters('sess-b')!.reinforced).toBe(3);
	});

	test('FIFO eviction removes oldest session past MAX_TRACKED_SESSIONS', () => {
		const max = _internals.MAX_TRACKED_SESSIONS;

		// Insert MAX_TRACKED_SESSIONS + 1 sessions to trigger eviction of the oldest
		for (let i = 0; i < max + 1; i++) {
			stashDrainSummary(`evict-${i}`, {
				admitted: i + 1,
				reinforced: 0,
				rejected: 0,
				attempted: i + 1,
				deferred: 0,
				failed: 0,
				retries: 0,
			});
		}

		// Tracked count must not exceed MAX_TRACKED_SESSIONS
		expect(_internals.getTrackedSessionCount()).toBe(max);

		// Oldest session (first inserted) must have been evicted
		expect(getDrainCounters('evict-0')).toBeUndefined();

		// Newest session (last inserted) must still be present
		expect(getDrainCounters(`evict-${max}`)).toBeDefined();
		expect(getDrainCounters(`evict-${max}`)!.admitted).toBe(max + 1);
	});

	test('resetDrainCounters clears one session', () => {
		stashDrainSummary('sess-1', {
			admitted: 1,
			reinforced: 0,
			rejected: 0,
			attempted: 1,
			deferred: 0,
			failed: 0,
			retries: 0,
		});
		stashDrainSummary('sess-2', {
			admitted: 2,
			reinforced: 0,
			rejected: 0,
			attempted: 2,
			deferred: 0,
			failed: 0,
			retries: 0,
		});

		resetDrainCounters('sess-1');
		expect(getDrainCounters('sess-1')).toBeUndefined();
		expect(getDrainCounters('sess-2')!.admitted).toBe(2);
	});

	test('resetDrainCounters with no argument clears all', () => {
		stashDrainSummary('sess-1', {
			admitted: 1,
			reinforced: 0,
			rejected: 0,
			attempted: 1,
			deferred: 0,
			failed: 0,
			retries: 0,
		});
		stashDrainSummary('sess-2', {
			admitted: 2,
			reinforced: 0,
			rejected: 0,
			attempted: 2,
			deferred: 0,
			failed: 0,
			retries: 0,
		});

		resetDrainCounters();
		expect(getDrainCounters('sess-1')).toBeUndefined();
		expect(getDrainCounters('sess-2')).toBeUndefined();
		expect(_internals.getTrackedSessionCount()).toBe(0);
	});
});

describe('computeDedupDropCount — close.ts dedup arithmetic', () => {
	let computeDedupDropCount: (
		retroLessons: string[],
		existingLessonTexts: Set<string>,
	) => number;

	beforeEach(async () => {
		const { _internals } = await import('../commands/close');
		computeDedupDropCount = _internals.computeDedupDropCount;
	});

	test('returns count of retro lessons matching existing normalized texts', () => {
		const retroLessons = [
			'lesson A',
			'lesson B',
			'lesson C',
			'lesson D',
			'lesson E',
		];
		const existing = new Set(['lesson a', 'lesson b', 'lesson c']);
		// normalizeLessonText lowercases+trims, so 'lesson A' matches 'lesson a'
		expect(computeDedupDropCount(retroLessons, existing)).toBe(3);
	});

	test('returns 0 when no retro lessons match existing texts', () => {
		const retroLessons = ['X', 'Y'];
		const existing = new Set(['A', 'B']);
		expect(computeDedupDropCount(retroLessons, existing)).toBe(0);
	});

	test('returns 0 when retroLessons is empty', () => {
		expect(computeDedupDropCount([], new Set(['A', 'B']))).toBe(0);
	});
});

describe('assembleActionMenu — FR-007 action menu assembly', () => {
	function makeData(
		overrides: Partial<SessionReflectionData> = {},
	): SessionReflectionData {
		return {
			timestamp: '2026-01-01T00:00:00Z',
			totalToolCalls: 10,
			totalToolFailures: 1,
			toolProblems: [],
			agentDispatches: [],
			gateFailures: [],
			lessonsFromRetros: [],
			errorTaxonomy: {},
			lessonsStored: 0,
			knowledgeCreated: 0,
			dedupDropCount: 0,
			drainAdmitted: 0,
			drainReinforced: 0,
			drainRejected: 0,
			skillViolationSignals: [],
			nearDuplicateCandidates: [],
			draftedIssueCandidates: [],
			...overrides,
		};
	}

	test('produces numbered menu with correct items and targetTools', () => {
		const menu = reflectionInternals.assembleActionMenu(
			makeData({
				skillViolationSignals: [
					{ skillPath: '.opencode/skills/test/SKILL.md', violationCount: 3 },
				],
				nearDuplicateCandidates: [
					{
						sessionEntryText: 'Always use path.join',
						existingEntryText: 'Always use path.join for paths',
						existingEntryId: 'abc-123',
					},
				],
				draftedIssueCandidates: [
					{
						title: 'dup-issue',
						body: 'body A',
						errorCategory: 'cat-a',
						evidence: 'ev',
					},
				],
				lessonsStored: 5,
			}),
		);

		expect(menu).toHaveLength(4);
		const tools = menu.map((item) => item.targetTool);
		expect(tools).toEqual([
			'skill_improve',
			'knowledge_add',
			'gh issue create',
			'skill_generate',
		]);
		expect(menu[0].description).toContain('skill violations');
		expect(menu[1].description).toContain('near-duplicate');
		expect(menu[2].description).toContain('File issue');
		expect(menu[3].description).toContain('Compile 5');
	});

	test('deduplication removes duplicate descriptions', () => {
		const menu = reflectionInternals.assembleActionMenu(
			makeData({
				draftedIssueCandidates: [
					{ title: 'dup-issue', body: 'A', errorCategory: 'a', evidence: 'e' },
					{ title: 'dup-issue', body: 'B', errorCategory: 'b', evidence: 'e' },
				],
			}),
		);
		expect(menu).toHaveLength(1);
	});

	test('caps at 12 items and re-numbers', () => {
		const violations = Array.from({ length: 15 }, (_, i) => ({
			skillPath: `skill-${i}`,
			violationCount: 1,
		}));
		const menu = reflectionInternals.assembleActionMenu(
			makeData({ skillViolationSignals: violations }),
		);
		expect(menu).toHaveLength(12);
		expect(menu[0].number).toBe(1);
		expect(menu[11].number).toBe(12);
	});

	test('empty data produces empty menu', () => {
		expect(reflectionInternals.assembleActionMenu(makeData())).toHaveLength(0);
	});
});
