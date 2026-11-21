/**
 * Issue #2486/#3701/#3840: capture-time defense-in-depth redaction for training
 * content.
 *
 * The placement classes (URL spans, credential key/value spans, quoted-JSON
 * keys, Bearer/Basic schemes) still cover the same shapes as the display
 * sanitizer `sanitizeFailureEvidenceDisplay` (`src/failures/invocation-failure.ts`).
 * Since #3840 the VALUE-shape side is a widened corpus: the bare well-known
 * credential families mirrored from the shell site
 * (`src/hooks/guardrails/helpers.ts` `SHELL_BARE_TOKEN_VALUE_PATTERNS`,
 * labels restyled to this site's angle-bracket form) PLUS the shared JWS
 * scanner (`src/utils/jws-redaction.ts`), whose spans win over any overlapping
 * bare arm (whole-span union — a bare arm only fires on spans disjoint from
 * scanner spans). Deliberately NOT mirrored here: the display site's
 * Cf/DI condensed-view sweep and its 512-byte display bounding — vault records
 * keep the contracted 4096-char content budget. This is defense-in-depth, not
 * a security boundary (same honest framing as #2369): the human consenting to
 * capture is trusting the redactor class, and the recorded
 * `redaction.version` pins which revision produced each stored record.
 */

/**
 * Bumped when the pattern set changes; recorded on every vault record.
 * v2 (#3840): added the bare well-known credential families (anthropic,
 * openrouter, openai, github, aws, slack, google, groq, jwt, base64, azure)
 * plus the shared JWS scanner. Reads accept every version 1..CURRENT so
 * pre-v2 records stay valid, exportable, and survive the expiry sweep.
 */
import { findRedactableTokenSpans } from '../utils/jws-redaction.js';

export const TRAINING_REDACTION_VERSION = 2;

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

/**
 * Bare well-known credential VALUE shapes — mirrored (families and bounds
 * identical) from the shell site `SHELL_BARE_TOKEN_VALUE_PATTERNS`
 * (`src/hooks/guardrails/helpers.ts`), with this site's angle-bracket labels.
 * Mirrored arms must stay in lockstep with the display/shell corpus; the
 * family-parity suites pin all three sites against the same fixtures.
 */
const TRAINING_BARE_TOKEN_VALUE_PATTERNS: ReadonlyArray<{
	label: string;
	re: RegExp;
	/** Optional post-match class guard (the base64 arm requires
	 * upper+lower+digit on the matched run so hex-only digests stay visible). */
	guard?: (match: string) => boolean;
}> = [
	{ label: '<redacted:anthropic>', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
	{ label: '<redacted:openrouter>', re: /\bsk-or-[A-Za-z0-9_-]{20,}/g },
	{ label: '<redacted:openai>', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
	{
		label: '<redacted:github>',
		re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
	},
	{ label: '<redacted:github>', re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
	{ label: '<redacted:aws>', re: /\bAKIA[0-9A-Z]{16}\b/g },
	{ label: '<redacted:slack>', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
	{ label: '<redacted:google>', re: /\bAIza[A-Za-z0-9_-]{30,}/g },
	{ label: '<redacted:google>', re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/g },
	{ label: '<redacted:google>', re: /\bya29\.[A-Za-z0-9_-]{20,}/g },
	{ label: '<redacted:groq>', re: /\bgsk_[A-Za-z0-9]{20,}/g },
	{
		// Payload segment is any base64url run — an empty claims object
		// encodes as `e30`, not `eyJ` (#3710).
		label: '<redacted:jwt>',
		re: /\beyJ[A-Za-z0-9_-]{10,1024}\.[A-Za-z0-9_-]{1,}\.[A-Za-z0-9_-]{10,}/g,
	},
	{
		// ≥80-char mixed-class run; the guard keeps hex-only SHA digests,
		// uppercase-hex runs, and sub-80 payloads visible (#3712 F-013).
		label: '<redacted:base64>',
		re: /[A-Za-z0-9+/]{80,}={0,2}/g,
		guard: (match) =>
			/[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9]/.test(match),
	},
	// Azure connection-string `AccountKey=<base64>` contextual arm — the whole
	// span collapses to the family placeholder (no re-matchable residue).
	{
		label: '<redacted:azure>',
		re: /\bAccountKey=[A-Za-z0-9+/]{20,}={0,2}/gi,
	},
];

interface Replacement {
	start: number;
	end: number;
	label: string;
}

/**
 * Whole-span union pass (#3840): the shared JWS scanner's spans are collected
 * FIRST and win over any overlapping bare-arm match; a bare arm only fires on
 * a span disjoint from every scanner span. Leftmost-longest selection among
 * the remaining candidates; application splices from the end so earlier
 * indices stay valid.
 */
function redactBareValueShapes(content: string): {
	text: string;
	redactions: number;
} {
	const scannerSpans = findRedactableTokenSpans(content);
	const planned: Replacement[] = scannerSpans.map((span) => ({
		start: span.start,
		end: span.end,
		label: '<redacted:jwt>',
	}));
	const overlapsPlanned = (start: number, end: number) =>
		planned.some((r) => start < r.end && end > r.start);
	for (const arm of TRAINING_BARE_TOKEN_VALUE_PATTERNS) {
		arm.re.lastIndex = 0;
		for (const match of content.matchAll(arm.re)) {
			if (!match[0]) continue;
			if (arm.guard && !arm.guard(match[0])) continue;
			const start = match.index ?? 0;
			const end = start + match[0].length;
			if (overlapsPlanned(start, end)) continue;
			planned.push({ start, end, label: arm.label });
		}
	}
	if (planned.length === 0) return { text: content, redactions: 0 };
	planned.sort((a, b) => a.start - b.start || b.end - a.end);
	let text = content;
	for (let i = planned.length - 1; i >= 0; i -= 1) {
		const r = planned[i] as Replacement;
		text = text.slice(0, r.start) + r.label + text.slice(r.end);
	}
	return { text, redactions: planned.length };
}

export interface RedactionResult {
	content: string;
	applied: boolean;
	redactions: number;
}

/**
 * Redact URL, credential-placement, and bare-value credential patterns from
 * already-bounded capture content (callers bound FIRST — a placeholder can be
 * longer than the span it replaces, and truncating after redaction would
 * collapse distinct inputs onto one identity). Pure; never throws (on internal
 * failure the content is withheld rather than stored raw).
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
		const bare = redactBareValueShapes(working);
		working = bare.text;
		redactions += bare.redactions;
	} catch {
		return {
			content: '<redacted:redaction-failed>',
			applied: true,
			redactions: 1,
		};
	}
	return { content: working, applied: redactions > 0, redactions };
}
