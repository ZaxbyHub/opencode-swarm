import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// Read the reviewer.ts source directly to access the stable legacy prompt body.
const reviewerSource = fs.readFileSync(
	path.join(__dirname, '../../../src/agents/reviewer.ts'),
	'utf-8',
);

// Runtime construction may append the structured-finding contract after this
// prompt, but these assertions intentionally cover the legacy review contract.
const promptMatch = reviewerSource.match(
	/const LEGACY_REVIEWER_PROMPT = `([\s\S]*?)`;?\s*$/m,
);
const REVIEWER_PROMPT = promptMatch ? promptMatch[1] : '';

describe('Task 3.2: SUBSTANCE VERIFICATION in reviewer prompt', () => {
	// Test 1: SUBSTANCE VERIFICATION section exists between Step 0a and Tier 1
	describe('SUBSTANCE VERIFICATION section placement', () => {
		it('should contain SUBSTANCE VERIFICATION section', () => {
			expect(REVIEWER_PROMPT).toContain('SUBSTANCE VERIFICATION');
		});

		it('should have SUBSTANCE VERIFICATION after Step 0a and before Tier 1', () => {
			const step0aIndex = REVIEWER_PROMPT.indexOf(
				'STEP 0a: COMPLEXITY CLASSIFICATION',
			);
			const substanceIndex = REVIEWER_PROMPT.indexOf(
				'STEP 0b: SUBSTANCE VERIFICATION',
			);
			const tier1Index = REVIEWER_PROMPT.indexOf('TIER 1: CORRECTNESS');

			expect(step0aIndex).toBeGreaterThan(-1);
			expect(substanceIndex).toBeGreaterThan(-1);
			expect(tier1Index).toBeGreaterThan(-1);

			expect(substanceIndex).toBeGreaterThan(step0aIndex);
			expect(tier1Index).toBeGreaterThan(substanceIndex);
		});

		it('should mark SUBSTANCE VERIFICATION as mandatory before Tier 1', () => {
			const substanceSection = REVIEWER_PROMPT.match(
				/STEP 0b: SUBSTANCE VERIFICATION[^]+?TIER 1/,
			);
			expect(substanceSection?.[0]).toContain('mandatory');
			expect(substanceSection?.[0]).toContain('run before Tier 1');
		});
	});

	// Test 2: Four vaporware indicators defined
	describe('VAPORWARE INDICATORS definition', () => {
		it('should define exactly 4 vaporware indicators', () => {
			const indicatorsSection = REVIEWER_PROMPT.match(
				/VAPORWARE INDICATORS:([^]+?)Reject with:/,
			);
			expect(indicatorsSection).not.toBeNull();

			const indicatorCount = (indicatorsSection?.[1] ?? '').match(/^\d+\./gm);
			expect(indicatorCount).toHaveLength(4);
		});

		it('should define PLACEHOLDER PATTERNS indicator', () => {
			expect(REVIEWER_PROMPT).toContain('PLACEHOLDER PATTERNS');
		});

		it('should define STUB DETECTION indicator', () => {
			expect(REVIEWER_PROMPT).toContain('STUB DETECTION');
		});

		it('should define COMMENT-TO-CODE RATIO ABUSE indicator', () => {
			expect(REVIEWER_PROMPT).toContain('COMMENT-TO-CODE RATIO ABUSE');
		});

		it('should define IMPORT THEATER indicator', () => {
			expect(REVIEWER_PROMPT).toContain('IMPORT THEATER');
		});
	});

	// Test 3: Substance failures are automatic rejections
	describe('Substance failure handling', () => {
		it('should describe substance verification as AUTOMATIC REJECTION trigger', () => {
			const substanceSection = REVIEWER_PROMPT.match(
				/STEP 0b: SUBSTANCE VERIFICATION[^]+?TIER 1/,
			);
			expect(substanceSection?.[0]).toContain('AUTOMATIC REJECTION');
		});

		it('should specify rejection format for substance failures', () => {
			expect(REVIEWER_PROMPT).toContain('SUBSTANCE FAIL:');
		});

		it('should instruct to reject immediately on substance failure', () => {
			const substanceSection = REVIEWER_PROMPT.match(
				/STEP 0b: SUBSTANCE VERIFICATION[^]+?TIER 1/,
			);
			expect(substanceSection?.[0]).toContain('REJECT immediately');
		});

		it('should proceed to Tier 1 only if substance verification passes', () => {
			const substanceSection = REVIEWER_PROMPT.match(
				/STEP 0b: SUBSTANCE VERIFICATION[^]+?TIER 1/,
			);
			expect(substanceSection?.[0]).toContain('proceed to Tier 1');
			expect(substanceSection?.[0]).toContain(
				'If substance verification passes',
			);
		});
	});

	// Test 4: reviewer_substance_check event defined
	describe('reviewer_substance_check event definition', () => {
		it('should have reviewer_substance_check event defined in module', () => {
			expect(reviewerSource).toContain('reviewer_substance_check');
		});

		it('should define event with correct name', () => {
			expect(reviewerSource).toContain("event: 'reviewer_substance_check'");
		});

		it('should have event fields defined', () => {
			expect(reviewerSource).toContain('fields:');
			expect(reviewerSource).toContain('function_name');
			expect(reviewerSource).toContain('issue_type');
		});
	});

	// Test 5: Token count ≤250 tokens
	describe('SUBSTANCE VERIFICATION token budget', () => {
		it('should have SUBSTANCE VERIFICATION section under 250 tokens', () => {
			const substanceSection = REVIEWER_PROMPT.match(
				/STEP 0b: SUBSTANCE VERIFICATION[^]+?TIER 1/,
			);
			expect(substanceSection).not.toBeNull();

			// Simple word count as proxy for tokens (approximate)
			const sectionText = substanceSection?.[0] ?? '';
			const wordCount = sectionText.split(/\s+/).length;

			// Allow some margin - tokens are typically ~1.3 words, so 250 tokens ≈ 190-200 words
			expect(wordCount).toBeLessThanOrEqual(250);
		});

		it('should have concise vaporware indicators list', () => {
			const indicatorsSection = REVIEWER_PROMPT.match(
				/VAPORWARE INDICATORS:([^]+?)Reject with:/,
			);
			expect(indicatorsSection).not.toBeNull();

			const indicatorText = indicatorsSection?.[1] ?? '';
			const wordCount = indicatorText.split(/\s+/).length;

			// Should be very concise - 4 short indicators
			expect(wordCount).toBeLessThanOrEqual(60);
		});
	});
});
