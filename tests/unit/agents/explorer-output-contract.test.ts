import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CANDIDATE_HEADERS } from '../../../src/background/candidate-contract';

// Read the source file directly since EXPLORER_PROMPT is not exported
const EXPLORER_SOURCE = readFileSync(
	resolve(import.meta.dir, '../../../src/agents/explorer.ts'),
	'utf-8',
);

// Extract the EXPLORER_PROMPT value from the source
function extractPromptBlock(source: string, promptName: string): string {
	const regex = new RegExp(
		`const ${promptName}\\s*=\\s*\x60([\\s\\S]*?)\x60;?\\s*export`,
		'm',
	);
	const match = source.match(regex);
	return match ? match[1] : '';
}

const EXPLORER_PROMPT = extractPromptBlock(EXPLORER_SOURCE, 'EXPLORER_PROMPT');

// Helper to extract sections from prompts
function extractSection(prompt: string, sectionName: string): string | null {
	const lines = prompt.split('\n');
	let inSection = false;
	const sectionContent: string[] = [];

	for (const line of lines) {
		// Check for section header (### or ## with section name)
		const sectionHeaderPattern = new RegExp(
			`^(#{1,3})\\s+${sectionName}\\s*$`,
			'i',
		);
		if (sectionHeaderPattern.test(line)) {
			inSection = true;
			continue;
		}

		// Check for next section (any header at same or higher level)
		if (inSection && /^#{1,3}\s+\S/.test(line)) {
			break;
		}

		if (inSection) {
			sectionContent.push(line);
		}
	}

	return sectionContent.length > 0 ? sectionContent.join('\n') : null;
}

describe('EXPLORER_PROMPT Output Contract Verification', () => {
	describe('ANALYSIS PROTOCOL section requirements', () => {
		test('1. EXPLORER_PROMPT contains "COMPLEXITY INDICATORS" section', () => {
			expect(EXPLORER_PROMPT).toContain('### COMPLEXITY INDICATORS');
			const section = extractSection(EXPLORER_PROMPT, 'COMPLEXITY INDICATORS');
			expect(section).not.toBeNull();
			// Verify it covers structural concerns
			expect(section!).toMatch(
				/cyclomatic complexity|deep nesting|circular dependencies|complex control flow/i,
			);
		});

		test('2. EXPLORER_PROMPT contains "RELEVANT CONSTRAINTS" in ANALYSIS PROTOCOL (not "RELEVANT CONTEXT FOR TASK")', () => {
			expect(EXPLORER_PROMPT).toContain('### RELEVANT CONSTRAINTS');
			expect(EXPLORER_PROMPT).not.toContain('RELEVANT CONTEXT FOR TASK');
		});
	});

	describe('OUTPUT FORMAT section requirements', () => {
		test('candidate mode defers the exact schema to one caller/controller-owned contract', () => {
			const candidateSection = extractSection(
				EXPLORER_PROMPT,
				'CANDIDATE REPORTING MODE',
			);
			expect(candidateSection).not.toBeNull();
			expect(candidateSection).toContain('one unprefixed data row per finding');
			expect(candidateSection).toContain('exact header supplied by the caller');
			expect(candidateSection).toContain('Do not merge fields');
			expect(candidateSection).not.toContain('impact_context');
			expect(candidateSection).not.toContain('invariant_violated');
			expect(candidateSection).not.toContain('[CLEAN] | lane');
			expect(candidateSection).not.toContain('[CLEAN] | micro_lane');
			expect(candidateSection).toContain('negative evidence');
		});

		test('a direct caller-owned base schema remains the only concrete family in the combined contract', () => {
			const directPrompt = `Audit the diff. Return:\n${CANDIDATE_HEADERS.base_explorer}`;
			const combined = `${EXPLORER_PROMPT}\n${directPrompt}`;
			expect(combined.split(CANDIDATE_HEADERS.base_explorer)).toHaveLength(2);
			expect(combined).not.toContain(CANDIDATE_HEADERS.micro_lane);
		});

		test('3. EXPLORER_PROMPT contains "OBSERVED CHANGES" section in OUTPUT FORMAT', () => {
			const outputFormatIndex = EXPLORER_PROMPT.indexOf(
				'OUTPUT FORMAT (MANDATORY',
			);
			const integrationImpactIndex = EXPLORER_PROMPT.indexOf(
				'## INTEGRATION IMPACT ANALYSIS MODE',
			);
			const outputFormatSection = EXPLORER_PROMPT.substring(
				outputFormatIndex,
				integrationImpactIndex,
			);

			expect(outputFormatSection).toContain('OBSERVED CHANGES:');
		});

		test('4. EXPLORER_PROMPT contains "CONSUMERS_AFFECTED" section in OUTPUT FORMAT', () => {
			const outputFormatIndex = EXPLORER_PROMPT.indexOf(
				'OUTPUT FORMAT (MANDATORY',
			);
			const integrationImpactIndex = EXPLORER_PROMPT.indexOf(
				'## INTEGRATION IMPACT ANALYSIS MODE',
			);
			const outputFormatSection = EXPLORER_PROMPT.substring(
				outputFormatIndex,
				integrationImpactIndex,
			);

			expect(outputFormatSection).toContain('CONSUMERS_AFFECTED:');
		});

		test('2b. EXPLORER_PROMPT contains "RELEVANT CONSTRAINTS" in OUTPUT FORMAT (not "RELEVANT CONTEXT FOR TASK")', () => {
			const outputFormatIndex = EXPLORER_PROMPT.indexOf(
				'OUTPUT FORMAT (MANDATORY',
			);
			const integrationImpactIndex = EXPLORER_PROMPT.indexOf(
				'## INTEGRATION IMPACT ANALYSIS MODE',
			);
			const outputFormatSection = EXPLORER_PROMPT.substring(
				outputFormatIndex,
				integrationImpactIndex,
			);

			expect(outputFormatSection).toContain('RELEVANT CONSTRAINTS:');
		});
	});

	describe('INTEGRATION IMPACT OUTPUT FORMAT requirements', () => {
		test('5. EXPLORER_PROMPT contains "COMPATIBILITY SIGNALS" (not "VERDICT") in integration impact OUTPUT FORMAT', () => {
			const integrationSection = EXPLORER_PROMPT.substring(
				EXPLORER_PROMPT.indexOf('## INTEGRATION IMPACT ANALYSIS MODE'),
			);

			expect(integrationSection).toContain('COMPATIBILITY SIGNALS:');
			expect(integrationSection).not.toContain('VERDICT:');
		});

		test('6. EXPLORER_PROMPT contains "MIGRATION_SURFACE" (not "MIGRATION_NEEDED") in integration impact OUTPUT FORMAT', () => {
			const integrationSection = EXPLORER_PROMPT.substring(
				EXPLORER_PROMPT.indexOf('## INTEGRATION IMPACT ANALYSIS MODE'),
			);

			expect(integrationSection).toContain('MIGRATION_SURFACE:');
			expect(integrationSection).not.toContain('MIGRATION_NEEDED');
		});
	});

	describe('RISKS vs COMPLEXITY INDICATORS distinction', () => {
		test('7. RUNTIME/BEHAVIORAL CONCERNS section is distinct from COMPLEXITY INDICATORS — covers runtime concerns', () => {
			const risksSection = extractSection(
				EXPLORER_PROMPT,
				'RUNTIME/BEHAVIORAL CONCERNS',
			);
			expect(risksSection).not.toBeNull();
			// RUNTIME/BEHAVIORAL CONCERNS should cover runtime concerns: error handling, unreachable code, platform assumptions
			expect(risksSection!).toMatch(
				/error handling|unreachable|single-throw|platform-specific/i,
			);
		});

		test('7b. COMPLEXITY INDICATORS covers structural concerns (not runtime)', () => {
			const complexitySection = extractSection(
				EXPLORER_PROMPT,
				'COMPLEXITY INDICATORS',
			);
			expect(complexitySection).not.toBeNull();
			// COMPLEXITY INDICATORS should cover structural concerns: cyclomatic complexity, nesting, circular deps
			expect(complexitySection!).toMatch(
				/cyclomatic complexity|deep nesting|circular dependencies|complex control flow/i,
			);
			// Should NOT contain runtime-specific terms
			expect(complexitySection!).not.toMatch(
				/error handling|platform-specific|unreachable/i,
			);
		});
	});
});

describe('Export requirements', () => {
	test('8. CURATOR_INIT_PROMPT is exported from explorer.ts', () => {
		expect(EXPLORER_SOURCE).toMatch(/export\s+const\s+CURATOR_INIT_PROMPT\s*=/);
	});

	test('8b. CURATOR_PHASE_PROMPT is exported from explorer.ts', () => {
		expect(EXPLORER_SOURCE).toMatch(
			/export\s+const\s+CURATOR_PHASE_PROMPT\s*=/,
		);
	});
});
