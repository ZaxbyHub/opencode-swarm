import { z } from 'zod';

// ---------------------------------------------------------------------------
// SpecRequirement
// ---------------------------------------------------------------------------
export const ObligationSchema = z.enum(['MUST', 'SHALL', 'SHOULD', 'MAY']);
export type Obligation = z.infer<typeof ObligationSchema>;

export const SpecRequirementSchema = z.object({
	id: z
		.string()
		.regex(
			/^FR-(?!000)\d{3}$/,
			'Requirement ID must match FR-### pattern (e.g., FR-001)',
		),
	obligation: ObligationSchema,
	text: z.string().min(1),
});
export type SpecRequirement = z.infer<typeof SpecRequirementSchema>;

// ---------------------------------------------------------------------------
// SpecScenario (BDD-style scenario outline)
// ---------------------------------------------------------------------------
export const SpecScenarioSchema = z.object({
	name: z.string().min(1),
	given: z.array(z.string()).optional().default([]),
	when: z
		.array(z.string())
		.min(1, 'Scenario must have at least one "when" clause'),
	thenClauses: z
		.array(z.string())
		.min(1, 'Scenario must have at least one "then" clause'),
});
export type SpecScenario = z.infer<typeof SpecScenarioSchema>;

// ---------------------------------------------------------------------------
// SpecSection
// ---------------------------------------------------------------------------
export const SpecSectionSchema = z.object({
	name: z.string().min(1),
	requirements: z.array(SpecRequirementSchema).default([]),
});
export type SpecSection = z.infer<typeof SpecSectionSchema>;

// ---------------------------------------------------------------------------
// SwarmSpec (root document)
// ---------------------------------------------------------------------------
export const SwarmSpecSchema = z.object({
	title: z.string().min(1),
	purpose: z.string().min(1),
	sections: z
		.array(SpecSectionSchema)
		.min(1, 'Spec must have at least one section'),
});
export type SwarmSpec = z.infer<typeof SwarmSpecSchema>;

// ---------------------------------------------------------------------------
// SpecDelta (incremental change document)
// ---------------------------------------------------------------------------
export const SpecDeltaSchema = z.object({
	added: z.array(SpecRequirementSchema).default([]),
	modified: z.array(SpecRequirementSchema).default([]),
	removed: z.array(SpecRequirementSchema).default([]),
});
export type SpecDelta = z.infer<typeof SpecDeltaSchema>;

// ---------------------------------------------------------------------------
// DeltaSpec (union of full spec and delta forms)
// ---------------------------------------------------------------------------
export const DeltaSpecSchema = z.union([
	SwarmSpecSchema,
	SpecDeltaSchema,
]);
export type DeltaSpec = z.infer<typeof DeltaSpecSchema>;

// ---------------------------------------------------------------------------
// validateSpecContent
// Validates raw markdown string using regex patterns without full parsing.
// Pre-processing strips fenced code blocks to avoid false positives.
// ---------------------------------------------------------------------------

const FENCED_BLOCK_PATTERN = /```[\s\S]*?```/g;
const INLINE_CODE_PATTERN = /`[^`]*`/g;
const FR_ID_PATTERN = /\bFR-\d{3}\b/g;
const OBLIGATION_PATTERN = /\b(MUST|SHALL|SHOULD|MAY)\b/g;
const SECTION_HEADER_PATTERN = /^##\s+.+$/gm;

interface ValidationIssue {
	line: number;
	message: string;
}

interface SpecContentValidationResult {
	valid: boolean;
	issues: ValidationIssue[];
}

/**
 * Strip fenced code blocks and inline code from markdown content.
 * @param content - Raw markdown string
 * @returns Content with code blocks removed
 */
function stripCodeBlocks(content: string): string {
	return content
		.replace(FENCED_BLOCK_PATTERN, '')
		.replace(INLINE_CODE_PATTERN, '');
}

/**
 * Extract line number from content up to a given position.
 * @param content - Full content string
 * @param position - Character position in the string
 * @returns Line number (1-indexed)
 */
function getLineNumber(content: string, position: number): number {
	const prefix = content.substring(0, position);
	return (prefix.match(/\n/g) || []).length + 1;
}

/**
 * Validate raw markdown spec content using regex patterns.
 * Checks for:
 * - FR-### requirement IDs
 * - Obligation keywords (MUST, SHALL, SHOULD, MAY)
 * - Section headers (## Section Name)
 *
 * @param content - Raw markdown string to validate
 * @returns Validation result with issues array
 */
export function validateSpecContent(
	content: string,
): SpecContentValidationResult {
	const issues: ValidationIssue[] = [];

	if (!content || content.trim().length === 0) {
		return { valid: false, issues: [{ line: 1, message: 'Content is empty' }] };
	}

	// Strip code blocks to avoid false positives from code examples
	const strippedContent = stripCodeBlocks(content);

	// Check for FR-### IDs
	const frMatches = strippedContent.match(FR_ID_PATTERN);
	if (!frMatches || frMatches.length === 0) {
		issues.push({
			line: 1,
			message: 'No FR-### requirement IDs found in spec content',
		});
	}

	// Check for obligation keywords
	const obligationMatches = strippedContent.match(OBLIGATION_PATTERN);
	if (!obligationMatches || obligationMatches.length === 0) {
		issues.push({
			line: 1,
			message:
				'No obligation keywords (MUST, SHALL, SHOULD, MAY) found in spec content',
		});
	}

	// Check for section headers
	const sectionMatches = strippedContent.match(SECTION_HEADER_PATTERN);
	if (!sectionMatches || sectionMatches.length === 0) {
		issues.push({
			line: 1,
			message: 'No section headers (## Section Name) found in spec content',
		});
	}

	// Validate FR-ID format consistency (all IDs should follow FR-###)
	const idMatches = strippedContent.matchAll(/\bFR-(\d{3})\b/g);
	for (const idMatch of idMatches) {
		const num = parseInt(idMatch[1], 10);
		if (num === 0) {
			const pos = idMatch.index;
			issues.push({
				line: getLineNumber(strippedContent, pos),
				message: `Invalid FR-ID "${idMatch[0]}" — number must be 001-999`,
			});
		}
	}

	return {
		valid: issues.length === 0,
		issues,
	};
}
