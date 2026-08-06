/**
 * Tests for constrained candidate generation (Workstream B).
 * Covers: trust-region enforcement, equivalent-patch detection, leakage denial,
 * budget/cancel.
 */

import { describe, expect, it } from 'bun:test';
import {
	buildGeneratorInputs,
	draftCandidate,
	enforceTrustRegion,
	isEquivalentPatch,
	type GeneratorInputs,
} from '../../../../src/services/skill-optimizer/candidates.js';

const BASE_BUDGET = { maxChangedLines: 200, maxChangedBytes: 20_000, maxChangedSections: 6 };

function makeInputs(overrides: Partial<GeneratorInputs> = {}): GeneratorInputs {
	return {
		baselineContent: '---\nname: test\ndescription: x\n---\n# Test\nbody',
		eligibleEvidence: [{ id: 'e1', triggers: ['t'], requiredActions: ['a'], forbiddenActions: [], confidence: 0.8 }],
		counterexamples: [],
		budget: BASE_BUDGET,
		...overrides,
	};
}

describe('skill-opt candidates — trust region', () => {
	it('enforces the trust region and breaches are flagged', () => {
		const big: any = {
			content: 'x',
			diffSummary: { changedLines: 500, changedBytes: 100, changedSections: 1 },
			rationale: '',
			risks: [],
			rollbackSnapshot: '',
			metric: { eligibilityScore: 0 },
		};
		expect(() => enforceTrustRegion(big, BASE_BUDGET)).toThrow(/TrustRegionViolation.*changedLines/);
	});

	it('accepts a candidate within the trust region', () => {
		const ok: any = {
			content: 'x',
			diffSummary: { changedLines: 10, changedBytes: 100, changedSections: 1 },
			rationale: '',
			risks: [],
			rollbackSnapshot: '',
			metric: { eligibilityScore: 0 },
		};
		expect(() => enforceTrustRegion(ok, BASE_BUDGET)).not.toThrow();
	});
});

describe('skill-opt candidates — equivalent patch', () => {
	it('detects identical content as equivalent', () => {
		expect(isEquivalentPatch('abc', 'abc')).toBe(true);
		expect(isEquivalentPatch('abc', 'abd')).toBe(false);
	});
});

describe('skill-opt candidates — leakage denial', () => {
	it('throws LEAKAGE_DETECTED when evidence references a held-out task ID', () => {
		let threw = false;
		try {
			buildGeneratorInputs({
				baselineContent: 'x',
				eligibleEvidence: [
					{ id: 'e1', triggers: ['task-test-abc-123'], requiredActions: ['a'], forbiddenActions: [], confidence: 0.8 },
				],
				counterexamples: [],
				budget: { max_changed_lines: 200, max_changed_bytes: 20_000, max_changed_sections: 6 } as never,
				claimedTestTaskIds: new Set(['task-test-abc-123']),
			});
		} catch (err) {
			threw = err instanceof Error && err.message.includes('LEAKAGE_DETECTED');
		}
		expect(threw).toBe(true);
	});

	it('allows evidence that does not reference held-out task IDs', () => {
		const inputs = buildGeneratorInputs({
			baselineContent: 'x',
			eligibleEvidence: [{ id: 'e1', triggers: ['safe'], requiredActions: ['a'], forbiddenActions: [], confidence: 0.8 }],
			counterexamples: [],
			budget: { max_changed_lines: 200, max_changed_bytes: 20_000, max_changed_sections: 6 } as never,
			claimedTestTaskIds: new Set(['task-test-xyz']),
		});
		expect(inputs.eligibleEvidence).toHaveLength(1);
	});

	it('does NOT false-positive on a substring (task-1 vs task-123) — final critic FI2', () => {
		// A held-out ID `task-1` must not match a legitimate phrase `task-123`.
		const inputs = buildGeneratorInputs({
			baselineContent: 'x',
			eligibleEvidence: [{ id: 'e1', triggers: ['reference task-123 for details'], requiredActions: ['a'], forbiddenActions: [], confidence: 0.8 }],
			counterexamples: [],
			budget: { max_changed_lines: 200, max_changed_bytes: 20_000, max_changed_sections: 6 } as never,
			claimedTestTaskIds: new Set(['task-1']),
		});
		expect(inputs.eligibleEvidence).toHaveLength(1);
	});

	it('matches an exact evidence id even when phrases are safe', () => {
		let threw = false;
		try {
			buildGeneratorInputs({
				baselineContent: 'x',
				eligibleEvidence: [{ id: 'task-1', triggers: ['safe'], requiredActions: ['a'], forbiddenActions: [], confidence: 0.8 }],
				counterexamples: [],
				budget: { max_changed_lines: 200, max_changed_bytes: 20_000, max_changed_sections: 6 } as never,
				claimedTestTaskIds: new Set(['task-1']),
			});
		} catch (err) {
			threw = err instanceof Error && err.message.includes('LEAKAGE_DETECTED');
		}
		expect(threw).toBe(true);
	});
});

describe('skill-opt candidates — deterministic draft', () => {
	it('drafts a candidate that appends an Optimization Notes section', () => {
		const inputs = makeInputs();
		const candidate = draftCandidate(inputs);
		expect(candidate.content).toContain('## Optimization Notes');
		expect(candidate.rollbackSnapshot).toBe(inputs.baselineContent);
		expect(candidate.diffSummary.changedLines).toBeGreaterThan(0);
	});

	it('drafts within the trust region by default', () => {
		const candidate = draftCandidate(makeInputs());
		expect(candidate.diffSummary.changedLines).toBeLessThanOrEqual(BASE_BUDGET.maxChangedLines);
	});
});
