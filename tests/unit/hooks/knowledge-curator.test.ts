/**
 * Verification tests for knowledge-curator.ts
 * Tests the curator hook and lesson extraction/storage logic.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
	createKnowledgeCuratorHook,
	curateAndStoreSwarm,
	runAutoPromotion,
} from '../../../src/hooks/knowledge-curator.js';
import type { KnowledgeConfig } from '../../../src/hooks/knowledge-types.js';

// IMPORTANT: vi.mocked() does NOT work in this environment - use local mock variables

// Create local mock variables for knowledge-store
const mockAppendKnowledge = vi.fn<[], Promise<void>>();
const mockAppendRejectedLesson = vi.fn<[], Promise<void>>();
const mockFindNearDuplicate = vi.fn<[string, unknown[], number], unknown>();
const mockReadKnowledge = vi.fn<[string], Promise<unknown[]>>();
const mockRewriteKnowledge = vi.fn<[string, unknown[]], Promise<void>>();
const mockResolveSwarmKnowledgePath = vi.fn<[string], string>();
const mockResolveSwarmRejectedPath = vi.fn<[string], string>();
const mockResolveHiveKnowledgePath = vi.fn<[], string>();
const mockComputeConfidence = vi.fn<[number, boolean], number>();
const mockInferTags = vi.fn<[string], string[]>();
const mockReadRetractionRecords = vi.fn<[string], Promise<unknown[]>>();
const mockAppendRetractionRecord = vi.fn<[string, unknown], Promise<void>>();

// Create local mock variables for utils
const mockReadSwarmFileAsync = vi.fn<
	[string, string],
	Promise<string | null>
>();
const mockSafeHook = vi.fn<(fn: unknown) => unknown>();
const mockValidateSwarmPath = vi.fn<[string, string], string>();

// Create local mock variable for knowledge-validator
const mockValidateLesson = vi.fn<
	[string, string[], { category: string; scope: string; confidence: number }],
	{
		valid: boolean;
		layer: number | null;
		reason: string | null;
		severity: string | null;
	}
>();
const mockQuarantineEntry = vi.fn<
	[string, string, string, 'architect' | 'user' | 'auto'],
	Promise<void>
>();
const mockNormalize = vi.fn<[string], string>();

// Create local mock variable for knowledge-reader
const mockUpdateRetrievalOutcome = vi.fn<
	[string, string, boolean],
	Promise<void>
>();

vi.mock('../../../src/hooks/knowledge-validator.js', () => ({
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

vi.mock('../../../src/hooks/knowledge-reader.js', () => ({
	updateRetrievalOutcome: (...args: unknown[]) =>
		mockUpdateRetrievalOutcome(...(args as [string, string, boolean])),
}));

vi.mock('../../../src/hooks/knowledge-store.js', () => ({
	resolveSwarmKnowledgePath: (...args: unknown[]) =>
		mockResolveSwarmKnowledgePath(...(args as [string])),
	resolveSwarmRejectedPath: (...args: unknown[]) =>
		mockResolveSwarmRejectedPath(...(args as [string])),
	resolveHiveKnowledgePath: () => mockResolveHiveKnowledgePath(),
	readKnowledge: (...args: unknown[]) =>
		mockReadKnowledge(...(args as [string])),
	readRetractionRecords: (...args: unknown[]) =>
		mockReadRetractionRecords(...(args as [string])),
	appendKnowledge: (...args: unknown[]) => mockAppendKnowledge(...(args as [])),
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
	inferTags: (...args: unknown[]) => mockInferTags(...(args as [string])),
	normalize: (...args: unknown[]) => mockNormalize(...(args as [string])),
}));

vi.mock('../../../src/hooks/utils.js', () => ({
	readSwarmFileAsync: (...args: unknown[]) =>
		mockReadSwarmFileAsync(...(args as [string, string])),
	safeHook: (...args: unknown[]) => mockSafeHook(...(args as [unknown])),
	validateSwarmPath: (...args: unknown[]) =>
		mockValidateSwarmPath(...(args as [string, string])),
}));

vi.mock('../../../src/hooks/knowledge-validator.js', () => ({
	validateLesson: (...args: unknown[]) =>
		mockValidateLesson(
			...(args as [
				string,
				string[],
				{ category: string; scope: string; confidence: number },
			]),
		),
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

describe('knowledge-curator', () => {
	beforeEach(() => {
		vi.clearAllMocks();
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
		mockAppendKnowledge.mockResolvedValue(undefined);
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

	describe('createKnowledgeCuratorHook', () => {
		test('hook fires on write to .swarm/plan.md and processes lessons', async () => {
			// Setup: readSwarmFileAsync returns plan with 1 lesson
			const planContent = makePlanContent(['Always use defensive programming']);
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			// Input: write to plan.md
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess1',
			};
			await hook(input, {});

			// Expected: appendKnowledge called once
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);
		});

		test('hook skips writes to other files (e.g. README.md)', async () => {
			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			// Input: write to README.md
			const input = {
				toolName: 'write',
				path: '/project/README.md',
				sessionID: 'sess1',
			};
			await hook(input, {});

			// Expected: readSwarmFileAsync NOT called (early return)
			expect(mockReadSwarmFileAsync).not.toHaveBeenCalled();
			expect(mockAppendKnowledge).not.toHaveBeenCalled();
		});

		test('hook returns early when config.enabled is false', async () => {
			const hook = createKnowledgeCuratorHook('/project', {
				...defaultConfig,
				enabled: false,
			});

			// Input: write to plan.md
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess1',
			};
			await hook(input, {});

			// Expected: readSwarmFileAsync NOT called
			expect(mockReadSwarmFileAsync).not.toHaveBeenCalled();
			expect(mockAppendKnowledge).not.toHaveBeenCalled();
		});

		test('hook is idempotent — same session + same retro section → only processed once', async () => {
			// Setup: readSwarmFileAsync returns plan content
			const planContent = makePlanContent(['Test idempotency lesson']);
			mockReadSwarmFileAsync.mockResolvedValue(planContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-idempotent',
			};

			// Call hook twice with same session ID
			await hook(input, {});
			await hook(input, {});

			// Expected: appendKnowledge called only once
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);
		});

		test('safeHook swallows thrown errors without propagating', async () => {
			// Setup: make readSwarmFileAsync throw
			mockReadSwarmFileAsync.mockRejectedValueOnce(
				new Error('file read failed'),
			);

			// Make safeHook wrap the function to catch errors (the real behavior)
			mockSafeHook.mockImplementation((fn: unknown) => {
				return async (...args: unknown[]) => {
					try {
						await (fn as (input: unknown, output: unknown) => Promise<void>)(
							args[0],
							args[1],
						);
					} catch {
						// Swallow the error
					}
				};
			});

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);

			// Input: write to plan.md
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-error',
			};

			// Expected: hook should NOT throw (safeHook catches errors)
			// The function resolves successfully (even though it catches internally)
			await expect(hook(input, {})).resolves.toBeUndefined();
		});
	});

	describe('extractLessonsFromRetro (via curateAndStoreSwarm)', () => {
		test('lessons extracted from ### Lessons Learned bullet points', async () => {
			const lessons = [
				'First lesson learned',
				'Second lesson learned',
				'Third lesson learned',
			];
			const planContent = makePlanContent(lessons);
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-extract',
			};
			await hook(input, {});

			// Should have 3 lessons stored
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(3);
		});

		test('non-bullet lines in the section are ignored', async () => {
			const planContent = `# Test Project
Swarm: mega

### Lessons Learned
This is just a description line, not a lesson.
- But this is a real lesson
Another line without a bullet
- Another real lesson
`;
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-ignore',
			};
			await hook(input, {});

			// Should only store 2 lessons (the bullet points)
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(2);
		});
	});

	describe('curateAndStoreSwarm', () => {
		test('valid lesson is appended to knowledge store', async () => {
			mockValidateLesson.mockReturnValueOnce({
				valid: true,
				layer: null,
				reason: null,
				severity: null,
			});
			mockReadKnowledge.mockResolvedValueOnce([]);

			await curateAndStoreSwarm(
				['Always validate user input'],
				'test-project',
				{ phase_number: 1 },
				'/project',
				defaultConfig,
			);

			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);
			expect(mockAppendRejectedLesson).not.toHaveBeenCalled();
		});

		test('blocked lesson (rm -rf) goes to rejected, not knowledge store', async () => {
			mockValidateLesson.mockReturnValueOnce({
				valid: false,
				layer: 2,
				reason: 'dangerous command pattern detected',
				severity: 'error',
			});
			mockReadKnowledge.mockResolvedValueOnce([]);

			await curateAndStoreSwarm(
				['Run rm -rf to clean up'],
				'test-project',
				{ phase_number: 1 },
				'/project',
				defaultConfig,
			);

			expect(mockAppendRejectedLesson).toHaveBeenCalledTimes(1);
			expect(mockAppendKnowledge).not.toHaveBeenCalled();
		});

		test('near-duplicate lesson is silently skipped', async () => {
			// First, return a valid validation result
			mockValidateLesson.mockReturnValue({
				valid: true,
				layer: null,
				reason: null,
				severity: null,
			});
			// Return an existing entry as near-duplicate
			mockFindNearDuplicate.mockReturnValueOnce({
				id: 'existing-id',
				lesson: 'Similar lesson',
			});
			mockReadKnowledge.mockResolvedValueOnce([]);

			await curateAndStoreSwarm(
				['Always validate user input'],
				'test-project',
				{ phase_number: 1 },
				'/project',
				defaultConfig,
			);

			// Should skip the duplicate
			expect(mockAppendKnowledge).not.toHaveBeenCalled();
		});

		test('lesson with validation warning (vague) is still stored', async () => {
			// Validation passes but returns a warning
			mockValidateLesson.mockReturnValueOnce({
				valid: true,
				layer: 3,
				reason: 'vague lesson',
				severity: 'warning',
			});
			mockReadKnowledge.mockResolvedValueOnce([]);

			await curateAndStoreSwarm(
				['Use good tools'],
				'test-project',
				{ phase_number: 1 },
				'/project',
				defaultConfig,
			);

			// Warnings don't block storage
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);
			expect(mockAppendRejectedLesson).not.toHaveBeenCalled();
		});
	});

	describe('runAutoPromotion', () => {
		test('candidate with 3 distinct phase confirmations becomes established', async () => {
			// Setup: readKnowledge returns 1 candidate entry with 3 confirmed_by records (different phase numbers)
			const candidateEntry = {
				id: 'entry-1',
				tier: 'swarm',
				lesson: 'Use defensive programming always',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.6,
				status: 'candidate',
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00Z',
						project_name: 'proj',
					},
					{
						phase_number: 2,
						confirmed_at: '2026-01-02T00:00:00Z',
						project_name: 'proj',
					},
					{
						phase_number: 3,
						confirmed_at: '2026-01-03T00:00:00Z',
						project_name: 'proj',
					},
				],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				project_name: 'proj',
				auto_generated: true,
			};
			mockReadKnowledge.mockResolvedValueOnce([candidateEntry]);

			await runAutoPromotion('/project', defaultConfig);

			// rewriteKnowledge should be called with the entry promoted to 'established'
			expect(mockRewriteKnowledge).toHaveBeenCalledTimes(1);
			const [[, writtenEntries]] = mockRewriteKnowledge.mock.calls;
			expect(writtenEntries[0].status).toBe('established');
		});

		test('established entry older than auto_promote_days becomes promoted', async () => {
			// Create a created_at that is older than auto_promote_days
			const oldDate = new Date(
				Date.now() - 91 * 24 * 60 * 60 * 1000,
			).toISOString(); // 91 days ago
			const establishedEntry = {
				id: 'entry-2',
				tier: 'swarm',
				lesson: 'Always validate TypeScript types carefully',
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.7,
				status: 'established',
				confirmed_by: [
					{ phase_number: 1, confirmed_at: oldDate, project_name: 'proj' },
				],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: oldDate,
				updated_at: oldDate,
				project_name: 'proj',
				auto_generated: true,
			};
			mockReadKnowledge.mockResolvedValueOnce([establishedEntry]);

			await runAutoPromotion('/project', defaultConfig); // defaultConfig.auto_promote_days = 90

			expect(mockRewriteKnowledge).toHaveBeenCalledTimes(1);
			const [[, writtenEntries]] = mockRewriteKnowledge.mock.calls;
			expect(writtenEntries[0].status).toBe('promoted');
			expect(writtenEntries[0].hive_eligible).toBe(true);
		});

		test('already-promoted entry is not modified on re-run', async () => {
			const promotedEntry = {
				id: 'entry-3',
				tier: 'swarm',
				lesson: 'Use bun test for fast unit testing',
				category: 'testing',
				tags: ['testing'],
				scope: 'global',
				confidence: 0.8,
				status: 'promoted',
				hive_eligible: true,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00Z',
						project_name: 'proj',
					},
					{
						phase_number: 2,
						confirmed_at: '2026-01-02T00:00:00Z',
						project_name: 'proj',
					},
					{
						phase_number: 3,
						confirmed_at: '2026-01-03T00:00:00Z',
						project_name: 'proj',
					},
				],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2026-01-01T00:00:00Z',
				updated_at: '2026-01-03T00:00:00Z',
				project_name: 'proj',
				auto_generated: true,
			};
			mockReadKnowledge.mockResolvedValueOnce([promotedEntry]);

			await runAutoPromotion('/project', defaultConfig);

			// No changes — rewriteKnowledge should NOT be called
			expect(mockRewriteKnowledge).not.toHaveBeenCalled();
		});

		test('promoted entry has hive_eligible set to true', async () => {
			const oldDate = new Date(
				Date.now() - 95 * 24 * 60 * 60 * 1000,
			).toISOString(); // 95 days ago
			const establishedEntry = {
				id: 'entry-4',
				tier: 'swarm',
				lesson: 'Run bun test to verify module changes',
				category: 'testing',
				tags: [],
				scope: 'global',
				confidence: 0.7,
				status: 'established',
				confirmed_by: [
					{ phase_number: 1, confirmed_at: oldDate, project_name: 'proj' },
				],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: oldDate,
				updated_at: oldDate,
				project_name: 'proj',
				auto_generated: true,
			};
			mockReadKnowledge.mockResolvedValueOnce([establishedEntry]);

			await runAutoPromotion('/project', defaultConfig);

			const [[, writtenEntries]] = mockRewriteKnowledge.mock.calls;
			expect(writtenEntries[0].hive_eligible).toBe(true);
			expect(writtenEntries[0].status).toBe('promoted');
		});
	});

	describe('RETRACT: and BAD RULE: pattern detection', () => {
		test('RETRACT: line does not store as lesson and quarantines matching entry', async () => {
			// Setup: existing knowledge entry with lesson "Always use strict mode"
			const existingEntry = {
				id: 'entry-1',
				tier: 'swarm' as const,
				lesson: 'Always use strict mode',
				category: 'process' as const,
				tags: [],
				scope: 'global',
				confidence: 0.7,
				status: 'candidate' as const,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00Z',
						project_name: 'proj',
					},
				],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2026-01-01T00:00:00Z',
				updated_at: '2026-01-01T00:00:00Z',
				project_name: 'proj',
				auto_generated: true,
			};
			const hiveEntry = {
				...existingEntry,
				id: 'hive-entry-1',
				tier: 'hive' as const,
				source_project: 'other-project',
				encounter_score: 1,
			};
			mockReadKnowledge.mockResolvedValueOnce([existingEntry]);
			mockReadKnowledge.mockResolvedValueOnce([hiveEntry]);

			// Plan with RETRACT: line
			const planContent = `# Test Project
Swarm: mega
Phase: 1

### Lessons Learned
- RETRACT: Always use strict mode
- Another normal lesson
`;
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-retract',
			};
			await hook(input, {});

			// Expected: only the normal lesson stored (1 call), not the retraction
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);
			expect(mockAppendKnowledge).toHaveBeenCalledWith(
				'/project/.swarm/knowledge.jsonl',
				expect.objectContaining({
					lesson: 'Another normal lesson',
				}),
			);

			// Expected: quarantineEntry called for the matching entry
			expect(mockQuarantineEntry).toHaveBeenCalledTimes(1);
			expect(mockQuarantineEntry).toHaveBeenCalledWith(
				'/project',
				'entry-1',
				'Retracted by architect: Always use strict mode',
				'architect',
			);
			expect(mockAppendRetractionRecord).toHaveBeenCalledWith(
				'/project',
				expect.objectContaining({
					normalized_lesson: 'always use strict mode',
					matched_swarm_ids: ['entry-1'],
					matched_hive_ids: ['hive-entry-1'],
				}),
			);
		});

		test('BAD RULE: line has same behavior as RETRACT:', async () => {
			// Setup: existing knowledge entry
			const existingEntry = {
				id: 'entry-2',
				tier: 'swarm' as const,
				lesson: 'Disable all linting errors',
				category: 'process' as const,
				tags: [],
				scope: 'global',
				confidence: 0.6,
				status: 'candidate' as const,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00Z',
						project_name: 'proj',
					},
				],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2026-01-01T00:00:00Z',
				updated_at: '2026-01-01T00:00:00Z',
				project_name: 'proj',
				auto_generated: true,
			};
			const hiveEntry = {
				...existingEntry,
				id: 'hive-entry-2',
				tier: 'hive' as const,
				source_project: 'other-project',
				encounter_score: 1,
			};
			mockReadKnowledge.mockResolvedValueOnce([existingEntry]);
			mockReadKnowledge.mockResolvedValueOnce([hiveEntry]);

			const planContent = `# Test Project
Swarm: mega
Phase: 1

### Lessons Learned
- BAD RULE: Disable all linting errors
- Normal lesson about testing
`;
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-badrule',
			};
			await hook(input, {});

			// Expected: only the normal lesson stored
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);
			expect(mockAppendKnowledge).toHaveBeenCalledWith(
				'/project/.swarm/knowledge.jsonl',
				expect.objectContaining({
					lesson: 'Normal lesson about testing',
				}),
			);

			// Expected: quarantineEntry called with "architect" reporter
			expect(mockQuarantineEntry).toHaveBeenCalledTimes(1);
			expect(mockQuarantineEntry).toHaveBeenCalledWith(
				'/project',
				'entry-2',
				'Retracted by architect: Disable all linting errors',
				'architect',
			);
			expect(mockAppendRetractionRecord).toHaveBeenCalledWith(
				'/project',
				expect.objectContaining({
					normalized_lesson: 'disable all linting errors',
					matched_swarm_ids: ['entry-2'],
					matched_hive_ids: ['hive-entry-2'],
				}),
			);
		});

		test('case-insensitive matching: retract:, RETRACT:, Retract: all detected', async () => {
			const existingEntry = {
				id: 'entry-3',
				tier: 'swarm' as const,
				lesson: 'Test lesson to retract',
				category: 'process' as const,
				tags: [],
				scope: 'global',
				confidence: 0.5,
				status: 'candidate' as const,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00Z',
						project_name: 'proj',
					},
				],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2026-01-01T00:00:00Z',
				updated_at: '2026-01-01T00:00:00Z',
				project_name: 'proj',
				auto_generated: true,
			};
			mockReadKnowledge.mockResolvedValueOnce([existingEntry]);

			// Test with lowercase "retract:"
			mockNormalize.mockImplementation((text: string) =>
				text.toLowerCase().trim(),
			);
			mockReadSwarmFileAsync.mockResolvedValueOnce(`# Test
Swarm: mega

### Lessons Learned
- retract: Test lesson to retract
`);
			const hook1 = createKnowledgeCuratorHook('/project', defaultConfig);
			await hook1(
				{
					toolName: 'write',
					path: '/project/.swarm/plan.md',
					sessionID: 'sess-lower',
				},
				{},
			);
			expect(mockQuarantineEntry).toHaveBeenCalledTimes(1);
			vi.clearAllMocks();

			// Test with uppercase "RETRACT:"
			mockReadKnowledge.mockResolvedValueOnce([existingEntry]);
			mockReadSwarmFileAsync.mockResolvedValueOnce(`# Test
Swarm: mega

### Lessons Learned
- RETRACT: Test lesson to retract
`);
			const hook2 = createKnowledgeCuratorHook('/project', defaultConfig);
			await hook2(
				{
					toolName: 'write',
					path: '/project/.swarm/plan.md',
					sessionID: 'sess-upper',
				},
				{},
			);
			expect(mockQuarantineEntry).toHaveBeenCalledTimes(1);
			vi.clearAllMocks();

			// Test with mixed case "Retract:"
			mockReadKnowledge.mockResolvedValueOnce([existingEntry]);
			mockReadSwarmFileAsync.mockResolvedValueOnce(`# Test
Swarm: mega

### Lessons Learned
- Retract: Test lesson to retract
`);
			const hook3 = createKnowledgeCuratorHook('/project', defaultConfig);
			await hook3(
				{
					toolName: 'write',
					path: '/project/.swarm/plan.md',
					sessionID: 'sess-mixed',
				},
				{},
			);
			expect(mockQuarantineEntry).toHaveBeenCalledTimes(1);
		});

		test('mixed section: RETRACT: lines and normal lessons stored correctly', async () => {
			const entryToQuarantine = {
				id: 'entry-4',
				tier: 'swarm' as const,
				lesson: 'Old outdated rule',
				category: 'process' as const,
				tags: [],
				scope: 'global',
				confidence: 0.7,
				status: 'candidate' as const,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00Z',
						project_name: 'proj',
					},
				],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2026-01-01T00:00:00Z',
				updated_at: '2026-01-01T00:00:00Z',
				project_name: 'proj',
				auto_generated: true,
			};
			mockReadKnowledge.mockResolvedValueOnce([entryToQuarantine]);

			const planContent = `# Test Project
Swarm: mega
Phase: 1

### Lessons Learned
- First valid lesson
- RETRACT: Old outdated rule
- Second valid lesson
- BAD RULE: Another bad rule
- Third valid lesson
`;
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-mixed',
			};
			await hook(input, {});

			// Expected: 3 normal lessons stored (not the retraction lines)
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(3);
			const lessonsStored = mockAppendKnowledge.mock.calls.map(
				([, entry]) => entry.lesson,
			);
			expect(lessonsStored).toContain('First valid lesson');
			expect(lessonsStored).toContain('Second valid lesson');
			expect(lessonsStored).toContain('Third valid lesson');
			expect(lessonsStored).not.toContain('RETRACT: Old outdated rule');
			expect(lessonsStored).not.toContain('BAD RULE: Another bad rule');

			// Expected: quarantineEntry called once for the matching entry
			expect(mockQuarantineEntry).toHaveBeenCalledTimes(1);
			expect(mockQuarantineEntry).toHaveBeenCalledWith(
				'/project',
				'entry-4',
				'Retracted by architect: Old outdated rule',
				'architect',
			);
		});

		test('no matching entry: RETRACT: with no matching lesson is no-op (no crash)', async () => {
			// No existing knowledge entries
			mockReadKnowledge.mockResolvedValueOnce([]);

			const planContent = `# Test Project
Swarm: mega
Phase: 1

### Lessons Learned
- RETRACT: Non-existent lesson that does not exist
- Normal lesson still stored
`;
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-nomatch',
			};

			// Should NOT throw
			await expect(hook(input, {})).resolves.toBeUndefined();

			// Normal lesson still stored
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);
			expect(mockAppendKnowledge).toHaveBeenCalledWith(
				'/project/.swarm/knowledge.jsonl',
				expect.objectContaining({
					lesson: 'Normal lesson still stored',
				}),
			);

			// quarantineEntry should NOT be called (no match)
			expect(mockQuarantineEntry).not.toHaveBeenCalled();
		});

		test('empty retraction text: RETRACT: with nothing after colon is ignored', async () => {
			mockReadKnowledge.mockResolvedValueOnce([]);

			const planContent = `# Test Project
Swarm: mega
Phase: 1

### Lessons Learned
- RETRACT:
- Normal lesson should still be stored
- BAD RULE:
- Another normal lesson
`;
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-empty',
			};
			await hook(input, {});

			// Expected: 2 normal lessons stored (empty retractions ignored)
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(2);
			const lessonsStored = mockAppendKnowledge.mock.calls.map(
				([, entry]) => entry.lesson,
			);
			expect(lessonsStored).toContain('Normal lesson should still be stored');
			expect(lessonsStored).toContain('Another normal lesson');

			// Expected: quarantineEntry NOT called (empty retraction text ignored)
			expect(mockQuarantineEntry).not.toHaveBeenCalled();
		});

		test('multiple retractions in one section process all matching entries', async () => {
			const entry1 = {
				id: 'entry-5',
				tier: 'swarm' as const,
				lesson: 'First rule to retract',
				category: 'process' as const,
				tags: [],
				scope: 'global',
				confidence: 0.7,
				status: 'candidate' as const,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00Z',
						project_name: 'proj',
					},
				],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2026-01-01T00:00:00Z',
				updated_at: '2026-01-01T00:00:00Z',
				project_name: 'proj',
				auto_generated: true,
			};
			const entry2 = {
				id: 'entry-6',
				tier: 'swarm' as const,
				lesson: 'Second rule to retract',
				category: 'process' as const,
				tags: [],
				scope: 'global',
				confidence: 0.6,
				status: 'candidate' as const,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00Z',
						project_name: 'proj',
					},
				],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2026-01-01T00:00:00Z',
				updated_at: '2026-01-01T00:00:00Z',
				project_name: 'proj',
				auto_generated: true,
			};
			mockReadKnowledge.mockResolvedValueOnce([entry1, entry2]);

			const planContent = `# Test Project
Swarm: mega
Phase: 1

### Lessons Learned
- RETRACT: First rule to retract
- RETRACT: Second rule to retract
- Normal lesson
`;
			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-multi',
			};
			await hook(input, {});

			// Expected: only 1 normal lesson stored
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);

			// Expected: quarantineEntry called twice (once for each matching entry)
			expect(mockQuarantineEntry).toHaveBeenCalledTimes(2);
			expect(mockQuarantineEntry).toHaveBeenCalledWith(
				'/project',
				'entry-5',
				'Retracted by architect: First rule to retract',
				'architect',
			);
			expect(mockQuarantineEntry).toHaveBeenCalledWith(
				'/project',
				'entry-6',
				'Retracted by architect: Second rule to retract',
				'architect',
			);
		});
	});

	describe('retrieval outcome semantics', () => {
		test('curation does not mark retrieval outcomes as successful', async () => {
			const planContent = `# Test Project
Swarm: mega
Phase: 7

### Lessons Learned
- Always use TypeScript strict mode
`;

			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-update',
			};

			await hook(input, {});

			// Curation should not eagerly claim a success outcome.
			expect(mockUpdateRetrievalOutcome).not.toHaveBeenCalled();

			// Also ensure curation happened
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);
		});

		test('curation with zero stored entries still does not mark outcome', async () => {
			const planContent = `# Test Project
Swarm: mega
Phase: 3

### Lessons Learned
- Lesson will be rejected
`;

			// Make validation fail so no entries are stored
			mockValidateLesson.mockReturnValueOnce({
				valid: false,
				layer: 1,
				reason: 'test rejection',
				severity: 'error',
			});

			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-zero-entries',
			};

			await hook(input, {});

			// No success/failure outcome should be attributed at curation time.
			expect(mockUpdateRetrievalOutcome).not.toHaveBeenCalled();

			// Confirm no entries were stored
			expect(mockAppendKnowledge).not.toHaveBeenCalled();
		});

		test('curation remains safe even without retrieval-outcome side effects', async () => {
			const planContent = `# Test Project
Swarm: mega
Phase: 5

### Lessons Learned
- Test lesson
`;

			// Make safeHook wrap the function to catch errors (the real behavior)
			mockSafeHook.mockImplementation((fn: unknown) => {
				return async (...args: unknown[]) => {
					try {
						await (fn as (input: unknown, output: unknown) => Promise<void>)(
							args[0],
							args[1],
						);
					} catch {
						// Swallow the error
					}
				};
			});

			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-error-swallow',
			};

			// Expected: hook should NOT throw (safeHook catches errors)
			await expect(hook(input, {})).resolves.toBeUndefined();

			expect(mockUpdateRetrievalOutcome).not.toHaveBeenCalled();

			// Curation should have completed successfully
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);
		});

		test('phase parsing still works for single-digit phases', async () => {
			const planContent = `# Test Project
Swarm: mega
Phase: 1

### Lessons Learned
- First phase lesson
`;

			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-phase-1',
			};

			await hook(input, {});

			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);
		});

		test('phase parsing still works for multi-digit phases', async () => {
			const planContent = `# Test Project
Swarm: mega
Phase: 12

### Lessons Learned
- Multi-digit phase lesson
`;

			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-phase-12',
			};

			await hook(input, {});

			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);
		});

		test('phase number defaults to 1 when Phase: header is missing', async () => {
			const planContent = `# Test Project
Swarm: mega

### Lessons Learned
- Lesson without phase header
`;

			mockReadSwarmFileAsync.mockResolvedValueOnce(planContent);

			const hook = createKnowledgeCuratorHook('/project', defaultConfig);
			const input = {
				toolName: 'write',
				path: '/project/.swarm/plan.md',
				sessionID: 'sess-no-phase',
			};

			await hook(input, {});

			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1);
		});
	});
});
