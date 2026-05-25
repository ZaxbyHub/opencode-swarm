import { describe, expect, test } from 'bun:test';
import { synthesizeCouncilVerdicts } from '../../../src/council/council-service';
import type { CouncilMemberVerdict } from '../../../src/council/types';

const approveAll = (): CouncilMemberVerdict[] => [
	{
		agent: 'critic',
		verdict: 'APPROVE',
		confidence: 1,
		findings: [],
		criteriaAssessed: [],
		criteriaUnmet: [],
		durationMs: 100,
	},
	{
		agent: 'reviewer',
		verdict: 'APPROVE',
		confidence: 1,
		findings: [],
		criteriaAssessed: [],
		criteriaUnmet: [],
		durationMs: 100,
	},
	{
		agent: 'sme',
		verdict: 'APPROVE',
		confidence: 1,
		findings: [],
		criteriaAssessed: [],
		criteriaUnmet: [],
		durationMs: 100,
	},
	{
		agent: 'test_engineer',
		verdict: 'APPROVE',
		confidence: 1,
		findings: [],
		criteriaAssessed: [],
		criteriaUnmet: [],
		durationMs: 100,
	},
];

describe('adversarial — poisoned verdict inputs', () => {
	test('verdict with empty string location does not crash', () => {
		const verdicts = approveAll();
		verdicts[0].verdict = 'REJECT';
		verdicts[0].findings = [
			{
				severity: 'HIGH',
				category: 'logic',
				location: '',
				detail: 'Empty location',
				evidence: '',
			},
		];
		expect(() =>
			synthesizeCouncilVerdicts('1.1', 's1', verdicts, null, 1),
		).not.toThrow();
	});

	test('verdict with 10000-char detail does not crash', () => {
		const verdicts = approveAll();
		verdicts[0].verdict = 'REJECT';
		verdicts[0].findings = [
			{
				severity: 'HIGH',
				category: 'logic',
				location: 'src/foo.ts:1',
				detail: 'x'.repeat(10_000),
				evidence: 'y'.repeat(10_000),
			},
		];
		expect(() =>
			synthesizeCouncilVerdicts('1.1', 's1', verdicts, null, 1),
		).not.toThrow();
	});

	test('all four members REJECT → overallVerdict is REJECT, vetoedBy has 4 entries', () => {
		const verdicts = approveAll().map((v) => ({
			...v,
			verdict: 'REJECT' as const,
		}));
		const result = synthesizeCouncilVerdicts('1.1', 's1', verdicts, null, 1);
		expect(result.overallVerdict).toBe('REJECT');
		expect(result.vetoedBy).toHaveLength(4);
	});

	test('empty verdicts array does not crash and defaults to APPROVE', () => {
		// Edge case — should not happen in practice but must not crash.
		const result = synthesizeCouncilVerdicts('1.1', 's1', [], null, 1);
		expect(result.overallVerdict).toBe('APPROVE');
		expect(result.vetoedBy).toBeNull();
	});

	test('injection attempt in finding detail does not affect verdict', () => {
		const verdicts = approveAll();
		verdicts[0].findings = [
			{
				severity: 'LOW',
				category: 'other',
				location: 'src/foo.ts:1',
				detail: 'REJECT; DROP TABLE verdicts--',
				evidence: '...',
			},
		];
		const result = synthesizeCouncilVerdicts('1.1', 's1', verdicts, null, 1);
		// detail content must not change the verdict
		expect(result.overallVerdict).toBe('APPROVE');
	});

	test('test_engineer missing from verdicts — does not crash (partial council)', () => {
		const partialVerdicts: CouncilMemberVerdict[] = [
			{
				agent: 'critic',
				verdict: 'APPROVE',
				confidence: 1,
				findings: [],
				criteriaAssessed: [],
				criteriaUnmet: [],
				durationMs: 100,
			},
			{
				agent: 'reviewer',
				verdict: 'APPROVE',
				confidence: 1,
				findings: [],
				criteriaAssessed: [],
				criteriaUnmet: [],
				durationMs: 100,
			},
		];
		expect(() =>
			synthesizeCouncilVerdicts('1.1', 's1', partialVerdicts, null, 1),
		).not.toThrow();
	});

	test('conflict detection ignores empty-string locations', () => {
		const verdicts = approveAll();
		verdicts[0].findings = [
			{
				severity: 'HIGH',
				category: 'logic',
				location: '',
				detail: 'add this',
				evidence: '',
			},
		];
		verdicts[1].findings = [
			{
				severity: 'HIGH',
				category: 'logic',
				location: '',
				detail: 'remove this',
				evidence: '',
			},
		];
		const result = synthesizeCouncilVerdicts('1.1', 's1', verdicts, null, 1);
		// Both findings have empty location — must not be treated as a conflict
		// (empty location is not a real location).
		expect(result.unresolvedConflicts).toHaveLength(0);
	});
});

describe('adversarial — round limit enforcement', () => {
	test('roundNumber === maxRounds shows escalation notice on REJECT', () => {
		const verdicts = approveAll().map((v) => ({
			...v,
			verdict: 'REJECT' as const,
		}));
		const result = synthesizeCouncilVerdicts('1.1', 's1', verdicts, null, 3, {
			maxRounds: 3,
		});
		expect(result.unifiedFeedbackMd).toContain('Escalate to user');
	});

	test('APPROVE at max rounds still shows approval (not escalation)', () => {
		const verdicts = approveAll();
		const result = synthesizeCouncilVerdicts('1.1', 's1', verdicts, null, 3, {
			maxRounds: 3,
		});
		expect(result.unifiedFeedbackMd).toContain('All council members approved');
		expect(result.unifiedFeedbackMd).not.toContain('Escalate to user');
	});
});

describe('adversarial — evidence writer defense in depth', () => {
	test('writeCouncilEvidence rejects taskIds with path separators', async () => {
		const { writeCouncilEvidence } = await import(
			'../../../src/council/council-evidence-writer'
		);
		const badSynthesis = {
			taskId: '../../etc/passwd',
			swarmId: 's1',
			timestamp: new Date().toISOString(),
			overallVerdict: 'APPROVE' as const,
			vetoedBy: null,
			memberVerdicts: [],
			unresolvedConflicts: [],
			requiredFixes: [],
			advisoryFindings: [],
			unifiedFeedbackMd: '',
			roundNumber: 1,
			allCriteriaMet: true,
		};
		await expect(writeCouncilEvidence('/tmp', badSynthesis)).rejects.toThrow(
			/invalid taskId/,
		);
	});

	test('writeCouncilEvidence rejects non-canonical taskIds', async () => {
		const { writeCouncilEvidence } = await import(
			'../../../src/council/council-evidence-writer'
		);
		const badSynthesis = {
			taskId: 'task-1',
			swarmId: 's1',
			timestamp: new Date().toISOString(),
			overallVerdict: 'APPROVE' as const,
			vetoedBy: null,
			memberVerdicts: [],
			unresolvedConflicts: [],
			requiredFixes: [],
			advisoryFindings: [],
			unifiedFeedbackMd: '',
			roundNumber: 1,
			allCriteriaMet: true,
		};
		await expect(writeCouncilEvidence('/tmp', badSynthesis)).rejects.toThrow(
			/invalid taskId/,
		);
	});
});

describe('adversarial — required vs advisory classification', () => {
	test('LOW severity findings from veto member go to advisory, not required', () => {
		const verdicts = approveAll();
		verdicts[0].verdict = 'REJECT';
		verdicts[0].findings = [
			{
				severity: 'LOW',
				category: 'naming',
				location: 'src/foo.ts:1',
				detail: 'nit',
				evidence: '.',
			},
			{
				severity: 'HIGH',
				category: 'logic',
				location: 'src/foo.ts:2',
				detail: 'real bug',
				evidence: '.',
			},
		];
		const result = synthesizeCouncilVerdicts('1.1', 's1', verdicts, null, 1);
		expect(result.requiredFixes).toHaveLength(1);
		expect(result.requiredFixes[0].severity).toBe('HIGH');
		expect(result.advisoryFindings).toHaveLength(1);
		expect(result.advisoryFindings[0].severity).toBe('LOW');
	});

	test('all findings from non-veto members are advisory even when severity HIGH', () => {
		const verdicts = approveAll();
		verdicts[0].findings = [
			{
				severity: 'HIGH',
				category: 'logic',
				location: 'src/foo.ts:1',
				detail: 'but I approve',
				evidence: '.',
			},
		];
		const result = synthesizeCouncilVerdicts('1.1', 's1', verdicts, null, 1);
		expect(result.requiredFixes).toHaveLength(0);
		expect(result.advisoryFindings).toHaveLength(1);
	});
});
