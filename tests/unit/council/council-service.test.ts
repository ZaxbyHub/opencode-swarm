import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synthesizePhaseCouncilAdvisory } from '../../../src/council/council-service';
import type {
	CouncilAgent,
	CouncilFinding,
	CouncilMemberVerdict,
} from '../../../src/council/types';

let tempDir: string;

const PHASE_NUMBER = 1;
const PHASE_SUMMARY = 'Test phase summary';

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'council-service-test-'));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function makeVerdict(
	agent: CouncilAgent,
	verdict: 'APPROVE' | 'CONCERNS' | 'REJECT',
	findings: CouncilFinding[] = [],
	criteriaAssessed: string[] = [],
	criteriaUnmet: string[] = [],
): CouncilMemberVerdict {
	return {
		agent,
		verdict,
		confidence: 0.9,
		findings,
		criteriaAssessed,
		criteriaUnmet,
		durationMs: 1000,
	};
}

function makeFinding(
	severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW',
	location: string,
	detail: string,
): CouncilFinding {
	return {
		severity,
		category: 'logic',
		location,
		detail,
		evidence: 'test evidence',
	};
}

describe('synthesizePhaseCouncilAdvisory', () => {
	describe('verdict synthesis', () => {
		test('all APPROVE → overallVerdict APPROVE, requiredFixes empty', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'APPROVE'),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.overallVerdict).toBe('APPROVE');
			expect(result.requiredFixes).toEqual([]);
			expect(result.vetoedBy).toBeNull();
			expect(result.quorumSize).toBe(3);
		});

		test('single REJECT with vetoPriority=true → overallVerdict REJECT', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'REJECT', [
					makeFinding('HIGH', 'src/file.ts:10', 'Critical bug'),
				]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				1,
				{ vetoPriority: true },
				tempDir,
			);

			expect(result.overallVerdict).toBe('REJECT');
			expect(result.vetoedBy).toEqual(['critic']);
			expect(result.requiredFixes).toHaveLength(1);
			expect(result.requiredFixes[0].severity).toBe('HIGH');
		});

		test('single REJECT with vetoPriority=false → overallVerdict CONCERNS', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'REJECT', [
					makeFinding('HIGH', 'src/file.ts:10', 'Critical bug'),
				]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				1,
				{ vetoPriority: false },
				tempDir,
			);

			expect(result.overallVerdict).toBe('CONCERNS');
			expect(result.vetoedBy).toEqual(['critic']);
		});

		test('CONCERNS present without REJECT → overallVerdict CONCERNS', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'CONCERNS', [
					makeFinding('LOW', 'src/file.ts:10', 'Minor issue'),
				]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.overallVerdict).toBe('CONCERNS');
			expect(result.vetoedBy).toBeNull();
		});

		test('mixed CONCERNS + APPROVE → overallVerdict CONCERNS', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'CONCERNS', [
					makeFinding('MEDIUM', 'src/util.ts:5', 'Could be optimized'),
				]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.overallVerdict).toBe('CONCERNS');
		});

		test('multiple REJECTs from different members → vetoedBy contains all rejecting', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'REJECT', [
					makeFinding('HIGH', 'src/a.ts:1', 'Bug A'),
				]),
				makeVerdict('reviewer', 'REJECT', [
					makeFinding('MEDIUM', 'src/b.ts:2', 'Bug B'),
				]),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				1,
				{ vetoPriority: true },
				tempDir,
			);

			expect(result.overallVerdict).toBe('REJECT');
			expect(result.vetoedBy).toContain('critic');
			expect(result.vetoedBy).toContain('reviewer');
			expect(result.requiredFixes).toHaveLength(2);
		});
	});

	describe('quorum handling', () => {
		test('quorum < 3 → advisory note added', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'APPROVE'),
				makeVerdict('reviewer', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.quorumSize).toBe(2);
			expect(result.advisoryNotes.some((n) => n.includes('quorum'))).toBeTrue();
		});

		test('quorum = 3 → no quorum advisory note', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'APPROVE'),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.quorumSize).toBe(3);
			expect(
				result.advisoryNotes.some((n) => n.includes('quorum')),
			).toBeFalse();
		});

		test('empty verdicts array → graceful handling', () => {
			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				[],
				1,
				{},
				tempDir,
			);

			expect(result.quorumSize).toBe(0);
			expect(result.advisoryNotes.some((n) => n.includes('quorum'))).toBeTrue();
		});
	});

	describe('finding classification', () => {
		test('HIGH severity from rejecting member → requiredFixes', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'REJECT', [
					makeFinding('HIGH', 'src/bug.ts:1', 'Critical bug'),
					makeFinding('LOW', 'src/style.ts:2', 'Style issue'),
				]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.requiredFixes).toHaveLength(1);
			expect(result.requiredFixes[0].severity).toBe('HIGH');
			expect(
				result.advisoryFindings.some((f) => f.severity === 'LOW'),
			).toBeTrue();
		});

		test('MEDIUM severity from rejecting member → requiredFixes', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'REJECT', [
					makeFinding('MEDIUM', 'src/issue.ts:5', 'Medium priority'),
				]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.requiredFixes).toHaveLength(1);
			expect(result.requiredFixes[0].severity).toBe('MEDIUM');
		});

		test('LOW severity from rejecting member → advisoryFindings only', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'REJECT', [
					makeFinding('LOW', 'src/style.ts:1', 'Minor style'),
				]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.requiredFixes).toHaveLength(0);
			expect(result.advisoryFindings).toHaveLength(1);
			expect(result.advisoryFindings[0].severity).toBe('LOW');
		});

		test('findings from non-rejecting members → advisoryFindings', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'APPROVE', [
					makeFinding('MEDIUM', 'src/advisory.ts:1', 'Consider this'),
				]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(
				result.advisoryFindings.some((f) => f.detail === 'Consider this'),
			).toBeTrue();
		});
	});

	describe('conflict detection', () => {
		test('contradictory findings at same location → unresolvedConflicts', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'CONCERNS', [
					makeFinding(
						'HIGH',
						'src/conflict.ts:1',
						'Add validation for this input',
					),
				]),
				makeVerdict('reviewer', 'CONCERNS', [
					makeFinding(
						'HIGH',
						'src/conflict.ts:1',
						'Remove validation for this input',
					),
				]),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.unresolvedConflicts.length).toBeGreaterThan(0);
			expect(result.unresolvedConflicts[0]).toContain('Conflict at');
		});
	});

	describe('return value', () => {
		test('return value has correct schema for APPROVE verdict', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'APPROVE'),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				1,
				{},
			);

			expect(result.overallVerdict).toBe('APPROVE');
			expect(result.quorumSize).toBe(3);
			expect(result.phaseNumber).toBe(PHASE_NUMBER);
			expect(result.scope).toBe('phase');
			expect(result.timestamp).toBeDefined();
			expect(typeof result.timestamp).toBe('string');
			expect(result.vetoedBy).toBeNull();
		});

		test('return value contains requiredFixes when present', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'REJECT', [
					makeFinding('HIGH', 'src/bug.ts:1', 'Critical bug'),
				]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				1,
				{},
			);

			expect(result.requiredFixes).toBeDefined();
			expect(result.requiredFixes.length).toBe(1);
			expect(result.requiredFixes[0].severity).toBe('HIGH');
			expect(result.requiredFixes[0].location).toBe('src/bug.ts:1');
		});

		test('return value contains advisoryNotes with quorum warning', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'APPROVE'),
				makeVerdict('reviewer', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				1,
				{},
			);

			expect(result.advisoryNotes).toBeDefined();
			expect(Array.isArray(result.advisoryNotes)).toBeTrue();
			expect(result.advisoryNotes.some((n) => n.includes('quorum'))).toBeTrue();
		});
	});

	describe('unifiedFeedbackMd generation', () => {
		test('APPROVE verdict generates approval message', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'APPROVE'),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.unifiedFeedbackMd).toContain('APPROVE');
			expect(result.unifiedFeedbackMd).toContain('Phase Council Review');
		});

		test('REJECT verdict generates blocking message with required fixes', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'REJECT', [
					makeFinding('HIGH', 'src/bug.ts:1', 'Critical bug'),
				]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.unifiedFeedbackMd).toContain('REJECT');
			expect(result.unifiedFeedbackMd).toContain('BLOCKED');
			expect(result.unifiedFeedbackMd).toContain('Required Fixes');
		});

		test('round number is included in feedback', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'APPROVE'),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				2,
				{ maxRounds: 3 },
				tempDir,
			);

			expect(result.unifiedFeedbackMd).toContain('Round 2/3');
		});
	});

	describe('phase number and summary', () => {
		test('returned phaseNumber matches input', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'APPROVE'),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				5,
				'Phase 5 summary',
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.phaseNumber).toBe(5);
			expect(result.phaseSummary).toBe('Phase 5 summary');
		});

		test('empty phase summary is handled', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'APPROVE'),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				'',
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.phaseSummary).toBe('');
		});
	});

	describe('advisory notes generation', () => {
		test('advisory findings generate advisory notes', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'CONCERNS', [
					makeFinding('LOW', 'src/style.ts:1', 'Minor style issue'),
				]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.advisoryNotes.length).toBeGreaterThan(0);
			expect(result.advisoryNotes[0]).toContain('advisory finding');
		});
	});

	describe('allCriteriaMet for phase council', () => {
		test('no unmet criteria and non-empty verdicts → allCriteriaMet true', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'APPROVE', [], ['C1', 'C2'], []),
				makeVerdict('reviewer', 'APPROVE', [], ['C1', 'C2'], []),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.allCriteriaMet).toBeTrue();
		});

		test('some unmet criteria → allCriteriaMet false', () => {
			const verdicts: CouncilMemberVerdict[] = [
				makeVerdict('critic', 'APPROVE', [], ['C1'], []),
				makeVerdict('reviewer', 'CONCERNS', [], ['C1'], ['C2']),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				PHASE_NUMBER,
				PHASE_SUMMARY,
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.allCriteriaMet).toBeFalse();
		});
	});
});
