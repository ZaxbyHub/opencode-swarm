/**
 * Shared fixtures for the hive promotion test files.
 *
 * Extracted while migrating fixtures for the #1821 A3 `actionability_floor`
 * promotion gate: `makeConfig` and `readRawHive` were byte-identical in
 * hive-promoter.test.ts, hive-promoter.adversarial.test.ts and
 * hive-migration-lineage.test.ts, and the actionability fixture below has to
 * stay consistent across all of them (a drifted copy would silently stop
 * exercising the gate).
 *
 * NOT a `.test.ts` file — it declares no tests and is never collected.
 */

import { promises as fsPromises } from 'node:fs';
import type {
	HiveKnowledgeEntry,
	KnowledgeConfig,
} from '../../../src/hooks/knowledge-types.js';
import { resolveHiveKnowledgePath } from '../../../src/knowledge/hive-paths.js';

/**
 * The minimum fields that satisfy the #1821 A3 `actionability_floor` gate: one
 * machine-checkable predicate (`required_actions`) plus one scope tag
 * (`applies_to_tools`). Spread into an entry factory to keep a fixture
 * promotable under the default-ON floor.
 *
 * Deliberately NOT a way to disable the gate — the gate stays on and these
 * fixtures satisfy it honestly, the same way real promotion candidates must.
 */
export const ACTIONABLE_FIELDS: {
	applies_to_tools: string[];
	required_actions: string[];
} = {
	applies_to_tools: ['write'],
	required_actions: ['run the type checker before handing off'],
};

/** Knowledge config used by the hive promotion tests (dedup_threshold 0.8). */
export function makeConfig(
	overrides: Partial<KnowledgeConfig> = {},
): KnowledgeConfig {
	return {
		enabled: true,
		swarm_max_entries: 100,
		hive_max_entries: 200,
		auto_promote_days: 90,
		max_inject_count: 5,
		dedup_threshold: 0.8,
		scope_filter: ['global'],
		hive_enabled: true,
		rejected_max_entries: 20,
		validation_enabled: true,
		evergreen_confidence: 0.9,
		evergreen_utility: 0.8,
		low_utility_threshold: 0.3,
		min_retrievals_for_utility: 3,
		schema_version: 2,
		same_project_weight: 1.0,
		cross_project_weight: 0.5,
		min_encounter_score: 0.1,
		initial_encounter_score: 1.0,
		encounter_increment: 0.1,
		max_encounter_score: 10.0,
		default_max_phases: 10,
		todo_max_phases: 3,
		sweep_enabled: true,
		confidence_floor_action: 'demote',
		confidence_floor_min_outcomes: 3,
		confidence_floor_signal_threshold: 0,
		contradiction_threshold_action: 'quarantine',
		contradiction_quarantine_threshold: 3,
		contradiction_quarantine_window_days: 30,
		promoted_demotion_min_negative_phases: 3,
		promoted_demotion_signal_threshold: -0.3,
		promotion_min_terminal_applications: 0,
		promotion_min_distinct_cohorts: 0,
		directive_min_confidence: 0.75,
		...overrides,
	};
}

/**
 * Read raw JSONL lines from the resolved hive path (no normalization). Used to
 * assert on the exact on-disk content written by the transaction.
 */
export async function readRawHive(): Promise<HiveKnowledgeEntry[]> {
	try {
		const content = await fsPromises.readFile(
			resolveHiveKnowledgePath(),
			'utf-8',
		);
		return content
			.split('\n')
			.filter((l) => l.trim().length > 0)
			.map((l) => JSON.parse(l) as HiveKnowledgeEntry);
	} catch {
		return [];
	}
}
