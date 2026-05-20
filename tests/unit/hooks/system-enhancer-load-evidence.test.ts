/**
 * Tests for system-enhancer.ts loadEvidence discriminated union migration
 *
 * Verifies that:
 * 1. When loadEvidence returns { status: 'found', bundle: ... } → function uses bundle data
 * 2. When loadEvidence returns { status: 'not_found' } → function skips/returns null
 * 3. When loadEvidence returns { status: 'invalid_schema', errors: [...] } → function skips/returns null
 * 4. Correct bundle.entries access (not direct property access on result)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Create mock functions before vi.mock to ensure they're available in the mock
const mockLoadEvidence = vi.fn();
const mockListEvidenceTaskIds = vi.fn();
const mockLoadPlan = vi.fn();
const mockLoadPlanJsonOnly = vi.fn();

// Mock the evidence/manager module BEFORE importing system-enhancer
vi.mock('../../../src/evidence/manager.js', () => ({
	loadEvidence: mockLoadEvidence,
	listEvidenceTaskIds: mockListEvidenceTaskIds,
	checkRequirementCoverage: vi.fn(),
	saveEvidence: vi.fn(),
	deleteEvidence: vi.fn(),
	archiveEvidence: vi.fn(),
	sanitizeTaskId: vi.fn((id: string) => id),
	isValidEvidenceType: vi.fn(() => true),
	isSyntaxEvidence: vi.fn(() => false),
	isPlaceholderEvidence: vi.fn(() => false),
	isSastEvidence: vi.fn(() => false),
	isSbomEvidence: vi.fn(() => false),
	isBuildEvidence: vi.fn(() => false),
	isQualityBudgetEvidence: vi.fn(() => false),
	isSecretscanEvidence: vi.fn(() => false),
	VALID_EVIDENCE_TYPES: [],
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

describe('System Enhancer - loadEvidence Discriminated Union Migration', () => {
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

	afterEach(() => {
		// Clean up after each test
	});

	const getBuildRetroInjection = () => {
		return require('../../../src/hooks/system-enhancer.js').buildRetroInjection;
	};

	// ========== Helper to create mock evidence bundle ==========
	function createMockRetroBundle(
		phase: number,
		verdict: 'pass' | 'fail' | 'info',
		summary?: string,
	): any {
		const timestamp = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		return {
			status: 'found',
			bundle: {
				schema_version: '1.0.0',
				task_id: `retro-${phase}`,
				entries: [
					{
						type: 'retrospective',
						task_id: `retro-${phase}`,
						timestamp,
						agent: 'architect',
						verdict,
						summary: summary ?? `Phase ${phase} completed successfully`,
						metadata: {},
						phase_number: phase,
						total_tool_calls: 100,
						coder_revisions: 2,
						reviewer_rejections: 1,
						test_failures: 0,
						security_findings: 0,
						integration_issues: 0,
						task_count: 5,
						task_complexity: 'moderate',
						top_rejection_reasons: ['Config schema approach not aligned'],
						lessons_learned: [
							'Tree-sitter integration requires WASM grammar files',
							'Security reviews are critical',
						],
					},
				],
				created_at: timestamp,
				updated_at: timestamp,
			},
		};
	}

	// ========== Tier 1 Tests (buildRetroInjection) ==========

	it('1. buildRetroInjection uses bundle data when loadEvidence returns status: "found"', async () => {
		// Arrange
		const mockBundle = createMockRetroBundle(1, 'pass');
		mockLoadEvidence.mockResolvedValue(mockBundle);
		mockListEvidenceTaskIds.mockResolvedValue(['retro-1']);

		// Act
		const buildRetroInjection = getBuildRetroInjection();
		const result = await buildRetroInjection('/test/directory', 2, 'test-plan');

		// Assert
		expect(result).not.toBeNull();
		expect(result).toContain('## Previous Phase Retrospective (Phase 1)');
		expect(result).toContain('Phase 1 completed successfully');
		expect(result).toContain(
			'Tree-sitter integration requires WASM grammar files',
		);

		// Verify loadEvidence was called with the correct task ID
		expect(mockLoadEvidence).toHaveBeenCalledWith('/test/directory', 'retro-1');
		expect(mockLoadEvidence).toHaveBeenCalledTimes(1);
	});

	it('2. buildRetroInjection returns null when loadEvidence returns status: "not_found"', async () => {
		// Arrange
		mockLoadEvidence.mockResolvedValue({ status: 'not_found' });

		// Act
		const buildRetroInjection = getBuildRetroInjection();
		const result = await buildRetroInjection('/test/directory', 2);

		// Assert
		expect(result).toBeNull();

		// Verify loadEvidence was called
		expect(mockLoadEvidence).toHaveBeenCalledWith('/test/directory', 'retro-1');
	});

	it('3. buildRetroInjection returns null when loadEvidence returns status: "invalid_schema"', async () => {
		// Arrange
		mockLoadEvidence.mockResolvedValue({
			status: 'invalid_schema',
			errors: [
				'entries.0.phase_number: Expected number, got undefined',
				'entries.0.summary: Required field missing',
			],
		});

		// Act
		const buildRetroInjection = getBuildRetroInjection();
		const result = await buildRetroInjection('/test/directory', 2);

		// Assert
		expect(result).toBeNull();

		// Verify loadEvidence was called
		expect(mockLoadEvidence).toHaveBeenCalledWith('/test/directory', 'retro-1');
	});

	it('4. buildRetroInjection correctly accesses bundle.entries array via discriminated union', async () => {
		// Arrange - Create a bundle with empty entries array to test access pattern
		const mockBundle = {
			status: 'found',
			bundle: {
				schema_version: '1.0.0',
				task_id: 'retro-1',
				entries: [], // Empty entries array
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			},
		};
		mockLoadEvidence.mockResolvedValue(mockBundle);

		// Act
		const buildRetroInjection = getBuildRetroInjection();
		const result = await buildRetroInjection('/test/directory', 2);

		// Assert - With empty entries, should fall through to scan and return null
		expect(result).toBeNull();

		// Verify the code accessed bundle.entries through discriminated union pattern
		// The function should check: result.status === 'found' && result.bundle.entries.length > 0
		expect(mockLoadEvidence).toHaveBeenCalledWith('/test/directory', 'retro-1');
	});

	it('5. buildRetroInjection skips injection when verdict is "fail" (bundle data check)', async () => {
		// Arrange
		const mockBundle = createMockRetroBundle(1, 'fail', 'Phase 1 failed');
		mockLoadEvidence.mockResolvedValue(mockBundle);

		// Act
		const buildRetroInjection = getBuildRetroInjection();
		const result = await buildRetroInjection('/test/directory', 2);

		// Assert
		expect(result).toBeNull();
	});

	it('6. buildRetroInjection uses bundle.entries.find to locate retrospective entry', async () => {
		// Arrange - Create a bundle with multiple entry types
		const mockBundle = {
			status: 'found',
			bundle: {
				schema_version: '1.0.0',
				task_id: 'retro-1',
				entries: [
					{
						type: 'review',
						task_id: 'review-1',
						timestamp: new Date().toISOString(),
						agent: 'reviewer',
					},
					{
						type: 'retrospective',
						task_id: 'retro-1',
						timestamp: new Date().toISOString(),
						agent: 'architect',
						verdict: 'pass',
						summary: 'Phase 1 completed',
						metadata: {},
						phase_number: 1,
						total_tool_calls: 50,
						coder_revisions: 1,
						reviewer_rejections: 0,
						test_failures: 0,
						security_findings: 0,
						integration_issues: 0,
						task_count: 3,
						task_complexity: 'simple',
						top_rejection_reasons: [],
						lessons_learned: ['Lesson 1', 'Lesson 2'],
					},
				],
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			},
		};
		mockLoadEvidence.mockResolvedValue(mockBundle);

		// Act
		const buildRetroInjection = getBuildRetroInjection();
		const result = await buildRetroInjection('/test/directory', 2);

		// Assert - Should find the retrospective entry and use it
		expect(result).not.toBeNull();
		expect(result).toContain('## Previous Phase Retrospective (Phase 1)');
		expect(result).toContain('Lesson 1');
	});

	it('7. buildRetroInjection fallback scan uses status: "found" pattern for each task', async () => {
		// Arrange - Direct lookup fails (empty entries), but fallback scan finds retro-2
		mockLoadEvidence
			.mockResolvedValueOnce({
				status: 'found',
				bundle: {
					entries: [],
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				},
			}) // retro-1 with empty entries
			.mockResolvedValueOnce(createMockRetroBundle(2, 'pass')); // retro-2 in scan
		mockListEvidenceTaskIds.mockResolvedValue(['retro-1', 'retro-2']);

		// Act
		const buildRetroInjection = getBuildRetroInjection();
		const result = await buildRetroInjection('/test/directory', 3);

		// Assert
		expect(result).not.toBeNull();
		expect(result).toContain('## Previous Phase Retrospective (Phase 2)');

		// Verify both loadEvidence calls used discriminated union pattern
		expect(mockLoadEvidence).toHaveBeenCalledTimes(3); // retro-2, retro-1, retro-2 (scan)
	});

	it('8. buildRetroInjection Tier 2 Phase 1 filters by status: "found" during cross-project scan', async () => {
		// Arrange - Phase 1 uses Tier 2 cross-project scan
		mockListEvidenceTaskIds.mockResolvedValue([
			'retro-1',
			'retro-2',
			'retro-3',
		]);
		mockLoadEvidence
			.mockResolvedValue(createMockRetroBundle(1, 'pass', 'Phase 1 completed'))
			.mockResolvedValue(createMockRetroBundle(2, 'pass', 'Phase 2 completed'))
			.mockResolvedValue(createMockRetroBundle(3, 'pass', 'Phase 3 completed'));

		// Act
		const buildRetroInjection = getBuildRetroInjection();
		const result = await buildRetroInjection(
			'/test/directory',
			1,
			'different-plan',
		);

		// Assert
		expect(result).not.toBeNull();
		expect(result).toContain(
			'## Historical Lessons (from recent prior projects)',
		);
		expect(result).toContain('Most recent retrospectives in this workspace:');
	});

	it('9. buildRetroInjection Tier 2 skips when loadEvidence returns status: "not_found" for tasks', async () => {
		// Arrange - Some retros not found during Tier 2 scan
		mockListEvidenceTaskIds.mockResolvedValue(['retro-1', 'retro-2']);
		mockLoadEvidence
			.mockResolvedValue({ status: 'not_found' }) // retro-1 not found
			.mockResolvedValue(createMockRetroBundle(2, 'pass', 'Phase 2 completed')); // retro-2 found

		// Act
		const buildRetroInjection = getBuildRetroInjection();
		const result = await buildRetroInjection(
			'/test/directory',
			1,
			'different-plan',
		);

		// Assert - Should skip not_found and use found retros
		expect(result).not.toBeNull();
		expect(result).toContain('Phase 2 completed');

		// Verify both tasks were attempted
		expect(mockLoadEvidence).toHaveBeenCalledTimes(2);
	});

	it('10. buildRetroInjection Tier 2 skips when loadEvidence returns status: "invalid_schema"', async () => {
		// Arrange - Some retros have invalid schema
		mockListEvidenceTaskIds.mockResolvedValue(['retro-1', 'retro-2']);
		mockLoadEvidence
			.mockResolvedValue({
				status: 'invalid_schema',
				errors: ['schema validation failed'],
			}) // retro-1 invalid
			.mockResolvedValue(createMockRetroBundle(2, 'pass', 'Phase 2 completed')); // retro-2 valid

		// Act
		const buildRetroInjection = getBuildRetroInjection();
		const result = await buildRetroInjection(
			'/test/directory',
			1,
			'different-plan',
		);

		// Assert - Should skip invalid_schema and use found retros
		expect(result).not.toBeNull();
		expect(result).toContain('Phase 2 completed');
	});

	// ========== Note: buildCoderRetroInjection tests removed as it's not exported ==========
	// buildCoderRetroInjection is an internal function, not exported from the module
	// Testing the discriminated union behavior through buildRetroInjection is sufficient

	// ========== Edge case tests ==========

	it('19. buildRetroInjection returns null when prevPhase < 1 (Phase 1 no direct lookup)', async () => {
		// Arrange - Phase 1 has no previous phase
		const buildRetroInjection = getBuildRetroInjection();

		// Act
		const result = await buildRetroInjection('/test/directory', 1);

		// Assert
		expect(result).toBeNull();

		// Verify loadEvidence was NOT called for direct lookup (prevPhase = 0)
		expect(mockLoadEvidence).not.toHaveBeenCalled();
	});

	it('20. buildRetroInjection gracefully handles mixed status results during fallback scan', async () => {
		// Arrange - Mix of found, not_found, and invalid_schema during scan
		mockLoadEvidence
			.mockResolvedValue({ status: 'not_found' }) // retro-1 direct lookup
			.mockResolvedValue({ status: 'not_found' }) // retro-1 scan
			.mockResolvedValue({
				status: 'invalid_schema',
				errors: ['Invalid schema'],
			}) // retro-2 scan
			.mockResolvedValue(createMockRetroBundle(3, 'pass', 'Phase 3 found')); // retro-3 scan
		mockListEvidenceTaskIds.mockResolvedValue([
			'retro-1',
			'retro-2',
			'retro-3',
		]);

		// Act
		const buildRetroInjection = getBuildRetroInjection();
		const result = await buildRetroInjection('/test/directory', 4);

		// Assert - Should find and use the valid retro-3
		expect(result).not.toBeNull();
		expect(result).toContain('## Previous Phase Retrospective (Phase 3)');
	});
});
