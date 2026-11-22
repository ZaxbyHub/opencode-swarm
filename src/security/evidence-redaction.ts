/**
 * #3844: redaction for free text that crosses a DURABLE evidence boundary
 * (a `.swarm` artifact write, an agent-output surface, or a forge
 * publication). This is the SUPERSET redactor: it composes the existing
 * persisted-store corpus (`redactSecrets`, src/memory/redaction.ts — private
 * keys, openssh blocks, gitlab/stripe/aws shapes and its full 14-family set)
 * with the display-site bare-value families + azure
 * (src/failures/invocation-failure.ts / src/hooks/guardrails/helpers.ts
 * corpus), URL credential stripping (userinfo + credential-bearing
 * query/fragment), and the shared JWS scanner
 * (src/utils/jws-redaction.ts). Unlike the display sanitizer it applies NO
 * 512-byte display bound — evidence keeps its full content budget.
 *
 * Ordering: the scanner spans and the bare credential-family arms are
 * collected TOGETHER and merged into disjoint ranges, so an overlapping arm
 * can neither strand a tail nor drop a head (a secret-bearing prefix before
 * an eyJ run keeps its family label). Then the context arms run over that
 * placeholder-bearing output: the persisted-store corpus (`redactSecrets`),
 * the credential PLACEMENT shapes (key/value, quoted-JSON, scheme-prefixed),
 * and URL credential stripping (userinfo + credential-bearing query).
 * Fail-closed: on internal error the text is withheld (placeholder), never
 * returned raw.
 */

import { redactSecrets } from '../memory/redaction';
import { findRedactableTokenSpans } from '../utils/jws-redaction';

/**
 * URL userinfo credentials. The scheme is matched GENERICALLY, not just
 * http/https: a `postgres://`, `mongodb+srv://`, `ssh://` or `redis://`
 * connection string carries its password in the userinfo the same way, and
 * the shell site's `[a-zA-Z][a-zA-Z0-9+.-]{0,32}://` is the precedent.
 */
const URL_CREDENTIALS_PATTERN =
	/(\b[a-zA-Z][a-zA-Z0-9+.-]{0,32}:\/\/)([^\s/@:]+):([^\s/@]+)@([^\s'"<>]+)/gi;

/**
 * Credential PLACEMENT shapes, mirrored from the training redactor
 * (src/training/redact.ts) so the evidence path stays a true superset of the
 * surfaces the training vault already covers. The persisted-store corpus
 * (`redactSecrets`) only matches a key with a PREFIX_ segment, so an
 * unprefixed `password=`, `password:`, `{"password": "..."}`, `PASSWORD=`,
 * `passwd=`, `token=` or `api_key:` survived on the evidence path.
 */
const EVIDENCE_CREDENTIAL_KV_PATTERN =
	/(?:^|[\s,;"'([{])([A-Za-z0-9_ -]{0,40}(?:token|secret|password|passwd|authorization|credential|bearer|api[-_ ]?key|access[-_ ]?key)[A-Za-z0-9_ -]{0,40}\s*[=:]\s*)(?:bearer|basic|digest|negotiate|apikey)?\s*(?:["'][^"'\n]*["']|[^\s,;"'}\]]+)/gi;

/** The quoted-JSON key form the loose key/value pattern cannot bridge. */
const EVIDENCE_QUOTED_JSON_CREDENTIAL_PATTERN =
	/(["'])([A-Za-z0-9_ -]{0,40}(?:token|secret|password|passwd|authorization|credential|bearer|api[-_ ]?key|access[-_ ]?key)[A-Za-z0-9_ -]{0,40})\1(\s*:\s*)(["'])([^"'\n]{4,})\4/gi;

/**
 * A scheme-prefixed token with no key morpheme (`Bearer <token>`). The value
 * class cannot start at `[`, so an already-inserted placeholder is never
 * re-matched.
 */
const EVIDENCE_SCHEME_TOKEN_PATTERN =
	/\b(bearer|basic)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi;
const URL_QUERY_CREDENTIALS_PATTERN =
	/([?&])((?:access_token|api_key|apikey|token|secret|signature|client_secret)=)([^\s&'"<>]+)/gi;

const EVIDENCE_BARE_TOKEN_VALUE_PATTERNS: ReadonlyArray<{
	label: string;
	re: RegExp;
	guard?: (match: string) => boolean;
}> = [
	{ label: '[REDACTED:anthropic]', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
	{ label: '[REDACTED:openrouter]', re: /\bsk-or-[A-Za-z0-9_-]{20,}/g },
	{ label: '[REDACTED:openai]', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
	{
		label: '[REDACTED:github]',
		re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
	},
	{ label: '[REDACTED:github]', re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
	{ label: '[REDACTED:aws]', re: /\bAKIA[0-9A-Z]{16}\b/g },
	{ label: '[REDACTED:slack]', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
	{ label: '[REDACTED:google]', re: /\bAIza[A-Za-z0-9_-]{30,}/g },
	{ label: '[REDACTED:google]', re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/g },
	{ label: '[REDACTED:google]', re: /\bya29\.[A-Za-z0-9_-]{20,}/g },
	{ label: '[REDACTED:groq]', re: /\bgsk_[A-Za-z0-9]{20,}/g },
	{
		label: '[REDACTED:azure]',
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

export interface EvidenceRedactionResult {
	text: string;
	redactions: number;
}

/**
 * Merge overlapping planned ranges into DISJOINT ranges.
 *
 * A credential-family arm and a JWS scanner span can overlap three ways, and
 * the previous clip policy mishandled two of them:
 *   - the arm starts BEFORE the scanner span -> the prefix was clipped and
 *     redacted under the family label (that part was intended);
 *   - the arm starts INSIDE the scanner span and extends PAST it -> the whole
 *     arm match was DROPPED, so the tail (the actual secret value) survived;
 *   - the arm starts INSIDE the scanner span and is SHORTER -> the arm match
 *     was dropped, and the 12-character floor then dropped the clipped head
 *     too, so a short family prefix survived in the clear.
 * The union of two OVERLAPPING credential spans is credential material, so
 * merging them into one range removes the clip entirely: no stranded tail,
 * no dropped head, and no duplicate-range corruption (two arms matching the
 * same text used to push two overlapping ranges, and the reverse splice ate
 * the first placeholder). Building the output from the merged, disjoint
 * ranges in ONE pass also removes the per-range string rebuild that made the
 * pass quadratic in the number of matches.
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

function redactBareAndScanner(content: string): EvidenceRedactionResult {
	const raw: Replacement[] = findRedactableTokenSpans(content).map((span) => ({
		start: span.start,
		end: span.end,
		label: '[REDACTED:jwt]',
		origin: 'scanner',
	}));
	for (const arm of EVIDENCE_BARE_TOKEN_VALUE_PATTERNS) {
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

/**
 * Test seam: lets a test make the context-corpus pass throw so the
 * fail-closed catch path can be exercised. Production defaults unchanged.
 */
export const _internals = {
	redactSecrets,
};

/**
 * Clamp a REDACTED free-text field back inside its schema bound.
 *
 * A redaction placeholder can be LONGER than the secret it replaces — a
 * short `?token=abc` value becomes `?token=[REDACTED]` (+7) and a URL
 * userinfo grows by 23 characters — so a value that sat exactly on its
 * schema max can be pushed PAST it by the redaction itself. The persisted
 * artifact would then fail its schema on read (a receipt whose validations
 * exceed `FindingValidationSchema`'s 2000-character evidence bound reads
 * back as missing).
 *
 * The value is already secret-free at this point, so truncating it is safe.
 * A trailing PARTIAL placeholder fragment is dropped with it, so the
 * persisted value never shows half a marker.
 */
export function clampRedactedText(value: string, max: number): string {
	if (value.length <= max) return value;
	let cut = value.slice(0, max);
	// A cut can land INSIDE a redaction marker ('[REDACTED]' -> '[RE'). A
	// half-written marker is not a usable value, so the fragment is dropped
	// rather than persisted.
	const square = cut.lastIndexOf('[');
	if (square !== -1) {
		const tail = cut.slice(square);
		if (
			tail !== '[REDACTED]' &&
			('[REDACTED'.startsWith(tail) || tail.startsWith('[REDACTED'))
		) {
			cut = cut.slice(0, square);
		}
	}
	const angle = cut.lastIndexOf('<');
	if (angle !== -1) {
		const tail = cut.slice(angle);
		if (
			!tail.endsWith('>') &&
			('<redacted'.startsWith(tail) || tail.startsWith('<redacted'))
		) {
			cut = cut.slice(0, angle);
		}
	}
	return cut;
}

/**
 * Redact credential material from evidence free text. Pure; never throws —
 * on internal failure the WHOLE text is withheld (fail-closed), never
 * returned raw.
 */
export function redactEvidenceText(text: string): string {
	if (typeof text !== 'string' || text.length === 0) return text;
	try {
		// Span-union pass FIRST, on the ORIGINAL text: computing scanner spans
		// after the context corpus would let redactSecrets' three-part JWT
		// regex consume the head of a five-part JWE, stranding its tail
		// segments (#3844 round-5 review finding; executed probe confirmed
		// segments 4-5 survived under context-first ordering). Placeholders
		// are inert for every later context arm.
		const bare = redactBareAndScanner(text);
		let working = bare.text;
		// Context corpus (private-key blocks, KV shapes, bearer, etc.) runs
		// over the placeholder-bearing union output — placeholders are inert
		// for every context arm.
		working = _internals.redactSecrets(working);
		// Credential PLACEMENT shapes (key/value, quoted-JSON, scheme) — the
		// persisted-store corpus only matches a PREFIXED key, so these are
		// ported from the training redactor to keep the evidence path a
		// superset of the surface the training vault already covers.
		working = working.replace(
			EVIDENCE_CREDENTIAL_KV_PATTERN,
			(_m, prefix: string) => `${prefix}[REDACTED]`,
		);
		working = working.replace(
			EVIDENCE_QUOTED_JSON_CREDENTIAL_PATTERN,
			(_m, openQuote: string, key: string, sep: string) =>
				`${openQuote}${key}${openQuote}${sep}${openQuote}[REDACTED]${openQuote}`,
		);
		working = working.replace(
			EVIDENCE_SCHEME_TOKEN_PATTERN,
			(_m, scheme: string, space: string) => `${scheme}${space}[REDACTED]`,
		);
		working = working.replace(
			URL_CREDENTIALS_PATTERN,
			(_m, scheme: string, _user: string, _pass: string, host: string) =>
				`${scheme}[REDACTED:url-credentials]@${host}`,
		);
		working = working.replace(
			URL_QUERY_CREDENTIALS_PATTERN,
			(_m, sep: string, key: string) => `${sep}${key}[REDACTED]`,
		);
		return working;
	} catch {
		return '[REDACTED:evidence-redaction-failed]';
	}
}

/**
 * #3844 fold-in (owner-directed; closes #3899): recursively redact every
 * STRING value inside an arbitrary JSON-shaped payload (objects and arrays;
 * non-string leaves pass through unchanged). Structural identity (keys,
 * array order, numbers, booleans, null) is preserved so consumers that
 * destructure the persisted shape keep working. Used at durable boundaries
 * whose free text lives in producer-controlled fields (gate-evidence
 * passthrough extras).
 */
export function redactEvidenceDeep<T>(value: T): T {
	if (typeof value === 'string') {
		return redactEvidenceText(value) as unknown as T;
	}
	if (Array.isArray(value)) {
		return value.map((item) => redactEvidenceDeep(item)) as unknown as T;
	}
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(
			value as Record<string, unknown>,
		)) {
			out[key] = redactEvidenceDeep(item);
		}
		return out as unknown as T;
	}
	return value;
}
