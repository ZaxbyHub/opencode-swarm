import { describe, expect, it } from 'bun:test';
import { createReviewerAgent } from './reviewer';

describe('REVIEWER_PROMPT — REUSE_RE_VERIFICATION in verdict format', () => {
	const agent = createReviewerAgent('test-model');
	const prompt = agent.config.prompt ?? '';

	it('appears in the VERDICT FORMAT section', () => {
		expect(prompt).toContain('REUSE_RE_VERIFICATION');
	});

	it('appears in the OUTPUT FORMAT section', () => {
		const outputFormatIndex = prompt.indexOf('## OUTPUT FORMAT');
		const reuseFieldInOutput = prompt.indexOf(
			'REUSE_RE_VERIFICATION:',
			outputFormatIndex,
		);
		expect(reuseFieldInOutput).toBeGreaterThan(outputFormatIndex);
	});

	it('is positioned after VERDICT in OUTPUT FORMAT', () => {
		const outputFormatIndex = prompt.indexOf('## OUTPUT FORMAT');
		const verdictIndex = prompt.indexOf('VERDICT:', outputFormatIndex);
		const reuseIndex = prompt.indexOf(
			'REUSE_RE_VERIFICATION:',
			outputFormatIndex,
		);
		expect(reuseIndex).toBeGreaterThan(verdictIndex);
		const riskIndex = prompt.indexOf('RISK:', outputFormatIndex);
		expect(riskIndex).toBeGreaterThan(reuseIndex);
	});

	it('APPROVED-path REUSE_RE_VERIFICATION only allows VERIFIED | SKIPPED (not DUPLICATION_DETECTED)', () => {
		const verdictFormatIndex = prompt.indexOf('VERDICT FORMAT:');
		const approvedSection = prompt.substring(
			verdictFormatIndex,
			prompt.indexOf('REJECTED:', verdictFormatIndex),
		);
		expect(approvedSection).toContain(
			'REUSE_RE_VERIFICATION: [VERIFIED | SKIPPED]',
		);
		expect(approvedSection).not.toContain('DUPLICATION_DETECTED');
	});

	it('REJECTED-path REUSE_RE_VERIFICATION includes DUPLICATION_DETECTED', () => {
		const rejectedStart = prompt.indexOf('REJECTED:');
		const rejectedEnd = prompt.indexOf('\n\n', rejectedStart);
		const rejectedSection = prompt.substring(
			rejectedStart,
			rejectedEnd > 0 ? rejectedEnd : rejectedStart + 200,
		);
		expect(rejectedSection).toContain('DUPLICATION_DETECTED');
	});

	it('OUTPUT FORMAT clarifies DUPLICATION_DETECTED is only valid with REJECTED', () => {
		const outputFormatIndex = prompt.indexOf('## OUTPUT FORMAT');
		const outputSection = prompt.substring(
			outputFormatIndex,
			outputFormatIndex + 500,
		);
		expect(outputSection).toContain(
			'DUPLICATION_DETECTED is only valid when VERDICT is REJECTED',
		);
	});
});

describe('REVIEWER_PROMPT — REUSE RE-VERIFICATION', () => {
	const agent = createReviewerAgent('test-model');
	const prompt = agent.config.prompt ?? '';

	it('contains the REUSE RE-VERIFICATION section', () => {
		expect(prompt).toContain(
			'## REUSE RE-VERIFICATION (MANDATORY FOR NEW EXPORTS)',
		);
	});

	it('specifies 3+ search queries per export', () => {
		expect(prompt).toContain('AT LEAST 3 different search queries');
	});

	it('specifies DUPLICATION_DETECTED causes immediate REJECT at Tier 1', () => {
		expect(prompt).toContain('DUPLICATION_DETECTED');
		expect(prompt).toContain('Tier 1 CORRECTNESS failure');
		expect(prompt).toContain('REJECT immediately');
	});

	it('specifies skip when EXPORTS_ADDED is none', () => {
		expect(prompt).toContain('SKIPPED (no new exports)');
	});

	it('is positioned after EXPLORER FINDINGS section', () => {
		const explorerIndex = prompt.indexOf('## EXPLORER FINDINGS');
		const reuseIndex = prompt.indexOf(
			'## REUSE RE-VERIFICATION (MANDATORY FOR NEW EXPORTS)',
		);
		expect(reuseIndex).toBeGreaterThan(explorerIndex);
	});

	it('is positioned before REVIEW REASONING section', () => {
		const reuseIndex = prompt.indexOf(
			'## REUSE RE-VERIFICATION (MANDATORY FOR NEW EXPORTS)',
		);
		const reviewIndex = prompt.indexOf('## REVIEW REASONING');
		expect(reviewIndex).toBeGreaterThan(reuseIndex);
	});

	it('does not modify EXPLORER FINDINGS content', () => {
		expect(prompt).toContain('Explorer agent outputs (from @mega_explorer)');
	});

	it('does not modify REVIEW REASONING content', () => {
		expect(prompt).toContain(
			'PRECONDITIONS: What must be true for this code to work correctly?',
		);
	});
});
