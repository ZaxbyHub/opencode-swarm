/**
 * curator-types-results.test.ts
 *
 * Behavioral tests for curator-types.ts — Result and Runtime types (FR-012):
 * CuratorInitResult, CuratorPhaseResult, CriticDriftResult, schema_version invariants
 *
 * Note: curator-types.ts exports only interfaces/types — no runtime logic.
 * Tests verify type-level contracts via concrete object construction and
 * exhaustiveness assertions on discriminator fields.
 */

import { describe, expect, it } from 'bun:test';
import type {
	CriticDriftResult,
	CuratorInitResult,
	CuratorPhaseResult,
	CuratorSummary,
	DocDriftReport,
	DriftReport,
} from '../../../src/hooks/curator-types';

// ---------------------------------------------------------------------------
// CuratorInitResult — returned from curator init phase
// ---------------------------------------------------------------------------
describe('CuratorInitResult', () => {
	it('compiles with all fields', () => {
		const result: CuratorInitResult = {
			briefing: 'Welcome, architect. Prior sessions: 2.',
			contradictions: [
				'Phase 1 used reviewer=coder, Phase 2 used reviewer=architect',
			],
			knowledge_entries_reviewed: 47,
			prior_phases_covered: 2,
		};
		expect(result.briefing).toContain('architect');
		expect(result.contradictions.length).toBe(1);
		expect(result.prior_phases_covered).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// CuratorPhaseResult — returned from each phase run
// ---------------------------------------------------------------------------
describe('CuratorPhaseResult', () => {
	it('compiles with knowledge_application_findings', () => {
		const result: CuratorPhaseResult = {
			phase: 1,
			digest: {
				phase: 1,
				timestamp: '',
				summary: 'done',
				agents_used: [],
				tasks_completed: 1,
				tasks_total: 1,
				key_decisions: [],
				blockers_resolved: [],
			},
			compliance: [],
			knowledge_recommendations: [],
			summary_updated: true,
			knowledge_application_findings: [
				{
					knowledge_id: 'k-001',
					expected_behavior: 'safe paths',
					observed_behavior: 'used path.join()',
					verdict: 'applied',
					evidence_refs: [],
				},
			],
		};
		expect(result.knowledge_application_findings).toHaveLength(1);
	});

	it('compiles with skill_candidates', () => {
		const result: CuratorPhaseResult = {
			phase: 2,
			digest: {
				phase: 2,
				timestamp: '',
				summary: '',
				agents_used: [],
				tasks_completed: 0,
				tasks_total: 0,
				key_decisions: [],
				blockers_resolved: [],
			},
			compliance: [],
			knowledge_recommendations: [],
			summary_updated: false,
			skill_candidates: [
				{
					slug: 'test-candidate',
					title: 'Test',
					source_knowledge_ids: ['k-001'],
					trigger: '',
					required_procedure: [],
					forbidden_shortcuts: [],
					target_agents: [],
					reviewer_checks: [],
					confidence: 0.75,
					reason: 'test',
				},
			],
		};
		expect(result.skill_candidates).toHaveLength(1);
	});

	it('already_digested flag is optional', () => {
		const result: CuratorPhaseResult = {
			phase: 1,
			digest: {
				phase: 1,
				timestamp: '',
				summary: '',
				agents_used: [],
				tasks_completed: 0,
				tasks_total: 0,
				key_decisions: [],
				blockers_resolved: [],
			},
			compliance: [],
			knowledge_recommendations: [],
			summary_updated: false,
			already_digested: true,
		};
		expect(result.already_digested).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// CriticDriftResult — produced by critic after curator phase run
// ---------------------------------------------------------------------------
describe('CriticDriftResult', () => {
	it('compiles with nested DriftReport', () => {
		const result: CriticDriftResult = {
			phase: 1,
			report: {
				schema_version: 1,
				phase: 1,
				timestamp: '2026-01-01T00:00:00.000Z',
				alignment: 'ALIGNED',
				drift_score: 0,
				first_deviation: null,
				compounding_effects: [],
				corrections: [],
				requirements_checked: 5,
				requirements_satisfied: 5,
				scope_additions: [],
				injection_summary: 'all good',
			},
			report_path: '.swarm/drift-report-phase-1.json',
			injection_text: 'Phase 1 aligned — no drift detected.',
		};
		expect(result.report.alignment).toBe('ALIGNED');
		expect(result.report_path).toContain('drift-report');
	});
});

// ---------------------------------------------------------------------------
// schema_version invariants — all top-level interfaces use schema_version: 1
// ---------------------------------------------------------------------------
describe('schema_version invariants', () => {
	it('CuratorSummary has schema_version 1', () => {
		const s: CuratorSummary = {
			schema_version: 1,
			session_id: 's',
			last_updated: '',
			last_phase_covered: 0,
			digest: '',
			phase_digests: [],
			compliance_observations: [],
			knowledge_recommendations: [],
		};
		expect(s.schema_version).toBe(1);
	});

	it('DriftReport has schema_version 1', () => {
		const r: DriftReport = {
			schema_version: 1,
			phase: 1,
			timestamp: '',
			alignment: 'ALIGNED',
			drift_score: 0,
			first_deviation: null,
			compounding_effects: [],
			corrections: [],
			requirements_checked: 0,
			requirements_satisfied: 0,
			scope_additions: [],
			injection_summary: '',
		};
		expect(r.schema_version).toBe(1);
	});

	it('DocDriftReport has schema_version 1', () => {
		const r: DocDriftReport = {
			schema_version: 1,
			phase: 1,
			timestamp: '',
			verdict: 'NO_DOCS',
			out_dir: 'docs',
			stale_sections: [],
			missing_docs: [],
			checked_docs: [],
		};
		expect(r.schema_version).toBe(1);
	});
});
