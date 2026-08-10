import { describe, expect, it } from 'bun:test';
import {
	ApprovalEvidenceSchema,
	BaseEvidenceSchema,
	BuildEvidenceSchema,
	DiffEvidenceSchema,
	EVIDENCE_MAX_JSON_BYTES,
	EVIDENCE_MAX_PATCH_BYTES,
	EVIDENCE_MAX_TASK_BYTES,
	type Evidence,
	EvidenceBundleSchema,
	EvidenceSchema,
	type EvidenceType,
	EvidenceTypeSchema,
	EvidenceVerdictSchema,
	NoteEvidenceSchema,
	PlaceholderEvidenceSchema,
	QualityBudgetEvidenceSchema,
	RetrospectiveEvidenceSchema,
	ReviewEvidenceSchema,
	SastEvidenceSchema,
	SbomEvidenceSchema,
	SecretscanEvidenceSchema,
	SyntaxEvidenceSchema,
	TestEvidenceSchema,
} from '../../../src/config/evidence-schema';

describe('RetrospectiveEvidenceSchema - new fields (v6.13.3)', () => {
	const validRetroBase = {
		task_id: 'retro-1',
		type: 'retrospective' as const,
		timestamp: '2026-02-09T12:00:00.000Z',
		agent: 'mega_reviewer',
		verdict: 'info' as const,
		summary: 'Phase 1 retrospective',
		phase_number: 1,
		total_tool_calls: 150,
		coder_revisions: 3,
		reviewer_rejections: 1,
		test_failures: 2,
		security_findings: 0,
		integration_issues: 1,
		task_count: 5,
		task_complexity: 'moderate' as const,
		top_rejection_reasons: [],
		lessons_learned: [],
	};

	it('user_directives validates with all category/scope combinations', () => {
		const evidence = {
			...validRetroBase,
			user_directives: [
				{
					directive: 'Use TypeScript strict mode',
					category: 'tooling' as const,
					scope: 'session' as const,
				},
				{
					directive: 'Follow naming conventions',
					category: 'code_style' as const,
					scope: 'project' as const,
				},
				{
					directive: 'Keep functions small',
					category: 'architecture' as const,
					scope: 'global' as const,
				},
				{
					directive: 'Write tests first',
					category: 'process' as const,
					scope: 'project' as const,
				},
				{
					directive: 'Avoid magic numbers',
					category: 'other' as const,
					scope: 'session' as const,
				},
			],
		};
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.user_directives.length).toBeGreaterThanOrEqual(5);
		}
	});

	it('user_directives defaults to empty array when omitted', () => {
		const evidence = { ...validRetroBase };
		// @ts-ignore - intentionally omitting user_directives
		delete evidence.user_directives;
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.user_directives).toEqual([]);
		}
	});

	it('user_directives rejects invalid category value', () => {
		const evidence = {
			...validRetroBase,
			user_directives: [
				{
					directive: 'Test directive',
					category: 'invalid_cat' as any,
					scope: 'session' as const,
				},
			],
		};
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('user_directives rejects invalid scope value', () => {
		const evidence = {
			...validRetroBase,
			user_directives: [
				{
					directive: 'Test directive',
					category: 'tooling' as const,
					scope: 'team' as any,
				},
			],
		};
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('approaches_tried validates with all result values', () => {
		const evidence = {
			...validRetroBase,
			approaches_tried: [
				{
					approach: 'First approach - direct implementation',
					result: 'success' as const,
				},
				{
					approach: 'Second approach - refactored implementation',
					result: 'failure' as const,
					abandoned_reason: 'Too complex',
				},
				{
					approach: 'Third approach - hybrid solution',
					result: 'partial' as const,
				},
			],
		};
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.approaches_tried.length).toBe(3);
		}
	});

	it('approaches_tried defaults to empty array when omitted', () => {
		const evidence = { ...validRetroBase };
		// @ts-ignore - intentionally omitting approaches_tried
		delete evidence.approaches_tried;
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.approaches_tried).toEqual([]);
		}
	});

	it('approaches_tried respects max(10) limit', () => {
		const evidence = {
			...validRetroBase,
			approaches_tried: Array.from({ length: 11 }, (_, i) => ({
				approach: `Approach ${i + 1}`,
				result: 'success' as const,
			})),
		};
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('approaches_tried rejects invalid result enum value', () => {
		const evidence = {
			...validRetroBase,
			approaches_tried: [
				{ approach: 'Test approach', result: 'skipped' as any },
			],
		};
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(false);
	});

	it('full retrospective with all new and existing fields validates correctly', () => {
		const evidence = {
			...validRetroBase,
			user_directives: [
				{
					directive: 'Use TypeScript strict mode',
					category: 'tooling' as const,
					scope: 'session' as const,
				},
				{
					directive: 'Follow naming conventions',
					category: 'code_style' as const,
					scope: 'project' as const,
				},
			],
			approaches_tried: [
				{
					approach: 'First approach - direct implementation',
					result: 'success' as const,
				},
				{
					approach: 'Second approach - refactored implementation',
					result: 'failure' as const,
					abandoned_reason: 'Too complex',
				},
			],
		};
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.user_directives.length).toBe(2);
			expect(result.data.approaches_tried.length).toBe(2);
		}
	});

	it('existing retrospective without new fields still validates (backward compat)', () => {
		const evidence = { ...validRetroBase };
		const result = RetrospectiveEvidenceSchema.safeParse(evidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.user_directives).toEqual([]);
			expect(result.data.approaches_tried).toEqual([]);
		}
	});
});
