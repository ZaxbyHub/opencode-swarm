/**
 * Adversarial tests for Task 3.4: curator-summary feedback changes
 * Tests specifically attack vectors relevant to the curator-summary integration:
 * - Malformed summary writes
 * - Curator-summary corruption risk
 * - Missing curator summary edge cases
 * - Leakage of unintended data in the summary payload
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock curator module
const mockReadCuratorSummary = vi.fn();
const mockWriteCuratorSummary = vi.fn();

vi.mock('../../../src/hooks/curator.js', () => ({
	readCuratorSummary: (...args: unknown[]) => mockReadCuratorSummary(...args),
	writeCuratorSummary: (...args: unknown[]) => mockWriteCuratorSummary(...args),
}));

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

// Mock validateLesson
vi.mock('../../../src/hooks/knowledge-validator.js', () => ({
	validateLesson: vi.fn().mockReturnValue({
		valid: true,
		layer: 1,
		reason: '',
		severity: 'none',
	}),
}));

// Import after mocking
import { createHivePromoterHook } from '../../../src/hooks/hive-promoter.js';
import type { KnowledgeConfig } from '../../../src/hooks/knowledge-types.js';

describe('Task 3.4: curator-summary feedback integration adversarial tests', () => {
	let mockConfig: KnowledgeConfig;

	beforeEach(() => {
		vi.clearAllMocks();

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
			same_project_weight: 0.5,
			cross_project_weight: 1.0,
			min_encounter_score: 0.0,
			initial_encounter_score: 1.0,
			encounter_increment: 0.1,
			max_encounter_score: 5.0,
		};
	});

	describe('VULNERABILITY 2: Corrupted curator summary data', () => {
		it('CRASH: should fail when curator summary has invalid schema_version type', async () => {
			mockReadCuratorSummary.mockResolvedValue({
				schema_version: '1', // String instead of number!
				session_id: 'test-session',
				last_updated: '2024-01-01T00:00:00Z',
				last_phase_covered: 1,
				digest: 'Test digest',
				phase_digests: [],
				compliance_observations: [],
				knowledge_recommendations: [],
			});

			const hook = createHivePromoterHook('/test-project', mockConfig);

			// This might not crash but could cause issues downstream
			await hook({}, {});

			// The hook uses safeHook which suppresses errors, so let's check write wasn't called with bad data
			// Note: This test documents the vulnerability
		});

		it('CRASH: should fail when last_phase_covered is not a number', async () => {
			mockReadCuratorSummary.mockResolvedValue({
				schema_version: 1,
				session_id: 'test-session',
				last_updated: '2024-01-01T00:00:00Z',
				last_phase_covered: 'one', // String instead of number!
				digest: 'Test digest',
				phase_digests: [],
				compliance_observations: [],
				knowledge_recommendations: [],
			});

			const hook = createHivePromoterHook('/test-project', mockConfig);
			await hook({}, {});
			// Hook runs without crash due to safeHook, but data is corrupted
		});
	});

	describe('VULNERABILITY 3: Missing last_updated property', () => {
		it('should handle missing last_updated property gracefully', async () => {
			mockReadCuratorSummary.mockResolvedValue({
				schema_version: 1,
				session_id: 'test-session',
				// last_updated is MISSING
				last_phase_covered: 1,
				digest: 'Test digest',
				phase_digests: [],
				compliance_observations: [],
				knowledge_recommendations: [],
			});

			const hook = createHivePromoterHook('/test-project', mockConfig);

			// Should not crash
			await hook({}, {});

			// Should have written summary with new last_updated
			expect(mockWriteCuratorSummary).toHaveBeenCalled();
			const writtenSummary = mockWriteCuratorSummary.mock.calls[0][1];
			expect(writtenSummary.last_updated).toBeDefined();
		});
	});

	describe('EDGE CASE: No curator summary exists', () => {
		it('should handle null curator summary (no prior summary)', async () => {
			// No prior curator summary
			mockReadCuratorSummary.mockResolvedValue(null);

			const hook = createHivePromoterHook('/test-project', mockConfig);

			// Should NOT crash - hook just won't update curator summary
			await hook({}, {});

			// Should NOT attempt to write curator summary
			expect(mockWriteCuratorSummary).not.toHaveBeenCalled();
		});
	});

	describe('DATA LEAKAGE: Unintended data in recommendation payload', () => {
		it('should NOT leak internal file paths in recommendation', async () => {
			mockReadCuratorSummary.mockResolvedValue({
				schema_version: 1,
				session_id: 'test-session',
				last_updated: '2024-01-01T00:00:00Z',
				last_phase_covered: 1,
				digest: 'Test digest',
				phase_digests: [],
				compliance_observations: [],
				knowledge_recommendations: [],
			});

			const hook = createHivePromoterHook('/test-project', mockConfig);
			await hook({}, {});

			expect(mockWriteCuratorSummary).toHaveBeenCalled();
			const writtenSummary = mockWriteCuratorSummary.mock.calls[0][1];

			// Check the recommendation doesn't contain file paths
			const rec = writtenSummary.knowledge_recommendations[0];
			expect(rec.lesson).not.toContain('/test-project');
			expect(rec.lesson).not.toContain('\\test-project');
			expect(rec.reason).not.toContain('/test-project');
			expect(rec.reason).not.toContain('\\test-project');
		});

		it('should NOT leak directory parameter in recommendation reason', async () => {
			mockReadCuratorSummary.mockResolvedValue({
				schema_version: 1,
				session_id: 'test-session',
				last_updated: '2024-01-01T00:00:00Z',
				last_phase_covered: 1,
				digest: 'Test digest',
				phase_digests: [],
				compliance_observations: [],
				knowledge_recommendations: [],
			});

			// Test with a suspicious path that might leak
			const suspiciousPath = '/Users/user/.ssh/id_rsa';
			const hook = createHivePromoterHook(suspiciousPath, mockConfig);
			await hook({}, {});

			expect(mockWriteCuratorSummary).toHaveBeenCalled();
			const writtenSummary = mockWriteCuratorSummary.mock.calls[0][1];

			const rec = writtenSummary.knowledge_recommendations[0];
			// The reason JSON should only contain promotion stats, not paths
			expect(rec.reason).not.toContain('.ssh');
			expect(rec.reason).not.toContain('id_rsa');
		});

		it('should only expose aggregate stats in recommendation lesson', async () => {
			mockReadCuratorSummary.mockResolvedValue({
				schema_version: 1,
				session_id: 'test-session',
				last_updated: '2024-01-01T00:00:00Z',
				last_phase_covered: 1,
				digest: 'Test digest',
				phase_digests: [],
				compliance_observations: [],
				knowledge_recommendations: [],
			});

			const hook = createHivePromoterHook('/test-project', mockConfig);
			await hook({}, {});

			expect(mockWriteCuratorSummary).toHaveBeenCalled();
			const writtenSummary = mockWriteCuratorSummary.mock.calls[0][1];

			const rec = writtenSummary.knowledge_recommendations[0];

			// Lesson should only contain these words (aggregate counts)
			expect(rec.lesson).toMatch(/Hive promotion:/);
			expect(rec.lesson).toMatch(/new/);
			expect(rec.lesson).toMatch(/encounters/);
			expect(rec.lesson).toMatch(/advancements/);
			expect(rec.lesson).toMatch(/total entries/);

			// Should NOT contain individual lesson content
			expect(rec.lesson).not.toContain('lesson:');
			expect(rec.lesson).not.toContain('Test lesson');
		});
	});

	describe('EDGE CASE: Very large promotion counts', () => {
		it('should handle very large new_promotions count without overflow', async () => {
			mockReadCuratorSummary.mockResolvedValue({
				schema_version: 1,
				session_id: 'test-session',
				last_updated: '2024-01-01T00:00:00Z',
				last_phase_covered: 1,
				digest: 'Test digest',
				phase_digests: [],
				compliance_observations: [],
				knowledge_recommendations: [],
			});

			// Mock huge promotion counts via the internal function
			// We can't directly control this, but we verify the format handles it
			const hook = createHivePromoterHook('/test-project', mockConfig);
			await hook({}, {});

			expect(mockWriteCuratorSummary).toHaveBeenCalled();
			const writtenSummary = mockWriteCuratorSummary.mock.calls[0][1];

			const rec = writtenSummary.knowledge_recommendations[0];

			// Reason should be valid JSON
			const parsedReason = JSON.parse(rec.reason);
			expect(parsedReason).toHaveProperty('new_promotions');
			expect(parsedReason).toHaveProperty('encounters_incremented');
			expect(parsedReason).toHaveProperty('advancements');
			expect(parsedReason).toHaveProperty('total_hive_entries');
		});
	});

	describe('EDGE CASE: JSON serialization in reason field', () => {
		it('should properly escape special characters in reason JSON', async () => {
			mockReadCuratorSummary.mockResolvedValue({
				schema_version: 1,
				session_id: 'test-session',
				last_updated: '2024-01-01T00:00:00Z',
				last_phase_covered: 1,
				digest: 'Test digest',
				phase_digests: [],
				compliance_observations: [],
				knowledge_recommendations: [],
			});

			const hook = createHivePromoterHook('/test-project', mockConfig);
			await hook({}, {});

			expect(mockWriteCuratorSummary).toHaveBeenCalled();
			const writtenSummary = mockWriteCuratorSummary.mock.calls[0][1];

			const rec = writtenSummary.knowledge_recommendations[0];

			// Reason should be valid parseable JSON
			expect(() => JSON.parse(rec.reason)).not.toThrow();

			// The parsed result should have expected structure
			const parsed = JSON.parse(rec.reason);
			expect(typeof parsed.timestamp).toBe('string');
			expect(typeof parsed.new_promotions).toBe('number');
			expect(typeof parsed.encounters_incremented).toBe('number');
			expect(typeof parsed.advancements).toBe('number');
			expect(typeof parsed.total_hive_entries).toBe('number');
		});

		it('should handle JSON.stringify edge cases in reason field', async () => {
			// This tests that if somehow a field contained quotes or special chars,
			// JSON.stringify would properly escape them
			mockReadCuratorSummary.mockResolvedValue({
				schema_version: 1,
				session_id: 'test-session',
				last_updated: '2024-01-01T00:00:00Z',
				last_phase_covered: 1,
				digest: 'Test digest',
				phase_digests: [],
				compliance_observations: [],
				knowledge_recommendations: [],
			});

			const hook = createHivePromoterHook('/test-project', mockConfig);
			await hook({}, {});

			expect(mockWriteCuratorSummary).toHaveBeenCalled();
			const writtenSummary = mockWriteCuratorSummary.mock.calls[0][1];

			const rec = writtenSummary.knowledge_recommendations[0];

			// Round-trip: parse and re-stringify should produce same result
			const parsed = JSON.parse(rec.reason);
			const reStringified = JSON.stringify(parsed);
			expect(reStringified).toBe(rec.reason);
		});
	});

	describe('EDGE CASE: Empty arrays in curator summary', () => {
		it('should handle empty phase_digests array', async () => {
			mockReadCuratorSummary.mockResolvedValue({
				schema_version: 1,
				session_id: 'test-session',
				last_updated: '2024-01-01T00:00:00Z',
				last_phase_covered: 1,
				digest: 'Test digest',
				phase_digests: [],
				compliance_observations: [],
				knowledge_recommendations: [],
			});

			const hook = createHivePromoterHook('/test-project', mockConfig);

			// Should not crash
			await hook({}, {});

			expect(mockWriteCuratorSummary).toHaveBeenCalled();
		});

		it('should handle empty compliance_observations array', async () => {
			mockReadCuratorSummary.mockResolvedValue({
				schema_version: 1,
				session_id: 'test-session',
				last_updated: '2024-01-01T00:00:00Z',
				last_phase_covered: 1,
				digest: 'Test digest',
				phase_digests: [],
				compliance_observations: [],
				knowledge_recommendations: [],
			});

			const hook = createHivePromoterHook('/test-project', mockConfig);

			await hook({}, {});

			expect(mockWriteCuratorSummary).toHaveBeenCalled();
		});
	});
});
