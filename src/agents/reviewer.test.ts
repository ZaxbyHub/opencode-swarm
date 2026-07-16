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

describe('REVIEWER_PROMPT — ACCEPTANCE field (issue #1687 task 2.2)', () => {
	const agent = createReviewerAgent('test-model');
	const prompt = agent.config.prompt ?? '';

	it('INPUT FORMAT includes an ACCEPTANCE field', () => {
		expect(prompt).toContain('ACCEPTANCE:');
	});

	it('ACCEPTANCE field is positioned after GATES, before SKILLS, in INPUT FORMAT', () => {
		const inputFormatIndex = prompt.indexOf('## INPUT FORMAT');
		const gatesIndex = prompt.indexOf(
			'GATES: [pre-completed gate results',
			inputFormatIndex,
		);
		const acceptanceIndex = prompt.indexOf('ACCEPTANCE:', gatesIndex);
		const skillsIndex = prompt.indexOf('SKILLS: [optional', acceptanceIndex);
		expect(gatesIndex).toBeGreaterThan(inputFormatIndex);
		expect(acceptanceIndex).toBeGreaterThan(gatesIndex);
		expect(skillsIndex).toBeGreaterThan(acceptanceIndex);
	});

	it('documents verbatim/byte-for-byte FR text requirement, not paraphrase', () => {
		expect(prompt).toContain('byte-for-byte');
		expect(prompt).toContain('never a paraphrase or summary');
	});

	it('documents ACCEPTANCE is never empty even without a spec mapping', () => {
		expect(prompt).toContain('This field is never empty.');
	});

	it('ACCEPTANCE HANDLING guidance treats ACCEPTANCE as authoritative and requires REJECT on unmet items', () => {
		expect(prompt).toContain('ACCEPTANCE HANDLING');
		expect(prompt).toContain('authoritative definition of "done"');
		expect(prompt).toContain('Tier 1 CORRECTNESS failure');
	});

	it('TIER 1: CORRECTNESS explicitly requires checking the diff against ACCEPTANCE, not just correctness-in-isolation', () => {
		const tier1Index = prompt.indexOf('TIER 1: CORRECTNESS');
		const tier2Index = prompt.indexOf('TIER 2: SAFETY');
		const tier1Section = prompt.substring(tier1Index, tier2Index);
		expect(tier1Section).toContain('ACCEPTANCE field');
		expect(tier1Section).toContain(
			'not merely that the diff is well-formed or plausible in isolation',
		);
	});

	it('OUTPUT FORMAT includes an ACCEPTANCE_SATISFACTION field distinct from general correctness', () => {
		const outputFormatIndex = prompt.indexOf('## OUTPUT FORMAT');
		const acceptanceSatisfactionIndex = prompt.indexOf(
			'ACCEPTANCE_SATISFACTION:',
			outputFormatIndex,
		);
		expect(acceptanceSatisfactionIndex).toBeGreaterThan(outputFormatIndex);
		const verdictIndex = prompt.indexOf('VERDICT:', outputFormatIndex);
		expect(acceptanceSatisfactionIndex).toBeGreaterThan(verdictIndex);
		expect(prompt).toContain(
			'This is a distinct question from "does the diff look correct"',
		);
		expect(prompt).toContain(
			'NOT_SATISFIED on any item forces VERDICT: REJECTED',
		);
	});
});
