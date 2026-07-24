/**
 * Versioned contracts for the consensus miner (issue #1821, Workstream C).
 *
 * Style mirrors `src/evaluation/contracts.ts`: every persisted shape is a
 * `.strict()` Zod object carrying an explicit `v: z.literal(1)` discriminant, so
 * an unknown key or a future schema version fails loudly at the store boundary
 * instead of silently round-tripping through a partially-understood artifact.
 *
 * The interfaces below are hand-written rather than `z.infer`-derived because
 * the issue specifies them verbatim; the `satisfies`-style compile assertions at
 * the bottom of each block keep the schema and the interface from drifting apart
 * without forcing consumers to read Zod inference to learn the shape.
 */

import { z } from 'zod';

/**
 * Deliberately looser than `EvaluationIdentifierSchema`: consensus references
 * carry model ids (`anthropic/claude-opus-4`), evidence refs
 * (`evaluation-run:run-1`), and skill paths (`.claude/skills/foo/SKILL.md`),
 * all of which legitimately contain `/` and `:`. The invariants that matter
 * here are non-empty, bounded, and NUL-free — the same trade-off
 * `src/learning/provenance.ts` documents for its `ReferenceSchema`.
 */
const ReferenceSchema = z
	.string()
	.min(1)
	.max(512)
	.refine((value) => !value.includes('\0'), 'reference contains a NUL byte');

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IsoDateSchema = z.iso.datetime({ offset: true });

/** Upper bound on any single reference list. Keeps a report bounded on disk. */
export const MAX_CONSENSUS_REFS = 200;

/** Upper bound on a rendered statement. Also the LLM-summary truncation bound. */
export const MAX_CONSENSUS_STATEMENT_CHARS = 600;

export { ReferenceSchema as ConsensusReferenceSchema };
export { Sha256Schema as ConsensusSha256Schema };

const ReferenceListSchema = z.array(ReferenceSchema).max(MAX_CONSENSUS_REFS);

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Mining request. Every filter is optional and intersective: omitting `runIds`
 * means "every run in the corpus", supplying it means "only these runs".
 *
 * Specified verbatim by issue #1821 Workstream C — do not reorder or rename.
 */
export interface ConsensusMineRequest {
	runIds?: string[];
	taskCategories?: string[];
	agentRoles?: string[];
	modelIds?: string[];
	minSupport: number;
	minSuccessfulRuns: number;
	maxEvidenceItems: number;
}

export const ConsensusMineRequestSchema = z
	.object({
		runIds: ReferenceListSchema.optional(),
		taskCategories: ReferenceListSchema.optional(),
		agentRoles: ReferenceListSchema.optional(),
		modelIds: ReferenceListSchema.optional(),
		minSupport: z.number().int().min(1),
		minSuccessfulRuns: z.number().int().min(0),
		maxEvidenceItems: z.number().int().min(1),
	})
	.strict();

// ---------------------------------------------------------------------------
// Attribute
// ---------------------------------------------------------------------------

/** Where a mined attribute would be actioned, if it qualifies as a proposal. */
export const ConsensusProposedTargetSchema = z.enum([
	'skill',
	'prompt',
	'tooling',
	'orchestration',
	'none',
]);
export type ConsensusProposedTarget = z.infer<
	typeof ConsensusProposedTargetSchema
>;

/**
 * One mined consensus attribute.
 *
 * Specified verbatim by issue #1821 Workstream C — do not reorder or rename.
 *
 * Field semantics that are easy to get wrong:
 * - `support` counts DISTINCT RUNS carrying the signal. A run that emits the
 *   same signal fifty times still contributes exactly one.
 * - `successSupport` / `failureSupport` are likewise distinct-run counts, and a
 *   single run may appear in both when it carries the signal on a successful and
 *   a failing observation. They therefore do not have to sum to `support`.
 * - `taskDiversity` counts distinct task identities (task id, else task
 *   category) among the contributing observations. It is the anecdote gate:
 *   below 2 the attribute is emitted as an investigation note only.
 * - `modelDiversity` counts distinct model ids among the contributing
 *   observations, and is **0 when no contributing observation carries a model
 *   id at all** — trajectory-, usage-, and knowledge-derived attributes have no
 *   model attribution in the corpus. Zero therefore means "not measurable from
 *   this corpus", NOT "measured as none", and it must never gate emission on its
 *   own. See `docs/consensus-mining.md`.
 */
export interface ConsensusAttributeV1 {
	v: 1;
	id: string;
	statement: string;
	support: number;
	successSupport: number;
	failureSupport: number;
	taskDiversity: number;
	modelDiversity: number;
	evidenceRefs: string[];
	counterexampleRefs: string[];
	confidence: number;
	proposedTarget: 'skill' | 'prompt' | 'tooling' | 'orchestration' | 'none';
}

export const ConsensusAttributeV1Schema = z
	.object({
		v: z.literal(1),
		id: ReferenceSchema,
		statement: z.string().min(1).max(MAX_CONSENSUS_STATEMENT_CHARS),
		support: z.number().int().nonnegative(),
		successSupport: z.number().int().nonnegative(),
		failureSupport: z.number().int().nonnegative(),
		taskDiversity: z.number().int().nonnegative(),
		modelDiversity: z.number().int().nonnegative(),
		evidenceRefs: ReferenceListSchema,
		counterexampleRefs: ReferenceListSchema,
		confidence: z.number().min(0).max(1),
		proposedTarget: ConsensusProposedTargetSchema,
	})
	.strict()
	.superRefine((attribute, ctx) => {
		if (attribute.successSupport > attribute.support) {
			ctx.addIssue({
				code: 'custom',
				path: ['successSupport'],
				message: 'successful-run support cannot exceed total run support',
			});
		}
		if (attribute.failureSupport > attribute.support) {
			ctx.addIssue({
				code: 'custom',
				path: ['failureSupport'],
				message: 'failing-run support cannot exceed total run support',
			});
		}
		// An attribute whose support includes failing runs but which carries no
		// counterexample references has had its negative evidence dropped. That is
		// exactly the failure mode the miner exists to prevent, so it is a schema
		// error rather than a lint.
		if (
			attribute.failureSupport > 0 &&
			attribute.counterexampleRefs.length === 0
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['counterexampleRefs'],
				message:
					'an attribute with failing support must retain its counterexample references',
			});
		}
	});

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

/**
 * A proposals-only change suggestion. The miner never applies one: it records
 * what a human or a downstream gated workflow could choose to do.
 *
 * `intent` is deliberately *minimal* — one sentence describing the smallest
 * change that would test the attribute. Anything longer invites the reader to
 * treat a mined correlation as a specification.
 */
export interface ProposedSkillChange {
	/** Where the change would land, e.g. a skill slug or subsystem name. */
	target: string;
	/** Minimal, one-sentence statement of the smallest change worth trying. */
	intent: string;
	/** Supporting observations (evidence refs from the corpus). */
	evidenceRefs: string[];
	/** Contradicting observations. Never empty when the attribute has failures. */
	counterexampleRefs: string[];
	/** Inherited from the attribute; in [0, 1]. */
	confidence: number;
	/** The metric a validation run should move if the intent is correct. */
	expectedMetric: string;
	/** Deterministic selector describing which slice to validate against. */
	validationSelector: string;
	/** `computeRecommendationFingerprint({ kind: 'miner', ... })`. */
	fingerprint: string;
	/** `stampLearningProvenance` output for the `consensus_mine` mechanism. */
	provenance: ProposedSkillChangeProvenance;
}

/**
 * Structural mirror of `LearningProvenanceV1` (`src/learning/provenance.ts`).
 *
 * Restated here rather than imported so the consensus store's on-disk contract
 * is self-describing and this module keeps zero non-Zod dependencies; the miner
 * still *produces* the value via `stampLearningProvenance`, so the two shapes
 * cannot drift silently — a change there fails this schema's parse in tests.
 */
export interface ProposedSkillChangeProvenance {
	v: 1;
	mechanism: 'consensus_mine';
	sourceKnowledgeIds: string[];
	sourceTaskIds: string[];
	sourceEvidenceRefs: string[];
	sourceRunIds: string[];
	sourceModelIds: string[];
	writeOrigin: {
		sessionId?: string;
		agentRole?: string;
		agentId?: string;
		producedAt: string;
	};
}

export const ProposedSkillChangeProvenanceSchema = z
	.object({
		v: z.literal(1),
		mechanism: z.literal('consensus_mine'),
		sourceKnowledgeIds: ReferenceListSchema,
		sourceTaskIds: ReferenceListSchema,
		sourceEvidenceRefs: ReferenceListSchema,
		sourceRunIds: ReferenceListSchema,
		sourceModelIds: ReferenceListSchema,
		writeOrigin: z
			.object({
				sessionId: ReferenceSchema.optional(),
				agentRole: ReferenceSchema.optional(),
				agentId: ReferenceSchema.optional(),
				producedAt: IsoDateSchema,
			})
			.strict(),
	})
	.strict();

export const ProposedSkillChangeSchema = z
	.object({
		target: ReferenceSchema,
		intent: z.string().min(1).max(MAX_CONSENSUS_STATEMENT_CHARS),
		evidenceRefs: ReferenceListSchema,
		counterexampleRefs: ReferenceListSchema,
		confidence: z.number().min(0).max(1),
		expectedMetric: ReferenceSchema,
		validationSelector: z.string().min(1).max(1024),
		fingerprint: z.string().regex(/^lrec_[a-f0-9]{16}$/),
		provenance: ProposedSkillChangeProvenanceSchema,
	})
	.strict();

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** The corpus readers the miner is allowed to draw from. */
export const ConsensusSourceKindSchema = z.enum([
	'evaluation-run',
	'gate-audit',
	'gate-ground-truth',
	'task-trajectory',
	'prm-session',
	'skill-usage',
	'knowledge',
	'evidence-bundle',
]);
export type ConsensusSourceKind = z.infer<typeof ConsensusSourceKindSchema>;

/** Per-source content fingerprint, so a report declares what it actually read. */
export interface ConsensusCorpusHash {
	source: ConsensusSourceKind;
	hash: string;
	observations: number;
}

export const ConsensusCorpusHashSchema = z
	.object({
		source: ConsensusSourceKindSchema,
		hash: Sha256Schema,
		observations: z.number().int().nonnegative(),
	})
	.strict();

/**
 * One immutable mining report under `.swarm/evolution/consensus/<reportId>.json`.
 *
 * `integrityHash` covers every field EXCEPT `integrityHash`, `reportId`, and
 * `generatedAt`. Excluding the wall clock is what makes "same inputs ⇒ identical
 * hash" true; excluding `reportId` lets the id be *derived* from the hash
 * without a circular definition.
 */
export interface ConsensusReportV1 {
	v: 1;
	reportId: string;
	generatedAt: string;
	request: ConsensusMineRequest;
	inputIds: string[];
	corpusHashes: ConsensusCorpusHash[];
	configHash: string;
	integrityHash: string;
	attributes: ConsensusAttributeV1[];
	proposals: ProposedSkillChange[];
	redactionPolicyVersion: number;
}

export const ConsensusReportV1Schema = z
	.object({
		v: z.literal(1),
		reportId: ReferenceSchema,
		generatedAt: IsoDateSchema,
		request: ConsensusMineRequestSchema,
		inputIds: ReferenceListSchema,
		corpusHashes: z.array(ConsensusCorpusHashSchema).max(64),
		configHash: Sha256Schema,
		integrityHash: Sha256Schema,
		attributes: z.array(ConsensusAttributeV1Schema).max(1000),
		proposals: z.array(ProposedSkillChangeSchema).max(1000),
		redactionPolicyVersion: z.number().int().nonnegative(),
	})
	.strict()
	.superRefine((report, ctx) => {
		const attributeIds = new Set(report.attributes.map((a) => a.id));
		if (attributeIds.size !== report.attributes.length) {
			ctx.addIssue({
				code: 'custom',
				path: ['attributes'],
				message: 'report contains duplicate attribute ids',
			});
		}
		const fingerprints = report.proposals.map((p) => p.fingerprint);
		if (new Set(fingerprints).size !== fingerprints.length) {
			ctx.addIssue({
				code: 'custom',
				path: ['proposals'],
				message: 'report contains duplicate proposal fingerprints',
			});
		}
		// An investigation note (`proposedTarget: 'none'`) must never have
		// produced a proposal. Enforced structurally so a miner regression that
		// promotes an anecdote cannot be persisted.
		const noteAttributeIds = new Set(
			report.attributes
				.filter((attribute) => attribute.proposedTarget === 'none')
				.map((attribute) => attribute.id),
		);
		for (const proposal of report.proposals) {
			for (const sourceId of proposal.provenance.sourceEvidenceRefs) {
				if (noteAttributeIds.has(sourceId)) {
					ctx.addIssue({
						code: 'custom',
						path: ['proposals'],
						message:
							'an investigation-note attribute must not produce a proposal',
					});
				}
			}
		}
	});

// ---------------------------------------------------------------------------
// Schema/interface drift guards
// ---------------------------------------------------------------------------

/**
 * Compile-time assertions that each Zod schema's inferred output is assignable
 * to the hand-written interface the issue specified verbatim. A renamed field or
 * a widened type on either side becomes a type error here rather than a runtime
 * surprise at the store boundary.
 */
type AssertAssignable<Actual extends Expected, Expected> = Actual;

export type _ConsensusMineRequestAssignable = AssertAssignable<
	z.infer<typeof ConsensusMineRequestSchema>,
	ConsensusMineRequest
>;
export type _ConsensusAttributeAssignable = AssertAssignable<
	z.infer<typeof ConsensusAttributeV1Schema>,
	ConsensusAttributeV1
>;
export type _ProposedSkillChangeAssignable = AssertAssignable<
	z.infer<typeof ProposedSkillChangeSchema>,
	ProposedSkillChange
>;
export type _ConsensusReportAssignable = AssertAssignable<
	z.infer<typeof ConsensusReportV1Schema>,
	ConsensusReportV1
>;
