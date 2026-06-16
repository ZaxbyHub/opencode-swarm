import { z } from 'zod';

// File size limits for evidence bundles
export const EVIDENCE_MAX_JSON_BYTES = 500 * 1024; // 500KB
export const EVIDENCE_MAX_PATCH_BYTES = 5 * 1024 * 1024; // 5MB
export const EVIDENCE_MAX_TASK_BYTES = 20 * 1024 * 1024; // 20MB

// Evidence type enum
export const EvidenceTypeSchema = z.enum([
	'review',
	'test',
	'diff',
	'approval',
	'note',
	'retrospective',
	'syntax',
	'placeholder',
	'sast',
	'sbom',
	'build',
	'quality_budget',
	'secretscan',
	'mutation-gate',
	'drift-verification',
	'hallucination-verification',
]);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

// Evidence verdict enum
export const EvidenceVerdictSchema = z.enum([
	'pass',
	'fail',
	'warn',
	'skip',
	'approved',
	'rejected',
	'info',
]);
export type EvidenceVerdict = z.infer<typeof EvidenceVerdictSchema>;

// Base evidence schema with common fields
export const BaseEvidenceSchema = z.object({
	task_id: z.string().min(1), // e.g. "1.1", "2.3"
	type: EvidenceTypeSchema,
	timestamp: z.string().datetime(), // ISO 8601
	agent: z.string().min(1), // which agent produced this
	verdict: EvidenceVerdictSchema,
	summary: z.string().min(1), // human-readable summary
	metadata: z.record(z.string(), z.unknown()).optional(), // extensible key-value
});
export type BaseEvidence = z.infer<typeof BaseEvidenceSchema>;

// Review evidence schema
export const ReviewEvidenceSchema = BaseEvidenceSchema.extend({
	type: z.literal('review'),
	risk: z.enum(['low', 'medium', 'high', 'critical']),
	issues: z
		.array(
			z.object({
				severity: z.enum(['error', 'warning', 'info']),
				message: z.string().min(1),
				file: z.string().optional(),
				line: z.number().int().optional(),
			}),
		)
		.default([]),
});
export type ReviewEvidence = z.infer<typeof ReviewEvidenceSchema>;

// Test evidence schema
export const TestEvidenceSchema = BaseEvidenceSchema.extend({
	type: z.literal('test'),
	tests_passed: z.number().int().min(0),
	tests_failed: z.number().int().min(0),
	test_file: z.string().optional(), // path to test file
	failures: z
		.array(
			z.object({
				name: z.string().min(1),
				message: z.string().min(1),
			}),
		)
		.default([]),
});
export type TestEvidence = z.infer<typeof TestEvidenceSchema>;

// Diff evidence schema
export const DiffEvidenceSchema = BaseEvidenceSchema.extend({
	type: z.literal('diff'),
	files_changed: z.array(z.string()).default([]),
	additions: z.number().int().min(0).default(0),
	deletions: z.number().int().min(0).default(0),
	patch_path: z.string().optional(), // path to .patch file
});
export type DiffEvidence = z.infer<typeof DiffEvidenceSchema>;

// Approval evidence schema (base with narrowed type)
export const ApprovalEvidenceSchema = BaseEvidenceSchema.extend({
	type: z.literal('approval'),
});
export type ApprovalEvidence = z.infer<typeof ApprovalEvidenceSchema>;

// Note evidence schema (base with narrowed type)
export const NoteEvidenceSchema = BaseEvidenceSchema.extend({
	type: z.literal('note'),
});
export type NoteEvidence = z.infer<typeof NoteEvidenceSchema>;

// Retrospective evidence schema
export const RetrospectiveEvidenceSchema = BaseEvidenceSchema.extend({
	type: z.literal('retrospective'),
	// Execution metrics
	phase_number: z.number().int().min(1).max(99),
	total_tool_calls: z.number().int().min(0).max(9999),
	// Revision cycles
	coder_revisions: z.number().int().min(0).max(999),
	reviewer_rejections: z.number().int().min(0).max(999),
	loop_detections: z.number().int().min(0).max(9999).optional(),
	circuit_breaker_trips: z.number().int().min(0).max(9999).optional(),
	test_failures: z.number().int().min(0).max(9999),
	security_findings: z.number().int().min(0).max(999),
	integration_issues: z.number().int().min(0).max(999),
	// Task classification
	task_count: z.number().int().min(1).max(9999),
	task_complexity: z.enum(['trivial', 'simple', 'moderate', 'complex']),
	// Qualitative findings (structured)
	top_rejection_reasons: z.array(z.string()).default([]),
	lessons_learned: z.array(z.string()).max(5).default([]),
	user_directives: z
		.array(
			z.object({
				directive: z.string().min(1),
				category: z.enum([
					'tooling',
					'code_style',
					'architecture',
					'process',
					'other',
				]),
				scope: z.enum(['session', 'project', 'global']),
			}),
		)
		.default([]),
	approaches_tried: z
		.array(
			z.object({
				approach: z.string().min(1),
				result: z.enum(['success', 'failure', 'partial']),
				abandoned_reason: z.string().optional(),
			}),
		)
		.max(10)
		.default([]),
	error_taxonomy: z
		.array(
			z.enum([
				'planning_error',
				'interface_mismatch',
				'logic_error',
				'scope_creep',
				'gate_evasion',
			]),
		)
		.default([]),
});
export type RetrospectiveEvidence = z.infer<typeof RetrospectiveEvidenceSchema>;

export const SyntaxEvidenceSchema = BaseEvidenceSchema.extend({
	type: z.literal('syntax'),
	files_checked: z.number().int(),
	files_failed: z.number().int(),
	skipped_count: z.number().int().default(0),
	files: z
		.array(
			z.object({
				path: z.string(),
				language: z.string(),
				ok: z.boolean(),
				errors: z
					.array(
						z.object({
							line: z.number().int(),
							column: z.number().int(),
							message: z.string(),
						}),
					)
					.default([]),
				skipped_reason: z.string().optional(),
			}),
		)
		.default([]),
});
export type SyntaxEvidence = z.infer<typeof SyntaxEvidenceSchema>;

export const PlaceholderEvidenceSchema = BaseEvidenceSchema.extend({
	type: z.literal('placeholder'),
	findings: z
		.array(
			z.object({
				path: z.string(),
				line: z.number().int(),
				kind: z.enum(['comment', 'string', 'function_body', 'other']),
				excerpt: z.string(),
				rule_id: z.string(),
			}),
		)
		.default([]),
	files_scanned: z.number().int(),
	files_with_findings: z.number().int(),
	findings_count: z.number().int(),
});
export type PlaceholderEvidence = z.infer<typeof PlaceholderEvidenceSchema>;

export const SastFindingSchema = z.object({
	rule_id: z.string(),
	severity: z.enum(['critical', 'high', 'medium', 'low']),
	message: z.string(),
	location: z.object({
		file: z.string(),
		line: z.number().int(),
		column: z.number().int().optional(),
	}),
	remediation: z.string().optional(),
});

export const SastEvidenceSchema = BaseEvidenceSchema.extend({
	type: z.literal('sast'),
	findings: z.array(SastFindingSchema).default([]),
	engine: z.enum(['tier_a', 'tier_a+tier_b']),
	files_scanned: z.number().int(),
	findings_count: z.number().int(),
	findings_by_severity: z.object({
		critical: z.number().int(),
		high: z.number().int(),
		medium: z.number().int(),
		low: z.number().int(),
	}),
	// Baseline-diffing fields (optional — present when baseline diff was active)
	new_findings: z.array(SastFindingSchema).optional(),
	pre_existing_findings: z.array(SastFindingSchema).optional(),
	baseline_used: z.boolean().optional(),
});
export type SastEvidence = z.infer<typeof SastEvidenceSchema>;

export const SbomEvidenceSchema = BaseEvidenceSchema.extend({
	type: z.literal('sbom'),
	components: z
		.array(
			z.object({
				name: z.string(),
				version: z.string(),
				type: z.enum(['library', 'framework', 'application']),
				purl: z.string().optional(),
				license: z.string().optional(),
			}),
		)
		.default([]),
	metadata: z.object({
		timestamp: z.string().datetime(),
		tool: z.string(),
		tool_version: z.string(),
	}),
	files: z.array(z.string()), // Manifest files used
	components_count: z.number().int(),
	output_path: z.string(), // Path to generated SBOM
});
export type SbomEvidence = z.infer<typeof SbomEvidenceSchema>;

export const BuildEvidenceSchema = BaseEvidenceSchema.extend({
	type: z.literal('build'),
	runs: z
		.array(
			z.object({
				kind: z.enum(['build', 'typecheck', 'test']),
				command: z.string(),
				cwd: z.string(),
				exit_code: z.number().int(),
				duration_ms: z.number().int(),
				stdout_tail: z.string(),
				stderr_tail: z.string(),
			}),
		)
		.default([]),
	files_scanned: z.number().int(),
	runs_count: z.number().int(),
	failed_count: z.number().int(),
	skipped_reason: z.string().optional(),
});
export type BuildEvidence = z.infer<typeof BuildEvidenceSchema>;

export const QualityBudgetEvidenceSchema = BaseEvidenceSchema.extend({
	type: z.literal('quality_budget'),
	metrics: z.object({
		complexity_delta: z.number(),
		public_api_delta: z.number(),
		duplication_ratio: z.number(),
		test_to_code_ratio: z.number(),
	}),
	thresholds: z.object({
		max_complexity_delta: z.number(),
		max_public_api_delta: z.number(),
		max_duplication_ratio: z.number(),
		min_test_to_code_ratio: z.number(),
	}),
	violations: z
		.array(
			z.object({
				type: z.enum(['complexity', 'api', 'duplication', 'test_ratio']),
				message: z.string(),
				severity: z.enum(['error', 'warning']),
				files: z.array(z.string()),
			}),
		)
		.default([]),
	files_analyzed: z.array(z.string()),
});
export type QualityBudgetEvidence = z.infer<typeof QualityBudgetEvidenceSchema>;

// Secretscan evidence schema
export const SecretscanEvidenceSchema = BaseEvidenceSchema.extend({
	type: z.literal('secretscan'),
	findings_count: z.number().int().min(0).default(0),
	scan_directory: z.string().optional(),
	files_scanned: z.number().int().min(0).default(0),
	skipped_files: z.number().int().min(0).default(0),
});
export type SecretscanEvidence = z.infer<typeof SecretscanEvidenceSchema>;

/**
 * Gate evidence schemas
 *
 * These types cover the three mutation-testing and drift/hallucination gate
 * workflows. They use a distinct verdict vocabulary (pass/warn/fail/skip for
 * mutation, approved/rejected for drift and hallucination) and are intentionally
 * separate from the core BaseEvidenceSchema that drives the coder-review pipeline.
 *
 * Architectural distinction from BaseEvidenceSchema:
 * - BaseEvidenceSchema is task-scoped (task_id and agent are required), reflecting
 *   evidence produced by individual agents working on a specific task.
 * - GateEvidenceBaseSchema is phase-scoped: task_id and agent are optional because
 *   gate writers (write_mutation_evidence, write_drift_evidence,
 *   write_hallucination_evidence) operate at the phase level and are invoked by
 *   the architect, not scoped to a single task.
 */

// Base schema shared by all gate evidence types (relaxed constraints)
const GateEvidenceBaseSchema = z.object({
	task_id: z.string().optional(),
	agent: z.string().optional(),
	timestamp: z.string().datetime(),
	summary: z.string().min(1),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

// Mutation gate evidence schema
export const MutationGateEvidenceSchema = GateEvidenceBaseSchema.extend({
	type: z.literal('mutation-gate'),
	verdict: z.enum(['pass', 'warn', 'fail', 'skip']),
	killRate: z.number().min(0).max(1).optional(),
	adjustedKillRate: z.number().min(0).max(1).optional(),
	/**
	 * Optional JSON-serialised list of survived mutant IDs (stored as a string
	 * because evidence bundles are JSON and arrays of arbitrary size are not
	 * bounded by the schema). Parse with JSON.parse() when needed.
	 */
	survivedMutants: z.string().optional(),
});
export type MutationGateEvidence = z.infer<typeof MutationGateEvidenceSchema>;

// Drift verification evidence schema
export const DriftVerificationEvidenceSchema = GateEvidenceBaseSchema.extend({
	type: z.literal('drift-verification'),
	verdict: z.enum(['approved', 'rejected']),
	requirementCoverage: z.string().optional(),
});
export type DriftVerificationEvidence = z.infer<
	typeof DriftVerificationEvidenceSchema
>;

// Hallucination verification evidence schema
export const HallucinationVerificationEvidenceSchema =
	GateEvidenceBaseSchema.extend({
		type: z.literal('hallucination-verification'),
		verdict: z.enum(['approved', 'rejected']),
		findings: z.string().optional(),
	});
export type HallucinationVerificationEvidence = z.infer<
	typeof HallucinationVerificationEvidenceSchema
>;

// Discriminated union of all evidence types
export const EvidenceSchema = z.discriminatedUnion('type', [
	ReviewEvidenceSchema,
	TestEvidenceSchema,
	DiffEvidenceSchema,
	ApprovalEvidenceSchema,
	NoteEvidenceSchema,
	RetrospectiveEvidenceSchema,
	SyntaxEvidenceSchema,
	PlaceholderEvidenceSchema,
	SastEvidenceSchema,
	SbomEvidenceSchema,
	BuildEvidenceSchema,
	QualityBudgetEvidenceSchema,
	SecretscanEvidenceSchema,
	MutationGateEvidenceSchema,
	DriftVerificationEvidenceSchema,
	HallucinationVerificationEvidenceSchema,
]);
export type Evidence = z.infer<typeof EvidenceSchema>;

// Evidence bundle schema (container for all evidence for a task)
export const EvidenceBundleSchema = z.object({
	schema_version: z.literal('1.0.0'),
	task_id: z.string().min(1),
	entries: z.array(EvidenceSchema).default([]),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
