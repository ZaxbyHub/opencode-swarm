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

/** Bumped when the pattern set changes; recorded on every vault record. */
export const TRAINING_REDACTION_VERSION = 1;

const URL_PATTERN = /\bhttps?:\/\/[^\s'"<>]+/g;

// Credential key/value shapes: `token=...`, `"api_key": "..."`,
// `Authorization: Bearer ...` — tolerant of the common separators, with the
// key containing any of the secret-bearing morphemes. The leading separator
// char is captured so the replacement keeps the surrounding text intact.
const CREDENTIAL_KV_PATTERN =
	/(?:^|[\s,;"'([{])([A-Za-z0-9_ -]{0,40}(?:token|secret|password|passwd|authorization|credential|bearer|api[-_ ]?key|access[-_ ]?key)[A-Za-z0-9_ -]{0,40}\s*[=:]\s*)(?:bearer|basic|digest|negotiate|apikey)?[^\s,;"'}\]]+/gi;

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
	} catch {
		return {
			content: '<redacted:redaction-failed>',
			applied: true,
			redactions: 1,
		};
	}
	return { content: working, applied: redactions > 0, redactions };
}
