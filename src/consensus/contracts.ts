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

/**
 * Upper bound on a rendered statement, and the hard REJECTION bound on an LLM
 * restatement. Model output is never truncated to fit — a half-sentence is
 * exactly how a fragment of reasoning survives a length cut — so an
 * over-long restatement is discarded and the deterministic statement stands.
 */
export const MAX_CONSENSUS_STATEMENT_CHARS = 600;

/**
 * Upper bound on the attribute and proposal arrays of a single report.
 *
 * `MAX_CONSENSUS_ATTRIBUTES` is exported because the PRODUCER must enforce it
 * too: a schema-only cap turns a large `maxEvidenceItems` into a hard
 * `ConsensusReportV1Schema.parse` throw at the end of mining, which means NO
 * report is written at all — the caller loses every finding rather than the tail
 * of a ranked list. `src/consensus/miner.ts` therefore caps first, ranked, and
 * records how many it dropped in `report.truncation`.
 *
 * `MAX_CONSENSUS_PROPOSALS` has no producer-side counterpart, by design: the
 * miner emits at most one proposal per attribute and deduplication only removes,
 * so `proposals.length <= attributes.length <= MAX_CONSENSUS_ATTRIBUTES` holds
 * structurally while the two constants are equal. It is exported so that
 * equality — which the argument depends on — is asserted by a test rather than
 * assumed.
 */
export const MAX_CONSENSUS_ATTRIBUTES = 1000;
export const MAX_CONSENSUS_PROPOSALS = 1000;

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
const ConsensusProposedTargetSchema = z.enum([
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
 * - `statement` is ALWAYS the deterministic rendering of the arithmetic. A model
 *   never replaces it. An optional model restatement lives in `llmSummary`,
 *   which is excluded from the report's integrity hash — see below.
 */
export interface ConsensusAttributeV1 {
	v: 1;
	id: string;
	statement: string;
	/**
	 * Optional LLM restatement of `statement`, admitted only through the miner's
	 * `FINDING:` whitelist: the first `FINDING:` line of one dispatch, carrying no
	 * bracket markup, no forged `[REDACTED:…]` marker, no listed reasoning marker
	 * and — once decimal points and at most one lower-case-continued
	 * abbreviation are masked — at most one sentence-terminator run, within
	 * `MAX_CONSENSUS_STATEMENT_CHARS` and never trimmed to fit. That bounds the
	 * SHAPE and SIZE of what a model can put here; it is not a claim that the
	 * admitted text cannot read as a multi-step narration — a semicolon- or
	 * dash-chained sentence can, and the guard does not stop it. See
	 * `extractRestatement` in `./miner.ts`.
	 *
	 * Separate from `statement`, and **excluded from `integrityHash`**, for one
	 * reason: `llm_summarization_enabled` defaults to `true`, and a model's
	 * wording is not reproducible. Folding it into the hashed content made "same
	 * inputs ⇒ identical hash" false by default, which in turn made `reportId`
	 * non-deterministic and defeated the point of a content-addressed immutable
	 * report. Cosmetic output does not get to move a content address.
	 *
	 * Absent whenever summarization is disabled, unavailable, or rejected by the
	 * restatement guard. Readers should render it as a convenience and treat
	 * `statement` as the authoritative text.
	 */
	llmSummary?: string;
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
		llmSummary: z.string().min(1).max(MAX_CONSENSUS_STATEMENT_CHARS).optional(),
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
	/**
	 * The `ConsensusAttributeV1.id` this proposal was derived from.
	 *
	 * Load-bearing, not decorative. It is what makes a report provenance-auditable
	 * — a reader can point at the exact attribute whose arithmetic produced the
	 * recommendation — and it is what
	 * `ConsensusReportV1Schema`'s investigation-note guard compares against. That
	 * guard previously tested `provenance.sourceEvidenceRefs` (corpus refs, e.g.
	 * `evaluation-run:r1:t1:0`) for membership in the set of attribute ids
	 * (`cattr_<16hex>`). Those namespaces are disjoint, so the check could never
	 * fire on real miner output: it was a guard in name only.
	 */
	sourceAttributeId: string;
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
 * Every `source*` list here is **scoped to the attribute that produced this
 * proposal** (issue #1821 AC23), not to the whole filtered corpus. A proposal
 * that claimed the run, model, and task ids of every observation the miner
 * looked at would be asserting provenance it does not have — and would be
 * indistinguishable from every other proposal in the same report.
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
	/**
	 * Deliberately NARROWER than the shared `LearningWriteOriginSchema`, which
	 * also admits an `agentId`. Nothing on the consensus path can produce one:
	 * `MineConsensusDeps` has no `agentId` field, `buildProposals`'s options bag
	 * has no slot for it, and its `stampLearningProvenance` call passes exactly
	 * `producedAt` / `sessionId` / `agentRole`. Declaring a field no code path can
	 * reach documented a value that never exists, so the schema below — which is
	 * `.strict()` — now rejects it rather than reserving room for it (issue #1821).
	 */
	writeOrigin: {
		sessionId?: string;
		agentRole?: string;
		producedAt: string;
	};
}

const ProposedSkillChangeProvenanceSchema = z
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
				producedAt: IsoDateSchema,
			})
			.strict(),
	})
	.strict();

export const ProposedSkillChangeSchema = z
	.object({
		sourceAttributeId: ReferenceSchema,
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
const ConsensusSourceKindSchema = z.enum([
	'evaluation-run',
	'gate-audit',
	'gate-ground-truth',
	'task-trajectory',
	'prm-session',
	'skill-usage',
	'knowledge',
	'evidence-bundle',
	// The issue's Workstream C names five corpus arms, the fifth being "curated
	// failures". It was missed at intake (recovered as AC28) and is the only
	// source whose every observation is a FAILURE — see `loadCuratedFailures`.
	'curated-failure',
]);
export type ConsensusSourceKind = z.infer<typeof ConsensusSourceKindSchema>;

/** Per-source content fingerprint, so a report declares what it actually read. */
export interface ConsensusCorpusHash {
	source: ConsensusSourceKind;
	hash: string;
	observations: number;
}

const ConsensusCorpusHashSchema = z
	.object({
		source: ConsensusSourceKindSchema,
		hash: Sha256Schema,
		observations: z.number().int().nonnegative(),
	})
	.strict();

/**
 * Everything this report dropped, and why.
 *
 * Persisted rather than returned-only, because every one of these cuts changes
 * what the report *means*. A reader who cannot tell that the corpus was capped
 * cannot tell whether `failureSupport: 0` means "nothing failed" or "the
 * failures were truncated away", and a reader who cannot see that the attribute
 * array was capped will read a partial list as a complete one. Silence here is
 * the difference between an incomplete report and a misleading one.
 */
export interface ConsensusTruncationV1 {
	/** `maxEvidenceItems` cut the corpus before tallying. */
	corpus: boolean;
	/** Observations actually tallied, after filtering and after the corpus cut. */
	observations: number;
	/** `inputIds` was cut at `MAX_CONSENSUS_REFS`. */
	inputIds: boolean;
	/** Distinct run ids in the filtered corpus, before the `inputIds` cut. */
	totalInputIds: number;
	/**
	 * Attributes dropped by the producer-side `MAX_CONSENSUS_ATTRIBUTES` cap.
	 *
	 * There is deliberately no `proposalsDropped` counterpart. The miner emits at
	 * most one proposal per attribute and deduplication only removes, so
	 * `proposals.length <= attributes.length <= MAX_CONSENSUS_ATTRIBUTES`, and
	 * `MAX_CONSENSUS_PROPOSALS` equals `MAX_CONSENSUS_ATTRIBUTES`. A producer-side
	 * proposal cap would therefore be an unreachable branch reporting a
	 * permanently-zero count, which is worse than not having one.
	 */
	attributesDropped: number;
}

const ConsensusTruncationV1Schema = z
	.object({
		corpus: z.boolean(),
		observations: z.number().int().nonnegative(),
		inputIds: z.boolean(),
		totalInputIds: z.number().int().nonnegative(),
		attributesDropped: z.number().int().nonnegative(),
	})
	.strict();

/**
 * One immutable mining report under `.swarm/evolution/consensus/<reportId>.json`.
 *
 * `integrityHash` covers every field EXCEPT `integrityHash`, `reportId`,
 * `generatedAt`, each proposal's ENTIRE `provenance.writeOrigin` — `producedAt`
 * *and* the `sessionId` / `agentRole`, which are the only three fields this
 * path can populate — and each attribute's
 * `llmSummary`. Each exclusion has its own reason: `integrityHash` cannot cover
 * itself and `reportId` is derived from it, so both would be circular;
 * `generatedAt` and `producedAt` are wall clocks; the `writeOrigin` identity
 * fields say *who* ran the mine, which must not be able to change what the mine
 * found (`sessionId` comes from `ctx.sessionID`, so while it was hashed two
 * sessions mining a byte-identical corpus produced two different reports); and
 * `llmSummary` is non-reproducible model prose that `llm_summarization_enabled`
 * turns on by default, so hashing it would make "same inputs ⇒ identical hash"
 * false in the default configuration. See `computeConsensusIntegrityHash`.
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
	truncation: ConsensusTruncationV1;
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
		attributes: z
			.array(ConsensusAttributeV1Schema)
			.max(MAX_CONSENSUS_ATTRIBUTES),
		proposals: z.array(ProposedSkillChangeSchema).max(MAX_CONSENSUS_PROPOSALS),
		truncation: ConsensusTruncationV1Schema,
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
		// Every proposal must name an attribute that is actually in this report,
		// and that attribute must not be an investigation note.
		//
		// The membership half is what makes the report auditable at all: a
		// `sourceAttributeId` pointing at nothing is a recommendation with no
		// derivation. The note half is the structural guarantee that a miner
		// regression promoting an anecdote (`proposedTarget: 'none'`) into a
		// proposal cannot be persisted. Both compare attribute id to attribute id —
		// the previous version compared corpus evidence refs against attribute ids,
		// two disjoint namespaces, so it could never fire.
		const attributesById = new Map(
			report.attributes.map((attribute) => [attribute.id, attribute]),
		);
		for (const proposal of report.proposals) {
			const source = attributesById.get(proposal.sourceAttributeId);
			if (!source) {
				ctx.addIssue({
					code: 'custom',
					path: ['proposals'],
					message: `proposal references attribute ${proposal.sourceAttributeId}, which is not in this report`,
				});
				continue;
			}
			if (source.proposedTarget === 'none') {
				ctx.addIssue({
					code: 'custom',
					path: ['proposals'],
					message:
						'an investigation-note attribute must not produce a proposal',
				});
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
 *
 * These four are `export`ed with no importer ON PURPOSE. They are type-level
 * assertions, not API: the `export` is what keeps them from reading as unused
 * locals, and they are erased entirely at build time.
 *
 * ## Declared export carve-out for the whole subsystem
 *
 * The carve-out covers TYPES ONLY, and that boundary is the whole point. Every
 * runtime VALUE `src/consensus/` exports — every schema, constant, function,
 * and error class — has a by-name importer, in a sibling module or a test.
 * `ProposedSkillChangeSchema` was the one exception and is no longer one:
 * `tests/unit/consensus/contracts-proposal.test.ts` exercises the bounds the
 * miner mirrors (the `lrec_<16hex>` fingerprint shape and the 1024-character
 * `validationSelector` cap), which is coverage the embedding
 * `ConsensusReportV1Schema` tests did not provide. A value export with no
 * importer is unwired code, not a carve-out candidate — that is exactly why the
 * `consensusV1` namespace and the `index.ts` barrel were deleted.
 *
 * Those four assertions are, however, not the only exported TYPES with no
 * by-name importer. Eight more have none either:
 *
 * - `KnowledgeLike` and `LoadCorpusOptions` (`./corpus.ts`)
 * - `MineConsensusResult` and `ConsensusReportIntegrityInput` (`./miner.ts`)
 * - `MineAndStoreConsensusOptions` / `MineAndStoreConsensusResult`
 *   (`./public-api.ts`)
 * - `ConsensusListSummary` and `ConsensusPruneResult` (`./store.ts`)
 *
 * They stay exported because every one is the declared parameter or return
 * shape of an exported function (`loadConsensusCorpus`, `mineConsensus`,
 * `computeConsensusIntegrityHash`, `mineAndStoreConsensusV1`,
 * `listConsensusReports`, `pruneConsensusReports`) or a field type of an
 * exported interface (`CorpusReaders`). A caller cannot annotate a variable
 * holding one of those results without them, and hiding them would break
 * `declaration`-emitting builds. Deleting a type that an exported signature
 * already hands out removes a name, not a surface — and unlike a value, it is
 * erased at build time, so it ships nothing.
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
