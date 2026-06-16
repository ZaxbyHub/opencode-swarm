/**
 * Snapshot/contract test for buildDelegateDirectiveBlock
 * (Swarm Learning System, Change 1 / Task 1.3).
 *
 * The block must be deterministic (sorted by priority then ID), render the
 * actionable fields (forbidden/required/verification) only where present, carry
 * the explicit ack contract, and emit nothing when there are no directives.
 */

import { describe, expect, it } from 'bun:test';
import { buildDelegateDirectiveBlock } from '../../../src/hooks/knowledge-injector.js';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader.js';
import type { KnowledgeConfig } from '../../../src/hooks/knowledge-types.js';

function makeConfig(): KnowledgeConfig {
	return {
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
		same_project_weight: 1,
		cross_project_weight: 0.5,
		min_encounter_score: 0.1,
		initial_encounter_score: 1,
		encounter_increment: 0.1,
		max_encounter_score: 10,
		default_max_phases: 10,
		todo_max_phases: 3,
		sweep_enabled: true,
	};
}

function entry(partial: Partial<RankedEntry> & { id: string }): RankedEntry {
	return {
		tier: 'swarm',
		lesson: 'lesson',
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.8,
		status: 'established',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		relevanceScore: { category: 0, confidence: 0, keywords: 0 },
		finalScore: 0.5,
		...partial,
	} as RankedEntry;
}

describe('buildDelegateDirectiveBlock', () => {
	it('renders a deterministic block sorted by priority then id', () => {
		// Provide entries OUT of priority order to prove the sort runs.
		const entries: RankedEntry[] = [
			entry({
				id: 'k-med',
				directive_priority: 'medium',
				lesson: 'Document edge cases',
			}),
			entry({
				id: 'k-crit',
				directive_priority: 'critical',
				lesson: 'Never use async iterators in hot paths',
				forbidden_actions: ['async iterator'],
			}),
			entry({
				id: 'k-high',
				directive_priority: 'high',
				lesson: 'Prefer for-loops',
				required_actions: ['use a for loop', 'measure throughput'],
				verification_checks: ['grep for "for await"'],
			}),
		];

		const block = buildDelegateDirectiveBlock(entries, makeConfig());

		const expected = [
			'<delegate_knowledge_directives>',
			'These directives were learned from prior swarm runs and scoped to your role. Apply them to the task below.',
			'ACK CONTRACT: end your FINAL message with one line per CRITICAL directive in this block:',
			'  KNOWLEDGE_APPLIED:<id> — you applied it',
			'  KNOWLEDGE_IGNORED:<id> reason=<short why> — you intentionally did not apply it',
			'  KNOWLEDGE_N_A:<id> reason=<why> — it did not apply to your task',
			'Omitting a critical id is a contract violation.',
			'- id: k-crit',
			'  priority: critical',
			'  lesson: Never use async iterators in hot paths',
			'  forbidden: async iterator',
			'- id: k-high',
			'  priority: high',
			'  lesson: Prefer for-loops',
			'  required: use a for loop; measure throughput',
			'  verification: grep for "for await"',
			'- id: k-med',
			'  priority: medium',
			'  lesson: Document edge cases',
			'</delegate_knowledge_directives>',
		].join('\n');

		expect(block).toBe(expected);
	});

	it('returns null when there are zero entries (no empty wrapper)', () => {
		expect(buildDelegateDirectiveBlock([], makeConfig())).toBeNull();
	});

	it('omits optional fields that are absent or empty', () => {
		const block = buildDelegateDirectiveBlock(
			[
				entry({
					id: 'k-1',
					directive_priority: 'high',
					lesson: 'Lonely lesson',
					forbidden_actions: [],
				}),
			],
			makeConfig(),
		);
		expect(block).not.toBeNull();
		expect(block).toContain('  lesson: Lonely lesson');
		expect(block).not.toContain('forbidden:');
		expect(block).not.toContain('required:');
		expect(block).not.toContain('verification:');
	});

	it('defaults a missing priority to medium', () => {
		const block = buildDelegateDirectiveBlock(
			[entry({ id: 'k-x', lesson: 'No priority set' })],
			makeConfig(),
		);
		expect(block).toContain('  priority: medium');
	});
});
