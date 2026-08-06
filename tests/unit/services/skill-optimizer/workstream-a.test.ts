/**
 * Tests for Workstream A (lifecycle closure).
 * Covers: deterministic seed composition, promoted_external staleness policy,
 * wall-clock retirement gate, and the outcomeSignal === 0 zero-evidence boundary
 * (distinct from the existing strongOutcomes test in skill-generator.test.ts).
 */

import { describe, expect, it } from 'bun:test';
import {
	evaluatePromotedExternalStaleness,
	parsePromotedExternalFrontmatter,
} from '../../../../src/services/skill-optimizer/promoted-external-staleness.js';
import {
	classifyOutcomeSignal,
	evaluateRetirement,
} from '../../../../src/services/skill-optimizer/retirement.js';

describe('promoted-external staleness', () => {
	it('returns current when there is no decisive signal', () => {
		const d = evaluatePromotedExternalStaleness({
			directory: '',
			skillSlug: 'x',
			origin: 'promoted_external',
			usage: { appliedExplicitCount: 5, ignoredCount: 0, violatedCount: 0 },
			ageDays: 90,
			retirementMinAgeDays: 60,
		});
		expect(d.action).toBe('current');
	});

	it('retires a never-applied skill with strong negative signal past the age floor', () => {
		const d = evaluatePromotedExternalStaleness({
			directory: '',
			skillSlug: 'x',
			usage: { appliedExplicitCount: 0, ignoredCount: 5, violatedCount: 0 },
			ageDays: 90,
			retirementMinAgeDays: 60,
		});
		expect(d.action).toBe('retire');
	});

	it('does NOT retire below the minimum age floor', () => {
		const d = evaluatePromotedExternalStaleness({
			directory: '',
			skillSlug: 'x',
			usage: { appliedExplicitCount: 0, ignoredCount: 10, violatedCount: 10 },
			ageDays: 10,
			retirementMinAgeDays: 60,
		});
		expect(d.action).toBe('current');
	});

	it('reads promoted_external frontmatter', () => {
		const fm = parsePromotedExternalFrontmatter(
			'---\nskill_origin: promoted_external\nsource_knowledge_ids: ["a","b"]\nname: x\ndescription: y\n---\nbody',
		);
		expect(fm.origin).toBe('promoted_external');
		expect(fm.sourceKnowledgeIds).toEqual(['a', 'b']);
	});
});

describe('retirement gate', () => {
	it('refuses below the age floor', () => {
		expect(
			evaluateRetirement({
				usage: {
					appliedExplicitCount: 0,
					ignoredCount: 5,
					violatedCount: 0,
					failedAfterShownCount: 0,
				},
				ageDays: 10,
				minAgeDays: 60,
			}).retire,
		).toBe(false);
	});

	it('retires never-applied with strong negatives past the floor', () => {
		expect(
			evaluateRetirement({
				usage: {
					appliedExplicitCount: 0,
					ignoredCount: 5,
					violatedCount: 0,
					failedAfterShownCount: 0,
				},
				ageDays: 90,
				minAgeDays: 60,
			}).retire,
		).toBe(true);
	});

	it('keeps a supported skill even if old', () => {
		expect(
			evaluateRetirement({
				usage: {
					appliedExplicitCount: 10,
					ignoredCount: 1,
					violatedCount: 0,
					failedAfterShownCount: 0,
				},
				ageDays: 365,
				minAgeDays: 60,
			}).retire,
		).toBe(false);
	});
});

describe('outcomeSignal === 0 zero-evidence boundary', () => {
	it('classifies genuine no-evidence (no outcomes) as zero_evidence', () => {
		const { signal, classification } = classifyOutcomeSignal(undefined);
		expect(signal).toBe(0);
		expect(classification).toBe('zero_evidence');
	});

	it('classifies an all-zero outcome object as zero_evidence', () => {
		const { signal, classification } = classifyOutcomeSignal({
			applied_explicit_count: 0,
			succeeded_after_shown_count: 0,
			ignored_count: 0,
			violated_count: 0,
			contradicted_count: 0,
			failed_after_shown_count: 0,
		});
		expect(signal).toBe(0);
		expect(classification).toBe('zero_evidence');
	});

	it('classifies a positive signal as positive', () => {
		const { classification } = classifyOutcomeSignal({
			applied_explicit_count: 5,
			succeeded_after_shown_count: 0,
			ignored_count: 0,
			violated_count: 0,
			contradicted_count: 0,
			failed_after_shown_count: 0,
		});
		expect(classification).toBe('positive');
	});

	it('classifies a negative signal as negative', () => {
		const { classification } = classifyOutcomeSignal({
			applied_explicit_count: 0,
			succeeded_after_shown_count: 0,
			ignored_count: 5,
			violated_count: 0,
			contradicted_count: 0,
			failed_after_shown_count: 0,
		});
		expect(classification).toBe('negative');
	});
});

describe('promoted-external staleness — F5 block-list YAML + regenerate', () => {
	it('parses block-list YAML source_knowledge_ids', () => {
		const fm = parsePromotedExternalFrontmatter(
			'---\nskill_origin: promoted_external\nsource_knowledge_ids:\n  - "abc-123"\n  - "def-456"\nname: x\ndescription: y\n---\nbody',
		);
		expect(fm.origin).toBe('promoted_external');
		expect(fm.sourceKnowledgeIds).toEqual(['abc-123', 'def-456']);
	});

	it('still parses inline source_knowledge_ids', () => {
		const fm = parsePromotedExternalFrontmatter(
			'---\nskill_origin: promoted_external\nsource_knowledge_ids: ["a","b"]\n---\nbody',
		);
		expect(fm.sourceKnowledgeIds).toEqual(['a', 'b']);
	});

	it('returns regenerate when sourceChanged is true and IDs are present', () => {
		const d = evaluatePromotedExternalStaleness({
			directory: '',
			skillSlug: 'x',
			sourceKnowledgeIds: ['abc-123'],
			sourceChanged: true,
			usage: { appliedExplicitCount: 5, ignoredCount: 0, violatedCount: 0 },
			ageDays: 10,
			retirementMinAgeDays: 60,
		});
		expect(d.action).toBe('regenerate');
		expect('sourceKnowledgeIds' in d).toBe(true);
	});

	it('does not regenerate when sourceChanged but no IDs', () => {
		const d = evaluatePromotedExternalStaleness({
			directory: '',
			skillSlug: 'x',
			sourceChanged: true,
			usage: { appliedExplicitCount: 5, ignoredCount: 0, violatedCount: 0 },
			ageDays: 90,
			retirementMinAgeDays: 60,
		});
		expect(d.action).not.toBe('regenerate');
	});
});
