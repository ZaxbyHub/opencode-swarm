/**
 * Test fixtures for delegate-directive-injection behavioral tests.
 * Contains factory functions and mock data builders.
 */

import type { DelegateInjectionInput } from '../../../src/hooks/delegate-directive-injection.js';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader.js';
import type { KnowledgeConfig } from '../../../src/hooks/knowledge-types.js';

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

export function makeConfig(
	overrides?: Partial<KnowledgeConfig>,
): KnowledgeConfig {
	return {
		enabled: true,
		swarm_max_entries: 100,
		hive_max_entries: 200,
		auto_promote_days: 90,
		max_inject_count: 5,
		delegate_max_inject_count: 8,
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
		max_lesson_display_chars: 120,
		...(overrides ?? {}),
	};
}

export function makeEntry(
	partial: Partial<RankedEntry> & { id: string },
): RankedEntry {
	return {
		tier: 'swarm',
		lesson: 'lesson text',
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

export function makeInput(
	overrides?: Partial<DelegateInjectionInput>,
): DelegateInjectionInput {
	return {
		tool: 'Task',
		agent: 'architect',
		sessionID: 'test-session',
		args: {
			subagent_type: 'coder',
			prompt: 'Do the thing',
		},
		...overrides,
	};
}
