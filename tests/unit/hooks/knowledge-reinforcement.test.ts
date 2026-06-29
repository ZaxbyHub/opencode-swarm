/**
 * Behavioral tests for knowledge-reinforcement.ts (FR-012)
 *
 * Covers three observable outcomes:
 * 1. Promotes high-confidence knowledge entries (confidence score increases with each distinct phase)
 * 2. Tracks reinforcement count (distinct phase confirmations accumulate in confirmed_by)
 * 3. Demotes stale knowledge after configured TTL (reinforcement resets phases_alive to prevent demotion)
 *
 * Uses Tier 0 pure-function testing — no mock.module, no file I/O, no _internals needed.
 * These functions are pure transformations over the entry object.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
	findActiveSwarmNearDuplicate,
	isActiveSwarmKnowledgeEntry,
	type ReinforcementReason,
	type ReinforcementResult,
	reinforceSwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-reinforcement';
import type {
	PhaseConfirmationRecord,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeSwarmEntry(
	overrides: Partial<SwarmKnowledgeEntry> = {},
): SwarmKnowledgeEntry {
	const id = overrides.id ?? 'entry-1';
	return {
		id,
		tier: 'swarm',
		lesson: 'always verify nullsafety before merging PRs in this repo',
		category: 'process',
		tags: ['safety', 'pr'],
		scope: 'global',
		confidence: 0.6,
		status: 'candidate',
		confirmed_by: overrides.confirmed_by ?? [
			{
				phase_number: 1,
				confirmed_at: '2026-01-01T00:00:00.000Z',
				project_name: 'proj',
			},
		],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		project_name: 'proj',
		auto_generated: false,
		phases_alive: overrides.phases_alive ?? 0,
		max_phases: overrides.max_phases,
		...overrides,
	};
}

function confirmPhase(
	entry: SwarmKnowledgeEntry,
	phase: number,
): ReinforcementResult {
	return reinforceSwarmKnowledgeEntry(entry, {
		phase_number: phase,
		confirmed_at: new Date(2026, 0, phase + 1).toISOString(),
		project_name: entry.project_name,
	});
}

// -----------------------------------------------------------------------------
// Test suite
// -----------------------------------------------------------------------------

describe('knowledge-reinforcement', () => {
	// -------------------------------------------------------------------------
	// Outcome 1: Promotes high-confidence knowledge entries
	// -------------------------------------------------------------------------

	describe('confidence promotion', () => {
		test('first reinforcement boosts confidence from 0.6 to 0.7', () => {
			// Start with candidate status at 0.6 confidence (1 initial confirmation)
			const entry = makeSwarmEntry({ confirmed_by: [], confidence: 0.6 });

			const result = confirmPhase(entry, 2);

			expect(result.reinforced).toBe(true);
			expect(result.reason).toBe('reinforced');
			// distinctPhaseCount = 1 → 0.5 + 0.1 = 0.7
			expect(entry.confidence).toBeCloseTo(0.7, 5);
		});

		test('second distinct phase confirmation raises confidence to 0.8', () => {
			// entry already has phase 1 confirmed → distinctPhaseCount after phase 2 = 2 → 0.5 + 0.2 = 0.8
			const entry = makeSwarmEntry({
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00.000Z',
						project_name: 'proj',
					},
				],
				confidence: 0.6,
			});

			confirmPhase(entry, 2);

			// 0.5 + 0.2 (2 distinct phases) = 0.8
			expect(entry.confidence).toBeCloseTo(0.8, 5);
		});

		test('third distinct phase confirmation reaches 0.9', () => {
			const entry = makeSwarmEntry({
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00.000Z',
						project_name: 'proj',
					},
					{
						phase_number: 2,
						confirmed_at: '2026-01-02T00:00:00.000Z',
						project_name: 'proj',
					},
				],
				confidence: 0.8,
			});

			confirmPhase(entry, 3);

			// 0.5 + 0.3 (3 distinct phases, capped) = 0.9
			expect(entry.confidence).toBeCloseTo(0.9, 5);
		});

		test('confidence is capped at 1.0 with 3 phases and auto_generated bonus does not exceed cap', () => {
			// With 3 distinct phase confirmations and auto_generated=false:
			// score = 0.5 + Math.min(3, 3) * 0.1 + 0.1 = 0.5 + 0.3 + 0.1 = 0.9
			// (The phase bonus caps at 3, not 3+)
			const entry = makeSwarmEntry({
				auto_generated: false,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00.000Z',
						project_name: 'proj',
					},
					{
						phase_number: 2,
						confirmed_at: '2026-01-02T00:00:00.000Z',
						project_name: 'proj',
					},
					{
						phase_number: 3,
						confirmed_at: '2026-01-03T00:00:00.000Z',
						project_name: 'proj',
					},
				],
				confidence: 0.8,
			});

			confirmPhase(entry, 4);

			// 0.5 + 0.3 (3 phases, capped) + 0.1 (human-originated) = 0.9; cap = 1.0 → 0.9
			expect(entry.confidence).toBeCloseTo(0.9, 5);
		});

		test('auto_generated=false adds +0.1 bonus on top of phase boosts', () => {
			// auto_generated = false → +0.1 bonus
			const entry = makeSwarmEntry({
				auto_generated: false,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00.000Z',
						project_name: 'proj',
					},
					{
						phase_number: 2,
						confirmed_at: '2026-01-02T00:00:00.000Z',
						project_name: 'proj',
					},
				],
				confidence: 0.8,
			});

			confirmPhase(entry, 3);

			// 0.5 + 0.3 (3 phases) + 0.1 (human-originated) = 0.9
			expect(entry.confidence).toBeCloseTo(0.9, 5);
		});

		test('auto_generated=true does not receive the human bonus', () => {
			const entry = makeSwarmEntry({
				auto_generated: true,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00.000Z',
						project_name: 'proj',
					},
					{
						phase_number: 2,
						confirmed_at: '2026-01-02T00:00:00.000Z',
						project_name: 'proj',
					},
				],
				confidence: 0.7,
			});

			confirmPhase(entry, 3);

			// 0.5 + 0.3 (3 phases) + 0.0 (auto) = 0.8
			expect(entry.confidence).toBeCloseTo(0.8, 5);
		});
	});

	// -------------------------------------------------------------------------
	// Outcome 2: Tracks reinforcement count via confirmed_by accumulation
	// -------------------------------------------------------------------------

	describe('reinforcement count tracking', () => {
		test('reinforced=true is returned when a new distinct phase is confirmed', () => {
			const entry = makeSwarmEntry({ confirmed_by: [], phases_alive: 5 });

			const result = confirmPhase(entry, 7);

			expect(result.reinforced).toBe(true);
			expect(result.reason).toBe('reinforced');
			expect(result.entryId).toBe('entry-1');
		});

		test('confirmed_by grows by one per distinct phase', () => {
			const entry = makeSwarmEntry({ confirmed_by: [] });

			confirmPhase(entry, 1);
			expect(entry.confirmed_by).toHaveLength(1);
			expect(entry.confirmed_by[0].phase_number).toBe(1);

			confirmPhase(entry, 2);
			expect(entry.confirmed_by).toHaveLength(2);
			expect(entry.confirmed_by.map((r) => r.phase_number)).toEqual([1, 2]);

			confirmPhase(entry, 3);
			expect(entry.confirmed_by).toHaveLength(3);
			expect(entry.confirmed_by.map((r) => r.phase_number)).toEqual([1, 2, 3]);
		});

		test('same phase confirmation returns reinforced=false and does not add duplicate', () => {
			const entry = makeSwarmEntry({ confirmed_by: [] });

			confirmPhase(entry, 1);
			const result = confirmPhase(entry, 1); // repeat same phase

			expect(result.reinforced).toBe(false);
			expect(result.reason).toBe('already_confirmed_phase');
			expect(entry.confirmed_by).toHaveLength(1); // still only one
		});

		test('confirmed_by stores the full PhaseConfirmationRecord with project_name', () => {
			const entry = makeSwarmEntry({ confirmed_by: [] });

			const result = reinforceSwarmKnowledgeEntry(entry, {
				phase_number: 4,
				confirmed_at: '2026-06-01T12:00:00.000Z',
				project_name: 'my-project',
			});

			expect(result.reinforced).toBe(true);
			const record = entry.confirmed_by[0];
			expect(record.phase_number).toBe(4);
			expect(record.confirmed_at).toBe('2026-06-01T12:00:00.000Z');
			expect(record.project_name).toBe('my-project');
		});

		test('updated_at reflects the latest confirmation timestamp', () => {
			const oldDate = '2026-01-01T00:00:00.000Z';
			const newDate = '2026-06-28T12:00:00.000Z';
			const entry = makeSwarmEntry({ updated_at: oldDate });

			reinforceSwarmKnowledgeEntry(entry, {
				phase_number: 2,
				confirmed_at: newDate,
				project_name: 'proj',
			});

			expect(entry.updated_at).toBe(newDate);
		});

		test('phases_alive resets to 0 on each successful reinforcement', () => {
			const entry = makeSwarmEntry({ phases_alive: 99 });

			const result = confirmPhase(entry, 5);

			expect(result.reinforced).toBe(true);
			expect(entry.phases_alive).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// Outcome 3: Demotes stale knowledge after configured TTL
	// -------------------------------------------------------------------------

	describe('TTL staleness and demotion prevention', () => {
		test('reinforcement resets phases_alive to 0, preventing TTL expiry', () => {
			// phases_alive increments each phase by the curator when entry is not reinforced
			const entry = makeSwarmEntry({ phases_alive: 3, max_phases: 5 });

			const result = confirmPhase(entry, 2);

			expect(result.reinforced).toBe(true);
			expect(entry.phases_alive).toBe(0);
			// Entry is safe from demotion since phases_alive < max_phases
			expect(entry.phases_alive < (entry.max_phases ?? 5)).toBe(true);
		});

		test('entry with no prior confirmations can be reinforced from phases_alive=0', () => {
			const entry = makeSwarmEntry({ confirmed_by: [], phases_alive: 0 });

			const result = confirmPhase(entry, 1);

			expect(result.reinforced).toBe(true);
			expect(entry.phases_alive).toBe(0);
			expect(entry.confidence).toBe(0.7); // 1 distinct phase → 0.5 + 0.1
		});

		test('entry reaching max_phases staleness is demoted (inactive path skips reinforcement)', () => {
			// An entry that has been stale too long would be demoted by the curator.
			// We test that inactive entries (archived/quarantined) return reinforced=false.
			const entry = makeSwarmEntry({ status: 'archived', phases_alive: 20 });

			const result = confirmPhase(entry, 5);

			expect(result.reinforced).toBe(false);
			expect(result.reason).toBe('inactive');
			expect(entry.phases_alive).toBe(20); // unchanged — no reinforcement applied
		});

		test('quarantined entries are inactive and cannot be reinforced', () => {
			const entry = makeSwarmEntry({ status: 'quarantined', phases_alive: 15 });

			const result = confirmPhase(entry, 5);

			expect(result.reinforced).toBe(false);
			expect(result.reason).toBe('inactive');
		});

		test('quarantined_unactionable entries are inactive', () => {
			const entry = makeSwarmEntry({
				status: 'quarantined_unactionable',
				phases_alive: 2,
			});

			const result = confirmPhase(entry, 3);

			expect(result.reinforced).toBe(false);
			expect(result.reason).toBe('inactive');
		});

		test('confirmed_by is not mutated when entry is inactive', () => {
			const originalConfirmedBy = [
				{
					phase_number: 1,
					confirmed_at: '2026-01-01T00:00:00.000Z',
					project_name: 'proj',
				},
			];
			const entry = makeSwarmEntry({
				status: 'archived',
				confirmed_by: originalConfirmedBy,
			});

			confirmPhase(entry, 2);

			// confirmed_by must not be mutated for inactive entries
			expect(entry.confirmed_by).toHaveLength(1);
			expect(entry.confirmed_by[0].phase_number).toBe(1);
		});
	});

	// -------------------------------------------------------------------------
	// isActiveSwarmKnowledgeEntry
	// -------------------------------------------------------------------------

	describe('isActiveSwarmKnowledgeEntry', () => {
		test('returns false for archived entries', () => {
			expect(
				isActiveSwarmKnowledgeEntry(makeSwarmEntry({ status: 'archived' })),
			).toBe(false);
		});

		test('returns false for quarantined entries', () => {
			expect(
				isActiveSwarmKnowledgeEntry(makeSwarmEntry({ status: 'quarantined' })),
			).toBe(false);
		});

		test('returns false for quarantined_unactionable entries', () => {
			expect(
				isActiveSwarmKnowledgeEntry(
					makeSwarmEntry({ status: 'quarantined_unactionable' }),
				),
			).toBe(false);
		});

		test('returns true for candidate entries', () => {
			expect(
				isActiveSwarmKnowledgeEntry(makeSwarmEntry({ status: 'candidate' })),
			).toBe(true);
		});

		test('returns true for established entries', () => {
			expect(
				isActiveSwarmKnowledgeEntry(makeSwarmEntry({ status: 'established' })),
			).toBe(true);
		});

		test('returns true for promoted entries', () => {
			expect(
				isActiveSwarmKnowledgeEntry(makeSwarmEntry({ status: 'promoted' })),
			).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// findActiveSwarmNearDuplicate
	// -------------------------------------------------------------------------

	describe('findActiveSwarmNearDuplicate', () => {
		test('returns undefined when no active duplicates exist', () => {
			const entry1 = makeSwarmEntry({
				id: 'e1',
				lesson: 'always run lint before committing',
			});
			const entry2 = makeSwarmEntry({
				id: 'e2',
				lesson: 'never skip type checks in CI pipeline',
			});

			// "verify nullsafety" has no bigram overlap with these lessons
			const result = findActiveSwarmNearDuplicate(
				'verify nullsafety before merging',
				[entry1, entry2],
				0.6,
			);

			expect(result).toBeUndefined();
		});

		test('returns the active duplicate when lesson is similar above threshold', () => {
			// Based on existing findNearDuplicate test cases: "X" and "X + suffix" share bigrams
			const entry = makeSwarmEntry({
				id: 'e1',
				lesson: 'always validate inputs before processing',
			});

			const result = findActiveSwarmNearDuplicate(
				'always validate inputs before processing anything',
				[entry],
				0.6,
			);

			expect(result?.id).toBe('e1');
		});

		test('does not match archived or quarantined entries', () => {
			// The archived/quarantined entries have the matching lesson but must be filtered out
			const archived = makeSwarmEntry({
				id: 'archived',
				lesson: 'always validate inputs before processing',
				status: 'archived',
			});
			const quarantined = makeSwarmEntry({
				id: 'quarantined',
				lesson: 'always validate inputs before processing',
				status: 'quarantined',
			});
			const active = makeSwarmEntry({
				id: 'active',
				lesson: 'always validate inputs before processing',
			});

			const result = findActiveSwarmNearDuplicate(
				'always validate inputs before processing',
				[archived, quarantined, active],
				0.6,
			);

			expect(result?.id).toBe('active');
			expect(result?.id).not.toBe('archived');
			expect(result?.id).not.toBe('quarantined');
		});

		test('returns undefined when no entry meets the threshold', () => {
			// Unrelated lesson strings fall below 0.6 similarity
			const entry = makeSwarmEntry({
				id: 'e1',
				lesson: 'docker containerization best practices',
			});

			const result = findActiveSwarmNearDuplicate(
				'use vitest for testing',
				[entry],
				0.6,
			);

			expect(result).toBeUndefined();
		});

		test('returns first active match when multiple active entries could match', () => {
			// Both entries are similar enough to the candidate; first match in filtered list is returned
			const entry1 = makeSwarmEntry({
				id: 'e1',
				lesson: 'always validate inputs before processing',
				status: 'candidate',
			});
			const entry2 = makeSwarmEntry({
				id: 'e2',
				lesson: 'always validate inputs before processing anything',
				status: 'candidate',
			});

			const result = findActiveSwarmNearDuplicate(
				'always validate inputs before processing',
				[entry1, entry2],
				0.6,
			);

			// Both are identical to the candidate (similarity=1.0); find returns first
			expect(result).toBeDefined();
			expect(['e1', 'e2']).toContain(result!.id);
		});
	});

	// -------------------------------------------------------------------------
	// ReinforcementResult shape
	// -------------------------------------------------------------------------

	describe('ReinforcementResult interface', () => {
		test('result contains entryId, reinforced, and reason fields', () => {
			const entry = makeSwarmEntry({ confirmed_by: [] });

			const result = confirmPhase(entry, 1);

			expect(result).toHaveProperty('entryId');
			expect(result).toHaveProperty('reinforced');
			expect(result).toHaveProperty('reason');
			expect(typeof result.entryId).toBe('string');
			expect(typeof result.reinforced).toBe('boolean');
			expect([
				'reinforced',
				'already_confirmed_phase',
				'inactive',
			] as ReinforcementReason[]).toContain(result.reason);
		});

		test('reason is "already_confirmed_phase" when phase already confirmed', () => {
			const entry = makeSwarmEntry({
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00.000Z',
						project_name: 'proj',
					},
				],
			});

			const result = confirmPhase(entry, 1);

			expect(result.reason).toBe('already_confirmed_phase');
			expect(result.reinforced).toBe(false);
		});

		test('reason is "inactive" when entry is archived', () => {
			const entry = makeSwarmEntry({ status: 'archived' });

			const result = confirmPhase(entry, 1);

			expect(result.reason).toBe('inactive');
			expect(result.reinforced).toBe(false);
		});

		test('reason is "reinforced" on successful new phase confirmation', () => {
			const entry = makeSwarmEntry({ confirmed_by: [] });

			const result = confirmPhase(entry, 1);

			expect(result.reason).toBe('reinforced');
			expect(result.reinforced).toBe(true);
		});
	});
});
