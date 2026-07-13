import { z } from 'zod';

const IdentifierSchema = z
	.string()
	.min(1)
	.max(160)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IsoDateSchema = z.iso.datetime({ offset: true });
const RelativePathSchema = z
	.string()
	.min(1)
	.max(1024)
	.refine((value) => !value.includes('\0'), 'path contains a NUL byte')
	.refine((value) => !/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(value), {
		message: 'path must be project-relative',
	})
	.refine(
		(value) =>
			!value
				.replace(/\\/g, '/')
				.split('/')
				.some((segment) => segment === '..'),
		'path must not traverse outside its root',
	);

export { IdentifierSchema as EvaluationIdentifierSchema };
export { Sha256Schema as EvaluationSha256Schema };
export { RelativePathSchema as EvaluationRelativePathSchema };

export const EvaluationSplitSchema = z.enum(['train', 'validation', 'test']);
export type EvaluationSplit = z.infer<typeof EvaluationSplitSchema>;

export const CostRecordSchema = z
	.object({
		source: z.enum(['reported', 'estimated', 'unavailable']),
		usd: z.number().finite().nonnegative().optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.source === 'unavailable' && value.usd !== undefined) {
			ctx.addIssue({
				code: 'custom',
				path: ['usd'],
				message: 'unavailable costs cannot declare a USD value',
			});
		}
		if (value.source !== 'unavailable' && value.usd === undefined) {
			ctx.addIssue({
				code: 'custom',
				path: ['usd'],
				message: 'reported and estimated costs require a USD value',
			});
		}
	});
export type CostRecord = z.infer<typeof CostRecordSchema>;

export const HumanReviewReceiptSchema = z
	.object({
		reviewer: z.string().min(1).max(200),
		reviewedAt: IsoDateSchema,
		instruction: z.literal(true),
		fixture: z.literal(true),
		scorer: z.literal(true),
		secretsPrivacy: z.literal(true),
		license: z.literal(true),
		split: z.literal(true),
	})
	.strict();

export const EvaluationTaskV1Schema = z
	.object({
		v: z.literal(1),
		id: IdentifierSchema,
		derivedFromTaskId: IdentifierSchema.optional(),
		source: z.enum(['curated', 'trace-proposal']),
		split: EvaluationSplitSchema,
		category: IdentifierSchema,
		protected: z.boolean().default(false),
		instructionPath: RelativePathSchema,
		environment: z.discriminatedUnion('kind', [
			z
				.object({ kind: z.literal('fixture'), path: RelativePathSchema })
				.strict(),
			z
				.object({ kind: z.literal('container'), path: RelativePathSchema })
				.strict(),
		]),
		scorer: z
			.object({
				kind: z.enum(['builtin', 'project']),
				argv: z.array(z.string().min(1).max(4096)).min(1).max(64),
				timeoutMs: z.number().int().min(100).max(600_000),
				scoreRange: z
					.tuple([z.number().finite(), z.number().finite()])
					.refine(([minimum, maximum]) => maximum > minimum, {
						message: 'score range maximum must be greater than minimum',
					}),
			})
			.strict(),
		provenance: z
			.object({
				origin: z.string().min(1).max(2048),
				license: z.string().min(1).max(200),
				collectedAt: IsoDateSchema.optional(),
				review: HumanReviewReceiptSchema.optional(),
			})
			.strict(),
		contentHash: Sha256Schema,
	})
	.strict()
	.superRefine((task, ctx) => {
		if (task.derivedFromTaskId === task.id) {
			ctx.addIssue({
				code: 'custom',
				path: ['derivedFromTaskId'],
				message: 'a derived task must reference a different parent task',
			});
		}
		if (task.source === 'trace-proposal' && !task.provenance.review) {
			ctx.addIssue({
				code: 'custom',
				path: ['provenance', 'review'],
				message: 'trace-derived tasks require an explicit human review receipt',
			});
		}
		if (
			task.scorer.kind === 'project' &&
			!RelativePathSchema.safeParse(task.scorer.argv[0]).success
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['scorer', 'argv', 0],
				message: 'project scorer executable must be project-relative',
			});
		}
	});
export type EvaluationTaskV1 = z.infer<typeof EvaluationTaskV1Schema>;

export const EvaluationCandidateV1Schema = z
	.object({
		v: z.literal(1),
		id: IdentifierSchema,
		kind: z.enum(['baseline', 'skill', 'harness']),
		payloadPath: RelativePathSchema,
		model: z.string().min(1).max(300),
		agent: z.string().min(1).max(160).optional(),
		contentHash: Sha256Schema,
	})
	.strict();
export type EvaluationCandidateV1 = z.infer<typeof EvaluationCandidateV1Schema>;

export const EvaluationOutcomeSchema = z.enum([
	'scored',
	'infrastructure_failure',
	'timeout',
	'cancelled',
	'malformed',
	'unsupported',
	'integrity_failure',
]);
export type EvaluationOutcome = z.infer<typeof EvaluationOutcomeSchema>;

export const EvaluationResultV1Schema = z
	.object({
		v: z.literal(1),
		taskId: IdentifierSchema,
		category: IdentifierSchema,
		protected: z.boolean().default(false),
		repetition: z.number().int().nonnegative(),
		candidateId: IdentifierSchema,
		seed: z.string().min(1).max(500),
		outcome: EvaluationOutcomeSchema,
		score: z.number().finite().optional(),
		scoreRange: z.tuple([z.number().finite(), z.number().finite()]),
		cost: CostRecordSchema,
		durationMs: z.number().int().nonnegative(),
		retries: z.number().int().nonnegative().default(0),
		failureCode: z.string().min(1).max(160).optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.strict()
	.superRefine((result, ctx) => {
		const [minimum, maximum] = result.scoreRange;
		if (maximum <= minimum) {
			ctx.addIssue({
				code: 'custom',
				path: ['scoreRange'],
				message: 'score range maximum must be greater than minimum',
			});
		}
		if (result.outcome === 'scored') {
			if (
				result.score === undefined ||
				result.score < minimum ||
				result.score > maximum
			) {
				ctx.addIssue({
					code: 'custom',
					path: ['score'],
					message: 'scored outcomes require an in-range score',
				});
			}
		} else if (result.score !== undefined) {
			ctx.addIssue({
				code: 'custom',
				path: ['score'],
				message: 'non-score outcomes must not be imputed with a score',
			});
		}
	});
export type EvaluationResultV1 = z.infer<typeof EvaluationResultV1Schema>;

export const EvaluationBudgetsV1Schema = z
	.object({
		maxTasks: z.number().int().positive(),
		maxRepetitions: z.number().int().positive(),
		maxConcurrency: z.number().int().positive(),
		maxTaskTimeMs: z.number().int().positive(),
		maxRetries: z.number().int().nonnegative(),
		maxOutputBytes: z.number().int().positive(),
		maxSpendUsd: z.number().finite().nonnegative().optional(),
	})
	.strict();

export const EnvironmentFingerprintV1Schema = z
	.object({
		platform: z.string().min(1),
		arch: z.string().min(1),
		runtime: z.string().min(1),
		baseSha: z.string().regex(/^[a-f0-9]{40,64}$/),
		activeTreeHash: Sha256Schema,
		taskSetHash: Sha256Schema,
	})
	.strict();

export const EvaluationRunV1Schema = z
	.object({
		v: z.literal(1),
		runId: IdentifierSchema,
		createdAt: IsoDateSchema,
		status: z.enum(['complete', 'inconclusive', 'cancelled']),
		baseline: EvaluationCandidateV1Schema,
		candidate: EvaluationCandidateV1Schema,
		taskSet: z
			.object({
				id: IdentifierSchema,
				contentHash: Sha256Schema,
				taskIds: z.array(IdentifierSchema).min(1),
			})
			.strict(),
		split: EvaluationSplitSchema,
		seed: z.string().min(1).max(500),
		models: z.array(z.string().min(1).max(300)).min(1),
		environment: EnvironmentFingerprintV1Schema,
		budgets: EvaluationBudgetsV1Schema,
		results: z.array(EvaluationResultV1Schema),
		cost: CostRecordSchema,
		integrityHash: Sha256Schema,
	})
	.strict()
	.superRefine((run, ctx) => {
		if (run.environment.taskSetHash !== run.taskSet.contentHash) {
			ctx.addIssue({
				code: 'custom',
				path: ['environment', 'taskSetHash'],
				message: 'environment and task-set hashes must agree',
			});
		}
		const allowed = new Set([run.baseline.id, run.candidate.id]);
		if (allowed.size !== 2) {
			ctx.addIssue({
				code: 'custom',
				path: ['candidate', 'id'],
				message: 'baseline and candidate ids must differ',
			});
		}
		if (run.results.some((result) => !allowed.has(result.candidateId))) {
			ctx.addIssue({
				code: 'custom',
				path: ['results'],
				message:
					'results may only reference the declared baseline and candidate',
			});
		}
		const taskIds = new Set(run.taskSet.taskIds);
		if (run.results.some((result) => !taskIds.has(result.taskId))) {
			ctx.addIssue({
				code: 'custom',
				path: ['results'],
				message: 'results may only reference tasks in the frozen task set',
			});
		}
		const resultKeys = run.results.map(
			(result) =>
				`${result.candidateId}\u0000${result.taskId}\u0000${result.repetition}`,
		);
		if (new Set(resultKeys).size !== resultKeys.length) {
			ctx.addIssue({
				code: 'custom',
				path: ['results'],
				message: 'run contains duplicate candidate/task/repetition results',
			});
		}
		if (
			run.results.some(
				(result) => result.repetition >= run.budgets.maxRepetitions,
			)
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['results'],
				message: 'result repetition exceeds the declared run budget',
			});
		}
	});
export type EvaluationRunV1 = z.infer<typeof EvaluationRunV1Schema>;

export const PromotionPolicyV1Schema = z
	.object({
		v: z.literal(1),
		minValidPairs: z.number().int().positive().default(6),
		minCoverage: z.number().min(0).max(1).default(0.8),
		deadband: z.number().min(0).max(1).default(0),
		confidence: z.literal(0.95).default(0.95),
		bootstrapResamples: z.literal(10_000).default(10_000),
		requireAvailableCosts: z.boolean().default(true),
		protectedCategoryTolerances: z
			.record(z.string(), z.number().min(0).max(1))
			.default({}),
	})
	.strict();
export type PromotionPolicyV1 = z.infer<typeof PromotionPolicyV1Schema>;

const PromotionComparisonSchema = z
	.object({
		baselineRunId: IdentifierSchema,
		baselineCandidateId: IdentifierSchema,
		baselineMean: z.number().min(0).max(1),
		candidateMean: z.number().min(0).max(1),
		pairedDelta: z.number().min(-1).max(1),
		confidenceInterval: z.tuple([
			z.number().min(-1).max(1),
			z.number().min(-1).max(1),
		]),
		validPairs: z.number().int().nonnegative(),
		missingPairs: z.number().int().nonnegative(),
		coverage: z.number().min(0).max(1),
	})
	.strict();

export const PromotionDecisionV1Schema = z
	.object({
		v: z.literal(1),
		decisionId: IdentifierSchema,
		runId: IdentifierSchema,
		decidedAt: IsoDateSchema,
		status: z.enum(['accept', 'reject', 'inconclusive']),
		reasons: z.array(z.string().min(1).max(300)),
		baseline: PromotionComparisonSchema,
		historicalBest: PromotionComparisonSchema,
		deadband: z.number().min(0).max(1),
		bootstrap: z
			.object({
				resamples: z.literal(10_000),
				confidence: z.literal(0.95),
				seedHash: Sha256Schema,
			})
			.strict(),
		categories: z.array(
			z
				.object({
					category: IdentifierSchema,
					protected: z.boolean(),
					tolerance: z.number().min(0).max(1),
					baselineMean: z.number().min(0).max(1),
					candidateMean: z.number().min(0).max(1),
					pairedDelta: z.number().min(-1).max(1),
					regression: z.boolean(),
				})
				.strict(),
		),
		lineage: z
			.object({
				baselineRunId: IdentifierSchema,
				historicalBestRunId: IdentifierSchema,
				taskSetHash: Sha256Schema,
				baselineHash: Sha256Schema,
				candidateHash: Sha256Schema,
				historicalBestHash: Sha256Schema,
			})
			.strict(),
		policyHash: Sha256Schema,
		unavailableQualityMetrics: z
			.array(z.enum(['complexity_delta', 'public_api_delta']))
			.default(['complexity_delta', 'public_api_delta']),
	})
	.strict();
export type PromotionDecisionV1 = z.infer<typeof PromotionDecisionV1Schema>;

export const GateNameSchema = z.enum([
	'reviewer',
	'test-engineer',
	'sast',
	'mutation',
	'quality',
]);
export type GateName = z.infer<typeof GateNameSchema>;

export const GateAuditManifestV1Schema = z
	.object({
		v: z.literal(1),
		id: IdentifierSchema,
		createdAt: IsoDateSchema,
		taskIds: z.array(IdentifierSchema).min(1),
		gates: z.array(GateNameSchema).min(1),
		models: z.array(z.string().min(1).max(300)).min(1),
		preferredSwarm: IdentifierSchema.optional(),
		repetitions: z.number().int().positive().max(100),
		seed: z.string().min(1).max(500),
		maxConcurrency: z.number().int().positive().max(64),
		maxRetries: z.number().int().nonnegative().max(20),
		maxTimeMs: z.number().int().positive(),
		maxCostUsd: z.number().finite().nonnegative().optional(),
		contentHash: Sha256Schema,
	})
	.strict();
export type GateAuditManifestV1 = z.infer<typeof GateAuditManifestV1Schema>;

export const GateAuditCellV1Schema = z
	.object({
		v: z.literal(1),
		taskId: IdentifierSchema,
		candidateId: IdentifierSchema.optional(),
		defectType: IdentifierSchema,
		gate: GateNameSchema,
		model: z.string().min(1).max(300),
		repetition: z.number().int().nonnegative(),
		outcome: z.enum([
			'caught',
			'missed',
			'false_rejection',
			'unsupported',
			'infrastructure_failure',
		]),
		retries: z.number().int().nonnegative(),
		cost: CostRecordSchema,
		durationMs: z.number().int().nonnegative(),
		failureClassification: z
			.enum([
				'clean',
				'pre_existing_failure',
				'new_regression',
				'flaky_failure',
				'infrastructure_failure',
				'unknown_failure',
			])
			.optional(),
		failureCode: z.string().min(1).max(160).optional(),
	})
	.strict();
export type GateAuditCellV1 = z.infer<typeof GateAuditCellV1Schema>;

export const GateAuditResultV1Schema = z
	.object({
		v: z.literal(1),
		runId: IdentifierSchema,
		manifestHash: Sha256Schema,
		createdAt: IsoDateSchema,
		status: z.enum(['complete', 'inconclusive', 'cancelled']),
		cells: z.array(GateAuditCellV1Schema),
		cost: CostRecordSchema,
		qualityMetricAvailability: z
			.object({
				complexity_delta: z.literal('unavailable'),
				public_api_delta: z.literal('unavailable'),
			})
			.strict(),
	})
	.strict();
export type GateAuditResultV1 = z.infer<typeof GateAuditResultV1Schema>;

export const TestConsumptionClaimV1Schema = z
	.object({
		v: z.literal(1),
		runId: IdentifierSchema,
		taskSetHash: Sha256Schema,
		baselineHash: Sha256Schema,
		candidateHash: Sha256Schema,
		claimedAt: IsoDateSchema,
	})
	.strict();
export type TestConsumptionClaimV1 = z.infer<
	typeof TestConsumptionClaimV1Schema
>;

export const TaskSetSnapshotV1Schema = z
	.object({
		v: z.literal(1),
		id: IdentifierSchema,
		split: EvaluationSplitSchema,
		tasks: z.array(EvaluationTaskV1Schema).min(1),
		contentHash: Sha256Schema,
		createdAt: IsoDateSchema,
	})
	.strict();
export type TaskSetSnapshotV1 = z.infer<typeof TaskSetSnapshotV1Schema>;
