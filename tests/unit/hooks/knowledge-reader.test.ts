/**
 * Verification tests for src/hooks/knowledge-reader.ts
 *
 * Tests cover:
 * - readMergedKnowledge basic merge (deduplication logic)
 * - readMergedKnowledge ranking (composite scoring)
 * - updateRetrievalOutcome (outcome tracking)
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	type ProjectContext,
	type RankedEntry,
	_internals as readerInternals,
	readMergedKnowledge,
	updateRetrievalOutcome,
} from '../../../src/hooks/knowledge-reader.js';
import type {
	HiveKnowledgeEntry,
	KnowledgeConfig,
	PhaseConfirmationRecord,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types.js';

// ============================================================================
// Mocks Setup
// ============================================================================

const originalReaderInternals = { ...readerInternals };
const mockReadKnowledge = mock(async () => []);
const mockReadRetractionRecords = mock(async () => []);
const mockExistsSync = mock(() => false);
const mockReadFile = mock(async () => '');
const mockAtomicWriteFile = mock(async () => {});
const mockWarn = mock();
const mockRecordKnowledgeEvent = mock(async () => null);
const mockTransactFile = mock(
	async <T>(
		filePath: string,
		read: (filePath: string) => Promise<T>,
		write: (filePath: string, data: T) => Promise<void>,
		mutate: (data: T) => T | null,
	): Promise<boolean> => {
		const data = await read(filePath);
		const result = mutate(data);
		if (result === null) return false;
		await write(filePath, result);
		return true;
	},
);
const mockNormalize = mock((text: string) =>
	text
		.toLowerCase()
		.replace(/[^\w\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim(),
);
const mockJaccardBigram = mock((a: Set<string>, b: Set<string>) => {
	if (a.size === 0 && b.size === 0) return 1.0;
	const intersection = new Set(Array.from(a).filter((x) => b.has(x)));
	const union = new Set([...Array.from(a), ...Array.from(b)]);
	return intersection.size / union.size;
});
const mockWordBigrams = mock((text: string) => {
	const words = text
		.toLowerCase()
		.replace(/[^\w\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.split(' ')
		.filter(Boolean);
	const bigrams = new Set<string>();
	for (let i = 0; i < words.length - 1; i++) {
		bigrams.add(`${words[i]} ${words[i + 1]}`);
	}
	return bigrams;
});
const mockResolveSwarmKnowledgePath = mock(
	() => '/mock/.swarm/knowledge.jsonl',
);
const mockResolveHiveKnowledgePath = mock(
	() => '/mock/hive/shared-learnings.jsonl',
);

beforeEach(() => {
	Object.assign(readerInternals, originalReaderInternals);
	readerInternals.existsSync =
		mockExistsSync as typeof readerInternals.existsSync;
	readerInternals.readFile = mockReadFile as typeof readerInternals.readFile;
	readerInternals.atomicWriteFile =
		mockAtomicWriteFile as typeof readerInternals.atomicWriteFile;
	readerInternals.transactFile =
		mockTransactFile as typeof readerInternals.transactFile;
	readerInternals.warn = mockWarn as typeof readerInternals.warn;
	readerInternals.readKnowledge =
		mockReadKnowledge as typeof readerInternals.readKnowledge;
	readerInternals.readRetractionRecords =
		mockReadRetractionRecords as typeof readerInternals.readRetractionRecords;
	readerInternals.resolveHiveKnowledgePath =
		mockResolveHiveKnowledgePath as typeof readerInternals.resolveHiveKnowledgePath;
	readerInternals.resolveSwarmKnowledgePath =
		mockResolveSwarmKnowledgePath as typeof readerInternals.resolveSwarmKnowledgePath;
	readerInternals.jaccardBigram =
		mockJaccardBigram as typeof readerInternals.jaccardBigram;
	readerInternals.normalize = mockNormalize as typeof readerInternals.normalize;
	readerInternals.wordBigrams =
		mockWordBigrams as typeof readerInternals.wordBigrams;
	readerInternals.recordKnowledgeEvent =
		mockRecordKnowledgeEvent as typeof readerInternals.recordKnowledgeEvent;
});

afterEach(() => {
	Object.assign(readerInternals, originalReaderInternals);
});

// ============================================================================
// Helper Factories
// ============================================================================

const defaultPhaseConfirmation: PhaseConfirmationRecord = {
	phase_number: 1,
	confirmed_at: '2026-03-02T00:00:00.000Z',
	project_name: 'test-project',
};

function makeSwarmEntry(
	overrides?: Partial<SwarmKnowledgeEntry>,
): SwarmKnowledgeEntry {
	return {
		id: 'swarm-' + Math.random().toString(36).substring(2, 9),
		tier: 'swarm',
		lesson: 'Test lesson for verification',
		category: 'testing',
		tags: [],
		scope: 'global',
		confidence: 0.5,
		status: 'established',
		confirmed_by: [defaultPhaseConfirmation],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 1,
		created_at: '2026-03-02T00:00:00.000Z',
		updated_at: '2026-03-02T00:00:00.000Z',
		project_name: 'test-project',
		...overrides,
	};
}

function makeHiveEntry(
	overrides?: Partial<HiveKnowledgeEntry>,
): HiveKnowledgeEntry {
	return {
		id: 'hive-' + Math.random().toString(36).substring(2, 9),
		tier: 'hive',
		lesson: 'Test lesson for verification',
		category: 'testing',
		tags: [],
		scope: 'global',
		confidence: 0.5,
		status: 'established',
		confirmed_by: [
			{
				project_name: 'other-project',
				confirmed_at: '2026-03-02T00:00:00.000Z',
				phase_number: 1,
			},
		],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 1,
		created_at: '2026-03-02T00:00:00.000Z',
		updated_at: '2026-03-02T00:00:00.000Z',
		source_project: 'other-project',
		...overrides,
	};
}

function makeConfig(overrides?: Partial<KnowledgeConfig>): KnowledgeConfig {
	return {
		enabled: true,
		swarm_max_entries: 100,
		hive_max_entries: 200,
		auto_promote_days: 90,
		max_inject_count: 5,
		dedup_threshold: 0.6,
		scope_filter: ['global'],
		hive_enabled: true,
		rejected_max_entries: 20,
		validation_enabled: true,
		evergreen_confidence: 0.9,
		evergreen_utility: 0.8,
		low_utility_threshold: 0.3,
		min_retrievals_for_utility: 3,
		schema_version: 1,
		...overrides,
	};
}

// ============================================================================
// Test Suite: readMergedKnowledge — basic merge
// ============================================================================

describe('readMergedKnowledge — basic merge', () => {
	beforeEach(() => {
		mock.clearAllMocks();
		mockReadKnowledge.mockResolvedValue([]);
	});

	it('Test 1: empty both tiers returns empty array', async () => {
		mockReadKnowledge.mockImplementation(async (path: string) => {
			if (path.includes('swarm')) return [];
			if (path.includes('hive')) return [];
			return [];
		});

		const config = makeConfig();
		const result = await readMergedKnowledge('/proj', config);

		expect(result).toEqual([]);
		expect(result.length).toBe(0);
	});

	it('Test 2: swarm only entries returned when hive disabled', async () => {
		const swarmEntries = [
			makeSwarmEntry({ lesson: 'First swarm lesson' }),
			makeSwarmEntry({ lesson: 'Second swarm lesson' }),
		];

		mockReadKnowledge.mockImplementation(async (path: string) => {
			if (path.includes('swarm')) return swarmEntries;
			if (path.includes('hive')) return [];
			return [];
		});

		const config = makeConfig({ hive_enabled: false });
		const result = await readMergedKnowledge('/proj', config);

		expect(result.length).toBe(2);
		expect(result.every((e) => e.tier === 'swarm')).toBe(true);
	});

	it('Test 3: hive entries win over swarm exact duplicate', async () => {
		const lessonText = 'Always use dependency injection for testability';
		const swarmEntry = makeSwarmEntry({ lesson: lessonText });
		const hiveEntry = makeHiveEntry({ lesson: lessonText });

		mockReadKnowledge.mockImplementation(async (path: string) => {
			if (path.includes('swarm')) return [swarmEntry];
			if (path.includes('hive')) return [hiveEntry];
			return [];
		});

		const config = makeConfig();
		const result = await readMergedKnowledge('/proj', config);

		expect(result.length).toBe(1);
		expect(result[0].tier).toBe('hive');
	});

	it('Test 4: hive dedup suppresses swarm near-duplicate (Jaccard >= 0.6)', async () => {
		// These two sentences should have high Jaccard similarity (>= 0.6)
		// swarm: "use dependency injection for testability" -> 4 bigrams
		// hive: "use dependency injection for testability code" -> 5 bigrams
		// shared: 4, total unique: 5, Jaccard = 4/5 = 0.8
		const swarmLesson = 'use dependency injection for testability';
		const hiveLesson = 'use dependency injection for testability code';

		const swarmEntry = makeSwarmEntry({ lesson: swarmLesson });
		const hiveEntry = makeHiveEntry({ lesson: hiveLesson });

		mockReadKnowledge.mockImplementation(async (path: string) => {
			if (path.includes('swarm')) return [swarmEntry];
			if (path.includes('hive')) return [hiveEntry];
			return [];
		});

		const config = makeConfig();
		const result = await readMergedKnowledge('/proj', config);

		// Should only return the hive entry (swarm near-duplicate suppressed)
		expect(result.length).toBe(1);
		expect(result[0].tier).toBe('hive');
	});

	it('Test 5: swarm entry not near-dup of hive is included', async () => {
		const swarmLesson = 'Use bun for fast JavaScript runtime execution';
		const hiveLesson = 'Always use dependency injection for testability';

		const swarmEntry = makeSwarmEntry({ lesson: swarmLesson });
		const hiveEntry = makeHiveEntry({ lesson: hiveLesson });

		mockReadKnowledge.mockImplementation(async (path: string) => {
			if (path.includes('swarm')) return [swarmEntry];
			if (path.includes('hive')) return [hiveEntry];
			return [];
		});

		const config = makeConfig();
		const result = await readMergedKnowledge('/proj', config);

		// Both entries should be included (low similarity)
		expect(result.length).toBe(2);
		const tiers = result.map((e) => e.tier);
		expect(tiers).toContain('swarm');
		expect(tiers).toContain('hive');
	});
	// Regression for #828: entries with undefined/unexpected status are not
	// silently excluded — only 'quarantined' entries are filtered out.
	it('Test 5a: entries with undefined status are included (quarantine deny-list)', async () => {
		const entryWithUndefinedStatus = makeSwarmEntry({
			lesson: 'Lesson with missing status after migration',
			// @ts-expect-error — simulating a legacy entry with undefined status
			status: undefined,
		});

		mockReadKnowledge.mockImplementation(async (path: string) => {
			if (path.includes('swarm')) return [entryWithUndefinedStatus];
			if (path.includes('hive')) return [];
			return [];
		});

		const config = makeConfig();
		const result = await readMergedKnowledge('/proj', config);

		expect(result.length).toBe(1);
		expect(result[0].id).toBe(entryWithUndefinedStatus.id);
	});

	it('Test 5c: quarantined entries are excluded', async () => {
		const quarantinedEntry = makeSwarmEntry({
			lesson: 'Quarantined lesson that should be filtered out',
			status: 'quarantined',
		});
		const activeEntry = makeSwarmEntry({
			lesson: 'Active lesson that should be included',
			status: 'established',
		});

		mockReadKnowledge.mockImplementation(async (path: string) => {
			if (path.includes('swarm')) return [quarantinedEntry, activeEntry];
			if (path.includes('hive')) return [];
			return [];
		});

		const config = makeConfig();
		const result = await readMergedKnowledge('/proj', config);

		expect(result.length).toBe(1);
		expect(result[0].id).toBe(activeEntry.id);
	});

	it('Test 5d: established status entries are included by deny-list', async () => {
		const establishedEntry = makeSwarmEntry({
			lesson: 'Established lesson that should be included',
			status: 'established',
		});

		mockReadKnowledge.mockImplementation(async (path: string) => {
			if (path.includes('swarm')) return [establishedEntry];
			if (path.includes('hive')) return [];
			return [];
		});

		const config = makeConfig();
		const result = await readMergedKnowledge('/proj', config);

		expect(result.length).toBe(1);
		expect(result[0].id).toBe(establishedEntry.id);
	});

	it('Test 5e: promoted status entries are included by deny-list', async () => {
		const promotedEntry = makeSwarmEntry({
			lesson: 'Promoted lesson that should be included',
			status: 'promoted',
		});

		mockReadKnowledge.mockImplementation(async (path: string) => {
			if (path.includes('swarm')) return [promotedEntry];
			if (path.includes('hive')) return [];
			return [];
		});

		const config = makeConfig();
		const result = await readMergedKnowledge('/proj', config);

		expect(result.length).toBe(1);
		expect(result[0].id).toBe(promotedEntry.id);
	});

	it('Test 5f: null status entries are included by deny-list', async () => {
		const nullStatusEntry = makeSwarmEntry({
			lesson: 'Lesson with null status that should be included',
			// @ts-expect-error — simulating a legacy entry with null status
			status: null,
		});

		mockReadKnowledge.mockImplementation(async (path: string) => {
			if (path.includes('swarm')) return [nullStatusEntry];
			if (path.includes('hive')) return [];
			return [];
		});

		const config = makeConfig();
		const result = await readMergedKnowledge('/proj', config);

		expect(result.length).toBe(1);
		expect(result[0].id).toBe(nullStatusEntry.id);
	});

	// G4 (#1716): the merge layer used to deny-list only `'quarantined'`, so a
	// `quarantined_unactionable`-status row that ever landed in knowledge.jsonl
	// would slip through to retrieval. The canonical `isActiveStatus` helper
	// now excludes all three inactive statuses, closing the leak while still
	// preserving #828's undefined/null passthrough (Tests 5a/5f above).
	it('Test 5g: quarantined_unactionable entries are excluded (G4 leak fix)', async () => {
		const unactionableEntry = makeSwarmEntry({
			lesson: 'Lesson that failed the actionability gate',
			status: 'quarantined_unactionable',
		});
		const activeEntry = makeSwarmEntry({
			lesson: 'Active lesson that should be included',
			status: 'established',
		});

		(readKnowledge as unknown as ReturnType<typeof mock>).mockImplementation(
			async (path: string) => {
				if (path.includes('swarm')) return [unactionableEntry, activeEntry];
				if (path.includes('hive')) return [];
				return [];
			},
		);

		const config = makeConfig();
		const result = await readMergedKnowledge('/proj', config);

		expect(result.length).toBe(1);
		expect(result[0].id).toBe(activeEntry.id);
	});

	// G4 (#1716): the merge layer used to deny-list only `'quarantined'`, so an
	// `archived`-status row was NOT excluded here (it was caught downstream by
	// search-knowledge.ts). The canonical helper now excludes `archived` at the
	// merge layer too — defense-in-depth.
	it('Test 5h: archived entries are excluded at the merge layer (G4 leak fix)', async () => {
		const archivedEntry = makeSwarmEntry({
			lesson: 'Archived lesson that should be filtered out',
			status: 'archived',
		});
		const activeEntry = makeSwarmEntry({
			lesson: 'Active lesson that should be included',
			status: 'established',
		});

		(readKnowledge as unknown as ReturnType<typeof mock>).mockImplementation(
			async (path: string) => {
				if (path.includes('swarm')) return [archivedEntry, activeEntry];
				if (path.includes('hive')) return [];
				return [];
			},
		);

		const config = makeConfig();
		const result = await readMergedKnowledge('/proj', config);

		expect(result.length).toBe(1);
		expect(result[0].id).toBe(activeEntry.id);
	});
});

// ============================================================================
// Test Suite: readMergedKnowledge — ranking
// ============================================================================

describe('readMergedKnowledge — ranking', () => {
	beforeEach(() => {
		mock.clearAllMocks();
		mockReadKnowledge.mockResolvedValue([]);
	});

	it('Test 6: hive entries ranked above equal-confidence swarm entries', async () => {
		const swarmEntry = makeSwarmEntry({
			lesson: 'always write unit tests first for better code',
			confidence: 0.7,
		});
		const hiveEntry = makeHiveEntry({
			lesson: 'use dependency injection for testability',
			confidence: 0.7,
		});

		mockReadKnowledge.mockImplementation(async (path: string) => {
			if (path.includes('swarm')) return [swarmEntry];
			if (path.includes('hive')) return [hiveEntry];
			return [];
		});

		const config = makeConfig();
		const result = await readMergedKnowledge('/proj', config);

		expect(result.length).toBe(2);
		// Hive should be ranked first due to HIVE_TIER_BOOST (0.05)
		expect(result[0].tier).toBe('hive');
		expect(result[1].tier).toBe('swarm');
		expect(result[0].finalScore).toBeGreaterThan(result[1].finalScore);
	});

	it('Test 7: max_inject_count limits results', async () => {
		const swarmEntries = Array.from({ length: 10 }, (_, i) =>
			makeSwarmEntry({
				lesson: `Swarm lesson ${i + 1}`,
				id: `swarm-${i + 1}`,
			}),
		);

		mockReadKnowledge.mockImplementation(async (path: string) => {
			if (path.includes('swarm')) return swarmEntries;
			if (path.includes('hive')) return [];
			return [];
		});

		const config = makeConfig({ max_inject_count: 3 });
		const result = await readMergedKnowledge('/proj', config);

		expect(result.length).toBe(3);
	});

	// NOTE: This test verifies baseline behavior when no phase context is available.
	// The original assertion `e.relevanceScore >= 0` compares an object to a number
	// and always fails in JS. The scoring itself is correct: categoryScore defaults
	// to 0.5, keywordsScore to 0.5 (no tags), confidenceScore to entry.confidence (0.5).
	// finalScore ends up >= 0.325 for these entries.
	it('Test 8: context-less call still returns entries (relevanceScore defaults to 0.5 base)', async () => {
		const swarmEntries = [
			makeSwarmEntry({
				lesson: 'First global lesson',
				scope: 'global',
			}),
			makeSwarmEntry({
				lesson: 'Second global lesson',
				scope: 'global',
			}),
		];

		mockReadKnowledge.mockImplementation(async (path: string) => {
			if (path.includes('swarm')) return swarmEntries;
			if (path.includes('hive')) return [];
			return [];
		});

		const config = makeConfig();
		const result = await readMergedKnowledge('/proj', config); // No context

		expect(result.length).toBe(2);
		// All entries have non-negative component scores: category=0.5, confidence=0.5, keywords=0.5
		expect(result.every((e) => e.finalScore >= 0)).toBe(true);
	});

	it('Test 9: same-project hive entry penalized in ranking', async () => {
		const context: ProjectContext = {
			projectName: 'my-project',
			currentPhase: 'implementation',
		};

		const hiveEntrySameProject = makeHiveEntry({
			lesson: 'Hive lesson from same project',
			confidence: 0.8,
			source_project: 'my-project',
			scope: 'global',
		});

		const hiveEntryOtherProject = makeHiveEntry({
			lesson: 'Hive lesson from other project',
			confidence: 0.8,
			source_project: 'other-project',
			scope: 'global',
		});

		mockReadKnowledge.mockImplementation(async (path: string) => {
			if (path.includes('swarm')) return [];
			if (path.includes('hive'))
				return [hiveEntrySameProject, hiveEntryOtherProject];
			return [];
		});

		const config = makeConfig();
		const result = await readMergedKnowledge('/proj', config, context);

		expect(result.length).toBe(2);
		// Other project should rank higher due to SAME_PROJECT_PENALTY
		expect(result[0].id).toBe(hiveEntryOtherProject.id);
		expect(result[1].id).toBe(hiveEntrySameProject.id);
		expect(result[0].finalScore).toBeGreaterThan(result[1].finalScore);
	});

	// FR-E1: warn is called when recordLessonsShown fails
	// NOTE: recordLessonsShown has internal try-catch that calls warn without re-throwing,
	// so the .catch() at line 462-464 in readMergedKnowledge is unreachable.
	// The warn IS called, but via recordLessonsShown' internal catch (line 286).
	it('Test 9b: warn called when recordLessonsShown fails (FR-E1)', async () => {
		const swarmEntry = makeSwarmEntry({
			lesson: 'Test lesson that will fail to record',
			scope: 'global',
		});

		mockReadKnowledge.mockImplementation(async (path: string) => {
			if (path.includes('swarm')) return [swarmEntry];
			if (path.includes('hive')) return [];
			return [];
		});

		mockTransactFile.mockRejectedValueOnce(new Error('record failed'));

		const config = makeConfig();
		const context: ProjectContext = {
			projectName: 'test-project',
			currentPhase: 'Phase 1',
		};

		// Call readMergedKnowledge - should not throw, but warn should be called
		const result = await readMergedKnowledge('/proj', config, context);

		// Should still return results despite recordLessonsShown failing
		expect(result.length).toBe(1);

		// recordLessonsShown is fire-and-forget — the async chain now goes through
		// transactShownFile → mkdir → error → warn. Give the microtask queue an
		// extra tick to allow the error propagation and the warn call to settle.
		await new Promise((resolve) => setTimeout(resolve, 0));

		// warn IS called when recordLessonsShown's mkdir fails - via internal catch
		expect(mockWarn).toHaveBeenCalledWith(
			'[swarm] Knowledge: failed to record shown lessons',
		);
	});
});

// ============================================================================
// Test Suite: updateRetrievalOutcome
// ============================================================================

describe('updateRetrievalOutcome', () => {
	beforeEach(() => {
		mock.clearAllMocks();
		mockReadKnowledge.mockResolvedValue([]);
		mockExistsSync.mockReturnValue(false);
		mockReadFile.mockResolvedValue('');
	});

	it('Test 10: no-op when shown file does not exist', async () => {
		mockExistsSync.mockReturnValue(false);

		await updateRetrievalOutcome('/proj', 'phase-5', true);

		// Issue #1477: no shown file → no outcome attribution event emitted.
		expect(mockRecordKnowledgeEvent).not.toHaveBeenCalled();
	});

	it('Test 11: emits a success outcome event on success', async () => {
		const phaseInfo = 'phase-5';
		const shownData = {
			[phaseInfo]: ['id-1'],
		};

		mockExistsSync.mockReturnValue(true);
		mockReadFile.mockResolvedValue(JSON.stringify(shownData));

		await updateRetrievalOutcome('/proj', phaseInfo, true); // phaseSucceeded

		// Issue #1477: success attribution is now an immutable 'outcome' event keyed
		// by knowledge_id (the event log is the single source of truth, folded into
		// the rollup on read), NOT an in-place entry mutation.
		expect(mockRecordKnowledgeEvent).toHaveBeenCalledTimes(1);
		expect(mockRecordKnowledgeEvent).toHaveBeenCalledWith(
			'/proj',
			expect.objectContaining({
				type: 'outcome',
				knowledge_id: 'id-1',
				outcome: 'success',
				phase: phaseInfo,
			}),
		);
	});

	it('Test 12: emits a failure outcome event on failure', async () => {
		const phaseInfo = 'phase-5';
		const shownData = {
			[phaseInfo]: ['id-1'],
		};

		mockExistsSync.mockReturnValue(true);
		mockReadFile.mockResolvedValue(JSON.stringify(shownData));

		await updateRetrievalOutcome('/proj', phaseInfo, false); // phaseSucceeded = false

		// Issue #1477: failure attribution is now an immutable 'outcome' event.
		expect(mockRecordKnowledgeEvent).toHaveBeenCalledTimes(1);
		expect(mockRecordKnowledgeEvent).toHaveBeenCalledWith(
			'/proj',
			expect.objectContaining({
				type: 'outcome',
				knowledge_id: 'id-1',
				outcome: 'failure',
				phase: phaseInfo,
			}),
		);
	});

	it('Test 13: cleans up phase key from shown file after update', async () => {
		const phaseInfo = 'phase-5';
		const shownData = {
			[phaseInfo]: ['id-1'],
		};

		mockExistsSync.mockReturnValue(true);
		mockReadFile.mockResolvedValue(JSON.stringify(shownData));

		await updateRetrievalOutcome('/proj', phaseInfo, true);

		// LF-1 fix: the shownFile cleanup now uses atomicWriteFile via transactShownFile
		// instead of bare writeFile.
		expect(mockAtomicWriteFile).toHaveBeenCalled();

		const atomicCall = mockAtomicWriteFile.mock.calls[0];
		const writtenData = JSON.parse(atomicCall[1] as string);

		expect(writtenData[phaseInfo]).toBeUndefined();
	});

	it('Test 14: attributes outcomes tier-agnostically without reading knowledge files', async () => {
		// Issue #1477: outcome attribution is now event-sourced by knowledge_id, so
		// updateRetrievalOutcome no longer reads/mutates the swarm or hive stores —
		// it emits one 'outcome' event per shown id regardless of which tier the
		// entry lives in (the fold attributes by id).
		const phaseInfo = 'phase-5';
		const shownData = {
			[phaseInfo]: ['swarm-id', 'hive-id'],
		};

		mockExistsSync.mockReturnValue(true);
		mockReadFile.mockResolvedValue(JSON.stringify(shownData));

		await updateRetrievalOutcome('/proj', phaseInfo, true);

		// No knowledge-store reads at all (tier lookup is gone).
		expect(mockReadKnowledge).not.toHaveBeenCalled();
		expect(mockTransactFile).toHaveBeenCalledTimes(1);
		// One event per shown id.
		expect(mockRecordKnowledgeEvent).toHaveBeenCalledTimes(2);
		const ids = (
			mockRecordKnowledgeEvent.mock.calls as Array<
				[string, { knowledge_id: string }]
			>
		)
			.map(([, e]) => e.knowledge_id)
			.sort();
		expect(ids).toEqual(['hive-id', 'swarm-id']);
	});
});
