import { createHash } from 'node:crypto';
import { findRedactableTokenSpans } from '../utils/jws-redaction.js';
import {
	extractStatusCode,
	MODEL_UNAVAILABLE_PATTERN,
	QUOTA_ERROR_PATTERN,
	REQUEST_SHAPE_REJECTION_PATTERN,
	TRANSIENT_MODEL_ERROR_PATTERN,
	TRANSIENT_STATUS_CODES,
} from '../utils/provider-error-classification.js';
import type {
	ActionIdentityInput,
	ActionIdentityV1,
} from './action-identity.js';
import { createActionIdentity } from './action-identity.js';

const MAX_DISPLAY_BYTES = 512;
const MAX_STRUCTURED_STRING = 128;

export type InvocationFailureSource =
	| 'provider'
	| 'shell'
	| 'filesystem'
	| 'git'
	| 'policy'
	| 'validation'
	| 'cancellation'
	| 'deadline';

export type InvocationFailureRetryClass =
	| 'retry_same'
	| 'retry_fallback'
	| 'repair_then_retry'
	| 'operator_action'
	| 'do_not_retry';

export type InvocationFailureRisk = 'low' | 'medium' | 'high';

export interface InvocationFailureEvidence {
	display: string;
	statusCode?: number;
	exitCode?: number;
	code?: string;
	signal?: string;
}

export interface InvocationFailureRecordV1 {
	version: 1;
	source: InvocationFailureSource;
	category: string;
	retryClass: InvocationFailureRetryClass;
	risk: InvocationFailureRisk;
	action: ActionIdentityV1 | null;
	evidence: InvocationFailureEvidence;
	occurredAt: string;
}

export interface ToolFailureClassificationInput {
	tool: string;
	args?: unknown;
	output: string;
	error?: unknown;
	metadata?: unknown;
	correlation?: {
		sandboxWrapped?: boolean;
		originalCommand?: string;
	};
}

function hasOwn(
	source: unknown,
	key: string,
): source is Record<string, unknown> {
	return (
		typeof source === 'object' &&
		source !== null &&
		Object.hasOwn(source as Record<string, unknown>, key)
	);
}

function readOwn(source: unknown, key: string): unknown {
	return hasOwn(source, key) ? source[key] : undefined;
}

function boundedString(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed.slice(0, MAX_STRUCTURED_STRING);
}

function boundedUtf8(value: string, maxBytes = MAX_DISPLAY_BYTES): string {
	const buffer = Buffer.from(value, 'utf8');
	if (buffer.byteLength <= maxBytes) return value;
	return buffer
		.subarray(0, maxBytes)
		.toString('utf8')
		.replace(/\uFFFD+$/g, '');
}

function hashValue(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function redactUrl(match: string): string {
	try {
		const parsed = new URL(match);
		const digestSource =
			parsed.origin + parsed.pathname + (parsed.search ? '?<redacted>' : '');
		return `<url:${hashValue(digestSource).slice(0, 12)}>`;
	} catch {
		return `<url:${hashValue(match).slice(0, 12)}>`;
	}
}

/**
 * Whitespace, C0/C1 control chars (`\p{Cc}`), Unicode format chars (`\p{Cf}`,
 * e.g. zero-width space), and default-ignorable code points (`\p{DI}`, e.g.
 * variation selectors and Hangul filler — render as nothing but aren't `Cc`
 * or `Cf`) are all tolerated as "fill" at every inter-token position in the
 * KEY-VALUE redaction patterns below (keyword letters, keyword-to-separator,
 * separator-to-Bearer, Bearer-to-value, suffix-to-`=`) — and inside the bare
 * VALUE shapes via the deletion sweep in step 6, which consumes invisible
 * bytes (Cf/DI) that render as nothing; VISIBLE fill inside a bare token
 * (whitespace, Cc) is a documented residual it does not tolerate (#3165
 * F-1, PR #3705 review round 2): a byte from any of
 * these classes can sit anywhere provider-controlled text places it, and
 * treating only a subset as fill left the rest free to break a `\b` boundary
 * or truncate a match before the real secret (see PR #2363 review history,
 * rounds 1-6, for the specific bypasses this closed). Each fill run is
 * bounded (not `*`) as defense in depth, but the primary ReDoS fix is
 * structural: `SCREAMING_KV_CANDIDATE_PATTERN` below matches the key run
 * with a single flat character class instead of a repeated
 * `(?:[A-Z0-9_]${FILL})*` group — that nesting let the regex engine
 * backtrack over many equivalent fill-length distributions and stayed
 * superlinear even with each individual fill run bounded (round 5).
 *
 * This is best-effort defense-in-depth for a log-display string, not a
 * security boundary: six rounds of closing one invisible/control-character
 * category at a time is evidence that a keyword-matching redactor cannot be
 * made complete against an adversarial Unicode alphabet (e.g. combining
 * marks like U+0300 still defeat it, deliberately not fixed here — see
 * `sanitizeFailureEvidenceDisplay`'s doc comment). Anything downstream that
 * treats this function's output as a guarantee rather than a best effort is
 * relying on more than it provides.
 */
const FILL_MAX_RUN = 8;
const FILL = `[\\s"'\\p{Cc}\\p{Cf}\\p{Default_Ignorable_Code_Point}]{0,${FILL_MAX_RUN}}`;
const CONTROL_CHAR_RUN = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]+/gu;

/** Hard cap on input length before any redaction regex runs, independent of
 * the final `boundedUtf8` display cap — bounds worst-case regex work against
 * adversarially long control-char-heavy input. */
const MAX_SANITIZE_INPUT_CHARS = MAX_DISPLAY_BYTES * 8;

/**
 * Builds a keyword alternative tolerant of a control/whitespace run between
 * every letter, e.g. `tolerantKeyword('token')` matches `t`, optional fill,
 * `o`, optional fill, `k`, … — so "to\x1bken" still matches as one keyword
 * instead of splitting into two non-matching fragments.
 */
function tolerantKeyword(word: string): string {
	return word.split('').join(FILL);
}

// #2485 note: the pre-#2485 keyword list (`bearer`, `token`, `secret`,
// `password`, `authorization`, plus a bespoke `api[_-]?key` shape) was
// replaced by CREDENTIAL_MORPHEMES below — see the Gap 1 doc comment there.

const SCREAMING_SUFFIXES = ['TOKEN', 'KEY', 'SECRET', 'PASSWORD', 'AUTH'];

const TOLERANT_BEARER_PREFIX = tolerantKeyword('Bearer');
/**
 * Fill-tolerant auth SCHEME words tolerated between the separator and the
 * credential value. #2369 Gap 1: only `Bearer` was recognized, so
 * `Authorization: Basic <base64>` redacted the scheme word and left the
 * credential itself in cleartext. The scheme set is the IANA-registered
 * HTTP auth schemes plus `ApiKey` (common in vendor diagnostics).
 */
const TOLERANT_AUTH_SCHEME_PREFIX = `(?:${[
	'Bearer',
	'Basic',
	'Digest',
	'Negotiate',
	'HOBA',
	'Mutual',
	'ApiKey',
]
	.map(tolerantKeyword)
	.join('|')})`;
/**
 * #2369 Gap 1: the credential keyword match is deliberately NOT `\b`-anchored
 * and matches a whole identifier SHAPE — a bounded identifier prefix (≤24
 * identifier chars), one fill-tolerant credential MORPHEME, and a bounded
 * identifier suffix (≤24). `\b` required a genuine word/non-word transition,
 * so glued key names (`access_token=`, `refresh_token=`, `client_secret=`,
 * `private_key=`, `session_key=`, `my_secret=`), prefix-glued `…_key` names,
 * and keyword-suffixed names (`tokenX=`) never matched. Matching the whole
 * identifier shape instead of a lone anchored keyword closes the whole glued
 * family at once; `key`/`credential` join the morpheme set because
 * `private_key`/`session_key` end in `key` without containing any prior
 * morpheme (`auth` is deliberately NOT a morpheme: it would redact every
 * `author=` field in legitimate diagnostics).
 *
 * Consequence, accepted on purpose as defense-in-depth (#2369's own suggested
 * direction): benign identifiers CONTAINING a morpheme (`tokenize=…`,
 * `keyboard=…`) are also redacted. Over-redaction of a log-display string is
 * the safe side of the trade; the value matchers stay whitespace-bounded so
 * the #2363 round-8 cross-line merge regression cannot reopen.
 */
const CREDENTIAL_MORPHEMES = [
	'token',
	'secret',
	'password',
	'authorization',
	'credential',
	'bearer',
	'key',
].map(tolerantKeyword);
/**
 * Suffix charset: identifier characters PLUS every fill class except
 * horizontal space (`\p{Zs}` / U+0020), so a fill byte inserted anywhere in
 * the key tail — between morpheme and suffix identifier chars, or inside the
 * suffix — cannot split the key shape. Space is deliberately excluded: with
 * it, the key could span whole words of prose ("the token count = 42" would
 * redact). A flat class (not a repeated group) keeps this ReDoS-safe — the
 * #2363 round-5 lesson. Accepted residual, documented: a vertical-whitespace
 * byte DIRECTLY between a morpheme and more identifier chars (`TOKEN\nX_ID=`)
 * is tolerated, so a directly-newline-glued identifier pair can be
 * over-redacted as one key; ordinary log lines (which separate the next
 * identifier with a space) are unaffected, exactly like the SCREAMING arm's
 * own trade. The prefix stays pure-identifier: it is opportunistic (output
 * fidelity only); the morpheme alone always matches.
 */
const CREDENTIAL_KEY_SUFFIX_CHARS =
	'\\p{L}\\p{N}_\\-\\x00-\\x1f\\x7f-\\x9f\\p{Cf}\\p{Default_Ignorable_Code_Point}';
const CREDENTIAL_KEY_IDENTIFIER = `[\\p{L}\\p{N}_-]{0,24}(?:${CREDENTIAL_MORPHEMES.join('|')})[${CREDENTIAL_KEY_SUFFIX_CHARS}]{0,24}`;
const CREDENTIAL_KV_PATTERN = new RegExp(
	`(${CREDENTIAL_KEY_IDENTIFIER})${FILL}[:=]${FILL}(?:${TOLERANT_AUTH_SCHEME_PREFIX}${FILL})?(?:${TOLERANT_BEARER_PREFIX}${FILL})?[^\\s,;]+`,
	'giu',
);
/**
 * #2369 Gap 2: ANSI CSI sequences are neutralized to a single space BEFORE
 * redaction runs. An SGR sequence like `\x1b[31m` ends in `m` — a word
 * character — so `\x1b[31mtoken=…` had no `\b` boundary before the keyword
 * and the value shipped in cleartext. Replacing the whole CSI sequence with a
 * space can only CREATE boundaries, never remove them (a separator is
 * substituted, nothing is deleted or joined), so the #2363 split/join fixes
 * stay closed. Parameter runs are bounded (≤32); the
 * {@link BARE_SGR_PARAMETER_RUN} sweep below catches the over-long tail.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the ESC byte IS the match target - a CSI sequence is defined by it (#2485 Gap 2)
const CSI_SEQUENCE = /\x1b\[[0-9;:;<=>?]{0,32}[ !-/]{0,4}[@-~]/gu;
/**
 * Fallback for CSI parameter runs longer than {@link CSI_SEQUENCE}'s bound:
 * after redaction, a residual bare `[<params>m` SGR body (digits/semicolons
 * only, ≥17 chars so ordinary prose like `[0m`-adjacent text is untouched by
 * this arm and handled by the bounded pattern instead) is also replaced with
 * a space so an adversarial 30-digit parameter run cannot both survive and
 * shield an adjacent keyword.
 */
const BARE_SGR_PARAMETER_RUN = /\[[0-9;:]{17,64}m/gu;
/**
 * Matches a candidate SCREAMING_CASE `KEY=value` span using a single flat
 * character class for the key run (bounded to 80 chars) instead of the
 * nested `(?:[A-Z0-9_]${FILL})*` repetition an earlier version used — that
 * nesting let the regex engine backtrack over many equivalent ways to
 * distribute fill-run length across repetitions, causing superlinear time on
 * long fill-heavy input even with each individual fill run bounded (PR #2363
 * review round 5). Whether the key actually contains a credential suffix
 * (TOKEN/KEY/SECRET/PASSWORD/AUTH, tolerant of embedded fill) is checked in
 * JS after the match, not by the regex — see `screamingKeyContainsSuffix`.
 */
/**
 * Fill class for the SCREAMING_KV key run specifically — like `FILL`, but
 * excludes vertical whitespace (`\n`, `\r`, `\v`, `\f`, U+2028/U+2029). The
 * general `FILL` includes all of `\s` because it's used in small, bounded
 * gaps immediately around a fixed keyword (e.g. between "authorization" and
 * its separator); the SCREAMING_KV key run, by contrast, is an unbounded
 * (up to 80-char) span that can legitimately contain space/tab between
 * words. Letting THAT span also cross a newline merges two unrelated log
 * lines into one redaction match — e.g. `AUTH FAILED\nHTTP_STATUS=401`
 * collapsed to `AUTHFAILEDHTTP_STATUS=<redacted>`, destroying the very
 * failure-reason legibility this PR (#2349) exists to preserve, and making
 * different status codes produce byte-identical redacted output (closeout
 * critic finding). Horizontal fill (space/tab/other control/format/DI
 * chars) is still tolerated so the round 1-6 bypasses stay closed; only the
 * line-merging vector is closed here.
 */
const SCREAMING_KEY_HORIZONTAL_FILL_CHARS =
	'\\x00-\\x09\\x0e-\\x1f\\x7f-\\x9f\\p{Zs}\\p{Cf}\\p{Default_Ignorable_Code_Point}';
const SCREAMING_KV_CANDIDATE_PATTERN = new RegExp(
	`\\b([A-Z0-9_${SCREAMING_KEY_HORIZONTAL_FILL_CHARS}]{1,80})${FILL}=${FILL}([^\\s]+)`,
	'gu',
);

function screamingKeyContainsSuffix(key: string): boolean {
	const stripped = key.replace(CONTROL_CHAR_RUN, '').replace(/\s+/g, '');
	return SCREAMING_SUFFIXES.some((suffix) => stripped.includes(suffix));
}

/**
 * Bare well-known credential VALUE shapes (#3165 F-1): content-based, so they
 * fire wherever the token appears — including prose placements with no
 * adjacent `key[:=]value` span ("Incorrect API key provided: sk-proj-…",
 * "please rotate ghp_…"), which the KV arms above cannot match (letters
 * between morpheme and separator defeat FILL, and without a separator neither
 * KV arm fires at all). MIRRORS the token VALUE shapes of
 * `redactShellCommand` (src/hooks/guardrails/helpers.ts) — deliberately a
 * mirror, not a shared module, per the src/training/redact.ts precedent: the
 * failure-display path keeps its small import graph and its own bounded
 * pipeline, and the parity suite (invocation-failure-bare-tokens-3165.test.ts)
 * pins both sites against the same corpus so they cannot drift. ReDoS posture:
 * like the KV arms, each shape's trailing quantifier is individually
 * unbounded; total regex work is bounded by the MAX_SANITIZE_INPUT_CHARS
 * pre-slice. Fill posture: Cf/DI bytes INSIDE a bare token are consumed by
 * the deletion sweep in sanitizeFailureEvidenceDisplay (step 6), and the
 * sweep UNIONS the uncondensed matches so an invisible byte that was itself
 * the \b boundary provider cannot regress head behavior; the residual is a
 * token whose FOLLOWING word character defeats the trailing \b on BOTH
 * views (whitespace/Cc-split bodies plus word-char followers — head-
 * equivalent, still cleartext). VISIBLE fill
 * (whitespace, Cc, combining marks) splitting a bare token remains an
 * accepted residual — stated, not pattern-tolerated, because deleting
 * visible bytes could alter what the reader sees (#2363).
 */
const BARE_TOKEN_VALUE_PATTERNS: ReadonlyArray<{
	family: string;
	re: RegExp;
	/** #3712: optional post-match class guard (the base64 arm requires
	 * upper+lower+digit on the matched run so hex-only digests stay visible). */
	guard?: (match: string) => boolean;
}> = [
	// #3712: specific sk- prefixes BEFORE the openai shape — the openai
	// pattern subsumes `sk-ant-api03-…` and `sk-or-v1-…`, and both the
	// sequential mirror chain and this sweep's leftmost-longest selection
	// keep the FIRST family for identical spans, so ordering (not a
	// lookahead) assigns the rotation-correct provider label.
	{ family: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
	{ family: 'openrouter', re: /\bsk-or-[A-Za-z0-9_-]{20,}/g },
	{ family: 'openai', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
	{
		family: 'github',
		re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
	},
	{ family: 'github', re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
	{ family: 'aws', re: /\bAKIA[0-9A-Z]{16}\b/g },
	{ family: 'slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
	{ family: 'google', re: /\bAIza[A-Za-z0-9_-]{30,}/g },
	// #3712 F-006: Google OAuth client secrets and GCP access tokens.
	{ family: 'google', re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/g },
	{ family: 'google', re: /\bya29\.[A-Za-z0-9_-]{20,}/g },
	// #3712 F-006: Groq service keys.
	{ family: 'groq', re: /\bgsk_[A-Za-z0-9]{20,}/g },
	// #3893 AC13 (F11): additional vendor families, mirrored at the shell
	// site (SHELL_BARE_TOKEN_VALUE_PATTERNS) and pinned by the shared parity
	// corpus. Bounds are conservative minimums per vendor so digests, hashes,
	// and ordinary prose stay visible.
	// Stripe secret/restricted keys: mirrors memory's stripe arm verbatim;
	// \b-anchored both ends (bare `sk_`/`rk_` collides with prose like
	// "risk_live_…").
	{
		family: 'stripe',
		re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g,
	},
	// GitLab PAT/trigger tokens: sub-15 `glpat-` fragments are not real
	// tokens and stay visible.
	{ family: 'gitlab', re: /\bgl(?:pat|ptt)-[A-Za-z0-9_-]{15,}/g },
	// npm granular access tokens: npm's shortest issued shapes are well past
	// 30 alnum body chars.
	{ family: 'npm', re: /\bnpm_[A-Za-z0-9]{30,}/g },
	// Hugging Face access tokens: real tokens are 34+; short `hf_`
	// fragments in prose stay visible.
	{ family: 'huggingface', re: /\bhf_[A-Za-z0-9]{30,}/g },
	// xAI (Grok) API keys: real keys are far longer than the 20-char
	// conservative minimum; hyphenated prose stays visible.
	{ family: 'xai', re: /\bxai-[A-Za-z0-9]{20,}/g },
	// #3712 F-006: JWTs (the HEADER segment is base64url of `{"…`, so it
	// starts with eyJ; the signature closes the token). Matches the WHOLE
	// three-segment token as one span.
	//
	// #3710 review: the PAYLOAD segment is any base64url run, not only a
	// JSON object — an empty claims object encodes as `e30`, not `eyJ` (and a
	// `null`/string payload encodes as `bnVsbA`/`Ingi`).
	{
		family: 'jwt',
		re: /\beyJ[A-Za-z0-9_-]{10,1024}\.[A-Za-z0-9_-]{1,}\.[A-Za-z0-9_-]{10,}/g,
	},
	// #3712 F-013: base64 credential arm at the display site — mirrors the
	// shell site's ≥80-char mixed-class run (the class guard keeps hex-only
	// SHA digests, uppercase-hex runs, and sub-80 payloads visible).
	{
		family: 'base64',
		re: /[A-Za-z0-9+/]{80,}={0,2}/g,
		guard: (match) =>
			/[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9]/.test(match),
	},
];

/**
 * Cf (format) and Default_Ignorable code points (variation selectors,
 * Hangul filler): bytes that render as NOTHING. A byte from either class
 * inside a bare credential token splits it past the `\b`-anchored bare
 * shapes (#3165 F-1 review round), so the display redactor deletes them
 * from the sweep's view. Deletion is the correct transform for this class —
 * unlike visible bytes, removing an invisible byte cannot change what the
 * reader sees.
 */
const BARE_TOKEN_ZERO_WIDTH_FILL_RE =
	/\p{Cf}|\p{Default_Ignorable_Code_Point}/u;

/**
 * #3893 AC14 (F12): quote-aware dash-flag redaction for the display site —
 * mirrors `redactDashFlags` at the shell site
 * (src/hooks/guardrails/helpers.ts). Deliberately a mirror, not a shared
 * module, per the BARE_TOKEN_VALUE_PATTERNS precedent: the failure-display
 * path keeps its small import graph and bounded pipeline, and the parity
 * corpus (invocation-failure-bare-tokens-3165 + the #3710/#3893 suites) pins
 * both sites against the same fixtures so they cannot drift. Until this arm,
 * dash-flag values were left wholly raw at the display site while the shell
 * site redacted them (the #3893 lockstep gap).
 *
 * Manual left-to-right scan (same O(n) shape and rationale as the shell
 * site): the flag name is `[a-zA-Z_-]+` with zero-width fill bytes
 * (Cf/DI/Mn/U+2800 — the shell site's extended class) TRANSPARENT to the
 * continuation and to the keyword probe but kept in the emitted bytes;
 * `--name=value` redacts the non-space value run; `--name<ws>value` redacts
 * the next token, or — when the value opens with a quote — the whole span
 * through the MATCHING close quote (or input end). Only the VALUE is
 * replaced (with `[REDACTED]`); flag names, separators, whitespace, and
 * non-keyword flags are emitted unchanged.
 */
const DASH_FLAG_KEYWORD_RE =
	/token|secret|password|passwd|api[_-]?key|apikey|auth|credential|private[_-]?key|access[_-]?key/i;
const DASH_FLAG_FILL_RE =
	/\p{Cf}|\p{Default_Ignorable_Code_Point}|\p{Mn}|\u2800/u;
const DASH_FLAG_FILL_GLOBAL_RE = new RegExp(DASH_FLAG_FILL_RE.source, 'gu');

function isDashFlagNameChar(c: string): boolean {
	return (
		(c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '-' || c === '_'
	);
}

function redactDashFlagsDisplay(input: string): string {
	// #3893 AC13 fill-split pre-check, mirrored: when the raw text has no
	// keyword, re-test a fill-condensed copy (cheap; miss path only) so a
	// zero-width byte inside `--pass\u200Bword` cannot skip the whole scan.
	if (
		!DASH_FLAG_KEYWORD_RE.test(input) &&
		!DASH_FLAG_KEYWORD_RE.test(input.replace(DASH_FLAG_FILL_GLOBAL_RE, ''))
	) {
		return input;
	}
	let out = '';
	let i = 0;
	while (i < input.length) {
		const dash = input.indexOf('--', i);
		if (dash < 0) {
			out += input.slice(i);
			break;
		}
		out += input.slice(i, dash);
		let k = dash + 2;
		let keywordName = '';
		while (k < input.length) {
			const c = input[k];
			if (isDashFlagNameChar(c)) {
				keywordName += c;
				k += 1;
			} else if (DASH_FLAG_FILL_RE.test(c)) {
				k += 1;
			} else {
				break;
			}
		}
		const name = input.slice(dash + 2, k);
		if (keywordName.length > 0 && DASH_FLAG_KEYWORD_RE.test(keywordName)) {
			if (input[k] === '=') {
				let v = k + 1;
				while (v < input.length && !/\s/.test(input[v])) v++;
				out += v > k + 1 ? `--${name}=[REDACTED]` : `--${name}=`;
				i = v;
				continue;
			}
			if (k < input.length && /\s/.test(input[k])) {
				let wsEnd = k;
				while (wsEnd < input.length && /\s/.test(input[wsEnd])) wsEnd++;
				if (
					wsEnd < input.length &&
					!(input[wsEnd] === '-' && input[wsEnd + 1] === '-')
				) {
					// Quote-aware value (#3893 AC14): consume through the MATCHING
					// close quote (or input end) so a multi-word quoted secret
					// redacts whole; each quote type respects its own closer.
					const quote = input[wsEnd];
					let v = wsEnd;
					if (quote === '"' || quote === "'") {
						v = wsEnd + 1;
						while (v < input.length && input[v] !== quote) v++;
						if (v < input.length) v += 1; // include the close quote
					} else {
						while (v < input.length && !/\s/.test(input[v])) v++;
					}
					out += `--${name}${input.slice(k, wsEnd)}[REDACTED]`;
					i = v;
					continue;
				}
				out += `--${name}${input.slice(k, wsEnd)}`;
				i = wsEnd;
				continue;
			}
			out += `--${name}`;
			i = k;
			continue;
		}
		out += `--${name}`;
		i = k;
	}
	return out;
}

/**
 * Redacts secrets/URLs and strips control chars for terminal/display safety.
 * Order of operations (each step exists to keep a prior fix closed):
 *   1. slice to MAX_SANITIZE_INPUT_CHARS (regex-work bound)
 *   2. neutralize ANSI CSI sequences to a single space (#2369 Gap 2 — an SGR
 *      final byte `m` is a word character and defeated `\b`; substituting a
 *      separator can only create boundaries, never remove one, so the #2363
 *      split/join fixes stay closed)
 *   3. redact dash-flag values (`--password "multi word"` / `--token=x`),
 *      quote-aware and mirrored from the shell site's redactDashFlags
 *      (#3893 AC14 — before this step the display site left dash flags
 *      wholly raw while the shell site redacted them)
 *   4. redact URLs (against the CSI-neutralized view)
 *   5. redact credential KV pairs — keyword match is UNANCHORED and tolerant
 *      of glued key names and identifier suffixes (#2369 Gap 1), and the
 *      value matcher tolerates a fill-tolerant auth scheme word (Basic,
 *      Digest, …) between separator and credential so `Authorization: Basic
 *      <base64>` redacts the credential, not just the scheme
 *   6. redact SCREAMING_CASE KV pairs (unchanged shape)
 *   7. redact bare well-known credential VALUE shapes wherever they appear,
 *      no key=value span needed (#3165 F-1 — see BARE_TOKEN_VALUE_PATTERNS),
 *      matching on a Cf/DI-deletion condensed view UNIONED with the
 *      uncondensed matches so an invisible byte can neither split a token
 *      past the arm NOR regress head behavior when it was itself the \b
 *      boundary provider (visible fill inside a bare token stays a
 *      documented residual — see the FILL note above)
 *   8. strip residual control/format/DI runs to spaces
 *   9. sweep residual over-long bare `[<params>m` SGR bodies (the >32-char
 *      CSI tail the bounded pre-pass cannot match)
 *   10. trim + 512-byte UTF-8 bound
 *
 * Best-effort defense-in-depth for a log-display string, NOT a security
 * boundary: combining marks (U+0300 class) still defeat the KV keyword
 * matching above and are deliberately not fixed there (#2369 Gap 3 —
 * sweeping `\p{Mn}` through the KV arms would over-redact every legitimate
 * combining accent in non-Latin diagnostics; the #3893 dash-flag arm skips
 * fill bytes — Cf/DI/Mn/U+2800 — in its keyword CLASSIFICATION view only,
 * leaving its emitted bytes untouched). Glued-key
 * matching (Gap 1) and the CSI pre-pass (Gap 2) were added by #2485; the
 * bare-token arm gained the Cf/DI deletion sweep in the PR #3705 review
 * round (F-1), with visible splits (whitespace/Cc) disclosed above as its
 * documented residual.
 */
export function sanitizeFailureEvidenceDisplay(value: string): string {
	const bounded = value.slice(0, MAX_SANITIZE_INPUT_CHARS);
	const neutralized = bounded.replace(CSI_SEQUENCE, ' ');
	// #3893 AC14 (F12): quote-aware dash-flag values, mirrored from the shell
	// site's redactDashFlags — runs on the CSI-neutralized view so a residual
	// SGR body cannot shield the flag name, and BEFORE the KV/bare arms so the
	// emitted [REDACTED] spans are final for the flag-value surface.
	const dashRedacted = redactDashFlagsDisplay(neutralized);
	const redacted = dashRedacted
		.replace(/\bhttps?:\/\/[^\s'"<>]+/gi, (match) => redactUrl(match))
		// #3712 azure CONTEXTUAL arm: connection-string `AccountKey=<base64>`
		// material. The WHOLE `key=value` span collapses to the BARE
		// placeholder (no `AccountKey=` residue): the generic KV arm below
		// would otherwise consume the value as a family-less `<redacted>`
		// (plan-critic round-1 probe), and a residue form like
		// `AccountKey=[REDACTED:azure]` is itself re-matchable KV shape.
		.replace(/\bAccountKey=[A-Za-z0-9+/]{20,}={0,2}/gi, '[REDACTED:azure]')
		.replace(
			CREDENTIAL_KV_PATTERN,
			(_, key: string) => `${key.replace(CONTROL_CHAR_RUN, '')}=<redacted>`,
		)
		.replace(SCREAMING_KV_CANDIDATE_PATTERN, (match, key: string) => {
			if (!screamingKeyContainsSuffix(key)) return match;
			return `${key.replace(CONTROL_CHAR_RUN, '').replace(/\s+/g, '')}=<redacted>`;
		});
	// #3165 F-1 (PR #3705 review round 2): the bare shapes above have NO
	// fill tolerance, so a zero-width byte INSIDE a credential splits it
	// past this sweep (U+200B inside an sk- token left a 30-char tail in
	// display output where the KV arms tolerate the same byte as fill).
	// Cf/DI characters render as nothing, so DELETING them cannot change
	// what a reader sees — but deleting a byte that was itself PROVIDING a
	// \b boundary glues its word-char neighbours together and kills the
	// anchor on the condensed view (wordchar+Cf+token, token+Cf+wordchar;
	// closeout-critic probes G1/G2). The sweep therefore UNIONS two match
	// passes: the uncondensed text (exactly what the sequential .replace at
	// the published head matched — head-dominance) and the condensed view
	// (fill tolerance), then splices the union back right-to-left. Visible
	// separators (whitespace, Cc — newlines included — and combining marks)
	// stay a documented residual: deleting those could merge or reorder
	// what the reader sees, which the #2363 split/join fixes deliberately
	// avoid.
	const condensedChars: string[] = [];
	const condensedToOriginal: number[] = [];
	let cursor = 0;
	for (const char of redacted) {
		if (!BARE_TOKEN_ZERO_WIDTH_FILL_RE.test(char)) {
			condensedChars.push(char);
			// One map entry per UTF-16 CODE UNIT (not per code point):
			// matchAll's match.index counts code units, so a map indexed by
			// code-point position misaligns every span after a kept astral
			// character (emoji/CJK-ext) and maps a token ending at the
			// input end past the array (NaN end -> slice(NaN) appends the
			// whole cleartext string). Each unit carries its OWN absolute
			// offset (cursor + unit) so a span END lookup (map[lastUnit]+1)
			// lands after the full astral char instead of splitting the
			// surrogate pair (#3743 implementation review); matches always
			// start/end on char boundaries.
			for (let unit = 0; unit < char.length; unit += 1) {
				condensedToOriginal.push(cursor + unit);
			}
		}
		cursor += char.length;
	}
	const condensed = condensedChars.join('');
	const bareMatches: Array<{
		family: string;
		start: number;
		end: number;
	}> = [];
	// Pass A — head-dominance: the UNcondensed text. Every match the
	// published head's sequential .replace found must stay a candidate.
	for (const { family, re, guard } of BARE_TOKEN_VALUE_PATTERNS) {
		re.lastIndex = 0;
		for (const match of redacted.matchAll(re)) {
			if (guard && !guard(match[0])) continue;
			bareMatches.push({
				family,
				start: match.index,
				end: match.index + match[0].length,
			});
		}
	}
	// #3723: linear JWS span scan on the UNCONDENSED view — covers headers of
	// ANY length (x5c certificate chains exceed the legacy arm's 1024-char
	// bound). The legacy jwt family entry stays (fast path + pin parity); the
	// union/splice below dedupes identical spans. #3736: the combined
	// producer also carries the standard-base64 dotted-token spans and drops
	// any generic span overlapping an eyJ span (mid-token generic starts
	// would otherwise glue adjacent tokens through the extend rule).
	for (const span of findRedactableTokenSpans(redacted)) {
		bareMatches.push({ family: 'jwt', start: span.start, end: span.end });
	}
	// Pass B — fill tolerance: the Cf/DI-deleted condensed view, mapped
	// back to original offsets (a span mapped back INCLUDES any deleted
	// invisible bytes that sat inside it).
	for (const { family, re, guard } of BARE_TOKEN_VALUE_PATTERNS) {
		re.lastIndex = 0;
		for (const match of condensed.matchAll(re)) {
			if (guard && !guard(match[0])) continue;
			bareMatches.push({
				family,
				start: condensedToOriginal[match.index],
				end: condensedToOriginal[match.index + match[0].length - 1] + 1,
			});
		}
	}
	// #3723 (critic r2 finding 1): the SAME span scan on the CONDENSED view —
	// a long-header token WITH an embedded zero-width byte splits the run on
	// the uncondensed view (the fill byte is not in the run class) AND misses
	// the legacy condensed arm (its header bound is still 1024), so only this
	// pass closes the composition case. A mapped-back span INCLUDES the
	// deleted invisible bytes that sat inside it.
	// #3736: the combined span producer on the CONDENSED view (a long-header
	// or standard-base64 token split by an invisible byte closes here).
	for (const span of findRedactableTokenSpans(condensed)) {
		bareMatches.push({
			family: 'jwt',
			start: condensedToOriginal[span.start],
			end: condensedToOriginal[span.end - 1] + 1,
		});
	}
	let swept = redacted;
	if (bareMatches.length > 0) {
		// Leftmost-longest greedy selection over the union: maximal
		// non-overlapping coverage. Identical spans from both passes dedupe;
		// a longer overlapping span EXTENDS the covered interval (keeps the
		// earlier start), so output never shows LESS redaction than the
		// published head (every head match is a candidate from Pass A). Left-to-right
		// list build, then a right-to-left splice keeps offsets valid.
		bareMatches.sort((a, b) => a.start - b.start || b.end - a.end);
		const selected: typeof bareMatches = [];
		for (const match of bareMatches) {
			const last = selected[selected.length - 1];
			if (last === undefined || match.start >= last.end) {
				selected.push(match);
			} else if (match.end > last.end) {
				// EXTEND, not replace: keep last.start/last.family and grow the
				// end. A replace would keep the LATER start and uncover the
				// earlier span's exclusive prefix (e.g. a slack match that
				// stops at '_' while an inner ghp_ match ends later left
				// 'xoxb-abcdefghij-' cleartext where head and the mirror
				// redact both — closeout-critic H1).
				selected[selected.length - 1] = { ...last, end: match.end };
			}
		}
		for (let i = selected.length - 1; i >= 0; i -= 1) {
			const match = selected[i];
			swept =
				swept.slice(0, match.start) +
				`[REDACTED:${match.family}]` +
				swept.slice(match.end);
		}
	}
	const stripped = swept
		.replace(CONTROL_CHAR_RUN, ' ')
		.replace(BARE_SGR_PARAMETER_RUN, ' ');
	return boundedUtf8(stripped.trim());
}

function signalFrom(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	if (typeof value === 'number' || typeof value === 'boolean')
		return String(value);
	if (typeof value !== 'object' || value === null) return '';
	return ['name', 'message', 'code', 'status', 'statusCode']
		.map((key) => signalFrom(readOwn(value, key)))
		.filter(Boolean)
		.join(' ');
}

function actionIdentity(action?: ActionIdentityInput): ActionIdentityV1 | null {
	return action ? createActionIdentity(action) : null;
}

function buildRecord(input: {
	source: InvocationFailureSource;
	category: string;
	retryClass: InvocationFailureRetryClass;
	risk: InvocationFailureRisk;
	action?: ActionIdentityInput;
	display: string;
	statusCode?: number;
	exitCode?: number;
	code?: string;
	signal?: string;
}): InvocationFailureRecordV1 {
	return {
		version: 1,
		source: input.source,
		category: input.category,
		retryClass: input.retryClass,
		risk: input.risk,
		action: actionIdentity(input.action),
		evidence: {
			display: sanitizeFailureEvidenceDisplay(input.display),
			...(input.statusCode !== undefined && { statusCode: input.statusCode }),
			...(input.exitCode !== undefined && { exitCode: input.exitCode }),
			...(input.code && { code: input.code.slice(0, MAX_STRUCTURED_STRING) }),
			...(input.signal && {
				signal: sanitizeFailureEvidenceDisplay(input.signal).slice(
					0,
					MAX_STRUCTURED_STRING,
				),
			}),
		},
		occurredAt: new Date().toISOString(),
	};
}

function isShellTool(tool: string): boolean {
	const normalized = tool.trim().toLowerCase();
	return normalized === 'bash' || normalized === 'shell';
}

function isAbortLike(value: unknown): boolean {
	if (value instanceof Error && value.name === 'AbortError') return true;
	const signal = signalFrom(value);
	return /\bAbortError\b/i.test(signal) || /\baborted\b/i.test(signal);
}

function isSimpleCommand(command: string): boolean {
	return command.length > 0 && !/[;&|<>\r\n]/.test(command);
}

function isNeutralExitOne(command: string): boolean {
	const trimmed = command.trim();
	if (!isSimpleCommand(trimmed)) return false;
	const tokens =
		trimmed
			.match(/"[^"]*"|'[^']*'|\S+/g)
			?.map((token) => token.replace(/^(["'])(.*)\1$/, '$2')) ?? [];
	const executable = tokens[0]?.toLowerCase();
	if (executable === 'rg' || executable === 'rg.exe') return true;
	if (executable !== 'git' && executable !== 'git.exe') return false;
	let subcommandIndex = 1;
	while (tokens[subcommandIndex] === '-C' && tokens[subcommandIndex + 1]) {
		subcommandIndex += 2;
	}
	return (
		tokens[subcommandIndex]?.toLowerCase() === 'diff' &&
		tokens.slice(subcommandIndex + 1).includes('--quiet')
	);
}

function readExitCode(metadata: unknown): number | undefined {
	const exit = hasOwn(metadata, 'exit')
		? readOwn(metadata, 'exit')
		: readOwn(metadata, 'exitCode');
	return typeof exit === 'number' && Number.isFinite(exit) ? exit : undefined;
}

function readStatusCode(error: unknown): number | undefined {
	const direct = readOwn(error, 'status');
	if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
	const alternate = readOwn(error, 'statusCode');
	if (typeof alternate === 'number' && Number.isFinite(alternate))
		return alternate;
	const signal = signalFrom(error);
	const parsed = extractStatusCode(signal);
	return parsed === null ? undefined : parsed;
}

function providerSignal(error: unknown): string {
	return signalFrom(error).trim();
}

/**
 * #3177: the provider-category set `classifyProviderFailure` itself emits
 * (enumerated per the category docstring above), plus the two early-finish
 * categories `readEarlyFinish` stamps on its carriers
 * (provider.output_length / provider.content_filter, review finding F-001:
 * rejecting them degraded the carrier to text classification and lost the
 * category/risk the reader had already computed). A carrier snapshot outside
 * this set is not honored (fail-closed to normal classification).
 */
const KNOWN_PROVIDER_CARRIER_CATEGORIES = new Set([
	'provider.cancelled',
	'provider.authentication_configuration',
	'provider.quota_billing',
	'provider.rate_limit',
	'provider.unavailable',
	'provider.context_window',
	'provider.content_policy',
	'provider.request_shape',
	'provider.unknown',
	'provider.output_length',
	'provider.content_filter',
]);

const KNOWN_PROVIDER_CARRIER_RETRY_CLASSES =
	new Set<InvocationFailureRetryClass>([
		'retry_same',
		'retry_fallback',
		'repair_then_retry',
		'operator_action',
		'do_not_retry',
	]);

const KNOWN_PROVIDER_CARRIER_RISKS = new Set<InvocationFailureRisk>([
	'low',
	'medium',
	'high',
]);

/**
 * #3177: read the verified carrier snapshot off an error. Returns null unless
 * `error.providerError` is an object whose category, retryClass, and risk are
 * all known enum values — the exact shape `readProviderMessageError` +
 * `providerMessageErrorToError` produce.
 */
function readProviderCarrierSnapshot(error: unknown): {
	category: string;
	retryClass: InvocationFailureRetryClass;
	risk: InvocationFailureRisk;
} | null {
	if (typeof error !== 'object' || error === null) return null;
	const carrier = readOwn(error, 'providerError');
	if (typeof carrier !== 'object' || carrier === null) return null;
	const category = readOwn(carrier, 'category');
	const retryClass = readOwn(carrier, 'retryClass');
	const risk = readOwn(carrier, 'risk');
	if (
		typeof category !== 'string' ||
		typeof retryClass !== 'string' ||
		typeof risk !== 'string'
	)
		return null;
	if (
		!KNOWN_PROVIDER_CARRIER_CATEGORIES.has(category) ||
		!KNOWN_PROVIDER_CARRIER_RETRY_CLASSES.has(
			retryClass as InvocationFailureRetryClass,
		) ||
		!KNOWN_PROVIDER_CARRIER_RISKS.has(risk as InvocationFailureRisk)
	)
		return null;
	return {
		category,
		retryClass: retryClass as InvocationFailureRetryClass,
		risk: risk as InvocationFailureRisk,
	};
}

/**
 * Provider failure categories in use (enumerated per issue #2673 plan-critic
 * finding 6, so downstream category-prefix consumers — telemetry filters,
 * dashboards, circuit thresholds — can discover every leaf):
 *   provider.cancelled, provider.authentication_configuration,
 *   provider.quota_billing, provider.rate_limit, provider.unavailable,
 *   provider.context_window, provider.content_policy,
 *   provider.request_shape (#2673: deterministic request-shape rejections,
 *   e.g. a strict single-system provider rejecting a multi-system payload),
 *   provider.unknown.
 */
export function classifyProviderFailure(
	error: unknown,
	action?: ActionIdentityInput,
): InvocationFailureRecordV1 {
	const signal = providerSignal(error);
	const lowered = signal.toLowerCase();
	const statusCode = readStatusCode(error);
	const code = boundedString(readOwn(error, 'code'));
	if (isAbortLike(error)) {
		return buildRecord({
			source: 'provider',
			category: 'provider.cancelled',
			retryClass: 'do_not_retry',
			risk: 'low',
			action,
			display: signal || 'AbortError',
			code,
			statusCode,
		});
	}
	// #3177: honor a verified provider-message carrier's read-time snapshot.
	// `providerMessageErrorToError` attaches `.providerError` (the
	// ProviderMessageError the reader classified over the UNBOUNDED raw
	// provider message); the carrier's own message is bounded display text
	// that can lose the very keyword the text arms below match. Provenance is
	// the nested carrier object itself — never a bare `.category` property —
	// and every enum field must be known; anything else falls through to
	// normal classification (fail-closed). Abort-like errors were already
	// handled above, so an abort-shaped carrier stays cancelled regardless.
	const carrierSnapshot = readProviderCarrierSnapshot(error);
	if (carrierSnapshot) {
		return buildRecord({
			source: 'provider',
			category: carrierSnapshot.category,
			retryClass: carrierSnapshot.retryClass,
			risk: carrierSnapshot.risk,
			action,
			display: signal || carrierSnapshot.category,
			code,
			statusCode,
		});
	}
	if (
		statusCode === 401 ||
		statusCode === 403 ||
		/\b(?:unauthorized|invalid api key|forbidden|authentication|credentials?)\b/i.test(
			signal,
		)
	) {
		return buildRecord({
			source: 'provider',
			category: 'provider.authentication_configuration',
			retryClass: 'operator_action',
			risk: 'high',
			action,
			display: signal,
			code,
			statusCode,
		});
	}
	if (QUOTA_ERROR_PATTERN.test(signal)) {
		return buildRecord({
			source: 'provider',
			category: 'provider.quota_billing',
			retryClass: 'retry_fallback',
			risk: 'medium',
			action,
			display: signal,
			code,
			statusCode,
		});
	}
	if (statusCode === 429 || /\brate.?limit\b/i.test(signal)) {
		return buildRecord({
			source: 'provider',
			category: 'provider.rate_limit',
			retryClass: 'retry_same',
			risk: 'medium',
			action,
			display: signal,
			code,
			statusCode,
		});
	}
	// Issue #3022: `Model unavailable: <id>` (OpenCode v2 SessionRunnerModel.
	// ModelUnavailableError / provider.no-route). The requested model id does
	// not exist on the provider, so a same-model retry can never succeed —
	// advance to the next fallback_models entry instead. Checked BEFORE the
	// generic transient branch (which would classify it retry_same).
	if (MODEL_UNAVAILABLE_PATTERN.test(signal)) {
		return buildRecord({
			source: 'provider',
			category: 'provider.unavailable',
			retryClass: 'retry_fallback',
			risk: 'medium',
			action,
			display: signal,
			code,
			statusCode,
		});
	}
	if (
		(statusCode !== undefined && TRANSIENT_STATUS_CODES.has(statusCode)) ||
		TRANSIENT_MODEL_ERROR_PATTERN.test(signal)
	) {
		return buildRecord({
			source: 'provider',
			category: 'provider.unavailable',
			retryClass: 'retry_same',
			risk: 'medium',
			action,
			display: signal,
			code,
			statusCode,
		});
	}
	if (/\b(?:context length|maximum context|too many tokens)\b/i.test(signal)) {
		return buildRecord({
			source: 'provider',
			category: 'provider.context_window',
			retryClass: 'do_not_retry',
			risk: 'low',
			action,
			display: signal,
			code,
			statusCode,
		});
	}
	if (
		/\b(?:content policy|content filter|safety system|policy violation|moderation)\b/i.test(
			signal,
		)
	) {
		return buildRecord({
			source: 'provider',
			category: 'provider.content_policy',
			retryClass: 'do_not_retry',
			risk: 'medium',
			action,
			display: signal,
			code,
			statusCode,
		});
	}
	if (REQUEST_SHAPE_REJECTION_PATTERN.test(signal)) {
		return buildRecord({
			source: 'provider',
			category: 'provider.request_shape',
			retryClass: 'do_not_retry',
			risk: 'low',
			action,
			display: signal,
			code,
			statusCode,
		});
	}
	return buildRecord({
		source: 'provider',
		category: lowered.length > 0 ? 'provider.unknown' : 'provider.cancelled',
		retryClass: 'do_not_retry',
		risk: 'medium',
		action,
		display: signal || 'unknown provider error',
		code,
		statusCode,
	});
}

export function isRetryableProviderFailure(
	record: InvocationFailureRecordV1,
): boolean {
	return (
		record.source === 'provider' &&
		(record.retryClass === 'retry_same' ||
			record.retryClass === 'retry_fallback')
	);
}

export function classifyToolInvocationFailure(
	input: ToolFailureClassificationInput,
): InvocationFailureRecordV1 | null {
	const shell = isShellTool(input.tool);
	const explicitError = signalFrom(input.error);
	const outputSignal = typeof input.output === 'string' ? input.output : '';
	const signal = [explicitError, outputSignal]
		.filter(Boolean)
		.join('\n')
		.trim();
	const exitCode = readExitCode(input.metadata);
	const metadataCode = boundedString(readOwn(input.metadata, 'code'));
	const originalCommand = input.correlation?.originalCommand ?? '';
	if (!signal && exitCode === undefined) return null;
	if (
		shell &&
		(metadataCode === 'SANDBOX_WRAPPER_FAILURE' ||
			(input.correlation?.sandboxWrapped === true &&
				/\[sandbox\]\s+BLOCKED:/i.test(signal)))
	) {
		return buildRecord({
			source: 'shell',
			category: 'shell.sandbox_wrapper',
			retryClass: 'operator_action',
			risk: 'high',
			action: { tool: input.tool, args: input.args },
			display: 'sandbox wrapper failed closed',
			exitCode,
			code: metadataCode,
		});
	}
	if (
		shell &&
		(metadataCode === 'ParserError' ||
			/\b(?:MissingEndCurlyBrace|ParserError|ParseError|IncompleteParseException)\b/i.test(
				signal,
			))
	) {
		return buildRecord({
			source: 'shell',
			category: input.correlation?.sandboxWrapped
				? 'shell.sandbox_wrapper'
				: 'shell.parser',
			retryClass: input.correlation?.sandboxWrapped
				? 'operator_action'
				: 'repair_then_retry',
			risk: 'high',
			action: { tool: input.tool, args: input.args },
			display: 'shell parser rejected the command',
			exitCode,
			code: metadataCode,
		});
	}
	const structuredCommandUnavailable =
		/\bCommandNotFoundException\b/i.test(explicitError) ||
		metadataCode === 'ENOENT' ||
		/\b(?:spawn|execFile)\s+\S+\s+ENOENT\b/i.test(explicitError) ||
		(exitCode === 127 &&
			/(?:^|\n)(?:\/bin\/)?(?:ba|da|z|k)?sh(?:\.exe)?:\s+(?:(?:line\s+)?\d+:\s+)?[^:\r\n]+:\s+not found\b/im.test(
				outputSignal,
			)) ||
		(exitCode === 127 &&
			/(?:^|\n)[^:\r\n]+:\s+command not found\b/im.test(outputSignal));
	if (shell && structuredCommandUnavailable) {
		return buildRecord({
			source: 'shell',
			category: 'shell.command_unavailable',
			retryClass: 'repair_then_retry',
			risk: 'medium',
			action: { tool: input.tool, args: input.args },
			display: `command unavailable${exitCode !== undefined ? ` (exit ${exitCode})` : ''}`,
			exitCode,
			code: metadataCode ?? (/\bENOENT\b/.test(signal) ? 'ENOENT' : undefined),
		});
	}
	if (shell && exitCode === 1 && isNeutralExitOne(originalCommand)) return null;
	if (shell && exitCode !== undefined && exitCode !== 0) {
		return buildRecord({
			source: 'shell',
			category: 'shell.exit',
			retryClass: 'do_not_retry',
			risk: 'medium',
			action: { tool: input.tool, args: input.args },
			display: `shell exited with code ${exitCode}`,
			exitCode,
			code: metadataCode,
		});
	}
	if (!shell && (explicitError.length > 0 || exitCode !== undefined)) {
		return buildRecord({
			source: 'validation',
			category: 'validation.agent_result',
			retryClass: 'repair_then_retry',
			risk: 'medium',
			action: { tool: input.tool, args: input.args },
			display: signal || 'tool failure',
			exitCode,
			code: metadataCode,
		});
	}
	return null;
}

export function createFilesystemFailure(input: {
	reason:
		| 'busy_lock'
		| 'permission'
		| 'read_only'
		| 'no_space'
		| 'path_containment'
		| 'not_found'
		| 'unknown';
	display: string;
	code?: string;
	idempotent?: boolean;
	action?: ActionIdentityInput;
}): InvocationFailureRecordV1 {
	const mapping: Record<
		typeof input.reason,
		{ category: string; retryClass: InvocationFailureRetryClass }
	> = {
		busy_lock: {
			category: 'filesystem.busy_lock',
			retryClass: input.idempotent ? 'retry_same' : 'do_not_retry',
		},
		permission: {
			category: 'filesystem.permission',
			retryClass: 'operator_action',
		},
		read_only: {
			category: 'filesystem.read_only',
			retryClass: 'operator_action',
		},
		no_space: {
			category: 'filesystem.no_space',
			retryClass: 'operator_action',
		},
		path_containment: {
			category: 'filesystem.path_containment',
			retryClass: 'do_not_retry',
		},
		not_found: {
			category: 'filesystem.not_found',
			retryClass: 'repair_then_retry',
		},
		unknown: { category: 'filesystem.unknown', retryClass: 'do_not_retry' },
	};
	const selected = mapping[input.reason];
	return buildRecord({
		source: 'filesystem',
		category: selected.category,
		retryClass: selected.retryClass,
		risk: 'medium',
		action: input.action,
		display: input.display,
		code: input.code,
	});
}

export function createGitFailure(input: {
	reason:
		| 'conflict'
		| 'rebase'
		| 'dirty_primary'
		| 'lock_busy'
		| 'timeout'
		| 'command_unavailable'
		| 'corrupt_repository';
	display: string;
	code?: string;
	idempotent?: boolean;
	action?: ActionIdentityInput;
}): InvocationFailureRecordV1 {
	const mapping: Record<
		typeof input.reason,
		{ category: string; retryClass: InvocationFailureRetryClass }
	> = {
		conflict: { category: 'git.conflict', retryClass: 'operator_action' },
		rebase: { category: 'git.rebase', retryClass: 'operator_action' },
		dirty_primary: {
			category: 'git.dirty_primary',
			retryClass: 'operator_action',
		},
		lock_busy: {
			category: 'git.lock_busy',
			retryClass: input.idempotent ? 'retry_same' : 'do_not_retry',
		},
		timeout: {
			category: 'git.timeout',
			retryClass: input.idempotent ? 'retry_same' : 'do_not_retry',
		},
		command_unavailable: {
			category: 'git.command_unavailable',
			retryClass: 'operator_action',
		},
		corrupt_repository: {
			category: 'git.corrupt_repository',
			retryClass: 'operator_action',
		},
	};
	const selected = mapping[input.reason];
	return buildRecord({
		source: 'git',
		category: selected.category,
		retryClass: selected.retryClass,
		risk: 'high',
		action: input.action,
		display: input.display,
		code: input.code,
	});
}

export function createPolicyFailure(input: {
	reason: 'gate_denial' | 'containment' | 'destructive';
	display: string;
	code?: string;
	action?: ActionIdentityInput;
}): InvocationFailureRecordV1 {
	const mapping: Record<
		typeof input.reason,
		{ category: string; retryClass: InvocationFailureRetryClass }
	> = {
		gate_denial: {
			category: 'policy.gate_denial',
			retryClass: 'repair_then_retry',
		},
		containment: {
			category: 'policy.containment',
			retryClass: 'do_not_retry',
		},
		destructive: {
			category: 'policy.destructive',
			retryClass: 'do_not_retry',
		},
	};
	const selected = mapping[input.reason];
	return buildRecord({
		source: 'policy',
		category: selected.category,
		retryClass: selected.retryClass,
		risk: 'high',
		action: input.action,
		display: input.display,
		code: input.code,
	});
}

export function createValidationFailure(input: {
	display: string;
	code?: string;
	action?: ActionIdentityInput;
}): InvocationFailureRecordV1 {
	return buildRecord({
		source: 'validation',
		category: 'validation.agent_result',
		retryClass: 'repair_then_retry',
		risk: 'medium',
		action: input.action,
		display: input.display,
		code: input.code,
	});
}

export function createCancellationFailure(input: {
	display: string;
	action?: ActionIdentityInput;
}): InvocationFailureRecordV1 {
	return buildRecord({
		source: 'cancellation',
		category: 'cancellation.abort',
		retryClass: 'do_not_retry',
		risk: 'low',
		action: input.action,
		display: input.display,
	});
}

export function createDeadlineFailure(input: {
	display: string;
	code?: string;
	idempotent?: boolean;
	action?: ActionIdentityInput;
}): InvocationFailureRecordV1 {
	return buildRecord({
		source: 'deadline',
		category: 'deadline.expired',
		retryClass: input.idempotent ? 'retry_same' : 'do_not_retry',
		risk: 'medium',
		action: input.action,
		display: input.display,
		code: input.code,
	});
}

export const _test_exports = {
	isNeutralExitOne,
	sanitizeFailureEvidenceDisplay,
};
