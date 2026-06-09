import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	synthesizeCouncilVerdicts,
	synthesizeFinalCouncilAdvisory,
	synthesizePhaseCouncilAdvisory,
} from '../../../src/council/council-service';
import type {
	CouncilAgent,
	CouncilFinding,
	CouncilFindingSeverity,
	CouncilMemberVerdict,
} from '../../../src/council/types';

let tempDir: string;

beforeEach(() => {
	tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'blocking-concerns-')));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function makeVerdict(
	agent: CouncilAgent,
	verdict: 'APPROVE' | 'CONCERNS' | 'REJECT',
	findings: CouncilFinding[] = [],
): CouncilMemberVerdict {
	return {
		agent,
		verdict,
		confidence: 0.9,
		findings,
		criteriaAssessed: ['C1'],
		criteriaUnmet: verdict === 'REJECT' ? ['C1'] : [],
		durationMs: 1000,
	};
}

function makeFinding(
	severity: CouncilFindingSeverity,
	detail: string,
): CouncilFinding {
	return {
		severity,
		category: 'logic',
		location: 'src/test.ts:1',
		detail,
		evidence: 'test evidence',
	};
}

describe('blocking concerns promotion', () => {
	describe('synthesizePhaseCouncilAdvisory', () => {
		test('HIGH finding from CONCERNS member promoted to requiredFixes', () => {
			const verdicts = [
				makeVerdict('critic', 'CONCERNS', [
					makeFinding('HIGH', 'serious concern'),
				]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				1,
				'test phase',
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.overallVerdict).toBe('CONCERNS');
			expect(result.blockingConcernsCount).toBe(1);
			expect(result.requiredFixes).toHaveLength(1);
			expect(result.requiredFixes[0].detail).toBe('serious concern');
			expect(
				result.advisoryFindings.some((f) => f.detail === 'serious concern'),
			).toBe(false);
		});

		test('CRITICAL finding from CONCERNS member promoted to requiredFixes', () => {
			const verdicts = [
				makeVerdict('critic', 'CONCERNS', [
					makeFinding('CRITICAL', 'critical concern'),
				]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				1,
				'test phase',
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.overallVerdict).toBe('CONCERNS');
			expect(result.blockingConcernsCount).toBe(1);
			expect(result.requiredFixes).toHaveLength(1);
			expect(result.requiredFixes[0].severity).toBe('CRITICAL');
		});

		test('LOW/MEDIUM findings from CONCERNS member stay advisory', () => {
			const verdicts = [
				makeVerdict('critic', 'CONCERNS', [
					makeFinding('LOW', 'minor issue'),
					makeFinding('MEDIUM', 'moderate issue'),
				]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				1,
				'test phase',
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.overallVerdict).toBe('CONCERNS');
			expect(result.blockingConcernsCount).toBe(0);
			expect(result.requiredFixes).toHaveLength(0);
			expect(result.advisoryFindings).toHaveLength(2);
		});

		test('mixed severity from CONCERNS: only HIGH/CRITICAL promoted', () => {
			const verdicts = [
				makeVerdict('critic', 'CONCERNS', [
					makeFinding('HIGH', 'serious'),
					makeFinding('LOW', 'minor'),
					makeFinding('CRITICAL', 'critical'),
					makeFinding('MEDIUM', 'moderate'),
				]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				1,
				'test phase',
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.blockingConcernsCount).toBe(2);
			expect(result.requiredFixes).toHaveLength(2);
			expect(result.requiredFixes.map((f) => f.severity).sort()).toEqual([
				'CRITICAL',
				'HIGH',
			]);
			expect(result.advisoryFindings).toHaveLength(2);
			expect(result.advisoryFindings.map((f) => f.severity).sort()).toEqual([
				'LOW',
				'MEDIUM',
			]);
		});

		test('findings from REJECT member not double-promoted', () => {
			const verdicts = [
				makeVerdict('critic', 'REJECT', [makeFinding('HIGH', 'from rejector')]),
				makeVerdict('reviewer', 'CONCERNS', [
					makeFinding('HIGH', 'from concerns member'),
				]),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				1,
				'test phase',
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.overallVerdict).toBe('REJECT');
			expect(result.blockingConcernsCount).toBe(1);
			const reqDetails = result.requiredFixes.map((f) => f.detail);
			expect(reqDetails).toContain('from rejector');
			expect(reqDetails).toContain('from concerns member');
		});

		test('BLOCKING CONCERNS banner appears in unifiedFeedbackMd', () => {
			const verdicts = [
				makeVerdict('critic', 'CONCERNS', [makeFinding('HIGH', 'must fix')]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				1,
				'test phase',
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.unifiedFeedbackMd).toContain('BLOCKING CONCERNS');
			expect(result.unifiedFeedbackMd).toContain('1 HIGH/CRITICAL');
		});

		test('no banner when blockingConcernsCount is 0', () => {
			const verdicts = [
				makeVerdict('critic', 'CONCERNS', [makeFinding('LOW', 'minor')]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizePhaseCouncilAdvisory(
				1,
				'test phase',
				verdicts,
				1,
				{},
				tempDir,
			);

			expect(result.unifiedFeedbackMd).not.toContain('BLOCKING CONCERNS');
		});
	});

	describe('synthesizeCouncilVerdicts', () => {
		test('HIGH finding from CONCERNS member promoted to requiredFixes', () => {
			const verdicts = [
				makeVerdict('critic', 'CONCERNS', [
					makeFinding('HIGH', 'serious concern'),
				]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizeCouncilVerdicts(
				'task-1',
				'swarm-1',
				verdicts,
				null,
				1,
				{},
			);

			expect(result.overallVerdict).toBe('CONCERNS');
			expect(result.blockingConcernsCount).toBe(1);
			expect(result.requiredFixes).toHaveLength(1);
			expect(result.requiredFixes[0].detail).toBe('serious concern');
		});

		test('CRITICAL severity accepted in findings', () => {
			const verdicts = [
				makeVerdict('critic', 'REJECT', [
					makeFinding('CRITICAL', 'critical bug'),
				]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizeCouncilVerdicts(
				'task-1',
				'swarm-1',
				verdicts,
				null,
				1,
				{},
			);

			expect(result.overallVerdict).toBe('REJECT');
			expect(result.requiredFixes).toHaveLength(1);
			expect(result.requiredFixes[0].severity).toBe('CRITICAL');
		});

		test('BLOCKING CONCERNS banner in unifiedFeedbackMd', () => {
			const verdicts = [
				makeVerdict('critic', 'CONCERNS', [
					makeFinding('CRITICAL', 'critical concern'),
				]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizeCouncilVerdicts(
				'task-1',
				'swarm-1',
				verdicts,
				null,
				1,
				{},
			);

			expect(result.unifiedFeedbackMd).toContain('BLOCKING CONCERNS');
			expect(result.blockingConcernsCount).toBe(1);
		});
	});

	describe('synthesizeFinalCouncilAdvisory', () => {
		test('HIGH finding from CONCERNS member promoted to requiredFixes', () => {
			const verdicts = [
				makeVerdict('critic', 'CONCERNS', [
					makeFinding('HIGH', 'serious concern'),
				]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizeFinalCouncilAdvisory(
				'project summary',
				verdicts,
				1,
				{},
			);

			expect(result.overallVerdict).toBe('CONCERNS');
			expect(result.blockingConcernsCount).toBe(1);
			expect(result.requiredFixes).toHaveLength(1);
		});

		test('BLOCKING CONCERNS banner in unifiedFeedbackMd', () => {
			const verdicts = [
				makeVerdict('critic', 'CONCERNS', [
					makeFinding('CRITICAL', 'critical concern'),
					makeFinding('LOW', 'minor thing'),
				]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizeFinalCouncilAdvisory(
				'project summary',
				verdicts,
				1,
				{},
			);

			expect(result.unifiedFeedbackMd).toContain('BLOCKING CONCERNS');
			expect(result.unifiedFeedbackMd).toContain('project close');
			expect(result.blockingConcernsCount).toBe(1);
			expect(result.requiredFixes).toHaveLength(1);
			expect(
				result.advisoryFindings.some((f) => f.detail === 'minor thing'),
			).toBe(true);
		});

		test('no promotion when only LOW/MEDIUM concerns', () => {
			const verdicts = [
				makeVerdict('critic', 'CONCERNS', [
					makeFinding('MEDIUM', 'moderate'),
					makeFinding('LOW', 'minor'),
				]),
				makeVerdict('reviewer', 'APPROVE'),
				makeVerdict('sme', 'APPROVE'),
			];

			const result = synthesizeFinalCouncilAdvisory(
				'project summary',
				verdicts,
				1,
				{},
			);

			expect(result.blockingConcernsCount).toBe(0);
			expect(result.requiredFixes).toHaveLength(0);
			expect(result.advisoryFindings).toHaveLength(2);
			expect(result.unifiedFeedbackMd).not.toContain('BLOCKING CONCERNS');
		});
	});
});
