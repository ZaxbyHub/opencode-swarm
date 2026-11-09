/**
 * Sanitize a model-derived identity string (agent name, scope key) before it
 * is interpolated into a single-line diagnostic (#3617 review PRR-006/PRR-010
 * and the post-push automation review).
 *
 * Drops every Unicode "Other" code point — `\p{C}`: C0/C1 controls, format
 * characters (bidi overrides/isolates, zero-width marks, BOM), surrogates,
 * private-use and unassigned code points — plus the line and paragraph
 * separators U+2028/U+2029 (`\p{Zl}`/`\p{Zp}`), so the value can neither break
 * the log line nor visually reorder it. The length bound counts CODE POINTS,
 * so truncation never splits a surrogate pair.
 */
const UNSAFE_DIAGNOSTIC_CHAR = /[\p{C}\p{Zl}\p{Zp}]/u;

export const MAX_DIAGNOSTIC_SCOPE_LENGTH = 200;

export function sanitizeDiagnosticScope(value: string): string {
	return Array.from(value)
		.filter((ch) => !UNSAFE_DIAGNOSTIC_CHAR.test(ch))
		.slice(0, MAX_DIAGNOSTIC_SCOPE_LENGTH)
		.join('');
}
