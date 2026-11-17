/**
 * Linear-time whole-JWS-token discovery and redaction (#3723).
 *
 * The legacy jwt arms at both redaction sites bound the first (header)
 * segment to `{10,1024}` because an unbounded segment made the regex
 * quadratic on dense `eyJ` runs. A JWS whose header carries an `x5c`
 * certificate chain (RFC 7515 §4.1.6 — 1.2-5 KB, e.g. Apple App Store
 * Server payloads or Android attestations) exceeds that bound, so the arm
 * misses the token and the payload and signature survive in clear text in a
 * bare placement (the base64 fallback arms require ≥80-char runs and exclude
 * `-`/`_` from their class, so the 40-60 char segments never match).
 *
 * This scanner is the single-pass alternative: one greedy pass over maximal
 * `[A-Za-z0-9_.-]+` runs (a single-char class regex cannot backtrack), then
 * pure string arithmetic per run — split on `.`, scan LEFTMOST
 * NON-OVERLAPPING segment triples (i advances 3 on acceptance, 1 on
 * rejection, mirroring the global regex's consumption), accept the legacy
 * arm's shape minus the 1024 cap (header ≥ 'eyJ'+10, payload ≥ 1, signature
 * ≥ 10), and replace the accepted span with the same `[REDACTED:jwt]`
 * label the legacy family uses. Output is built from slices in one forward
 * walk — no repeated whole-run copies, O(n) in the input.
 */

/** Maximal dotted base64url-ish runs — single-char class, linear, no backtracking. */
const DOTTED_RUN_RE = /[A-Za-z0-9_.-]+/g;

/** The redaction label both legacy jwt arms already use. */
export const JWS_REDACTION_LABEL = '[REDACTED:jwt]';

/** Acceptance bounds, byte-identical to the legacy arm's quantifiers. */
const HEADER_PREFIX = 'eyJ';
const MIN_HEADER_TOTAL = 13; // 'eyJ' + {10,}
const MIN_PAYLOAD = 1; // {1,}
const MIN_SIGNATURE = 10; // {10,}

export interface JwsTokenSpan {
	/** Inclusive start index of the 'eyJ' header start, in the input string. */
	start: number;
	/** Exclusive end index (end of the signature segment). */
	end: number;
}

/**
 * The `\b`-equivalent 'eyJ' start inside a dot-free segment: the segment
 * start, or immediately after a '-' (the only non-word character besides '.'
 * that can appear inside a run segment; a word character before 'e' would
 * have merged into the same segment, so no boundary exists there — the same
 * reasoning that makes the legacy `\beyJ` anchor correct).
 *
 * LEFTMOST boundary (implementation-review r1): a later in-header `-eyJ`
 * occurrence must not mask an earlier eligible boundary. Because the length
 * acceptance below compares the REMAINING segment length from the boundary,
 * the first boundary is always the longest candidate — if it fails the
 * minimum, every later boundary is shorter and must fail too — so taking the
 * first candidate is exact, not an approximation, and stays O(1) per segment.
 */
function headerStart(segment: string): number {
	if (segment.startsWith(HEADER_PREFIX)) return 0;
	const idx = segment.indexOf(`-${HEADER_PREFIX}`);
	return idx === -1 ? -1 : idx + 1;
}

/**
 * Find every whole three-segment JWS token span in `text` (leftmost,
 * non-overlapping, per maximal dotted run). Linear in the input length.
 */
export function findJwsTokenSpans(text: string): JwsTokenSpan[] {
	const spans: JwsTokenSpan[] = [];
	DOTTED_RUN_RE.lastIndex = 0;
	for (const run of text.matchAll(DOTTED_RUN_RE)) {
		const runStart = run.index ?? 0;
		const segments = run[0].split('.');
		// Cumulative offset of each segment start within the run.
		const offsets: number[] = [];
		let cursor = 0;
		for (const segment of segments) {
			offsets.push(cursor);
			cursor += segment.length + 1; // +1 for the '.' separator
		}
		let i = 0;
		while (i + 2 < segments.length) {
			const headerSeg = segments[i] as string;
			const hs = headerStart(headerSeg);
			if (hs === -1) {
				i += 1;
				continue;
			}
			const headerLength = headerSeg.length - hs;
			const payload = segments[i + 1] as string;
			const signature = segments[i + 2] as string;
			if (
				headerLength >= MIN_HEADER_TOTAL &&
				payload.length >= MIN_PAYLOAD &&
				signature.length >= MIN_SIGNATURE
			) {
				const start = runStart + (offsets[i] as number) + hs;
				const end = runStart + (offsets[i + 2] as number) + signature.length;
				spans.push({ start, end });
				i += 3; // accepted: consume the triple (non-overlapping)
			} else {
				i += 1; // rejected: advance one segment
			}
		}
	}
	return spans;
}

/**
 * Replace every whole JWS token span with `[REDACTED:jwt]` (span-precise —
 * surrounding text, including prefix/suffix text inside the same dotted run,
 * is preserved). Used as the textual pre-pass at sites without a
 * condensed-view sweep (the shell mirror); the display site consumes the
 * span producer directly on both of its views.
 */
export function redactJwsTokens(text: string): string {
	const spans = findJwsTokenSpans(text);
	if (spans.length === 0) return text;
	let out = '';
	let cursor = 0;
	for (const span of spans) {
		out += text.slice(cursor, span.start) + JWS_REDACTION_LABEL;
		cursor = span.end;
	}
	out += text.slice(cursor);
	return out;
}
