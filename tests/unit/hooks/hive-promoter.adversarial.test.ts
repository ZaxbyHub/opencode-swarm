/**
 * Adversarial security/edge-case tests for hive-promoter.ts
 *
 * These tests ONLY attack vectors — malformed inputs, oversized payloads,
 * injection attempts, boundary violations, abuse of the promotion system.
 *
 * Happy-path tests are in hive-promoter.test.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	checkHivePromotions,
	createHivePromoterHook,
} from '../../../src/hooks/hive-promoter.js';
import type {
	HiveKnowledgeEntry,
	KnowledgeConfig,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types.js';

// Mock knowledge-store module
vi.mock('../../../src/hooks/knowledge-store.js', () => ({
	resolveHiveKnowledgePath: vi
		.fn()
		.mockReturnValue('/hive/shared-learnings.jsonl'),
	resolveHiveRejectedPath: vi
		.fn()
		.mockReturnValue('/hive/shared-learnings-rejected.jsonl'),
	resolveSwarmKnowledgePath: vi
		.fn()
		.mockReturnValue('/swarm/.swarm/knowledge.jsonl'),
	readKnowledge: vi.fn().mockResolvedValue([]),
	appendKnowledge: vi.fn().mockResolvedValue(undefined),
	rewriteKnowledge: vi.fn().mockResolvedValue(undefined),
	findNearDuplicate: vi.fn().mockReturnValue(undefined),
	computeConfidence: vi.fn().mockReturnValue(0.6),
	enforceKnowledgeCap: async () => {},
	sweepAgedEntries: async () => {},
	sweepStaleTodos: async () => {},
	bumpKnowledgeConfidenceBatch: async () => {},
}));

// Import after mocking to ensure mocks are applied
import {
	appendKnowledge,
	findNearDuplicate,
	readKnowledge,
	resolveHiveKnowledgePath,
	resolveHiveRejectedPath,
	rewriteKnowledge,
} from '../../../src/hooks/knowledge-store.js';

// Mock validateLesson to pass by default (we'll override in specific tests)
vi.mock('../../../src/hooks/knowledge-validator.js', () => ({
	validateLesson: vi.fn().mockReturnValue({
		valid: true,
		layer: 1,
		reason: '',
		severity: 'none',
	}),
}));

import { validateLesson } from '../../../src/hooks/knowledge-validator.js';

describe('hive-promoter adversarial tests', () => {
	let mockConfig: KnowledgeConfig;
	let mockSwarmEntries: SwarmKnowledgeEntry[];
	let mockHiveEntries: HiveKnowledgeEntry[];

	beforeEach(() => {
		// Reset all mocks
		vi.clearAllMocks();

		// Reset validateLesson to pass by default
		(validateLesson as vi.Mock).mockReturnValue({
			valid: true,
			layer: 1,
			reason: '',
			severity: 'none',
		});

		// Default config
		mockConfig = {
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

		// Default mock swarm entry
		mockSwarmEntries = [
			{
				id: 'swarm-1',
				tier: 'swarm',
				lesson: 'Valid lesson about testing strategies',
				category: 'testing',
				tags: ['testing', 'quality'],
				scope: 'global',
				confidence: 0.8,
				status: 'candidate',
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2024-01-01T00:00:00Z',
						project_name: 'project-a',
					},
					{
						phase_number: 2,
						confirmed_at: '2024-01-02T00:00:00Z',
						project_name: 'project-a',
					},
					{
						phase_number: 3,
						confirmed_at: '2024-01-03T00:00:00Z',
						project_name: 'project-a',
					},
				],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
				hive_eligible: true,
				project_name: 'project-a',
			},
		];

		mockHiveEntries = [];

		// Setup readKnowledge to return hive entries (use a closure to track the current hive entries)
		(readKnowledge as vi.Mock).mockImplementation((path: string) => {
			if (path === '/hive/shared-learnings.jsonl') {
				return Promise.resolve([...mockHiveEntries]); // Return a copy
			}
			return Promise.resolve([]);
		});

		// Setup findNearDuplicate to return undefined by default (no duplicate found)
		(findNearDuplicate as vi.Mock).mockReturnValue(undefined);
	});

	describe('SCENARIO 1: Empty swarm entries array', () => {
		it('should complete without errors and no I/O when swarm entries is empty', async () => {
			await checkHivePromotions([], mockConfig);

			// Should read hive entries once
			expect(readKnowledge).toHaveBeenCalledTimes(1);

			// Should not append anything (no entries to promote)
			expect(appendKnowledge).not.toHaveBeenCalled();

			// Should not rewrite hive (no modifications)
			expect(rewriteKnowledge).not.toHaveBeenCalled();
		});
	});

	describe('SCENARIO 2: Null/undefined lesson in swarm entry', () => {
		it('should not crash when lesson is null', async () => {
			const entryWithNullLesson: SwarmKnowledgeEntry = {
				...mockSwarmEntries[0],
				lesson: null as unknown as string,
			};

			// This should not throw - validateLesson will catch it
			await checkHivePromotions([entryWithNullLesson], mockConfig);

			// Should attempt to validate and reject
			expect(validateLesson).toHaveBeenCalled();
		});

		it('should not crash when lesson is undefined', async () => {
			const entryWithUndefinedLesson: SwarmKnowledgeEntry = {
				...mockSwarmEntries[0],
				lesson: undefined as unknown as string,
			};

			// This should not throw
			await checkHivePromotions([entryWithUndefinedLesson], mockConfig);

			// Should attempt to validate
			expect(validateLesson).toHaveBeenCalled();
		});
	});

	describe('SCENARIO 3: Negative auto_promote_days', () => {
		it('should promote ALL entries when auto_promote_days is negative (age threshold negative)', async () => {
			const configWithNegativeDays = { ...mockConfig, auto_promote_days: -1 };

			const entries: SwarmKnowledgeEntry[] = [
				{
					...mockSwarmEntries[0],
					id: 'swarm-2',
					created_at: new Date().toISOString(), // Very new entry
					hive_eligible: false, // Not eligible via route 1
					tags: [], // No fast-track tag
				},
			];

			await checkHivePromotions(entries, configWithNegativeDays);

			// With negative days, ageThresholdMs is negative, so ageMs (always >= 0) >= negativeThreshold is true
			// Should promote via age-based route (Route 3)
			expect(appendKnowledge).toHaveBeenCalledTimes(1);
		});
	});

	describe('SCENARIO 4: Zero dedup_threshold', () => {
		it('should treat all entries as duplicates when dedup_threshold is 0', async () => {
			const configWithZeroThreshold = { ...mockConfig, dedup_threshold: 0 };

			// Add a hive entry that the swarm entry would match
			mockHiveEntries = [
				{
					id: 'hive-existing',
					tier: 'hive',
					lesson: 'Valid lesson about testing strategies',
					category: 'testing',
					tags: ['testing', 'quality'],
					scope: 'global',
					confidence: 0.5,
					status: 'candidate',
					confirmed_by: [],
					retrieval_outcomes: {
						applied_count: 0,
						succeeded_after_count: 0,
						failed_after_count: 0,
					},
					schema_version: 1,
					created_at: '2024-01-01T00:00:00Z',
					updated_at: '2024-01-01T00:00:00Z',
					source_project: 'project-x',
				},
			];

			// Mock findNearDuplicate to return the entry itself when threshold is 0
			// (simulating "everything matches everything")
			(findNearDuplicate as vi.Mock).mockReturnValue(mockHiveEntries[0]);

			const entries: SwarmKnowledgeEntry[] = [
				{
					...mockSwarmEntries[0],
					id: 'swarm-2',
					hive_eligible: true,
					confirmed_by: [
						{
							phase_number: 1,
							confirmed_at: '2024-01-01T00:00:00Z',
							project_name: 'project-a',
						},
						{
							phase_number: 2,
							confirmed_at: '2024-01-02T00:00:00Z',
							project_name: 'project-a',
						},
						{
							phase_number: 3,
							confirmed_at: '2024-01-03T00:00:00Z',
							project_name: 'project-a',
						},
					],
				},
			];

			await checkHivePromotions(entries, configWithZeroThreshold);

			// Should find duplicate and skip promotion
			expect(appendKnowledge).not.toHaveBeenCalled();
		});
	});

	describe('SCENARIO 5: Crafted hive-fast-track tag (repeated)', () => {
		it('should promote only once even with repeated hive-fast-track tag', async () => {
			const entryWithRepeatedTag: SwarmKnowledgeEntry = {
				...mockSwarmEntries[0],
				tags: ['hive-fast-track', 'hive-fast-track', 'hive-fast-track'],
			};

			await checkHivePromotions([entryWithRepeatedTag], mockConfig);

			// Should append exactly once (tags.includes check is true once)
			expect(appendKnowledge).toHaveBeenCalledTimes(1);
		});
	});

	describe('SCENARIO 6: Swarm entry with 3 phases all from same phase_number', () => {
		it('should NOT promote when all 3 confirmations are from the same phase (not distinct)', async () => {
			const entryWithSamePhase: SwarmKnowledgeEntry = {
				...mockSwarmEntries[0],
				hive_eligible: true,
				tags: [], // No fast-track tag
				created_at: new Date().toISOString(), // Recent entry so age route won't trigger
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2024-01-01T00:00:00Z',
						project_name: 'project-a',
					},
					{
						phase_number: 1,
						confirmed_at: '2024-01-02T00:00:00Z',
						project_name: 'project-a',
					},
					{
						phase_number: 1,
						confirmed_at: '2024-01-03T00:00:00Z',
						project_name: 'project-a',
					},
				],
			};

			await checkHivePromotions([entryWithSamePhase], mockConfig);

			// Route 1 requires 3 DISTINCT phases, this has only 1 distinct phase
			// Route 2 has no fast-track tag
			// Route 3 won't trigger because created_at is recent
			// Should NOT promote
			expect(appendKnowledge).not.toHaveBeenCalled();
		});
	});

	describe('SCENARIO 7: Hive entry with confirmed_by from same project 3 times', () => {
		it('should NOT advance to established with 3 confirmations from same project', async () => {
			const hiveEntryWithSameProject: HiveKnowledgeEntry = {
				id: 'hive-1',
				tier: 'hive',
				lesson: 'Test lesson',
				category: 'testing',
				tags: ['testing'],
				scope: 'global',
				confidence: 0.5,
				status: 'candidate',
				confirmed_by: [
					{ project_name: 'project-a', confirmed_at: '2024-01-01T00:00:00Z' },
					{ project_name: 'project-a', confirmed_at: '2024-01-02T00:00:00Z' },
					{ project_name: 'project-a', confirmed_at: '2024-01-03T00:00:00Z' },
				],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
				source_project: 'project-a',
			};

			mockHiveEntries = [hiveEntryWithSameProject];

			const swarmEntry: SwarmKnowledgeEntry = {
				...mockSwarmEntries[0],
				project_name: 'project-a', // Same project as hive entry source
			};

			await checkHivePromotions([swarmEntry], mockConfig);

			// Should not advance to established (only 1 distinct project, not 3)
			const hiveModified = (rewriteKnowledge as vi.Mock).mock.calls.length > 0;
			if (hiveModified) {
				const updatedHive = (rewriteKnowledge as vi.Mock).mock
					.calls[0][1] as HiveKnowledgeEntry[];
				const entry = updatedHive[0];
				expect(entry.status).toBe('candidate'); // Should NOT be established
			}
		});
	});

	describe('SCENARIO 8: Lesson exactly at 280 char boundary', () => {
		it('should validate successfully at exactly 280 chars', async () => {
			const lesson280 = 'x'.repeat(280);

			const entry280: SwarmKnowledgeEntry = {
				...mockSwarmEntries[0],
				lesson: lesson280,
				hive_eligible: true,
			};

			(validateLesson as vi.Mock).mockReturnValue({
				valid: true,
				layer: 1,
				reason: '',
				severity: 'none',
			});

			await checkHivePromotions([entry280], mockConfig);

			// Should promote (validation passes)
			expect(appendKnowledge).toHaveBeenCalledTimes(1);
		});

		it('should fail validation at 281 chars', async () => {
			const lesson281 = 'x'.repeat(281);

			const entry281: SwarmKnowledgeEntry = {
				...mockSwarmEntries[0],
				lesson: lesson281,
				hive_eligible: true,
			};

			(validateLesson as vi.Mock).mockReturnValue({
				valid: false,
				layer: 1,
				reason: 'Lesson too long',
				severity: 'error',
			});

			await checkHivePromotions([entry281], mockConfig);

			// Should NOT promote to hive, should reject
			expect(appendKnowledge).toHaveBeenCalledTimes(1); // One call to append rejected
			expect(resolveHiveRejectedPath).toHaveBeenCalled();
		});
	});

	describe('SCENARIO 9: Lesson with injection attempt (control characters)', () => {
		it('should block lesson with control characters before hive write', async () => {
			const injectionLesson = 'Test lesson \x00\x01\x02\x1b with control chars';

			const entryWithInjection: SwarmKnowledgeEntry = {
				...mockSwarmEntries[0],
				lesson: injectionLesson,
				hive_eligible: true,
			};

			(validateLesson as vi.Mock).mockReturnValue({
				valid: false,
				layer: 2,
				reason: 'Control characters detected',
				severity: 'error',
			});

			await checkHivePromotions([entryWithInjection], mockConfig);

			// Should NOT promote to hive knowledge
			// Should append to rejected lessons
			expect(appendKnowledge).toHaveBeenCalledTimes(1);
			expect(resolveHiveRejectedPath).toHaveBeenCalled();
		});
	});

	describe('SCENARIO 10: Very large swarm entries array (1000 entries)', () => {
		it('should process 1000 entries without hanging or error', async () => {
			const largeArray: SwarmKnowledgeEntry[] = Array.from(
				{ length: 1000 },
				(_, i) => ({
					...mockSwarmEntries[0],
					id: `swarm-${i}`,
					lesson: `Lesson number ${i}`,
				}),
			);

			// Should not throw
			await checkHivePromotions(largeArray, mockConfig);

			// Should have read hive entries
			expect(readKnowledge).toHaveBeenCalled();

			// With default config and valid entries, should promote all (mocked validation passes)
			// Unless findNearDuplicate blocks them
			expect(appendKnowledge).toHaveBeenCalled();
		});
	});

	describe('SCENARIO 11: config.hive_enabled = undefined (falsy but not false)', () => {
		it('should NOT early-exit when hive_enabled is undefined (only === false exits)', async () => {
			const configWithUndefined: KnowledgeConfig = {
				...mockConfig,
				hive_enabled: undefined as unknown as boolean, // Explicitly undefined
			};

			const eligibleEntry: SwarmKnowledgeEntry = {
				...mockSwarmEntries[0],
				hive_eligible: true,
			};

			await checkHivePromotions([eligibleEntry], configWithUndefined);

			// The code checks `config.hive_enabled === false` to early exit
			// undefined is not === false, so it should proceed
			expect(readKnowledge).toHaveBeenCalled(); // Should read hive entries
			// Should attempt promotion
			expect(appendKnowledge).toHaveBeenCalled();
		});
	});

	describe('SCENARIO 12: Swarm entry with schema_version: 0 or NaN', () => {
		it('should use config.schema_version when entry has schema_version: 0', async () => {
			const entryWithSchema0: SwarmKnowledgeEntry = {
				...mockSwarmEntries[0],
				schema_version: 0,
			};

			await checkHivePromotions([entryWithSchema0], mockConfig);

			// Should call appendKnowledge - check the hive entry uses config.schema_version
			expect(appendKnowledge).toHaveBeenCalled();

			// Get the first call's second argument (the hive entry)
			const calls = (appendKnowledge as vi.Mock).mock.calls;
			expect(calls.length).toBeGreaterThan(0);

			const appendCall = calls[0]; // Get the first call
			expect(appendCall.length).toBe(2); // Should have 2 arguments: path and entry

			const hiveEntry = appendCall[1] as HiveKnowledgeEntry;

			// The hive entry should use config.schema_version (1), not the swarm entry's schema_version (0)
			expect(hiveEntry.schema_version).toBe(mockConfig.schema_version); // Should be 1 from config
		});

		it('should use config.schema_version when entry has schema_version: NaN', async () => {
			const entryWithNaN: SwarmKnowledgeEntry = {
				...mockSwarmEntries[0],
				schema_version: NaN,
			};

			await checkHivePromotions([entryWithNaN], mockConfig);

			// Should call appendKnowledge
			expect(appendKnowledge).toHaveBeenCalled();

			// Get the first call (the hive append)
			const calls = (appendKnowledge as vi.Mock).mock.calls;
			expect(calls.length).toBeGreaterThan(0);

			const appendCall = calls[0];
			const hiveEntry = appendCall[1] as HiveKnowledgeEntry;

			// The hive entry should use config.schema_version (1), not NaN
			expect(hiveEntry.schema_version).toBe(mockConfig.schema_version); // Should be 1 from config
		});
	});

	describe('Additional edge cases', () => {
		it('should handle entry with invalid created_at date gracefully', async () => {
			const entryWithInvalidDate: SwarmKnowledgeEntry = {
				...mockSwarmEntries[0],
				created_at: 'invalid-date',
				hive_eligible: false,
				tags: [],
			};

			// getEntryAgeMs returns 0 for invalid dates
			// So age check would be: 0 >= (90 * 86400000) = false
			// Should not promote via age route
			await checkHivePromotions([entryWithInvalidDate], mockConfig);
			expect(appendKnowledge).not.toHaveBeenCalled();
		});

		it('should handle empty tags array without error', async () => {
			const entryWithEmptyTags: SwarmKnowledgeEntry = {
				...mockSwarmEntries[0],
				tags: [],
				hive_eligible: true,
			};

			await checkHivePromotions([entryWithEmptyTags], mockConfig);

			// Should still promote via route 1
			expect(appendKnowledge).toHaveBeenCalled();
		});

		it('should handle entry with missing hive_eligible property (undefined)', async () => {
			const entryWithoutEligible: SwarmKnowledgeEntry = {
				...mockSwarmEntries[0],
			};
			delete (entryWithoutEligible as any).hive_eligible;

			// hive_eligible defaults to undefined, which is falsy
			// So route 1 won't trigger, but route 2 or 3 might
			await checkHivePromotions([entryWithoutEligible], mockConfig);
		});
	});
});
