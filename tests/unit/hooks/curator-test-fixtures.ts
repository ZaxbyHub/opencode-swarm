/**
 * Shared test fixtures for knowledge-curator tests.
 *
 * Provides common mock setup, helper functions, and test data factories.
 * Each test file imports what it needs and calls the setup functions.
 *
 * @example
 * ```ts
 * import { createCuratorMocks, setupMockModules, createCuratorBeforeEach, defaultConfig, makePlanContent } from './curator-test-fixtures.js';
 *
 * // Create fresh mocks for this file
 * const mocks = createCuratorMocks();
 * setupMockModules(mocks);
 *
 * const { createKnowledgeCuratorHook } = await import('../../../src/hooks/knowledge-curator.js');
 * const { transactKnowledge } = await import('../../../src/hooks/knowledge-store.js');
 *
 * const beforeEach = createCuratorBeforeEach(mocks, transactKnowledge);
 * ```
 */

import { type Mock, mock } from 'bun:test';
import * as realKnowledgeReader from '../../../src/hooks/knowledge-reader.js';
import * as realKnowledgeStore from '../../../src/hooks/knowledge-store.js';
import type { KnowledgeConfig } from '../../../src/hooks/knowledge-types.js';
// Import real modules for spreading in mock returns (FR-001 SC-001.1 pattern)
import * as realKnowledgeValidator from '../../../src/hooks/knowledge-validator.js';
import * as realUtils from '../../../src/hooks/utils.js';

// =============================================================================
// Mock factory
// =============================================================================

/**
 * Creates a fresh set of mock functions for knowledge-curator tests.
 * Call this once per test file (not per test) to ensure isolation.
 */
export function createCuratorMocks() {
	// Knowledge-store mocks
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
	const mockResolveHiveKnowledgePath = mock(() => '');
	const mockComputeConfidence = mock((_n: number, _b: boolean) => 0);
	const mockInferTags = mock((_s: string) => [] as string[]);
	const mockReadRetractionRecords = mock((_s: string) => Promise.resolve([]));
	const mockAppendRetractionRecord = mock((_s: string, _u: unknown) =>
		Promise.resolve(),
	);

	// Utils mocks
	const mockReadSwarmFileAsync = mock((_s: string, _f: string) =>
		Promise.resolve(null as string | null),
	);
	const mockSafeHook = mock((fn: unknown) => fn);
	const mockValidateSwarmPath = mock((_d: string, _f: string) => '');

	// Knowledge-validator mocks
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

	// Knowledge-reader mocks
	const mockUpdateRetrievalOutcome = mock(
		(_s: string, _id: string, _b: boolean) => Promise.resolve(),
	);

	return {
		// Knowledge-store mocks
		mockAppendRejectedLesson,
		mockFindNearDuplicate,
		mockReadKnowledge,
		mockRewriteKnowledge,
		mockResolveSwarmKnowledgePath,
		mockResolveSwarmRejectedPath,
		mockResolveHiveKnowledgePath,
		mockComputeConfidence,
		mockInferTags,
		mockReadRetractionRecords,
		mockAppendRetractionRecord,
		// Utils mocks
		mockReadSwarmFileAsync,
		mockSafeHook,
		mockValidateSwarmPath,
		// Knowledge-validator mocks
		mockValidateLesson,
		mockQuarantineEntry,
		mockNormalize,
		// Knowledge-reader mocks
		mockUpdateRetrievalOutcome,
	};
}

// =============================================================================
// Module mock setup
// =============================================================================

/**
 * Sets up mock.module() for the three external dependencies.
 * Call BEFORE importing the SUT.
 */
export function setupMockModules(mocks: ReturnType<typeof createCuratorMocks>) {
	const {
		mockAppendRejectedLesson,
		mockFindNearDuplicate,
		mockReadKnowledge,
		mockRewriteKnowledge,
		mockResolveSwarmKnowledgePath,
		mockResolveSwarmRejectedPath,
		mockResolveHiveKnowledgePath,
		mockComputeConfidence,
		mockInferTags,
		mockReadRetractionRecords,
		mockAppendRetractionRecord,
		mockReadSwarmFileAsync,
		mockSafeHook,
		mockValidateSwarmPath,
		mockValidateLesson,
		mockQuarantineEntry,
		mockNormalize,
		mockUpdateRetrievalOutcome,
	} = mocks;

	mock.module('../../../src/hooks/knowledge-validator.js', () => ({
		...realKnowledgeValidator,
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
		validateActionability: () => ({ actionable: true }),
		validateActionableFields: () => ({ valid: true, errors: [] }),
		appendUnactionable: async () => {},
	}));

	mock.module('../../../src/hooks/knowledge-reader.js', () => ({
		...realKnowledgeReader,
		updateRetrievalOutcome: (...args: unknown[]) =>
			mockUpdateRetrievalOutcome(...(args as [string, string, boolean])),
	}));

	mock.module('../../../src/hooks/knowledge-store.js', () => ({
		...realKnowledgeStore,
		resolveSwarmKnowledgePath: (...args: unknown[]) =>
			mockResolveSwarmKnowledgePath(...(args as [string])),
		resolveSwarmRejectedPath: (...args: unknown[]) =>
			mockResolveSwarmRejectedPath(...(args as [string])),
		resolveHiveKnowledgePath: () => mockResolveHiveKnowledgePath(),
		readKnowledge: (...args: unknown[]) =>
			mockReadKnowledge(...(args as [string])),
		readRetractionRecords: (...args: unknown[]) =>
			mockReadRetractionRecords(...(args as [string])),
		appendRetractionRecord: (...args: unknown[]) =>
			mockAppendRetractionRecord(...(args as [string, unknown])),
		appendRejectedLesson: (...args: unknown[]) =>
			mockAppendRejectedLesson(...(args as [])),
		findNearDuplicate: (...args: unknown[]) =>
			mockFindNearDuplicate(...(args as [string, unknown[], number])),
		rewriteKnowledge: (...args: unknown[]) =>
			mockRewriteKnowledge(...(args as [string, unknown[]])),
		computeConfidence: (...args: unknown[]) =>
			mockComputeConfidence(...(args as [number, boolean])),
		computeOutcomeSignal: () => 0,
		inferTags: (...args: unknown[]) => mockInferTags(...(args as [string])),
		normalize: (...args: unknown[]) => mockNormalize(...(args as [string])),
		transactKnowledge: mock(
			async <T>(
				filePath: string,
				mutate: (entries: T[]) => T[] | null,
			): Promise<boolean> => {
				const entries = (await mockReadKnowledge(filePath)) as T[];
				const result = mutate(entries);
				return result !== null;
			},
		),
		transactFile: async () => false,
		enforceKnowledgeCap: async () => {},
		sweepAgedEntries: async () => {},
		sweepStaleTodos: async () => {},
		bumpKnowledgeConfidenceBatch: async () => {},
		resolveSwarmRetractionsPath: () => '',
		resolveHiveRejectedPath: () => '',
		readRejectedLessons: async () => [],
		normalizeEntry: (e: unknown) => e,
		getPlatformConfigDir: () => '/tmp',
		_internals: {},
		wordBigrams: (_t: string) => new Set<string>(),
		jaccardBigram: () => 0,
	}));

	mock.module('../../../src/hooks/utils.js', () => ({
		...realUtils,
		readSwarmFileAsync: (...args: unknown[]) =>
			mockReadSwarmFileAsync(...(args as [string, string])),
		safeHook: (...args: unknown[]) => mockSafeHook(...(args as [unknown])),
		validateSwarmPath: (...args: unknown[]) =>
			mockValidateSwarmPath(...(args as [string, string])),
	}));
}

// =============================================================================
// BeforeEach reset factory
// =============================================================================

/**
 * Creates a beforeEach function that resets all mocks to their default state.
 * Pass the transactKnowledge mock from your dynamic import.
 */
export function createCuratorBeforeEach(
	mocks: ReturnType<typeof createCuratorMocks>,
	transactKnowledge: Mock,
) {
	return function curatorBeforeEach() {
		const {
			mockAppendRejectedLesson,
			mockFindNearDuplicate,
			mockReadKnowledge,
			mockRewriteKnowledge,
			mockResolveSwarmKnowledgePath,
			mockResolveSwarmRejectedPath,
			mockResolveHiveKnowledgePath,
			mockComputeConfidence,
			mockInferTags,
			mockReadRetractionRecords,
			mockAppendRetractionRecord,
			mockReadSwarmFileAsync,
			mockSafeHook,
			mockValidateSwarmPath,
			mockValidateLesson,
			mockQuarantineEntry,
			mockNormalize,
			mockUpdateRetrievalOutcome,
		} = mocks;

		transactKnowledge.mockClear();
		mockAppendRejectedLesson.mockClear();
		mockFindNearDuplicate.mockClear();
		mockReadKnowledge.mockClear();
		mockRewriteKnowledge.mockClear();
		mockResolveSwarmKnowledgePath.mockClear();
		mockResolveSwarmRejectedPath.mockClear();
		mockResolveHiveKnowledgePath.mockClear();
		mockComputeConfidence.mockClear();
		mockInferTags.mockClear();
		mockReadRetractionRecords.mockClear();
		mockAppendRetractionRecord.mockClear();
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
		mockResolveHiveKnowledgePath.mockReturnValue(
			'/home/user/.local/share/opencode-swarm/shared-learnings.jsonl',
		);
		mockReadKnowledge.mockResolvedValue([]);
		mockReadRetractionRecords.mockResolvedValue([]);
		mockAppendRetractionRecord.mockResolvedValue(undefined);
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
	};
}

// =============================================================================
// Default config
// =============================================================================

export const defaultConfig: KnowledgeConfig = {
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

// =============================================================================
// Helper functions
// =============================================================================

export function makePlanContent(lessons: string[]): string {
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
