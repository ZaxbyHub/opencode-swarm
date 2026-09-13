/**
 * General Council Mode — pure synthesis service.
 *
 * No I/O, no HTTP. Takes completed member responses for all rounds and
 * produces the final `GeneralCouncilResult`. Mirrors the design of
 * `./council-service.ts` (synthesizeCouncilVerdicts).
 *
 * Quadratic Voting (NSED arXiv:2601.16863): consensus claims are weighted by
 * member confidence rather than counted by headcount. A claim is a consensus
 * point only when its weighted agreement exceeds 0.6 across members.
 *
 * MAINTAIN/CONCEDE/NUANCE protocol (ConfMAD): a Round 2 response resolves a
 * Round 1 disagreement only when a disputant declares a paragraph-leading
 * CONCEDE on that topic (the documented stance grammar in
 * ../agents/council-prompts.ts); MAINTAIN and NUANCE both leave it
 * persisting (NUANCE carries no distinct synthesis behavior — it is parsed
 * only so the stance grammar is recognized and recorded). Issue #2578: prose
 * that merely CONTAINS the word "concede" (e.g. "MAINTAIN — I do not
 * concede…") is not a concession, and a member detected as holding a
 * contrary position (typed oppose/alternative claim, or appearing in any
 * detected disagreement) is disagreement evidence that must never be emitted
 * as consensus.
 */

import {
	areContraryStances,
	detectDisagreements,
	isWellFormedClaim,
} from './disagreement-detector.js';
import type {
	GeneralCouncilDeliberationResponse,
	GeneralCouncilDisagreement,
	GeneralCouncilMemberResponse,
	GeneralCouncilResult,
	WebSearchResult,
} from './general-council-types.js';

/** Confidence-weighted consensus threshold (NSED Quadratic Voting). */
const CONSENSUS_WEIGHT_THRESHOLD = 0.6;

/** Round 2 stance keywords, exactly as documented in council-prompts.ts. */
const LEADING_STANCE_KEYWORDS = ['MAINTAIN', 'CONCEDE', 'NUANCE'] as const;

export type GeneralCouncilLeadingStance =
	(typeof LEADING_STANCE_KEYWORDS)[number];

/** One paragraph-leading stance declaration parsed from a Round 2 response. */
export interface LeadingStanceDeclaration {
	stance: GeneralCouncilLeadingStance;
	/** The full text of the paragraph whose first word is the stance keyword. */
	paragraph: string;
}

/**
 * Parse the documented paragraph-leading stance contract (issue #2578 sole
 * owner: this module — callers must reuse this parser, not re-implement it).
 *
 * A declaration exists only when the FIRST word of a paragraph (blank-line
 * separated) is exactly one of the uppercase keywords MAINTAIN / CONCEDE /
 * NUANCE (case-sensitive, as the prompt documents them), standing alone
 * before whitespace, punctuation, or a markdown decorator. Prose such as
 * "I do not concede" or "After review I concede…" never leads a paragraph
 * with the keyword and so yields no declaration — the conservative direction
 * (no concession).
 *
 * Council prompts sanction markdown inside the response string ("Markdown OK
 * inside the string"), so common paragraph decorators must not hide a
 * declaration: leading blockquote/heading/list markers are stripped before
 * the first-word check, emphasis wrapping (bold/italic/code) and hyphen
 * joins are boundary characters, and zero-width characters are removed.
 */
export function extractLeadingStanceDeclarations(
	response: string,
): LeadingStanceDeclaration[] {
	if (typeof response !== 'string' || response.length === 0) return [];
	const declarations: LeadingStanceDeclaration[] = [];
	for (const raw of response.split(/\n\s*\n/)) {
		const paragraph = raw
			.trim()
			// Zero-width and BOM characters must not absorb the keyword.
			.replace(/[\u200B-\u200D\uFEFF]/g, '')
			// Leading blockquote, heading, and list markers (the prompt says
			// markdown is OK), repeated for nested cases.
			.replace(/^(?:>\s*|#{1,6}\s+|[-*+]\s+|\d{1,3}[.)]\s+)*/, '')
			// Emphasis opening markers directly before the keyword.
			.replace(/^[_*~]+/, '')
			// Quotation marks and backticks directly before the keyword
			// (a member quoting or code-fencing the stance keyword).
			.replace(/^["'`]+/, '');
		if (paragraph === '') continue;
		const boundary = paragraph.search(/[\s:,.;!?—–*_`>#-]/);
		const firstWord =
			boundary === -1 ? paragraph : paragraph.slice(0, boundary);
		if ((LEADING_STANCE_KEYWORDS as readonly string[]).includes(firstWord)) {
			declarations.push({
				stance: firstWord as GeneralCouncilLeadingStance,
				paragraph,
			});
		}
	}
	return declarations;
}

/** Tokenize for claim-similarity grouping. */
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter((t) => t.length >= 4);
}

/** Token overlap (Jaccard). */
function similarity(a: string, b: string): number {
	const tokensA = new Set(tokenize(a));
	const tokensB = new Set(tokenize(b));
	if (tokensA.size === 0 || tokensB.size === 0) return 0;
	let intersection = 0;
	for (const t of tokensA) if (tokensB.has(t)) intersection++;
	const union = tokensA.size + tokensB.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/** Extract candidate claim sentences (length >= 30 chars, contains a period). */
function extractClaims(response: string): string[] {
	return response
		.split(/(?<=[.!?])\s+/)
		.map((s) => s.trim())
		.filter((s) => s.length >= 30 && s.length <= 400);
}

interface ClaimCluster {
	representative: string;
	weightedAgreement: number;
	memberIds: Set<string>;
}

/**
 * Cluster claims across members, weighting each contribution by the member's
 * confidence. Returns clusters whose weighted agreement crosses the threshold,
 * with the representative claim as the longest variant in the cluster.
 *
 * "Weighted agreement" = sum(confidence) / total members — bounded to [0, 1].
 *
 * Issue #2578: the documented stance contract is parsed BEFORE similarity
 * clustering. A member holding at least one well-formed contrary typed claim
 * (oppose/alternative — the canonical `areContraryStances(stance, 'support')`
 * definition) is excluded from consensus clustering entirely: an explicit
 * contrary position is disagreement evidence until a valid paragraph-leading
 * concession resolves it, and lexical linking of a contrary sentence back to
 * its subject is unreliable under negation. The exclusion is deliberately
 * conservative (under-report consensus, never report a contrary position as
 * consensus).
 *
 * Feedback round (review F-3, critic-confirmed): the claims field is OPTIONAL
 * in the prompt contract, so exclusion cannot key on typed claims alone. A
 * member with NO well-formed support typed claim who appears in any detected
 * disagreement (marker-phrase pass, divergence pairing) is excluded as well:
 * their contrary sentence must never be emitted as a consensus point.
 * Members holding explicit support claims stay in clustering — excluding the
 * support side of a detected divergence would over-suppress agreeing
 * majorities. Residual (documented, safe direction): a dissenter missed by
 * every detection pass (no claims, no marker phrase, high lexical overlap
 * under negation) is indistinguishable from a supporter at this layer.
 */
function buildConsensusClusters(
	responses: GeneralCouncilMemberResponse[],
	disagreements: GeneralCouncilDisagreement[],
): string[] {
	if (responses.length < 2) return [];
	const totalMembers = responses.length;

	const membersWithContraryClaims = new Set(
		responses
			.filter((member) =>
				(Array.isArray(member.claims) ? member.claims : []).some(
					(claim) =>
						isWellFormedClaim(claim) &&
						areContraryStances(claim.stance, 'support'),
				),
			)
			.map((member) => member.memberId),
	);
	const typedSupportMembers = new Set(
		responses
			.filter((member) =>
				(Array.isArray(member.claims) ? member.claims : []).some(
					(claim) => isWellFormedClaim(claim) && claim.stance === 'support',
				),
			)
			.map((member) => member.memberId),
	);
	for (const disagreement of disagreements) {
		for (const position of disagreement.positions) {
			if (typedSupportMembers.has(position.memberId)) {
				// A typed support claim rescues a flagged member from
				// exclusion only when it pertains to the disagreement it is
				// flagged on. An unrelated-subject support claim must not
				// rescue a marker-phrase dissenter: their contrary sentence
				// would otherwise be eligible for consensus clustering.
				// When the subject relation cannot be established the member
				// is excluded — under-reporting consensus is the safe
				// direction (never reporting a contrary position as
				// consensus).
				const member = responses.find((m) => m.memberId === position.memberId);
				const pertains = (
					Array.isArray(member?.claims) ? member.claims : []
				).some((claim) => {
					if (!isWellFormedClaim(claim) || claim.stance !== 'support')
						return false;
					const subject =
						typeof claim.subject === 'string'
							? claim.subject.toLowerCase()
							: '';
					const topic = disagreement.topic.toLowerCase();
					return (
						subject !== '' &&
						(topic.includes(subject) || subject.includes(topic))
					);
				});
				if (pertains) continue;
			}
			membersWithContraryClaims.add(position.memberId);
		}
	}

	const clusters: ClaimCluster[] = [];
	for (const member of responses) {
		if (membersWithContraryClaims.has(member.memberId)) continue;
		const confidence = clamp01(member.confidence ?? 0.5);
		const claims = extractClaims(member.response ?? '');
		for (const claim of claims) {
			let assigned = false;
			for (const cluster of clusters) {
				if (similarity(cluster.representative, claim) >= 0.5) {
					if (!cluster.memberIds.has(member.memberId)) {
						cluster.weightedAgreement += confidence;
						cluster.memberIds.add(member.memberId);
					}
					if (claim.length > cluster.representative.length) {
						cluster.representative = claim;
					}
					assigned = true;
					break;
				}
			}
			if (!assigned) {
				clusters.push({
					representative: claim,
					weightedAgreement: confidence,
					memberIds: new Set([member.memberId]),
				});
			}
		}
	}

	return clusters
		.filter(
			(c) =>
				c.memberIds.size >= 2 &&
				c.weightedAgreement / totalMembers >= CONSENSUS_WEIGHT_THRESHOLD,
		)
		.sort(
			(a, b) =>
				b.weightedAgreement - a.weightedAgreement ||
				b.memberIds.size - a.memberIds.size,
		)
		.map((c) => c.representative);
}

function clamp01(n: number): number {
	if (typeof n !== 'number' || Number.isNaN(n)) return 0;
	if (n < 0) return 0;
	if (n > 1) return 1;
	return n;
}

/**
 * Compute persisting disagreements: those whose Round 2 responses do NOT
 * contain a valid concession on the relevant disagreement topic.
 *
 * Issue #2578: a concession is a paragraph-leading CONCEDE declaration
 * (extractLeadingStanceDeclarations) by a disputant whose response lists the
 * topic — the documented grammar, not the word "concede" anywhere in the
 * response. Everything else (MAINTAIN, NUANCE, prose mentions, negations like
 * "I do not concede", missing declarations) leaves the disagreement
 * persisting: explicit disagreement is preserved unless a valid concession is
 * actually declared.
 *
 * Known binding scope (review PRR-001): resolution binds at the TOPIC-LIST
 * level, exactly as the issue contract specifies ("a CONCEDE from a disputant
 * whose response lists the topic"). A member who declares CONCEDE on one
 * listed topic while declaring MAINTAIN on another listed topic resolves both;
 * per-declaration topic binding is a deliberate contract boundary, not an
 * oversight. Tightening it is a detection-improvement follow-up, same bucket
 * as the missed-dissenter residual below.
 */
function computePersistingDisagreements(
	disagreements: GeneralCouncilDisagreement[],
	round2: GeneralCouncilDeliberationResponse[],
): GeneralCouncilDisagreement[] {
	if (disagreements.length === 0) return [];
	if (round2.length === 0) return disagreements;

	return disagreements.filter((d) => {
		// A disagreement is resolved if at least one disputing member CONCEDEs on it.
		const disputants = new Set(d.positions.map((p) => p.memberId));
		const conceded = round2.some((r) => {
			if (!disputants.has(r.memberId)) return false;
			if (!r.disagreementTopics?.includes(d.topic)) return false;
			return extractLeadingStanceDeclarations(r.response ?? '').some(
				(declaration) => declaration.stance === 'CONCEDE',
			);
		});
		return !conceded;
	});
}

/** De-duplicate sources by URL (keep first occurrence). */
function dedupeSources(
	round1: GeneralCouncilMemberResponse[],
	round2: GeneralCouncilDeliberationResponse[],
): WebSearchResult[] {
	const seen = new Set<string>();
	const out: WebSearchResult[] = [];
	const allSources = [...round1, ...round2].flatMap((r) => r.sources ?? []);
	for (const src of allSources) {
		if (!src?.url) continue;
		if (seen.has(src.url)) continue;
		seen.add(src.url);
		out.push(src);
	}
	return out;
}

/**
 * Render the structural synthesis markdown. The moderator pass (when configured)
 * consumes this as input and produces the user-facing answer.
 */
function renderSynthesisMarkdown(
	question: string,
	mode: 'general' | 'spec_review',
	roundsCompleted: 1 | 2,
	members: GeneralCouncilMemberResponse[],
	consensusPoints: string[],
	persistingDisagreements: GeneralCouncilDisagreement[],
	allSources: WebSearchResult[],
): string {
	const memberLines = members
		.map((m) => `- ${m.memberId} (${m.model}, ${m.role})`)
		.join('\n');

	const consensusBlock =
		consensusPoints.length > 0
			? consensusPoints.map((c) => `- ${c}`).join('\n')
			: '_No consensus claims reached the weighted-agreement threshold._';

	const disagreementsBlock =
		persistingDisagreements.length > 0
			? persistingDisagreements
					.map(
						(d) =>
							`- **${d.topic}**\n` +
							d.positions
								.map((p) => `  - ${p.memberId}: ${p.claim}`)
								.join('\n'),
					)
					.join('\n')
			: '_No persisting disagreements after deliberation._';

	const sourcesBlock =
		allSources.length > 0
			? allSources.map((s) => `- [${s.title || s.url}](${s.url})`).join('\n')
			: '_No sources cited._';

	return [
		'## General Council Synthesis',
		'',
		`**Question:** ${question}`,
		`**Mode:** ${mode}`,
		`**Members:**\n${memberLines}`,
		`**Rounds:** ${roundsCompleted}`,
		'',
		'### Consensus',
		consensusBlock,
		'',
		'### Persistent Disagreements',
		disagreementsBlock,
		'',
		'### Sources',
		sourcesBlock,
	].join('\n');
}

/**
 * Pure synthesis. Given completed member responses, produces the final
 * `GeneralCouncilResult` (without `moderatorOutput` — moderator is invoked
 * by the architect after this returns and populated separately).
 */
export function synthesizeGeneralCouncil(
	question: string,
	mode: 'general' | 'spec_review',
	round1Responses: GeneralCouncilMemberResponse[],
	round2Responses: GeneralCouncilDeliberationResponse[],
): GeneralCouncilResult {
	const safeRound1 = Array.isArray(round1Responses) ? round1Responses : [];
	const safeRound2 = Array.isArray(round2Responses) ? round2Responses : [];

	const disagreements = detectDisagreements(safeRound1);
	const consensusPoints = buildConsensusClusters(safeRound1, disagreements);
	const persistingDisagreements = computePersistingDisagreements(
		disagreements,
		safeRound2,
	);
	const allSources = dedupeSources(safeRound1, safeRound2);
	const roundsCompleted: 1 | 2 = safeRound2.length > 0 ? 2 : 1;

	const synthesis = renderSynthesisMarkdown(
		question,
		mode,
		roundsCompleted,
		safeRound1,
		consensusPoints,
		persistingDisagreements,
		allSources,
	);

	return {
		question,
		mode,
		round1Responses: safeRound1,
		disagreements,
		round2Responses: safeRound2,
		synthesis,
		consensusPoints,
		persistingDisagreements: persistingDisagreements.map((d) => d.topic),
		allSources,
		timestamp: new Date().toISOString(),
	};
}
