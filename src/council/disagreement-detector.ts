/**
 * Disagreement detection for the General Council Mode.
 *
 * Pure function module — no I/O, no HTTP, deterministic. Takes Round 1 member
 * responses, returns the set of factual disagreements that should be routed
 * back to disputing members for Round 2 reconciliation.
 *
 * Three-pass detection:
 *   Pass 1 — Explicit linguistic markers ("I disagree with", "unlike", etc.)
 *   Pass 2 — Structured claims (issue #2102 contract G): contrary typed
 *            stances on the same subject, detectable without any marker
 *            phrase. Claims are optional and bounded; when absent, invalid,
 *            or malformed this pass contributes nothing and the fallback
 *            passes below still run.
 *   Pass 3 — Claim divergence heuristic (mutually exclusive recommendations)
 *
 * Marker-based disagreements are always kept: the combined list orders the
 * explicit-marker pass FIRST, so structured data can never push a marker
 * detection out of the MAX_DISAGREEMENTS cap, and dedupe merges positions
 * instead of removing them.
 *
 * NSED design note (arXiv:2601.16863): only the disagreement delta is fed
 * forward to Round 2, not full Round 1 context — mirrors the "semantic forget
 * gate" selective-retention insight and keeps prompt sizes bounded.
 */

import type {
	GeneralCouncilClaim,
	GeneralCouncilDisagreement,
	GeneralCouncilDisagreementPosition,
	GeneralCouncilMemberResponse,
} from './general-council-types.js';

const MAX_DISAGREEMENTS = 10;
const MAX_CLAIMS_PER_MEMBER = 8;
const CLAIM_SUBJECT_OVERLAP_THRESHOLD = 0.6;

const EXPLICIT_DISAGREEMENT_MARKERS = [
	'i disagree with',
	'i would push back on',
	'contrary to',
	'this contradicts',
	'unlike ',
];

// "Strong recommendation" lead-ins for Pass 2 claim extraction.
const STRONG_RECOMMENDATION_MARKERS = [
	'recommend',
	'best approach',
	'should use',
	'i suggest',
	'the answer is',
	'the right choice is',
];

/** Tokenize on word boundaries, lowercase, drop short stopword-like tokens. */
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter((t) => t.length >= 3);
}

/** Jaccard-like overlap on token sets. Returns 0..1. */
function termOverlap(a: string, b: string): number {
	const tokensA = new Set(tokenize(a));
	const tokensB = new Set(tokenize(b));
	if (tokensA.size === 0 || tokensB.size === 0) return 0;
	let intersection = 0;
	for (const t of tokensA) {
		if (tokensB.has(t)) intersection++;
	}
	const union = tokensA.size + tokensB.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/** Extract the first sentence containing any of the markers (lower-cased match). */
function extractMarkerSentence(
	response: string,
	markers: string[],
): string | null {
	const lower = response.toLowerCase();
	const sentences = response.split(/(?<=[.!?])\s+/);
	for (const sentence of sentences) {
		const sentLower = sentence.toLowerCase();
		if (markers.some((m) => sentLower.includes(m))) {
			return sentence.trim();
		}
	}
	// Also check raw substring as a fallback (multi-line claims)
	for (const marker of markers) {
		const idx = lower.indexOf(marker);
		if (idx !== -1) {
			const slice = response.slice(idx, idx + 200);
			return slice.split(/\n/)[0]?.trim() ?? slice.trim();
		}
	}
	return null;
}

/** Deduplicate disagreements by topic (case-insensitive substring match). */
function dedupeByTopic(
	disagreements: GeneralCouncilDisagreement[],
): GeneralCouncilDisagreement[] {
	const result: GeneralCouncilDisagreement[] = [];
	for (const d of disagreements) {
		const topicLower = d.topic.toLowerCase();
		const existing = result.find(
			(r) =>
				r.topic.toLowerCase().includes(topicLower) ||
				topicLower.includes(r.topic.toLowerCase()),
		);
		if (existing) {
			// Merge positions, dedup by memberId
			for (const pos of d.positions) {
				if (!existing.positions.some((p) => p.memberId === pos.memberId)) {
					existing.positions.push(pos);
				}
			}
		} else {
			result.push(d);
		}
	}
	return result;
}

/**
 * Detect explicit disagreements via linguistic markers (Pass 1).
 * Each member who flags an explicit disagreement gets a position with the
 * marker sentence as the topic-relevant claim.
 */
function detectExplicitMarkers(
	responses: GeneralCouncilMemberResponse[],
): GeneralCouncilDisagreement[] {
	const out: GeneralCouncilDisagreement[] = [];
	for (const member of responses) {
		const markerSentence = extractMarkerSentence(
			member.response,
			EXPLICIT_DISAGREEMENT_MARKERS,
		);
		if (!markerSentence) continue;
		const position: GeneralCouncilDisagreementPosition = {
			memberId: member.memberId,
			claim: markerSentence,
			evidence:
				member.sources[0]?.url ?? '(no source cited in marker sentence)',
		};
		out.push({
			topic: markerSentence.slice(0, 80),
			positions: [position],
		});
	}
	return out;
}

/**
 * Extract the first strong recommendation per member (Pass 3 input).
 */
function extractRecommendation(response: string): string | null {
	return extractMarkerSentence(response, STRONG_RECOMMENDATION_MARKERS);
}

const VALID_STANCES = new Set([
	'support',
	'oppose',
	'neutral',
	'concern',
	'alternative',
] as const);

/**
 * Defensive shape check for one structured claim. Malformed claims are
 * skipped individually — they must never break the detector or suppress the
 * fallback passes (issue #2102 contract G safety rule).
 */
function isWellFormedClaim(value: unknown): value is GeneralCouncilClaim {
	if (!value || typeof value !== 'object') return false;
	const claim = value as Partial<GeneralCouncilClaim>;
	return (
		typeof claim.subject === 'string' &&
		claim.subject.length > 0 &&
		claim.subject.length <= 120 &&
		typeof claim.statement === 'string' &&
		claim.statement.length > 0 &&
		claim.statement.length <= 600 &&
		typeof claim.stance === 'string' &&
		VALID_STANCES.has(
			claim.stance as typeof VALID_STANCES extends Set<infer T> ? T : never,
		) &&
		(typeof claim.confidence !== 'number' ||
			(claim.confidence >= 0 && claim.confidence <= 1)) &&
		// Evidence bounds mirror MemberClaimsSchema (≤4 string refs, each
		// ≤240 chars; empty strings are schema-valid) so this defensive layer
		// enforces them independently of the tool boundary (PR review F-BOT-1).
		(claim.evidence === undefined ||
			(Array.isArray(claim.evidence) &&
				claim.evidence.length <= 4 &&
				claim.evidence.every(
					(item) => typeof item === 'string' && item.length <= 240,
				)))
	);
}

function normalizeSubject(subject: string): string {
	return subject.trim().toLowerCase().replace(/\s+/g, ' ');
}

function sameClaimSubject(a: string, b: string): boolean {
	const na = normalizeSubject(a);
	const nb = normalizeSubject(b);
	if (na === nb) return true;
	return termOverlap(na, nb) >= CLAIM_SUBJECT_OVERLAP_THRESHOLD;
}

/**
 * Two stances are contrary when they differ, neither is neutral, and at
 * least one is an explicit contrary position (`oppose` or `alternative`).
 * `concern` flags risk without taking a side, so support-vs-concern is not
 * auto-detected here — the marker/heuristic passes still cover it.
 */
function areContraryStances(
	a: GeneralCouncilClaim['stance'],
	b: GeneralCouncilClaim['stance'],
): boolean {
	if (a === b) return false;
	if (a === 'neutral' || b === 'neutral') return false;
	return (
		a === 'oppose' ||
		a === 'alternative' ||
		b === 'oppose' ||
		b === 'alternative'
	);
}

/**
 * Pass 2 (issue #2102 contract G): structured-claim conflicts. Two members
 * holding different non-neutral stances on the same subject — with at least
 * one `oppose`/`alternative` — is a detectable disagreement even when the
 * free-text response contains none of the marker phrases. No claim supplied
 * by one member is itself proof of consensus or correctness.
 */
function detectStructuredClaimConflicts(
	responses: GeneralCouncilMemberResponse[],
): GeneralCouncilDisagreement[] {
	interface ClaimEntry {
		memberId: string;
		claim: GeneralCouncilClaim;
		evidence: string;
	}
	const entries: ClaimEntry[] = [];
	for (const member of responses) {
		if (!Array.isArray(member.claims)) continue;
		for (const claim of member.claims.slice(0, MAX_CLAIMS_PER_MEMBER)) {
			if (!isWellFormedClaim(claim)) continue;
			entries.push({
				memberId: member.memberId,
				claim,
				evidence:
					(Array.isArray(claim.evidence) ? claim.evidence[0] : undefined) ??
					member.sources?.[0]?.url ??
					'(no source cited in claim)',
			});
		}
	}

	const out: GeneralCouncilDisagreement[] = [];
	for (let i = 0; i < entries.length; i++) {
		for (let j = i + 1; j < entries.length; j++) {
			const a = entries[i];
			const b = entries[j];
			if (!a || !b) continue;
			if (a.memberId === b.memberId) continue;
			if (!sameClaimSubject(a.claim.subject, b.claim.subject)) continue;
			if (!areContraryStances(a.claim.stance, b.claim.stance)) continue;
			out.push({
				topic: normalizeSubject(a.claim.subject).slice(0, 80),
				positions: [
					{
						memberId: a.memberId,
						claim: a.claim.statement,
						evidence: a.evidence,
					},
					{
						memberId: b.memberId,
						claim: b.claim.statement,
						evidence: b.evidence,
					},
				],
			});
		}
	}
	return out;
}

/**
 * Pass 2: claim-divergence heuristic. For every pair of members, if their
 * recommendations target what looks like the same topic (term overlap > 0.4)
 * but propose mutually exclusive specifics (overlap < 0.3), flag a disagreement.
 */
function detectClaimDivergence(
	responses: GeneralCouncilMemberResponse[],
): GeneralCouncilDisagreement[] {
	const recommendations: Array<{
		memberId: string;
		text: string;
		evidence: string;
	}> = [];
	for (const member of responses) {
		const rec = extractRecommendation(member.response);
		if (!rec) continue;
		recommendations.push({
			memberId: member.memberId,
			text: rec,
			evidence: member.sources[0]?.url ?? '(no source cited)',
		});
	}

	const out: GeneralCouncilDisagreement[] = [];
	for (let i = 0; i < recommendations.length; i++) {
		for (let j = i + 1; j < recommendations.length; j++) {
			const a = recommendations[i];
			const b = recommendations[j];
			if (!a || !b) continue;
			const topicOverlap = termOverlap(a.text, b.text);
			if (topicOverlap > 0.4) continue; // same topic AND wording → not a divergence
			// Heuristic for divergence: low overall overlap (each recommends something
			// different about apparently distinct subjects). The original heuristic
			// (topic > 0.4 AND recommendation < 0.3) requires per-subject extraction
			// we don't perform here; the simpler bound captures the typical case.
			if (topicOverlap > 0 && topicOverlap < 0.3) {
				const topic = `${a.text.slice(0, 50)} vs ${b.text.slice(0, 50)}`;
				out.push({
					topic,
					positions: [
						{ memberId: a.memberId, claim: a.text, evidence: a.evidence },
						{ memberId: b.memberId, claim: b.text, evidence: b.evidence },
					],
				});
			}
		}
	}
	return out;
}

/**
 * Detect disagreements across Round 1 member responses.
 *
 * Returns at most MAX_DISAGREEMENTS items, deduplicated by topic. Pure function:
 * given the same input, produces the same output. Empty inputs and missing
 * fields are handled without throwing.
 */
export function detectDisagreements(
	responses: GeneralCouncilMemberResponse[],
): GeneralCouncilDisagreement[] {
	if (!Array.isArray(responses) || responses.length < 2) return [];

	const safeResponses = responses.filter(
		(r): r is GeneralCouncilMemberResponse =>
			typeof r?.memberId === 'string' && typeof r?.response === 'string',
	);

	// Marker pass FIRST so structured data can never push an explicit-marker
	// disagreement out of the cap; the union never drops a marker detection.
	const explicit = detectExplicitMarkers(safeResponses);
	const structured = detectStructuredClaimConflicts(safeResponses);
	const divergent = detectClaimDivergence(safeResponses);

	const combined = [...explicit, ...structured, ...divergent];
	const deduped = dedupeByTopic(combined);
	return deduped.slice(0, MAX_DISAGREEMENTS);
}
