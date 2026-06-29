/**
 * curator-types-compliance.test.ts
 *
 * Behavioral tests for curator-types.ts — Compliance and Drift types (FR-012):
 * ComplianceObservation, KnowledgeRecommendation, DriftReport, DocDriftReport
 *
 * Note: curator-types.ts exports only interfaces/types — no runtime logic.
 * Tests verify type-level contracts via concrete object construction and
 * exhaustiveness assertions on discriminator fields.
 */

import { describe, expect, it } from 'bun:test';
import type {
	ComplianceObservation,
	DocDriftReport,
	DriftReport,
	KnowledgeRecommendation,
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
// Discriminated union: ComplianceObservation
// ---------------------------------------------------------------------------
describe('ComplianceObservation', () => {
	const DISCRIMINATOR_VALUES = [
		'missing_reviewer',
		'missing_retro',
		'missing_sme',
		'skipped_test',
		'workflow_deviation',
	] as const;

	it('compiles with every discriminator variant', () => {
		for (const type of DISCRIMINATOR_VALUES) {
			const obs: ComplianceObservation = {
				phase: 1,
				timestamp: '2026-01-01T00:00:00.000Z',
				type,
				description: `test ${type}`,
				severity: 'info',
			};
			expect(obs.type).toBe(type);
		}
	});

	it('narrows correctly on discriminator — no fallthrough', () => {
		const obs: ComplianceObservation = {
			phase: 1,
			timestamp: '2026-01-01T00:00:00.000Z',
			type: 'missing_reviewer',
			description: 'reviewer absent',
			severity: 'warning',
		};

		// Type narrowing should eliminate all other variants
		let count = 0;
		if (obs.type === 'missing_reviewer') {
			count++;
		}
		if (obs.type === 'missing_retro') {
			count++;
		}
		if (obs.type === 'missing_sme') {
			count++;
		}
		if (obs.type === 'skipped_test') {
			count++;
		}
		if (obs.type === 'workflow_deviation') {
			count++;
		}
		expect(count).toBe(1);
	});

	it('exhaustive switch — all five variants covered', () => {
		const variants = [
			{ type: 'missing_reviewer' as const, description: 'a' },
			{ type: 'missing_retro' as const, description: 'b' },
			{ type: 'missing_sme' as const, description: 'c' },
			{ type: 'skipped_test' as const, description: 'd' },
			{ type: 'workflow_deviation' as const, description: 'e' },
		];

		for (const v of variants) {
			const obs: ComplianceObservation = {
				phase: 1,
				timestamp: '',
				...v,
				severity: 'info',
			};
			// This switch covers every variant — TypeScript errors if a case is missing
			switch (obs.type) {
				case 'missing_reviewer':
					expect(obs.type).toBe('missing_reviewer');
					break;
				case 'missing_retro':
					expect(obs.type).toBe('missing_retro');
					break;
				case 'missing_sme':
					expect(obs.type).toBe('missing_sme');
					break;
				case 'skipped_test':
					expect(obs.type).toBe('skipped_test');
					break;
				case 'workflow_deviation':
					expect(obs.type).toBe('workflow_deviation');
					break;
				default:
					assertNever(obs);
			}
		}
	});

	it('severity is limited to info | warning', () => {
		const obsInfo: ComplianceObservation = {
			phase: 1,
			timestamp: '',
			type: 'missing_reviewer',
			description: 'info',
			severity: 'info',
		};
		const obsWarn: ComplianceObservation = {
			phase: 1,
			timestamp: '',
			type: 'missing_reviewer',
			description: 'warning',
			severity: 'warning',
		};
		expect(obsInfo.severity).toBe('info');
		expect(obsWarn.severity).toBe('warning');
	});
});

// ---------------------------------------------------------------------------
// Discriminated union: KnowledgeRecommendation
// ---------------------------------------------------------------------------
describe('KnowledgeRecommendation', () => {
	const ACTION_VALUES = [
		'promote',
		'archive',
		'flag_contradiction',
		'rewrite',
	] as const;

	it('compiles with every action variant', () => {
		for (const action of ACTION_VALUES) {
			const rec: KnowledgeRecommendation = {
				action,
				lesson: `lesson for ${action}`,
				reason: `reason for ${action}`,
			};
			expect(rec.action).toBe(action);
		}
	});

	it('exhaustive switch — all four actions covered', () => {
		for (const action of ACTION_VALUES) {
			const rec: KnowledgeRecommendation = { action, lesson: 'l', reason: 'r' };
			switch (rec.action) {
				case 'promote':
					expect(rec.action).toBe('promote');
					break;
				case 'archive':
					expect(rec.action).toBe('archive');
					break;
				case 'flag_contradiction':
					expect(rec.action).toBe('flag_contradiction');
					break;
				case 'rewrite':
					expect(rec.action).toBe('rewrite');
					break;
				default:
					assertNever(rec);
			}
		}
	});

	it('narrows correctly — entry_id only present when expected', () => {
		const withId: KnowledgeRecommendation = {
			action: 'promote',
			entry_id: 'entry-123',
			lesson: 'lesson',
			reason: 'reason',
		};
		const withoutId: KnowledgeRecommendation = {
			action: 'archive',
			lesson: 'lesson',
			reason: 'reason',
		};
		expect(withId.entry_id).toBe('entry-123');
		expect(withoutId.entry_id).toBeUndefined();
	});

	it('category and confidence are optional', () => {
		const rec: KnowledgeRecommendation = {
			action: 'promote',
			lesson: 'lesson',
			reason: 'reason',
		};
		expect(rec.category).toBeUndefined();
		expect(rec.confidence).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Discriminated union: DriftReport.alignment
// ---------------------------------------------------------------------------
describe('DriftReport', () => {
	const ALIGNMENT_VALUES = [
		'ALIGNED',
		'MINOR_DRIFT',
		'MAJOR_DRIFT',
		'OFF_SPEC',
	] as const;

	it('compiles with every alignment variant', () => {
		for (const alignment of ALIGNMENT_VALUES) {
			const report: DriftReport = {
				schema_version: 1,
				phase: 1,
				timestamp: '2026-01-01T00:00:00.000Z',
				alignment,
				drift_score: alignment === 'ALIGNED' ? 0 : 0.5,
				first_deviation: null,
				compounding_effects: [],
				corrections: [],
				requirements_checked: 0,
				requirements_satisfied: 0,
				scope_additions: [],
				injection_summary: '',
			};
			expect(report.alignment).toBe(alignment);
		}
	});

	it('exhaustive switch — all four alignments covered', () => {
		for (const alignment of ALIGNMENT_VALUES) {
			const report: DriftReport = {
				schema_version: 1,
				phase: 1,
				timestamp: '',
				alignment,
				drift_score: alignment === 'ALIGNED' ? 0 : 0.5,
				first_deviation:
					alignment === 'ALIGNED'
						? null
						: {
								phase: 1,
								task: '1.1',
								description: 'test deviation',
							},
				compounding_effects: [],
				corrections: [],
				requirements_checked: 1,
				requirements_satisfied: alignment === 'ALIGNED' ? 1 : 0,
				scope_additions: [],
				injection_summary: '',
			};
			switch (report.alignment) {
				case 'ALIGNED':
					expect(report.alignment).toBe('ALIGNED');
					break;
				case 'MINOR_DRIFT':
					expect(report.alignment).toBe('MINOR_DRIFT');
					break;
				case 'MAJOR_DRIFT':
					expect(report.alignment).toBe('MAJOR_DRIFT');
					break;
				case 'OFF_SPEC':
					expect(report.alignment).toBe('OFF_SPEC');
					break;
				default:
					assertNever(report);
			}
		}
	});

	it('first_deviation is typed correctly when not null', () => {
		const report: DriftReport = {
			schema_version: 1,
			phase: 1,
			timestamp: '',
			alignment: 'MINOR_DRIFT',
			drift_score: 0.3,
			first_deviation: {
				phase: 2,
				task: '2.1',
				description: 'scope creep',
			},
			compounding_effects: [],
			corrections: [],
			requirements_checked: 5,
			requirements_satisfied: 4,
			scope_additions: ['new-feature'],
			injection_summary: 'minor drift injected',
		};
		expect(report.first_deviation).not.toBeNull();
		if (report.first_deviation !== null) {
			expect(report.first_deviation.phase).toBe(2);
			expect(report.first_deviation.task).toBe('2.1');
		}
	});

	it('drift_score is 0.0–1.0 range (sanity)', () => {
		const aligned: DriftReport = {
			schema_version: 1,
			phase: 1,
			timestamp: '',
			alignment: 'ALIGNED',
			drift_score: 0,
			first_deviation: null,
			compounding_effects: [],
			corrections: [],
			requirements_checked: 1,
			requirements_satisfied: 1,
			scope_additions: [],
			injection_summary: '',
		};
		const offSpec: DriftReport = {
			schema_version: 1,
			phase: 1,
			timestamp: '',
			alignment: 'OFF_SPEC',
			drift_score: 1.0,
			first_deviation: { phase: 1, task: '1.1', description: 'x' },
			compounding_effects: [],
			corrections: [],
			requirements_checked: 1,
			requirements_satisfied: 0,
			scope_additions: [],
			injection_summary: '',
		};
		expect(aligned.drift_score).toBe(0);
		expect(offSpec.drift_score).toBe(1.0);
	});
});

// ---------------------------------------------------------------------------
// Discriminated union: DocDriftReport.verdict
// ---------------------------------------------------------------------------
describe('DocDriftReport', () => {
	const VERDICT_VALUES = ['DOC_FRESH', 'DOC_STALE', 'NO_DOCS'] as const;

	it('compiles with every verdict variant', () => {
		for (const verdict of VERDICT_VALUES) {
			const report: DocDriftReport = {
				schema_version: 1,
				phase: 1,
				timestamp: '2026-01-01T00:00:00.000Z',
				verdict,
				out_dir: 'docs',
				stale_sections: [],
				missing_docs: [],
				checked_docs: [],
			};
			expect(report.verdict).toBe(verdict);
		}
	});

	it('exhaustive switch — all three verdicts covered', () => {
		for (const verdict of VERDICT_VALUES) {
			const report: DocDriftReport = {
				schema_version: 1,
				phase: 1,
				timestamp: '',
				verdict,
				out_dir: 'docs',
				stale_sections:
					verdict === 'DOC_STALE'
						? [{ section_id: 's1', doc: 'domain.md', reason: 'stale' }]
						: [],
				missing_docs: verdict === 'NO_DOCS' ? ['domain.md'] : [],
				checked_docs: [],
			};
			switch (report.verdict) {
				case 'DOC_FRESH':
					expect(report.verdict).toBe('DOC_FRESH');
					break;
				case 'DOC_STALE':
					expect(report.verdict).toBe('DOC_STALE');
					break;
				case 'NO_DOCS':
					expect(report.verdict).toBe('NO_DOCS');
					break;
				default:
					assertNever(report);
			}
		}
	});

	it('stale_sections is array of objects with required fields', () => {
		const report: DocDriftReport = {
			schema_version: 1,
			phase: 1,
			timestamp: '',
			verdict: 'DOC_STALE',
			out_dir: 'docs',
			stale_sections: [
				{
					section_id: 'architecture',
					doc: 'technical-spec.md',
					reason: 'outdated',
				},
				{
					section_id: 'api_reference',
					doc: 'behavior-spec.md',
					reason: 'missing anchor',
				},
			],
			missing_docs: [],
			checked_docs: ['domain.md', 'technical-spec.md', 'behavior-spec.md'],
		};
		expect(report.stale_sections.length).toBe(2);
		expect(report.stale_sections[0].section_id).toBe('architecture');
		expect(report.stale_sections[1].doc).toBe('behavior-spec.md');
	});
});
