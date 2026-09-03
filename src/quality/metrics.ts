import * as fs from 'node:fs';
import * as path from 'node:path';
import type { QualityBudgetConfig } from '../config/schema';
import * as logger from '../utils/logger';
import { readBaseFileContent, resolveQualityMergeBase } from './git-base';

// ============ Types ============

export interface QualityMetrics {
	complexity_delta: number;
	public_api_delta: number;
	duplication_ratio: number;
	test_to_code_ratio: number;
	files_analyzed: string[];
	thresholds: QualityBudgetConfig;
	violations: QualityViolation[];
}

export interface QualityViolation {
	type: 'complexity' | 'api' | 'duplication' | 'test_ratio';
	message: string;
	severity: 'error' | 'warning';
	files: string[];
}

// ============ Constants ============

const MAX_FILE_SIZE_BYTES = 256 * 1024; // 256KB per file
const MIN_DUPLICATION_LINES = 10; // Minimum lines to flag as duplication
/**
 * Defensive cap on per-file `git show` base reads (issue #2470): bounds
 * subprocess count for very large change sets; files beyond the cap count
 * full head complexity toward the delta (conservative direction).
 */
const MAX_BASE_FILE_READS = 200;

// ============ Complexity Calculation ============

/**
 * Estimate cyclomatic complexity from source code
 * Counts: if, for, while, switch, case, catch, &&, ||, ternary ?, optional chaining, nullish coalescing
 */
export function estimateCyclomaticComplexity(content: string): number {
	// Remove block comments /* ... */
	let processed = content.replace(/\/\*[\s\S]*?\*\//g, '');

	// Remove line comments //
	processed = processed.replace(/\/\/.*/g, '');

	// Remove Python comments #
	processed = processed.replace(/#.*/g, '');

	// Remove single-quoted strings
	processed = processed.replace(/'[^']*'/g, '');

	// Remove double-quoted strings
	processed = processed.replace(/"[^"]*"/g, '');

	// Remove template literals
	processed = processed.replace(/`[^`]*`/g, '');

	let complexity = 1; // Base complexity

	// Count decision points
	const decisionPatterns = [
		/\bif\b/g, // if statements
		/\belse\s+if\b/g, // else if
		/\bfor\b/g, // for loops
		/\bwhile\b/g, // while loops
		/\bswitch\b/g, // switch
		/\bcase\b/g, // case
		/\bcatch\b/g, // catch blocks
		/\?\./g, // optional chaining
		/\?\?/g, // nullish coalescing
		/&&/g, // logical AND
		/\|\|/g, // logical OR
	];

	for (const pattern of decisionPatterns) {
		const matches = processed.match(pattern);
		if (matches) {
			complexity += matches.length;
		}
	}

	// Approximate ternary: ? followed by non-colon (simple heuristic)
	const ternaryMatches = processed.match(/\?[^:]/g);
	if (ternaryMatches) {
		complexity += ternaryMatches.length;
	}

	return complexity;
}

/**
 * Get complexity for a single file
 */
function getComplexityForFile(filePath: string): number | null {
	try {
		const stat = fs.statSync(filePath);

		// Skip files > 256KB
		if (stat.size > MAX_FILE_SIZE_BYTES) {
			return null;
		}

		const content = fs.readFileSync(filePath, 'utf-8');
		return estimateCyclomaticComplexity(content);
	} catch {
		return null;
	}
}

/**
 * Compute complexity delta for changed files.
 *
 * The delta is a true base-versus-head difference (issue #2470 / #1655): head
 * complexity of each changed file minus its merge-base complexity. Files with
 * no base version (new files, unavailable base) contribute their full head
 * complexity; deleted files (head missing, base present) subtract their base
 * complexity. When no merge base can be resolved the map is empty and every
 * file is treated as new — preserving the historical head-only absolute value.
 */
async function computeComplexityDelta(
	files: string[],
	workingDir: string,
	baseContents: ReadonlyMap<string, string | null>,
): Promise<{ delta: number; analyzedFiles: string[] }> {
	let delta = 0;
	const analyzedFiles: string[] = [];

	for (const file of files) {
		const fullPath = path.isAbsolute(file) ? file : path.join(workingDir, file);
		const baseContent = baseContents.get(file) ?? null;

		// Check if file exists
		if (!fs.existsSync(fullPath)) {
			// Deleted file: the change removes its base complexity.
			if (baseContent !== null) {
				delta -= estimateCyclomaticComplexity(baseContent);
			}
			continue;
		}

		const complexity = getComplexityForFile(fullPath);
		if (complexity !== null) {
			delta +=
				complexity -
				(baseContent !== null ? estimateCyclomaticComplexity(baseContent) : 0);
			analyzedFiles.push(file);
		}
	}

	return { delta, analyzedFiles };
}

// ============ Public API Delta Calculation ============

/**
 * Count exports/declarations in a TypeScript/JavaScript file
 */
function countExportsInFile(content: string): number {
	let count = 0;

	// export function name
	const exportFunctionMatches = content.match(/export\s+function\s+\w+/g);
	if (exportFunctionMatches) count += exportFunctionMatches.length;

	// export class name
	const exportClassMatches = content.match(/export\s+class\s+\w+/g);
	if (exportClassMatches) count += exportClassMatches.length;

	// export const name
	const exportConstMatches = content.match(/export\s+const\s+\w+/g);
	if (exportConstMatches) count += exportConstMatches.length;

	// export let name
	const exportLetMatches = content.match(/export\s+let\s+\w+/g);
	if (exportLetMatches) count += exportLetMatches.length;

	// export var name
	const exportVarMatches = content.match(/export\s+var\s+\w+/g);
	if (exportVarMatches) count += exportVarMatches.length;

	// export { name1, name2 }
	const exportNamedMatches = content.match(/export\s*\{[^}]+\}/g);
	if (exportNamedMatches) {
		for (const match of exportNamedMatches) {
			// Extract only the names inside the braces, not the 'export' keyword
			const names = match.match(/\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g);
			// Filter out 'export' if it somehow matched
			const filteredNames = names ? names.filter((n) => n !== 'export') : [];
			count += filteredNames.length;
		}
	}

	// export default
	const exportDefaultMatches = content.match(/export\s+default/g);
	if (exportDefaultMatches) count += exportDefaultMatches.length;

	// export type / export interface
	const exportTypeMatches = content.match(/export\s+(type|interface)\s+\w+/g);
	if (exportTypeMatches) count += exportTypeMatches.length;

	// export enum
	const exportEnumMatches = content.match(/export\s+enum\s+\w+/g);
	if (exportEnumMatches) count += exportEnumMatches.length;

	// export = (CommonJS)
	const exportEqualsMatches = content.match(/export\s+=/g);
	if (exportEqualsMatches) count += exportEqualsMatches.length;

	return count;
}

/**
 * Count exports in Python files (def, class at module level)
 */
function countPythonExports(content: string): number {
	let count = 0;

	// Remove comments
	const noComments = content.replace(/#.*/g, '');

	// Remove strings
	const noStrings = noComments.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');

	// Count function definitions at module level (allowing for leading whitespace)
	const functionMatches = noStrings.match(/^\s*def\s+\w+/gm);
	if (functionMatches) count += functionMatches.length;

	// Count class definitions at module level
	const classMatches = noStrings.match(/^\s*class\s+\w+/gm);
	if (classMatches) count += classMatches.length;

	// Count __all__ - must be done BEFORE removing strings from content
	// because __all__ contains quoted names
	const originalContent = content;
	const allMatchOriginal = originalContent.match(/__all__\s*=\s*\[([^\]]+)\]/);
	if (allMatchOriginal?.[1]) {
		// Extract names - handle both quoted and unquoted
		const names = allMatchOriginal[1].match(/['"]?(\w+)['"]?/g);
		if (names) {
			// Remove quotes if present and count
			const cleanNames = names.map((n) => n.replace(/['"]/g, ''));
			count += cleanNames.length;
		}
	}

	return count;
}

/**
 * Count exports in Rust files
 */
function countRustExports(content: string): number {
	let count = 0;

	// Remove comments
	let processed = content.replace(/\/\/.*/g, '');
	processed = processed.replace(/\/\*[\s\S]*?\*\//g, '');

	// pub fn
	const pubFnMatches = processed.match(/pub\s+fn\s+\w+/g);
	if (pubFnMatches) count += pubFnMatches.length;

	// pub struct
	const pubStructMatches = processed.match(/pub\s+struct\s+\w+/g);
	if (pubStructMatches) count += pubStructMatches.length;

	// pub enum
	const pubEnumMatches = processed.match(/pub\s+enum\s+\w+/g);
	if (pubEnumMatches) count += pubEnumMatches.length;

	// pub use
	const pubUseMatches = processed.match(/pub\s+use\s+/g);
	if (pubUseMatches) count += pubUseMatches.length;

	// pub const
	const pubConstMatches = processed.match(/pub\s+const\s+\w+/g);
	if (pubConstMatches) count += pubConstMatches.length;

	// pub mod
	const pubModMatches = processed.match(/pub\s+mod\s+\w+/g);
	if (pubModMatches) count += pubModMatches.length;

	// pub type
	const pubTypeMatches = processed.match(/pub\s+type\s+\w+/g);
	if (pubTypeMatches) count += pubTypeMatches.length;

	return count;
}

/**
 * Count exports in Go files
 */
function countGoExports(content: string): number {
	let count = 0;

	// Remove comments
	let processed = content.replace(/\/\/.*/gm, '');
	processed = processed.replace(/\/\*[\s\S]*?\*\//g, '');

	// Match exported functions (capitalized function names) - allow leading whitespace
	const exportedFuncMatches = processed.match(/^\s*func\s+[A-Z]\w*/gm);
	if (exportedFuncMatches) count += exportedFuncMatches.length;

	// Match exported variables (capitalized) - allow leading whitespace
	const exportedVarMatches = processed.match(/^\s*var\s+[A-Z]\w*/gm);
	if (exportedVarMatches) count += exportedVarMatches.length;

	// Match exported types - allow leading whitespace
	const exportedTypeMatches = processed.match(/^\s*type\s+[A-Z]\w*/gm);
	if (exportedTypeMatches) count += exportedTypeMatches.length;

	// Match exported constants (capitalized) - allow leading whitespace
	const exportedConstMatches = processed.match(/^\s*const\s+[A-Z]\w*/gm);
	if (exportedConstMatches) count += exportedConstMatches.length;

	// Match package exports via package statement (counts as 1)
	const packageMatch = processed.match(/^\s*package\s+\w+/m);
	if (packageMatch) count += 1;

	return count;
}

/**
 * Get export count for a file based on extension
 */
function getExportCountForFile(filePath: string): number {
	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		const ext = path.extname(filePath).toLowerCase();

		switch (ext) {
			case '.ts':
			case '.tsx':
			case '.js':
			case '.jsx':
			case '.mjs':
			case '.cjs':
				return countExportsInFile(content);
			case '.py':
				return countPythonExports(content);
			case '.rs':
				return countRustExports(content);
			case '.go':
				return countGoExports(content);
			default:
				return countExportsInFile(content); // Default to JS-like counting
		}
	} catch {
		return 0;
	}
}

/**
 * Compute public API delta for changed files.
 *
 * True base-versus-head difference (issue #2470 / #1655), mirroring
 * computeComplexityDelta: head export count minus merge-base export count per
 * file; deleted files subtract their base exports.
 */
async function computePublicApiDelta(
	files: string[],
	workingDir: string,
	baseContents: ReadonlyMap<string, string | null>,
): Promise<{ delta: number; analyzedFiles: string[] }> {
	let delta = 0;
	const analyzedFiles: string[] = [];

	for (const file of files) {
		const fullPath = path.isAbsolute(file) ? file : path.join(workingDir, file);
		const baseContent = baseContents.get(file) ?? null;

		// Check if file exists
		if (!fs.existsSync(fullPath)) {
			// Deleted file: the change removes its base API surface.
			if (baseContent !== null) {
				delta -= countExportsInFile(baseContent);
			}
			continue;
		}

		const exports = getExportCountForFile(fullPath);
		delta +=
			exports - (baseContent !== null ? countExportsInFile(baseContent) : 0);
		analyzedFiles.push(file);
	}

	return { delta, analyzedFiles };
}

// ============ Duplication Detection ============

/**
 * Tokenize code into n-grams (reserved for future n-gram-based duplication detection)
 */
function _tokenizeToNGrams(content: string, n: number): string[] {
	// Normalize whitespace
	const normalized = content.replace(/\s+/g, ' ').trim();

	// Split into tokens (words and symbols)
	const tokens = normalized
		.split(/([\s+\-*/=(){}[\]<>.,;])/)
		.filter((t) => t.trim().length > 0);

	// Generate n-grams
	const ngrams: string[] = [];
	for (let i = 0; i <= tokens.length - n; i++) {
		ngrams.push(tokens.slice(i, i + n).join('|'));
	}

	return ngrams;
}

/**
 * Find duplicate lines using a sliding-window approach.
 *
 * NOTE: Sliding windows overlap by design — a file with N repetitions of the
 * same minLines-sized block will count (N - 1) * minLines duplicate lines per
 * unique window, which may overcount relative to the true amount of non-original
 * content. This is acceptable for a heuristic metric; the ratio is capped at
 * lines.length to prevent impossible values.
 */
function findDuplicateLines(content: string, minLines: number): number {
	const lines = content.split('\n').filter((line) => line.trim().length > 0);

	if (lines.length < minLines) {
		return 0;
	}

	const normalizedLines = lines.map((line) => line.trim());
	const windowCounts = new Map<string, number>();
	for (let i = 0; i <= normalizedLines.length - minLines; i++) {
		const window = normalizedLines.slice(i, i + minLines).join('\n');
		windowCounts.set(window, (windowCounts.get(window) || 0) + 1);
	}

	let duplicateCount = 0;
	for (const [_window, count] of windowCounts) {
		if (count > 1) {
			duplicateCount += (count - 1) * minLines;
		}
	}

	return Math.min(duplicateCount, lines.length);
}

/**
 * Compute duplication ratio for files
 */
async function computeDuplicationRatio(
	files: string[],
	workingDir: string,
): Promise<{ ratio: number; analyzedFiles: string[] }> {
	let totalLines = 0;
	let duplicateLines = 0;
	const analyzedFiles: string[] = [];

	for (const file of files) {
		const fullPath = path.isAbsolute(file) ? file : path.join(workingDir, file);

		// Check if file exists
		if (!fs.existsSync(fullPath)) {
			continue;
		}

		try {
			const stat = fs.statSync(fullPath);
			if (stat.size > MAX_FILE_SIZE_BYTES) {
				continue;
			}

			const content = fs.readFileSync(fullPath, 'utf-8');
			const lines = content
				.split('\n')
				.filter((line) => line.trim().length > 0);

			if (lines.length < MIN_DUPLICATION_LINES) {
				analyzedFiles.push(file);
				continue;
			}

			totalLines += lines.length;
			duplicateLines += findDuplicateLines(content, MIN_DUPLICATION_LINES);
			analyzedFiles.push(file);
		} catch {}
	}

	const ratio = totalLines > 0 ? duplicateLines / totalLines : 0;
	return { ratio, analyzedFiles };
}

// ============ Test-to-Code Ratio ============

/**
 * Count lines in a file (non-empty, non-comment)
 */
function countCodeLines(content: string): number {
	// Remove block comments /* ... */
	let processed = content.replace(/\/\*[\s\S]*?\*\//g, '');

	// Remove line comments //
	processed = processed.replace(/\/\/.*/g, '');

	// Remove Python comments #
	processed = processed.replace(/#.*/g, '');

	// Count non-empty lines
	const lines = processed.split('\n').filter((line) => line.trim().length > 0);
	return lines.length;
}

/**
 * Check if a file is a test file
 */
function isTestFile(filePath: string): boolean {
	const basename = path.basename(filePath);
	const _ext = path.extname(filePath).toLowerCase();

	// Check common test patterns
	const testPatterns = [
		'.test.',
		'.spec.',
		'.tests.',
		'.test.ts',
		'.test.js',
		'.spec.ts',
		'.spec.js',
		'.test.tsx',
		'.test.jsx',
		'.spec.tsx',
		'.spec.jsx',
	];

	for (const pattern of testPatterns) {
		if (basename.includes(pattern)) {
			return true;
		}
	}

	// Check if in tests directory
	const normalizedPath = filePath.replace(/\\/g, '/');
	if (normalizedPath.includes('/tests/') || normalizedPath.includes('/test/')) {
		return true;
	}

	// Check __tests__ directory
	if (normalizedPath.includes('/__tests__/')) {
		return true;
	}

	return false;
}

/**
 * Check if a glob segment matches a path segment (handles * wildcards within segment)
 */
function matchSegment(globSeg: string, pathSeg: string): boolean {
	// ** is handled at the segment level, not here
	if (globSeg === '**') {
		// This shouldn't happen - ** should be handled by the main loop
		return false;
	}

	// Literal match
	if (globSeg === pathSeg) {
		return true;
	}

	// Check if segment contains glob wildcards
	if (globSeg.includes('*')) {
		// Convert glob segment to regex
		// * matches zero or more characters within the segment (not across /)
		let pattern = globSeg;
		// Escape regex metacharacters except *
		pattern = pattern.replace(/[[\](){}|+?^$.\\]/g, '\\$&');
		// Replace * with regex that matches zero or more chars
		pattern = pattern.replace(/\*/g, '.*');
		// Anchor to match entire segment
		const regex = new RegExp(`^${pattern}$`);
		return regex.test(pathSeg);
	}

	return false;
}

/**
 * Segment-based glob matcher for patterns with **
 * Splits glob and path by / and matches segment by segment
 * Handles ** semantics: zero-or-more segments, without crossing malformed empty segments
 */
function matchGlobSegment(
	globSegments: string[],
	pathSegments: string[],
): boolean {
	// Reject paths with empty segments (//)
	if (pathSegments.some((s) => s === '')) {
		return false;
	}

	let gIndex = 0;
	let pIndex = 0;

	while (gIndex < globSegments.length && pIndex < pathSegments.length) {
		const globSeg = globSegments[gIndex];

		if (globSeg === '**') {
			// ** matches zero or more directory segments
			// Try matching zero segments first (skip ** and continue)
			if (
				matchGlobSegment(
					globSegments.slice(gIndex + 1),
					pathSegments.slice(pIndex),
				)
			) {
				return true;
			}
			// Try matching one or more segments with **
			// For each possible split point, check if the rest matches
			// This ensures ** doesn't cross invalid boundaries
			for (let i = pIndex; i < pathSegments.length; i++) {
				// Try consuming pathSegments[pIndex] through pathSegments[i] (inclusive)
				// by slicing from i+1
				if (
					matchGlobSegment(
						globSegments.slice(gIndex + 1),
						pathSegments.slice(i + 1),
					)
				) {
					return true;
				}
			}
			// No match found for this ** position
			return false;
		} else if (globSeg === '*') {
			// * matches exactly one non-empty segment
			if (pathSegments[pIndex] === '') {
				return false;
			}
			gIndex++;
			pIndex++;
		} else {
			// Literal segment or segment with * wildcards - use matchSegment
			if (!matchSegment(globSeg, pathSegments[pIndex])) {
				return false;
			}
			gIndex++;
			pIndex++;
		}
	}

	// Handle trailing ** (which can match zero segments)
	while (gIndex < globSegments.length && globSegments[gIndex] === '**') {
		gIndex++;
	}

	// Both must be exhausted for a match
	return gIndex === globSegments.length && pIndex === pathSegments.length;
}

/**
 * Check if a path matches a glob pattern using segment-based matching
 * This handles ** correctly without regex edge cases
 * Ensures ** semantics: zero-or-more segments, without crossing malformed empty segments
 */
function matchesGlobSegment(path: string, glob: string): boolean {
	// Normalize path separators
	const normalizedPath = path.replace(/\\/g, '/');
	const normalizedGlob = glob.replace(/\\/g, '/');

	// Reject paths with empty segments early - they can never match
	if (normalizedPath.includes('//')) {
		return false;
	}

	// Reject globs with empty segments (malformed patterns)
	if (normalizedGlob.includes('//')) {
		return false;
	}

	// Split into segments (filter out empty segments for matching)
	const pathSegments = normalizedPath.split('/').filter((s) => s !== '');
	const globSegments = normalizedGlob.split('/').filter((s) => s !== '');

	// Handle empty glob - matches everything
	if (globSegments.length === 0) {
		return true;
	}

	// Handle bare ** glob - matches everything
	if (globSegments.length === 1 && globSegments[0] === '**') {
		return true;
	}

	return matchGlobSegment(globSegments, pathSegments);
}

/**
 * Convert a simple glob pattern (without **) to a regex
 * Ensures * doesn't cross path separators
 */
function simpleGlobToRegex(glob: string): RegExp {
	// Handle empty glob - matches everything
	if (!glob) {
		return /.*/;
	}

	let pattern = glob;

	// Escape regex metacharacters except *
	const regexMetacharacters = /[[\](){}|+?^$.\\]/g;
	pattern = pattern.replace(regexMetacharacters, '\\$&');

	// Replace * with [^/]+ (one or more non-slash characters)
	// This ensures * doesn't cross path separators
	pattern = pattern.replace(/\*/g, '[^/]+');

	return new RegExp(`^${pattern}$`);
}

/**
 * Check if glob contains **
 */
function hasGlobstar(glob: string): boolean {
	return glob.includes('**');
}

/**
 * Check if a path matches a glob pattern
 * Uses segment-based matching for patterns with **, regex for simpler patterns
 * Ensures ** semantics: zero-or-more segments, without crossing malformed empty segments
 */
function globMatches(path: string, glob: string): boolean {
	// Normalize path
	const normalizedPath = path.replace(/\\/g, '/');

	// Handle empty glob - matches all paths (but reject paths with //)
	if (!glob || glob === '') {
		// Reject paths with empty segments
		if (normalizedPath.includes('//')) {
			return false;
		}
		return true;
	}

	// Handle trailing backslash in glob - treat as literal (or ignore)
	const normalizedGlob = glob.endsWith('\\') ? glob.slice(0, -1) : glob;

	// Reject paths/globs with empty segments for matching decisions
	if (normalizedPath.includes('//') || normalizedGlob.includes('//')) {
		return false;
	}

	// Use segment-based matching for patterns with **
	if (hasGlobstar(normalizedGlob)) {
		return matchesGlobSegment(normalizedPath, normalizedGlob);
	}

	// Use simple regex for patterns without **
	const regex = simpleGlobToRegex(normalizedGlob);
	return regex.test(normalizedPath);
}

/**
 * Convert a glob pattern to a regex for path matching
 * - ** matches any number of directories (zero or more)
 * - * matches any characters within a single path segment
 * - . is escaped
 * - Regex metacharacters are escaped to avoid SyntaxError
 * @deprecated Use globMatches() instead for reliable globstar handling
 */
function _globToRegex(glob: string): RegExp {
	// Handle empty glob - matches everything
	if (!glob) {
		return /.*/;
	}

	// Use placeholder to protect ** during processing
	const placeholder = '\x00';

	let pattern = glob;

	// Handle trailing backslash - escape it to prevent regex errors
	// A trailing \ in glob should be treated as literal backslash
	if (pattern.endsWith('\\')) {
		pattern = `${pattern.slice(0, -1)}\\\\`;
	}

	// Check if pattern contains ** - we'll use different anchoring
	const hasGlobstar = pattern.includes('**');

	// Step 1: Replace ** with placeholder (preserve for later)
	pattern = pattern.replace(/\*\*/g, placeholder);

	// Step 2: Escape regex metacharacters (but not * which is now placeholder)
	// These must be escaped: [ ] ( ) + ? | ^ $ { } . \
	// Note: / doesn't need escaping in regex
	const regexMetacharacters = /[[\](){}|+?^$.\\]/g;
	pattern = pattern.replace(regexMetacharacters, '\\$&');

	// Step 3: Replace remaining single * (original glob star) with [^/]*
	// Zero or more non-slash characters
	pattern = pattern.replace(/\*/g, '[^/]*');

	// Step 4: Replace ** placeholder with .*? (non-greedy zero-or-more)
	// This allows ** to match zero or more directory segments, so src/**/*.ts matches src/file.ts
	pattern = pattern.replace(new RegExp(placeholder, 'g'), '.*?');

	// Special handling: for patterns with **, make trailing segment optional
	// to allow zero trailing path segments (e.g., src/** should match src/ and src)
	// Use (?:/.*)? to optionally match / followed by anything
	if (hasGlobstar) {
		// Replace trailing .*? with (?:/.*)? to allow zero trailing segments
		// This fixes src/** matching src/ and src, while preserving directory boundaries
		pattern = pattern.replace(/\.\*\?$/, '(?:/.*)?');
	}

	// Anchor based on whether pattern contains **
	// If no **, anchor both ends (to prevent * from matching across /)
	// If has **, DON'T anchor - allows finding literals anywhere in string
	if (!hasGlobstar) {
		return new RegExp(`^${pattern}$`);
	}

	// For ** patterns, use unanchored regex
	// This allows **/src/** to match src/file
	return new RegExp(pattern);
}

/**
 * Check if file should be excluded from analysis
 * Ensures ** semantics: zero-or-more segments, without crossing malformed empty segments
 */
function shouldExcludeFile(filePath: string, excludeGlobs: string[]): boolean {
	const normalizedPath = filePath.replace(/\\/g, '/');

	// Reject paths with empty segments (//) as they can never match
	if (normalizedPath.includes('//')) {
		return false;
	}

	for (const glob of excludeGlobs) {
		// Skip malformed globs with //
		const normalizedGlob = glob.replace(/\\/g, '/');
		if (normalizedGlob.includes('//')) {
			continue;
		}
		if (globMatches(normalizedPath, glob)) {
			return true;
		}
	}

	return false;
}

/**
 * Compute test-to-code ratio
 */
async function computeTestToCodeRatio(
	workingDir: string,
	enforceGlobs: string[],
	excludeGlobs: string[],
): Promise<{ ratio: number; testLines: number; codeLines: number }> {
	let testLines = 0;
	let codeLines = 0;

	// Scan src directory for production code
	const srcDir = path.join(workingDir, 'src');
	if (fs.existsSync(srcDir)) {
		await scanDirectoryForLines(
			srcDir,
			enforceGlobs,
			excludeGlobs,
			false,
			(lines) => {
				codeLines += lines;
			},
		);
	}

	// Also check other source directories
	const possibleSrcDirs = ['lib', 'app', 'source', 'core'];
	for (const dir of possibleSrcDirs) {
		const dirPath = path.join(workingDir, dir);
		if (fs.existsSync(dirPath)) {
			await scanDirectoryForLines(
				dirPath,
				enforceGlobs,
				excludeGlobs,
				false,
				(lines) => {
					codeLines += lines;
				},
			);
		}
	}

	// Scan tests directory for test code
	const testsDir = path.join(workingDir, 'tests');
	if (fs.existsSync(testsDir)) {
		await scanDirectoryForLines(
			testsDir,
			['**'],
			['node_modules', 'dist'],
			true,
			(lines) => {
				testLines += lines;
			},
		);
	}

	// Also check test patterns in other locations
	const possibleTestDirs = ['test', '__tests__', 'specs'];
	for (const dir of possibleTestDirs) {
		const dirPath = path.join(workingDir, dir);
		if (fs.existsSync(dirPath) && dirPath !== testsDir) {
			await scanDirectoryForLines(
				dirPath,
				['**'],
				['node_modules', 'dist'],
				true,
				(lines) => {
					testLines += lines;
				},
			);
		}
	}

	const totalLines = testLines + codeLines;
	const ratio = totalLines > 0 ? testLines / totalLines : 0;

	return { ratio, testLines, codeLines };
}

/**
 * Recursively scan directory and count lines
 */
async function scanDirectoryForLines(
	dirPath: string,
	includeGlobs: string[],
	excludeGlobs: string[],
	isTestScan: boolean,
	callback: (lines: number) => void,
): Promise<void> {
	try {
		const entries = fs.readdirSync(dirPath, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(dirPath, entry.name);

			if (entry.isDirectory()) {
				// Skip excluded directories
				if (
					entry.name === 'node_modules' ||
					entry.name === 'dist' ||
					entry.name === 'build' ||
					entry.name === '.git'
				) {
					continue;
				}
				await scanDirectoryForLines(
					fullPath,
					includeGlobs,
					excludeGlobs,
					isTestScan,
					callback,
				);
			} else if (entry.isFile()) {
				// Check if it matches include patterns
				const relativePath = fullPath.replace(`${dirPath}/`, '');

				// Skip files that don't match extension
				const ext = path.extname(entry.name).toLowerCase();
				const validExts = [
					'.ts',
					'.tsx',
					'.js',
					'.jsx',
					'.py',
					'.rs',
					'.go',
					'.java',
					'.cs',
				];
				if (!validExts.includes(ext)) {
					continue;
				}

				// For test scan, only count test files
				if (isTestScan && !isTestFile(fullPath)) {
					continue;
				}

				// For code scan, skip test files
				if (!isTestScan && isTestFile(fullPath)) {
					continue;
				}

				// Check exclusions
				if (shouldExcludeFile(relativePath, excludeGlobs)) {
					continue;
				}

				// Check inclusions (if not test scan)
				if (
					!isTestScan &&
					includeGlobs.length > 0 &&
					!includeGlobs.includes('**')
				) {
					let matches = false;
					for (const glob of includeGlobs) {
						if (globMatches(relativePath, glob)) {
							matches = true;
							break;
						}
					}
					if (!matches) continue;
				}

				try {
					const content = fs.readFileSync(fullPath, 'utf-8');
					const lines = countCodeLines(content);
					callback(lines);
				} catch {
					// Skip files that can't be read
				}
			}
		}
	} catch {
		// Directory doesn't exist or can't be read
	}
}

// ============ Violation Detection ============

/**
 * Detect violations based on metrics and thresholds
 */
function detectViolations(
	metrics: QualityMetrics,
	thresholds: QualityBudgetConfig,
): QualityViolation[] {
	const violations: QualityViolation[] = [];

	// Check complexity delta
	if (metrics.complexity_delta > thresholds.max_complexity_delta) {
		violations.push({
			type: 'complexity',
			message: `Complexity delta (${metrics.complexity_delta}) exceeds threshold (${thresholds.max_complexity_delta})`,
			severity:
				metrics.complexity_delta > thresholds.max_complexity_delta * 1.5
					? 'error'
					: 'warning',
			files: metrics.files_analyzed,
		});
	}

	// Check public API delta
	if (metrics.public_api_delta > thresholds.max_public_api_delta) {
		violations.push({
			type: 'api',
			message: `Public API delta (${metrics.public_api_delta}) exceeds threshold (${thresholds.max_public_api_delta})`,
			severity:
				metrics.public_api_delta > thresholds.max_public_api_delta * 1.5
					? 'error'
					: 'warning',
			files: metrics.files_analyzed,
		});
	}

	// Check duplication ratio
	if (metrics.duplication_ratio > thresholds.max_duplication_ratio) {
		violations.push({
			type: 'duplication',
			message: `Duplication ratio (${(metrics.duplication_ratio * 100).toFixed(1)}%) exceeds threshold (${(thresholds.max_duplication_ratio * 100).toFixed(1)}%)`,
			severity:
				metrics.duplication_ratio > thresholds.max_duplication_ratio * 1.5
					? 'error'
					: 'warning',
			files: metrics.files_analyzed,
		});
	}

	// Check test-to-code ratio - only if there are files analyzed
	// and there's actual production code in the project
	if (
		metrics.files_analyzed.length > 0 &&
		metrics.test_to_code_ratio < thresholds.min_test_to_code_ratio
	) {
		violations.push({
			type: 'test_ratio',
			message: `Test-to-code ratio (${(metrics.test_to_code_ratio * 100).toFixed(1)}%) below threshold (${(thresholds.min_test_to_code_ratio * 100).toFixed(1)}%)`,
			severity:
				metrics.test_to_code_ratio < thresholds.min_test_to_code_ratio * 0.5
					? 'error'
					: 'warning',
			files: metrics.files_analyzed,
		});
	}

	return violations;
}

/**
 * Load the merge-base content of every changed file once, shared by the
 * complexity and public-API delta computations.
 *
 * Returns an empty map when no merge base resolves (not a git repo, no
 * candidate branch) — callers then treat every file as having no base, which
 * reproduces the historical head-only absolute metrics. Files beyond
 * MAX_BASE_FILE_READS also fall back to no-base (conservative: their full
 * head complexity counts toward the delta).
 */
async function loadBaseFileContents(
	files: string[],
	workingDir: string,
): Promise<Map<string, string | null>> {
	const baseContents = new Map<string, string | null>();
	if (files.length === 0) return baseContents;

	const baseRef = await resolveQualityMergeBase(workingDir);
	if (!baseRef) return baseContents;

	let read = 0;
	let capped = false;
	for (const file of files) {
		if (read >= MAX_BASE_FILE_READS) {
			capped = true;
			break;
		}
		baseContents.set(
			file,
			await readBaseFileContent(workingDir, baseRef, file),
		);
		read++;
	}
	if (capped) {
		logger.warn(
			`[quality-metrics] More than ${MAX_BASE_FILE_READS} changed files — ` +
				`base-version reads capped; remaining files count full head complexity toward the delta.`,
		);
	}
	return baseContents;
}

// ============ Main Function ============

/**
 * Compute quality metrics for changed files
 */
export async function computeQualityMetrics(
	changedFiles: string[],
	thresholds: QualityBudgetConfig,
	workingDir: string,
): Promise<QualityMetrics> {
	// Get defaults if not provided
	const config: QualityBudgetConfig = {
		enabled: thresholds.enabled ?? true,
		max_complexity_delta: thresholds.max_complexity_delta ?? 5,
		max_public_api_delta: thresholds.max_public_api_delta ?? 10,
		max_duplication_ratio: thresholds.max_duplication_ratio ?? 0.05,
		min_test_to_code_ratio: thresholds.min_test_to_code_ratio ?? 0.3,
		enforce_on_globs: thresholds.enforce_on_globs ?? ['src/**'],
		exclude_globs: thresholds.exclude_globs ?? [
			'docs/**',
			'tests/**',
			'**/*.test.*',
		],
	};

	// Filter changed files to only include those matching enforce globs
	const filteredFiles = changedFiles.filter((file) => {
		const normalizedPath = file.replace(/\\/g, '/');
		for (const glob of config.enforce_on_globs) {
			if (globMatches(normalizedPath, glob)) {
				// Check exclusions
				for (const exclude of config.exclude_globs) {
					if (globMatches(normalizedPath, exclude)) {
						return false;
					}
				}
				return true;
			}
		}
		return false;
	});

	// Load merge-base content once for both delta computations (issue #2470).
	// Empty when no merge base resolves — files then keep head-only metrics.
	const baseContents = await loadBaseFileContents(filteredFiles, workingDir);

	// Compute all metrics
	const [complexityResult, apiResult, duplicationResult, testRatioResult] =
		await Promise.all([
			computeComplexityDelta(filteredFiles, workingDir, baseContents),
			computePublicApiDelta(filteredFiles, workingDir, baseContents),
			computeDuplicationRatio(filteredFiles, workingDir),
			computeTestToCodeRatio(
				workingDir,
				config.enforce_on_globs,
				config.exclude_globs,
			),
		]);

	// Combine analyzed files
	const allAnalyzedFiles = [
		...new Set([
			...complexityResult.analyzedFiles,
			...apiResult.analyzedFiles,
			...duplicationResult.analyzedFiles,
		]),
	];

	// Detect violations
	const violations = detectViolations(
		{
			complexity_delta: complexityResult.delta,
			public_api_delta: apiResult.delta,
			duplication_ratio: duplicationResult.ratio,
			test_to_code_ratio: testRatioResult.ratio,
			files_analyzed: allAnalyzedFiles,
			thresholds: config,
			violations: [],
		},
		config,
	);

	return {
		complexity_delta: complexityResult.delta,
		public_api_delta: apiResult.delta,
		duplication_ratio: duplicationResult.ratio,
		test_to_code_ratio: testRatioResult.ratio,
		files_analyzed: allAnalyzedFiles,
		thresholds: config,
		violations,
	};
}
