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
 * Ordering: scanner spans first (they win over any overlapping arm), then
 * context arms (private-key blocks / KV via redactSecrets, URL credentials),
 * then the bare families. Fail-closed: on internal error the text is
 * withheld (placeholder), never returned raw.
 */

import { redactSecrets } from '../memory/redaction';
import { findRedactableTokenSpans } from '../utils/jws-redaction';

const URL_CREDENTIALS_PATTERN =
	/(\bhttps?:\/\/)([^\s/@:]+):([^\s/@]+)@([^\s'"<>]+)/gi;
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
}

export interface EvidenceRedactionResult {
	text: string;
	redactions: number;
}

function redactBareAndScanner(content: string): EvidenceRedactionResult {
	const planned: Replacement[] = findRedactableTokenSpans(content).map(
		(span) => ({ start: span.start, end: span.end, label: '[REDACTED:jwt]' }),
	);
	for (const arm of EVIDENCE_BARE_TOKEN_VALUE_PATTERNS) {
		arm.re.lastIndex = 0;
		for (const match of content.matchAll(arm.re)) {
			if (!match[0]) continue;
			if (arm.guard && !arm.guard(match[0])) continue;
			const start = match.index ?? 0;
			let end = start + match[0].length;
			// Overlap policy (#3844 round-5): a bare match overlapping a
			// scanner span is CLIPPED to its non-overlapping head rather than
			// dropped — a secret-bearing prefix before an eyJ run keeps its
			// family label on the covered portion instead of surviving clear.
			const overlap = planned.find((r) => start < r.end && end > r.start);
			if (overlap && overlap.start > start) {
				end = overlap.start;
			} else if (overlap) {
				continue;
			}
			if (end - start >= 12) {
				planned.push({ start, end, label: arm.label });
			}
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
		working = redactSecrets(working);
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
