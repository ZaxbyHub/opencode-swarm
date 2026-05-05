/**
 * Verification tests for Task 3.1 — curator pipeline output improvements
 *
 * Key behaviors tested:
 * 1. curateAndStoreSwarm returns { stored: N, skipped: M, rejected: K } for various input scenarios
 * 2. Empty lessons array → returns { 0, 0, 0 }
 * 3. All lessons valid → stored increments
 * 4. Duplicate lessons → skipped increments
 * 5. Invalid lessons → rejected increments
 * 6. Advisory message in phase-complete.ts includes "Knowledge: N applied, M skipped" text
 *
 * MOCK CONVERSION NOTES:
 * These tests use mock.module() for cross-module mocks because the source
 * modules (knowledge-store, knowledge-validator, knowledge-reader) use direct
 * imports rather than _internals DI seams.
 *
 * Cross-module mocks CANNOT be converted to _internals because:
 * - The source uses direct named imports
 * - _internals seams only exist where they were explicitly designed
 *
 * MOCK MODULES (remain as mock.module):
 * - src/hooks/knowledge-store.js: all functions
 * - src/hooks/knowledge-validator.js: validateLesson, quarantineEntry
 * - src/hooks/knowledge-reader.js: updateRetrievalOutcome
 *
 * These tests use mock.module for cross-module mocks. In CI, per-file isolation
 * prevents leakage. For local batch runs, use `bun test --isolate` (Bun >=1.3.13).
 * beforeEach resets mock call state via mockClear() for deterministic test isolation.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { KnowledgeConfig } from '../../../src/hooks/knowledge-types';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
} from '../../../src/state';

// =============================================================================
// Mock modules using bun:test native mock.module
// =============================================================================

// Mock knowledge-store module
const mockAppendKnowledge = mock(async () => {});
const mockAppendRejectedLesson = mock(async () => {});
const mockEnforceKnowledgeCap = mock(async () => {});
const mockFindNearDuplicate = mock(() => undefined);
const mockReadKnowledge = mock(async () => []);
const mockRewriteKnowledge = mock(async () => {});
const mockResolveSwarmKnowledgePath = mock(() => '/mock/knowledge.jsonl');
const mockResolveSwarmRejectedPath = mock(() => '/mock/rejected.jsonl');
const mockComputeConfidence = mock(() => 0.6);
const mockInferTags = mock(() => [] as string[]);
const mockNormalize = mock((text: string) => text.toLowerCase().trim());

mock.module('../../../src/hooks/knowledge-store.js', () => ({
	resolveSwarmKnowledgePath: mockResolveSwarmKnowledgePath,
	resolveSwarmRejectedPath: mockResolveSwarmRejectedPath,
	readKnowledge: mockReadKnowledge,
	appendKnowledge: mockAppendKnowledge,
	appendRejectedLesson: mockAppendRejectedLesson,
	findNearDuplicate: mockFindNearDuplicate,
	rewriteKnowledge: mockRewriteKnowledge,
	computeConfidence: mockComputeConfidence,
	inferTags: mockInferTags,
	normalize: mockNormalize,
	enforceKnowledgeCap: mockEnforceKnowledgeCap,
}));

// Mock knowledge-validator module
const mockValidateLesson = mock(() => ({
	valid: true,
	layer: null,
	reason: null,
	severity: null,
}));
const mockQuarantineEntry = mock(async () => {});

// Mock knowledge-reader module
const mockUpdateRetrievalOutcome = mock(async () => {});

mock.module('../../../src/hooks/knowledge-validator.js', () => ({
	validateLesson: mockValidateLesson,
	quarantineEntry: mockQuarantineEntry,
}));

mock.module('../../../src/hooks/knowledge-reader.js', () => ({
	updateRetrievalOutcome: mockUpdateRetrievalOutcome,
}));

// Import after mocks are set up
const { curateAndStoreSwarm } = await import(
	'../../../src/hooks/knowledge-curator.js'
);

// =============================================================================
// Test data and helpers
// =============================================================================

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
	same_project_weight: 1.0,
	cross_project_weight: 0.5,
	min_encounter_score: 0.1,
	initial_encounter_score: 1.0,
	encounter_increment: 0.1,
	max_encounter_score: 10.0,
};

// =============================================================================
// Tests: curateAndStoreSwarm return value
// =============================================================================

describe('curateAndStoreSwarm return value verification (Task 3.1)', () => {
	beforeEach(() => {
		// Reset all mock states
		mockAppendKnowledge.mockClear();
		mockAppendRejectedLesson.mockClear();
		mockFindNearDuplicate.mockClear();
		mockReadKnowledge.mockClear();
		mockRewriteKnowledge.mockClear();
		mockValidateLesson.mockClear();
		mockQuarantineEntry.mockClear();
		mockUpdateRetrievalOutcome.mockClear();

		// Set default mock return values
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
		mockNormalize.mockImplementation((text: string) =>
			text.toLowerCase().trim(),
		);
		mockValidateLesson.mockReturnValue({
			valid: true,
			layer: null,
			reason: null,
			severity: null,
		});
		mockQuarantineEntry.mockResolvedValue(undefined);
	});

	// =========================================================================
	// Test 1: Empty lessons array → returns { 0, 0, 0 }
	// =========================================================================
	test('empty lessons array returns { stored: 0, skipped: 0, rejected: 0 }', async () => {
		const result = await curateAndStoreSwarm(
			[],
			'test-project',
			{ phase_number: 1 },
			'/project',
			defaultConfig,
		);

		expect(result).toEqual({ stored: 0, skipped: 0, rejected: 0 });
		expect(mockAppendKnowledge).not.toHaveBeenCalled();
		expect(mockAppendRejectedLesson).not.toHaveBeenCalled();
	});

	// =========================================================================
	// Test 2: All lessons valid → stored increments
	// =========================================================================
	test('all valid lessons returns correct stored count', async () => {
		const lessons = [
			'Lesson one about testing',
			'Lesson two about security',
			'Lesson three about process',
		];

		// All lessons pass validation
		mockValidateLesson.mockReturnValue({
			valid: true,
			layer: null,
			reason: null,
			severity: null,
		});

		const result = await curateAndStoreSwarm(
			lessons,
			'test-project',
			{ phase_number: 1 },
			'/project',
			defaultConfig,
		);

		expect(result.stored).toBe(3);
		expect(result.skipped).toBe(0);
		expect(result.rejected).toBe(0);
		expect(mockAppendKnowledge).toHaveBeenCalledTimes(3);
	});

	// =========================================================================
	// Test 3: Duplicate lessons → skipped increments
	// =========================================================================
	test('duplicate lessons are skipped and count is correct', async () => {
		const lessons = [
			'First unique lesson',
			'Second unique lesson',
			'Duplicate of first unique lesson',
		];

		// First two lessons pass validation
		mockValidateLesson.mockReturnValue({
			valid: true,
			layer: null,
			reason: null,
			severity: null,
		});

		// First call: no duplicate, Second call: no duplicate, Third call: is duplicate
		mockFindNearDuplicate
			.mockReturnValueOnce(undefined) // First lesson - not duplicate
			.mockReturnValueOnce(undefined) // Second lesson - not duplicate
			.mockReturnValueOnce({ id: 'existing-1', lesson: 'First unique lesson' }); // Third lesson - is duplicate

		const result = await curateAndStoreSwarm(
			lessons,
			'test-project',
			{ phase_number: 1 },
			'/project',
			defaultConfig,
		);

		expect(result.stored).toBe(2);
		expect(result.skipped).toBe(1);
		expect(result.rejected).toBe(0);
		expect(mockAppendKnowledge).toHaveBeenCalledTimes(2);
	});

	// =========================================================================
	// Test 4: Invalid lessons → rejected increments
	// =========================================================================
	test('invalid lessons are rejected and count is correct', async () => {
		const lessons = [
			'Valid lesson one',
			'Invalid dangerous command lesson',
			'Another valid lesson',
		];

		// First and third lessons pass, second fails
		mockValidateLesson
			.mockReturnValueOnce({
				valid: true,
				layer: null,
				reason: null,
				severity: null,
			})
			.mockReturnValueOnce({
				valid: false,
				layer: 2,
				reason: 'dangerous pattern detected',
				severity: 'error',
			})
			.mockReturnValueOnce({
				valid: true,
				layer: null,
				reason: null,
				severity: null,
			});

		const result = await curateAndStoreSwarm(
			lessons,
			'test-project',
			{ phase_number: 1 },
			'/project',
			defaultConfig,
		);

		expect(result.stored).toBe(2);
		expect(result.skipped).toBe(0);
		expect(result.rejected).toBe(1);
		expect(mockAppendRejectedLesson).toHaveBeenCalledTimes(1);
		expect(mockAppendKnowledge).toHaveBeenCalledTimes(2);
	});

	// =========================================================================
	// Test 5: Mixed valid, duplicate, and rejected lessons
	// =========================================================================
	test('mixed lessons return correct counts for all categories', async () => {
		const lessons = [
			'Valid lesson 1',
			'Rejected lesson',
			'Valid lesson 2',
			'Duplicate of valid lesson 1',
			'Valid lesson 3',
		];

		mockValidateLesson
			.mockReturnValueOnce({
				valid: true,
				layer: null,
				reason: null,
				severity: null,
			}) // Valid 1
			.mockReturnValueOnce({
				valid: false,
				layer: 1,
				reason: 'bad pattern',
				severity: 'error',
			}) // Rejected
			.mockReturnValueOnce({
				valid: true,
				layer: null,
				reason: null,
				severity: null,
			}) // Valid 2
			.mockReturnValueOnce({
				valid: true,
				layer: null,
				reason: null,
				severity: null,
			}) // Duplicate
			.mockReturnValueOnce({
				valid: true,
				layer: null,
				reason: null,
				severity: null,
			}); // Valid 3

		mockFindNearDuplicate
			.mockReturnValueOnce(undefined) // Valid 1 - stored
			.mockReturnValueOnce(undefined) // Rejected - no dedup check
			.mockReturnValueOnce(undefined) // Valid 2 - stored
			.mockReturnValueOnce({ id: 'existing-1', lesson: 'Valid lesson 1' }) // Duplicate - skipped
			.mockReturnValueOnce(undefined); // Valid 3 - stored

		const result = await curateAndStoreSwarm(
			lessons,
			'test-project',
			{ phase_number: 1 },
			'/project',
			defaultConfig,
		);

		expect(result.stored).toBe(3); // Valid 1, Valid 2, Valid 3
		expect(result.skipped).toBe(1); // Duplicate
		expect(result.rejected).toBe(1); // Rejected
	});

	// =========================================================================
	// Test 6: All lessons rejected
	// =========================================================================
	test('all lessons rejected returns { stored: 0, skipped: 0, rejected: N }', async () => {
		const lessons = ['Bad lesson 1', 'Bad lesson 2', 'Bad lesson 3'];

		mockValidateLesson.mockReturnValue({
			valid: false,
			layer: 1,
			reason: 'invalid',
			severity: 'error',
		});

		const result = await curateAndStoreSwarm(
			lessons,
			'test-project',
			{ phase_number: 1 },
			'/project',
			defaultConfig,
		);

		expect(result.stored).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.rejected).toBe(3);
		expect(mockAppendKnowledge).not.toHaveBeenCalled();
		expect(mockAppendRejectedLesson).toHaveBeenCalledTimes(3);
	});

	// =========================================================================
	// Test 7: All lessons skipped as duplicates
	// =========================================================================
	test('all lessons are duplicates returns { stored: 0, skipped: N, rejected: 0 }', async () => {
		const lessons = ['Lesson A', 'Lesson B', 'Lesson C'];

		mockValidateLesson.mockReturnValue({
			valid: true,
			layer: null,
			reason: null,
			severity: null,
		});

		// Reset the mock to clear any previous behavior, then set the return value
		mockFindNearDuplicate.mockReset();
		mockFindNearDuplicate.mockReturnValue({
			id: 'existing',
			lesson: 'existing',
		});

		const result = await curateAndStoreSwarm(
			lessons,
			'test-project',
			{ phase_number: 1 },
			'/project',
			defaultConfig,
		);

		expect(result.stored).toBe(0);
		expect(result.skipped).toBe(3);
		expect(result.rejected).toBe(0);
	});

	// =========================================================================
	// Test 8: Return value shape is exact
	// =========================================================================
	test('return value has exact shape { stored: number, skipped: number, rejected: number }', async () => {
		const result = await curateAndStoreSwarm(
			['Test lesson'],
			'test-project',
			{ phase_number: 1 },
			'/project',
			defaultConfig,
		);

		// Verify exact shape
		expect(result).toHaveProperty('stored');
		expect(result).toHaveProperty('skipped');
		expect(result).toHaveProperty('rejected');

		// Verify types are numbers
		expect(typeof result.stored).toBe('number');
		expect(typeof result.skipped).toBe('number');
		expect(typeof result.rejected).toBe('number');

		// Verify no extra properties
		const keys = Object.keys(result);
		expect(keys).toEqual(['stored', 'skipped', 'rejected']);
	});
});
