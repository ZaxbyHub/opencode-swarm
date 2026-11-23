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
 * connection string carries its password in the userinfo the same way.
 *
 * RFC 3986 bounds the scheme's SYNTAX, not its length, so the quantifier is
 * unbounded (`*`) — a bounded scheme class would silently leave a long
 * scheme's userinfo unredacted.
 *
 * The scan is LINEAR. A leading `\b` was not enough: `\b` matches at every
 * word start, so a colon-free run like `a.a.a...` restarted the scheme scan
 * at each word and rescanned the remaining suffix — quadratic (measured:
 * 64 KB of `a.` took 4.2 s, 128 KB ~17 s).
 *
 * Two rules make it linear AND keep the coverage `\b` had:
 *   - the scheme may only START where the preceding character cannot be part
 *     of a scheme (`(?<![A-Za-z0-9+.-])`), which rejects the interior
 *     positions in O(1) and leaves one attempt per scheme run;
 *   - the scheme class covers EVERY scheme character (not just a leading
 *     letter), so the attempt that survives always consumes the WHOLE run
 *     before `://`. A URL that follows an ellipsis (`...https://...`), a
 *     dash, a plus or a digit (`1.https://...`) is therefore still matched —
 *     the `\b` arm matched those, and rejecting them would lose coverage.
 *
 * The negative lookbehind is fixed-width, so it is portable (the repo
 * already uses lookbehind in src/).
 */
const URL_CREDENTIALS_PATTERN =
	/(?<![A-Za-z0-9+.-])([a-zA-Z0-9+.-]+:\/\/)([^\s/@:]+):([^\s/@]+)@([^\s'"<>]+)/gi;

/**
 * Credential PLACEMENT shapes, mirrored from the training redactor
 * (src/training/redact.ts) so the evidence path stays a true superset of the
 * surfaces the training vault already covers. The persisted-store corpus
 * (`redactSecrets`) only matches a key with a PREFIX_ segment, so an
 * unprefixed `password=`, `password:`, `{"password": "..."}`, `PASSWORD=`,
 * `passwd=`, `token=` or `api_key:` survived on the evidence path.
 *
 * Three properties the arm MUST hold:
 *   - The leading separator is CAPTURED and re-emitted. It used to be part of
 *     the match but not of the replacement, so `the token=abc` came back as
 *     `thetoken=[REDACTED]` — the words were glued together.
 *   - A value made ONLY of complete placeholders (the bracket form this
 *     arm emits, or the training vault's `<redacted...>` form) is a FIXED
 *     point: the bare value class is a repetition whose alternatives are
 *     those two placeholders and any non-delimiter character, and the
 *     replacement re-emits one generic placeholder. Earlier, the value
 *     class excluded `]` but allowed `[`, so the arm re-matched its own
 *     placeholder and `password=[REDACTED]` grew by one bracket per pass
 *     — the redactor is applied more than once on the same text, and a
 *     non-idempotent arm made the evidence copy and the receipt copy of
 *     one finding differ. The repetition also consumes a composite value
 *     (a placeholder followed by more secret material, anywhere in the
 *     value) whole.
 *   - A quoted value keeps its quotes.
 */
const EVIDENCE_CREDENTIAL_KV_PATTERN =
	/(^|[\s,;"'([{])([A-Za-z0-9_ -]{0,40}(?:token|secret|password|passwd|authorization|credential|bearer|api[-_ ]?key|access[-_ ]?key)[A-Za-z0-9_ -]{0,40}\s*[=:]\s*)(?:bearer|basic|digest|negotiate|apikey)?\s*("[^"'\n]*"|'[^'\n]*'|(?:\[REDACTED[^\]\s]*\]|<redacted[^>\s]*>|[^\s,;"'}\]])(?:\[REDACTED[^\]\s]*\]|<redacted[^>\s]*>|[^\s,;"'}\]])*)/gi;

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
/**
 * The credential-bearing query parameters of a URL.
 *
 * The training redactor replaces a WHOLE URL, so a `?password=...` (or an
 * Azure SAS `&sig=...`, or an S3 `X-Amz-Signature=...`) is covered there; the
 * evidence path redacts the credential PARAMETER instead of the whole URL, so
 * the parameter names have to be enumerated here — including the
 * vendor-prefixed ones (`X-Amz-*`, `X-Goog-*`) and the URL FRAGMENT form.
 */
const URL_QUERY_CREDENTIALS_PATTERN =
	/([?&#])((?:access_token|api_key|apikey|api-key|x-api-key|token|secret|password|passwd|pass|pwd|credential|signature|sig|auth|jwt|client_secret|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)=)([^\s&"<>#]+)/gi;

const EVIDENCE_BARE_TOKEN_VALUE_PATTERNS: ReadonlyArray<{
	label: string;
	re: RegExp;
	guard?: (match: string) => boolean;
	/**
	 * The exact replacement for the matched span.
	 */
	replace?: (match: string, ...groups: string[]) => string;
	/**
	 * When set, the arm's RANGE is this capture group's span inside the
	 * match rather than the whole match. The AWS context arm uses it to
	 * redact the 40-character secret WITHOUT swallowing the prose between
	 * the access-key id and the secret: that prose can itself carry a
	 * credential, and a range that covered it would replace it with raw
	 * text (the other arms would never see it).
	 */
	group?: number;
}> = [
	{ label: '[REDACTED:anthropic]', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
	{ label: '[REDACTED:openrouter]', re: /\bsk-or-[A-Za-z0-9_-]{20,}/g },
	{ label: '[REDACTED:openai]', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
	{
		label: '[REDACTED:github]',
		re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
	},
	{ label: '[REDACTED:github]', re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
	{
		// The AWS secret CONTEXT: the 40-character secret is only
		// recognizable NEXT TO its access-key id. The arm's RANGE is the
		// SECRET alone (the `group` field) — the prose between the id
		// and the secret is left alone, because it can itself carry a
		// credential that the other arms must still see (re-inserting it
		// verbatim inside this arm's replacement put it back in the clear).
		// The id is redacted by the bare id arm below.
		label: '[REDACTED:aws-secret]',
		re: /(AKIA[0-9A-Z]{16})([^\n]{0,200}?)\b([A-Za-z0-9/+=]{40})\b/dg,
		group: 3,
	},
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
	{
		// The training redactor's >=80-char mixed-class base64 family
		// (src/training/redact.ts). The evidence path must stay a true
		// SUPERSET of the surfaces the training vault already covers: an
		// undotted base64 secret that the vault redacts before export used
		// to survive in the clear on the evidence path, because neither the
		// persisted-store corpus (no standalone mixed-class base64 arm) nor
		// the display families below match it. The guard keeps hex-only SHA
		// digests, uppercase-hex runs and sub-80 payloads visible (the same
		// #3712 F-013 rule the training path applies).
		label: '[REDACTED:base64]',
		re: /[A-Za-z0-9+/]{80,}={0,2}/g,
		guard: (match) =>
			/[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9]/.test(match),
	},
];

interface Replacement {
	start: number;
	end: number;
	label: string;
	/** 'scanner' = the shared JWS scanner; 'bare' = a credential-family arm. */
	origin: 'scanner' | 'bare';
	/**
	 * The EXACT replacement text for the range (defaults to `label`). An arm
	 * that must keep part of the matched span (e.g. the prose between an
	 * access-key id and its secret) supplies it here.
	 */
	text?: string;
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
				last.text = r.text ?? r.label;
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
			const groupSpan =
				arm.group !== undefined ? match.indices?.[arm.group] : undefined;
			const start = groupSpan ? groupSpan[0] : (match.index ?? 0);
			const end = groupSpan ? groupSpan[1] : start + match[0].length;
			raw.push({
				start,
				end,
				label: arm.label,
				origin: 'bare',
				...(arm.replace
					? { text: arm.replace(match[0], ...match.slice(1)) }
					: {}),
			});
		}
	}
	const planned = mergePlannedRanges(raw);
	if (planned.length === 0) return { text: content, redactions: 0 };
	let text = '';
	let cursor = 0;
	for (const r of planned) {
		text += content.slice(cursor, r.start) + (r.text ?? r.label);
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
 * Drop a trailing INCOMPLETE redaction-marker fragment from a cut value.
 *
 * A cut can land INSIDE a marker ('[REDACTED]' -> '[RE',
 * '[REDACTED:github]' -> '[REDACTED:gi'). A half-written marker is not a
 * usable value, so the fragment is dropped rather than persisted.
 *
 * A COMPLETE marker is NOT a fragment and is KEPT. The earlier test dropped
 * any tail merely STARTING with the marker head, which emptied the whole
 * value whenever the text began with a redacted secret — and an empty
 * `FindingValidationSchema`/`ReviewFindingSchema` field fails its
 * `.min(1)` bound, so the finding disappeared from the persisted receipt
 * (the very failure this clamp exists to prevent).
 *
 * @param cut the already-truncated value
 * @param open the marker's opening delimiter
 * @param close the marker's closing delimiter
 * @param head the marker head a fragment starts with
 */
function stripIncompleteMarkerFragment(
	cut: string,
	open: string,
	close: string,
	head: string,
): string {
	for (let i = cut.length - 1; i >= 0; i -= 1) {
		if (cut[i] !== open) continue;
		const tail = cut.slice(i);
		// A one-character tail IS a fragment: a cut that lands right after the
		// marker's opening delimiter leaves a bare `[` (or `<`), which is
		// the head of a marker, not usable content.
		const markerish = head.startsWith(tail) || tail.startsWith(head);
		if (!markerish) continue;
		// A closing delimiter inside the tail means the marker is COMPLETE
		// in the cut — it is real content, not a fragment.
		if (tail.includes(close)) return cut;
		return cut.slice(0, i);
	}
	return cut;
}

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
 * persisted value never shows half a marker; a COMPLETE placeholder is kept,
 * and the result is never emptied (a schema-bound field has a `.min(1)`
 * floor, so an empty value would drop the finding instead of bounding it).
 */
export function clampRedactedText(value: string, max: number): string {
	if (value.length <= max) return value;
	const cut = value.slice(0, max);
	const stripped = stripIncompleteMarkerFragment(
		stripIncompleteMarkerFragment(cut, '<', '>', '<redacted'),
		'[',
		']',
		'[REDACTED',
	);
	// A stripped fragment that would leave NOTHING behind is worse than a
	// half marker: a schema-bound field has a `.min(1)` floor, so an empty
	// value drops the finding instead of bounding it. (Unreachable for the
	// real bounds — every marker is shorter than every field's max — but the
	// clamp is a shared helper and must not be able to empty a value.)
	return stripped.length > 0 ? stripped : cut;
}

/**
 * One redaction pass over the text.
 *
 * The order matters: the span-union pass runs FIRST on the original text
 * (computing the scanner spans and the bare credential-family arms together),
 * then the persisted-store context corpus runs over the whole
 * placeholder-bearing output, then the credential PLACEMENT shapes run.
 */
function redactEvidenceOnce(text: string): string {
	// Span-union pass FIRST, on the ORIGINAL text: computing scanner spans
	const bare = redactBareAndScanner(text);
	let working = bare.text;
	// Context corpus (private-key blocks, KV shapes, bearer, etc.) runs
	// over the placeholder-bearing union output — over the WHOLE text,
	// because a corpus pattern can span several lines (a private-key
	// block needs both delimiters in ONE match) and a placeholder in
	// the middle of such a span must not break the match.
	working = _internals.redactSecrets(working);
	// Credential PLACEMENT shapes (key/value, quoted-JSON, scheme) — the
	// persisted-store corpus only matches a PREFIXED key, so these are
	// ported from the training redactor to keep the evidence path a
	// superset of the surface the training vault already covers.
	working = working.replace(
		EVIDENCE_CREDENTIAL_KV_PATTERN,
		(_m: string, separator: string, prefix: string, value: string) => {
			const quoted =
				value.length >= 2 &&
				(value.startsWith('"') || value.startsWith("'")) &&
				value.endsWith(value[0]);
			const placeholder = quoted
				? `${value[0]}[REDACTED]${value[0]}`
				: '[REDACTED]';
			return `${separator}${prefix}${placeholder}`;
		},
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
}

/**
 * How many times the pass may run before the result is returned as-is.
 *
 * One pass is not always enough: a bare credential-family arm is anchored on
 * a word boundary, so a credential GLUED to a preceding word character
 * (`creds AKIA…sk-ant-…`) has no boundary and is skipped; the context corpus
 * then replaces the neighbouring token with a placeholder that ENDS the word,
 * so the NEXT pass sees the boundary the credential needed. The loop runs
 * until the output stops changing, which makes the result a FIXED POINT —
 * re-applying the redactor to it changes nothing.
 */
const MAX_REDACTION_PASSES = 4;

/**
 * Redact credential material from evidence free text. Pure; never throws —
 * on internal failure the WHOLE text is withheld (fail-closed), never
 * returned raw.
 *
 * The result is a fixed point of the redaction: the same value is redacted
 * more than once on this path (the review evidence is redacted at assembly
 * and again at persistence, the receipt is redacted again when it is
 * persisted, the forge queue re-redacts a stored message on every rewrite),
 * and the evidence copy and the receipt copy of one finding must be
 * byte-identical.
 */
export function redactEvidenceText(text: string): string {
	if (typeof text !== 'string' || text.length === 0) return text;
	try {
		let working = text;
		for (let pass = 0; pass < MAX_REDACTION_PASSES; pass++) {
			const next = redactEvidenceOnce(working);
			if (next === working) return working;
			working = next;
		}
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

/**
 * The schema bounds a redacted review finding is read back against:
 * `ReviewFindingSchema` (title <= 200, body <= 2000) and
 * `FindingValidationSchema` (evidence <= 2000).
 *
 * The evidence path and the receipt path persist TWO copies of the same
 * finding, and the auto-review evidence integrity check compares them. Both
 * copies must therefore be produced by the SAME function with the SAME
 * bound — otherwise the two copies differ and the check rejects the pair.
 * These constants are the single source of truth for both sides.
 */
export const EVIDENCE_FINDING_TITLE_MAX = 200;
export const EVIDENCE_FINDING_BODY_MAX = 2000;
export const EVIDENCE_VALIDATION_EVIDENCE_MAX = 2000;
/**
 * The finding's FILE path is model-authored free text (for an unanchored
 * finding it is whatever the model wrote), so it is redacted like the other
 * free-text fields. The bound is `ReviewFindingSchema`'s (`file` <= 500).
 */
export const EVIDENCE_FINDING_FILE_MAX = 500;

/**
 * The canonical persisted form of one redacted free-text field: redact, then
 * clamp back inside the schema bound the field is read back against.
 *
 * The pair runs to a FIXED POINT: the clamp can cut a value where a
 * credential-shaped run begins (a cut that ends in `sk_live_…` makes the
 * Stripe arm match on the NEXT application), so a single pass is not
 * idempotent. The field's identity is derived from this value, and the
 * evidence copy and the receipt copy of one finding must be byte-identical,
 * so the value has to be stable under re-application.
 */
export function redactEvidenceField(value: string, max: number): string {
	let current = value;
	for (let pass = 0; pass < MAX_REDACTION_PASSES; pass++) {
		const next = clampRedactedText(redactEvidenceText(current), max);
		if (next === current) return current;
		current = next;
	}
	return current;
}
