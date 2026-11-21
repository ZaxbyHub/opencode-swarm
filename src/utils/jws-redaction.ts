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
 * length <16 stays visible.
 *
 * #3743 closures: a dir-JWE whose IV fails tokenLike no longer stays fully
 * visible (the IV position is accepted structurally); a 13-39-char standard
 * header that strictly base64-decodes to a JSON object is redacted (the 40+
 * floor remains for non-JSON-decoding headers, so benign dotted paths stay
 * visible); glued-composition tails are recovered by candidate enumeration +
 * the header-overreach clamp (an approved widening: two adjacent spans may
 * merge across an internal separator dot — same disclosed over-redaction
 * class as the Snapshot absorption above; coverage is never reduced).
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

/**
 * #3743: a 13-39-char standard-alphabet header below the 40-char floor is a
 * candidate iff it is STRICTLY valid base64 (standard alphabet only, at most
 * two trailing padding chars, no interior separator junk) AND decodes to a
 * JSON OBJECT (every real JWS/JWE header is a JSON object; version strings,
 * dotted paths, and prose never decode to one). The floor stays for
 * non-JSON-decoding headers, so benign path-like dotted runs stay visible.
 */
const SHORT_HEADER_MIN = MIN_HEADER_TOTAL; // 13
const SHORT_HEADER_MAX = 39;

function isShortJsonHeader(seg: string): boolean {
	if (seg.length < SHORT_HEADER_MIN || seg.length > SHORT_HEADER_MAX)
		return false;
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(seg)) return false;
	let decoded: string;
	try {
		decoded = Buffer.from(seg, 'base64').toString('utf8');
	} catch {
		return false;
	}
	if (!decoded.startsWith('{')) return false;
	try {
		const parsed: unknown = JSON.parse(decoded);
		return (
			typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
		);
	} catch {
		return false;
	}
}

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
	// 4.5-review F4: take the EARLIEST boundary across BOTH delimiter types —
	// a later in-segment `-eyJ` must not mask an earlier `_eyJ` boundary (the
	// leftmost rule above: the earliest boundary is the longest candidate).
	const hyphen = segment.indexOf(`-${HEADER_PREFIX}`);
	const underscore = segment.indexOf(`_${HEADER_PREFIX}`);
	let idx: number;
	if (hyphen === -1) idx = underscore;
	else if (underscore === -1) idx = hyphen;
	else idx = Math.min(hyphen, underscore);
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
 * 4.5-review round 2 (class fix): does a REAL token start at segment j?
 * Uses the SAME acceptance shapes the scanner itself accepts — a signed
 * triple (header >=13, payload >=1, signature >=1), an unsigned 2-segment
 * token (payload >=1, empty LAST signature), or an empty-key structural
 * JWE header position (payload segment empty). Both absorption guards use
 * this one predicate so every acceptance shape is also a stopping shape
 * (round-2 findings: an unsigned neighbor's header and an empty-key JWE
 * tail were swallowed because the guard only recognized signed triples).
 */
function canStartTokenAt(segments: string[], j: number): boolean {
	const headerSeg = segments[j];
	if (headerSeg === undefined) return false;
	const hs = headerStart(headerSeg);
	if (hs === -1 || headerSeg.length - hs < MIN_HEADER_TOTAL) return false;
	const payload = segments[j + 1];
	if (payload === undefined || segments[j + 2] === undefined) return false;
	const signature = segments[j + 2] as string;
	// unsigned 2-segment token: empty signature segment (any position — the
	// final-critic's `hdr.payload..next` composition previously slipped past
	// the last-segment-only form)
	if (signature === '' && payload.length >= MIN_PAYLOAD) {
		return true;
	}
	// empty-key structural JWE header position: payload segment empty
	if (payload === '') return true;
	return payload.length >= MIN_PAYLOAD && signature.length >= MIN_SIGNATURE_EYJ;
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

			// #3736 D3 (final-critic round 1 widened): unsigned 2-segment
			// shape `hdr.payload.` — the signature segment is EMPTY, whether
			// or not it is the run's LAST segment (`hdr.payload..next` and
			// `hdr.payload..hdr2.p2.s2` previously fell through to the signed
			// check, where a 0-length signature fails, leaving the claims
			// visible). The span consumes through the separating dot; a
			// following segment is never part of this token.
			if (signature === '' && payload.length >= MIN_PAYLOAD) {
				spans.push({ start, end: runStart + (offsets[i + 2] as number) });
				i += 3; // consumed hdr + payload + the empty signature slot
				continue;
			}

			// #3736 D2-rev2: structural empty-key JWE `hdr..iv.ct.tag` — the
			// `{1,}` payload minimum cannot hold; accept when at least ONE
			// token-like segment follows the empty key (the iv), absorbing
			// further token-like tail segments (never across a segment that
			// starts a REAL next token — the shared canStartTokenAt
			// predicate). One follower suffices because a truncated or
			// adjacent-token composition must still redact the `hdr..iv.`
			// prefix while the next token scans separately (execution-review
			// r2-A2 leg).
			if (payload === '') {
				let last = i + 1; // the empty segment itself is consumed
				let guard = i + 2;
				while (guard < segments.length && guard - i <= 4) {
					const seg = segments[guard] as string;
					// #3743: the FIRST guarded segment is the IV position — the
					// structural evidence (5-part dotted shape with an EMPTY
					// second segment after a >=13-char header) identifies the
					// token, so the IV's own character mix is not evidence
					// against it: accept any NON-EMPTY IV that does not itself
					// start a real next token. Every segment AFTER the IV keeps
					// the tokenLike gate (tail absorption semantics unchanged —
					// `.build2024`/`s10`/`.next` stay visible).
					if (guard === i + 2) {
						if (seg === '' || canStartTokenAt(segments, guard)) break;
					} else if (
						seg === '' ||
						canStartTokenAt(segments, guard) ||
						!tokenLike(seg)
					) {
						break;
					}
					last = guard;
					guard += 1;
				}
				if (last >= i + 2) {
					// at least one token-like segment follows the empty key
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
				// segments (<= 3 further token-like segments — #3743 widens 2
				// -> 3 so a fully base64url-compatible glued token's third
				// trailing segment is covered; the pinned controls stay
				// visible because `.build2024`/`s10`/`.next` all FAIL
				// tokenLike — never across a segment that starts a REAL next
				// token of ANY accepted shape — the shared canStartTokenAt
				// predicate, 4.5 review round 2 — optionally crossing ONE
				// empty interior segment).
				let last = i + 2;
				let extra = 0;
				let crossedEmpty = false;
				while (extra < 3 && last + 1 < segments.length) {
					const next = segments[last + 1] as string;
					if (canStartTokenAt(segments, last + 1)) {
						break; // a REAL adjacent token (any shape) — scan it next
					}
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
 * standard base64 chars (no eyJ requirement; #3743: or a 13-39-char header
 * that strictly decodes to a JSON object) followed by a >=20-char payload and
 * a >=10-char signature. Candidate headers are the WHOLE segment first (bare
 * placement, trailing `=` padding included), then the suffix after interior
 * `=` separators with non-empty prefix AND suffix (assignment placement: the
 * span starts AT the separator, so a `key`-style prefix stays visible and the
 * separator is consumed — no re-matchable `key=[REDACTED:jwt]` residue).
 * Earliest valid separator wins. This is the GREEDY base scan (accept and
 * advance past the consumed triple) whose output is pinned by suites; the
 * #3743 enumeration variant below reuses the same acceptance test.
 */
interface RichCandidate {
	start: number;
	end: number;
	/** End of the candidate's first (header) segment — the clamp boundary. */
	headerEnd: number;
}

function genericCandidateAt(
	segments: string[],
	offsets: number[],
	runStart: number,
	i: number,
): RichCandidate | null {
	const seg = segments[i] as string;
	let candidateStart = -1;
	if (GENERIC_HEADER_RE.test(seg) || isShortJsonHeader(seg)) {
		candidateStart = offsets[i] as number;
	} else {
		// 4.5-review round 2 (F3 class fix): because the header shape
		// forbids INTERIOR '=', at most ONE interior '=' can carry a valid
		// candidate — the one directly before the trailing standard-base64
		// run. Compute it exactly and linearly from the end: strip <=2
		// trailing '=' padding, walk left over the base64 class, and require
		// the char before that run to be an interior '=' with a non-empty
		// prefix. A `a=b=c=…=i=<header>` prefix chain resolves to the same
		// single candidate as a short `key=`, with no per-separator probing
		// loop at all. Round 3: b64RunStart is SEGMENT-relative — the
		// emitted span adds the segment's cumulative run offset (offsets[i])
		// so a candidate in a NON-first segment (`foo.key=<header>…`)
		// anchors correctly instead of swallowing the dotted prefix.
		let end = seg.length;
		let pad = 0;
		while (end > 0 && seg[end - 1] === '=' && pad < 2) {
			end -= 1;
			pad += 1;
		}
		let b64RunStart = end;
		while (
			b64RunStart > 0 &&
			/[A-Za-z0-9+/]/.test(seg[b64RunStart - 1] as string)
		) {
			b64RunStart -= 1;
		}
		const runLen = end - b64RunStart;
		if (
			(runLen >= 40 || isShortJsonHeader(seg.slice(b64RunStart, end))) &&
			b64RunStart > 1 &&
			(seg[b64RunStart - 1] as string) === '='
		) {
			candidateStart = (offsets[i] as number) + b64RunStart - 1;
		}
	}
	if (candidateStart === -1) return null;
	const payload = segments[i + 1] as string;
	const signature = segments[i + 2] as string;
	if (
		payload.length >= GENERIC_MIN_PAYLOAD &&
		GENERIC_B64_RE.test(payload) &&
		signature.length >= GENERIC_MIN_SIGNATURE &&
		GENERIC_B64_RE.test(signature)
	) {
		return {
			start: runStart + candidateStart,
			end: runStart + (offsets[i + 2] as number) + signature.length,
			// The header segment ends where the payload segment begins.
			headerEnd: runStart + (offsets[i + 1] as number),
		};
	}
	return null;
}

export function findStandardB64TokenSpans(text: string): JwsTokenSpan[] {
	const spans: JwsTokenSpan[] = [];
	STANDARD_B64_DOTTED_RUN_RE.lastIndex = 0;
	for (const run of text.matchAll(STANDARD_B64_DOTTED_RUN_RE)) {
		const { segments, offsets, runStart } = splitRun(run);
		let i = 0;
		while (i + 2 < segments.length) {
			const candidate = genericCandidateAt(segments, offsets, runStart, i);
			if (candidate) {
				spans.push({ start: candidate.start, end: candidate.end });
				i += 3;
			} else {
				i += 1;
			}
		}
	}
	return spans;
}

/**
 * #3743: enumeration variant — a valid candidate at EVERY segment anchor.
 * The greedy scan above advances past a consumed triple, which SUPPRESSES a
 * real glued-header candidate that starts inside the consumed span (the
 * greedy artifact accepted a mid-token triple and skipped the true anchor).
 * Enumeration surfaces every candidate; the resolver decides.
 */
function enumerateStandardB64Candidates(text: string): RichCandidate[] {
	const candidates: RichCandidate[] = [];
	STANDARD_B64_DOTTED_RUN_RE.lastIndex = 0;
	for (const run of text.matchAll(STANDARD_B64_DOTTED_RUN_RE)) {
		const { segments, offsets, runStart } = splitRun(run);
		for (let i = 0; i + 2 < segments.length; i++) {
			const candidate = genericCandidateAt(segments, offsets, runStart, i);
			if (candidate) candidates.push(candidate);
		}
	}
	return candidates;
}

/**
 * #3736 + #3743: combined span producer for consumers that splice both
 * families, with a non-overlapping output contract.
 *
 * #3743 pipeline (base-survivor architecture — greedy base first, clamp
 * candidates added without evicting base survivors, family-aware
 * normalization last):
 *
 * 1. Base survivor set B = the ORIGINAL greedy generic scan (accept and
 *    advance) — byte-for-byte base-preserving by construction.
 * 2. Clamp candidate set C = enumerated candidates (every segment anchor)
 *    that are NOT already in B and whose HEADER overreach overlaps an eyJ
 *    span's tail: the greedy skip suppressed exactly these — a real
 *    glued-header candidate whose anchor sits inside a greedy-consumed
 *    triple.
 * 3. Clamp application: each C candidate clamps the overreached eyJ span's
 *    end to the candidate's start (the eyJ span yields its absorbed
 *    glued-header prefix; only the eyJ span is adjusted, never a B member).
 * 4. Final normalization (family-aware, coverage-preserving): sorted by
 *    start; a later overlapping span is DROPPED only when it is generic AND
 *    the kept span is a non-clamp generic (base-preserving — no widening);
 *    every other overlap EXTENDS the kept span to the union end, so coverage
 *    is never narrower than the pre-normalization union. The one approved
 *    widening (#3743 R26): two clamp-adjacent spans may merge across an
 *    internal separator dot (placeholder count can drop; coverage cannot).
 */
export function findRedactableTokenSpans(text: string): JwsTokenSpan[] {
	const eyJ = findJwsTokenSpans(text);
	const base = findStandardB64TokenSpans(text);
	if (eyJ.length === 0) {
		return base;
	}
	// Even when the greedy base found no generic span, enumerated clamp
	// candidates may exist (they only need an overreached eyJ span) — the
	// shared pipeline below handles that.

	const enumerated = enumerateStandardB64Candidates(text);
	const baseKeys = new Set(base.map((b) => `${b.start}:${b.end}`));
	// Clamp-eligible: strictly-later start than an overlapping eyJ span,
	// with the overlap lying entirely within the candidate's first (header)
	// segment — the header-overreach case. Per the plan-critic round-7
	// clarification this applies to candidates from BOTH the greedy base set
	// and the enumerated additions (an eyJ span's absorption can overreach
	// into a glued header the greedy scan DID discover — dropping it as a
	// mid-token artifact is what leaked the tail).
	const isClampEligible = (c: RichCandidate): boolean =>
		eyJ.some(
			(head) =>
				head.start < c.end &&
				c.start < head.end &&
				c.start > head.start &&
				Math.min(head.end, c.end) <= c.headerEnd,
		);
	const clampedKeys = new Set<string>();
	// Apply clamps: each clamp candidate yields its prefix from the FIRST eyJ
	// span it overreaches. Candidates are enumerated left-to-right, so the
	// earliest candidate per head wins (re-check the overlap against the
	// CURRENT end — a later candidate clamps an already-clamped head only if
	// it still overreaches).
	for (const c of enumerated) {
		if (!isClampEligible(c)) continue;
		for (const head of eyJ) {
			if (
				head.start < c.end &&
				c.start < head.end &&
				c.start > head.start &&
				Math.min(head.end, c.end) <= c.headerEnd
			) {
				head.end = c.start;
				clampedKeys.add(`${c.start}:${c.end}`);
				break;
			}
		}
	}

	interface NamedSpan extends JwsTokenSpan {
		eyJFamily: boolean;
		clampEmitted: boolean;
		/** True once an eyJ span has merged into this kept generic span. */
		mergedEyJ?: boolean;
	}
	const all: NamedSpan[] = [
		...eyJ.map((s) => ({ ...s, eyJFamily: true, clampEmitted: false })),
		...base.map(
			(s): NamedSpan => ({
				...s,
				eyJFamily: false,
				clampEmitted: clampedKeys.has(`${s.start}:${s.end}`),
			}),
		),
		// Enumerated additions beyond the greedy base — the candidates the
		// greedy accept-and-advance skip-suppressed. ALL of them enter the
		// arbitration (not only clamp-eligible ones): the normalization below
		// is base-preserving for plain generic overlaps (the later one is
		// dropped — no widening), while a suppressed candidate that extends
		// coverage past a clamp-emitted span unions forward (#3743 extended
		// composition: the P40-anchored survivor must not be evicted).
		...enumerated
			.filter((c) => !baseKeys.has(`${c.start}:${c.end}`))
			.map((s): NamedSpan => ({ ...s, eyJFamily: false, clampEmitted: false })),
	];
	all.sort((a, b) => a.start - b.start || b.end - a.end);

	const kept: NamedSpan[] = [];
	for (const span of all) {
		const last = kept[kept.length - 1];
		if (!last || span.start >= last.end) {
			kept.push(span);
			continue;
		}
		if (last.eyJFamily && !span.eyJFamily && !span.clampEmitted) {
			// #3736 artifact rule (base behavior): a strictly-later generic
			// span overlapping an eyJ span is a mid-token artifact — dropped.
			continue;
		}
		if (!last.eyJFamily && span.eyJFamily) {
			if (!last.mergedEyJ) {
				// First eyJ span this generic leads into — #3736 F1/F2 merge
				// (base rule a): full union, the generic's own leading header
				// material is real credential coverage.
				last.mergedEyJ = true;
				last.end = Math.max(last.end, span.end);
				continue;
			}
			if (last.clampEmitted) {
				// #3743: a subsequent eyJ span starting inside a clamp-emitted
				// candidate's territory — the coverage-preserving union keeps
				// the wider end (the approved R26 widening surface).
				last.end = Math.max(last.end, span.end);
				continue;
			}
			// #3736 Stage-B clamp (base behavior): after the first merge, a
			// plain generic span never extends across the start of a DISTINCT
			// following eyJ token — that token reclaims its territory and
			// both keep separate spans (and separate placeholders).
			last.end = span.start;
			kept.push(span);
			continue;
		}
		if (
			!last.eyJFamily &&
			!span.eyJFamily &&
			!last.clampEmitted &&
			!span.clampEmitted
		) {
			// #3743 base-preserving rule: two plain generic spans never widen
			// — the later one is dropped (the greedy base could only ever
			// produce the earlier).
			continue;
		}
		// Coverage-preserving union (#3743 R24): never narrower than the
		// pre-normalization union within the Stage-B eyJ boundaries above.
		last.end = Math.max(last.end, span.end);
	}
	return kept;
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
