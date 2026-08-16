/**
 * Promotion-evidence independence gate (issue #2032 review F-003).
 *
 * Split from hive-policy.test.ts (at the FR-006 cap): when
 * `promotion_min_terminal_applications` / `promotion_min_distinct_cohorts`
 * are active, only INDEPENDENT evidence counts — `receipt_source` present
 * and not 'delegate'. Delegate self-report stays non-independent (the
 * release note's shipped guarantee), and pre-#2032 source-less records
 * fail closed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { evaluatePromotionPolicy } from '../../../src/hooks/hive-policy.js';
import type {
	KnowledgeConfig,
	PromotionEvidenceRecord,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types.js';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { ACTIONABLE_FIELDS } from './hive-fixtures.js';

const FROZEN_NOW = Date.parse('2026-07-01T00:00:00.000Z');
let restoreClock: Restore | null = null;
beforeEach(() => {
	restoreClock = freezeClock({ fixedNow: FROZEN_NOW });
});
afterEach(() => restoreClock?.());

function makeEntry(): SwarmKnowledgeEntry {
	return {
		id: 'e1',
		tier: 'swarm',
		lesson: 'A canonical lesson about identity and policy gating here',
		category: 'process',
		tags: ['hive-fast-track'],
		scope: 'global',
		confidence: 0.7,
		status: 'promoted',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00Z',
		updated_at: '2026-01-01T00:00:00Z',
		project_name: 'p',
		...ACTIONABLE_FIELDS,
	};
}

const evidenceConfig: KnowledgeConfig = {
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
	promotion_min_terminal_applications: 2,
	promotion_min_distinct_cohorts: 2,
	directive_min_confidence: 0.75,
};

function record(
	overrides: Partial<PromotionEvidenceRecord>,
): PromotionEvidenceRecord {
	return {
		cohort_id: 'cohort-A',
		entry_id: 'e1',
		retrieval_trace_id: 't1',
		receipt_outcome: 'applied',
		receipt_event_id: 'r1',
		timestamp: '2026-01-01T00:00:00Z',
		...overrides,
	};
}

describe('promotion evidence independence (#2032 F-003)', () => {
	const gate = (evidence: PromotionEvidenceRecord[]) =>
		evaluatePromotionPolicy({
			entry: makeEntry(),
			config: evidenceConfig,
			evidence,
		}).gates.find((g) => g.name === 'validated_terminal_applications');

	it('delegate-only self-report evidence NEVER satisfies the active gate', () => {
		const g = gate([
			record({ cohort_id: 'cohort-A', receipt_source: 'delegate' }),
			record({
				cohort_id: 'cohort-B',
				receipt_source: 'delegate',
				receipt_event_id: 'r2',
			}),
		]);
		expect(g?.passed).toBe(false);
		expect(g?.detail).toContain('independent');
	});

	it('source-less (pre-#2032) evidence fails closed — it is not independent', () => {
		const g = gate([
			record({ cohort_id: 'cohort-A' }),
			record({ cohort_id: 'cohort-B', receipt_event_id: 'r2' }),
		]);
		expect(g?.passed).toBe(false);
	});

	it('no evidence at all fails the active gate (absence is never credit)', () => {
		// Moved from hive-policy.test.ts's #1847 evidence block (FR-006 split).
		expect(gate([])?.passed).toBe(false);
	});

	it('independent receipts from only ONE cohort still fail the distinct-cohort threshold', () => {
		const g = gate([
			record({ cohort_id: 'cohort-A', receipt_source: 'reviewer' }),
			record({
				cohort_id: 'cohort-A',
				receipt_source: 'reviewer',
				receipt_event_id: 'r2',
			}),
		]);
		expect(g?.passed).toBe(false);
	});

	it('independent (reviewer/test_engineer) evidence across cohorts satisfies the gate', () => {
		const g = gate([
			record({ cohort_id: 'cohort-A', receipt_source: 'reviewer' }),
			record({
				cohort_id: 'cohort-B',
				receipt_source: 'test_engineer',
				receipt_event_id: 'r2',
			}),
		]);
		expect(g?.passed).toBe(true);
	});

	it('delegate evidence does not dilute a qualifying independent set (mixed passes)', () => {
		const g = gate([
			record({ cohort_id: 'cohort-A', receipt_source: 'reviewer' }),
			record({
				cohort_id: 'cohort-B',
				receipt_source: 'test_engineer',
				receipt_event_id: 'r2',
			}),
			record({
				cohort_id: 'cohort-C',
				receipt_source: 'delegate',
				receipt_event_id: 'r3',
			}),
		]);
		expect(g?.passed).toBe(true);
	});

	it('thresholds 0 keep the legacy behavior: delegate-only evidence neither credits nor blocks', () => {
		const g = evaluatePromotionPolicy({
			entry: makeEntry(),
			config: {
				...evidenceConfig,
				promotion_min_terminal_applications: 0,
				promotion_min_distinct_cohorts: 0,
			},
			evidence: [record({ receipt_source: 'delegate' })],
		}).gates.find((g2) => g2.name === 'validated_terminal_applications');
		expect(g?.passed).toBe(true);
		expect(g?.detail).toContain('threshold 0');
	});
});
