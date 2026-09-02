/**
 * Learning provenance records (issue #1821, Lane 0a).
 *
 * Every durable learning write — a curator sweep decision, a micro-reflection,
 * a PRM pattern, a consensus-mined lesson, a skill-improver edit — must be able
 * to say *where it came from*. `LearningProvenanceV1` is the shared envelope:
 * which mechanism produced it, which knowledge/task/evidence/run/model ids fed
 * it, and which session/agent physically wrote it.
 *
 * Every reference class is deduplicated, sorted, and hard-capped at
 * `MAX_REFS_PER_CLASS` so a long-running session cannot grow a provenance record
 * without bound (AGENTS.md invariant 8 — global/persisted state must be
 * bounded).
 *
 * This module is pure: no filesystem, no network, no module-level mutable state.
 * The only ambient input is the wall clock, and only when the caller does not
 * supply `producedAt` — callers that need determinism pass it explicitly.
 */

import { z } from 'zod';
import {
	getCurrentWriteAuthority,
	type WriteAuthorityOrigin,
} from '../security/write-authority.js';

/**
 * Hard cap on entries retained per reference class. Sorting happens before the
 * cap so truncation is deterministic rather than insertion-order dependent.
 */
export const MAX_REFS_PER_CLASS = 50;

/** The learning mechanism that produced a record. */
export type LearningMechanism =
	| 'curator_sweep'
	| 'micro_reflection'
	| 'prm_pattern'
	| 'consensus_mine'
	| 'skill_improver';

/**
 * NOT exported: it exists only as the `mechanism` field of
 * `LearningProvenanceV1Schema`, and every consumer validates through that. The
 * public name for this set is the `LearningMechanism` union above.
 */
const LearningMechanismSchema = z.enum([
	'curator_sweep',
	'micro_reflection',
	'prm_pattern',
	'consensus_mine',
	'skill_improver',
]);

/**
 * Bounded reference string. Deliberately looser than
 * `EvaluationIdentifierSchema` in `src/evaluation/contracts.ts`: model ids
 * (`anthropic/claude-opus-4`) and evidence refs (`.swarm/evidence/phase-1.json`)
 * legitimately contain `/`, which the evaluation identifier regex rejects. The
 * invariants that matter here are non-empty, bounded, and NUL-free.
 */
const ReferenceSchema = z
	.string()
	.min(1)
	.max(512)
	.refine((value) => !value.includes('\0'), 'reference contains a NUL byte');

/** ISO-8601 timestamp, matching the evaluation contracts convention. */
const IsoDateSchema = z.iso.datetime({ offset: true });

const ReferenceListSchema = z.array(ReferenceSchema).max(MAX_REFS_PER_CLASS);

/**
 * NOT exported, for the same reason as `LearningMechanismSchema`: it is only
 * ever reached as `LearningProvenanceV1Schema.shape.writeOrigin`. The public
 * shapes are `LearningProvenanceV1['writeOrigin']` and
 * `LearningWriteOriginInput`.
 *
 * NO `agentId` (issue #1821). It was declared here and no code path could ever
 * produce one: all three production callers of `stampLearningProvenance` —
 * `src/consensus/miner.ts`, `src/services/recommendation-ledger.ts`, and
 * `src/learning/admission.ts` — pass exactly `producedAt` / `sessionId` /
 * `agentRole`, and none of their options bags has a slot to carry an agent id.
 * Declaring a field nothing can reach documented a value that never exists and
 * invited a reader to filter or join on it. `src/consensus/contracts.ts` got the
 * same treatment for its structural mirror of this shape; because this object is
 * `.strict()`, removing the key means an `agentId` is now REJECTED rather than
 * silently reserved. If an agent id ever becomes real, add it here together with
 * the producer that supplies it — not before.
 */
const LearningWriteOriginSchema = z
	.object({
		sessionId: ReferenceSchema.optional(),
		agentRole: ReferenceSchema.optional(),
		authority: z
			.enum([
				'autonomous',
				'optimizer_proposed',
				'critic_approved',
				'human_approved',
			])
			.optional(),
		producedAt: IsoDateSchema,
	})
	.strict();

export const LearningProvenanceV1Schema = z
	.object({
		v: z.literal(1),
		mechanism: LearningMechanismSchema,
		sourceKnowledgeIds: ReferenceListSchema,
		sourceTaskIds: ReferenceListSchema,
		sourceEvidenceRefs: ReferenceListSchema,
		sourceRunIds: ReferenceListSchema,
		sourceModelIds: ReferenceListSchema,
		writeOrigin: LearningWriteOriginSchema,
	})
	.strict();

export interface LearningProvenanceV1 {
	v: 1;
	mechanism: LearningMechanism;
	sourceKnowledgeIds: string[];
	sourceTaskIds: string[];
	sourceEvidenceRefs: string[];
	sourceRunIds: string[];
	sourceModelIds: string[];
	/** See `LearningWriteOriginSchema` for why there is no `agentId` here. */
	writeOrigin: {
		sessionId?: string;
		agentRole?: string;
		authority?: WriteAuthorityOrigin;
		producedAt: string;
	};
}

/** Caller-supplied provenance body. Every reference class is optional. */
export interface LearningProvenanceInput {
	mechanism: LearningMechanism;
	sourceKnowledgeIds?: string[];
	sourceTaskIds?: string[];
	sourceEvidenceRefs?: string[];
	sourceRunIds?: string[];
	sourceModelIds?: string[];
}

/** Caller-supplied write origin. `producedAt` defaults to now when omitted. */
export interface LearningWriteOriginInput {
	sessionId?: string;
	agentRole?: string;
	authority?: WriteAuthorityOrigin;
	producedAt?: string;
}

/**
 * Normalize one reference class: trim, drop empties, deduplicate, sort, then
 * cap. Sorting before capping keeps truncation deterministic for a given input
 * set regardless of the order the caller accumulated the references in.
 */
function normalizeRefs(refs: string[] | undefined): string[] {
	if (!refs || refs.length === 0) return [];
	const deduped = new Set<string>();
	for (const ref of refs) {
		const trimmed = ref.trim();
		if (trimmed.length > 0) deduped.add(trimmed);
	}
	return [...deduped].sort().slice(0, MAX_REFS_PER_CLASS);
}

/** Trim an optional origin field, treating whitespace-only as absent. */
function normalizeOriginField(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build a validated `LearningProvenanceV1` from a partial body and a write
 * origin. Fills `v`, missing reference classes, and `producedAt`; deduplicates,
 * sorts, and caps every reference class; then parses through
 * `LearningProvenanceV1Schema` so the returned value is guaranteed valid.
 *
 * Throws (via Zod) on an unknown mechanism or an unparseable `producedAt` —
 * a malformed provenance record must never be persisted silently.
 */
export function stampLearningProvenance(
	partial: LearningProvenanceInput,
	origin: LearningWriteOriginInput = {},
): LearningProvenanceV1 {
	const writeOrigin: LearningProvenanceV1['writeOrigin'] = {
		producedAt:
			normalizeOriginField(origin.producedAt) ?? new Date().toISOString(),
	};
	const sessionId = normalizeOriginField(origin.sessionId);
	if (sessionId !== undefined) writeOrigin.sessionId = sessionId;
	const agentRole = normalizeOriginField(origin.agentRole);
	if (agentRole !== undefined) writeOrigin.agentRole = agentRole;
	const authority = origin.authority ?? getCurrentWriteAuthority().origin;
	writeOrigin.authority = authority;

	return LearningProvenanceV1Schema.parse({
		v: 1,
		mechanism: partial.mechanism,
		sourceKnowledgeIds: normalizeRefs(partial.sourceKnowledgeIds),
		sourceTaskIds: normalizeRefs(partial.sourceTaskIds),
		sourceEvidenceRefs: normalizeRefs(partial.sourceEvidenceRefs),
		sourceRunIds: normalizeRefs(partial.sourceRunIds),
		sourceModelIds: normalizeRefs(partial.sourceModelIds),
		writeOrigin,
	}) as LearningProvenanceV1;
}
