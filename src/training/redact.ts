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
 * scanner spans). Since #3893 (AC4) the persisted-store floor
 * (`redactSecrets`, `src/memory/redaction.ts`) is composed AFTER the bare pass,
 * so the memory families (PEM blocks, Stripe, GitLab, ...) and the memory
 * site's fill-class condensed-view re-link reach this path too. Deliberately
 * NOT mirrored here: the display site's 512-byte display bounding — vault
 * records keep the contracted 4096-char content budget. This is
 * defense-in-depth, not a security boundary (same honest framing as #2369):
 * the human consenting to capture is trusting the redactor class, and the
 * recorded `redaction.version` pins which revision produced each stored
 * record.
 */

/**
 * Bumped when the pattern set changes; recorded on every vault record.
 * v2 (#3840): added the bare well-known credential families (anthropic,
 * openrouter, openai, github, aws, slack, google, groq, jwt, base64, azure)
 * plus the shared JWS scanner. Reads accept every version 1..CURRENT so
 * pre-v2 records stay valid, exportable, and survive the expiry sweep.
 * v3 (#3893 AC4): composed the persisted-store floor (`redactSecrets` from
 * `src/memory/redaction.ts` — the PEM private-key blocks, Stripe, GitLab,
 * AWS, and the remaining memory families, with the memory site's
 * fill-class condensed-view re-link and jws_span union) into the capture
 * path AFTER the bare-value pass. Pre-v3 records (1..2) stay valid,
 * exportable, and survive the expiry sweep — the consent/vault schemas
 * read `min(1)..max(CURRENT)`, so no migration is needed.
 */
import { redactSecrets } from '../memory/redaction.js';
import { findRedactableTokenSpans } from '../utils/jws-redaction.js';

export const TRAINING_REDACTION_VERSION = 3;

const URL_PATTERN = /\bhttps?:\/\/[^\s'"<>]+/g;

// Credential key/value shapes: `token=...`, `api_key="..."`,
// `Authorization: Bearer ...` — tolerant of the common separators, with the
// key containing any of the secret-bearing morphemes. The leading separator
// char is captured so the replacement keeps the surrounding text intact.
// The value alternation also accepts a quoted span so `api_key="v"` hits.
// The scheme group consumes its trailing whitespace so the value class
// reaches the token itself — without it the engine backtracks and redacts
// only the word "Bearer", leaving the token in the clear.
//
// Two properties the arm MUST hold:
//   - The leading separator is captured and re-emitted. It used to be part of
//     the match but not of the replacement, so the words around the value
//     were glued together (`password=<redacted>then` lost `then`).
//   - A value made ONLY of complete placeholders (this redactor's
//     `<redacted…>` or the evidence path's `[REDACTED…]`) is a FIXED POINT:
//     the export re-redacts every record, so a non-idempotent arm corrupted
//     the exported content (and counted a redaction that removed nothing).
//     Every OTHER value is consumed whole, placeholders included — a
//     placeholder followed by more secret material keeps no tail (an
//     earlier guard skipped those values and retained the tail). Each
//     placeholder body is bounded at 64 characters so a run of unclosed
//     openers stays linear.
//   - The placeholder is emitted UNQUOTED, whatever the value's quoting:
//     `api_key="v"` stores `api_key=<redacted>`, exactly as the merge base
//     did (the frozen preserving contract pins those bytes).
const CREDENTIAL_KV_PATTERN =
	/(^|[\s,;"'([{])([A-Za-z0-9_ -]{0,40}(?:token|secret|password|passwd|authorization|credential|bearer|api[-_ ]?key|access[-_ ]?key)[A-Za-z0-9_ -]{0,40}\s*[=:]\s*)(?:bearer|basic|digest|negotiate|apikey)?\s*("[^"'\n]*"|'[^'\n]*'|(?:\[REDACTED[^\]\s]{0,64}\]|<redacted[^>\s]{0,64}>|[^\s,;"'}\]])(?:\[REDACTED[^\]\s]{0,64}\]|<redacted[^>\s]{0,64}>|[^\s,;"'}\]])*)/gi;

/** A complete placeholder (either vocabulary) or a surrounding quote. */
const PLACEHOLDER_OR_QUOTE =
	/\[REDACTED[^\]\s]{0,64}\]|<redacted[^>\s]{0,64}>|["']/g;

/**
 * Whether a matched key/value value is nothing but complete placeholders
 * (its surrounding quotes ignored) — already redacted, so the arm leaves its
 * bytes alone and counts nothing.
 */
function isPlaceholderOnly(value: string): boolean {
	return value.replace(PLACEHOLDER_OR_QUOTE, '') === '';
}

/**
 * #3893 AC4 (F2): run the persisted-store floor (`redactSecrets`) on the
 * segments BETWEEN complete placeholders (either vocabulary) only. An
 * already-redacted value is never re-consumed by the floor, so every stored
 * placeholder — and therefore every exported record — is a fixed point of the
 * composed redactor. PLACEHOLDER_OR_QUOTE matches are short and bounded, so
 * the split is linear and the per-segment floor scans never span a
 * placeholder boundary (a placeholder already removed the secret it marked;
 * re-bridging it would re-consume it).
 */
function applyFloorAroundPlaceholders(text: string): string {
	const parts: string[] = [];
	let last = 0;
	let changed = false;
	PLACEHOLDER_OR_QUOTE.lastIndex = 0;
	for (const m of text.matchAll(PLACEHOLDER_OR_QUOTE)) {
		const start = m.index ?? 0;
		const segment = text.slice(last, start);
		const floored = redactSecrets(segment);
		if (floored !== segment) changed = true;
		parts.push(floored, m[0]);
		last = start + m[0].length;
	}
	const tail = text.slice(last);
	const flooredTail = redactSecrets(tail);
	if (flooredTail !== tail) changed = true;
	parts.push(flooredTail);
	return changed ? parts.join('') : text;
}

// JSON-quoted key form the loose pattern cannot bridge: `"api_key": "v"` —
// the closing quote of the key and the opening quote of the value fall
// outside the loose key/value classes, so this needs its own pass. The
// value may not be this redactor's own placeholder (quoted or not): the
// export re-redacts every record, so a re-match counts a redaction that
// removed nothing.
const QUOTED_JSON_CREDENTIAL_PATTERN =
	/(["'])([A-Za-z0-9_ -]{0,40}(?:token|secret|password|passwd|authorization|credential|bearer|api[-_ ]?key|access[-_ ]?key)[A-Za-z0-9_ -]{0,40})\1(\s*:\s*)(["'])((?!<redacted>)[^"'\n]{4,})\4/gi;

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
	{
		// Contextual AWS arm: AKIA access-key ID + up to 200 chars of interposed
		// text + adjacent 40-char secret. Placed before the bare AKIA arm so the
		// composite span is redacted whole (F-001 / critic recommendation: the
		// bare pass must not destroy the AKIA anchor before the floor's own
		// contextual arm can use it).
		label: '<redacted:aws>',
		re: /\bAKIA[0-9A-Z]{16}[^\n]{0,200}?\b[A-Za-z0-9/+=]{40}\b/g,
	},
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
	/** 'scanner' = the shared JWS scanner; 'bare' = a credential-family arm. */
	origin: 'scanner' | 'bare';
}

/**
 * Merge overlapping planned ranges into DISJOINT ranges.
 *
 * Same policy as the evidence site (src/security/evidence-redaction.ts): the
 * union of two OVERLAPPING credential spans is credential material, so
 * merging them removes the old clip policy's two failures — an arm match
 * starting inside a scanner span and extending past it used to be DROPPED
 * whole (stranding the secret tail), and a clipped head shorter than 12
 * characters used to be dropped as well. Merging also removes the
 * duplicate-range corruption (two arms matching the same text pushed two
 * overlapping ranges and the reverse splice ate the first placeholder) and
 * lets the output be built in ONE pass instead of rebuilding the string per
 * range (which was quadratic in the number of matches).
 */
function mergePlannedRanges(raw: Replacement[]): Replacement[] {
	raw.sort(
		(a, b) =>
			a.start - b.start ||
			b.end - a.end ||
			(a.origin === b.origin ? 0 : a.origin === 'scanner' ? -1 : 1),
	);
	const merged: Replacement[] = [];
	for (const r of raw) {
		const last = merged[merged.length - 1];
		if (last && r.start < last.end) {
			if (r.end > last.end) last.end = r.end;
			// A credential-family label is more specific than the scanner's
			// generic 'jwt' label, so a bare arm wins the merged label.
			if (last.origin === 'scanner' && r.origin === 'bare') {
				last.label = r.label;
				last.origin = 'bare';
			}
			continue;
		}
		merged.push({ ...r });
	}
	return merged;
}

/**
 * Whole-span union pass (#3840): the shared JWS scanner's spans and the bare
 * credential-family arms are collected together and merged into disjoint
 * ranges, so no overlapping span can strand a tail or drop a head.
 */
function redactBareValueShapes(content: string): {
	text: string;
	redactions: number;
} {
	const scannerSpans = findRedactableTokenSpans(content);
	const raw: Replacement[] = scannerSpans.map((span) => ({
		start: span.start,
		end: span.end,
		label: '<redacted:jwt>',
		origin: 'scanner',
	}));
	for (const arm of TRAINING_BARE_TOKEN_VALUE_PATTERNS) {
		arm.re.lastIndex = 0;
		for (const match of content.matchAll(arm.re)) {
			if (!match[0]) continue;
			if (arm.guard && !arm.guard(match[0])) continue;
			const start = match.index ?? 0;
			raw.push({
				start,
				end: start + match[0].length,
				label: arm.label,
				origin: 'bare',
			});
		}
	}
	const planned = mergePlannedRanges(raw);
	if (planned.length === 0) return { text: content, redactions: 0 };
	let text = '';
	let cursor = 0;
	for (const r of planned) {
		text += content.slice(cursor, r.start) + r.label;
		cursor = r.end;
	}
	text += content.slice(cursor);
	return { text, redactions: planned.length };
}

export interface RedactionResult {
	content: string;
	applied: boolean;
	redactions: number;
}

/**
 * The withheld-content marker the fail-closed catch returns.
 *
 * A record whose content carries this marker was NOT safely redacted - the
 * redactor failed internally and withheld the content instead of storing it
 * raw. Export surfaces treat that as a hard failure (the bundle is not
 * published) rather than shipping a withheld record as if it were redacted.
 */
export const TRAINING_REDACTION_FAILED_PLACEHOLDER =
	'<redacted:redaction-failed>';

/**
 * Test seam: lets a test make the bare-value pass throw so the fail-closed
 * catch path can be exercised. Production defaults unchanged.
 */
export const _internals = {
	redactBareValueShapes,
};

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
			(_match, separator: string, prefix: string, value: string) => {
				// Already redacted: keep the bytes, count nothing.
				if (isPlaceholderOnly(value)) return _match;
				redactions += 1;
				// The placeholder is UNQUOTED even for a quoted value: the
				// merge base stores `api_key=<redacted>` for `api_key="v"`, and
				// the frozen preserving contract pins those bytes. (Keeping the
				// quotes was an incidental change that broke it.)
				return `${separator}${prefix}<redacted>`;
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
		const bare = _internals.redactBareValueShapes(working);
		working = bare.text;
		redactions += bare.redactions;
		// #3893 AC4 (F2): compose the persisted-store floor. The placement
		// classes and bare families above cover SHAPES; `redactSecrets` is the
		// persisted-store corpus (memory redaction families: PEM private-key
		// blocks, Stripe, GitLab, AWS, ...) plus the memory site's fill-class
		// condensed-view re-link and jws_span union — the same floor the
		// evidence path composes. Composed LAST so its families operate on the
		// already-placement-redacted text; counted as ONE floor redaction
		// (the floor is one pass, matching the evidence-path counting). The
		// floor carries the SAME placeholder guard as the arms above (it runs
		// only on segments OUTSIDE complete placeholders — either vocabulary):
		// the memory env_secret arm is case-insensitive over `…_key=`-shaped
		// assignments, so an unguarded floor would re-consume the training
		// arm's own `api_key=<redacted>` output and break the export
		// re-redaction fixed point. Masking keeps every stored placeholder a
		// fixed point of the composed redactor.
		const floored = applyFloorAroundPlaceholders(working);
		if (floored !== working) {
			redactions += 1;
			working = floored;
		}
	} catch {
		return {
			content: TRAINING_REDACTION_FAILED_PLACEHOLDER,
			applied: true,
			redactions: 1,
		};
	}
	return { content: working, applied: redactions > 0, redactions };
}
