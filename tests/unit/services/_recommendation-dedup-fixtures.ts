/**
 * Shared fixtures for the curator-side cross-producer dedup tests
 * (issue #1821 AC21).
 *
 * Not a test file (no `.test.ts` suffix, so Bun does not collect it). Everything
 * here is a plain value builder or a filesystem helper — no mocks, so nothing
 * here can leak across files in Bun's shared test-runner process
 * (AGENTS.md invariant 7).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KnowledgeRecommendation } from '../../../src/hooks/curator-types.js';
import type {
	KnowledgeConfig,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types.js';

export const knowledgeConfig: KnowledgeConfig = {
	enabled: true,
	swarm_max_entries: 100,
	hive_max_entries: 200,
	auto_promote_days: 90,
	max_inject_count: 5,
	dedup_threshold: 0.6,
	scope_filter: ['global'],
	hive_enabled: true,
	rejected_max_entries: 20,
	// Off: the lesson-quality validator is orthogonal to dedup and would reject
	// the prose lessons in these suites before dedup could be observed.
	validation_enabled: false,
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

export const NEW_LESSON =
	'Prefer the _internals DI seam over mock.module in Bun tests';

/**
 * A new-entry `promote` must clear the Layer-5 actionability gate
 * (`src/hooks/actionability-predicate.ts`) or it is quarantined before the
 * append. Neither field participates in the cross-producer key — new knowledge
 * carries no scope keys — so this does not weaken what the dedup assertions
 * prove; it only keeps them falsifiable.
 */
export const ACTIONABLE = {
	required_actions: ['use the _internals seam'],
	applies_to_agents: ['coder'],
} satisfies Partial<KnowledgeRecommendation>;

export function knowledgeEntry(
	id: string,
	lesson: string,
	overrides: Partial<SwarmKnowledgeEntry> = {},
): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson,
		category: 'testing',
		tags: [],
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
		created_at: '2026-01-01T00:00:00Z',
		updated_at: '2026-01-01T00:00:00Z',
		project_name: 'test-project',
		...overrides,
	};
}

export function seedKnowledge(
	dir: string,
	entries: SwarmKnowledgeEntry[],
): void {
	fs.writeFileSync(
		path.join(dir, '.swarm', 'knowledge.jsonl'),
		entries.map((entry) => JSON.stringify(entry)).join('\n'),
		'utf-8',
	);
}

export function readKnowledge(dir: string): SwarmKnowledgeEntry[] {
	const file = path.join(dir, '.swarm', 'knowledge.jsonl');
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, 'utf-8')
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as SwarmKnowledgeEntry);
}
