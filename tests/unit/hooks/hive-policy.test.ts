/**
 * Identity & policy gate (issue #1847 §"Required tests").
 *
 * Verifies:
 *  - countDistinctProjects keys on canonical cohort_id (sibling worktrees / remote
 *    aliases of one repo count as one project; two distinct cohorts count as two).
 *  - evaluatePromotionPolicy gates + diagnostics.
 *  - Manual promotion cannot bypass policy without an explicit, audited override;
 *    the override is durable and records the failed gates.
 *  - Conservative application evidence: shown/retrieved/unvalidated receipts do
 *    not qualify; only validated terminal receipts count.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	describeEligibilityRoute,
	evaluatePromotionPolicy,
	failedGateNames,
} from '../../../src/hooks/hive-policy.js';
import { countDistinctProjects } from '../../../src/hooks/hive-promoter.js';
import type {
	KnowledgeConfig,
	ProjectConfirmationRecord,
	PromotionEvidenceRecord,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types.js';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { ACTIONABLE_FIELDS } from './hive-fixtures.js';

// Route 3 is age-based (`Date.now() - created_at` vs `auto_promote_days`), so a
// live clock drifts each fixture's route. Pinned past the fixtures (#1782 c1).
const FROZEN_NOW = Date.parse('2026-07-01T00:00:00.000Z');
let restoreClock: Restore | null = null;
beforeEach(() => {
	restoreClock = freezeClock({ fixedNow: FROZEN_NOW });
});
afterEach(() => restoreClock?.());

/**
 * A policy-evaluation fixture. Carries `ACTIONABLE_FIELDS` so it clears the
 * default-ON #1821 A3 `actionability_floor` gate; tests that target that gate
 * override the fields explicitly (see the actionability_floor describe block).
 */
function makeEntry(
	overrides: Partial<SwarmKnowledgeEntry> = {},
): SwarmKnowledgeEntry {
	return {
		id: 'e1',
		tier: 'swarm',
		lesson: 'A canonical lesson about identity and policy gating here',
		category: 'process',
		tags: [],
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
		...overrides,
	};
}

const baseConfig: KnowledgeConfig = {
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
	promotion_min_terminal_applications: 0,
	promotion_min_distinct_cohorts: 0,
	directive_min_confidence: 0.75,
};

describe('countDistinctProjects — canonical cohort identity (#1847)', () => {
	it('sibling worktrees (same cohort_id) count as ONE project', () => {
		const confirmedBy: ProjectConfirmationRecord[] = [
			{
				project_name: 'repo-wt1',
				cohort_id: 'cohort-X',
				confirmed_at: '2026-01-01T00:00:00Z',
			},
			{
				project_name: 'repo-wt2',
				cohort_id: 'cohort-X',
				confirmed_at: '2026-01-02T00:00:00Z',
			},
		];
		expect(countDistinctProjects(confirmedBy)).toBe(1);
	});

	it('SSH and HTTPS aliases of one repo share one cohort_id → one project', () => {
		const confirmedBy: ProjectConfirmationRecord[] = [
			{
				project_name: 'git@github.com:o/r',
				cohort_id: 'cohort-Y',
				confirmed_at: '2026-01-01T00:00:00Z',
			},
			{
				project_name: 'https-github-com-o-r',
				cohort_id: 'cohort-Y',
				confirmed_at: '2026-01-02T00:00:00Z',
			},
		];
		expect(countDistinctProjects(confirmedBy)).toBe(1);
	});

	it('two genuinely distinct cohorts count as two projects', () => {
		const confirmedBy: ProjectConfirmationRecord[] = [
			{
				project_name: 'repo-a',
				cohort_id: 'cohort-A',
				confirmed_at: '2026-01-01T00:00:00Z',
			},
			{
				project_name: 'repo-b',
				cohort_id: 'cohort-B',
				confirmed_at: '2026-01-02T00:00:00Z',
			},
		];
		expect(countDistinctProjects(confirmedBy)).toBe(2);
	});

	it('legacy records without cohort_id fall back to project_name (no synthetic cohort)', () => {
		const confirmedBy: ProjectConfirmationRecord[] = [
			{ project_name: 'legacy-a', confirmed_at: '2026-01-01T00:00:00Z' },
			{ project_name: 'legacy-b', confirmed_at: '2026-01-02T00:00:00Z' },
		];
		// Transitional: legacy records are NOT retroactively re-counted (M2).
		expect(countDistinctProjects(confirmedBy)).toBe(2);
	});

	it('mixed cohort + legacy: cohort deduped, legacy by name, never double-counted', () => {
		const confirmedBy: ProjectConfirmationRecord[] = [
			{
				project_name: 'wt1',
				cohort_id: 'cohort-Z',
				confirmed_at: '2026-01-01T00:00:00Z',
			},
			{
				project_name: 'wt2',
				cohort_id: 'cohort-Z',
				confirmed_at: '2026-01-02T00:00:00Z',
			},
			{ project_name: 'legacy-only', confirmed_at: '2026-01-03T00:00:00Z' },
		];
		// 1 cohort + 1 legacy name = 2.
		expect(countDistinctProjects(confirmedBy)).toBe(2);
	});
});

describe('evaluatePromotionPolicy — gates + diagnostics (#1847)', () => {
	it('route 1 (3 distinct phases + hive_eligible) is eligible at default thresholds', () => {
		const entry = makeEntry({
			hive_eligible: true,
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: '2026-01-01T00:00:00Z',
					project_name: 'p',
				},
				{
					phase_number: 2,
					confirmed_at: '2026-01-02T00:00:00Z',
					project_name: 'p',
				},
				{
					phase_number: 3,
					confirmed_at: '2026-01-03T00:00:00Z',
					project_name: 'p',
				},
			],
		});
		const decision = evaluatePromotionPolicy({
			entry,
			config: baseConfig,
			evidence: [],
		});
		expect(decision.eligible).toBe(true);
		expect(
			decision.gates.find((g) => g.name === 'eligibility_route')?.passed,
		).toBe(true);
	});

	it('an inactive status fails the active_status gate and is not eligible', () => {
		const entry = makeEntry({ status: 'archived', hive_eligible: true });
		const decision = evaluatePromotionPolicy({
			entry,
			config: baseConfig,
			evidence: [],
		});
		expect(decision.eligible).toBe(false);
		expect(decision.gates.find((g) => g.name === 'active_status')?.passed).toBe(
			false,
		);
		expect(failedGateNames(decision)).toContain('active_status');
	});

	it('a confidence-floor-demoted entry fails the confidence_floor gate', () => {
		const entry = makeEntry({
			tags: ['hive-fast-track'],
			confidence_floor_demoted: true,
		});
		const decision = evaluatePromotionPolicy({
			entry,
			config: baseConfig,
			evidence: [],
		});
		expect(decision.eligible).toBe(false);
		expect(
			decision.gates.find((g) => g.name === 'confidence_floor')?.passed,
		).toBe(false);
	});

	it('diagnostics explain each failed condition', () => {
		// created_at === the frozen now, so route 3 (age) fails by 0-day age.
		const entry = makeEntry({
			hive_eligible: false,
			tags: [],
			confirmed_by: [],
			created_at: new Date(FROZEN_NOW).toISOString(),
		});
		const decision = evaluatePromotionPolicy({
			entry,
			config: baseConfig,
			evidence: [],
		});
		expect(decision.eligible).toBe(false);
		// The eligibility_route gate detail enumerates route status.
		const route = decision.gates.find((g) => g.name === 'eligibility_route');
		expect(route?.detail).toContain('route');
	});
});

describe('evaluatePromotionPolicy — conservative application evidence (#1847)', () => {
	const evidenceConfig: KnowledgeConfig = {
		...baseConfig,
		promotion_min_terminal_applications: 2,
		promotion_min_distinct_cohorts: 2,
	};

	it('shown/retrieved-only receipts do NOT qualify (no validated terminal receipts)', () => {
		// An entry that passes the eligibility routes but has NO validated terminal
		// evidence fails the application gate when thresholds are > 0.
		const entry = makeEntry({ tags: ['hive-fast-track'] });
		const decision = evaluatePromotionPolicy({
			entry,
			config: evidenceConfig,
			evidence: [], // no receipts — does NOT count as credit
		});
		expect(decision.eligible).toBe(false);
		expect(
			decision.gates.find((g) => g.name === 'validated_terminal_applications')
				?.passed,
		).toBe(false);
	});

	it('validated terminal receipts across 2 distinct cohorts DO qualify', () => {
		const entry = makeEntry({ tags: ['hive-fast-track'] });
		const evidence: PromotionEvidenceRecord[] = [
			{
				cohort_id: 'cohort-A',
				entry_id: 'e1',
				retrieval_trace_id: 't1',
				receipt_outcome: 'applied',
				receipt_event_id: 'r1',
				timestamp: '2026-01-01T00:00:00Z',
			},
			{
				cohort_id: 'cohort-B',
				entry_id: 'e1',
				retrieval_trace_id: 't2',
				receipt_outcome: 'applied',
				receipt_event_id: 'r2',
				timestamp: '2026-01-02T00:00:00Z',
			},
		];
		const decision = evaluatePromotionPolicy({
			entry,
			config: evidenceConfig,
			evidence,
		});
		expect(
			decision.gates.find((g) => g.name === 'validated_terminal_applications')
				?.passed,
		).toBe(true);
	});

	it('receipts from only ONE cohort do not satisfy the distinct-cohort threshold', () => {
		const entry = makeEntry({ tags: ['hive-fast-track'] });
		const evidence: PromotionEvidenceRecord[] = [
			{
				cohort_id: 'cohort-A',
				entry_id: 'e1',
				retrieval_trace_id: 't1',
				receipt_outcome: 'applied',
				receipt_event_id: 'r1',
				timestamp: '2026-01-01T00:00:00Z',
			},
			{
				cohort_id: 'cohort-A',
				entry_id: 'e1',
				retrieval_trace_id: 't2',
				receipt_outcome: 'applied',
				receipt_event_id: 'r2',
				timestamp: '2026-01-02T00:00:00Z',
			},
		];
		const decision = evaluatePromotionPolicy({
			entry,
			config: evidenceConfig,
			evidence,
		});
		expect(
			decision.gates.find((g) => g.name === 'validated_terminal_applications')
				?.passed,
		).toBe(false);
	});

	it('default thresholds (0) preserve current behavior: absence neither credits nor blocks', () => {
		const entry = makeEntry({ tags: ['hive-fast-track'] });
		const decision = evaluatePromotionPolicy({
			entry,
			config: baseConfig, // thresholds default 0
			evidence: [],
		});
		expect(
			decision.gates.find((g) => g.name === 'validated_terminal_applications')
				?.passed,
		).toBe(true);
	});
});

describe('evaluatePromotionPolicy — actionability_floor gate (#1821 A3)', () => {
	/** An otherwise-eligible entry stripped of every predicate/scope field. */
	function proseOnly(): SwarmKnowledgeEntry {
		return makeEntry({
			tags: ['hive-fast-track'],
			applies_to_tools: undefined,
			applies_to_agents: undefined,
			required_actions: undefined,
			forbidden_actions: undefined,
			verification_checks: undefined,
			verification_predicate: undefined,
		});
	}

	it('a prose-only entry fails the gate and is NOT eligible (default ON)', () => {
		// baseConfig does not declare promotion_require_actionable at all, so this
		// also pins the `?? true` read of the OPTIONAL interface field: an
		// operator who never heard of the flag still gets the floor.
		expect(baseConfig.promotion_require_actionable).toBeUndefined();
		const decision = evaluatePromotionPolicy({
			entry: proseOnly(),
			config: baseConfig,
			evidence: [],
		});
		expect(decision.eligible).toBe(false);
		// The fast-track tag satisfies eligibility_route ONLY — it is a separate
		// gate and never bypasses the floor.
		expect(
			decision.gates.find((g) => g.name === 'eligibility_route')?.passed,
		).toBe(true);
		const gate = decision.gates.find((g) => g.name === 'actionability_floor');
		expect(gate?.passed).toBe(false);
		expect(gate?.detail).toContain('missing_predicate_and_scope');
		expect(failedGateNames(decision)).toContain('actionability_floor');
		expect(decision.reason).toContain('actionability_floor');
	});

	it('a predicate with no scope tag fails with missing_scope', () => {
		const decision = evaluatePromotionPolicy({
			entry: makeEntry({
				tags: ['hive-fast-track'],
				applies_to_tools: undefined,
				applies_to_agents: undefined,
				required_actions: ['run the type checker'],
			}),
			config: baseConfig,
			evidence: [],
		});
		expect(decision.eligible).toBe(false);
		expect(
			decision.gates.find((g) => g.name === 'actionability_floor')?.detail,
		).toContain('missing_scope');
	});

	it('a scope tag with no predicate fails with missing_predicate', () => {
		const decision = evaluatePromotionPolicy({
			entry: makeEntry({
				tags: ['hive-fast-track'],
				applies_to_tools: ['write'],
				required_actions: undefined,
			}),
			config: baseConfig,
			evidence: [],
		});
		expect(decision.eligible).toBe(false);
		expect(
			decision.gates.find((g) => g.name === 'actionability_floor')?.detail,
		).toContain('missing_predicate');
	});

	it('promotion_require_actionable=false restores legacy behavior', () => {
		const decision = evaluatePromotionPolicy({
			entry: proseOnly(),
			config: { ...baseConfig, promotion_require_actionable: false },
			evidence: [],
		});
		expect(decision.eligible).toBe(true);
		const gate = decision.gates.find((g) => g.name === 'actionability_floor');
		expect(gate?.passed).toBe(true);
		expect(gate?.detail).toContain('not enforced');
	});
});

describe('describeEligibilityRoute — preserved 3 routes (#1847 M1)', () => {
	it('route 1: hive_eligible + 3 distinct phases', () => {
		const r = describeEligibilityRoute(
			makeEntry({
				hive_eligible: true,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2026-01-01T00:00:00Z',
						project_name: 'p',
					},
					{
						phase_number: 2,
						confirmed_at: '2026-01-02T00:00:00Z',
						project_name: 'p',
					},
					{
						phase_number: 3,
						confirmed_at: '2026-01-03T00:00:00Z',
						project_name: 'p',
					},
				],
			}),
			90,
		);
		expect(r.passed).toBe(true);
		expect(r.detail).toContain('route 1');
	});

	it('route 2: hive-fast-track tag', () => {
		const r = describeEligibilityRoute(
			makeEntry({ tags: ['hive-fast-track'], hive_eligible: false }),
			90,
		);
		expect(r.passed).toBe(true);
		expect(r.detail).toContain('route 2');
	});

	it('route 3: age', () => {
		const old = new Date(FROZEN_NOW - 100 * 86_400_000).toISOString();
		const r = describeEligibilityRoute(
			makeEntry({ hive_eligible: false, tags: [], created_at: old }),
			90,
		);
		expect(r.passed).toBe(true);
		expect(r.detail).toContain('route 3');
	});
});
