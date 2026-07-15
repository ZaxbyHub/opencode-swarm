/**
 * Semantic classifier for AST changes.
 * Classifies AST changes into semantic categories with risk ranking.
 * @module diff/semantic-classifier
 */

import type { ASTChange, ASTDiffResult } from '../diff/ast-diff.js';

// ============================================================================
// Type Exports
// ============================================================================

/**
 * Semantic categories for classified changes.
 * Describes the nature of the change from a code impact perspective.
 */
export type ChangeCategory =
	| 'SIGNATURE_CHANGE'
	| 'API_CHANGE'
	| 'GUARD_REMOVED'
	| 'LOGIC_CHANGE'
	| 'DELETED_FUNCTION'
	| 'NEW_FUNCTION'
	| 'REFACTOR'
	| 'COSMETIC'
	| 'UNCLASSIFIED';

/**
 * Risk level associated with a classified change.
 * Indicates the potential impact severity of the change.
 */
export type RiskLevel = 'Critical' | 'High' | 'Medium' | 'Low';

/**
 * A classified AST change with semantic categorization and risk assessment.
 */
export interface ClassifiedChange {
	/** Semantic category of the change */
	category: ChangeCategory;
	/** Risk level indicating potential impact severity */
	riskLevel: RiskLevel;
	/** Path to the file containing this change */
	filePath: string;
	/** Name of the symbol (function, class, etc.) affected */
	symbolName: string;
	/** Type of change operation */
	changeType: 'added' | 'modified' | 'removed' | 'renamed';
	/** Starting line number of the change */
	lineStart: number;
	/** Ending line number of the change */
	lineEnd: number;
	/** Human-readable description of what was detected */
	description: string;
	/** Original AST change signature detail (if available) */
	signature?: string;
	/** Original name before rename, if this is a renamed symbol */
	renamedFrom?: string;
	/** Number of files that depend on this file (blast radius indicator) */
	consumersCount?: number;
}

// ============================================================================
// Guard Keyword Detection
// ============================================================================

/** Keywords that indicate a guard/check function */
const GUARD_KEYWORDS = [
	'guard',
	'check',
	'validate',
	'verify',
	'ensure',
	'assert',
	'require',
];

/**
 * Check if a symbol name contains guard-related keywords.
 */
function isGuardKeyword(name: string): boolean {
	return GUARD_KEYWORDS.some((keyword) => {
		// Build case-insensitive keyword pattern: 'check' → '[cC][hH][eE][cC][kK]'
		const ciKeyword = keyword
			.split('')
			.map((c) => `[${c.toLowerCase()}${c.toUpperCase()}]`)
			.join('');
		const re = new RegExp(`(?<![a-z])${ciKeyword}(?![a-z])`);
		return re.test(name);
	});
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if a function name appears to be exported based on related changes.
 * Simple heuristic: looks for a corresponding export change in the same file.
 */
function isExportedFunction(name: string, allChanges: ASTChange[]): boolean {
	return allChanges.some((c) => c.name === name && c.category === 'export');
}

/**
 * Classify a single AST change into a ClassifiedChange.
 */
function classifyChange(
	change: ASTChange,
	filePath: string,
	allChanges: ASTChange[],
): ClassifiedChange {
	const base: Pick<
		ClassifiedChange,
		| 'filePath'
		| 'symbolName'
		| 'changeType'
		| 'lineStart'
		| 'lineEnd'
		| 'signature'
	> = {
		filePath,
		symbolName: change.name,
		changeType: change.type,
		lineStart: change.lineStart,
		lineEnd: change.lineEnd,
		signature: change.signature,
	};

	// DELETED_FUNCTION: removed function
	if (change.type === 'removed' && change.category === 'function') {
		// Check if this is a guard function first — guards are Critical
		if (isGuardKeyword(change.name)) {
			return {
				...base,
				category: 'GUARD_REMOVED',
				riskLevel: 'Critical',
				description: `Guard function '${change.name}' was removed`,
			};
		}
		return {
			...base,
			category: 'DELETED_FUNCTION',
			riskLevel: 'High',
			description: `Deleted function '${change.name}'`,
		};
	}

	// REFACTOR: renamed (signatures match, structural but not breaking)
	if (change.type === 'renamed') {
		// Guard function renames are higher risk — guards are security-critical
		if (
			change.category === 'function' &&
			(isGuardKeyword(change.name) || isGuardKeyword(change.renamedFrom || ''))
		) {
			return {
				...base,
				category: 'GUARD_REMOVED',
				riskLevel: 'Critical',
				description: `Guard function renamed from '${change.renamedFrom || 'unknown'}' to '${change.name}'`,
				renamedFrom: change.renamedFrom,
			};
		}

		// Regular rename — structural change but not breaking (signatures match)
		return {
			...base,
			category: 'REFACTOR',
			riskLevel: 'Medium',
			description: `${change.category} renamed from '${change.renamedFrom || 'unknown'}' to '${change.name}'`,
			renamedFrom: change.renamedFrom,
		};
	}

	// NEW_FUNCTION: added function
	if (change.type === 'added' && change.category === 'function') {
		return {
			...base,
			category: 'NEW_FUNCTION',
			riskLevel: 'Medium',
			description: `New function '${change.name}' added`,
		};
	}

	// SIGNATURE_CHANGE: modified function with signature change
	if (
		change.type === 'modified' &&
		change.category === 'function' &&
		change.signature
	) {
		return {
			...base,
			category: 'SIGNATURE_CHANGE',
			riskLevel: 'Critical',
			description: `Function signature changed for '${change.name}': ${change.signature}`,
		};
	}

	// API_CHANGE: modified export or type, or modified function that appears exported
	if (change.type === 'modified') {
		if (change.category === 'export' || change.category === 'type') {
			return {
				...base,
				category: 'API_CHANGE',
				riskLevel: 'Critical',
				description: `API surface changed for '${change.name}' (${change.category})`,
			};
		}

		if (
			change.category === 'function' &&
			isExportedFunction(change.name, allChanges)
		) {
			return {
				...base,
				category: 'API_CHANGE',
				riskLevel: 'Critical',
				description: `Exported function '${change.name}' was modified`,
			};
		}
	}

	// LOGIC_CHANGE: modified function (not signature change)
	if (change.type === 'modified' && change.category === 'function') {
		return {
			...base,
			category: 'LOGIC_CHANGE',
			riskLevel: 'High',
			description: `Function body logic changed for '${change.name}'`,
		};
	}

	// REFACTOR: modified class, type, or variable
	if (
		change.type === 'modified' &&
		(change.category === 'class' ||
			change.category === 'type' ||
			change.category === 'variable')
	) {
		return {
			...base,
			category: 'REFACTOR',
			riskLevel: 'Medium',
			description: `${change.category} '${change.name}' was refactored`,
		};
	}

	// COSMETIC: import changes
	if (change.category === 'import') {
		return {
			...base,
			category: 'COSMETIC',
			riskLevel: 'Low',
			description: `Import ${change.type} for '${change.name}'`,
		};
	}

	// UNCLASSIFIED: fallback
	return {
		...base,
		category: 'UNCLASSIFIED',
		riskLevel: 'Medium',
		description: `Unclassified ${change.type} of ${change.category} '${change.name}'`,
	};
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Classify an array of AST diff results into semantic categories with risk levels.
 *
 * @param astDiffs - Array of ASTDiffResult from the AST differ
 * @returns Array of ClassifiedChange with semantic categorization
 *
 * @example
 * ```typescript
 * const diffs = await astDiff(oldCode, newCode);
 * const classified = classifyChanges(diffs);
 * for (const change of classified) {
 *   printToConsole(`[${change.riskLevel}] ${change.category}: ${change.symbolName}`);
 * }
 * ```
 */
export function classifyChanges(
	astDiffs: ASTDiffResult[],
	fileConsumers?: Record<string, number>,
): ClassifiedChange[] {
	const result: ClassifiedChange[] = [];

	for (const diff of astDiffs) {
		for (const change of diff.changes) {
			const classified = classifyChange(change, diff.filePath, diff.changes);
			if (fileConsumers && diff.filePath in fileConsumers) {
				classified.consumersCount = fileConsumers[diff.filePath];
			}
			result.push(classified);
		}
	}

	return result;
}
