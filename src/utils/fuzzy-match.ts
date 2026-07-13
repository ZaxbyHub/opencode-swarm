/**
 * Fuzzy text-matching engine — faithful TypeScript port of hermes-agent's
 * `tools/fuzzy_match.py` (issue #1718).
 *
 * Implements a 9-strategy matching chain that finds and replaces text,
 * tolerating the whitespace, indentation, escape-sequence, and Unicode
 * drift common in LLM-generated patches. Integrated into `apply-patch`
 * as an **opt-in fallback** (default off) gated by the `apply_patch.fuzzy_match`
 * and `apply_patch.fuzzy_match_context_aware` config flags.
 *
 * Porting conventions:
 * - Operates on **UTF-16 code units** consistently (`s[i]`, `s.length`).
 *   Matches `src/utils/sequence-matcher.ts`. Round-trip safe.
 * - Per-line stripping uses JS `String.prototype.trim()`, which strips the
 *   Unicode WhiteSpace + LineTerminator set. Coincides with Python
 *   `str.strip()` for the ASCII/BMP content in the test suite; minor
 *   divergence on exotic whitespace categories is acceptable.
 * - Strategy 9 (`contextAware`) is opt-in via the `includeContextAware`
 *   option to `fuzzyFindAndReplace`. It is the loosest, most-false-positive-
 *   prone strategy and is separately gated in apply-patch by
 *   `apply_patch.fuzzy_match_context_aware`.
 */

import { SequenceMatcher } from './sequence-matcher';

/** A `[start, end)` character span in the content string. */
type Span = [number, number];

/** Result of {@link fuzzyFindAndReplace}. */
export interface FuzzyResult {
	/** Modified content on success; original content on failure. */
	content: string;
	/** Number of replacements made (0 on failure). */
	matchCount: number;
	/** Name of the strategy that matched, or `null` on failure. */
	strategy: string | null;
	/** `null` on success; an error description on failure. */
	error: string | null;
}

/** Options for {@link fuzzyFindAndReplace}. */
export interface FuzzyOptions {
	/**
	 * When true (default), the `context_aware` strategy (9) is included in the
	 * chain. Strategy 9 is the loosest/most-false-positive-prone strategy
	 * (50% line similarity), so the `apply-patch` integration passes `false`
	 * unless the separate `apply_patch.fuzzy_match_context_aware` flag is set.
	 *
	 * The utility itself defaults it to `true` so the byte-faithful ported
	 * hermes test suite passes unmodified — strategy 9 is a legitimate part
	 * of the matching chain and several test cases depend on it.
	 */
	includeContextAware?: boolean;
}

// =============================================================================
// Unicode normalization (strategy 7)
// =============================================================================

/**
 * Maps Unicode typographic characters to their ASCII equivalents.
 * Some replacements EXPAND a single code point into multiple ASCII chars
 * (em-dash → "--", ellipsis → "..."); the position-remap helpers handle the
 * resulting offset divergence.
 */
export const UNICODE_MAP: Record<string, string> = {
	'\u201c': '"', // left double quotation mark
	'\u201d': '"', // right double quotation mark
	'\u2018': "'", // left single quotation mark
	'\u2019': "'", // right single quotation mark
	'\u2014': '--', // em dash
	'\u2013': '-', // en dash
	'\u2026': '...', // horizontal ellipsis
	'\u00a0': ' ', // no-break space
};

/** Normalize Unicode typographic characters to ASCII equivalents. */
export function unicodeNormalize(text: string): string {
	let out = text;
	for (const [char, repl] of Object.entries(UNICODE_MAP)) {
		out = out.split(char).join(repl);
	}
	return out;
}

// =============================================================================
// Whitespace / indent helpers
// =============================================================================

/** Return the leading spaces/tabs prefix of a line. */
function leadingWhitespace(line: string): string {
	let i = 0;
	while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
	return line.slice(0, i);
}

/** First line of `text` with non-whitespace content, or `null` if none. */
function firstMeaningfulLine(text: string): string | null {
	for (const line of text.split('\n')) {
		if (line.trim()) return line;
	}
	return null;
}

// =============================================================================
// Public entry: fuzzyFindAndReplace
// =============================================================================

/**
 * Find and replace text using a chain of increasingly fuzzy strategies.
 *
 * Strategies are tried in order; the first that yields matches wins. On a
 * unique match (or when `replaceAll` is true), the replacement is applied.
 * On failure, returns the original content with an error description.
 *
 * Guards (ported verbatim from hermes):
 * - Ambiguity: `>1 match && !replaceAll` → fail with a helpful message.
 * - Escape-drift: `\'`/`\"` present in both old+new but absent from the
 *   matched file region → block (transport serialization artifact).
 * - Selective unescape: `\t`/`\r` in new_string → real bytes only when the
 *   matched file region contains the corresponding control char. `\n` excluded.
 * - Unicode preservation: under strategy 7, unchanged spans keep the file's
 *   original Unicode characters rather than the ASCII-normalized equivalents.
 */
export function fuzzyFindAndReplace(
	content: string,
	oldString: string,
	newString: string,
	replaceAll = false,
	options: FuzzyOptions = {},
): FuzzyResult {
	if (!oldString) {
		return { content, matchCount: 0, strategy: null, error: 'old_string cannot be empty' };
	}
	if (oldString === newString) {
		return {
			content,
			matchCount: 0,
			strategy: null,
			error: 'old_string and new_string are identical',
		};
	}

	type StrategyEntry = [string, (content: string, pattern: string) => Span[]];
	const strategies: StrategyEntry[] = [
		['exact', strategyExact],
		['line_trimmed', strategyLineTrimmed],
		['whitespace_normalized', strategyWhitespaceNormalized],
		['indentation_flexible', strategyIndentationFlexible],
		['escape_normalized', strategyEscapeNormalized],
		['trimmed_boundary', strategyTrimmedBoundary],
		['unicode_normalized', strategyUnicodeNormalized],
		['block_anchor', strategyBlockAnchor],
	];
	if (options.includeContextAware !== false) {
		strategies.push(['context_aware', strategyContextAware]);
	}

	for (const [strategyName, strategyFn] of strategies) {
		const matches = strategyFn(content, oldString);
		if (matches.length === 0) continue;

		// Ambiguity guard.
		if (matches.length > 1 && !replaceAll) {
			return {
				content,
				matchCount: 0,
				strategy: null,
				error: `Found ${matches.length} matches for old_string. Provide more context to make it unique, or use replace_all=true.`,
			};
		}

		// Escape-drift guard (skipped for exact matches).
		if (strategyName !== 'exact') {
			const driftErr = detectEscapeDrift(content, matches, oldString, newString);
			if (driftErr) {
				return { content, matchCount: 0, strategy: null, error: driftErr };
			}
		}

		// Selective unescape of \t / \r in new_string based on the matched region.
		let effectiveNew = maybeUnescapeNewString(newString, content, matches);

		// Unicode preservation under strategy 7.
		if (strategyName === 'unicode_normalized') {
			effectiveNew = preserveUnicodeInReplacement(content, matches, oldString, effectiveNew);
		}

		const newContent = applyReplacements(
			content,
			matches,
			effectiveNew,
			strategyName !== 'exact' ? oldString : null,
		);
		return { content: newContent, matchCount: matches.length, strategy: strategyName, error: null };
	}

	return {
		content,
		matchCount: 0,
		strategy: null,
		error: 'Could not find a match for old_string in the file',
	};
}

// =============================================================================
// Guards and replacement-shaping helpers
// =============================================================================

/**
 * Detect tool-call escape-drift artifacts in new_string.
 *
 * Looks for `\'` or `\"` sequences present in BOTH old_string and new_string
 * (i.e. the model intended to preserve them) but absent from the matched file
 * region. That pattern indicates the transport layer inserted spurious
 * shell-style escapes; writing new_string verbatim would insert literal `\'`.
 */
function detectEscapeDrift(
	content: string,
	matches: Span[],
	oldString: string,
	newString: string,
): string | null {
	// Cheap pre-check.
	if (!newString.includes("\\'") && !newString.includes('\\"')) return null;

	let matchedRegions = '';
	for (const [start, end] of matches) matchedRegions += content.slice(start, end);

	for (const suspect of ["\\'", '\\"'] as const) {
		if (newString.includes(suspect) && oldString.includes(suspect) && !matchedRegions.includes(suspect)) {
			const plain = suspect[1]; // "'" or '"'
			return (
				`Escape-drift detected: old_string and new_string contain the literal sequence ` +
				`${JSON.stringify(suspect)} but the matched region of the file does not. This is almost ` +
				`always a tool-call serialization artifact where an apostrophe or quote got prefixed ` +
				`with a spurious backslash. Re-read the file with read_file and pass ` +
				`old_string/new_string without backslash-escaping ${JSON.stringify(plain)} characters.`
			);
		}
	}
	return null;
}

/**
 * Conditionally unescape `\t`/`\r` in new_string.
 *
 * LLMs frequently send the two-character sequences `\t` and `\r` inside JSON
 * tool-call arguments where they meant real control bytes. The unescape is
 * applied per-sequence only when the matched file region actually contains the
 * corresponding control byte. `\n` is intentionally excluded (newlines
 * serialize correctly through JSON).
 */
function maybeUnescapeNewString(newString: string, content: string, matches: Span[]): string {
	if (!newString.includes('\\t') && !newString.includes('\\r')) return newString;
	let matchedRegions = '';
	for (const [start, end] of matches) matchedRegions += content.slice(start, end);
	let out = newString;
	if (out.includes('\\t') && matchedRegions.includes('\t')) {
		out = out.split('\\t').join('\t');
	}
	if (out.includes('\\r') && matchedRegions.includes('\r')) {
		out = out.split('\\r').join('\r');
	}
	return out;
}

/**
 * Adjust `newString` so its indentation matches the file region.
 *
 * After a non-exact match, the LLM's old_string/new_string may use a different
 * indent style than the file (e.g. 2-space vs 4-space). This re-indents each
 * non-blank line by swapping the LLM's base indent prefix for the file's actual
 * base indent prefix, preserving relative nesting. No-op when the base indents
 * already match.
 */
function reindentReplacement(fileRegion: string, oldString: string, newString: string): string {
	if (!newString) return newString;

	const oldFirst = firstMeaningfulLine(oldString);
	const fileFirst = firstMeaningfulLine(fileRegion);
	if (oldFirst === null || fileFirst === null) return newString;

	const oldIndent = leadingWhitespace(oldFirst);
	const fileIndent = leadingWhitespace(fileFirst);
	if (oldIndent === fileIndent) return newString;

	const outLines: string[] = [];
	for (const line of newString.split('\n')) {
		if (!line.trim()) {
			// Blank lines: leave whitespace untouched.
			outLines.push(line);
			continue;
		}
		const lineIndent = leadingWhitespace(line);
		if (lineIndent.startsWith(oldIndent)) {
			// Common case: line has the LLM's base indent (possibly + extra).
			const remainder = line.slice(oldIndent.length);
			outLines.push(fileIndent + remainder);
		} else {
			// Line is less-indented than the LLM's base — anchor to file's base.
			outLines.push(fileIndent + line.replace(/^[ \t]+/, ''));
		}
	}
	return outLines.join('\n');
}

/**
 * Preserve Unicode characters from the file in the replacement string.
 *
 * Under strategy 7 (unicode_normalized), the file has Unicode characters but
 * old/new from the LLM are ASCII equivalents. Writing new_string verbatim
 * would silently corrupt the file's Unicode. This diffs norm_old → new_string
 * via SequenceMatcher and applies only the actual edits to the file's original
 * text, preserving Unicode for unchanged spans.
 */
function preserveUnicodeInReplacement(
	content: string,
	matches: Span[],
	oldString: string,
	newString: string,
): string {
	let fileRegion = '';
	for (const [start, end] of matches) fileRegion += content.slice(start, end);

	const normOld = unicodeNormalize(oldString);
	const normFile = unicodeNormalize(fileRegion);

	// If the normalized forms don't match, fall back to direct replacement.
	if (normOld !== normFile) return newString;

	// Build position maps from normalized space back to original space.
	const fileOrigToNorm = buildOrigToNormMap(fileRegion);
	const fileNormToOrig: Map<number, number> = new Map();
	for (let origPos = 0; origPos < fileOrigToNorm.length - 1; origPos++) {
		const np = fileOrigToNorm[origPos];
		if (!fileNormToOrig.has(np)) fileNormToOrig.set(np, origPos);
	}

	const sm = new SequenceMatcher(null, normOld, newString);
	const opcodes = sm.getOpcodes();

	const resultParts: string[] = [];
	for (const op of opcodes) {
		const { tag, i1, i2, j1, j2 } = op;
		if (tag === 'equal') {
			const origStart = fileNormToOrig.get(i1) ?? 0;
			let origEnd = origStart;
			while (origEnd < fileRegion.length && fileOrigToNorm[origEnd] < i2) {
				origEnd++;
			}
			resultParts.push(fileRegion.slice(origStart, origEnd));
		} else if (tag === 'replace') {
			resultParts.push(newString.slice(j1, j2));
		} else if (tag === 'delete') {
			// skip deleted portion
		} else if (tag === 'insert') {
			resultParts.push(newString.slice(j1, j2));
		}
	}
	return resultParts.join('');
}

/**
 * Apply replacements at the given spans.
 *
 * Spans are processed in descending position order so earlier offsets remain
 * valid. When `oldString` is non-null, the match came from a non-exact strategy
 * and `newString` is re-indented to match the file region before substitution.
 */
function applyReplacements(
	content: string,
	matches: Span[],
	newString: string,
	oldString: string | null,
): string {
	const sorted = [...matches].sort((x, y) => y[0] - x[0]);
	let result = content;
	for (const [start, end] of sorted) {
		const adjusted = oldString !== null
			? reindentReplacement(content.slice(start, end), oldString, newString)
			: newString;
		result = result.slice(0, start) + adjusted + result.slice(end);
	}
	return result;
}

// =============================================================================
// Position-remap helpers
// =============================================================================

/**
 * Map each original character index to its normalized index.
 *
 * Because UNICODE_MAP replacements may expand a single character into multiple
 * ASCII chars, the normalized string can be longer than the original. The
 * returned array has length `original.length + 1`; entry `i` is the normalized
 * index that original character `i` maps to. The final entry is the sentinel
 * (one past the last character).
 */
function buildOrigToNormMap(original: string): number[] {
	const result: number[] = [];
	let normPos = 0;
	for (let i = 0; i < original.length; i++) {
		result.push(normPos);
		const repl = UNICODE_MAP[original[i]];
		normPos += repl !== undefined ? repl.length : 1;
	}
	result.push(normPos);
	return result;
}

/** Convert (start, end) positions in the normalized string to original positions. */
function mapPositionsNormToOrig(origToNorm: number[], normMatches: Span[]): Span[] {
	const normToOrigStart: Map<number, number> = new Map();
	for (let origPos = 0; origPos < origToNorm.length - 1; origPos++) {
		const normPos = origToNorm[origPos];
		if (!normToOrigStart.has(normPos)) normToOrigStart.set(normPos, origPos);
	}

	const results: Span[] = [];
	const origLen = origToNorm.length - 1;
	for (const [normStart, normEnd] of normMatches) {
		if (!normToOrigStart.has(normStart)) continue;
		const origStart = normToOrigStart.get(normStart)!;
		let origEnd = origStart;
		while (origEnd < origLen && origToNorm[origEnd] < normEnd) origEnd++;
		results.push([origStart, origEnd]);
	}
	return results;
}

/**
 * Calculate start/end character positions from line indices.
 *
 * Lines are assumed to be `\n`-separated with no trailing newline in the array
 * form (i.e. `content.split('\n')`). Each line contributes `length + 1` to
 * account for the newline that was the separator.
 */
function calculateLinePositions(
	contentLines: string[],
	startLine: number,
	endLine: number,
	contentLength: number,
): Span {
	let start = 0;
	for (let i = 0; i < startLine; i++) start += contentLines[i].length + 1;
	let end = 0;
	for (let i = 0; i < endLine; i++) end += contentLines[i].length + 1;
	end -= 1; // exclude the trailing newline of the last line
	end = Math.min(contentLength, end);
	return [start, end];
}

/**
 * Find matches in line-normalized content and map back to original positions.
 *
 * Used by strategies that normalize per-line (trim, lstrip): the line-level
 * normalization preserves line count, so original positions are recovered via
 * {@link calculateLinePositions}.
 */
function findNormalizedMatches(
	content: string,
	contentLines: string[],
	contentNormalizedLines: string[],
	patternNormalized: string,
): Span[] {
	const patternNormLines = patternNormalized.split('\n');
	const numPatternLines = patternNormLines.length;
	const matches: Span[] = [];
	for (let i = 0; i <= contentNormalizedLines.length - numPatternLines; i++) {
		const block = contentNormalizedLines.slice(i, i + numPatternLines).join('\n');
		if (block === patternNormalized) {
			const [start, end] = calculateLinePositions(contentLines, i, i + numPatternLines, content.length);
			matches.push([start, end]);
		}
	}
	return matches;
}

/**
 * Map positions from a whitespace-normalized string back to the original.
 *
 * Handles the case where `[ \t]+` was collapsed to a single space. Includes
 * the word-boundary fix: trailing-whitespace expansion happens only when the
 * normalized match itself ends with a space; when it ends with a non-space,
 * the following whitespace in the original is a word boundary and must NOT be
 * consumed.
 */
function mapNormalizedPositions(
	original: string,
	normalized: string,
	normalizedMatches: Span[],
): Span[] {
	if (normalizedMatches.length === 0) return [];

	// Build orig_to_norm: orig_to_norm[i] = normalized position for original char i.
	const origToNorm: number[] = [];
	let origIdx = 0;
	let normIdx = 0;
	while (origIdx < original.length && normIdx < normalized.length) {
		if (original[origIdx] === normalized[normIdx]) {
			origToNorm.push(normIdx);
			origIdx++;
			normIdx++;
		} else if (
			(original[origIdx] === ' ' || original[origIdx] === '\t') &&
			normalized[normIdx] === ' '
		) {
			// Original has space/tab, normalized collapsed to space.
			origToNorm.push(normIdx);
			origIdx++;
			// Don't advance norm_idx until all consecutive whitespace is consumed.
			if (origIdx < original.length && original[origIdx] !== ' ' && original[origIdx] !== '\t') {
				normIdx++;
			}
		} else if (original[origIdx] === ' ' || original[origIdx] === '\t') {
			// Extra whitespace in original.
			origToNorm.push(normIdx);
			origIdx++;
		} else {
			// Mismatch — shouldn't happen with our normalization.
			origToNorm.push(normIdx);
			origIdx++;
		}
	}
	// Fill remaining.
	while (origIdx < original.length) {
		origToNorm.push(normalized.length);
		origIdx++;
	}

	// Reverse mapping: for each normalized position, find original range.
	const normToOrigStart: Map<number, number> = new Map();
	const normToOrigEnd: Map<number, number> = new Map();
	for (let origPos = 0; origPos < origToNorm.length; origPos++) {
		const normPos = origToNorm[origPos];
		if (!normToOrigStart.has(normPos)) normToOrigStart.set(normPos, origPos);
		normToOrigEnd.set(normPos, origPos);
	}

	const originalMatches: Span[] = [];
	for (const [normStart, normEnd] of normalizedMatches) {
		let origStart: number;
		if (normToOrigStart.has(normStart)) {
			origStart = normToOrigStart.get(normStart)!;
		} else {
			// Find nearest original position with normalized pos >= normStart.
			origStart = origToNorm.length;
			for (let i = 0; i < origToNorm.length; i++) {
				if (origToNorm[i] >= normStart) { origStart = i; break; }
			}
		}

		let origEnd: number;
		if (normToOrigEnd.has(normEnd - 1)) {
			origEnd = normToOrigEnd.get(normEnd - 1)! + 1;
		} else {
			origEnd = origStart + (normEnd - normStart);
		}

		// Word-boundary fix: expand trailing whitespace only when the normalized
		// match itself ends with a space. When it ends with a non-space, the
		// first whitespace in the original is a word boundary and must not be
		// consumed.
		if (normEnd < normalized.length && normalized[normEnd - 1] === ' ') {
			while (origEnd < original.length && (original[origEnd] === ' ' || original[origEnd] === '\t')) {
				origEnd++;
			}
		}
		originalMatches.push([origStart, Math.min(origEnd, original.length)]);
	}
	return originalMatches;
}

// =============================================================================
// Strategies
// =============================================================================

/** Strategy 1: exact string match, non-overlapping. */
export function strategyExact(content: string, pattern: string): Span[] {
	const matches: Span[] = [];
	let start = 0;
	while (true) {
		const pos = content.indexOf(pattern, start);
		if (pos === -1) break;
		matches.push([pos, pos + pattern.length]);
		// Advance past the whole match so self-overlapping patterns produce
		// non-overlapping spans (matches str.replace semantics). Advancing by 1
		// yielded overlapping matches that corrupt the file under replace_all.
		start = pos + pattern.length;
	}
	return matches;
}

/** Strategy 2: per-line `.trim()` + block equality. */
export function strategyLineTrimmed(content: string, pattern: string): Span[] {
	const patternLines = pattern.split('\n').map((l) => l.trim());
	const patternNormalized = patternLines.join('\n');
	const contentLines = content.split('\n');
	const contentNormalizedLines = contentLines.map((l) => l.trim());
	return findNormalizedMatches(content, contentLines, contentNormalizedLines, patternNormalized);
}

/** Strategy 3: collapse `[ \t]+` → single space, preserve newlines. */
export function strategyWhitespaceNormalized(content: string, pattern: string): Span[] {
	const normalize = (s: string) => s.replace(/[ \t]+/g, ' ');
	const patternNormalized = normalize(pattern);
	const contentNormalized = normalize(content);
	const matchesInNormalized = strategyExact(contentNormalized, patternNormalized);
	if (matchesInNormalized.length === 0) return [];
	return mapNormalizedPositions(content, contentNormalized, matchesInNormalized);
}

/** Strategy 4: strip all leading whitespace per line (lstrip). */
export function strategyIndentationFlexible(content: string, pattern: string): Span[] {
	const contentLines = content.split('\n');
	const contentStripped = contentLines.map((l) => l.replace(/^[ \t]+/, ''));
	const patternLines = pattern.split('\n').map((l) => l.replace(/^[ \t]+/, ''));
	return findNormalizedMatches(content, contentLines, contentStripped, patternLines.join('\n'));
}

/** Strategy 5: unescape `\n`/`\t`/`\r` literals → bytes, then exact match. */
export function strategyEscapeNormalized(content: string, pattern: string): Span[] {
	const unescapeLiterals = (s: string) =>
		s.split('\\n').join('\n').split('\\t').join('\t').split('\\r').join('\r');
	const patternUnescaped = unescapeLiterals(pattern);
	if (patternUnescaped === pattern) return []; // no escapes — skip
	return strategyExact(content, patternUnescaped);
}

/** Strategy 6: trim only first and last lines, sliding window. */
export function strategyTrimmedBoundary(content: string, pattern: string): Span[] {
	const patternLines = pattern.split('\n');
	if (patternLines.length === 0) return [];
	patternLines[0] = patternLines[0].trim();
	if (patternLines.length > 1) patternLines[patternLines.length - 1] = patternLines[patternLines.length - 1].trim();
	const modifiedPattern = patternLines.join('\n');
	const contentLines = content.split('\n');
	const matches: Span[] = [];
	const patternLineCount = patternLines.length;
	for (let i = 0; i <= contentLines.length - patternLineCount; i++) {
		const blockLines = contentLines.slice(i, i + patternLineCount);
		const checkLines = blockLines.slice();
		checkLines[0] = checkLines[0].trim();
		if (checkLines.length > 1) checkLines[checkLines.length - 1] = checkLines[checkLines.length - 1].trim();
		if (checkLines.join('\n') === modifiedPattern) {
			const [start, end] = calculateLinePositions(contentLines, i, i + patternLineCount, content.length);
			matches.push([start, end]);
		}
	}
	return matches;
}

/** Strategy 7: Unicode normalization (smart quotes, em/en dash, ellipsis, NBSP). */
export function strategyUnicodeNormalized(content: string, pattern: string): Span[] {
	const normPattern = unicodeNormalize(pattern);
	const normContent = unicodeNormalize(content);
	if (normContent === content && normPattern === pattern) return [];

	let normMatches = strategyExact(normContent, normPattern);
	if (normMatches.length === 0) {
		normMatches = strategyLineTrimmed(normContent, normPattern);
	}
	if (normMatches.length === 0) return [];

	const origToNorm = buildOrigToNormMap(content);
	return mapPositionsNormToOrig(origToNorm, normMatches);
}

/** Strategy 8: anchor on first+last lines, similarity for the middle. */
export function strategyBlockAnchor(content: string, pattern: string): Span[] {
	const normPattern = unicodeNormalize(pattern);
	const normContent = unicodeNormalize(content);
	const patternLines = normPattern.split('\n');
	if (patternLines.length < 2) return [];
	const firstLine = patternLines[0].trim();
	const lastLine = patternLines[patternLines.length - 1].trim();

	const normContentLines = normContent.split('\n');
	const origContentLines = content.split('\n');
	const patternLineCount = patternLines.length;

	const potentialMatches: number[] = [];
	for (let i = 0; i <= normContentLines.length - patternLineCount; i++) {
		if (
			normContentLines[i].trim() === firstLine &&
			normContentLines[i + patternLineCount - 1].trim() === lastLine
		) {
			potentialMatches.push(i);
		}
	}

	// Threshold: 0.50 for unique matches, 0.70 for multiple candidates.
	const candidateCount = potentialMatches.length;
	const threshold = candidateCount === 1 ? 0.5 : 0.7;

	const matches: Span[] = [];
	for (const i of potentialMatches) {
		let similarity: number;
		if (patternLineCount <= 2) {
			similarity = 1.0;
		} else {
			const contentMiddle = normContentLines.slice(i + 1, i + patternLineCount - 1).join('\n');
			const patternMiddle = patternLines.slice(1, -1).join('\n');
			similarity = new SequenceMatcher(null, contentMiddle, patternMiddle).ratio();
		}
		if (similarity >= threshold) {
			const [start, end] = calculateLinePositions(origContentLines, i, i + patternLineCount, content.length);
			matches.push([start, end]);
		}
	}
	return matches;
}

/**
 * Strategy 9: line-by-line similarity, 50% threshold.
 *
 * Loosest strategy — accepts any block where half the lines have per-line
 * similarity ≥ 0.80. Quadratic cost. Opt-in only (separate flag).
 */
export function strategyContextAware(content: string, pattern: string): Span[] {
	const patternLines = pattern.split('\n');
	const contentLines = content.split('\n');
	if (patternLines.length === 0) return [];
	const matches: Span[] = [];
	const patternLineCount = patternLines.length;
	for (let i = 0; i <= contentLines.length - patternLineCount; i++) {
		const blockLines = contentLines.slice(i, i + patternLineCount);
		let highSimilarityCount = 0;
		for (let k = 0; k < patternLines.length; k++) {
			const sim = new SequenceMatcher(null, patternLines[k].trim(), blockLines[k].trim()).ratio();
			if (sim >= 0.8) highSimilarityCount++;
		}
		if (highSimilarityCount >= patternLines.length * 0.5) {
			const [start, end] = calculateLinePositions(contentLines, i, i + patternLineCount, content.length);
			matches.push([start, end]);
		}
	}
	return matches;
}

// =============================================================================
// "Did you mean?" hint helpers (wired into apply-patch diagnostics)
// =============================================================================

/**
 * Find lines in `content` most similar to `oldString` for "did you mean?" feedback.
 *
 * Returns a formatted string showing the closest matching lines with context
 * and line numbers, or `''` if no useful match is found.
 */
export function findClosestLines(
	oldString: string,
	content: string,
	contextLines = 2,
	maxResults = 3,
): string {
	if (!oldString || !content) return '';
	const oldLines = oldString.split(/\r?\n/);
	const contentLines = content.split(/\r?\n/);
	if (oldLines.length === 0 || contentLines.length === 0) return '';

	let anchor = oldLines[0].trim();
	if (!anchor) {
		const candidates = oldLines.filter((l) => l.trim());
		if (candidates.length === 0) return '';
		anchor = candidates[0].trim();
	}

	const scored: Array<[number, number]> = [];
	for (let i = 0; i < contentLines.length; i++) {
		const stripped = contentLines[i].trim();
		if (!stripped) continue;
		const ratio = new SequenceMatcher(null, anchor, stripped).ratio();
		if (ratio > 0.3) scored.push([ratio, i]);
	}
	if (scored.length === 0) return '';

	scored.sort((a, b) => b[0] - a[0]);
	const top = scored.slice(0, maxResults);

	const parts: string[] = [];
	const seenRanges = new Set<string>();
	for (const [, lineIdx] of top) {
		const start = Math.max(0, lineIdx - contextLines);
		const end = Math.min(contentLines.length, lineIdx + oldLines.length + contextLines);
		const key = `${start}:${end}`;
		if (seenRanges.has(key)) continue;
		seenRanges.add(key);
		const lines: string[] = [];
		for (let j = start; j < end; j++) {
			const num = String(j + 1).padStart(4, ' ');
			lines.push(`${num}| ${contentLines[j]}`);
		}
		parts.push(lines.join('\n'));
	}
	if (parts.length === 0) return '';
	return parts.join('\n---\n');
}

/**
 * Return a "Did you mean..." snippet for plain no-match errors.
 *
 * Gated so the hint only fires for actual "old_string not found" failures.
 * Ambiguous-match, escape-drift, and identical-strings errors all have
 * `matchCount === 0` but a did-you-mean snippet would be misleading.
 */
export function formatNoMatchHint(
	error: string | null,
	matchCount: number,
	oldString: string,
	content: string,
): string {
	if (matchCount !== 0) return '';
	if (!error || !error.startsWith('Could not find')) return '';
	const hint = findClosestLines(oldString, content);
	if (!hint) return '';
	return `\n\nDid you mean one of these sections?\n${hint}`;
}
