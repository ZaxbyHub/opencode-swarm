/**
 * External content scanner — shared ingress point for arbitrary external text.
 *
 * Reuses the prompt-injection and unsafe-instruction patterns from
 * external-skill-validator.ts to scan network-fetched content (gitingest,
 * web_search, future network tools) before it enters the LLM context.
 *
 * Provides a single shared interface: `scanExternalContent(text, options?)`.
 * This ensures consistent threat detection across all external sources
 * and closes the asymmetry documented in issue #1278.
 *
 * Uses an `_internals` DI seam for testability — no `mock.module` leakage.
 */

import { INVISIBLE_FORMAT_CHARS } from '../hooks/knowledge-validator';
import {
	PROMPT_INJECTION_PATTERNS,
	UNSAFE_INSTRUCTION_PATTERNS,
	type ValidationFinding,
} from './external-skill-validator';

// ============================================================================
// Types
// ============================================================================

/** Result from scanning external content for injection and unsafe instructions. */
export interface ExternalContentScanResult {
	/** Whether threats were detected. */
	clean: boolean;
	/** Individual findings from the scan. */
	findings: ValidationFinding[];
	/** Threats found: 'none', 'warning', or 'error'. */
	threatLevel: 'none' | 'warning' | 'error';
	/** The original text (for comparison). */
	originalLength: number;
	/** The neutralized text with threat markers wrapped. */
	neutralized: string;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Apply invisible-format-character detection to raw text.
 *
 * Unlike the other patterns, invisible format chars are detected by counting
 * occurrences in the raw string (not via regex .test), because we need the
 * match string and they are multi-codepoint.
 *
 * Returns an array of findings (empty if none found).
 * Each finding includes the individual match string (not concatenated),
 * so callers can neutralize each occurrence at its original position.
 */
function scanInvisibleFormatChars(text: string): ValidationFinding[] {
	const findings: ValidationFinding[] = [];
	const matches = text.match(INVISIBLE_FORMAT_CHARS);
	if (matches !== null && matches.length > 0) {
		for (const match of matches) {
			findings.push({
				pattern: 'invisible_format_chars',
				field: 'external_content',
				description: `Invisible format characters detected (${matches.length} occurrence(s))`,
				severity: 'error',
				match: match.slice(0, 100),
			});
		}
	}
	return findings;
}

/**
 * Neutralize threat patterns in text by wrapping them with delimiters.
 * This makes them visible to the LLM as data, not instructions.
 */
function neutralizeThreatPatterns(
	text: string,
	findings: ValidationFinding[],
): string {
	if (findings.length === 0) {
		return text;
	}

	let result = text;

	// For each error-severity finding, wrap the matched text with markers.
	// Use a replacement function so that `$` characters in the original match
	// are not interpreted as RegExp replacement patterns ($&, $1, etc.).
	for (const finding of findings.filter((f) => f.severity === 'error')) {
		const escapedMatch = finding.match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const pattern = new RegExp(escapedMatch, 'g');
		result = result.replace(
			pattern,
			() =>
				`[EXTERNAL_CONTENT_THREAT: ${finding.pattern}] ${finding.match} [/EXTERNAL_CONTENT_THREAT]`,
		);
	}

	return result;
}

// ============================================================================
// Main Scanner
// ============================================================================

/**
 * Scan arbitrary external content for prompt-injection and unsafe-instruction threats.
 *
 * Returns a structured result with:
 * - `clean`: boolean indicating no error-severity findings
 * - `findings`: all detected findings
 * - `threatLevel`: aggregated threat assessment
 * - `neutralized`: the text with threat patterns wrapped for safety
 *
 * @param text - The external content to scan (arbitrary length, typically from API)
 * @param options - Optional: { trustLevel = 'low' }
 *   - 'low': warnings are treated as errors
 *   - 'medium'/'high': warnings stay warnings
 */
export function scanExternalContent(
	text: string,
	options?: {
		trustLevel?: 'low' | 'medium' | 'high';
		maxLength?: number;
	},
): ExternalContentScanResult {
	const trustLevel = options?.trustLevel ?? 'low';
	const maxLength = options?.maxLength ?? 50_000;

	// Defensive guard: treat null/undefined as empty string to prevent
	// runtime TypeError from callers outside the type system boundary.
	if (text == null) {
		text = '';
	}

	const originalLength = text.length;

	const findings: ValidationFinding[] = [];

	// Check for oversized content (warning)
	if (text.length > maxLength) {
		findings.push({
			pattern: 'oversized_content',
			field: 'external_content',
			description: `External content exceeds safe size threshold (${text.length} > ${maxLength} bytes)`,
			severity: 'error',
			match: `${text.length} bytes`,
		});
	}

	// Invisible format chars — special handling
	findings.push(...scanInvisibleFormatChars(text));

	// Prompt-injection patterns
	for (const entry of PROMPT_INJECTION_PATTERNS) {
		const match = entry.pattern.exec(text);
		if (match !== null) {
			findings.push({
				pattern: entry.name,
				field: 'external_content',
				description: entry.description,
				severity: entry.severity,
				match: match[0],
			});
		}
	}

	// Unsafe-instruction patterns
	for (const entry of UNSAFE_INSTRUCTION_PATTERNS) {
		const match = entry.pattern.exec(text);
		if (match !== null) {
			findings.push({
				pattern: entry.name,
				field: 'external_content',
				description: entry.description,
				severity: entry.severity,
				match: match[0],
			});
		}
	}

	// Trust-level modulation
	const promoteWarnings = trustLevel === 'low';
	const modulatedFindings: ValidationFinding[] = findings.map((f) =>
		promoteWarnings && f.severity === 'warning'
			? { ...f, severity: 'error' as const }
			: f,
	);

	const hasErrors = modulatedFindings.some((f) => f.severity === 'error');
	const hasWarnings = modulatedFindings.some((f) => f.severity === 'warning');

	let threatLevel: 'none' | 'warning' | 'error';
	if (hasErrors) {
		threatLevel = 'error';
	} else if (hasWarnings) {
		threatLevel = 'warning';
	} else {
		threatLevel = 'none';
	}

	// Neutralize error-severity threats
	const neutralized = neutralizeThreatPatterns(
		text,
		modulatedFindings.filter((f) => f.severity === 'error'),
	);

	return {
		clean: threatLevel === 'none',
		findings: modulatedFindings,
		threatLevel,
		originalLength,
		neutralized,
	};
}

// ============================================================================
// DI Seam — _internals
// ============================================================================

export const _internals = {
	// Exported for testing purposes
	scanInvisibleFormatChars,
	neutralizeThreatPatterns,
};
