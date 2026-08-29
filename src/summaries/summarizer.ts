/**
 * Summarization engine for tool outputs.
 * Provides content type detection, summarization decision logic, and structured summary creation.
 */

/**
 * Hysteresis factor to prevent churn for outputs near the threshold.
 * An output must be 25% larger than the threshold to be summarized.
 */
export const HYSTERESIS_FACTOR = 1.25;

/**
 * Content type classification for tool outputs.
 */
type ContentType = 'json' | 'code' | 'text' | 'binary';

/**
 * Heuristic-based content type detection.
 * @param output - The tool output string to analyze
 * @param toolName - The name of the tool that produced the output
 * @returns The detected content type: 'json', 'code', 'text', or 'binary'
 */
export function detectContentType(
	output: string,
	toolName: string,
): ContentType {
	// Check for JSON first
	const trimmed = output.trim();
	if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
		try {
			JSON.parse(trimmed);
			return 'json';
		} catch {
			// Not valid JSON, continue to other checks
		}
	}

	// Check if tool suggests code (read, cat, grep, bash)
	const codeToolNames = ['read', 'cat', 'grep', 'bash'];
	const lowerToolName = toolName.toLowerCase();
	const toolSegments = lowerToolName.split(/[.\-_/]/);
	if (codeToolNames.some((name) => toolSegments.includes(name))) {
		return 'code';
	}

	// Check for common code patterns
	const codePatterns = [
		'function ',
		'const ',
		'import ',
		'export ',
		'class ',
		'def ',
		'return ',
		'=>',
	];
	const startsWithShebang = trimmed.startsWith('#!');

	if (
		codePatterns.some((pattern) => output.includes(pattern)) ||
		startsWithShebang
	) {
		return 'code';
	}

	// Check for binary content (high ratio of non-printable characters)
	const sampleSize = Math.min(1000, output.length);
	let nonPrintableCount = 0;
	for (let i = 0; i < sampleSize; i++) {
		const charCode = output.charCodeAt(i);
		// Count chars with code < 32, excluding \n (10), \r (13), \t (9)
		if (charCode < 32 && charCode !== 9 && charCode !== 10 && charCode !== 13) {
			nonPrintableCount++;
		}
	}

	if (sampleSize > 0 && nonPrintableCount / sampleSize > 0.1) {
		return 'binary';
	}

	// Default to text
	return 'text';
}

/**
 * Determines whether output should be summarized based on size and hysteresis.
 * Uses hysteresis to prevent repeated summarization decisions for outputs near the threshold.
 * @param output - The tool output string to check
 * @param thresholdBytes - The threshold in bytes
 * @returns true if the output should be summarized
 */
export function shouldSummarize(
	output: string,
	thresholdBytes: number,
): boolean {
	const byteLength = Buffer.byteLength(output, 'utf8');
	return byteLength >= thresholdBytes * HYSTERESIS_FACTOR;
}

/**
 * Formats bytes into a human-readable string.
 * @param bytes - Number of bytes
 * @returns Formatted string (e.g., "20.5 KB", "1.2 MB")
 */
function formatBytes(bytes: number): string {
	const units = ['B', 'KB', 'MB', 'GB'];
	let unitIndex = 0;
	let size = bytes;

	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex++;
	}

	// Format to 1 decimal place if not whole number
	const formatted = unitIndex === 0 ? size.toString() : size.toFixed(1);
	return `${formatted} ${units[unitIndex]}`;
}

/**
 * Infer a compact type signature for a JSON value.
 */
function jsonTypeSignature(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) {
		const len = value.length;
		if (len === 0) return 'array<>';
		const first = value[0];
		return `array<${len}, ${jsonTypeSignature(first)}>`;
	}
	switch (typeof value) {
		case 'string':
			return 'string';
		case 'number':
			return Number.isInteger(value) ? 'number' : 'number(float)';
		case 'boolean':
			return 'boolean';
		case 'object':
			return 'object';
		default:
			return typeof value;
	}
}

/**
 * Build a structure-aware preview for a JSON object.
 * Shows ALL top-level keys with their type signatures (AC-008 / SC-012).
 */
function summarizeJsonObject(parsed: Record<string, unknown>): string {
	const keys = Object.keys(parsed);
	const parts = keys.map((key) => `${key}: ${jsonTypeSignature(parsed[key])}`);
	return `{ ${parts.join(', ')} }`;
}

/**
 * Build a structure-aware preview for a JSON array.
 */
function summarizeJsonArray(parsed: unknown[]): string {
	const len = parsed.length;
	if (len === 0) return '[ 0 items ]';
	const firstSig = jsonTypeSignature(parsed[0]);
	return `[ ${len} items, first: ${firstSig} ]`;
}

/**
 * Regex-based extractor for declaration signatures in code output.
 */
const DECLARATION_PATTERN =
	/(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+(\w+)/g;

/**
 * Extract declaration names from code text.
 */
function extractCodeSignatures(code: string): string[] {
	const signatures: string[] = [];
	for (const match of code.matchAll(DECLARATION_PATTERN)) {
		const name = match[1];
		if (name && !signatures.includes(name)) {
			signatures.push(name);
		}
	}
	return signatures;
}

/**
 * Per-line character cap (#2107 §5): a single oversized line (e.g. a 1 MiB
 * minified blob on one line) must be bounded on its own, with a truthful
 * omission suffix — never materialized in full and silently cut later.
 */
const MAX_SUMMARY_LINE_CHARS = 400;

/**
 * Codepoint-safe truncation to a UTF-8 byte budget (#2107 §5).
 *
 * Iterates code points (never UTF-16 units) so a multibyte CJK/emoji run can
 * never be split mid-codepoint, and the result is deterministic across Bun and
 * Node (which disagree on `Buffer.byteLength` for unpaired surrogates — per
 * code point, both agree). Returns the kept text and the exact number of bytes
 * omitted.
 */
export function truncateToBytes(
	text: string,
	maxBytes: number,
): { text: string; omittedBytes: number } {
	const totalBytes = Buffer.byteLength(text, 'utf8');
	if (maxBytes <= 0) {
		return { text: '', omittedBytes: totalBytes };
	}
	let used = 0;
	let kept = '';
	for (const codePoint of text) {
		const cpBytes = Buffer.byteLength(codePoint, 'utf8');
		if (used + cpBytes > maxBytes) {
			return { text: kept, omittedBytes: totalBytes - used };
		}
		kept += codePoint;
		used += cpBytes;
	}
	return { text, omittedBytes: 0 };
}

function capLine(line: string): string {
	if (line.length <= MAX_SUMMARY_LINE_CHARS) {
		return line;
	}
	const omitted = line.length - MAX_SUMMARY_LINE_CHARS;
	return `${line.slice(0, MAX_SUMMARY_LINE_CHARS)} [... ${omitted} chars omitted on this line ...]`;
}

/**
 * Deterministic bounded head/tail preview (#2107 §5).
 *
 * Head: the leading non-blank identity lines (ceil half of the line budget).
 * Tail: the trailing RAW outcome lines (floor half) — compiler, test, lint,
 * and security verdicts live at the END of tool output, so the old head-only
 * preview discarded exactly the decision-relevant evidence. Lines are never
 * reordered within either segment, no outcome is invented, and every dropped
 * region is disclosed with an accurate omitted-line count. When everything
 * fits, the original text is returned unchanged (modulo per-line caps).
 */
function headTailPreview(output: string, maxLines: number): string {
	const rawLines = output.split('\n');
	if (maxLines <= 0) {
		return '';
	}
	// Everything fits: return the original text unchanged (modulo per-line
	// caps). No omission marker, no reordering, no blank-line rewriting.
	if (rawLines.length <= maxLines) {
		return rawLines.map(capLine).join('\n');
	}
	const headCount = Math.max(1, Math.ceil(maxLines / 2));
	const tailCount = Math.max(0, maxLines - headCount);

	// Head: leading non-blank identity lines, never reaching into the tail
	// region (a line must not appear in both segments).
	const headLimitIndex =
		tailCount > 0 ? rawLines.length - tailCount : rawLines.length;
	const headLines: string[] = [];
	for (let i = 0; i < headLimitIndex && headLines.length < headCount; i++) {
		const line = rawLines[i];
		if (line.trim().length === 0) continue;
		headLines.push(line);
	}
	const tailLines: string[] = tailCount > 0 ? rawLines.slice(-tailCount) : [];
	// Trailing blank lines carry no evidence; trim them from the tail segment.
	while (
		tailLines.length > 0 &&
		tailLines[tailLines.length - 1].trim() === ''
	) {
		tailLines.pop();
	}

	const omittedCount = rawLines.length - headLines.length - tailLines.length;
	const segments: string[] = [];
	if (headLines.length > 0) {
		segments.push(headLines.map(capLine).join('\n'));
	}
	if (omittedCount > 0) {
		segments.push(`[... ${omittedCount} lines omitted ...]`);
	}
	if (tailLines.length > 0) {
		segments.push(tailLines.map(capLine).join('\n'));
	}
	return segments.join('\n');
}

/**
 * Build a preview for code output that includes declaration signatures plus
 * the bounded head/tail policy (failure output at the end of a code blob is
 * preserved).
 */
function summarizeCode(output: string): string {
	const signatures = extractCodeSignatures(output);
	const preview = headTailPreview(output, 5);

	if (signatures.length === 0) {
		return preview;
	}

	const sigLine = `// declarations: ${signatures.join(', ')}`;
	return [sigLine, preview].join('\n');
}

/**
 * Build a preview for plain text output using the bounded head/tail policy
 * (see headTailPreview). Previously head-only: the first `maxLines` non-blank
 * lines, which silently discarded trailing failure/exit evidence.
 */
function summarizeText(output: string, maxLines: number): string {
	return headTailPreview(output, maxLines);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a structured summary string from tool output.
 * @param output - The full tool output string
 * @param toolName - The name of the tool that produced the output
 * @param summaryId - Unique identifier for this summary
 * @param maxSummaryChars - Maximum bytes allowed for the preview
 * @returns Formatted summary string
 */
export function createSummary(
	output: string,
	toolName: string,
	summaryId: string,
	maxSummaryChars: number,
): string {
	const contentType = detectContentType(output, toolName);
	const lineCount = output.split('\n').length;
	const byteSize = Buffer.byteLength(output, 'utf8');
	const formattedSize = formatBytes(byteSize);

	// Calculate overhead for header and footer lines (in BYTES — the footer's
	// "→" is 3 UTF-8 bytes, so a character count would under-reserve and let
	// the total slip past the cap).
	const headerLine = `[SUMMARY ${summaryId}] ${formattedSize} | ${contentType} | ${lineCount} lines`;
	const footerLine = `→ Use /swarm retrieve ${summaryId} for full content`;
	const overhead =
		Buffer.byteLength(headerLine, 'utf8') +
		1 +
		Buffer.byteLength(footerLine, 'utf8') +
		1;

	const maxPreviewChars = maxSummaryChars - overhead;

	let preview: string;

	switch (contentType) {
		case 'json': {
			try {
				const parsed = JSON.parse(output.trim());
				if (Array.isArray(parsed)) {
					preview = summarizeJsonArray(parsed);
				} else if (typeof parsed === 'object' && parsed !== null) {
					preview = summarizeJsonObject(parsed as Record<string, unknown>);
				} else {
					preview = summarizeText(output, 3);
				}
			} catch {
				preview = summarizeText(output, 3);
			}
			break;
		}
		case 'code': {
			preview = summarizeCode(output);
			break;
		}
		case 'text': {
			preview = summarizeText(output, 5);
			break;
		}
		case 'binary': {
			preview = `[Binary content - ${formattedSize}]`;
			break;
		}
		default: {
			preview = summarizeText(output, 5);
		}
	}

	// Byte-safe preview cap (#2107 §5). The cap is enforced on UTF-8 bytes with
	// codepoint-safe truncation — multibyte content can no longer slip past the
	// implied budget the way the old character-based substring allowed — and
	// the omission is disclosed truthfully. When even the marker would not fit
	// the remaining budget, a minimal `...` marker is used so the TOTAL stays
	// within maxSummaryChars.
	const previewBytes = Buffer.byteLength(preview, 'utf8');
	if (previewBytes > maxPreviewChars) {
		let marker = `[... ${previewBytes} bytes total, truncated ...]`;
		if (Buffer.byteLength(marker, 'utf8') > maxPreviewChars) {
			marker = '...';
		}
		const { text: kept } = truncateToBytes(
			preview,
			Math.max(0, maxPreviewChars - Buffer.byteLength(marker, 'utf8')),
		);
		preview = `${kept}${marker}`;
	}

	return `${headerLine}\n${preview}\n${footerLine}`;
}

/**
 * Internal helpers exposed for testability.
 */
export const _internals = {
	truncateToBytes,
	headTailPreview,
	jsonTypeSignature,
	summarizeJsonObject,
	summarizeJsonArray,
	extractCodeSignatures,
	summarizeCode,
	summarizeText,
};
