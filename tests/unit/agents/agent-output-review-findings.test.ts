import { describe, expect, test } from 'bun:test';
import {
	extractFindingValidationsFromAgentOutput,
	extractMemoryProposalsFromAgentOutput,
	extractReviewFindingsFromAgentOutput,
} from '../../../src/agents/agent-output-schema';
import { createReviewerAgent } from '../../../src/agents/reviewer';

const VALID_FINDING = {
	title: 'Off-by-one drops the final record',
	body: 'The loop stops at length - 1, so the final record is never processed.',
	severity: 'high',
	confidence: 0.91,
	file: 'src/parser.ts',
	line_start: 42,
	line_end: 43,
} as const;

describe('structured reviewer findings', () => {
	test('extracts a strict bounded raw JSON payload', () => {
		const result = extractReviewFindingsFromAgentOutput(
			JSON.stringify({
				findings: [VALID_FINDING],
				verdict: 'REJECTED',
				overall_confidence: 0.88,
			}),
		);

		expect(result.error).toBeUndefined();
		expect(result.review).toEqual({
			findings: [VALID_FINDING],
			verdict: 'REJECTED',
			overall_confidence: 0.88,
		});
		expect(result.findings).toEqual([VALID_FINDING]);
	});

	test('coexists with a fenced memory proposal in the same output', () => {
		const output = [
			'```json',
			JSON.stringify({
				memoryProposals: [
					{
						operation: 'add',
						kind: 'repo_convention',
						text: 'Keep review findings diff-scoped.',
						rationale: 'Prevents pre-existing issues from entering a review.',
					},
				],
			}),
			'```',
			'```json',
			JSON.stringify({
				findings: [VALID_FINDING],
				verdict: 'REJECTED',
				overall_confidence: 0.9,
			}),
			'```',
		].join('\n');

		expect(extractReviewFindingsFromAgentOutput(output).findings).toEqual([
			VALID_FINDING,
		]);
		expect(
			extractMemoryProposalsFromAgentOutput(output).proposals,
		).toHaveLength(1);
	});

	test.each([
		['confidence above one', { ...VALID_FINDING, confidence: 1.01 }],
		['confidence below zero', { ...VALID_FINDING, confidence: -0.01 }],
		['invalid line range', { ...VALID_FINDING, line_start: 44, line_end: 43 }],
		['zero line number', { ...VALID_FINDING, line_start: 0 }],
		['unknown severity', { ...VALID_FINDING, severity: 'urgent' }],
		['unknown field', { ...VALID_FINDING, speculative: true }],
	])('rejects %s without throwing', (_label, finding) => {
		const result = extractReviewFindingsFromAgentOutput(
			JSON.stringify({
				findings: [finding],
				verdict: 'REJECTED',
				overall_confidence: 0.9,
			}),
		);

		expect(result.findings).toEqual([]);
		expect(result.review).toBeUndefined();
		expect(result.error).toBeString();
	});

	test('[review finding] rejects zero valid structured review blocks without throwing', () => {
		for (const output of [
			'```json\n{broken\n```',
			'```json\n{"memoryProposals":[]}\n```',
			'legacy prose only',
		]) {
			const result = extractReviewFindingsFromAgentOutput(output);
			expect(result.findings).toEqual([]);
			expect(result.review).toBeUndefined();
			expect(result.error).toContain(
				'expected exactly one valid structured findings block, found 0',
			);
		}
	});

	test('continues past an invalid relevant block to a later valid block', () => {
		const output = [
			'```json',
			'{"findings":"not-an-array"}',
			'```',
			'```json',
			JSON.stringify({
				findings: [VALID_FINDING],
				verdict: 'REJECTED',
				overall_confidence: 0.9,
			}),
			'```',
		].join('\n');
		expect(extractReviewFindingsFromAgentOutput(output).findings).toEqual([
			VALID_FINDING,
		]);
	});

	test('[review finding] rejects multiple valid structured review blocks', () => {
		const validBlock = [
			'```json',
			JSON.stringify({
				findings: [VALID_FINDING],
				verdict: 'REJECTED',
				overall_confidence: 0.9,
			}),
			'```',
		].join('\n');
		const result = extractReviewFindingsFromAgentOutput(
			`${validBlock}\n${validBlock}`,
		);
		expect(result.findings).toEqual([]);
		expect(result.review).toBeUndefined();
		expect(result.error).toBe(
			'expected exactly one valid structured findings block, found 2',
		);
	});

	test('bounds the number of findings in one response', () => {
		const result = extractReviewFindingsFromAgentOutput(
			JSON.stringify({
				findings: Array.from({ length: 51 }, () => VALID_FINDING),
				verdict: 'REJECTED',
				overall_confidence: 0.9,
			}),
		);
		expect(result.findings).toEqual([]);
		expect(result.error).toContain('Too big');
	});
});

describe('finding validation output', () => {
	test('extracts raw and fenced validator payloads', () => {
		const validation = {
			finding_id: 'a'.repeat(64),
			disposition: 'CONFIRMED',
			confidence: 0.97,
			evidence: 'src/parser.ts:42 reproduces the dropped final record.',
		} as const;
		for (const output of [
			JSON.stringify({ validations: [validation] }),
			`analysis\n\`\`\`json\n${JSON.stringify({ validations: [validation] })}\n\`\`\``,
		]) {
			const result = extractFindingValidationsFromAgentOutput(output);
			expect(result.error).toBeUndefined();
			expect(result.validations).toEqual([validation]);
		}
	});

	test('requires exactly one valid validator payload', () => {
		const validation = {
			finding_id: 'a'.repeat(64),
			disposition: 'CONFIRMED',
			confidence: 0.97,
			evidence: 'src/parser.ts:42 reproduces the dropped final record.',
		} as const;
		const payload = JSON.stringify({ validations: [validation] });
		const result = extractFindingValidationsFromAgentOutput(
			['```json', payload, '```', '```json', payload, '```'].join('\n'),
		);

		expect(result.validations).toEqual([]);
		expect(result.error).toBe(
			'expected exactly one valid structured validation block, found 2',
		);
		expect(
			extractFindingValidationsFromAgentOutput('no structured payload').error,
		).toBe('expected exactly one valid structured validation block, found 0');
	});

	test.each([
		[
			{
				finding_id: '',
				disposition: 'CONFIRMED',
				confidence: 0.9,
				evidence: 'x',
			},
		],
		[
			{
				finding_id: 'id',
				disposition: 'MAYBE',
				confidence: 0.9,
				evidence: 'x',
			},
		],
		[
			{
				finding_id: 'id',
				disposition: 'UNVERIFIED',
				confidence: 2,
				evidence: 'x',
			},
		],
		[
			{
				finding_id: 'id',
				disposition: 'DISPROVED',
				confidence: 0.9,
				evidence: '',
			},
		],
	])('rejects malformed validation objects fail-open', (validations) => {
		const result = extractFindingValidationsFromAgentOutput(
			JSON.stringify({ validations }),
		);
		expect(result.validations).toEqual([]);
		expect(result.error).toBeString();
	});

	test('bounds validation batch size', () => {
		const validation = {
			finding_id: 'id',
			disposition: 'UNVERIFIED',
			confidence: 0.5,
			evidence: 'Insufficient evidence.',
		};
		const result = extractFindingValidationsFromAgentOutput(
			JSON.stringify({
				validations: Array.from({ length: 51 }, () => validation),
			}),
		);
		expect(result.validations).toEqual([]);
		expect(result.error).toContain('Too big');
	});
});

describe('reviewer prompt structured-output contract', () => {
	test('keeps the legacy reviewer output contract when auto-review is disabled', () => {
		const prompt = createReviewerAgent('test-model').config.prompt;
		expect(prompt).toContain(
			'ISSUES: list with line numbers, grouped by CHECK dimension',
		);
		expect(prompt).toContain('Use INFO only inside ISSUES');
		expect(prompt).not.toContain('```json');
		expect(prompt).not.toContain('"confidence": 0.0');
		expect(prompt).not.toContain('prefer outputting no findings');
	});

	test('preserves legacy lines while requiring calibrated anti-speculative JSON', () => {
		const prompt = createReviewerAgent('test-model', undefined, undefined, true)
			.config.prompt;
		expect(prompt).toContain('VERDICT: APPROVED | REJECTED');
		expect(prompt).toContain('REUSE_RE_VERIFICATION:');
		expect(prompt).toContain('RISK: LOW | MEDIUM | HIGH | CRITICAL');
		expect(prompt).toContain('DIRECTIVE_COMPLIANCE:');
		expect(prompt).toContain('```json');
		expect(prompt).toContain('"confidence": 0.0');
		expect(prompt).toContain('"line_start": 1');
		expect(prompt).toContain('provably affected');
		expect(prompt).toContain('prefer outputting no findings');
	});
});
