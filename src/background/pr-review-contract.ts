import { createHash } from 'node:crypto';
import { type ZodIssue, z } from 'zod';

export const PR_REVIEW_REVIEWER_CLASSIFICATIONS = [
	'CONFIRMED',
	'DISPROVED',
	'UNVERIFIED',
	'PRE_EXISTING',
] as const;
export const PR_REVIEW_REVIEWER_EVIDENCE_TYPES = [
	'STRUCTURALLY_PROVEN',
	'EXECUTION_PROVEN',
	'STATIC_TRACE_PROVEN',
	'PLAUSIBLE_BUT_UNVERIFIED',
] as const;
export const PR_REVIEW_SEVERITIES = [
	'CRITICAL',
	'HIGH',
	'MEDIUM',
	'LOW',
	'INFO',
	'NONE',
] as const;
export const PR_REVIEW_CRITIC_STATUSES = [
	'UPHELD',
	'DOWNGRADED',
	'DISPROVED',
	'NEEDS_MORE_EVIDENCE',
] as const;
export const PR_REVIEW_FINDING_STATUSES = [
	'PENDING',
	'CONFIRMED',
	'DISPROVED',
	'PRE_EXISTING',
] as const;
export const PR_REVIEW_FINDING_ACTIONS = [
	'route_to_reviewer',
	'route_to_critic',
	'report',
	'suppress_with_reason',
	'handoff_to_feedback',
] as const;
export const PR_REVIEW_ARTIFACT_BOUNDARIES = [
	'post_explorer',
	'post_reviewer',
	'post_critic',
] as const;

/**
 * The six canonical PR-review base dimensions (issue #2383).
 *
 * Single source of truth: this contract module owns the list; the workflow
 * gate re-exports it. No other file may define the literal (guarded by a
 * source-scan test).
 */
export const PR_REVIEW_BASE_DIMENSION_IDS = [
	'intent-architecture',
	'correctness-state',
	'tests-falsifiability',
	'security-trust',
	'reliability-performance',
	'compatibility-delivery',
] as const;

export type PrReviewBaseDimensionId =
	(typeof PR_REVIEW_BASE_DIMENSION_IDS)[number];

/** Typed risk-impact classification for critic routing (issue #2383). */
export const PR_REVIEW_RISK_IMPACTS = [
	'ORDINARY',
	'HIGH_IMPACT',
	'UNKNOWN',
] as const;

export type PrReviewRiskImpact = (typeof PR_REVIEW_RISK_IMPACTS)[number];

/**
 * Typed risk tags for critic routing (issue #2383). Presence of ANY tag on a
 * MEDIUM finding routes it to critic; paths, dimensions, keywords, and prompt
 * prose may suggest risk to the model but can never override the typed result.
 */
export const PR_REVIEW_RISK_TAGS = [
	'SECURITY',
	'AUTH_PERMISSIONS',
	'STATE_INTEGRITY',
	'WRITE_PATH',
	'EVIDENCE_INTEGRITY',
	'GIT',
	'CONFIGURATION',
] as const;

export type PrReviewRiskTag = (typeof PR_REVIEW_RISK_TAGS)[number];

export const PR_REVIEW_RESULT_LANE_MODES = [
	'swarm-pr-review:base',
	'swarm-pr-review:micro',
] as const;
export const PR_REVIEW_RESULT_OUTCOMES = [
	'CLEAN',
	'FINDINGS',
	'INCOMPLETE',
] as const;
export const PR_REVIEW_RESULT_FINDING_SEVERITIES = [
	'CRITICAL',
	'HIGH',
	'MEDIUM',
	'LOW',
	'INFO',
] as const;
export const PR_REVIEW_RESULT_UNRESOLVED_REASONS = [
	'NOT_EXECUTED',
	'PARTIAL_OUTPUT',
	'CONTRACT_FAILURE',
	'RESOURCE_LIMIT',
	'DEADLINE_EXCEEDED',
	'STALE_BINDING',
	'PARENT_CANCELLED',
] as const;
export const MAX_PR_REVIEW_RESULT_OWNED_LANES = 11;
export const MAX_PR_REVIEW_RESULT_FINDINGS = 256;
export const MAX_PR_REVIEW_RESULT_RECEIPT_BYTES = 64 * 1024;

export type PrReviewResultLaneMode =
	(typeof PR_REVIEW_RESULT_LANE_MODES)[number];
export type PrReviewResultOutcome = (typeof PR_REVIEW_RESULT_OUTCOMES)[number];
export type PrReviewResultFindingSeverity =
	(typeof PR_REVIEW_RESULT_FINDING_SEVERITIES)[number];
export type PrReviewResultUnresolvedReason =
	(typeof PR_REVIEW_RESULT_UNRESOLVED_REASONS)[number];

export function prReviewLegacyTranscriptCompatibilityEnabled(
	value: boolean | undefined,
): boolean {
	return value === true;
}

const PrReviewResultLaneIdSchema = z.string().trim().min(1).max(120);
const PrReviewResultChildSessionSchema = z.string().trim().min(1).max(256);
const PrReviewResultShaSchema = z
	.string()
	.trim()
	.regex(/^[0-9a-f]{6,64}$/i);
const PrReviewResultDigestSchema = z
	.string()
	.trim()
	.regex(/^[0-9a-f]{64}$/i);

function addDuplicateIssue(
	ctx: z.RefinementCtx,
	path: (string | number)[],
	label: string,
	value: string,
): void {
	ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path,
		message: `${label} must not contain duplicate value "${value}"`,
	});
}

function assertUniqueStrings(
	values: readonly string[],
	ctx: z.RefinementCtx,
	path: (string | number)[],
	label: string,
): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) {
			addDuplicateIssue(ctx, path, label, value);
			return;
		}
		seen.add(value);
	}
}

export const PrReviewResultLocationSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('local'),
			file: z.string().trim().min(1).max(4_096),
			line: z.number().int().positive().max(1_000_000).optional(),
			endLine: z.number().int().positive().max(1_000_000).optional(),
			column: z.number().int().positive().max(10_000).optional(),
			endColumn: z.number().int().positive().max(10_000).optional(),
		})
		.strict()
		.superRefine((value, ctx) => {
			if (
				value.endLine !== undefined &&
				value.line !== undefined &&
				value.endLine < value.line
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['endLine'],
					message: 'endLine must be greater than or equal to line',
				});
			}
			if (
				value.endColumn !== undefined &&
				value.column !== undefined &&
				value.endColumn < value.column
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['endColumn'],
					message: 'endColumn must be greater than or equal to column',
				});
			}
		}),
	z
		.object({
			kind: z.literal('non_local'),
			label: z.string().trim().min(1).max(200),
			detail: z.string().trim().min(1).max(2_000),
		})
		.strict(),
]);

export type PrReviewResultLocation = z.infer<
	typeof PrReviewResultLocationSchema
>;

export const PrReviewResultFindingSchema = z
	.object({
		id: z.string().trim().min(1).max(128),
		workflowLane: PrReviewResultLaneIdSchema,
		severity: z.enum(PR_REVIEW_RESULT_FINDING_SEVERITIES),
		riskImpact: z.enum(PR_REVIEW_RISK_IMPACTS),
		riskTags: z
			.array(z.enum(PR_REVIEW_RISK_TAGS))
			.max(PR_REVIEW_RISK_TAGS.length),
		title: z.string().trim().min(1).max(200),
		body: z.string().trim().min(1).max(4_000),
		evidence: z.string().trim().min(1).max(4_000),
		location: PrReviewResultLocationSchema,
	})
	.strict()
	.superRefine((value, ctx) => {
		assertUniqueStrings(value.riskTags, ctx, ['riskTags'], 'riskTags');
	});

export type PrReviewResultFinding = z.infer<typeof PrReviewResultFindingSchema>;

export const PrReviewCleanAttestationSchema = z
	.object({
		workflowLane: PrReviewResultLaneIdSchema,
		coverageScope: z.string().trim().min(12).max(2_000),
		evidence: z.string().trim().min(20).max(4_000),
	})
	.strict();

export type PrReviewCleanAttestation = z.infer<
	typeof PrReviewCleanAttestationSchema
>;

export const PrReviewUnresolvedLaneSchema = z
	.object({
		workflowLane: PrReviewResultLaneIdSchema,
		reason: z.enum(PR_REVIEW_RESULT_UNRESOLVED_REASONS),
		detail: z.string().trim().min(1).max(4_000),
	})
	.strict();

export type PrReviewUnresolvedLane = z.infer<
	typeof PrReviewUnresolvedLaneSchema
>;

export const PrReviewLaneResultEnvelopeSchema = z
	.object({
		schemaVersion: z.literal(1),
		outcome: z.enum(PR_REVIEW_RESULT_OUTCOMES),
		creditedLanes: z
			.array(PrReviewResultLaneIdSchema)
			.max(MAX_PR_REVIEW_RESULT_OWNED_LANES),
		findings: z
			.array(PrReviewResultFindingSchema)
			.max(MAX_PR_REVIEW_RESULT_FINDINGS),
		cleanAttestations: z
			.array(PrReviewCleanAttestationSchema)
			.max(MAX_PR_REVIEW_RESULT_OWNED_LANES),
		unresolved: z
			.array(PrReviewUnresolvedLaneSchema)
			.max(MAX_PR_REVIEW_RESULT_OWNED_LANES),
	})
	.strict()
	.superRefine((value, ctx) => {
		assertUniqueStrings(
			value.creditedLanes,
			ctx,
			['creditedLanes'],
			'creditedLanes',
		);
		const findingIds = value.findings.map((finding) => finding.id);
		assertUniqueStrings(findingIds, ctx, ['findings'], 'findings');
		const findingLanes = value.findings.map((finding) => finding.workflowLane);
		assertUniqueStrings(
			value.cleanAttestations.map((entry) => entry.workflowLane),
			ctx,
			['cleanAttestations'],
			'cleanAttestations',
		);
		assertUniqueStrings(
			value.unresolved.map((entry) => entry.workflowLane),
			ctx,
			['unresolved'],
			'unresolved',
		);
		for (const lane of findingLanes) {
			if (
				value.cleanAttestations.some((entry) => entry.workflowLane === lane)
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['findings'],
					message: `workflow lane "${lane}" cannot be both CLEAN and FINDINGS`,
				});
				return;
			}
		}
		const coveredLanes = new Set<string>([
			...findingLanes,
			...value.cleanAttestations.map((entry) => entry.workflowLane),
		]);
		for (const lane of value.creditedLanes) {
			if (!coveredLanes.has(lane)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['creditedLanes'],
					message: `credited workflow lane "${lane}" must be backed by a finding or CLEAN attestation`,
				});
				return;
			}
		}
		for (const lane of coveredLanes) {
			if (!value.creditedLanes.includes(lane)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['creditedLanes'],
					message: `covered workflow lane "${lane}" must appear in creditedLanes`,
				});
				return;
			}
		}
		for (const lane of value.unresolved.map((entry) => entry.workflowLane)) {
			if (coveredLanes.has(lane)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['unresolved'],
					message: `workflow lane "${lane}" cannot be both credited and unresolved`,
				});
				return;
			}
		}
		const totalCovered = value.creditedLanes.length + value.unresolved.length;
		if (totalCovered === 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['creditedLanes'],
				message: 'result envelope must cover at least one workflow lane',
			});
			return;
		}
		if (value.outcome === 'CLEAN') {
			if (value.findings.length > 0 || value.unresolved.length > 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['outcome'],
					message: 'CLEAN outcome cannot include findings or unresolved lanes',
				});
			}
			if (value.cleanAttestations.length !== value.creditedLanes.length) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['cleanAttestations'],
					message:
						'CLEAN outcome must attest every credited workflow lane exactly once',
				});
			}
		}
		if (value.outcome === 'FINDINGS') {
			if (value.findings.length === 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['findings'],
					message: 'FINDINGS outcome requires at least one finding',
				});
			}
			if (value.unresolved.length > 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['unresolved'],
					message: 'FINDINGS outcome cannot include unresolved lanes',
				});
			}
		}
		if (value.outcome === 'INCOMPLETE' && value.unresolved.length === 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['unresolved'],
				message: 'INCOMPLETE outcome requires at least one unresolved lane',
			});
		}
	});

export type PrReviewLaneResultEnvelope = z.infer<
	typeof PrReviewLaneResultEnvelopeSchema
>;

export function serializedPrReviewResultReceiptBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function prReviewLaneResultEnvelopeDigest(
	value: PrReviewLaneResultEnvelope,
): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export const PrReviewResultReceiptSchema = z
	.object({
		schemaVersion: z.literal(1),
		mode: z.enum(PR_REVIEW_RESULT_LANE_MODES),
		workflowInstanceId: z.string().trim().min(1).max(256),
		workflowRevision: z.number().int().nonnegative(),
		batchId: z.string().trim().min(1).max(120),
		laneId: z.string().trim().min(1).max(120),
		workflowLane: PrReviewResultLaneIdSchema,
		ownedWorkflowLanes: z
			.array(PrReviewResultLaneIdSchema)
			.min(1)
			.max(MAX_PR_REVIEW_RESULT_OWNED_LANES),
		baseSha: PrReviewResultShaSchema,
		headSha: PrReviewResultShaSchema,
		dispatchRevisionDigest: PrReviewResultDigestSchema,
		childSessionId: PrReviewResultChildSessionSchema,
		generation: z.number().int().positive().max(1_000_000),
		semanticEnvelopeDigest: PrReviewResultDigestSchema,
		envelope: PrReviewLaneResultEnvelopeSchema,
	})
	.strict()
	.superRefine((value, ctx) => {
		assertUniqueStrings(
			value.ownedWorkflowLanes,
			ctx,
			['ownedWorkflowLanes'],
			'ownedWorkflowLanes',
		);
		if (!value.ownedWorkflowLanes.includes(value.workflowLane)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['workflowLane'],
				message: 'workflowLane must be included in ownedWorkflowLanes',
			});
		}
		const covered = new Set<string>([
			...value.envelope.creditedLanes,
			...value.envelope.unresolved.map((entry) => entry.workflowLane),
		]);
		if (covered.size !== value.ownedWorkflowLanes.length) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['envelope'],
				message:
					'envelope credited and unresolved workflow lanes must exactly partition ownedWorkflowLanes',
			});
			return;
		}
		for (const lane of value.ownedWorkflowLanes) {
			if (!covered.has(lane)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['ownedWorkflowLanes'],
					message: `owned workflow lane "${lane}" is missing from the envelope coverage`,
				});
				return;
			}
		}
		const expectedDigest = prReviewLaneResultEnvelopeDigest(value.envelope);
		if (value.semanticEnvelopeDigest !== expectedDigest) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['semanticEnvelopeDigest'],
				message:
					'semanticEnvelopeDigest must match the canonical envelope digest',
			});
		}
		const bytes = serializedPrReviewResultReceiptBytes(value);
		if (bytes > MAX_PR_REVIEW_RESULT_RECEIPT_BYTES) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: [],
				message: `receipt exceeds the ${MAX_PR_REVIEW_RESULT_RECEIPT_BYTES}-byte bound`,
			});
		}
	});

export type PrReviewResultReceipt = z.infer<typeof PrReviewResultReceiptSchema>;

export const PR_REVIEW_CONTRACT_CARD_HEADER = '[PR-REVIEW CONTRACT CARD]';
export const PR_REVIEW_FINDINGS_MAX_BYTES = 10 * 1024 * 1024;
export const PR_REVIEW_FINDINGS_WRITE_MAX_BYTES = 3 * 1024 * 1024;
export const PR_REVIEW_HANDOFF_MAX_BYTES = 128 * 1024;
export const PR_REVIEW_HANDOFF_WRITE_MAX_BYTES = 120 * 1024;
export const PR_REVIEW_DISCARDED_EXAMPLE_ITEM_ID = 'discarded-id';

export function serializedPrReviewArtifactInputBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export const PrReviewRunIdSchema = z
	.string()
	.regex(
		/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
		'run_id must be a safe relative identifier',
	);

export const PrReviewFindingSchema = z
	.object({
		finding_id: z.string().trim().min(1).max(128),
		status: z.enum(PR_REVIEW_FINDING_STATUSES),
		file_line: z.string().trim().min(1).max(1000),
		evidence: z.string().trim().min(1).max(20_000),
		next_action: z.enum(PR_REVIEW_FINDING_ACTIONS),
		severity: z.enum(PR_REVIEW_SEVERITIES).optional(),
		category: z.string().trim().min(1).max(128).optional(),
		/**
		 * Typed risk metadata (issue #2383). Required on every NEWLY written
		 * CONFIRMED finding; optional elsewhere. Legacy persisted rows missing
		 * these fields are normalized to `UNKNOWN` / `[]` at the single
		 * read/migration boundary (`readFindings`), which fail-safely routes
		 * them to critic review.
		 */
		risk_impact: z.enum(PR_REVIEW_RISK_IMPACTS).optional(),
		risk_tags: z
			.array(z.enum(PR_REVIEW_RISK_TAGS))
			.max(PR_REVIEW_RISK_TAGS.length)
			.optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.status !== 'CONFIRMED') return;
		if (value.risk_impact === undefined) {
			ctx.addIssue({
				code: 'custom',
				path: ['risk_impact'],
				message:
					'is required on every newly written CONFIRMED finding (issue #2383 typed critic routing)',
			});
		}
		if (value.risk_tags === undefined) {
			ctx.addIssue({
				code: 'custom',
				path: ['risk_tags'],
				message:
					'is required on every newly written CONFIRMED finding (issue #2383 typed critic routing)',
			});
		}
	});

// Issue #2385: the predicate and its input type moved canonically to
// `src/pr-review/critic-routing.ts` (the single-routing-authority boundary).
// Re-exported here so every existing consumer keeps one import path; there is
// still exactly ONE definition.
export {
	prReviewFindingRequiresCritic,
	type PrReviewCriticRoutingInput,
} from '../pr-review/critic-routing.js';

export const PrReviewHandoffSchema = z
	.object({
		pr_url: z.string().url().max(2000),
		finding_ids: z.array(z.string().trim().min(1).max(128)).min(1).max(1000),
		summary: z.string().trim().min(1).max(20_000),
		provenance: z.array(z.string().trim().min(1).max(4000)).min(1).max(1000),
	})
	.strict();

/**
 * Terminal N-of-6 settlement disclosure input (issue #2383).
 *
 * The controller declares the set of dimensions it believes are unresolved;
 * the gate derives each dimension's terminal state from lane evidence and
 * rejects any declaration that does not exactly match. New writers emit ONLY
 * this array shape; the persisted disclosure record additionally carries the
 * gate-derived per-dimension terminal states (versioned v2).
 */
export const PrReviewPartialBaseCoverageSchema = z
	.object({
		unresolved_dimensions: z
			.array(z.enum(PR_REVIEW_BASE_DIMENSION_IDS))
			.min(1)
			.max(PR_REVIEW_BASE_DIMENSION_IDS.length),
	})
	.strict()
	.superRefine((value, ctx) => {
		const seen = new Set<string>();
		for (const dimension of value.unresolved_dimensions) {
			if (seen.has(dimension)) {
				ctx.addIssue({
					code: 'custom',
					path: ['unresolved_dimensions'],
					message: `must not contain duplicate dimension "${dimension}"`,
				});
				return;
			}
			seen.add(dimension);
		}
	});

export const WritePrReviewArtifactArgsSchema = z
	.discriminatedUnion('kind', [
		z
			.object({
				kind: z.literal('findings'),
				run_id: PrReviewRunIdSchema.optional(),
				pr_head_sha: z
					.string()
					.trim()
					.regex(/^[0-9a-f]{6,64}$/i),
				boundary: z.enum(PR_REVIEW_ARTIFACT_BOUNDARIES),
				records: z.array(PrReviewFindingSchema).min(1).max(1000),
				partial_base_coverage: PrReviewPartialBaseCoverageSchema.optional(),
			})
			.strict(),
		z
			.object({
				kind: z.literal('handoff'),
				run_id: PrReviewRunIdSchema.optional(),
				pr_head_sha: z
					.string()
					.trim()
					.regex(/^[0-9a-f]{6,64}$/i),
				handoff: PrReviewHandoffSchema,
			})
			.strict(),
	])
	.superRefine((value, ctx) => {
		if (
			value.kind === 'findings' &&
			value.partial_base_coverage !== undefined &&
			value.boundary !== 'post_explorer'
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['partial_base_coverage'],
				message: 'is valid only for the post_explorer boundary',
			});
		}
		const bytes = serializedPrReviewArtifactInputBytes(value);
		const maxBytes =
			value.kind === 'findings'
				? PR_REVIEW_FINDINGS_WRITE_MAX_BYTES
				: PR_REVIEW_HANDOFF_WRITE_MAX_BYTES;
		if (bytes > maxBytes) {
			ctx.addIssue({
				code: 'custom',
				path: [value.kind === 'findings' ? 'records' : 'handoff'],
				message: `serialized UTF-8 payload must be at most ${maxBytes} bytes (got ${bytes})`,
			});
		}
	});

export type PrReviewVerdictKind = 'reviewer' | 'critic';

export interface PrReviewVerdictDescriptor {
	marker: '[REVIEWED]' | '[CRITIC]';
	fieldCount: number;
	fieldRoles: readonly string[];
	schema: z.ZodType<readonly string[]>;
}

const introducedByPrSchema = z
	.string()
	.regex(/^(?:introduced_by_pr\s*:\s*)?(?:YES|NO|UNKNOWN)$/i);

/**
 * Wire format of `risk_tags` inside a verdict row: comma-separated subset of
 * the canonical tags, or empty for "no tags". Pipes remain the field
 * delimiter, so a comma never needs escaping.
 */
const PrReviewRiskTagsFieldPattern = new RegExp(
	`^(?:(?:${PR_REVIEW_RISK_TAGS.join('|')})(?:,(?:${PR_REVIEW_RISK_TAGS.join('|')}))*)?$`,
);

const PrReviewRiskTagsFieldSchema = z
	.string()
	.regex(
		PrReviewRiskTagsFieldPattern,
		`must be a comma-separated subset of the canonical risk tags (${PR_REVIEW_RISK_TAGS.join(', ')}), or empty`,
	);

/** Field count of pre-#2383 reviewer rows, which lack the two risk fields. */
export const PR_REVIEW_REVIEWER_LEGACY_FIELD_COUNT = 10;

export function parsePrReviewRiskTagsField(field: string): PrReviewRiskTag[] {
	const trimmed = field.trim();
	if (!trimmed) return [];
	return trimmed.split(',').map((tag) => tag.trim()) as PrReviewRiskTag[];
}

export function encodePrReviewRiskTagsField(
	tags: readonly PrReviewRiskTag[],
): string {
	return [...tags].join(',');
}

export const PrReviewReviewerVerdictFieldsSchema = z
	.tuple([
		z.literal('[REVIEWED]'),
		z.string().min(1),
		z.enum(PR_REVIEW_REVIEWER_CLASSIFICATIONS),
		z.enum(PR_REVIEW_REVIEWER_EVIDENCE_TYPES),
		z.enum(PR_REVIEW_SEVERITIES),
		introducedByPrSchema,
		z.string().min(1),
		z.string().min(8),
		z.string().min(5),
		z.string().min(3),
		z.enum(PR_REVIEW_RISK_IMPACTS),
		PrReviewRiskTagsFieldSchema,
	])
	.superRefine((fields, ctx) => {
		if (fields[2] === 'DISPROVED' && fields[4] !== 'NONE') {
			ctx.addIssue({
				code: 'custom',
				path: [4],
				message: 'DISPROVED reviewer severity must be NONE',
			});
		}
	});

export const PrReviewCriticVerdictFieldsSchema = z
	.tuple([
		z.literal('[CRITIC]'),
		z.string().min(1),
		z.enum(PR_REVIEW_CRITIC_STATUSES),
		z.enum(PR_REVIEW_SEVERITIES),
		z.string().min(6),
		z.string().min(6),
	])
	.superRefine((fields, ctx) => {
		const status = fields[2];
		const severity = fields[3];
		if (status === 'NEEDS_MORE_EVIDENCE') {
			ctx.addIssue({
				code: 'custom',
				path: [2],
				message: 'NEEDS_MORE_EVIDENCE is not a terminal transport verdict',
			});
		}
		if (status === 'DISPROVED' && severity !== 'NONE') {
			ctx.addIssue({
				code: 'custom',
				path: [3],
				message: 'DISPROVED critic severity must be NONE',
			});
		}
		if (
			status === 'UPHELD' &&
			!(['CRITICAL', 'HIGH', 'MEDIUM'] as const).includes(
				severity as 'CRITICAL' | 'HIGH' | 'MEDIUM',
			)
		) {
			ctx.addIssue({
				code: 'custom',
				path: [3],
				message: 'UPHELD critic severity must be CRITICAL, HIGH, or MEDIUM',
			});
		}
		if (status === 'DOWNGRADED' && severity === 'CRITICAL') {
			ctx.addIssue({
				code: 'custom',
				path: [3],
				message: 'DOWNGRADED critic severity cannot be CRITICAL',
			});
		}
	});

export const PR_REVIEW_VERDICT_ROW_DESCRIPTORS: Record<
	PrReviewVerdictKind,
	PrReviewVerdictDescriptor
> = {
	reviewer: {
		marker: '[REVIEWED]',
		fieldCount: 12,
		fieldRoles: [
			'marker',
			'item_id',
			'classification',
			'evidence_type',
			'severity',
			'introduced_by_pr',
			'file:line',
			'rationale',
			'probe',
			'reviewer_notes',
			'risk_impact',
			'risk_tags',
		],
		schema: PrReviewReviewerVerdictFieldsSchema,
	},
	critic: {
		marker: '[CRITIC]',
		fieldCount: 6,
		fieldRoles: [
			'marker',
			'item_id',
			'status',
			'severity',
			'rationale',
			'required_change',
		],
		schema: PrReviewCriticVerdictFieldsSchema,
	},
};

export type PrReviewVerdictOverflowClass =
	| 'canonical'
	| 'legacy-fidelity-safe'
	| 'legacy-lossy';

export interface ParsedPrReviewVerdictRow {
	marker: string;
	fields: string[];
	overflowClass: PrReviewVerdictOverflowClass;
	recoveredOverflow: boolean;
}

function quoted(value: string): string {
	return `"${value}"`;
}

function formatEnum(values: readonly string[]): string {
	return values.map((value) => quoted(value)).join(' | ');
}

function getPathValue(input: unknown, path: readonly PropertyKey[]): unknown {
	let current = input;
	for (const segment of path) {
		if (current === null || current === undefined) return undefined;
		if (typeof segment === 'number') {
			if (!Array.isArray(current)) return undefined;
			current = current[segment];
			continue;
		}
		if (typeof segment === 'symbol' || typeof current !== 'object')
			return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function formatActualValue(value: unknown): string {
	if (value === undefined) return '(omitted)';
	if (typeof value === 'string') return quoted(value);
	try {
		const json = JSON.stringify(value);
		if (!json) return String(value);
		return json.length <= 160 ? json : `${json.slice(0, 157)}...`;
	} catch {
		return String(value);
	}
}

function formatIssueExpected(issue: ZodIssue): string {
	if (issue.code === 'invalid_value' && 'values' in issue) {
		return formatEnum((issue as ZodIssue & { values: string[] }).values);
	}
	if (issue.code === 'invalid_type') {
		return `${issue.expected}`;
	}
	if (issue.code === 'too_small' && issue.minimum === 1) {
		return 'a non-empty value';
	}
	return issue.message;
}

export function formatPrReviewValidationIssues(
	issues: readonly ZodIssue[],
	input: unknown,
): string[] {
	const rendered: string[] = [];
	for (const issue of issues) {
		if (issue.code === 'unrecognized_keys') {
			const parent = getPathValue(input, issue.path);
			for (const key of issue.keys) {
				const parentPath = issue.path.map(String);
				const value =
					parent && typeof parent === 'object'
						? (parent as Record<string, unknown>)[key]
						: undefined;
				rendered.push(
					`field ${[...parentPath, key].join('.')}: expected no unknown key, got ${formatActualValue(value)}`,
				);
			}
			continue;
		}
		const path =
			issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
		rendered.push(
			`field ${path}: expected ${formatIssueExpected(issue)}, got ${formatActualValue(
				getPathValue(input, issue.path),
			)}`,
		);
	}
	return rendered;
}

export function buildPrReviewContractCard(): string {
	const reviewer = PR_REVIEW_VERDICT_ROW_DESCRIPTORS.reviewer;
	const critic = PR_REVIEW_VERDICT_ROW_DESCRIPTORS.critic;
	const positiveReviewer = encodePrReviewVerdictRow('reviewer', [
		reviewer.marker,
		'C-1',
		'CONFIRMED',
		'STRUCTURALLY_PROVEN',
		'HIGH',
		'YES',
		'src/index.ts:1',
		'rationale with | pipe',
		'probe with \\ backslash',
		'reviewer notes',
		'HIGH_IMPACT',
		'SECURITY,GIT',
	]);
	const positiveCritic = encodePrReviewVerdictRow('critic', [
		critic.marker,
		'C-1',
		'UPHELD',
		'HIGH',
		'rationale with\nline break',
		'required change with\rcarriage return',
	]);
	const discardedReviewer = encodePrReviewVerdictRow('reviewer', [
		reviewer.marker,
		PR_REVIEW_DISCARDED_EXAMPLE_ITEM_ID,
		'DISPROVED',
		'STRUCTURALLY_PROVEN',
		'NONE',
		'YES',
		'src/example.ts:1',
		'illustrative only',
		'not routable',
		'not routable',
		'ORDINARY',
		'',
	]);
	const discardedCritic = encodePrReviewVerdictRow('critic', [
		critic.marker,
		PR_REVIEW_DISCARDED_EXAMPLE_ITEM_ID,
		'DISPROVED',
		'NONE',
		'illustrative only',
		'not routable',
	]);
	return [
		PR_REVIEW_CONTRACT_CARD_HEADER,
		'Live markers:',
		`REVIEWED row: ${reviewer.fieldRoles.map((role, index) => (index === 0 ? reviewer.marker : role)).join(' | ')}`,
		`REVIEWED classifications: ${PR_REVIEW_REVIEWER_CLASSIFICATIONS.join(', ')}`,
		`REVIEWED evidence types: ${PR_REVIEW_REVIEWER_EVIDENCE_TYPES.join(', ')}`,
		`REVIEWED severities: ${PR_REVIEW_SEVERITIES.join(', ')}`,
		`REVIEWED risk impacts: ${PR_REVIEW_RISK_IMPACTS.join(', ')}`,
		`REVIEWED risk tags (comma-separated subset or empty): ${PR_REVIEW_RISK_TAGS.join(', ')}`,
		`CRITIC row: ${critic.fieldRoles.map((role, index) => (index === 0 ? critic.marker : role)).join(' | ')}`,
		`CRITIC statuses: ${PR_REVIEW_CRITIC_STATUSES.join(', ')}`,
		`CRITIC severities: ${PR_REVIEW_SEVERITIES.join(', ')}`,
		'Escapes inside free-text fields only: \\\\ => backslash, \\| => literal pipe, \\n => newline, \\r => carriage return',
		'Literal backslash before a real delimiter must be written as \\\\| (backslash, then delimiter).',
		'DISCOVERY and FEEDBACK rows keep their existing row grammars; this card governs REVIEWED and CRITIC rows only.',
		`Positive REVIEWED example: ${positiveReviewer}`,
		`Positive CRITIC example: ${positiveCritic}`,
		`DISCARDED REVIEWED EXAMPLE: ${discardedReviewer}`,
		`DISCARDED CRITIC EXAMPLE: ${discardedCritic}`,
		'Routing rules:',
		'- Emit exactly one live REVIEWED row per assigned item in reviewer lanes.',
		'- Emit exactly one live CRITIC row per assigned item in critic lanes.',
		'- DISPROVED requires severity NONE.',
		'- NEEDS_MORE_EVIDENCE is not a terminal critic transport row.',
		'- risk_impact/risk_tags are REQUIRED on every CONFIRMED REVIEWED row; malformed or unknown values fail the row.',
		'- Critic routing is typed (issue #2383): CRITICAL/HIGH always; MEDIUM only when HIGH_IMPACT or any risk tag; UNKNOWN always; ORDINARY MEDIUMs with no tags are not critic-routed.',
		'- Paths, dimensions, keywords, and prose may suggest risk but never override the typed risk_impact/risk_tags result.',
		'- DISCARDED examples above are documentation only; they are not routable live rows.',
		'Defaults and ownership:',
		'- assigned_item_ids and workflow_lane come only from the controller block.',
		'- Omit no assigned row; emit no row for an unassigned or discarded example ID.',
		'- A settled lane is immutable and is never reprocessed on later collection.',
		'Transition matrix:',
		'- reviewer lane: assigned item -> exactly one REVIEWED row -> critic routing or terminal disposition.',
		'- critic lane: assigned reviewer claim -> exactly one CRITIC row -> final finding disposition.',
		'- malformed, duplicate, missing, or discarded rows -> contract failure and bounded retry; never acceptance.',
		'Retry and deadline semantics:',
		'- Malformed live rows fail closed and may be retried only within the controller retry bound.',
		'- A waited collection deadline is an OBSERVER deadline: it bounds the collect call only, never cancels or terminalizes child work (issue #2381); poll, explicitly cancel, or rely on the presumed-stale sweep.',
		'- Partial discovery salvage never turns an incomplete REVIEWED or CRITIC verdict into acceptance.',
	].join('\n');
}

function encodePrReviewVerdictField(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/\|/g, '\\|')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r');
}

export function encodePrReviewVerdictRow(
	kind: PrReviewVerdictKind,
	fields: readonly string[],
): string {
	const descriptor = PR_REVIEW_VERDICT_ROW_DESCRIPTORS[kind];
	const parsed = descriptor.schema.safeParse(fields);
	if (!parsed.success) {
		throw new Error(
			`${kind} verdict row requires ${descriptor.fieldCount} schema-valid fields beginning with ${descriptor.marker}: ${formatPrReviewValidationIssues(parsed.error.issues, fields).join('; ')}`,
		);
	}
	return parsed.data.map(encodePrReviewVerdictField).join(' | ');
}

export function parsePrReviewVerdictRow(
	line: string,
	kind: PrReviewVerdictKind,
): ParsedPrReviewVerdictRow | null {
	const descriptor = PR_REVIEW_VERDICT_ROW_DESCRIPTORS[kind];
	const fields: string[] = [];
	let current = '';
	let usedCanonicalEscape = false;
	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		if (char === '\\') {
			const next = line[index + 1];
			if (next === '\\') {
				current += '\\';
				usedCanonicalEscape = true;
				index++;
				continue;
			}
			if (next === '|') {
				current += '|';
				usedCanonicalEscape = true;
				index++;
				continue;
			}
			if (next === 'n') {
				current += '\n';
				usedCanonicalEscape = true;
				index++;
				continue;
			}
			if (next === 'r') {
				current += '\r';
				usedCanonicalEscape = true;
				index++;
				continue;
			}
			current += '\\';
			continue;
		}
		if (char === '|') {
			fields.push(current.trim());
			current = '';
			continue;
		}
		current += char;
	}
	fields.push(current.trim());
	if (fields[0] !== descriptor.marker) return null;
	if (
		kind === 'reviewer' &&
		fields.length === PR_REVIEW_REVIEWER_LEGACY_FIELD_COUNT
	) {
		// Legacy 10-field rows predate typed risk metadata (issue #2383).
		// Normalized at this single parse boundary to UNKNOWN / no tags, which
		// fail-safely routes the item to critic review. The row digest is
		// computed over the NORMALIZED fields on both the critic-batch binder
		// and the claim-admission side, so normalization is consistent.
		fields.push('UNKNOWN', '');
	}
	if (fields.length > descriptor.fieldCount) {
		const retained = fields.slice(0, descriptor.fieldCount - 1);
		retained.push(fields.slice(descriptor.fieldCount - 1).join('|'));
		return {
			marker: descriptor.marker,
			fields: retained,
			recoveredOverflow: true,
			overflowClass:
				fields.length === descriptor.fieldCount + 1 &&
				fields[fields.length - 1] === ''
					? 'legacy-fidelity-safe'
					: 'legacy-lossy',
		};
	}
	return {
		marker: descriptor.marker,
		fields,
		recoveredOverflow: false,
		overflowClass:
			fields.length === descriptor.fieldCount
				? usedCanonicalEscape
					? 'canonical'
					: 'legacy-fidelity-safe'
				: 'legacy-lossy',
	};
}

export function formatPrReviewRuntimeFieldError(
	field: string,
	expected: string,
	got: unknown,
): string {
	return `field ${field}: expected ${expected}, got ${formatActualValue(got)}`;
}

function pad(value: number, width: number): string {
	return `${value}`.padStart(width, '0');
}

export function generatePrReviewRunId(now: Date = new Date()): string {
	return (
		`pr-review-${now.getUTCFullYear()}` +
		`${pad(now.getUTCMonth() + 1, 2)}` +
		`${pad(now.getUTCDate(), 2)}` +
		`${pad(now.getUTCHours(), 2)}` +
		`${pad(now.getUTCMinutes(), 2)}` +
		`${pad(now.getUTCSeconds(), 2)}` +
		`${pad(now.getUTCMilliseconds(), 3)}`
	);
}
