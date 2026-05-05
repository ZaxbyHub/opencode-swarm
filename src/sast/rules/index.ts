/**
 * SAST Rule Engine - Main entry point
 * Provides rule registration, loading, and execution for static security analysis
 */

// Re-export interfaces
export interface SastRule {
	id: string;
	name: string;
	severity: 'critical' | 'high' | 'medium' | 'low';
	languages: string[];
	description: string;
	remediation?: string;
	// Detection: either query OR pattern
	query?: string;
	pattern?: RegExp;
	// Optional validation for context-aware filtering
	validate?: (match: SastMatch, context: SastContext) => boolean;
}

export interface SastMatch {
	text: string;
	line: number;
	column: number;
	endLine?: number;
	endColumn?: number;
	captures?: Record<string, string>;
}

export interface SastContext {
	filePath: string;
	content: string;
	language: string;
	parser?: unknown;
	tree?: unknown;
}

export interface SastFinding {
	rule_id: string;
	severity: 'critical' | 'high' | 'medium' | 'low';
	message: string;
	location: {
		file: string;
		line: number;
		column?: number;
	};
	remediation?: string;
	excerpt?: string;
}

import { cRules } from './c';
import { csharpRules } from './csharp';
import { goRules } from './go';
import { javaRules } from './java';
// Import language-specific rules
import { javascriptRules } from './javascript';
import { phpRules } from './php';
import { pythonRules } from './python';

/**
 * All registered SAST rules
 */
const allRules: SastRule[] = [
	...javascriptRules,
	...pythonRules,
	...goRules,
	...javaRules,
	...phpRules,
	...cRules,
	...csharpRules,
];

export const _internals: {
	getAllRules: typeof getAllRules;
	getRulesForLanguage: typeof getRulesForLanguage;
	getRuleById: typeof getRuleById;
	findPatternMatches: typeof findPatternMatches;
	executeRulesSync: typeof executeRulesSync;
	executeRules: typeof executeRules;
	getRuleStats: typeof getRuleStats;
} = {
	getAllRules,
	getRulesForLanguage,
	getRuleById,
	findPatternMatches,
	executeRulesSync,
	executeRules,
	getRuleStats,
} as const;

/**
 * Get all registered rules
 */
export function getAllRules(): SastRule[] {
	return [...allRules];
}

/**
 * Get rules for a specific language
 */
export function getRulesForLanguage(language: string): SastRule[] {
	const normalized = language.toLowerCase();
	return allRules.filter((rule) =>
		rule.languages.some((lang) => lang.toLowerCase() === normalized),
	);
}

/**
 * Get rule by ID
 */
export function getRuleById(id: string): SastRule | undefined {
	return allRules.find((rule) => rule.id === id);
}

/**
 * Parse source code and extract matches for a given pattern
 */
function findPatternMatches(content: string, pattern: RegExp): SastMatch[] {
	const matches: SastMatch[] = [];
	const lines = content.split('\n');

	for (let lineNum = 0; lineNum < lines.length; lineNum++) {
		const line = lines[lineNum];

		// Use exec in a loop with a working copy of the pattern
		const workPattern = new RegExp(
			pattern.source,
			pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
		);
		let match = workPattern.exec(line);

		while (match !== null) {
			matches.push({
				text: match[0],
				line: lineNum + 1, // 1-indexed
				column: match.index + 1, // 1-indexed
			});

			// Prevent infinite loop for zero-length matches
			if (match[0].length === 0) {
				workPattern.lastIndex++;
			}

			match = workPattern.exec(line);
		}
	}

	return matches;
}

/**
 * Execute rules synchronously (pattern matching only)
 * This is the primary execution method for offline SAST
 */
export function executeRulesSync(
	filePath: string,
	content: string,
	language: string,
): SastFinding[] {
	const findings: SastFinding[] = [];
	const normalizedLang = language.toLowerCase();
	const rules = getRulesForLanguage(normalizedLang);

	for (const rule of rules) {
		// Use pattern if available, otherwise skip (we can't run queries sync)
		if (!rule.pattern) continue;

		const matches = findPatternMatches(content, rule.pattern);

		for (const match of matches) {
			// Apply optional validation
			if (rule.validate) {
				const context: SastContext = {
					filePath,
					content,
					language: normalizedLang,
				};
				if (!rule.validate(match, context)) {
					continue;
				}
			}

			// Extract code excerpt
			const lines = content.split('\n');
			const excerpt = lines[match.line - 1]?.trim() || '';

			findings.push({
				rule_id: rule.id,
				severity: rule.severity,
				message: rule.description,
				location: {
					file: filePath,
					line: match.line,
					column: match.column,
				},
				remediation: rule.remediation,
				excerpt,
			});
		}
	}

	return findings;
}

/**
 * Execute rules against a file (async version with tree-sitter support)
 * Falls back to pattern matching if tree-sitter is unavailable
 */
export async function executeRules(
	filePath: string,
	content: string,
	language: string,
): Promise<SastFinding[]> {
	// For now, just use the sync version
	// Tree-sitter integration can be added later
	return _internals.executeRulesSync(filePath, content, language);
}

/**
 * Get statistics about rules
 */
export function getRuleStats(): {
	total: number;
	bySeverity: Record<string, number>;
	byLanguage: Record<string, number>;
} {
	const bySeverity: Record<string, number> = {
		critical: 0,
		high: 0,
		medium: 0,
		low: 0,
	};
	const byLanguage: Record<string, number> = {};

	for (const rule of allRules) {
		bySeverity[rule.severity]++;
		for (const lang of rule.languages) {
			const normalized = lang.toLowerCase();
			byLanguage[normalized] = (byLanguage[normalized] || 0) + 1;
		}
	}

	return {
		total: allRules.length,
		bySeverity,
		byLanguage,
	};
}
