import { validateSpecContent } from '../config/spec-schema';
import { readEffectiveSpecSync } from '../sdd/effective-spec';
import { createSwarmTool } from './create-tool';

// ============ Types ============
interface ValidateSpecResult {
	valid: boolean;
	specMtime: string | null;
	requirementCount: {
		MUST: number;
		SHALL: number;
		SHOULD: number;
		MAY: number;
		total: number;
	};
	scenarioCount: number;
	errors: string[];
	warnings: string[];
}

// Obligation keywords to count
const OBLIGATION_KEYWORDS = ['MUST', 'SHALL', 'SHOULD', 'MAY'] as const;
type ObligationKeyword = (typeof OBLIGATION_KEYWORDS)[number];

// Regex patterns for parsing
const FR_ID_PATTERN = /\bFR-(?!000)\d{3}\b/;
const OBLIGATION_PATTERN = /\b(MUST|SHALL|SHOULD|MAY)\b/g;
const SCENARIO_PATTERN = /^##\s+Scenario\s*:/gm;
const GIVEN_WHEN_THEN_PATTERN = /\b(Given|When|Then|And|But)[:\s]/gi;

// ============ Helper Functions ============

/**
 * Count requirements by obligation level from markdown content.
 * Parses each line to find FR-ID references and extracts obligation keywords.
 */
function countRequirementsByObligation(
	content: string,
): Record<ObligationKeyword, number> {
	const counts: Record<ObligationKeyword, number> = {
		MUST: 0,
		SHALL: 0,
		SHOULD: 0,
		MAY: 0,
	};

	// Strip code blocks to avoid false positives
	const strippedContent = content
		.replace(/```[\s\S]*?```/g, '')
		.replace(/`[^`]*`/g, '');

	const lines = strippedContent.split('\n');

	for (const line of lines) {
		// Check if line contains an FR-ID using match() instead of test()
		// to avoid lastIndex issues with /g flag
		const frMatches = line.match(FR_ID_PATTERN);
		if (!frMatches) continue;

		// Use matchAll to get ALL obligation keywords on this line
		const matches = line.matchAll(OBLIGATION_PATTERN);
		for (const match of matches) {
			const keyword = match[1] as ObligationKeyword;
			if (OBLIGATION_KEYWORDS.includes(keyword)) {
				counts[keyword]++;
			}
		}
	}

	return counts;
}

/**
 * Count scenarios by looking for Scenario headers or Given/When/Then patterns.
 * A scenario is identified by a ## Scenario: header or a block containing
 * Given/When/Then keywords.
 */
function countScenarios(content: string): number {
	let scenarioCount = 0;

	// Method 1: Count ## Scenario: headers
	const scenarioMatches = content.match(SCENARIO_PATTERN);
	if (scenarioMatches) {
		scenarioCount += scenarioMatches.length;
	}

	// Method 2: Count Given/When/Then blocks as scenarios
	// Split content into potential scenario blocks and count blocks with Given/When/Then
	const givenWhenThenMatches = content.match(GIVEN_WHEN_THEN_PATTERN);
	if (givenWhenThenMatches && givenWhenThenMatches.length > 0) {
		// If we found Given/When/Then patterns but no explicit Scenario headers,
		// estimate based on "When" occurrences (each scenario has at least one When)
		if (scenarioCount === 0) {
			const whenCount = (content.match(/\bWhen\s+/gi) || []).length;
			scenarioCount = whenCount;
		}
	}

	return scenarioCount;
}

// ============ Tool Definition ============
export const lint_spec: ReturnType<typeof createSwarmTool> = createSwarmTool({
	description:
		'Reads .swarm/spec.md, lints markdown spec for FR-IDs, obligations, and structure, and returns requirement counts by obligation level, scenario count, and any errors or warnings found.',
	args: {},
	async execute(_args: unknown, directory: string): Promise<string> {
		const errors: string[] = [];
		const warnings: string[] = [];

		const spec = readEffectiveSpecSync(directory);
		if (!spec) {
			const result: ValidateSpecResult = {
				valid: false,
				specMtime: null,
				requirementCount: {
					MUST: 0,
					SHALL: 0,
					SHOULD: 0,
					MAY: 0,
					total: 0,
				},
				scenarioCount: 0,
				errors: [
					'spec.md not found and no valid OpenSpec-compatible projection available',
				],
				warnings: [],
			};
			return JSON.stringify(result, null, 2);
		}

		const specMtime = spec.mtime;
		const content = spec.content;

		// Validate markdown-level content using validateSpecContent
		const contentValidation = validateSpecContent(content);
		if (!contentValidation.valid) {
			for (const issue of contentValidation.issues) {
				errors.push(`Line ${issue.line}: ${issue.message}`);
			}
		}

		// Count requirements by obligation level
		const obligationCounts = countRequirementsByObligation(content);
		const totalRequirements = Object.values(obligationCounts).reduce(
			(sum, count) => sum + count,
			0,
		);

		// Count scenarios
		const scenarioCount = countScenarios(content);

		// Build result
		const result: ValidateSpecResult = {
			valid: errors.length === 0,
			specMtime,
			requirementCount: {
				...obligationCounts,
				total: totalRequirements,
			},
			scenarioCount,
			errors,
			warnings: [...warnings, ...spec.warnings],
		};

		return JSON.stringify(result, null, 2);
	},
});
