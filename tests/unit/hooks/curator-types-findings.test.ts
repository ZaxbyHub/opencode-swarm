/**
 * curator-types-findings.test.ts
 *
 * Behavioral tests for curator-types.ts — Finding and Summary types (FR-012):
 * KnowledgeApplicationFinding, SkillCandidate, CuratorSummary, CuratorConfig
 *
 * Note: curator-types.ts exports only interfaces/types — no runtime logic.
 * Tests verify type-level contracts via concrete object construction and
 * exhaustiveness assertions on discriminator fields.
 */

import { describe, expect, it } from 'bun:test';
import type {
	CuratorConfig,
	CuratorSummary,
	KnowledgeApplicationFinding,
	PhaseDigestEntry,
	SkillCandidate,
} from '../../../src/hooks/curator-types';

// ---------------------------------------------------------------------------
// Helper: exhaustiveness sentinel — causes compile-time error if a union case
// is not handled in a switch on its discriminator.
// ---------------------------------------------------------------------------
/** Narrows a discriminated union exhaustively. If TypeScript narrows correctly, `never` is impossible. */
function assertNever(x: never): never {
	throw new Error(`Unhandled case: ${JSON.stringify(x)}`);
}

// ---------------------------------------------------------------------------
// KnowledgeApplicationFinding.verdict
// ---------------------------------------------------------------------------
describe('KnowledgeApplicationFinding', () => {
	const VERDICT_VALUES = [
		'applied',
		'ignored',
		'violated',
		'not_applicable',
	] as const;

	it('compiles with every verdict variant', () => {
		for (const verdict of VERDICT_VALUES) {
			const finding: KnowledgeApplicationFinding = {
				knowledge_id: 'k-001',
				expected_behavior: 'expected',
				observed_behavior: 'observed',
				verdict,
				evidence_refs: [],
			};
			expect(finding.verdict).toBe(verdict);
		}
	});

	it('exhaustive switch — all four verdicts covered', () => {
		for (const verdict of VERDICT_VALUES) {
			const finding: KnowledgeApplicationFinding = {
				knowledge_id: 'k-001',
				expected_behavior: 'exp',
				observed_behavior: 'obs',
				verdict,
				evidence_refs: ['file:///test'],
			};
			switch (finding.verdict) {
				case 'applied':
					expect(finding.verdict).toBe('applied');
					break;
				case 'ignored':
					expect(finding.verdict).toBe('ignored');
					break;
				case 'violated':
					expect(finding.verdict).toBe('violated');
					break;
				case 'not_applicable':
					expect(finding.verdict).toBe('not_applicable');
					break;
				default:
					assertNever(finding);
			}
		}
	});

	it('evidence_refs is array of strings', () => {
		const finding: KnowledgeApplicationFinding = {
			knowledge_id: 'k-002',
			expected_behavior: 'use safe path APIs',
			observed_behavior: 'used process.cwd() directly',
			verdict: 'violated',
			evidence_refs: [
				'src/utils/paths.ts:42',
				'src/hooks/guardrails/index.ts:15',
			],
		};
		expect(finding.evidence_refs.length).toBe(2);
		expect(finding.evidence_refs[0]).toContain('paths.ts');
	});
});

// ---------------------------------------------------------------------------
// SkillCandidate — compound object with required and optional fields
// ---------------------------------------------------------------------------
describe('SkillCandidate', () => {
	it('compiles with all required fields', () => {
		const candidate: SkillCandidate = {
			slug: 'safe-path-usage',
			title: 'Safe Path Usage',
			source_knowledge_ids: ['k-001', 'k-002'],
			trigger: 'when code uses process.cwd() or path拼接',
			required_procedure: ['use path.join()', 'validateDirectory()'],
			forbidden_shortcuts: ['never use string concatenation for paths'],
			target_agents: ['coder', 'reviewer'],
			reviewer_checks: ['grep for process.cwd()', 'verify path.join() usage'],
			confidence: 0.92,
			reason: 'widely applicable cross-platform path safety',
		};
		expect(candidate.slug).toBe('safe-path-usage');
		expect(candidate.confidence).toBe(0.92);
		expect(candidate.target_agents).toContain('reviewer');
	});

	it('compiles with minimal required fields', () => {
		// confidence is required on SkillCandidate (unlike KnowledgeRecommendation)
		const candidate: SkillCandidate = {
			slug: 'test-slug',
			title: 'Test',
			source_knowledge_ids: [],
			trigger: '',
			required_procedure: [],
			forbidden_shortcuts: [],
			target_agents: [],
			reviewer_checks: [],
			confidence: 0.5,
			reason: '',
		};
		expect(candidate.slug).toBe('test-slug');
	});
});

// ---------------------------------------------------------------------------
// CuratorSummary — top-level persisted artifact
// ---------------------------------------------------------------------------
describe('CuratorSummary', () => {
	it('compiles with all fields', () => {
		const summary: CuratorSummary = {
			schema_version: 1,
			session_id: 'session-abc',
			last_updated: '2026-01-01T12:00:00.000Z',
			last_phase_covered: 3,
			digest: 'abc123digest',
			phase_digests: [
				{
					phase: 1,
					timestamp: '2026-01-01T10:00:00.000Z',
					summary: 'Phase 1 complete',
					agents_used: ['coder', 'reviewer'],
					tasks_completed: 5,
					tasks_total: 5,
					key_decisions: ['decided to use path.join()'],
					blockers_resolved: ['resolved path safety issue'],
				},
			],
			compliance_observations: [],
			knowledge_recommendations: [],
		};
		expect(summary.schema_version).toBe(1);
		expect(summary.last_phase_covered).toBe(3);
		expect(summary.phase_digests.length).toBe(1);
	});

	it('phase_digests entry has all required fields', () => {
		const entry: PhaseDigestEntry = {
			phase: 2,
			timestamp: '2026-01-01T11:00:00.000Z',
			summary: 'Phase 2 done',
			agents_used: ['coder'],
			tasks_completed: 3,
			tasks_total: 4,
			key_decisions: [],
			blockers_resolved: ['blocked by dependency'],
		};
		expect(entry.phase).toBe(2);
		expect(entry.tasks_total).toBe(4);
		expect(entry.blockers_resolved).toContain('blocked by dependency');
	});
});

// ---------------------------------------------------------------------------
// CuratorConfig — configuration object
// ---------------------------------------------------------------------------
describe('CuratorConfig', () => {
	it('compiles with all fields', () => {
		const config: CuratorConfig = {
			enabled: true,
			init_enabled: true,
			phase_enabled: true,
			postmortem_enabled: true,
			max_summary_tokens: 4000,
			min_knowledge_confidence: 0.7,
			compliance_report: true,
			suppress_warnings: false,
			drift_inject_max_chars: 500,
			llm_timeout_ms: 30_000,
			skill_generation_enabled: true,
			skill_generation_mode: 'draft',
			min_skill_confidence: 0.8,
			min_skill_confirmations: 2,
		};
		expect(config.enabled).toBe(true);
		expect(config.skill_generation_mode).toBe('draft');
	});

	it('postmortem_enabled and skill fields are optional', () => {
		const config: CuratorConfig = {
			enabled: false,
			init_enabled: false,
			phase_enabled: false,
			max_summary_tokens: 1000,
			min_knowledge_confidence: 0.5,
			compliance_report: false,
			suppress_warnings: true,
			drift_inject_max_chars: 200,
		};
		expect(config.postmortem_enabled).toBeUndefined();
		expect(config.skill_generation_enabled).toBeUndefined();
		expect(config.skill_generation_mode).toBeUndefined();
	});
});
