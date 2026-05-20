/**
 * Adversarial tests for system-enhancer.ts loadEvidence callers
 *
 * Focus: Attack vectors on loadEvidence discriminated union handling
 *
 * Tests attack vectors:
 * - loadEvidence throwing instead of returning a discriminated union
 * - Unexpected status values (not in the union)
 * - Malformed bundle.entries (null, non-array, undefined)
 * - bundle.created_at being null/undefined/invalid (used in Caller 3 as timestamp fallback)
 * - Phase numbers: 0, negative, very large integers
 * - Injection in task ID strings (e.g., `retro-0`, `retro-999`, `retro-../../../etc`)
 * - What happens when all loadEvidence calls return non-found across many tasks
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Create mock functions before vi.mock to ensure they're available in the mock
const mockLoadEvidence = vi.fn();
const mockListEvidenceTaskIds = vi.fn();
const mockLoadPlan = vi.fn();
const mockLoadPlanJsonOnly = vi.fn();

// Mock the evidence/manager module BEFORE importing system-enhancer
vi.mock('../../../src/evidence/manager.js', () => ({
	loadEvidence: mockLoadEvidence,
	listEvidenceTaskIds: mockListEvidenceTaskIds,
}));

// Mock the plan/manager module
vi.mock('../../../src/plan/manager.js', () => ({
	loadPlan: mockLoadPlan,
	loadPlanJsonOnly: mockLoadPlanJsonOnly,
	derivePlanMarkdown: vi.fn((plan: any) => '# Derived Plan\n'),
	savePlan: vi.fn(),
	updateTaskStatus: vi.fn(),
	migrateLegacyPlan: vi.fn(),
	regeneratePlanMarkdown: vi.fn(),
}));

// Import the function under test
import { buildRetroInjection } from '../../../src/hooks/system-enhancer.js';

describe('buildRetroInjection - Adversarial Attack Vectors', () => {
	beforeEach(() => {
		// Clear all mocks before each test
		mockLoadEvidence.mockClear();
		mockListEvidenceTaskIds.mockClear();
		mockLoadPlan.mockClear();
		mockLoadPlanJsonOnly.mockClear();

		// Set default mock implementations
		mockLoadPlan.mockResolvedValue(null);
		mockLoadPlanJsonOnly.mockResolvedValue(null);
		mockListEvidenceTaskIds.mockResolvedValue([]);
	});

	// ========== Attack Vector 1: loadEvidence throwing instead of returning union ==========

	it('handles loadEvidence throwing synchronous error on Tier 1 direct lookup', async () => {
		const testDir = '/test/directory';
		const currentPhase = 2;

		// Load evidence throws instead of returning union
		mockLoadEvidence.mockImplementation(() => {
			throw new Error('File system corrupted');
		});

		// Should return null without crashing (caught by try/catch)
		const result = await buildRetroInjection(
			testDir,
			currentPhase,
			'Test Plan',
		);
		expect(result).toBeNull();
	});

	it('handles loadEvidence throwing async error on Tier 1 fallback loop', async () => {
		const testDir = '/test/directory';
		const currentPhase = 2;

		// First call returns not_found, fallback to list task ids
		mockLoadEvidence.mockResolvedValueOnce({ status: 'not_found' });
		mockListEvidenceTaskIds.mockResolvedValueOnce(['retro-1', 'retro-0']);

		// Subsequent calls throw
		mockLoadEvidence
			.mockResolvedValueOnce({ status: 'not_found' })
			.mockImplementationOnce(() => {
				throw new Error('Disk read error');
			});

		// Should return null without crashing
		const result = await buildRetroInjection(
			testDir,
			currentPhase,
			'Test Plan',
		);
		expect(result).toBeNull();
	});

	it('handles loadEvidence throwing on Tier 2 cross-project lookup', async () => {
		const testDir = '/test/directory';
		const currentPhase = 1; // Phase 1 triggers Tier 2

		mockListEvidenceTaskIds.mockResolvedValueOnce(['retro-1', 'retro-2']);
		mockLoadEvidence.mockImplementation(() => {
			throw new Error('Permission denied');
		});

		// Should return null without crashing
		const result = await buildRetroInjection(
			testDir,
			currentPhase,
			'Different Plan',
		);
		expect(result).toBeNull();
	});

	// ========== Attack Vector 2: Unexpected status values ==========

	it('handles unexpected status: "unknown" status in union', async () => {
		const testDir = '/test/directory';
		const currentPhase = 2;

		// @ts-expect-error - Testing invalid status
		mockLoadEvidence.mockResolvedValue({ status: 'unknown', bundle: {} });

		const result = await buildRetroInjection(testDir, currentPhase);
		expect(result).toBeNull();
	});

	it('handles unexpected status: "partial" status in union', async () => {
		const testDir = '/test/directory';
		const currentPhase = 2;

		// @ts-expect-error - Testing invalid status
		mockLoadEvidence.mockResolvedValue({
			status: 'partial',
			bundle: { entries: [] },
		});

		const result = await buildRetroInjection(testDir, currentPhase);
		expect(result).toBeNull();
	});

	it('handles missing status property entirely', async () => {
		const testDir = '/test/directory';
		const currentPhase = 2;

		// @ts-expect-error - Testing missing status
		mockLoadEvidence.mockResolvedValue({ bundle: { entries: [] } });

		const result = await buildRetroInjection(testDir, currentPhase);
		expect(result).toBeNull();
	});

	it('handles status: "found" without required bundle property', async () => {
		const testDir = '/test/directory';
		const currentPhase = 2;

		// @ts-expect-error - Testing missing bundle
		mockLoadEvidence.mockResolvedValue({ status: 'found' });

		// Should return null or handle gracefully (caught by try/catch in buildRetroInjection)
		const result = await buildRetroInjection(testDir, currentPhase);
		expect(result === null || result === undefined).toBe(true);
	});

	// ========== Attack Vector 3: Malformed bundle.entries ==========

	it('handles bundle.entries = null', async () => {
		const testDir = '/test/directory';
		const currentPhase = 2;

		mockLoadEvidence.mockResolvedValue({
			status: 'found',
			bundle: {
				schema_version: '1.0.0',
				task_id: 'retro-1',
				entries: null,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			},
		});

		const result = await buildRetroInjection(testDir, currentPhase);
		expect(result).toBeNull();
	});

	it('handles bundle.entries = undefined', async () => {
		const testDir = '/test/directory';
		const currentPhase = 2;

		mockLoadEvidence.mockResolvedValue({
			status: 'found',
			bundle: {
				schema_version: '1.0.0',
				task_id: 'retro-1',
				// entries: undefined - missing property
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			},
		});

		const result = await buildRetroInjection(testDir, currentPhase);
		expect(result).toBeNull();
	});

	it('handles bundle.entries = non-array (string)', async () => {
		const testDir = '/test/directory';
		const currentPhase = 2;

		// @ts-expect-error - Testing invalid entries type
		mockLoadEvidence.mockResolvedValue({
			status: 'found',
			bundle: {
				schema_version: '1.0.0',
				task_id: 'retro-1',
				entries: 'not an array',
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			},
		});

		// Should return null or handle gracefully (caught by try/catch)
		const result = await buildRetroInjection(testDir, currentPhase);
		expect(result === null || result === undefined).toBe(true);
	});

	it('handles bundle.entries = non-array (object)', async () => {
		const testDir = '/test/directory';
		const currentPhase = 2;

		// @ts-expect-error - Testing invalid entries type
		mockLoadEvidence.mockResolvedValue({
			status: 'found',
			bundle: {
				schema_version: '1.0.0',
				task_id: 'retro-1',
				entries: { foo: 'bar' },
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			},
		});

		// Should return null or handle gracefully (caught by try/catch)
		const result = await buildRetroInjection(testDir, currentPhase);
		expect(result === null || result === undefined).toBe(true);
	});

	it('handles bundle.entries = number', async () => {
		const testDir = '/test/directory';
		const currentPhase = 2;

		// @ts-expect-error - Testing invalid entries type
		mockLoadEvidence.mockResolvedValue({
			status: 'found',
			bundle: {
				schema_version: '1.0.0',
				task_id: 'retro-1',
				entries: 42,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			},
		});

		// Should return null or handle gracefully (caught by try/catch)
		const result = await buildRetroInjection(testDir, currentPhase);
		expect(result === null || result === undefined).toBe(true);
	});

	it('handles bundle.entries = empty array', async () => {
		const testDir = '/test/directory';
		const currentPhase = 2;

		mockLoadEvidence.mockResolvedValue({
			status: 'found',
			bundle: {
				schema_version: '1.0.0',
				task_id: 'retro-1',
				entries: [],
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			},
		});

		const result = await buildRetroInjection(testDir, currentPhase);
		// Empty entries array should result in null or empty string
		expect(result === null || result === '').toBe(true);
	});

	// ========== Attack Vector 4: bundle.created_at being null/undefined/invalid ==========

	it('handles bundle.created_at = null (used as timestamp fallback in Tier 2)', async () => {
		const testDir = '/test/directory';
		const currentPhase = 1; // Phase 1 triggers Tier 2

		const retroEntry = {
			type: 'retrospective',
			task_id: 'retro-1',
			timestamp: '2024-01-01T00:00:00.000Z',
			agent: 'architect',
			verdict: 'pass' as const,
			summary: 'Phase 1 completed',
			metadata: {},
			phase_number: 1,
			total_tool_calls: 100,
			coder_revisions: 0,
			reviewer_rejections: 0,
			test_failures: 0,
			security_findings: 0,
			integration_issues: 0,
			task_count: 5,
			task_complexity: 'moderate' as const,
			top_rejection_reasons: [],
			lessons_learned: ['Test lesson'],
		};

		mockListEvidenceTaskIds.mockResolvedValueOnce(['retro-1']);
		// @ts-expect-error - Testing null created_at
		mockLoadEvidence.mockResolvedValueOnce({
			status: 'found',
			bundle: {
				schema_version: '1.0.0',
				task_id: 'retro-1',
				entries: [retroEntry],
				created_at: null,
				updated_at: new Date().toISOString(),
			},
		});

		// Should handle gracefully - falls back to retro.timestamp but it's too old (exceeds 30-day cutoff in Tier 2)
		const result = await buildRetroInjection(
			testDir,
			currentPhase,
			'Different Plan',
		);
		// The timestamp is from 2024, which is more than 30 days ago, so it gets filtered out
		expect(result).toBeNull();
	});

	it('handles bundle.created_at = undefined (used as timestamp fallback in Tier 2)', async () => {
		const testDir = '/test/directory';
		const currentPhase = 1; // Phase 1 triggers Tier 2

		const now = new Date();
		const retroEntry = {
			type: 'retrospective',
			task_id: 'retro-1',
			timestamp: now.toISOString(),
			agent: 'architect',
			verdict: 'pass' as const,
			summary: 'Phase 1 completed',
			metadata: {},
			phase_number: 1,
			total_tool_calls: 100,
			coder_revisions: 0,
			reviewer_rejections: 0,
			test_failures: 0,
			security_findings: 0,
			integration_issues: 0,
			task_count: 5,
			task_complexity: 'moderate' as const,
			top_rejection_reasons: [],
			lessons_learned: ['Test lesson'],
		};

		mockListEvidenceTaskIds.mockResolvedValueOnce(['retro-1']);
		// @ts-expect-error - Testing undefined created_at
		mockLoadEvidence.mockResolvedValueOnce({
			status: 'found',
			bundle: {
				schema_version: '1.0.0',
				task_id: 'retro-1',
				entries: [retroEntry],
				// created_at: undefined - missing
				updated_at: now.toISOString(),
			},
		});

		// Should handle gracefully - falls back to retro.timestamp which is recent
		const result = await buildRetroInjection(
			testDir,
			currentPhase,
			'Different Plan',
		);
		// Recent timestamp should be included
		expect(result).not.toBeNull();
	});

	it('handles bundle.created_at = invalid ISO string', async () => {
		const testDir = '/test/directory';
		const currentPhase = 1; // Phase 1 triggers Tier 2

		const retroEntry = {
			type: 'retrospective',
			task_id: 'retro-1',
			timestamp: '2024-01-01T00:00:00.000Z',
			agent: 'architect',
			verdict: 'pass' as const,
			summary: 'Phase 1 completed',
			metadata: {},
			phase_number: 1,
			total_tool_calls: 100,
			coder_revisions: 0,
			reviewer_rejections: 0,
			test_failures: 0,
			security_findings: 0,
			integration_issues: 0,
			task_count: 5,
			task_complexity: 'moderate' as const,
			top_rejection_reasons: [],
			lessons_learned: ['Test lesson'],
		};

		mockListEvidenceTaskIds.mockResolvedValueOnce(['retro-1']);
		// @ts-expect-error - Testing invalid created_at
		mockLoadEvidence.mockResolvedValueOnce({
			status: 'found',
			bundle: {
				schema_version: '1.0.0',
				task_id: 'retro-1',
				entries: [retroEntry],
				created_at: 'not-a-valid-date',
				updated_at: new Date().toISOString(),
			},
		});

		// Should handle gracefully - falls back to retro.timestamp but it's too old (exceeds 30-day cutoff in Tier 2)
		const result = await buildRetroInjection(
			testDir,
			currentPhase,
			'Different Plan',
		);
		// The timestamp is from 2024, which is more than 30 days ago, so it gets filtered out
		expect(result).toBeNull();
	});

	it('handles bundle.created_at = very old date (before 1970)', async () => {
		const testDir = '/test/directory';
		const currentPhase = 1; // Phase 1 triggers Tier 2

		const retroEntry = {
			type: 'retrospective',
			task_id: 'retro-1',
			timestamp: '2024-01-01T00:00:00.000Z',
			agent: 'architect',
			verdict: 'pass' as const,
			summary: 'Phase 1 completed',
			metadata: {},
			phase_number: 1,
			total_tool_calls: 100,
			coder_revisions: 0,
			reviewer_rejections: 0,
			test_failures: 0,
			security_findings: 0,
			integration_issues: 0,
			task_count: 5,
			task_complexity: 'moderate' as const,
			top_rejection_reasons: [],
			lessons_learned: ['Test lesson'],
		};

		mockListEvidenceTaskIds.mockResolvedValueOnce(['retro-1']);
		mockLoadEvidence.mockResolvedValueOnce({
			status: 'found',
			bundle: {
				schema_version: '1.0.0',
				task_id: 'retro-1',
				entries: [retroEntry],
				created_at: '1900-01-01T00:00:00.000Z',
				updated_at: new Date().toISOString(),
			},
		});

		// Should handle gracefully (filter out due to age cutoff)
		const result = await buildRetroInjection(
			testDir,
			currentPhase,
			'Different Plan',
		);
		expect(result).toBeNull();
	});

	// ========== Attack Vector 5: Phase number edge cases ==========

	it('handles phase number = 0', async () => {
		const testDir = '/test/directory';
		const currentPhase = 0;

		// Phase 0 should skip Tier 1 (prevPhase = -1 < 1) and go to Tier 2
		mockListEvidenceTaskIds.mockResolvedValueOnce([]);

		const result = await buildRetroInjection(testDir, currentPhase);
		expect(result).toBeNull();
	});

	it('handles phase number = negative', async () => {
		const testDir = '/test/directory';
		const currentPhase = -5;

		// Negative phase should skip Tier 1 and go to Tier 2
		mockListEvidenceTaskIds.mockResolvedValueOnce([]);

		const result = await buildRetroInjection(testDir, currentPhase);
		expect(result).toBeNull();
	});

	it('handles phase number = very large integer (999999)', async () => {
		const testDir = '/test/directory';
		const currentPhase = 999999;

		const retroEntry = {
			type: 'retrospective',
			task_id: 'retro-999998',
			timestamp: new Date().toISOString(),
			agent: 'architect',
			verdict: 'pass' as const,
			summary: `Phase 999998 completed`,
			metadata: {},
			phase_number: 999998,
			total_tool_calls: 100,
			coder_revisions: 0,
			reviewer_rejections: 0,
			test_failures: 0,
			security_findings: 0,
			integration_issues: 0,
			task_count: 5,
			task_complexity: 'moderate' as const,
			top_rejection_reasons: [],
			lessons_learned: [`Lesson for phase 999998`],
		};

		mockLoadEvidence.mockResolvedValue({
			status: 'found',
			bundle: {
				schema_version: '1.0.0',
				task_id: 'retro-999998',
				entries: [retroEntry],
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			},
		});

		const result = await buildRetroInjection(testDir, currentPhase);
		// Should handle large phase numbers without crashing
		expect(result).not.toBeNull();
		expect(result).toContain('999998');
	});

	it('handles phase number = MAX_SAFE_INTEGER', async () => {
		const testDir = '/test/directory';
		const currentPhase = Number.MAX_SAFE_INTEGER;

		// Clear the persistent mock from previous test
		mockLoadEvidence.mockReset();
		mockLoadEvidence.mockResolvedValue({ status: 'not_found' });
		mockListEvidenceTaskIds.mockResolvedValueOnce([]);

		const result = await buildRetroInjection(testDir, currentPhase);
		// For very large phase numbers without matching retros, returns null
		expect(result).toBeNull();
	});

	// ========== Attack Vector 6: Injection in task ID strings ==========

	it('handles task ID with path traversal: retro-../../../etc', async () => {
		const testDir = '/test/directory';
		const currentPhase = 2;

		// First call is for retro-1, should succeed
		mockLoadEvidence.mockResolvedValueOnce({ status: 'not_found' });

		// Fallback loop encounters path-traversal task ID
		mockListEvidenceTaskIds.mockResolvedValueOnce(['retro-../../../etc']);

		// Load evidence should throw on invalid task ID
		mockLoadEvidence.mockImplementationOnce(() => {
			throw new Error('Invalid task ID: path traversal detected');
		});

		const result = await buildRetroInjection(testDir, currentPhase);
		expect(result).toBeNull();
	});

	it('handles task ID with Windows-style traversal: retro-..\\..\\windows', async () => {
		const testDir = '/test/directory';
		const currentPhase = 2;

		mockLoadEvidence.mockResolvedValueOnce({ status: 'not_found' });
		mockListEvidenceTaskIds.mockResolvedValueOnce(['retro-..\\..\\windows']);

		mockLoadEvidence.mockImplementationOnce(() => {
			throw new Error('Invalid task ID: path traversal detected');
		});

		const result = await buildRetroInjection(testDir, currentPhase);
		expect(result).toBeNull();
	});

	it('handles task ID with null byte injection', async () => {
		const testDir = '/test/directory';
		const currentPhase = 2;

		mockLoadEvidence.mockResolvedValueOnce({ status: 'not_found' });
		mockListEvidenceTaskIds.mockResolvedValueOnce(['retro-\x00evil']);

		mockLoadEvidence.mockImplementationOnce(() => {
			throw new Error('Invalid task ID: contains null bytes');
		});

		const result = await buildRetroInjection(testDir, currentPhase);
		expect(result).toBeNull();
	});

	it('handles task ID with control characters', async () => {
		const testDir = '/test/directory';
		const currentPhase = 2;

		mockLoadEvidence.mockResolvedValueOnce({ status: 'not_found' });
		// \x1B is escape character
		mockListEvidenceTaskIds.mockResolvedValueOnce(['retro-\x1B[31mevil']);

		mockLoadEvidence.mockImplementationOnce(() => {
			throw new Error('Invalid task ID: contains control characters');
		});

		const result = await buildRetroInjection(testDir, currentPhase);
		expect(result).toBeNull();
	});

	it('handles task ID with SQL injection pattern', async () => {
		const testDir = '/test/directory';
		const currentPhase = 2;

		mockLoadEvidence.mockResolvedValueOnce({ status: 'not_found' });
		mockListEvidenceTaskIds.mockResolvedValueOnce([
			"retro-1'; DROP TABLE users; --",
		]);

		mockLoadEvidence.mockImplementationOnce(() => {
			throw new Error('Invalid task ID: must match pattern');
		});

		const result = await buildRetroInjection(testDir, currentPhase);
		expect(result).toBeNull();
	});

	// ========== Attack Vector 7: All loadEvidence calls return non-found ==========

	it('handles all Tier 1 calls returning not_found across multiple tasks', async () => {
		const testDir = '/test/directory';
		const currentPhase = 5;

		// Direct lookup for retro-4
		mockLoadEvidence.mockResolvedValue({ status: 'not_found' });

		// Fallback: scan all evidence for any retro
		mockListEvidenceTaskIds.mockResolvedValue([
			'retro-1',
			'retro-2',
			'retro-3',
			'retro-4',
			'retro-5',
		]);

		// All retro loads return not_found
		mockLoadEvidence.mockResolvedValue({ status: 'not_found' });

		const result = await buildRetroInjection(testDir, currentPhase);
		expect(result).toBeNull();
	});

	it('handles all Tier 2 calls returning not_found for cross-project lookup', async () => {
		const testDir = '/test/directory';
		const currentPhase = 1; // Phase 1 triggers Tier 2

		mockListEvidenceTaskIds.mockResolvedValue([
			'retro-1',
			'retro-2',
			'retro-3',
		]);
		mockLoadEvidence.mockResolvedValue({ status: 'not_found' });

		const result = await buildRetroInjection(
			testDir,
			currentPhase,
			'Test Plan',
		);
		expect(result).toBeNull();
	});

	it('handles all calls returning invalid_schema', async () => {
		const testDir = '/test/directory';
		const currentPhase = 2;

		mockLoadEvidence.mockResolvedValue({
			status: 'invalid_schema',
			errors: ['schema.version mismatch', 'missing required field'],
		});

		mockListEvidenceTaskIds.mockResolvedValue(['retro-1']);

		const result = await buildRetroInjection(testDir, currentPhase);
		expect(result).toBeNull();
	});

	it('handles mixed not_found and invalid_schema responses', async () => {
		const testDir = '/test/directory';
		const currentPhase = 2;

		// First call is not_found
		mockLoadEvidence.mockResolvedValueOnce({ status: 'not_found' });

		mockListEvidenceTaskIds.mockResolvedValue(['retro-1', 'retro-2']);

		// Subsequent calls are a mix
		mockLoadEvidence
			.mockResolvedValueOnce({ status: 'invalid_schema', errors: ['corrupt'] })
			.mockResolvedValueOnce({ status: 'not_found' });

		const result = await buildRetroInjection(testDir, currentPhase);
		expect(result).toBeNull();
	});
});

describe('Combined Attack Vectors - Multiple Failures', () => {
	beforeEach(() => {
		mockLoadEvidence.mockClear();
		mockListEvidenceTaskIds.mockClear();
		mockLoadPlan.mockClear();
		mockLoadPlanJsonOnly.mockClear();

		mockLoadPlan.mockResolvedValue(null);
		mockLoadPlanJsonOnly.mockResolvedValue(null);
		mockListEvidenceTaskIds.mockResolvedValue([]);
	});

	it('handles phase 0 with malformed data in fallback loop', async () => {
		const testDir = '/test/directory';
		const currentPhase = 0;

		mockListEvidenceTaskIds.mockResolvedValue(['retro-1', 'retro-2']);

		// First call throws
		mockLoadEvidence.mockImplementationOnce(() => {
			throw new Error('Disk error');
		});

		// Second call has malformed data
		mockLoadEvidence.mockResolvedValueOnce({
			status: 'found',
			bundle: {
				schema_version: '1.0.0',
				task_id: 'retro-2',
				entries: null,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			},
		});

		const result = await buildRetroInjection(testDir, currentPhase);
		expect(result).toBeNull();
	});

	it('handles very large phase with all not_found responses', async () => {
		const testDir = '/test/directory';
		const currentPhase = 10000;

		mockLoadEvidence.mockResolvedValue({ status: 'not_found' });
		mockListEvidenceTaskIds.mockResolvedValue(
			Array.from({ length: 100 }, (_, i) => `retro-${i + 1}`),
		);
		mockLoadEvidence.mockResolvedValue({ status: 'not_found' });

		const result = await buildRetroInjection(testDir, currentPhase);
		expect(result).toBeNull();
	});

	it('handles path traversal task ID with invalid status in Tier 2', async () => {
		const testDir = '/test/directory';
		const currentPhase = 1;

		mockListEvidenceTaskIds.mockResolvedValue([
			'retro-../../../etc',
			'retro-1',
		]);

		// First call (path traversal) throws
		mockLoadEvidence.mockImplementationOnce(() => {
			throw new Error('Invalid task ID: path traversal detected');
		});

		// Second call returns unexpected status
		// @ts-expect-error - Testing invalid status
		mockLoadEvidence.mockResolvedValueOnce({ status: 'corrupted', bundle: {} });

		const result = await buildRetroInjection(
			testDir,
			currentPhase,
			'Test Plan',
		);
		expect(result).toBeNull();
	});
});
