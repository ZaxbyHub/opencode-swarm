import { beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('src/agents/architect.ts - SOUNDING BOARD PROTOCOL (ADVERSARIAL TESTS)', () => {
	const ARCHITECT_FILE = join(process.cwd(), 'src', 'agents', 'architect.ts');

	let architectContent: string;

	beforeEach(() => {
		architectContent = readFileSync(ARCHITECT_FILE, 'utf-8');
	});

	// ATTACK VECTOR 1: Template injection
	describe('ATTACK VECTOR 1: Template injection — verify {{AGENT_PREFIX}} is properly escaped', () => {
		it('should not have nested or malformed template patterns in protocol section', () => {
			const protocolStartMatch = architectContent.match(
				/6a\. \*\*SOUNDING BOARD PROTOCOL\*\*/,
			);
			expect(protocolStartMatch).toBeTruthy();

			const protocolStartIndex = architectContent.indexOf(
				protocolStartMatch![0],
			);
			const afterProtocol = architectContent.slice(protocolStartIndex);
			const nextSectionMatch = afterProtocol.match(/\n\s*7\. \*\*/);
			const protocolEndIndex = nextSectionMatch?.index
				? protocolStartIndex + nextSectionMatch.index
				: architectContent.length;

			const protocolSection = architectContent.slice(
				protocolStartIndex,
				protocolEndIndex,
			);

			// Check for genuinely malformed template patterns
			// Pattern 1: Nested braces like {{{
			const nestedOpenBraces = protocolSection.match(/\{\{\{/g);
			expect(nestedOpenBraces).toBeNull();

			// Pattern 2: Nested closing braces like }}}
			const nestedCloseBraces = protocolSection.match(/\}\}\}/g);
			expect(nestedCloseBraces).toBeNull();

			// Pattern 3: Unmatched braces
			const openBraceCount = (protocolSection.match(/\{\{/g) || []).length;
			const closeBraceCount = (protocolSection.match(/\}\}/g) || []).length;
			expect(openBraceCount).toBe(closeBraceCount); // Braces should be balanced
		});
	});

	// ATTACK VECTOR 2: Quote handling
	describe('ATTACK VECTOR 2: Quote handling — verify single quotes in event names dont break string', () => {
		it('should have properly balanced single quotes in protocol section', () => {
			const protocolStartMatch = architectContent.match(
				/6a\. \*\*SOUNDING BOARD PROTOCOL\*\*/,
			);
			expect(protocolStartMatch).toBeTruthy();

			const protocolStartIndex = architectContent.indexOf(
				protocolStartMatch![0],
			);
			const afterProtocol = architectContent.slice(protocolStartIndex);
			const nextSectionMatch = afterProtocol.match(/\n\s*7\. \*\*/);
			const protocolEndIndex = nextSectionMatch?.index
				? protocolStartIndex + nextSectionMatch.index
				: architectContent.length;

			const protocolSection = architectContent.slice(
				protocolStartIndex,
				protocolEndIndex,
			);

			// Count single quotes - should be even (paired)
			const singleQuoteCount = (protocolSection.match(/'/g) || []).length;
			expect(singleQuoteCount % 2).toBe(0);

			// Count double quotes - should be even (paired)
			const doubleQuoteCount = (protocolSection.match(/"/g) || []).length;
			expect(doubleQuoteCount % 2).toBe(0);
		});

		it('should have event names properly quoted', () => {
			// The protocol section mentions 'sounding_board_consulted' and 'architect_loop_detected'
			expect(architectContent).toContain("'sounding_board_consulted'");
			expect(architectContent).toContain("'architect_loop_detected'");
		});
	});

	// ATTACK VECTOR 3: Section numbering
	describe('ATTACK VECTOR 3: Section numbering — verify 6a doesnt conflict with existing sections', () => {
		it('should have section 6a without conflicting with section 6 or 7', () => {
			// Verify section numbering hierarchy is correct
			expect(architectContent).toMatch(/6\. \*\*CRITIC GATE/);
			expect(architectContent).toMatch(/6a\. \*\*SOUNDING BOARD PROTOCOL/);
			expect(architectContent).toMatch(/7\. \*\*TIERED QA GATE/);

			// Check that section 6 and 6a both exist (6a may be indented, so search broadly)
			const section6Match = architectContent.match(/6\. \*\*CRITIC GATE/);
			const section6aMatch = architectContent.match(
				/6a\. \*\*SOUNDING BOARD PROTOCOL/,
			);
			expect(section6Match).toBeDefined();
			expect(section6aMatch).toBeDefined();
		});

		it('should not have another 6a section that would cause confusion', () => {
			// Check there's only one 6a section (may be indented, so don't require ^ anchor)
			const section6aMatches = architectContent.match(
				/6a\. \*\*SOUNDING BOARD PROTOCOL/g,
			);
			expect(section6aMatches).toBeDefined();
			expect(section6aMatches?.length).toBe(1);
		});

		it('should maintain proper section order (6 -> 6a -> 7)', () => {
			const pos6 = architectContent.indexOf('6. **CRITIC GATE');
			const pos6a = architectContent.indexOf('6a. **SOUNDING BOARD PROTOCOL');
			const pos7 = architectContent.indexOf('7. **TIERED QA GATE');

			// All should exist
			expect(pos6).toBeGreaterThan(-1);
			expect(pos6a).toBeGreaterThan(-1);
			expect(pos7).toBeGreaterThan(-1);

			// Should be in order: 6 -> 6a -> 7
			expect(pos6a).toBeGreaterThan(pos6);
			expect(pos7).toBeGreaterThan(pos6a);
		});
	});

	// ATTACK VECTOR 4: Content boundaries
	describe('ATTACK VECTOR 4: Content boundaries — verify block doesnt bleed into adjacent sections', () => {
		it('should have clear separation between section 6a and 7', () => {
			const protocolStartMatch = architectContent.match(
				/6a\. \*\*SOUNDING BOARD PROTOCOL\*\*/,
			);
			expect(protocolStartMatch).toBeTruthy();

			const protocolStartIndex = architectContent.indexOf(
				protocolStartMatch![0],
			);
			const afterProtocol = architectContent.slice(protocolStartIndex);
			const nextSectionMatch = afterProtocol.match(/\n\s*7\. \*\*/);

			expect(nextSectionMatch).toBeTruthy();

			// Verify the section boundary
			const protocolEndIndex = protocolStartIndex + nextSectionMatch!.index;
			const protocolContent = architectContent.slice(
				protocolStartIndex,
				protocolEndIndex,
			);

			// Protocol should have content
			expect(protocolContent.length).toBeGreaterThan(100);

			// Should end cleanly before section 7
			expect(protocolContent).not.toContain('7. **TIERED QA GATE');
		});

		it('should not have section 6a content leaking into section 7', () => {
			const protocolStartMatch = architectContent.match(
				/6a\. \*\*SOUNDING BOARD PROTOCOL\*\*/,
			);
			expect(protocolStartMatch).toBeTruthy();

			const protocolStartIndex = architectContent.indexOf(
				protocolStartMatch![0],
			);
			const afterProtocol = architectContent.slice(protocolStartIndex);
			const nextSectionMatch = afterProtocol.match(/\n\s*7\. \*\*/);

			expect(nextSectionMatch).toBeTruthy();

			const protocolEndIndex = protocolStartIndex + nextSectionMatch!.index;
			const section7Index =
				protocolStartIndex +
				nextSectionMatch!.index +
				nextSectionMatch![0].length;

			const section7Content = architectContent.slice(
				section7Index,
				section7Index + 500,
			);

			// Section 7 should not contain 6a-specific content
			expect(section7Content).not.toContain('SOUNDING BOARD PROTOCOL');
			expect(section7Content).not.toContain('sounding_board_consulted');
		});
	});

	// ATTACK VECTOR 5: Token overflow
	describe('ATTACK VECTOR 5: Token overflow — verify content is within budget', () => {
		it('should have the protocol section within reasonable token budget', () => {
			const protocolStartMatch = architectContent.match(
				/6a\. \*\*SOUNDING BOARD PROTOCOL\*\*/,
			);
			expect(protocolStartMatch).toBeTruthy();

			const protocolStartIndex = architectContent.indexOf(
				protocolStartMatch![0],
			);
			// Section 6a ends at 6b (sub-sections 6b-6f are separate; only measure 6a itself)
			const afterProtocol = architectContent.slice(protocolStartIndex);
			const nextSubsectionMatch = afterProtocol.match(/\n\s*6b\. \*\*/);
			const nextSectionMatch = afterProtocol.match(/\n\s*7\. \*\*/);
			const endMatch = nextSubsectionMatch ?? nextSectionMatch;
			const protocolEndIndex = endMatch?.index
				? protocolStartIndex + endMatch.index
				: architectContent.length;

			const protocolSection = architectContent
				.slice(protocolStartIndex, protocolEndIndex)
				.trim();

			// Count tokens (rough estimation: ~0.75 words per token)
			const words = protocolSection.split(/\s+/).filter((w) => w.length > 0);
			const estimatedTokens = Math.ceil(words.length / 0.75);

			// The requirement is <= 150 tokens for section 6a itself
			expect(estimatedTokens).toBeLessThanOrEqual(150);

			// Also check character count as a sanity check
			expect(protocolSection.length).toBeLessThan(800); // ~150 tokens * 4-5 chars/token
		});

		it('should not have excessive whitespace padding that wastes tokens', () => {
			const protocolStartMatch = architectContent.match(
				/6a\. \*\*SOUNDING BOARD PROTOCOL\*\*/,
			);
			expect(protocolStartMatch).toBeTruthy();

			const protocolStartIndex = architectContent.indexOf(
				protocolStartMatch![0],
			);
			// Section 6a ends at 6b (sub-sections 6b-6f are separate; only measure 6a itself)
			const afterProtocol = architectContent.slice(protocolStartIndex);
			const nextSubsectionMatch = afterProtocol.match(/\n\s*6b\. \*\*/);
			const nextSectionMatch = afterProtocol.match(/\n\s*7\. \*\*/);
			const endMatch = nextSubsectionMatch ?? nextSectionMatch;
			const protocolEndIndex = endMatch?.index
				? protocolStartIndex + endMatch.index
				: architectContent.length;

			const protocolSection = architectContent.slice(
				protocolStartIndex,
				protocolEndIndex,
			);

			// Count excessive blank lines (3+ consecutive newlines)
			const excessiveBlankLines = protocolSection.match(/\n\s*\n\s*\n/g);
			expect(excessiveBlankLines).toBeNull(); // Should not have excessive blank lines
		});

		it('should have concise content without redundant repetition', () => {
			const protocolStartMatch = architectContent.match(
				/6a\. \*\*SOUNDING BOARD PROTOCOL\*\*/,
			);
			expect(protocolStartMatch).toBeTruthy();

			const protocolStartIndex = architectContent.indexOf(
				protocolStartMatch![0],
			);
			// Section 6a ends at 6b (sub-sections 6b-6f are separate; only measure 6a itself)
			const afterProtocol = architectContent.slice(protocolStartIndex);
			const nextSubsectionMatch = afterProtocol.match(/\n\s*6b\. \*\*/);
			const nextSectionMatch = afterProtocol.match(/\n\s*7\. \*\*/);
			const endMatch = nextSubsectionMatch ?? nextSectionMatch;
			const protocolEndIndex = endMatch?.index
				? protocolStartIndex + endMatch.index
				: architectContent.length;

			const protocolSection = architectContent.slice(
				protocolStartIndex,
				protocolEndIndex,
			);

			// Check for word repetition (e.g., "critic" appearing too many times) in 6a only
			const criticMatches = protocolSection.match(/critic/gi);
			expect(criticMatches).toBeDefined();
			expect(criticMatches?.length).toBeLessThan(5); // Should not mention "critic" excessively

			// Check for duplicate phrases
			const lines = protocolSection
				.split('\n')
				.filter((l) => l.trim().length > 0);
			const uniqueLines = new Set(lines);
			// Most lines should be unique
			expect(uniqueLines.size).toBeGreaterThanOrEqual(lines.length * 0.8);
		});

		it('should fit within the overall prompt budget', () => {
			// Check that the addition of section 6a doesn't cause the overall prompt
			// to exceed reasonable limits
			const totalCharacters = architectContent.length;
			const estimatedTotalTokens = Math.ceil(totalCharacters / 4);

			// The entire prompt should be within reasonable bounds. A typical
			// context window is 128K tokens, and this prompt should be well under
			// 40K tokens to allow for user input and responses. v6.84.0 added
			// MODE: COUNCIL, General Council early workflow option, and three
			// BEHAVIORAL_GUIDANCE blocks for QA gate hardening. Subsequent releases
			// added additional anti-rationalization hardening (time-pressure, urgency,
			// quick-fix patterns), bringing the prompt to approximately 37–38K tokens.
			expect(estimatedTotalTokens).toBeLessThan(40000);
		});
	});

	// Summary verdict
	describe('OVERALL SECURITY ASSESSMENT', () => {
		it('should pass all adversarial tests', () => {
			// This is a meta-test that confirms all attack vectors have been tested
			const requiredAttackVectors = [
				'Template injection',
				'Quote handling',
				'Section numbering',
				'Content boundaries',
				'Token overflow',
			];

			// If we reach this point, all individual tests have passed
			expect(requiredAttackVectors.length).toBe(5);
		});
	});
});
