/**
 * Verification tests for ESCALATION DISCIPLINE in architect.ts (Task 2.1)
 *
 * TEST REQUIREMENTS:
 * 1. Three-tier escalation present
 * 2. Tier 2 references SOUNDING_BOARD
 * 3. Tier 3 requires APPROVED verdict
 * 4. ESCALATION_SKIP violation defined
 * 5. Token budget ≤150
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ARCHITECT_FILE = join(process.cwd(), 'src', 'agents', 'architect.ts');

function readFile(path: string): string {
	return readFileSync(path, 'utf-8');
}

function countTokens(text: string): number {
	// Approximate token count: ~1.3 tokens per word on average
	const words = text
		.trim()
		.split(/\s+/)
		.filter((w) => w.length > 0);
	return Math.ceil(words.length * 1.3);
}

describe('ESCALATION DISCIPLINE Verification', () => {
	let content: string;
	let escalationSection: string;

	beforeEach(() => {
		content = readFile(ARCHITECT_FILE);

		// Extract only the ESCALATION DISCIPLINE block from TIER 1 through VIOLATION line
		const tier1Match = content.match(/TIER 1[\s\S]*?ESCALATION_SKIP[^\n]*/);
		escalationSection = tier1Match ? tier1Match[0] : '';
	});

	it('Requirement 1: Three-tier escalation present', () => {
		expect(content).toMatch(/TIER 1.*SELF-RESOLVE/);
		expect(content).toMatch(/TIER 2.*CRITIC CONSULTATION/);
		expect(content).toMatch(/TIER 3.*USER ESCALATION/);

		// Verify all three tiers are defined in a sequence
		expect(content).toContain('TIER 1 — SELF-RESOLVE:');
		expect(content).toContain('TIER 2 — CRITIC CONSULTATION:');
		expect(content).toContain('TIER 3 — USER ESCALATION:');
	});

	it('Requirement 2: Tier 2 references SOUNDING_BOARD', () => {
		const tier2Match = content.match(
			/TIER 2.*?CRITIC CONSULTATION:([\s\S]*?)(?=TIER 3|$)/,
		);
		expect(tier2Match).toBeTruthy();

		if (tier2Match) {
			const tier2Content = tier2Match[1];
			expect(tier2Content).toContain('sounding_board');
			expect(tier2Content).toMatch(/critic_sounding_board/);
		}
	});

	it('Requirement 3: Tier 3 requires APPROVED verdict', () => {
		const tier3Match = content.match(
			/TIER 3.*?USER ESCALATION:([\s\S]*?)(?=VIOLATION:|$)/,
		);
		expect(tier3Match).toBeTruthy();

		if (tier3Match) {
			const tier3Content = tier3Match[1];
			expect(tier3Content).toContain('APPROVED');
			expect(tier3Content).toMatch(
				/after critic_sounding_board returns APPROVED/,
			);
		}
	});

	it('Requirement 4: ESCALATION_SKIP violation defined', () => {
		expect(content).toContain('ESCALATION_SKIP');
		expect(content).toMatch(
			/VIOLATION:.*Skipping directly to Tier 3.*ESCALATION_SKIP/,
		);
	});

	it('Requirement 5: Token budget ≤150', () => {
		// Count tokens in the escalation discipline section
		const tokenCount = countTokens(escalationSection);

		console.log(`\nESCALATION DISCIPLINE token count: ${tokenCount}`);
		console.log(
			`Section preview (first 200 chars): ${escalationSection.substring(0, 200)}...`,
		);

		expect(tokenCount).toBeLessThanOrEqual(150);
	});

	it('Integration: All escalation discipline elements in proper order', () => {
		// Verify the sequence: TIER 1 → TIER 2 → TIER 3 → VIOLATION
		const tier1Index = content.indexOf('TIER 1 — SELF-RESOLVE:');
		const tier2Index = content.indexOf('TIER 2 — CRITIC CONSULTATION:');
		const tier3Index = content.indexOf('TIER 3 — USER ESCALATION:');
		const violationIndex = content.indexOf(
			'VIOLATION: Skipping directly to Tier 3 is ESCALATION_SKIP',
		);

		expect(tier1Index).toBeGreaterThan(-1);
		expect(tier2Index).toBeGreaterThan(tier1Index);
		expect(tier3Index).toBeGreaterThan(tier2Index);
		expect(violationIndex).toBeGreaterThan(tier3Index);
	});
});
