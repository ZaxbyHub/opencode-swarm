/**
 * Verification tests for evidence file curation logic in knowledge-curator.ts
 * Tests the hook's handling of evidence JSON files in .swarm/evidence/retro-N/ directory.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { KnowledgeConfig } from '../../../src/hooks/knowledge-types.js';

// Create local mock variables for knowledge-store
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

// Create local mock variables for utils
const mockReadSwarmFileAsync = mock((_s: string, _f: string) =>
	Promise.resolve(null as string | null),
);
const mockSafeHook = mock((fn: unknown) => fn);
const mockValidateSwarmPath = mock((_d: string, _f: string) => '');

// Create local mock variable for knowledge-validator
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

// Create local mock variable for knowledge-reader
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
	// Layer-5 stubs (Change 4): suite tests evidence-curation mechanics, not the
	// actionability gate (dedicated suites exist). Keep the gate open.
	validateActionability: () => ({ actionable: true }),
	validateActionableFields: () => ({ valid: true, errors: [] }),
	appendUnactionable: async () => {},
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
			_filePath: string,
			mutate: (entries: T[]) => T[] | null,
		): Promise<boolean> => {
			const entries = (await mockReadKnowledge(_filePath)) as T[];
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
	readSwarmFileAsync: (...args: unknown[]) =>
		mockReadSwarmFileAsync(...(args as [string, string])),
	safeHook: (...args: unknown[]) => mockSafeHook(...(args as [unknown])),
	validateSwarmPath: (...args: unknown[]) =>
		mockValidateSwarmPath(...(args as [string, string])),
}));

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
	// Layer-5 stubs (Change 4): suite tests evidence-curation mechanics, not the
	// actionability gate (dedicated suites exist). Keep the gate open.
	validateActionability: () => ({ actionable: true }),
	validateActionableFields: () => ({ valid: true, errors: [] }),
	appendUnactionable: async () => {},
}));

// Import the SUT and the transactKnowledge (the mock provided by the knowledge-store mock.module)
// using dynamic import so that the mocks are active before the modules under test are loaded.
const { createKnowledgeCuratorHook } = await import(
	'../../../src/hooks/knowledge-curator.js'
);

const { transactKnowledge: mockTransactKnowledge } = await import(
	'../../../src/hooks/knowledge-store.js'
);

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

// ============================================================================
// Tests
// ============================================================================

describe('knowledge-curator - evidence file curation', () => {
	beforeEach(() => {
		mockTransactKnowledge.mockClear();
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
	});

	describe('evidence file trigger detection', () => {
		test('trigger fires on evidence write', async () => {
			// Setup: readSwarmFileAsync returns evidence JSON with lessons_learned
			const evidenceContent = JSON.stringify({
				lessons_learned: [
					'Always write tests before code',
					'Use type safety everywhere',
				],
				project_name: 'test-project',
				phase_number: 3,
			});
			mockReadSwarmFileAsync.mockResolvedValueOnce(evidenceContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			// Input: write to evidence file
			const input = {
				toolName: 'write',
				path: '/project/.swarm/evidence/retro-3/evidence.json',
				sessionID: 'sess1',
			};
			await hook(input, {});

			// Expected: curateAndStoreSwarm called (via transactKnowledge, batched)
			expect(mockTransactKnowledge).toHaveBeenCalledTimes(1);
			const [, mutate] = mockTransactKnowledge.mock.calls[0] as [
				string,
				(entries: unknown[]) => unknown[] | null,
			];
			const result = mutate([]);
			const lessonsStored = (result ?? []).map(
				(entry: unknown) => (entry as { lesson?: string }).lesson,
			);
			expect(lessonsStored).toContain('Always write tests before code');
			expect(lessonsStored).toContain('Use type safety everywhere');
		});

		test('trigger fires on OpenCode-shaped args.filePath evidence write', async () => {
			const evidenceContent = JSON.stringify({
				lessons_learned: ['Curate OpenCode-shaped evidence writes'],
				project_name: 'test-project',
				phase_number: 3,
			});
			mockReadSwarmFileAsync.mockResolvedValueOnce(evidenceContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			await hook(
				{
					tool: 'write',
					args: {
						filePath: '/project/.swarm/evidence/retro-3/evidence.json',
					},
					sessionID: 'sess-opencode-evidence',
				},
				{},
			);

			expect(mockReadSwarmFileAsync).toHaveBeenCalledWith(
				'/project',
				'evidence/retro-3/evidence.json',
			);
			expect(mockTransactKnowledge).toHaveBeenCalledTimes(1);
		});

		test('trigger normalizes Windows separators in OpenCode-shaped evidence paths', async () => {
			const evidenceContent = JSON.stringify({
				lessons_learned: ['Curate Windows evidence paths'],
				project_name: 'test-project',
				phase_number: 3,
			});
			mockReadSwarmFileAsync.mockResolvedValueOnce(evidenceContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			await hook(
				{
					tool: 'edit',
					args: {
						filePath:
							'C:\\work\\project\\.swarm\\evidence\\retro-3\\evidence.json',
					},
					sessionID: 'sess-windows-evidence',
				},
				{},
			);

			expect(mockReadSwarmFileAsync).toHaveBeenCalledWith(
				'/project',
				'evidence/retro-3/evidence.json',
			);
			expect(mockTransactKnowledge).toHaveBeenCalledTimes(1);
		});

		test('trigger does NOT fire on plan.md write via evidence path (non-regression)', async () => {
			// Setup: readSwarmFileAsync returns plan content (not evidence)
			const planContent = `# Test Project
Swarm: mega
Phase: 1

### Lessons Learned
- Normal lesson from plan
`;
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			// Input: write to plan.md (not an evidence file)
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess2',
			};
			await hook(input, {});

			// Expected: curateAndStoreSwarm still called (plan.md trigger) — transact once
			expect(mockTransactKnowledge).toHaveBeenCalledTimes(1);
			const [, mutate] = mockTransactKnowledge.mock.calls[0] as [
				string,
				(entries: unknown[]) => unknown[] | null,
			];
			const result = mutate([]);
			expect(result).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						lesson: 'Normal lesson from plan',
					}),
				]),
			);

			// Verify it was plan.md path, not evidence path handling
			expect(mockReadSwarmFileAsync).toHaveBeenCalledWith(
				'/project',
				'plan.md',
			);
			expect(mockReadSwarmFileAsync).not.toHaveBeenCalledWith(
				'/project',
				expect.stringContaining('evidence/'),
			);
		});
	});

	describe('lessons extraction from evidence JSON', () => {
		test('lessons extracted from flat format', async () => {
			// Setup: evidence JSON with flat lessons_learned format
			const evidenceContent = JSON.stringify({
				lessons_learned: ['Lesson 1 from flat', 'Lesson 2 from flat'],
				project_name: 'test-project',
				phase_number: 2,
			});
			mockReadSwarmFileAsync.mockResolvedValueOnce(evidenceContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			const input = {
				toolName: 'write',
				path: '/project/.swarm/evidence/retro-2/evidence.json',
				sessionID: 'sess3',
			};
			await hook(input, {});

			// Expected: both lessons stored (transact once for the batch)
			expect(mockTransactKnowledge).toHaveBeenCalledTimes(1);
			const [, mutate] = mockTransactKnowledge.mock.calls[0] as [
				string,
				(entries: unknown[]) => unknown[] | null,
			];
			const result = mutate([]);
			const lessonsStored = (result ?? []).map(
				(entry: unknown) => (entry as { lesson?: string }).lesson,
			);
			expect(lessonsStored).toContain('Lesson 1 from flat');
			expect(lessonsStored).toContain('Lesson 2 from flat');
		});

		test('lessons extracted from entries format', async () => {
			// Setup: evidence JSON with entries array format
			const evidenceContent = JSON.stringify({
				entries: [
					{
						lessons_learned: ['Lesson from entries'],
						other_field: 'some data',
					},
				],
				project_name: 'test-project',
				phase_number: 1,
			});
			mockReadSwarmFileAsync.mockResolvedValueOnce(evidenceContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			const input = {
				toolName: 'write',
				path: '/project/.swarm/evidence/retro-1/evidence.json',
				sessionID: 'sess4',
			};
			await hook(input, {});

			// Expected: lesson from entries[0].lessons_learned stored (transact once)
			expect(mockTransactKnowledge).toHaveBeenCalledTimes(1);
			const [, mutate] = mockTransactKnowledge.mock.calls[0] as [
				string,
				(entries: unknown[]) => unknown[] | null,
			];
			const result = mutate([]);
			expect(result).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						lesson: 'Lesson from entries',
					}),
				]),
			);
		});

		test('empty lessons_learned array → curator NOT called (early return)', async () => {
			// Setup: evidence JSON with empty lessons_learned array
			const evidenceContent = JSON.stringify({
				lessons_learned: [],
				project_name: 'test-project',
				phase_number: 1,
			});
			mockReadSwarmFileAsync.mockResolvedValueOnce(evidenceContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			const input = {
				toolName: 'write',
				path: '/project/.swarm/evidence/retro-1/evidence.json',
				sessionID: 'sess5',
			};
			await hook(input, {});

			// Expected: curateAndStoreSwarm NOT called (early return on empty lessons)
			expect(mockTransactKnowledge).not.toHaveBeenCalled();
			expect(mockUpdateRetrievalOutcome).not.toHaveBeenCalled();
		});
	});

	describe('idempotency', () => {
		test('idempotency: same evidence file written twice with same content → curateAndStoreSwarm called only once', async () => {
			// Setup: evidence JSON with lessons
			const evidenceContent = JSON.stringify({
				lessons_learned: ['Lesson for idempotency test'],
				project_name: 'test-project',
				phase_number: 1,
			});
			mockReadSwarmFileAsync.mockResolvedValue(evidenceContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/evidence/retro-1/evidence.json',
				sessionID: 'sess-idempotent',
			};

			// Call hook twice with same session ID and same content
			await hook(input, {});
			await hook(input, {});

			// Expected: curateAndStoreSwarm called only once (idempotency check passed)
			expect(mockTransactKnowledge).toHaveBeenCalledTimes(1);
		});

		test('idempotency: same evidence file written with different content (more lessons) → curateAndStoreSwarm called again', async () => {
			// Equivalent OpenCode paths with different separators share one idempotency key.
			const evidenceContent = JSON.stringify({
				lessons_learned: ['Equivalent path idempotency'],
				project_name: 'test-project',
				phase_number: 1,
			});
			mockReadSwarmFileAsync.mockResolvedValue(evidenceContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			await hook(
				{
					tool: 'write',
					args: {
						filePath: '.swarm/evidence/retro-1/evidence.json',
					},
					sessionID: 'sess-normalized',
				},
				{},
			);
			await hook(
				{
					tool: 'write',
					args: {
						filePath: '.swarm\\evidence\\retro-1\\evidence.json',
					},
					sessionID: 'sess-normalized',
				},
				{},
			);

			expect(mockTransactKnowledge).toHaveBeenCalledTimes(1);
		});

		test('idempotency reruns evidence curation when content changes', async () => {
			// First call: evidence with 1 lesson
			const evidenceContent1 = JSON.stringify({
				lessons_learned: ['First lesson'],
				project_name: 'test-project',
				phase_number: 1,
			});

			// Second call: evidence with 2 lessons (different hash)
			const evidenceContent2 = JSON.stringify({
				lessons_learned: ['First lesson', 'Second lesson added'],
				project_name: 'test-project',
				phase_number: 1,
			});

			mockReadSwarmFileAsync
				.mockResolvedValueOnce(evidenceContent1)
				.mockResolvedValueOnce(evidenceContent2);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/evidence/retro-1/evidence.json',
				sessionID: 'sess-change',
			};

			// First call
			await hook(input, {});

			// Second call (content changed)
			await hook(input, {});

			// Expected: curateAndStoreSwarm called twice (different content) — 1 transact per batch
			expect(mockTransactKnowledge).toHaveBeenCalledTimes(2); // 1 from first call, 1 from second call
		});

		// FB-003 regression: absolute vs relative paths for same evidence file must share idempotency key
		test('FB-003: idempotency key is stable for equivalent absolute vs relative evidence paths', async () => {
			const evidenceContent = JSON.stringify({
				lessons_learned: ['Stable key lesson'],
				project_name: 'test-project',
				phase_number: 1,
			});
			mockReadSwarmFileAsync.mockResolvedValue(evidenceContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			// First call with absolute path
			await hook(
				{
					tool: 'write',
					args: {
						filePath: 'E:/repo/.swarm/evidence/retro-1/evidence.json',
					},
					sessionID: 'sess-fb003',
				},
				{},
			);

			// Second call with relative path (same logical file)
			await hook(
				{
					tool: 'write',
					args: {
						filePath: '.swarm/evidence/retro-1/evidence.json',
					},
					sessionID: 'sess-fb003',
				},
				{},
			);

			// Expected: only one curation (same key used for both)
			expect(mockTransactKnowledge).toHaveBeenCalledTimes(1);
		});
	});

	describe('error handling', () => {
		test('missing file (readSwarmFileAsync returns null) → curator NOT called, no error thrown', async () => {
			// Setup: readSwarmFileAsync returns null (file not found)
			mockReadSwarmFileAsync.mockResolvedValue(null);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			const input = {
				toolName: 'write',
				path: '/project/.swarm/evidence/retro-1/evidence.json',
				sessionID: 'sess-missing',
			};

			// Expected: hook completes without throwing
			await expect(hook(input, {})).resolves.toBeUndefined();

			// Expected: curateAndStoreSwarm NOT called (early return on missing file)
			expect(mockTransactKnowledge).not.toHaveBeenCalled();
		});

		test('invalid JSON in evidence file → curator NOT called, no error thrown', async () => {
			// Setup: readSwarmFileAsync returns invalid JSON
			mockReadSwarmFileAsync.mockResolvedValue('{ invalid json }');

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			const input = {
				toolName: 'write',
				path: '/project/.swarm/evidence/retro-1/evidence.json',
				sessionID: 'sess-bad-json',
			};

			// Expected: hook completes without throwing
			await expect(hook(input, {})).resolves.toBeUndefined();

			// Expected: curateAndStoreSwarm NOT called (JSON parse error causes early return)
			expect(mockTransactKnowledge).not.toHaveBeenCalled();
		});

		test('no lessons_learned field → curator NOT called, no error thrown', async () => {
			// Setup: evidence JSON without lessons_learned field
			const evidenceContent = JSON.stringify({
				project_name: 'test-project',
				phase_number: 1,
				other_data: 'some value',
			});
			mockReadSwarmFileAsync.mockResolvedValue(evidenceContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			const input = {
				toolName: 'write',
				path: '/project/.swarm/evidence/retro-1/evidence.json',
				sessionID: 'sess-no-lessons',
			};

			// Expected: hook completes without throwing
			await expect(hook(input, {})).resolves.toBeUndefined();

			// Expected: curateAndStoreSwarm NOT called (no lessons_learned field)
			expect(mockTransactKnowledge).not.toHaveBeenCalled();
		});

		test('entries array is empty → curator NOT called, no error thrown', async () => {
			// Setup: evidence JSON with empty entries array
			const evidenceContent = JSON.stringify({
				entries: [],
				project_name: 'test-project',
				phase_number: 1,
			});
			mockReadSwarmFileAsync.mockResolvedValue(evidenceContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			const input = {
				toolName: 'write',
				path: '/project/.swarm/evidence/retro-1/evidence.json',
				sessionID: 'sess-empty-entries',
			};

			// Expected: hook completes without throwing
			await expect(hook(input, {})).resolves.toBeUndefined();

			// Expected: curateAndStoreSwarm NOT called (empty entries)
			expect(mockTransactKnowledge).not.toHaveBeenCalled();
		});
	});

	describe('evidence metadata handling', () => {
		test('project_name and phase_number extracted from evidence JSON', async () => {
			// Setup: evidence JSON with metadata
			const evidenceContent = JSON.stringify({
				lessons_learned: ['Lesson with metadata'],
				project_name: 'my-awesome-project',
				phase_number: 5,
			});
			mockReadSwarmFileAsync.mockResolvedValueOnce(evidenceContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			const input = {
				toolName: 'write',
				path: '/project/.swarm/evidence/retro-5/evidence.json',
				sessionID: 'sess-metadata',
			};
			await hook(input, {});

			// Expected: lesson stored with correct metadata (transact once)
			expect(mockTransactKnowledge).toHaveBeenCalledTimes(1);
			const [, mutate] = mockTransactKnowledge.mock.calls[0] as [
				string,
				(entries: unknown[]) => unknown[] | null,
			];
			const result = mutate([]);
			expect(result).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						lesson: 'Lesson with metadata',
						project_name: 'my-awesome-project',
						confirmed_by: expect.arrayContaining([
							expect.objectContaining({
								phase_number: 5,
								project_name: 'my-awesome-project',
							}),
						]),
					}),
				]),
			);

			expect(mockUpdateRetrievalOutcome).not.toHaveBeenCalled();
		});

		test('missing project_name defaults to "unknown"', async () => {
			// Setup: evidence JSON without project_name
			const evidenceContent = JSON.stringify({
				lessons_learned: ['Lesson without project name'],
				phase_number: 2,
			});
			mockReadSwarmFileAsync.mockResolvedValueOnce(evidenceContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			const input = {
				toolName: 'write',
				path: '/project/.swarm/evidence/retro-2/evidence.json',
				sessionID: 'sess-no-project',
			};
			await hook(input, {});

			// Expected: lesson stored with default project_name (transact once)
			expect(mockTransactKnowledge).toHaveBeenCalledTimes(1);
			const [, mutate] = mockTransactKnowledge.mock.calls[0] as [
				string,
				(entries: unknown[]) => unknown[] | null,
			];
			const result = mutate([]);
			expect(result).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						lesson: 'Lesson without project name',
						project_name: 'unknown',
					}),
				]),
			);
		});

		test('missing phase_number defaults to 1', async () => {
			// Setup: evidence JSON without phase_number
			const evidenceContent = JSON.stringify({
				lessons_learned: ['Lesson without phase number'],
				project_name: 'test-project',
			});
			mockReadSwarmFileAsync.mockResolvedValueOnce(evidenceContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			const input = {
				toolName: 'write',
				path: '/project/.swarm/evidence/retro-1/evidence.json',
				sessionID: 'sess-no-phase',
			};
			await hook(input, {});

			// Expected: lesson stored with default phase_number (transact once)
			expect(mockTransactKnowledge).toHaveBeenCalledTimes(1);
			const [, mutate] = mockTransactKnowledge.mock.calls[0] as [
				string,
				(entries: unknown[]) => unknown[] | null,
			];
			const result = mutate([]);
			expect(result).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						lesson: 'Lesson without phase number',
						confirmed_by: expect.arrayContaining([
							expect.objectContaining({
								phase_number: 1,
							}),
						]),
					}),
				]),
			);

			expect(mockUpdateRetrievalOutcome).not.toHaveBeenCalled();
		});
	});

	describe('sessionID handling', () => {
		test('default sessionID when not provided', async () => {
			// Setup: evidence JSON with lessons
			const evidenceContent = JSON.stringify({
				lessons_learned: ['Lesson with default session'],
				project_name: 'test-project',
				phase_number: 1,
			});
			mockReadSwarmFileAsync.mockResolvedValueOnce(evidenceContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			// Input: no sessionID provided
			const input = {
				toolName: 'write',
				path: '/project/.swarm/evidence/retro-1/evidence.json',
			};
			await hook(input, {});

			// Expected: curateAndStoreSwarm still called (uses 'default' sessionID)
			expect(mockTransactKnowledge).toHaveBeenCalledTimes(1);
		});

		test('idempotency key uses sessionID + filePath', async () => {
			// Setup: evidence JSON with lessons
			const evidenceContent = JSON.stringify({
				lessons_learned: ['Lesson for session test'],
				project_name: 'test-project',
				phase_number: 1,
			});
			mockReadSwarmFileAsync.mockResolvedValue(evidenceContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			// First call with sessionID 'session-1'
			const input1 = {
				toolName: 'write',
				path: '/project/.swarm/evidence/retro-1/evidence.json',
				sessionID: 'session-1',
			};
			await hook(input1, {});

			// Second call with different sessionID 'session-2' - should NOT be idempotent
			const input2 = {
				toolName: 'write',
				path: '/project/.swarm/evidence/retro-1/evidence.json',
				sessionID: 'session-2',
			};
			await hook(input2, {});

			// Expected: curateAndStoreSwarm called twice (different sessionIDs)
			expect(mockTransactKnowledge).toHaveBeenCalledTimes(2);
		});
	});

	describe('evidence path normalization', () => {
		test('Windows-style backslash path is normalized', async () => {
			// Setup: evidence JSON with lessons
			const evidenceContent = JSON.stringify({
				lessons_learned: ['Lesson with Windows path'],
				project_name: 'test-project',
				phase_number: 1,
			});
			mockReadSwarmFileAsync.mockResolvedValueOnce(evidenceContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			// Input: Windows-style path with backslashes
			const input = {
				toolName: 'write',
				path: '\\project\\.swarm\\evidence\\retro-1\\evidence.json',
				sessionID: 'sess-windows',
			};
			await hook(input, {});

			// Expected: path normalized and file read correctly
			expect(mockReadSwarmFileAsync).toHaveBeenCalledWith(
				'/project',
				'evidence/retro-1/evidence.json',
			);
			expect(mockTransactKnowledge).toHaveBeenCalledTimes(1);
		});

		test('edit and apply_patch operations also trigger evidence curation', async () => {
			// Setup: evidence JSON with lessons
			const evidenceContent = JSON.stringify({
				lessons_learned: ['Lesson from edit operation'],
				project_name: 'test-project',
				phase_number: 1,
			});
			mockReadSwarmFileAsync.mockResolvedValue(evidenceContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			// Test 'edit' operation
			const editInput = {
				toolName: 'edit',
				path: '/project/.swarm/evidence/retro-1/evidence.json',
				sessionID: 'sess-edit',
			};
			await hook(editInput, {});

			// Test 'apply_patch' operation
			const patchInput = {
				toolName: 'apply_patch',
				file: '/project/.swarm/evidence/retro-1/evidence.json',
				sessionID: 'sess-patch',
			};
			await hook(patchInput, {});

			// Expected: both operations trigger curation
			expect(mockTransactKnowledge).toHaveBeenCalledTimes(2);
		});
	});
});
