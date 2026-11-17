/**
 * Linear-time whole-JWS-token discovery and redaction (#3723, widened #3736).
 *
 * The legacy jwt arms at both redaction sites bound the first (header)
 * segment to `{10,1024}` and the signature to `{10,}` because unbounded
 * quantifiers made the regex quadratic on dense `eyJ` runs. This scanner is
 * the single-pass alternative: one greedy pass over maximal dotted runs, then
 * pure string arithmetic per run. Output is built from slices in one forward
 * walk — O(n) in the input.
 *
 * #3736 widening (five leaking shapes, plan v3 / critic round 4):
 * - eyJ-anchored triples accept signatures of length >= 1 (was 10) — an
 *   alg:none-style or truncated-signature token still leaks its claims.
 * - after an accepted triple, up to two FOLLOWING token-like segments are
 *   absorbed (JWE compact 5-part shape); absorption never crosses a segment
 *   that itself starts an eligible eyJ header (an adjacent second token is
 *   scanned as its own span, never stranded), never crosses a non-token-like
 *   segment, and may cross a single EMPTY interior segment (dir-algorithm
 *   JWE carries an empty encrypted-key segment).
 * - an eyJ-valid header whose payload segment is EMPTY is accepted
 *   structurally as the empty-key JWE shape when the following segments are
 *   token-like (the `{1,}` payload minimum cannot hold for it).
 * - `hdr.payload.` (trailing dot, empty LAST signature segment) is accepted
 *   as the unsigned 2-segment shape; the payload may be as short as 1 char
 *   (e30/bnVsbA/Ingi are real payloads — the #3710 lesson).
 * - `headerStart` additionally accepts the position after `_` (the `\b`
 *   anchor never fires between two word characters, so `x_eyJ…` previously
 *   escaped every arm; the span still starts at the eyJ boundary).
 * - a SECOND discovery pass (`findStandardB64TokenSpans`) sees standard
 *   base64 alphabet runs (`+ / =`) the main run class cannot: dotted tokens
 *   whose header is 40+ chars of standard base64 with no eyJ prefix. Candidate
 *   headers are the WHOLE segment first (bare, incl. trailing `=` padding),
 *   then — only for interior `=` separators with non-empty prefix AND
 *   suffix — the suffix after the separator, with the span starting AT the
 *   separator so a `key`-style prefix stays visible and no re-matchable
 *   `key=[REDACTED:jwt]` residue survives. `/` inside base64 is material,
 *   never a boundary. Consumers push eyJ spans before generic spans so an
 *   equal-start overlap keeps the jwt label; the longest span wins
 *   overlaps (maximal non-overlapping coverage).
 *
 * Disclosed residuals (documented, over-redaction-leaning where marked):
 * a mixed-case >=8-char word directly appended to a token absorbs (e.g.
 * `…sig.Snapshot`); an all-lowercase ciphertext tail with no digit and
 * length <16 stays visible; an eyJ-INITIAL iv/ciphertext segment inside a
 * structural JWE tail is stopped by the adjacent-header guard (#3736
 * critic round 3) and can stay visible.
 */

/** Maximal dotted base64url-ish runs — single-char class, linear, no backtracking. */
const DOTTED_RUN_RE = /[A-Za-z0-9_.-]+/g;

/**
 * #3736 D4: standard-base64 dotted runs. The class adds `+`, `/` and `=` so
 * a token like `AAAA…+/BBBB…=.eyJ….c2ln…` enters discovery as one run; the
 * main class above would split it at every `+`/`/`/`=`.
 */
const STANDARD_B64_DOTTED_RUN_RE = /[A-Za-z0-9+/.=-]+/g;

/** The redaction label both legacy jwt arms already use. */
export const JWS_REDACTION_LABEL = '[REDACTED:jwt]';

/** Acceptance bounds, byte-identical to the legacy arm's quantifiers. */
const HEADER_PREFIX = 'eyJ';
const MIN_HEADER_TOTAL = 13; // 'eyJ' + {10,}
const MIN_PAYLOAD = 1; // {1,}
/**
 * #3736 D6: the eyJ-anchored triple's signature minimum drops 10 → 1. The
 * generic (D4) triple keeps the stricter legacy bound below.
 */
const MIN_SIGNATURE_EYJ = 1;

/** #3736 D4: generic standard-base64 triple bounds. */
const GENERIC_HEADER_RE = /^[A-Za-z0-9+/]{40,}={0,2}$/;
const GENERIC_MIN_PAYLOAD = 20;
const GENERIC_MIN_SIGNATURE = 10;
const GENERIC_B64_RE = /^[A-Za-z0-9+/_=-]+$/;

export interface JwsTokenSpan {
	/** Inclusive start index of the header start, in the input string. */
	start: number;
	/** Exclusive end index (end of the last consumed segment). */
	end: number;
}

/**
 * The `\b`-equivalent 'eyJ' start inside a dot-free segment: the segment
 * start, or immediately after a '-' or '_' (the only non-word characters
 * besides '.' that can appear inside a run segment; a word character before
 * 'e' would have merged into the same segment, so no boundary exists there —
 * the same reasoning that makes the legacy `\beyJ` anchor correct).
 *
 * LEFTMOST boundary (implementation-review r1): a later in-header `-eyJ`
 * occurrence must not mask an earlier eligible boundary. Because the length
 * acceptance below compares the REMAINING segment length from the boundary,
 * the first boundary is always the longest candidate — if it fails the
 * minimum, every later boundary is shorter and must fail too — so taking the
 * first candidate is exact, not an approximation, and stays O(1) per segment.
 *
 * #3736 D5: '_' joins '-' as an accepted boundary character (`x_eyJ…`
 * previously escaped every arm because `\b` never fires between two word
 * characters).
 */
function headerStart(segment: string): number {
	if (segment.startsWith(HEADER_PREFIX)) return 0;
	let idx = segment.indexOf(`-${HEADER_PREFIX}`);
	if (idx === -1) idx = segment.indexOf(`_${HEADER_PREFIX}`);
	if (idx === -1) return -1;
	return idx + 1;
}

/**
 * #3736 D2-rev2 token-like absorption predicate for JWE tail segments:
 * length >= 8 AND [(uppercase AND lowercase) OR (uppercase AND digit) OR
 * length >= 16]. Admits base64 material of every case-mix (an all-uppercase
 * 43-char CEK clears the >=16 arm; mixed-case ciphertext clears the
 * mixed-case arms) while excluding lowercase/digit-only prose suffixes such
 * as `build2024` (pinned visible). A mixed-case >=8 English word directly
 * appended to a token still absorbs — disclosed over-redaction-leaning
 * residual.
 */
function tokenLike(segment: string): boolean {
	if (segment.length < 8) return false;
	const hasUpper = /[A-Z]/.test(segment);
	const hasLower = /[a-z]/.test(segment);
	const hasDigit = /[0-9]/.test(segment);
	return (
		(hasUpper && hasLower) || (hasUpper && hasDigit) || segment.length >= 16
	);
}

interface RunSegments {
	segments: string[];
	/** Cumulative offset of each segment start within the run. */
	offsets: number[];
	runStart: number;
}

function splitRun(match: RegExpMatchArray): RunSegments {
	const runStart = match.index ?? 0;
	const segments = match[0].split('.');
	const offsets: number[] = [];
	let cursor = 0;
	for (const segment of segments) {
		offsets.push(cursor);
		cursor += segment.length + 1; // +1 for the '.' separator
	}
	return { segments, offsets, runStart };
}

/**
 * Find every whole eyJ-anchored token span in `text` (leftmost,
 * non-overlapping, per maximal dotted run), including the #3736 widened
 * shapes (n-part JWE absorption incl. empty-key, unsigned 2-segment,
 * underscore boundary, >=1-char signatures). Linear in the input.
 */
export function findJwsTokenSpans(text: string): JwsTokenSpan[] {
	const spans: JwsTokenSpan[] = [];
	DOTTED_RUN_RE.lastIndex = 0;
	for (const run of text.matchAll(DOTTED_RUN_RE)) {
		const { segments, offsets, runStart } = splitRun(run);
		let i = 0;
		while (i + 2 < segments.length) {
			const headerSeg = segments[i] as string;
			const hs = headerStart(headerSeg);
			if (hs === -1) {
				i += 1;
				continue;
			}
			const headerLength = headerSeg.length - hs;
			if (headerLength < MIN_HEADER_TOTAL) {
				i += 1;
				continue;
			}
			const payload = segments[i + 1] as string;
			const signature = segments[i + 2] as string;
			const start = runStart + (offsets[i] as number) + hs;

			// #3736 D3: unsigned 2-segment shape `hdr.payload.` — the
			// signature segment is EMPTY and is the run's LAST segment. The
			// span consumes the trailing dot (the token's own syntax).
			if (
				signature === '' &&
				i + 2 === segments.length - 1 &&
				payload.length >= MIN_PAYLOAD
			) {
				spans.push({ start, end: runStart + (offsets[i + 2] as number) });
				i += 3; // consumed hdr + payload + trailing dot
				continue;
			}

			// #3736 D2-rev2: structural empty-key JWE `hdr..iv.ct.tag` — the
			// `{1,}` payload minimum cannot hold; accept when the following
			// segments are token-like (never across an eyJ-header segment).
			if (payload === '') {
				let last = i + 1; // the empty segment itself is consumed
				let guard = i + 2;
				while (guard < segments.length && guard - i <= 4) {
					const seg = segments[guard] as string;
					if (seg === '' || headerStart(seg) !== -1 || !tokenLike(seg)) break;
					last = guard;
					guard += 1;
				}
				if (last >= i + 3) {
					// at least two token-like segments follow the empty key
					spans.push({
						start,
						end:
							runStart +
							(offsets[last] as number) +
							(segments[last] as string).length,
					});
					i = last + 1;
					continue;
				}
				i += 1;
				continue;
			}

			if (
				payload.length >= MIN_PAYLOAD &&
				signature.length >= MIN_SIGNATURE_EYJ
			) {
				// Accepted triple; #3736 D2-rev2 absorption of JWE tail
				// segments (<= 2 further token-like segments, never across an
				// eyJ-header segment, optionally crossing ONE empty interior
				// segment).
				let last = i + 2;
				let extra = 0;
				let crossedEmpty = false;
				while (extra < 2 && last + 1 < segments.length) {
					const next = segments[last + 1] as string;
					if (headerStart(next) !== -1) break; // adjacent token header — scan it next
					if (tokenLike(next)) {
						last += 1;
						extra += 1;
						continue;
					}
					if (
						next === '' &&
						!crossedEmpty &&
						last + 2 < segments.length &&
						tokenLike(segments[last + 2] as string)
					) {
						last += 1;
						crossedEmpty = true;
						continue;
					}
					break;
				}
				spans.push({
					start,
					end:
						runStart +
						(offsets[last] as number) +
						(segments[last] as string).length,
				});
				i = last + 1; // accepted: consume through the last absorbed segment
			} else {
				i += 1; // rejected: advance one segment
			}
		}
	}
	return spans;
}

/**
 * #3736 D4-rev3: standard-base64 dotted-token spans — headers of 40+
 * standard base64 chars (no eyJ requirement) followed by a >=20-char
 * payload and a >=10-char signature. Candidate headers are the WHOLE
 * segment first (bare placement, trailing `=` padding included), then the
 * suffix after interior `=` separators with non-empty prefix AND suffix
 * (assignment placement: the span starts AT the separator, so a `key`-style
 * prefix stays visible and the separator is consumed — no re-matchable
 * `key=[REDACTED:jwt]` residue). Earliest valid separator wins.
 */
export function findStandardB64TokenSpans(text: string): JwsTokenSpan[] {
	const spans: JwsTokenSpan[] = [];
	STANDARD_B64_DOTTED_RUN_RE.lastIndex = 0;
	for (const run of text.matchAll(STANDARD_B64_DOTTED_RUN_RE)) {
		const { segments, offsets, runStart } = splitRun(run);
		let i = 0;
		while (i + 2 < segments.length) {
			const seg = segments[i] as string;
			let candidateStart = -1;
			if (GENERIC_HEADER_RE.test(seg)) {
				candidateStart = offsets[i] as number;
			} else {
				for (let p = 0; p < seg.length; p += 1) {
					if (seg[p] !== '=') continue;
					if (p === 0 || p === seg.length - 1) continue; // empty prefix or suffix
					if (GENERIC_HEADER_RE.test(seg.slice(p + 1))) {
						candidateStart = p; // span starts AT the separator
						break;
					}
				}
				if (candidateStart === -1) {
					i += 1;
					continue;
				}
			}
			const payload = segments[i + 1] as string;
			const signature = segments[i + 2] as string;
			if (
				payload.length >= GENERIC_MIN_PAYLOAD &&
				GENERIC_B64_RE.test(payload) &&
				signature.length >= GENERIC_MIN_SIGNATURE &&
				GENERIC_B64_RE.test(signature)
			) {
				spans.push({
					start: runStart + candidateStart,
					end: runStart + (offsets[i + 2] as number) + signature.length,
				});
				i += 3;
			} else {
				i += 1;
			}
		}
	}
	return spans;
}

/**
 * #3736: combined span producer for consumers that splice both families.
 * A generic (D4) span that OVERLAPS any eyJ-anchored span is dropped: inside
 * a dotted run of JWT material the generic triple can start mid-token (the
 * payload and signature segments of one eyJ token look like a generic
 * header/payload pair) and would otherwise glue two adjacent tokens into one
 * span through the union's extend rule (observed on the #3716 two-token
 * fixture: `pre.<A>.<B>.post` collapsed to a single label). eyJ anchoring is
 * authoritative wherever both passes see the same bytes.
 */
export function findRedactableTokenSpans(text: string): JwsTokenSpan[] {
	const eyJ = findJwsTokenSpans(text);
	const generic = findStandardB64TokenSpans(text).filter(
		(g) => !eyJ.some((e) => g.start < e.end && e.start < g.end),
	);
	return [...eyJ, ...generic];
}

/**
 * Replace every whole token span (eyJ-anchored + standard-base64) with
 * `[REDACTED:jwt]` (span-precise — surrounding text, including prefix/suffix
 * text inside the same dotted run, is preserved). eyJ spans are collected
 * first so an equal-start overlap keeps the jwt label. Used as the textual
 * pre-pass at sites without a condensed-view sweep; the display site consumes
 * the span producers directly on both of its views.
 */
export function redactJwsTokens(text: string): string {
	const spans = findRedactableTokenSpans(text);
	if (spans.length === 0) return text;
	spans.sort((a, b) => a.start - b.start || b.end - a.end);
	const selected: JwsTokenSpan[] = [];
	for (const span of spans) {
		const last = selected[selected.length - 1];
		if (last === undefined || span.start >= last.end) {
			selected.push(span);
		} else if (span.end > last.end) {
			last.end = span.end; // EXTEND: keep the earlier start, grow coverage
		}
	}
	let out = '';
	let cursor = 0;
	for (const span of selected) {
		if (span.start < cursor) continue; // fully contained in an earlier span
		out += text.slice(cursor, span.start) + JWS_REDACTION_LABEL;
		cursor = span.end;
	}
	out += text.slice(cursor);
	return out;
}
