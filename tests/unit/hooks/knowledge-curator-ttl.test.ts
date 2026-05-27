/**
 * TTL eviction tests for knowledge-curator.ts
 * Tests the pruneSeenRetroSections() function and its behavior with time-based eviction.
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from 'bun:test';

// ============================================================================
// Date.now() mocking setup
// ============================================================================

let mockNow = Date.now();
let dateNowSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	mockNow = 1000000000000; // Fixed base time
	dateNowSpy = spyOn(global.Date, 'now').mockImplementation(() => mockNow);
});

afterEach(() => {
	dateNowSpy?.mockRestore();
});

function advanceTime(ms: number): void {
	mockNow += ms;
}

// ============================================================================
// Module imports (after Date.now is mocked)
// ============================================================================

import {
	createKnowledgeCuratorHook,
	curateAndStoreSwarm,
} from '../../../src/hooks/knowledge-curator.js';
import type { KnowledgeConfig } from '../../../src/hooks/knowledge-types.js';

// ============================================================================
// Other mocks
// ============================================================================

const mockAppendKnowledge = mock(async () => {});
const mockAppendRejectedLesson = mock(async () => {});
const mockFindNearDuplicate = mock(
	(_s: string, _a: unknown[], _n: number) => undefined,
);
const mockReadKnowledge = mock((_s: string) => Promise.resolve([]));
const mockRewriteKnowledge = mock((_s: string, _a: unknown[]) =>
	Promise.resolve(),
);
const mockResolveSwarmKnowledgePath = mock((_s: string) => '');
const mockResolveSwarmRejectedPath = mock((_s: string) => '');
const mockComputeConfidence = mock((_n: number, _b: boolean) => 0);
const mockInferTags = mock((_s: string) => [] as string[]);

const mockReadSwarmFileAsync = mock((_s: string, _f: string) =>
	Promise.resolve(null as string | null),
);
const mockSafeHook = mock((fn: unknown) => fn);
const mockValidateSwarmPath = mock((_d: string, _f: string) => '');

const mockValidateLesson = mock(
	(
		_l: string,
		_t: string[],
		_c: { category: string; scope: string; confidence: number },
	) => ({
		valid: true,
		layer: null,
		reason: null,
		severity: null,
	}),
);
const mockQuarantineEntry = mock(
	(_s: string, _e: string, _r: string, _who: 'architect' | 'user' | 'auto') =>
		Promise.resolve(),
);
const mockNormalize = mock((_s: string) => '');

const mockUpdateRetrievalOutcome = mock(
	(_s: string, _id: string, _b: boolean) => Promise.resolve(),
);

mock.module('../../../src/hooks/knowledge-validator.js', () => ({
	validateLesson: (...args: unknown[]) =>
		mockValidateLesson(
			...(args as [
				string,
				string[],
				{ category: string; scope: string; confidence: number },
			]),
		),
	quarantineEntry: (...args: unknown[]) =>
		mockQuarantineEntry(
			...(args as [string, string, string, 'architect' | 'user' | 'auto']),
		),
}));

mock.module('../../../src/hooks/knowledge-reader.js', () => ({
	updateRetrievalOutcome: (...args: unknown[]) =>
		mockUpdateRetrievalOutcome(...(args as [string, string, boolean])),
}));

mock.module('../../../src/hooks/knowledge-store.js', () => ({
	resolveSwarmKnowledgePath: (...args: unknown[]) =>
		mockResolveSwarmKnowledgePath(...(args as [string])),
	resolveSwarmRejectedPath: (...args: unknown[]) =>
		mockResolveSwarmRejectedPath(...(args as [string])),
	readKnowledge: (...args: unknown[]) =>
		mockReadKnowledge(...(args as [string])),
	appendKnowledge: (...args: unknown[]) => mockAppendKnowledge(...(args as [])),
	appendRejectedLesson: (...args: unknown[]) =>
		mockAppendRejectedLesson(...(args as [])),
	findNearDuplicate: (...args: unknown[]) =>
		mockFindNearDuplicate(...(args as [string, unknown[], number])),
	rewriteKnowledge: (...args: unknown[]) =>
		mockRewriteKnowledge(...(args as [string, unknown[]])),
	computeConfidence: (...args: unknown[]) =>
		mockComputeConfidence(...(args as [number, boolean])),
	inferTags: (...args: unknown[]) => mockInferTags(...(args as [string])),
	normalize: (...args: unknown[]) => mockNormalize(...(args as [string])),
	enforceKnowledgeCap: async () => {},
	sweepAgedEntries: async () => {},
	sweepStaleTodos: async () => {},
	bumpKnowledgeConfidenceBatch: async () => {},
	resolveHiveKnowledgePath: () => '',
	resolveHiveRejectedPath: () => '',
	readRetractionRecords: async () => [],
	appendRetractionRecord: async () => {},
	resolveSwarmRetractionsPath: () => '',
	readRejectedLessons: async () => [],
	normalizeEntry: (e: unknown) => e,
	_internals: {},
	wordBigrams: (_t: string) => new Set<string>(),
	jaccardBigram: () => 0,
	getPlatformConfigDir: () => '/tmp',
}));

mock.module('../../../src/hooks/utils.js', () => ({
	readSwarmFileAsync: (...args: unknown[]) =>
		mockReadSwarmFileAsync(...(args as [string, string])),
	safeHook: (...args: unknown[]) => mockSafeHook(...(args as [unknown])),
	validateSwarmPath: (...args: unknown[]) =>
		mockValidateSwarmPath(...(args as [string, string])),
}));

// ============================================================================
// Test data
// ============================================================================

const defaultConfig: KnowledgeConfig = {
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
};

function makePlanContent(lessons: string[]): string {
	const bullets = lessons.map((l) => `- ${l}`).join('\n');
	return `# My Test Project
Swarm: mega
Phase: 2 | Updated: 2026-03-02

## Phase 1: Setup [COMPLETE]
- [x] 1.1: Init

### Lessons Learned
${bullets}

## Phase 2: Core [IN PROGRESS]
- [ ] 2.1: Build
`;
}

// ============================================================================
// Tests
// ============================================================================

describe('knowledge-curator TTL eviction (seenRetroSections)', () => {
	beforeEach(() => {
		// Reset mock time
		mockNow = 1000000000000;

		mockAppendKnowledge.mockClear();
		mockAppendRejectedLesson.mockClear();
		mockFindNearDuplicate.mockClear();
		mockReadKnowledge.mockClear();
		mockRewriteKnowledge.mockClear();
		mockResolveSwarmKnowledgePath.mockClear();
		mockResolveSwarmRejectedPath.mockClear();
		mockComputeConfidence.mockClear();
		mockInferTags.mockClear();
		mockReadSwarmFileAsync.mockClear();
		mockSafeHook.mockClear();
		mockValidateSwarmPath.mockClear();
		mockValidateLesson.mockClear();
		mockQuarantineEntry.mockClear();
		mockNormalize.mockClear();
		mockUpdateRetrievalOutcome.mockClear();

		// Reset mock implementations to defaults
		mockResolveSwarmKnowledgePath.mockReturnValue(
			'/project/.swarm/knowledge.jsonl',
		);
		mockResolveSwarmRejectedPath.mockReturnValue(
			'/project/.swarm/rejected.jsonl',
		);
		mockReadKnowledge.mockResolvedValue([]);
		mockAppendKnowledge.mockResolvedValue(undefined);
		mockAppendRejectedLesson.mockResolvedValue(undefined);
		mockFindNearDuplicate.mockReturnValue(undefined);
		mockRewriteKnowledge.mockResolvedValue(undefined);
		mockComputeConfidence.mockReturnValue(0.6);
		mockInferTags.mockReturnValue([]);
		mockReadSwarmFileAsync.mockResolvedValue(null);
		mockSafeHook.mockImplementation((fn: unknown) => fn);
		mockValidateSwarmPath.mockImplementation(
			(dir: string, file: string) => `${dir}/.swarm/${file}`,
		);
		mockValidateLesson.mockReturnValue({
			valid: true,
			layer: null,
			reason: null,
			severity: null,
		});
		mockQuarantineEntry.mockResolvedValue(undefined);
		mockNormalize.mockImplementation((text: string) =>
			text.toLowerCase().trim(),
		);
		mockUpdateRetrievalOutcome.mockResolvedValue(undefined);
	});

	describe('Fresh entry NOT evicted', () => {
		test('Entry added < 24h ago remains in Map after prune', async () => {
			// Create hook with plan content
			const planContent = makePlanContent(['Fresh lesson']);
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			// Act: First call to hook adds entry to seenRetroSections
			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-fresh',
			};
			await hook(input, {});

			// Verify: Entry was added (appendKnowledge called once)
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);

			// Reset mocks for second call
			mockReadSwarmFileAsync.mockClear();
			mockAppendKnowledge.mockClear();

			// Advance time by 23 hours (less than 24h - fresh)
			advanceTime(23 * 60 * 60 * 1000);

			// Provide same plan content again
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			// Act: Second call to hook triggers prune, but entry should still be present
			await hook(input, {});

			// Verify: Entry should NOT be processed again (idempotency still works)
			// appendKnowledge should NOT be called because the entry is still in the Map
			expect(mockAppendKnowledge).not.toHaveBeenCalled();
		});
	});

	describe('Stale entry evicted', () => {
		test('Entry added > 24h ago is removed from Map after prune', async () => {
			// Create hook with plan content
			const planContent = makePlanContent(['Stale lesson']);
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			// Act: First call to hook adds entry to seenRetroSections
			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-stale',
			};
			await hook(input, {});

			// Verify: Entry was added
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);

			// Reset mocks for second call
			mockReadSwarmFileAsync.mockClear();
			mockAppendKnowledge.mockClear();

			// Advance time by 25 hours (more than 24h - stale)
			advanceTime(25 * 60 * 60 * 1000);

			// Provide same plan content again
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			// Act: Second call to hook triggers prune, stale entry should be evicted
			await hook(input, {});

			// Verify: Entry SHOULD be processed again (because it was evicted)
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);
		});
	});

	describe('Prune called on handler invocation', () => {
		test('After prune, stale entries no longer block re-curation (same content processed again after 24h)', async () => {
			// Create hook with plan content
			const planContent = makePlanContent(['Lesson to re-curate']);
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			// Act: First call to hook adds entry
			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-recurate',
			};
			await hook(input, {});

			// Verify: First curation happened
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);

			// Reset mocks
			mockReadSwarmFileAsync.mockClear();
			mockAppendKnowledge.mockClear();

			// Advance time by 25 hours (stale threshold)
			advanceTime(25 * 60 * 60 * 1000);

			// Provide same plan content again
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			// Act: Second call to hook after 24h should re-curate (stale entry evicted)
			await hook(input, {});

			// Verify: Re-curation happened because stale entry was pruned
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);

			// Reset mocks again
			mockReadSwarmFileAsync.mockClear();
			mockAppendKnowledge.mockClear();

			// Advance time by 1 hour (now 26h total from first, but 1h from second)
			advanceTime(1 * 60 * 60 * 1000);

			// Provide same plan content again
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			// Act: Third call to hook should NOT re-curate (entry is fresh)
			await hook(input, {});

			// Verify: No re-curation (entry still fresh, within 24h)
			expect(mockAppendKnowledge).not.toHaveBeenCalled();
		});
	});

	describe('Multiple entries, selective eviction', () => {
		test('Mix of fresh and stale entries — only stale ones removed', async () => {
			// Create hook
			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			// Add first session entry (will become stale)
			const planContent1 = makePlanContent(['Session 1 lesson']);
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent1);
			const input1 = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-1',
			};
			await hook(input1, {});

			// Advance time by 12 hours
			advanceTime(12 * 60 * 60 * 1000);

			// Add second session entry (will be fresh after 25h total)
			const planContent2 = makePlanContent(['Session 2 lesson']);
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent2);
			const input2 = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-2',
			};
			await hook(input2, {});

			// Verify both were added
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(2);

			// Reset mocks
			mockReadSwarmFileAsync.mockClear();
			mockAppendKnowledge.mockClear();

			// Advance time by 13 more hours (25h total from start)
			advanceTime(13 * 60 * 60 * 1000);

			// Try to re-process session 1 (stale, should re-curate)
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent1);
			await hook(input1, {});

			// Verify: Session 1 should be re-curated (was stale)
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);

			// Reset mocks
			mockReadSwarmFileAsync.mockClear();
			mockAppendKnowledge.mockClear();

			// Try to re-process session 2 (fresh, should NOT re-curate)
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent2);
			await hook(input2, {});

			// Verify: Session 2 should NOT be re-curated (still fresh, only 13h old)
			expect(mockAppendKnowledge).not.toHaveBeenCalled();
		});

		test('Multiple sessions with different ages — correct eviction per session', async () => {
			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const planContent = makePlanContent(['Test lesson']);

			// Add three sessions at different times
			// Session A at T = 0 (will be oldest)
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);
			await hook(
				{
					toolName: 'write',
					path: '/project/.swarm/plan.md',
					sessionID: 'sess-a',
				},
				{},
			);

			// Session B at T = 6 hours
			advanceTime(6 * 60 * 60 * 1000);
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);
			await hook(
				{
					toolName: 'write',
					path: '/project/.swarm/plan.md',
					sessionID: 'sess-b',
				},
				{},
			);

			// Session C at T = 12 hours
			advanceTime(6 * 60 * 60 * 1000);
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);
			await hook(
				{
					toolName: 'write',
					path: '/project/.swarm/plan.md',
					sessionID: 'sess-c',
				},
				{},
			);

			// Verify: All three were added
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(3);

			// Reset call counts but keep default implementations
			mockReadSwarmFileAsync.mockClear();
			mockAppendKnowledge.mockClear();

			// Set default implementation for readSwarmFileAsync (important!)
			mockReadSwarmFileAsync.mockResolvedValue(planContent);

			// Advance to T = 30 hours (30h total from start)
			advanceTime(18 * 60 * 60 * 1000);

			// Try to re-process Session A (30h old -> stale, should re-curate)
			await hook(
				{
					toolName: 'write',
					path: '/project/.swarm/plan.md',
					sessionID: 'sess-a',
				},
				{},
			);
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);

			// Reset call counts
			mockReadSwarmFileAsync.mockClear();
			mockAppendKnowledge.mockClear();
			mockReadSwarmFileAsync.mockResolvedValue(planContent);

			// Try to re-process Session B (24h old -> at threshold, timestamp == cutoff, NOT evicted)
			await hook(
				{
					toolName: 'write',
					path: '/project/.swarm/plan.md',
					sessionID: 'sess-b',
				},
				{},
			);
			expect(mockAppendKnowledge).not.toHaveBeenCalled();

			// Reset call counts
			mockReadSwarmFileAsync.mockClear();
			mockAppendKnowledge.mockClear();
			mockReadSwarmFileAsync.mockResolvedValue(planContent);

			// Try to re-process Session C (18h old -> fresh, should NOT re-curate)
			await hook(
				{
					toolName: 'write',
					path: '/project/.swarm/plan.md',
					sessionID: 'sess-c',
				},
				{},
			);
			expect(mockAppendKnowledge).not.toHaveBeenCalled();
		});
	});

	describe('Empty Map', () => {
		test('Prune on empty Map does not throw', async () => {
			// Create hook - no prior calls, so seenRetroSections is empty
			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-empty',
			};

			// Act: Call hook (prune called at start of handler)
			// This should not throw even with empty Map
			const planContent = makePlanContent(['First lesson']);
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			// Verify: No exception thrown
			await expect(hook(input, {})).resolves.toBeUndefined();

			// Verify: Lesson was processed normally
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);
		});

		test('Prune on empty Map multiple times is safe', async () => {
			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const planContent = makePlanContent(['Test lesson']);

			// Call hook multiple times with different session IDs
			// Each call triggers prune on potentially empty Map for that session
			for (let i = 0; i < 5; i++) {
				mockReadSwarmFileAsync.mockClear();
				mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

				const input = {
					toolName: 'write',
					path: '/project/.swarm/plan.md',
					sessionID: `sess-multi-${i}`,
				};

				// Should not throw
				await expect(hook(input, {})).resolves.toBeUndefined();
			}

			// Verify: All 5 lessons were processed
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(5);
		});
	});

	describe('Evidence file entries TTL', () => {
		test('Evidence entries also respect 24h TTL', async () => {
			// Mock evidence file content
			const evidenceContent = {
				project_name: 'test-project',
				phase_number: 1,
				entries: [
					{
						lessons_learned: ['Evidence lesson 1', 'Evidence lesson 2'],
					},
				],
			};

			// Create hook
			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			// Act: First call to hook adds evidence entry
			mockReadSwarmFileAsync.mockResolvedValueOnce(
				JSON.stringify(evidenceContent),
			);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/evidence/retro-123/evidence.json',
				sessionID: 'sess-evidence',
			};
			await hook(input, {});

			// Verify: Entries were added
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(2);

			// Reset mocks
			mockReadSwarmFileAsync.mockClear();
			mockAppendKnowledge.mockClear();

			// Advance time by 25 hours
			advanceTime(25 * 60 * 60 * 1000);

			// Provide same evidence file again
			mockReadSwarmFileAsync.mockResolvedValueOnce(
				JSON.stringify(evidenceContent),
			);

			// Act: Second call to hook - stale evidence entry should be evicted
			await hook(input, {});

			// Verify: Entries should be re-curated
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(2);

			// Reset mocks
			mockReadSwarmFileAsync.mockClear();
			mockAppendKnowledge.mockClear();

			// Advance time by 1 hour (now 26h total from first, but 1h from second)
			advanceTime(1 * 60 * 60 * 1000);

			// Provide same evidence file again
			mockReadSwarmFileAsync.mockResolvedValueOnce(
				JSON.stringify(evidenceContent),
			);

			// Act: Third call to hook - entry should still be fresh
			await hook(input, {});

			// Verify: No re-curation (entry is fresh)
			expect(mockAppendKnowledge).not.toHaveBeenCalled();
		});
	});

	describe('Boundary conditions', () => {
		test('Entry exactly 24h + 1ms old is evicted (timestamp < cutoff)', async () => {
			const planContent = makePlanContent(['Boundary lesson']);
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-boundary',
			};
			await hook(input, {});

			// Verify: Entry was added
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);

			// Reset mocks
			mockReadSwarmFileAsync.mockClear();
			mockAppendKnowledge.mockClear();

			// Advance time by exactly 24 hours + 1ms
			// Entry timestamp = initial time
			// Cutoff = current time - 86400000 = (initial + 86400001) - 86400000 = initial + 1
			// Condition: entry.timestamp < cutoff -> initial < (initial + 1) -> true (evicted)
			advanceTime(86_400_000 + 1);

			// Provide same plan content
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			// Act: Entry should be evicted and re-curated
			await hook(input, {});

			// Verify: Re-curation happened
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);
		});

		test('Entry 23h 59m old is NOT evicted (timestamp >= cutoff)', async () => {
			const planContent = makePlanContent(['Near-boundary lesson']);
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-near-boundary',
			};
			await hook(input, {});

			// Verify: Entry was added
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);

			// Reset mocks
			mockReadSwarmFileAsync.mockClear();
			mockAppendKnowledge.mockClear();

			// Advance time by 23 hours 59 minutes 59 seconds (just under 24h)
			advanceTime(23 * 60 * 60 * 1000 + 59 * 60 * 1000 + 59 * 1000);

			// Provide same plan content
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			// Act: Entry should NOT be evicted
			await hook(input, {});

			// Verify: No re-curation
			expect(mockAppendKnowledge).not.toHaveBeenCalled();
		});
	});
});
