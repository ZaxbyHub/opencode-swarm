/**
 * Issue #2486: capture-time defense-in-depth redaction for training content.
 *
 * Mirrors the URL / credential-pattern classes of
 * `sanitizeFailureEvidenceDisplay` (`src/failures/invocation-failure.ts`)
 * WITHOUT that function's 512-byte display bounding — vault records keep the
 * contracted 4096-char content budget. This is defense-in-depth, not a
 * security boundary (same honest framing as #2369): the human consenting to
 * capture is trusting the redactor class, and the recorded
 * `redaction.version` pins which revision produced each stored record.
 */

/** Bumped when the pattern set changes; recorded on every vault record.
 * v1's pattern set was extended pre-release (quoted-JSON credential shapes,
 * scheme-prefixed tokens) before any v1 record shipped, so the first released
 * revision covers the full set and no migration surface exists. */
export const TRAINING_REDACTION_VERSION = 1;

const URL_PATTERN = /\bhttps?:\/\/[^\s'"<>]+/g;

// Credential key/value shapes: `token=...`, `api_key="..."`,
// `Authorization: Bearer ...` — tolerant of the common separators, with the
// key containing any of the secret-bearing morphemes. The leading separator
// char is captured so the replacement keeps the surrounding text intact.
// The value alternation also accepts a quoted span so `api_key="v"` hits.
// The scheme group consumes its trailing whitespace so the value class
// reaches the token itself — without it the engine backtracks and redacts
// only the word "Bearer", leaving the token in the clear.
const CREDENTIAL_KV_PATTERN =
	/(?:^|[\s,;"'([{])([A-Za-z0-9_ -]{0,40}(?:token|secret|password|passwd|authorization|credential|bearer|api[-_ ]?key|access[-_ ]?key)[A-Za-z0-9_ -]{0,40}\s*[=:]\s*)(?:bearer|basic|digest|negotiate|apikey)?\s*(?:["'][^"'\n]*["']|[^\s,;"'}\]]+)/gi;

// JSON-quoted key form the loose pattern cannot bridge: `"api_key": "v"` —
// the closing quote of the key and the opening quote of the value fall
// outside the loose key/value classes, so this needs its own pass.
const QUOTED_JSON_CREDENTIAL_PATTERN =
	/(["'])([A-Za-z0-9_ -]{0,40}(?:token|secret|password|passwd|authorization|credential|bearer|api[-_ ]?key|access[-_ ]?key)[A-Za-z0-9_ -]{0,40})\1(\s*:\s*)(["'])([^"'\n]{4,})\4/gi;

// Scheme-prefixed token with no key morpheme at all: `Bearer <token>`.
const SCHEME_TOKEN_PATTERN = /\b(bearer|basic)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi;

// Out of scope for v1 (documented, not silently omitted): base64-encoded
// secrets and OS paths that merely contain sensitive directory names — both
// carry unbounded false-positive rates against 4096 chars of tool output.

export interface RedactionResult {
	content: string;
	applied: boolean;
	redactions: number;
}

/**
 * Redact URL and credential patterns from already-bounded capture content
 * (callers bound FIRST — a placeholder can be longer than the span it
 * replaces, and truncating after redaction would collapse distinct inputs
 * onto one identity). Pure; never throws (on internal failure the content is
 * withheld rather than stored raw).
 */
export function redactTrainingContent(content: string): RedactionResult {
	if (typeof content !== 'string' || content.length === 0) {
		return { content: '', applied: false, redactions: 0 };
	}
	let redactions = 0;
	let working = content;
	try {
		working = working.replace(URL_PATTERN, () => {
			redactions += 1;
			return '<redacted:url>';
		});
		working = working.replace(
			CREDENTIAL_KV_PATTERN,
			(_match, prefix: string) => {
				redactions += 1;
				return `${prefix}<redacted>`;
			},
		);
		working = working.replace(
			QUOTED_JSON_CREDENTIAL_PATTERN,
			(_match, openQuote: string, key: string, sep: string) => {
				redactions += 1;
				return `${openQuote}${key}${openQuote}${sep}${openQuote}<redacted>${openQuote}`;
			},
		);
		working = working.replace(
			SCHEME_TOKEN_PATTERN,
			(_match, scheme: string, space: string) => {
				redactions += 1;
				return `${scheme}${space}<redacted>`;
			},
		);
	} catch {
		return {
			content: '<redacted:redaction-failed>',
			applied: true,
			redactions: 1,
		};
	}
	return { content: working, applied: redactions > 0, redactions };
}
