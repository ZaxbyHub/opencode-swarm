import { createHash } from 'node:crypto';
import pLimit from 'p-limit';
import { z } from 'zod';
import {
	buildLaneOutputPreview,
	storeLaneOutput,
} from '../background/lane-output-store.js';
import {
	appendDelegationTransition,
	type BackgroundDelegationRecord,
	findByBatchId,
	recordPendingDelegation,
} from '../background/pending-delegations.js';
import {
	resolveExactMergeBaseAsync,
	resolvePrWorkflowRevisionDigestAsync,
} from '../background/workspace-snapshot.js';
import { WRITE_TOOL_NAMES } from '../config/constants.js';
import {
	isKnownCanonicalRole,
	resolveGeneratedAgentRole,
} from '../config/schema.js';
import {
	activatePrWorkflow,
	assertCurrentCheckoutHead,
	assertPrReviewBaseCoverageSettled,
	bindPrReviewBase,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	enforcePrReviewBaseDimensions,
	enforcePrWorkflowDispatchLanesAsync,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_BASE_LANE_FLOORS,
	PR_REVIEW_MICRO_LANE_FLOORS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	type PrReviewDepthTier,
	recordPrFeedbackGateBatch,
	recordPrReviewValidationBatch,
} from '../hooks/pr-workflow-gate.js';
import type { ParallelDispatcher } from '../parallel/dispatcher/parallel-dispatcher.js';
import { createParallelDispatcher } from '../parallel/dispatcher/parallel-dispatcher.js';
import { swarmState } from '../state.js';
import * as logger from '../utils/logger.js';
import { createSwarmTool } from './create-tool.js';

const MAX_LANES = 8;
export const MAX_PROMPT_CHARS = 80_000;
const COMMON_PROMPT_SEPARATOR = '\n\n';
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_ASYNC_LAUNCH_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 1_800_000;
const MAX_LANE_OUTPUT_CHARS = 20_000;
const ASYNC_MESSAGE_FETCH_LIMIT = 50;
const MAX_ERROR_CHARS = 200;
const ERROR_TRUNCATION_SUFFIX = '...';
const MAX_BATCH_ID_CHARS = 120;
const DEFAULT_ASYNC_STALE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_COLLECT_TIMEOUT_MS = DEFAULT_ASYNC_STALE_TIMEOUT_MS;
const MAX_COLLECT_TIMEOUT_MS = 60 * 60_000;
const COLLECT_POLL_INTERVAL_MS = 500;
const MAX_COLLECT_POLL_INTERVAL_MS = 10_000;
const MAX_ZOD_ISSUES_LISTED = 20;

const AGENT_NAME_SEPARATORS = ['_', '-', ' '] as const;

/**
 * Bound on how many "already delivered lane output" keys we remember
 * (invariant 8: module-level state must have an explicit eviction strategy).
 * `collect_lane_results` is polled repeatedly by the PR-review protocol; once
 * a settled lane's output has been delivered once, re-delivering the same
 * bounded preview on every subsequent poll is the dominant controller-context
 * driver behind PR-review compaction loops (see S1.1). This Set tracks which
 * `${batchId}\0${laneId}\0${digest}` keys have already been sent so later
 * polls can omit the `output` field (setting `output_omitted_repeat: true`
 * instead) while still returning every other metadata field unchanged.
 *
 * This is in-memory by design: a process restart re-delivers each preview
 * once more, which is harmless because `output` is only ever suppressed
 * when BOTH a digest AND a durable ref (`output_ref`, recoverable via
 * `retrieve_lane_output`) are present. If either is missing — e.g. the
 * artifact write failed (disk full, permission error) or the text was too
 * large to store — this falls open and keeps delivering `output` inline on
 * every poll, since there would otherwise be no way to recover the text.
 *
 * Cross-session caveat: When two sessions in different directories reuse the
 * same `batch_id`, `laneId`, and produce byte-identical output (identical
 * digest), the second session's first inline delivery may be suppressed as
 * though already delivered; subsequent polls correctly return metadata and
 * `output_ref`. This is degraded-not-broken because `output_ref` is always
 * returned and `retrieve_lane_output` recovers the full text.
 */
const MAX_TRACKED_DELIVERED_LANE_OUTPUTS = 1024;
const deliveredLaneOutputs = new Set<string>();

/** FIFO-evict the oldest delivered-output key when the set exceeds the bound. */
function evictDeliveredLaneOutputsIfOverBound(): void {
	while (deliveredLaneOutputs.size > MAX_TRACKED_DELIVERED_LANE_OUTPUTS) {
		const oldestKey = deliveredLaneOutputs.values().next().value;
		if (oldestKey === undefined) break;
		deliveredLaneOutputs.delete(oldestKey);
	}
}

/**
 * Formats a Zod issue list for error output, bounded to the first
 * {@link MAX_ZOD_ISSUES_LISTED} entries with a trailing "... and N more"
 * marker when truncated. A badly-malformed multi-lane payload can otherwise
 * produce dozens of issue lines, uncapped unlike every other error path in
 * this file (see MAX_ERROR_CHARS).
 */
function boundZodIssues(issues: readonly z.ZodIssue[]): string[] {
	const formatted = issues.map(
		(issue) => `${issue.path.join('.')}: ${issue.message}`,
	);
	if (formatted.length <= MAX_ZOD_ISSUES_LISTED) return formatted;
	const shown = formatted.slice(0, MAX_ZOD_ISSUES_LISTED);
	shown.push(`... and ${formatted.length - MAX_ZOD_ISSUES_LISTED} more`);
	return shown;
}

const PR_WORKFLOW_LANE_CHECKLISTS: Readonly<Record<string, string>> = {
	'intent-architecture':
		'obligations, claimed versus actual behavior, design fit, callers, consumers, sibling patterns, and documentation',
	'correctness-state':
		'control flow, boundary conditions, error paths, invariants, state transitions, persistence, and rollback behavior',
	'tests-falsifiability':
		'assertion strength, negative paths, fixtures and mocks, isolation, CI behavior, and falsification probes',
	'security-trust':
		'authentication, authorization, untrusted inputs, secrets, injection sinks, privilege, and write authority',
	'reliability-performance':
		'timeouts, retries, concurrency, cleanup, resource bounds, failure recovery, and performance regressions',
	'compatibility-delivery':
		'public contracts, schemas, migrations, platform portability, dependencies, packaging, deployment, and release behavior',
	'auth-identity-secrets':
		'identity, session, permission, authentication, authorization, secret, and cryptographic boundaries',
	'untrusted-input-boundaries':
		'parsing, serialization, query, template, filesystem, and network sources through every reachable sink',
	'subprocess-platform':
		'array-form execution, cwd, stdin, timeout, output bounds, kill paths, quoting, and OS/runtime portability',
	'concurrency-state':
		'locks, queues, caches, transactions, retries, races, session isolation, eviction, and state-machine transitions',
	'dependencies-build-release':
		'manifests, lockfiles, installers, build scripts, CI, artifacts, provenance, packaging, deployment, and release hygiene',
	'api-schema-migrations':
		'public APIs, wire/config/storage schemas, compatibility, defaults, migrations, flags, and rollback paths',
	'test-infrastructure':
		'test validity, isolation, mock leakage, fixtures, harnesses, coverage claims, and CI matrices',
	'ui-accessibility-i18n':
		'user interaction, rendering, keyboard and screen-reader access, focus, localization, and error states',
	'privacy-observability':
		'logs, telemetry, analytics, traces, diagnostics, retention, redaction, and sensitive-data exposure',
	'generated-provenance':
		'generated, vendored, binary, model-produced, codegen, and checked-in artifact source and reproducibility',
	'unclassified-risk':
		'every changed artifact or behavior not fully covered by another lane, with conservative escalation of ambiguity',
	'stage-b-reviewer':
		'every feedback item against the exact diff, fix correctness, adjacent regressions, repository contracts, and evidence quality',
	'stage-b-test':
		'every feedback item with independent targeted negative-path and regression probes on the Stage-A-bound revision',
	'closeout-reviewer':
		'the complete feedback inventory, final diff, tests, docs, release artifacts, scope, and unresolved risk',
	'closeout-critic':
		'challenge the closeout evidence, omissions, false confidence, severity, scope, and publication readiness',
};

const EXPLORER_CANDIDATE_FORMAT_SUFFIX = `

IMPORTANT — OUTPUT FORMAT REQUIREMENT:
You MUST emit your findings as a pipe-delimited [CANDIDATE] table.
Emit the marker-bearing header first, then one unprefixed data row per finding.

Standard explorer format (use unless the prompt specifies micro-lane work):
[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence

Micro-lane format (use when the prompt references invariant checking or micro_lane):
[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence

Candidate IDs must be globally unique across the run; prefix them with the
exact workflow_lane value from this dispatch.

If either a standard explorer or micro-lane finds zero issues, emit its header
followed by exactly:
[CLEAN] | workflow_lane | coverage_scope | evidence
Fill every CLEAN field with the exact workflow_lane; bare header-only output is
UNATTESTED for every PR-review lane.
Do NOT use the default PROJECT/STRUCTURE output format for this dispatch.`;

const READ_ONLY_LANE_ROLES: ReadonlySet<string> = new Set([
	'explorer',
	'reviewer',
	'test_engineer',
	'critic',
	'critic_oversight',
	'critic_sounding_board',
	'critic_drift_verifier',
	'critic_hallucination_verifier',
	'critic_architecture_supervisor',
	'sme',
	'researcher',
	'council_generalist',
	'council_skeptic',
	'council_domain_expert',
]);

const READ_ONLY_TOOL_DENYLIST = [
	...new Set([
		...WRITE_TOOL_NAMES,
		'extract_code_blocks',
		'multiedit',
		'multi_edit',
		'todo_write',
		'save_plan',
		'update_task_status',
		'phase_complete',
		'declare_scope',
		'declare_council_criteria',
		'submit_council_verdicts',
		'submit_phase_council_verdicts',
		'set_qa_gates',
		'write_retro',
		'write_drift_evidence',
		'write_hallucination_evidence',
		'write_mutation_evidence',
		'knowledge_add',
		'knowledge_remove',
		// Issue #1821 Workstream C: mining persists a report under `.swarm/`,
		// so it must not run inside a read-only lane.
		'consensus_mine',
		'summarize_work',
		'doc_scan',
		'lint',
	]),
] as const;

const LaneSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(80)
		.regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)
		.describe('Stable lane identifier, unique within this dispatch batch'),
	agent: z
		.string()
		.min(1)
		.max(120)
		.describe(
			'Read-only swarm agent name, including any generated swarm prefix',
		),
	prompt: z
		.string()
		.min(1)
		.max(MAX_PROMPT_CHARS)
		.describe('Full lane prompt to send to the requested agent'),
	workflow_lane: z
		.string()
		.min(1)
		.max(120)
		.optional()
		.describe(
			'Required mechanical policy identifier in PR workflows; distinct from the retry-safe lane id',
		),
	owned_workflow_lanes: z
		.array(z.string().trim().min(1).max(120))
		.min(1)
		.max(11)
		.optional()
		.describe(
			'Complete dimension/family set a consolidated PR-review base or micro lane covers under the controller-computed depth tier; must include workflow_lane. Omit for singleton lanes.',
		),
	feedback_item_ids: z
		.array(z.string().trim().min(1).max(120))
		.min(1)
		.optional()
		.describe('PR-feedback ledger item IDs owned exclusively by this lane'),
	review_item_ids: z
		.array(z.string().trim().min(1).max(160))
		.min(1)
		.optional()
		.describe(
			'Candidate/finding IDs owned by a PR-review reviewer or critic lane; every ID requires a parseable verdict row',
		),
});

const PrReviewTriggerEvaluationRowSchema = z
	.object({
		trigger_id: z.string().trim().min(1).max(120),
		result: z.literal('MATCHED'),
		evidence: z.string().trim().min(1).max(4000),
	})
	.strict();

const DispatchLanesArgsSchema = z.object({
	lanes: z
		.array(LaneSchema)
		.min(1)
		.max(MAX_LANES)
		.describe('Read-only lane specs to dispatch concurrently'),
	common_prompt: z
		.string()
		.min(1)
		// Must carry real content: a whitespace-only value would prepend a blank
		// prefix + separator to every lane prompt without adding any context.
		.regex(/\S/, 'common_prompt must contain non-whitespace content')
		// Reserve room for the separator + at least 1 char of lane prompt so any
		// schema-valid common_prompt can coexist with the shortest valid lane
		// prompt without the combined length exceeding MAX_PROMPT_CHARS.
		.max(MAX_PROMPT_CHARS - COMMON_PROMPT_SEPARATOR.length - 1)
		.optional()
		.describe(
			'Optional shared context prepended to every lane prompt. Send large shared context (PR diff, obligation ledger, scope) ONCE here instead of inlining the same blob into each lane prompt; this keeps the tool-call payload small and avoids malformed/truncated tool-call JSON. Combined common_prompt + per-lane prompt must not exceed the per-lane character limit.',
		),
	max_concurrent: z
		.number()
		.int()
		.min(1)
		.max(MAX_LANES)
		.optional()
		.describe('Maximum lanes in flight at once; defaults to lane count'),
	timeout_ms: z
		.number()
		.int()
		.min(10)
		.max(MAX_TIMEOUT_MS)
		.optional()
		.describe(
			'Per-lane timeout in milliseconds. For blocking dispatch this covers session create and prompt execution; for async dispatch this covers launch only, never lane runtime.',
		),
});

const DispatchLanesAsyncArgsSchema = DispatchLanesArgsSchema.extend({
	launch_timeout_ms: z
		.number()
		.int()
		.min(10)
		.max(MAX_TIMEOUT_MS)
		.optional()
		.describe(
			'Async launch acceptance timeout in milliseconds. This only bounds session creation and promptAsync acceptance; it is never a lane runtime timeout. Deprecated alias: timeout_ms.',
		),
	batch_id: z
		.string()
		.min(1)
		.max(MAX_BATCH_ID_CHARS)
		.regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
		.optional()
		.describe(
			'Stable async batch id for later collection; generated when omitted',
		),
	mode: z
		.string()
		.min(1)
		.max(80)
		.optional()
		.describe('Advisory workflow mode, such as deep-dive or swarm-pr-review'),
	pr_head_sha: z.string().min(1).max(80).optional(),
	base_sha: z
		.string()
		.regex(/^[0-9a-f]{6,64}$/i)
		.optional(),
	base_ref: z
		.string()
		.regex(/^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/)
		.optional(),
	scope: z.string().min(1).max(500).optional(),
	trigger_evaluation: z
		.array(PrReviewTriggerEvaluationRowSchema)
		.min(1)
		.optional()
		.describe(
			'Exact all-MATCHED repository-agnostic mandatory micro-lane ledger required for swarm-pr-review:micro',
		),
	feedback_inventory: z
		.array(z.string().trim().min(1).max(120))
		.min(1)
		.optional()
		.describe(
			'Complete immutable feedback item inventory required for swarm-pr-feedback:verification',
		),
});

const CollectLaneResultsArgsSchema = z.object({
	batch_id: z.string().min(1).max(MAX_BATCH_ID_CHARS),
	wait: z
		.boolean()
		.optional()
		.describe('Poll until all lanes settle or timeout'),
	timeout_ms: z
		.number()
		.int()
		.min(0)
		.max(MAX_COLLECT_TIMEOUT_MS)
		.optional()
		.describe('Total wait budget when wait=true'),
	include_pending: z
		.boolean()
		.optional()
		.describe(
			'Include pending/running lanes in lane_results. Defaults to true for non-blocking polls and false for wait=true joins.',
		),
	cancel_pending: z
		.boolean()
		.optional()
		.describe('Abort and mark pending/running lanes cancelled'),
});

export type DispatchLaneSpec = z.infer<typeof LaneSchema>;

function validatePrReviewMicroDispatch(
	args: DispatchLanesAsyncArgs,
	depthTier: PrReviewDepthTier,
): void {
	const evaluation = args.trigger_evaluation;
	if (!evaluation) {
		throw new Error(
			'BLOCKED: PR_REVIEW micro dispatch requires the complete trigger_evaluation ledger',
		);
	}
	const expected = new Set<string>(PR_REVIEW_REQUIRED_MICRO_LANE_IDS);
	const seen = new Set<string>();
	for (const row of evaluation) {
		if (seen.has(row.trigger_id)) {
			throw new Error(
				`BLOCKED: duplicate PR_REVIEW trigger row: ${row.trigger_id}`,
			);
		}
		seen.add(row.trigger_id);
	}
	const missing = [...expected].filter((id) => !seen.has(id));
	const unknown = [...seen].filter((id) => !expected.has(id));
	if (missing.length > 0 || unknown.length > 0) {
		throw new Error(
			`BLOCKED: PR_REVIEW trigger ledger must be exact; missing: ${missing.join(', ') || '(none)'}; unknown: ${unknown.join(', ') || '(none)'}`,
		);
	}
	const required = new Set(evaluation.map((row) => row.trigger_id));
	const laneOwnership = args.lanes.map((lane) => ({
		label: lane.workflow_lane ?? '',
		owned: lane.owned_workflow_lanes?.length
			? lane.owned_workflow_lanes
			: lane.workflow_lane
				? [lane.workflow_lane]
				: [],
	}));
	if (
		depthTier === 'L' &&
		laneOwnership.some((lane) => lane.owned.length !== 1)
	) {
		throw new Error(
			'BLOCKED: PR_REVIEW micro dispatch at depth tier L requires one dedicated lane per risk family; consolidated owned_workflow_lanes are allowed only at tiers S and M',
		);
	}
	const flattened = laneOwnership.flatMap((lane) => lane.owned);
	const duplicates = flattened.filter(
		(value, index) => flattened.indexOf(value) !== index,
	);
	const unmatched = flattened.filter((triggerId) => !required.has(triggerId));
	const invalidLabels = laneOwnership
		.filter(
			(lane) => lane.label.length === 0 || !lane.owned.includes(lane.label),
		)
		.map((lane) => lane.label || '(missing workflow_lane)');
	if (
		invalidLabels.length > 0 ||
		duplicates.length > 0 ||
		unmatched.length > 0
	) {
		throw new Error(
			`BLOCKED: PR_REVIEW micro lanes must have unique workflow_lane IDs from the mandatory repository-agnostic lane set, with workflow_lane contained in its own owned set; invalid: ${[
				...new Set([...invalidLabels, ...duplicates, ...unmatched]),
			].join(', ')}`,
		);
	}
	// Per-tier consolidation floor for a FULL micro sweep. Only a batch whose
	// lanes collectively own all eleven risk families is floored — this mirrors
	// the base floor, which binds only the wave that covers every dimension.
	// Partial retry batches (a subset of families) are exempt so re-dispatching a
	// failed family never deadlocks; the aggregate floor on the final attestation
	// (write_pr_review_trigger_eval) catches any split-consolidation that dodges
	// this per-batch check.
	const coversAllFamilies =
		required.size > 0 && [...required].every((id) => flattened.includes(id));
	const microFloor = PR_REVIEW_MICRO_LANE_FLOORS[depthTier];
	if (coversAllFamilies && laneOwnership.length < microFloor) {
		throw new Error(
			`BLOCKED: PR_REVIEW micro dispatch at depth tier ${depthTier} covering all ${PR_REVIEW_REQUIRED_MICRO_LANE_IDS.length} risk families requires at least ${microFloor} lanes; received ${laneOwnership.length}. Partial retry batches covering a subset of families are exempt.`,
		);
	}
}
export type DispatchLanesArgs = z.infer<typeof DispatchLanesArgsSchema>;
export type DispatchLanesAsyncArgs = z.infer<
	typeof DispatchLanesAsyncArgsSchema
>;
export type CollectLaneResultsArgs = z.infer<
	typeof CollectLaneResultsArgsSchema
>;

export type DispatchLaneStatus =
	| 'pending'
	| 'completed'
	| 'failed'
	| 'rejected'
	| 'cancelled'
	| 'stale'
	| 'consumed';

export interface DispatchLaneResult {
	id: string;
	agent: string;
	role: string;
	status: DispatchLaneStatus;
	session_id?: string;
	slot_id?: string;
	run_id?: string;
	started_at: string;
	completed_at: string;
	output?: string;
	output_chars?: number;
	output_truncated?: boolean;
	output_ref?: string;
	output_digest?: string;
	output_preview_chars?: number;
	output_degraded?: boolean;
	output_artifact_error?: string;
	transcript_incomplete?: boolean;
	message_count?: number;
	/**
	 * Set to true when this lane's `output` preview was withheld because an
	 * identical preview (same batch, lane, and result digest) was already
	 * delivered on an earlier `collect_lane_results` poll. All other result
	 * metadata (`output_ref`, `output_digest`, `output_chars`, etc.) is still
	 * present, so callers who need the full text again should retrieve it via
	 * `retrieve_lane_output` using `output_ref` rather than re-polling for it.
	 */
	output_omitted_repeat?: boolean;
	error?: string;
}

export interface DispatchLanesResult {
	success: boolean;
	failure_class?: 'invalid_args' | 'no_client';
	message?: string;
	dispatched: number;
	completed: number;
	failed: number;
	rejected: number;
	max_concurrent: number;
	timeout_ms: number;
	lane_results: DispatchLaneResult[];
	errors?: string[];
}

export interface DispatchLanesAsyncResult {
	success: boolean;
	failure_class?: 'invalid_args' | 'no_client';
	message?: string;
	batch_id: string | null;
	dispatched: number;
	pending: number;
	failed: number;
	rejected: number;
	max_concurrent: number;
	launch_timeout_ms: number;
	/** Deprecated alias for launch_timeout_ms; retained for existing callers. */
	timeout_ms: number;
	lane_results: DispatchLaneResult[];
	errors?: string[];
}

export interface CollectLaneResultsResult {
	success: boolean;
	failure_class?: 'invalid_args' | 'not_found' | 'no_client';
	message?: string;
	batch_id: string;
	total: number;
	completed: number;
	failed: number;
	cancelled: number;
	stale: number;
	pending: number;
	consumed: number;
	all_settled: boolean;
	lane_results: DispatchLaneResult[];
	errors?: string[];
}

export interface SessionOps {
	create(args: {
		body?: { parentID?: string; title?: string };
		query: { directory: string };
	}): Promise<{ data?: { id?: string } | null; error?: unknown }>;
	prompt(args: {
		path: { id: string };
		body: {
			agent: string;
			tools: ReadOnlyToolPermissions;
			parts: Array<{ type: 'text'; text: string }>;
		};
		signal?: AbortSignal;
	}): Promise<{
		data?: { parts?: Array<{ type: string; text?: string }> } | null;
		error?: unknown;
	}>;
	promptAsync?: (args: {
		path: { id: string };
		query?: { directory?: string };
		body: {
			agent: string;
			tools: ReadOnlyToolPermissions;
			parts: Array<{ type: 'text'; text: string }>;
		};
		signal?: AbortSignal;
	}) => Promise<{ data?: unknown; error?: unknown }>;
	messages?: (args: {
		path: { id: string };
		query?: { directory?: string; limit?: number };
	}) => Promise<{
		data?: Array<{
			info?: { role?: string };
			parts?: Array<{ type: string; text?: string }>;
		}> | null;
		error?: unknown;
	}>;
	status?: (args: { query?: { directory?: string } }) => Promise<{
		data?: Record<string, { type?: string }> | null;
		error?: unknown;
	}>;
	abort?: (args: { path: { id: string } }) => Promise<unknown>;
	delete(args: { path: { id: string } }): Promise<unknown>;
}

export const _internals: {
	getSessionOps: () => SessionOps | null;
	getGeneratedAgentNames: () => readonly string[];
	createParallelDispatcher: typeof createParallelDispatcher;
	resolvePrWorkflowRevisionDigestAsync: typeof resolvePrWorkflowRevisionDigestAsync;
	resolveExactMergeBaseAsync: typeof resolveExactMergeBaseAsync;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
} = {
	getSessionOps: () =>
		(swarmState.opencodeClient?.session as unknown as SessionOps | undefined) ??
		null,
	getGeneratedAgentNames: () => swarmState.generatedAgentNames,
	createParallelDispatcher,
	resolvePrWorkflowRevisionDigestAsync,
	resolveExactMergeBaseAsync,
	now: () => Date.now(),
	sleep,
};

export const _test_exports = {
	validatePrReviewMicroDispatch,
	applyCommonPrompt,
	applyExplorerFormatSuffix,
	applyPrWorkflowPromptContract,
	buildReadOnlyTools,
	buildLaneSessionCreateArgs,
	extractAssistantTranscript,
	formatError,
	nextCollectPollInterval,
	promptHash,
	DispatchLanesArgsSchema,
	DispatchLanesAsyncArgsSchema,
	DEFAULT_TIMEOUT_MS,
	DEFAULT_ASYNC_LAUNCH_TIMEOUT_MS,
	DEFAULT_ASYNC_STALE_TIMEOUT_MS,
	DEFAULT_COLLECT_TIMEOUT_MS,
	/**
	 * Clears the module-level `deliveredLaneOutputs` de-dupe set (see
	 * S1.1) so tests can assert first-poll vs. repeat-poll behavior without
	 * cross-test bleed-through.
	 */
	resetDeliveredLaneOutputs: () => {
		deliveredLaneOutputs.clear();
	},
	// Test-only export seam: lets tests exercise the S1.1 output-delivery
	// de-duplication logic directly against in-memory record literals,
	// without round-tripping through the durable delegation store or a
	// SessionOps mock.
	recordToLaneResult,
};

type ReadOnlyToolPermissions = Record<string, false> & {
	write: false;
	edit: false;
	patch: false;
};

interface DispatchLanesExecutionContext {
	callerAgent?: string;
	sessionID?: string;
}

export async function executeDispatchLanes(
	args: unknown,
	directory: string,
	context: DispatchLanesExecutionContext = {},
): Promise<DispatchLanesResult> {
	const parsed = DispatchLanesArgsSchema.safeParse(args);
	if (!parsed.success) {
		return failureResult({
			failure_class: 'invalid_args',
			message: 'Invalid dispatch_lanes arguments',
			errors: boundZodIssues(parsed.error.issues),
		});
	}

	const duplicateLaneIds = findDuplicateLaneIds(parsed.data.lanes);
	if (duplicateLaneIds.length > 0) {
		return failureResult({
			failure_class: 'invalid_args',
			message: 'Lane IDs must be unique within one dispatch_lanes batch',
			errors: duplicateLaneIds.map((id) => `Duplicate lane id: ${id}`),
		});
	}

	if (context.sessionID?.trim()) {
		try {
			await enforcePrWorkflowDispatchLanesAsync(
				directory,
				context.sessionID,
				'dispatch_lanes',
			);
		} catch (error) {
			return failureResult({
				failure_class: 'invalid_args',
				message:
					error instanceof Error
						? error.message
						: 'PR workflow gate rejected dispatch',
			});
		}
	}

	const session = _internals.getSessionOps();
	if (!session) {
		return failureResult({
			failure_class: 'no_client',
			message: 'OpenCode session client is not available',
		});
	}

	const common = applyCommonPrompt(
		parsed.data.lanes,
		parsed.data.common_prompt,
	);
	if (!common.ok) {
		return failureResult({
			failure_class: 'invalid_args',
			message: 'Invalid dispatch_lanes arguments',
			errors: common.errors,
		});
	}
	const lanes = applyExplorerFormatSuffix(common.lanes);
	const maxConcurrent = Math.min(
		parsed.data.max_concurrent ?? lanes.length,
		lanes.length,
		MAX_LANES,
	);
	const timeoutMs = parsed.data.timeout_ms ?? DEFAULT_TIMEOUT_MS;
	const dispatcher = _internals.createParallelDispatcher({
		enabled: true,
		maxConcurrentTasks: maxConcurrent,
		evidenceLockTimeoutMs: 0,
	});
	const limit = pLimit(maxConcurrent);

	try {
		const laneResults = await Promise.all(
			lanes.map((lane) =>
				limit(() =>
					runLane(session, dispatcher, lane, directory, timeoutMs, context),
				),
			),
		);
		return buildResult(laneResults, maxConcurrent, timeoutMs);
	} finally {
		dispatcher.shutdown();
	}
}

export async function executeDispatchLanesAsync(
	args: unknown,
	directory: string,
	context: DispatchLanesExecutionContext = {},
): Promise<DispatchLanesAsyncResult> {
	const parsed = DispatchLanesAsyncArgsSchema.safeParse(args);
	if (!parsed.success) {
		return asyncFailureResult({
			failure_class: 'invalid_args',
			message: 'Invalid dispatch_lanes_async arguments',
			errors: boundZodIssues(parsed.error.issues),
		});
	}

	const duplicateLaneIds = findDuplicateLaneIds(parsed.data.lanes);
	if (duplicateLaneIds.length > 0) {
		return asyncFailureResult({
			failure_class: 'invalid_args',
			message: 'Lane IDs must be unique within one dispatch_lanes_async batch',
			errors: duplicateLaneIds.map((id) => `Duplicate lane id: ${id}`),
		});
	}

	const requestedBatchId = parsed.data.batch_id ?? makeBatchId();
	const session = _internals.getSessionOps();
	if (!session || typeof session.promptAsync !== 'function') {
		return asyncFailureResult({
			failure_class: 'no_client',
			message: 'OpenCode session promptAsync client is not available',
		});
	}

	const common = applyCommonPrompt(
		parsed.data.lanes,
		parsed.data.common_prompt,
	);
	if (!common.ok) {
		return asyncFailureResult({
			failure_class: 'invalid_args',
			message: 'Invalid dispatch_lanes_async arguments',
			errors: common.errors,
		});
	}
	let lanes = common.lanes;
	const batchId = requestedBatchId;
	if (findByBatchId(directory, batchId).length > 0) {
		return asyncFailureResult({
			failure_class: 'invalid_args',
			message: `Async lane batch already exists: ${batchId}`,
			errors: [`batch_id must be unique: ${batchId}`],
		});
	}
	let verifiedPrHead: string | undefined;
	let workflowRevisionDigest: string | undefined;
	let verifiedReviewBaseSha: string | undefined;
	if (
		context.sessionID?.trim() &&
		parsed.data.pr_head_sha &&
		(parsed.data.mode?.startsWith('swarm-pr-review:') ||
			parsed.data.mode?.startsWith('swarm-pr-feedback:'))
	) {
		try {
			verifiedPrHead = await assertCurrentCheckoutHead(
				directory,
				parsed.data.pr_head_sha,
			);
			workflowRevisionDigest =
				(await _internals.resolvePrWorkflowRevisionDigestAsync(
					directory,
					parsed.data.pr_head_sha,
				)) ?? undefined;
			if (!workflowRevisionDigest) {
				throw new Error(
					'BLOCKED: PR workflow could not compute a bounded current-revision digest',
				);
			}
			if (parsed.data.mode?.startsWith('swarm-pr-review:')) {
				if (!parsed.data.base_sha || !parsed.data.base_ref) {
					throw new Error(
						'BLOCKED: PR_REVIEW dispatch requires exact base_sha and base_ref',
					);
				}
				const resolvedBase = await _internals.resolveExactMergeBaseAsync(
					directory,
					parsed.data.base_ref,
					parsed.data.pr_head_sha,
				);
				if (
					!resolvedBase ||
					resolvedBase.toLowerCase() !== parsed.data.base_sha.toLowerCase()
				) {
					throw new Error(
						'BLOCKED: PR_REVIEW base_sha is not the exact merge base of base_ref and pr_head_sha',
					);
				}
				verifiedReviewBaseSha = resolvedBase;
			}
		} catch (error) {
			return asyncFailureResult({
				failure_class: 'invalid_args',
				message:
					error instanceof Error
						? error.message
						: 'PR workflow checkout head verification failed',
			});
		}
	}
	if (context.sessionID?.trim()) {
		try {
			let gateState = await enforcePrWorkflowDispatchLanesAsync(
				directory,
				context.sessionID,
				'dispatch_lanes_async',
			);
			if (!gateState && parsed.data.mode?.startsWith('swarm-pr-review:')) {
				gateState = await activatePrWorkflow(
					directory,
					context.sessionID,
					'PR_REVIEW',
				);
			} else if (
				!gateState &&
				parsed.data.mode === 'swarm-pr-feedback:verification'
			) {
				gateState = await activatePrWorkflow(
					directory,
					context.sessionID,
					'PR_FEEDBACK',
				);
			}
			if (gateState?.mode === 'PR_REVIEW') {
				const headSha = parsed.data.pr_head_sha;
				if (!headSha) {
					throw new Error(
						'BLOCKED: active PR_REVIEW dispatch requires pr_head_sha',
					);
				}
				if (!verifiedReviewBaseSha || !parsed.data.base_ref) {
					throw new Error(
						'BLOCKED: PR_REVIEW exact merge-base scope was not verified',
					);
				}
				gateState = await bindPrReviewBase(directory, context.sessionID, {
					prHeadSha: headSha,
					baseRef: parsed.data.base_ref,
					baseSha: verifiedReviewBaseSha,
				});
				const laneSpecs = parsed.data.lanes.map((lane) => ({
					laneId: lane.id,
					workflowLane: lane.workflow_lane,
					reviewItemIds: lane.review_item_ids,
					ownedWorkflowLanes: lane.owned_workflow_lanes,
				}));
				const depthTier: PrReviewDepthTier = gateState.prReviewDepthTier ?? 'L';
				if (parsed.data.mode === 'swarm-pr-review:base') {
					const isInitialBase =
						(gateState.prReviewBaseDispatches?.length ?? 0) === 0;
					if (isInitialBase) {
						const ownedDimensionIds = parsed.data.lanes.flatMap((lane) =>
							lane.owned_workflow_lanes?.length
								? lane.owned_workflow_lanes
								: lane.workflow_lane
									? [lane.workflow_lane]
									: [],
						);
						const coversAllSixExactlyOnce =
							ownedDimensionIds.length ===
								PR_REVIEW_BASE_DIMENSION_IDS.length &&
							new Set(ownedDimensionIds).size ===
								PR_REVIEW_BASE_DIMENSION_IDS.length &&
							PR_REVIEW_BASE_DIMENSION_IDS.every((dimensionId) =>
								ownedDimensionIds.includes(dimensionId),
							);
						if (depthTier === 'L') {
							if (
								parsed.data.lanes.length !== 6 ||
								parsed.data.max_concurrent !== 6 ||
								parsed.data.lanes.some(
									(lane) => (lane.owned_workflow_lanes?.length ?? 1) !== 1,
								)
							) {
								throw new Error(
									'BLOCKED: initial PR_REVIEW base dispatch requires exactly six lanes and max_concurrent: 6 at depth tier L (consolidated owned_workflow_lanes are allowed only at tiers S and M)',
								);
							}
						} else if (
							!coversAllSixExactlyOnce ||
							parsed.data.lanes.length <
								PR_REVIEW_BASE_LANE_FLOORS[depthTier] ||
							parsed.data.lanes.length > PR_REVIEW_BASE_DIMENSION_IDS.length ||
							parsed.data.max_concurrent !== parsed.data.lanes.length
						) {
							throw new Error(
								`BLOCKED: initial PR_REVIEW base dispatch at depth tier ${depthTier} requires between ${PR_REVIEW_BASE_LANE_FLOORS[depthTier]} and ${PR_REVIEW_BASE_DIMENSION_IDS.length} lanes whose owned_workflow_lanes partition all six dimensions exactly once, with max_concurrent equal to the lane count`,
							);
						}
					}
					for (const lane of parsed.data.lanes) {
						if (
							resolveGeneratedAgentRole(
								lane.agent,
								swarmState.generatedAgentNames,
							) !== 'explorer'
						) {
							throw new Error(
								`BLOCKED: PR_REVIEW base lane "${lane.id}" must use the explorer role`,
							);
						}
					}
					await enforcePrReviewBaseDimensions(
						directory,
						context.sessionID,
						laneSpecs,
						{ batchId, prHeadSha: headSha },
					);
				} else if (parsed.data.mode === 'swarm-pr-review:micro') {
					await assertPrReviewBaseCoverageSettled(directory, context.sessionID);
					if (gateState.prHeadSha && gateState.prHeadSha !== headSha) {
						throw new Error(
							`BLOCKED: PR_REVIEW head mismatch; expected "${gateState.prHeadSha}", received "${headSha}"`,
						);
					}
					for (const lane of parsed.data.lanes) {
						if (
							resolveGeneratedAgentRole(
								lane.agent,
								swarmState.generatedAgentNames,
							) !== 'explorer'
						) {
							throw new Error(
								`BLOCKED: PR_REVIEW micro lane "${lane.id}" must use the explorer role`,
							);
						}
					}
					validatePrReviewMicroDispatch(parsed.data, depthTier);
				} else if (
					parsed.data.mode === 'swarm-pr-review:council' ||
					parsed.data.mode === 'swarm-pr-review:reviewer' ||
					parsed.data.mode === 'swarm-pr-review:critic'
				) {
					const phase = parsed.data.mode.endsWith(':council')
						? 'council'
						: parsed.data.mode.endsWith(':reviewer')
							? 'reviewer'
							: 'critic';
					if (parsed.data.lanes.some((lane) => lane.owned_workflow_lanes)) {
						throw new Error(
							`BLOCKED: PR_REVIEW ${phase} lanes must not declare owned_workflow_lanes; depth-tier consolidation applies only to base and micro discovery lanes`,
						);
					}
					for (const lane of parsed.data.lanes) {
						const role = resolveGeneratedAgentRole(
							lane.agent,
							swarmState.generatedAgentNames,
						);
						if (
							(phase === 'council' && !role.startsWith('council_')) ||
							(phase === 'reviewer' && role !== 'reviewer') ||
							(phase === 'critic' && !role.startsWith('critic'))
						) {
							throw new Error(
								`BLOCKED: PR_REVIEW ${phase} lane "${lane.id}" uses invalid role "${role || lane.agent}"`,
							);
						}
					}
					await recordPrReviewValidationBatch(
						directory,
						context.sessionID,
						phase,
						laneSpecs,
						{ batchId, prHeadSha: headSha },
					);
				} else {
					throw new Error(
						'BLOCKED: active PR_REVIEW requires a structured base, micro, council, reviewer, or critic mode',
					);
				}
			} else if (gateState?.mode === 'PR_FEEDBACK') {
				const headSha = parsed.data.pr_head_sha;
				if (!headSha) {
					throw new Error('BLOCKED: PR_FEEDBACK dispatch requires pr_head_sha');
				}
				if (parsed.data.lanes.some((lane) => lane.owned_workflow_lanes)) {
					throw new Error(
						'BLOCKED: PR_FEEDBACK lanes must not declare owned_workflow_lanes; depth-tier consolidation applies only to PR_REVIEW base and micro discovery lanes',
					);
				}
				if (parsed.data.mode === 'swarm-pr-feedback:verification') {
					await declarePrFeedbackInventory(
						directory,
						context.sessionID,
						parsed.data.feedback_inventory ?? [],
						{ prHeadSha: headSha },
					);
					await enforcePrFeedbackVerificationOwnership(
						directory,
						context.sessionID,
						parsed.data.lanes.map((lane) => ({
							laneId: lane.id,
							ownedItemIds: lane.feedback_item_ids ?? [],
						})),
						{ batchId, prHeadSha: headSha },
					);
				} else if (
					parsed.data.mode === 'swarm-pr-feedback:stage-b-reviewer' ||
					parsed.data.mode === 'swarm-pr-feedback:stage-b-test' ||
					parsed.data.mode === 'swarm-pr-feedback:closeout-reviewer' ||
					parsed.data.mode === 'swarm-pr-feedback:closeout-critic'
				) {
					if (
						parsed.data.lanes.length !== 1 ||
						parsed.data.max_concurrent !== 1
					) {
						throw new Error(
							'BLOCKED: each ordered PR_FEEDBACK gate requires exactly one lane and max_concurrent: 1',
						);
					}
					const phase = parsed.data.mode.slice('swarm-pr-feedback:'.length) as
						| 'stage-b-reviewer'
						| 'stage-b-test'
						| 'closeout-reviewer'
						| 'closeout-critic';
					const lane = parsed.data.lanes[0];
					const role = resolveGeneratedAgentRole(
						lane.agent,
						swarmState.generatedAgentNames,
					);
					const expectedRole =
						phase === 'stage-b-test'
							? 'test_engineer'
							: phase === 'closeout-critic'
								? 'critic'
								: 'reviewer';
					if (
						lane.workflow_lane !== phase ||
						(expectedRole === 'critic'
							? !role.startsWith('critic')
							: role !== expectedRole)
					) {
						throw new Error(
							`BLOCKED: PR_FEEDBACK ${phase} requires workflow_lane "${phase}" and role "${expectedRole}"`,
						);
					}
					await recordPrFeedbackGateBatch(
						directory,
						context.sessionID,
						phase,
						{
							laneId: lane.id,
							ownedItemIds: lane.feedback_item_ids ?? [],
						},
						{
							batchId,
							prHeadSha: headSha,
							revisionDigest: workflowRevisionDigest ?? '',
						},
					);
				} else {
					throw new Error(
						'BLOCKED: active PR_FEEDBACK requires structured verification, Stage B reviewer/test, and closeout reviewer/critic modes',
					);
				}
			}
		} catch (error) {
			return asyncFailureResult({
				failure_class: 'invalid_args',
				message:
					error instanceof Error
						? error.message
						: 'PR workflow gate rejected dispatch',
			});
		}
	}
	const contracted = applyPrWorkflowPromptContract(lanes, {
		mode: parsed.data.mode,
		prHeadSha: verifiedPrHead,
		revisionDigest: workflowRevisionDigest,
		scope: verifiedReviewBaseSha
			? `complete PR diff ${verifiedReviewBaseSha}...${verifiedPrHead}`
			: 'the complete immutable feedback inventory on the exact checked-out revision',
		callerFocus: parsed.data.scope,
	});
	if (!contracted.ok) {
		return asyncFailureResult({
			failure_class: 'invalid_args',
			message: 'Invalid mandatory PR workflow prompt contract',
			errors: contracted.errors,
		});
	}
	lanes = applyExplorerFormatSuffix(contracted.lanes);
	const canonicalWorkflowScope = verifiedReviewBaseSha
		? `complete PR diff ${verifiedReviewBaseSha}...${verifiedPrHead}`
		: parsed.data.mode?.startsWith('swarm-pr-feedback:')
			? 'the complete immutable feedback inventory on the exact checked-out revision'
			: parsed.data.scope;
	const maxConcurrent = Math.min(
		parsed.data.max_concurrent ?? lanes.length,
		lanes.length,
		MAX_LANES,
	);
	const launchTimeoutMs =
		parsed.data.launch_timeout_ms ??
		parsed.data.timeout_ms ??
		DEFAULT_ASYNC_LAUNCH_TIMEOUT_MS;
	const dispatcher = _internals.createParallelDispatcher({
		enabled: true,
		maxConcurrentTasks: maxConcurrent,
		evidenceLockTimeoutMs: 0,
	});
	const limit = pLimit(maxConcurrent);

	try {
		const laneResults = await Promise.all(
			lanes.map((lane) =>
				limit(() =>
					launchAsyncLane({
						session,
						dispatcher,
						lane,
						directory,
						timeoutMs: launchTimeoutMs,
						context,
						batchId,
						mode: parsed.data.mode,
						prHeadSha: parsed.data.pr_head_sha,
						gitHead: verifiedPrHead,
						dirtyHash: workflowRevisionDigest,
						scope: canonicalWorkflowScope,
					}),
				),
			),
		);
		const failed = laneResults.filter((lane) => lane.status === 'failed');
		const rejected = laneResults.filter((lane) => lane.status === 'rejected');
		const pending = laneResults.filter((lane) => lane.status === 'pending');
		return {
			success: failed.length === 0 && rejected.length === 0,
			batch_id: batchId,
			dispatched: laneResults.length,
			pending: pending.length,
			failed: failed.length,
			rejected: rejected.length,
			max_concurrent: maxConcurrent,
			launch_timeout_ms: launchTimeoutMs,
			timeout_ms: launchTimeoutMs,
			lane_results: laneResults,
		};
	} finally {
		dispatcher.shutdown();
	}
}

export async function executeCollectLaneResults(
	args: unknown,
	directory: string,
	context: Pick<DispatchLanesExecutionContext, 'sessionID'> = {},
): Promise<CollectLaneResultsResult> {
	const parsed = CollectLaneResultsArgsSchema.safeParse(args);
	if (!parsed.success) {
		return collectFailureResult({
			failure_class: 'invalid_args',
			batch_id: '',
			message: 'Invalid collect_lane_results arguments',
			errors: boundZodIssues(parsed.error.issues),
		});
	}
	const session = _internals.getSessionOps();
	if (!session || typeof session.messages !== 'function') {
		return collectFailureResult({
			failure_class: 'no_client',
			batch_id: parsed.data.batch_id,
			message: 'OpenCode session messages client is not available',
		});
	}
	const timeoutMs = parsed.data.timeout_ms ?? DEFAULT_COLLECT_TIMEOUT_MS;
	const deadline = _internals.now() + timeoutMs;
	const batchFilter =
		context.sessionID !== undefined
			? { parentSessionId: context.sessionID }
			: undefined;
	let records = findByBatchId(directory, parsed.data.batch_id, batchFilter);
	if (records.length === 0) {
		return collectFailureResult({
			failure_class: 'not_found',
			batch_id: parsed.data.batch_id,
			message: `No async lane batch found for ${parsed.data.batch_id}`,
		});
	}

	let keepPolling = true;
	let pollIntervalMs = COLLECT_POLL_INTERVAL_MS;
	while (keepPolling) {
		await collectOnce(
			session,
			directory,
			records,
			parsed.data.cancel_pending === true,
		);
		await sweepStaleAsyncLaneRecords(
			session,
			directory,
			records,
			DEFAULT_ASYNC_STALE_TIMEOUT_MS,
		);
		records = findByBatchId(directory, parsed.data.batch_id, batchFilter);
		if (allSettled(records) || parsed.data.wait !== true) {
			keepPolling = false;
			continue;
		}
		if (_internals.now() >= deadline) {
			keepPolling = false;
			continue;
		}
		await _internals.sleep(
			Math.min(pollIntervalMs, Math.max(0, deadline - _internals.now())),
		);
		pollIntervalMs = nextCollectPollInterval(pollIntervalMs);
	}

	return buildCollectResult(
		parsed.data.batch_id,
		records,
		parsed.data.include_pending ?? parsed.data.wait !== true,
	);
}

async function launchAsyncLane(args: {
	session: SessionOps;
	dispatcher: ParallelDispatcher;
	lane: DispatchLaneSpec;
	directory: string;
	timeoutMs: number;
	context: DispatchLanesExecutionContext;
	batchId: string;
	mode?: string;
	prHeadSha?: string;
	gitHead?: string;
	dirtyHash?: string;
	scope?: string;
}): Promise<DispatchLaneResult> {
	const validation = validateLaneAgent(args.lane.agent, args.context);
	const role = validation.role;
	const startedAt = isoNow();
	if (!validation.ok) {
		return {
			id: args.lane.id,
			agent: args.lane.agent,
			role,
			status: 'rejected',
			started_at: startedAt,
			completed_at: isoNow(),
			error: validation.error,
		};
	}
	const decision = args.dispatcher.dispatch(args.lane.id);
	if (decision.action !== 'dispatch') {
		return {
			id: args.lane.id,
			agent: args.lane.agent,
			role,
			status: 'failed',
			started_at: startedAt,
			completed_at: isoNow(),
			error: `dispatcher ${decision.action}: ${decision.reason}`,
		};
	}
	try {
		const createTimeoutMessage = `Lane "${args.lane.id}" session.create timed out after ${args.timeoutMs}ms`;
		const createPromise = args.session.create(
			buildLaneSessionCreateArgs(args.directory, args.lane, args.context),
		);
		let createTimedOut = false;
		createPromise
			.then((createResult) => {
				if (createTimedOut && createResult.data?.id) {
					scheduleSessionCleanup(args.session, createResult.data.id);
				}
			})
			.catch(() => undefined);
		const createResult = await withTimeout(
			createPromise,
			args.timeoutMs,
			createTimeoutMessage,
		).catch((error) => {
			if (formatError(error) === createTimeoutMessage) {
				createTimedOut = true;
			}
			throw error;
		});
		const sessionId = createResult.data?.id;
		if (!sessionId) {
			return failedLane(
				args.lane,
				role,
				startedAt,
				`session.create failed: ${formatError(createResult.error)}`,
				decision.slot.slotId,
				decision.slot.runId,
			);
		}

		const pendingRecord = await recordPendingDelegation(args.directory, {
			correlationId: sessionId,
			jobId: null,
			subagentSessionId: sessionId,
			parentSessionId:
				args.context.sessionID ?? `dispatch_lanes_async:${args.batchId}`,
			callID: args.batchId,
			normalizedAgent: role,
			swarmPrefixedAgent: args.lane.agent,
			planTaskId: null,
			evidenceTaskId: null,
			batchId: args.batchId,
			laneId: args.lane.id,
			mode: args.mode ?? 'advisory',
			workflowLane: args.lane.workflow_lane,
			ownedWorkflowLanes: args.lane.owned_workflow_lanes,
			promptHash: promptHash(args.lane, args.directory, args.batchId),
			workspace: {
				directory: args.directory,
				gitHead: args.gitHead ?? null,
				dirtyHash: args.dirtyHash ?? null,
				prHeadSha: args.prHeadSha ?? null,
				scope: args.scope ?? null,
			},
			generation: 1,
		});
		if (!pendingRecord) {
			cleanupAsyncLaunchSession(args.session, sessionId);
			return failedLane(
				args.lane,
				role,
				startedAt,
				'Failed to record async lane in background delegation ledger',
				decision.slot.slotId,
				decision.slot.runId,
			);
		}

		scheduleAsyncLanePrompt({
			session: args.session,
			directory: args.directory,
			sessionId,
			lane: args.lane,
			timeoutMs: args.timeoutMs,
		});

		return {
			id: args.lane.id,
			agent: args.lane.agent,
			role,
			status: 'pending',
			session_id: sessionId,
			slot_id: decision.slot.slotId,
			run_id: decision.slot.runId,
			started_at: startedAt,
			completed_at: isoNow(),
		};
	} catch (error) {
		return failedLane(
			args.lane,
			role,
			startedAt,
			formatError(error),
			decision.slot.slotId,
			decision.slot.runId,
		);
	} finally {
		args.dispatcher.releaseSlot(decision.slot.slotId);
	}
}

async function collectOnce(
	session: SessionOps,
	directory: string,
	records: BackgroundDelegationRecord[],
	cancelPending: boolean,
): Promise<void> {
	for (const record of records) {
		if (record.status !== 'pending' && record.status !== 'running') continue;
		if (cancelPending) {
			if (typeof session.abort === 'function') {
				await session
					.abort({ path: { id: record.subagentSessionId } })
					.catch(() => undefined);
			}
			await appendDelegationTransition(directory, record.correlationId, {
				status: 'cancelled',
			});
			continue;
		}
		const readyForCollection = await isLaneReadyForCollection(
			session,
			directory,
			record.subagentSessionId,
		);
		if (!readyForCollection) continue;
		let messages: Awaited<ReturnType<NonNullable<SessionOps['messages']>>>;
		try {
			messages = await session.messages!({
				path: { id: record.subagentSessionId },
				query: { directory, limit: ASYNC_MESSAGE_FETCH_LIMIT },
			});
		} catch {
			continue;
		}
		if (!messages.data) continue;
		const transcript = extractAssistantTranscript(messages.data);
		if (!transcript.text) continue;
		const collectedRevisionDigest = record.workspace?.prHeadSha
			? ((await _internals.resolvePrWorkflowRevisionDigestAsync(
					directory,
					record.workspace.prHeadSha,
				)) ?? undefined)
			: undefined;
		const output = prepareLaneOutput({
			directory,
			batchId: record.batchId ?? record.callID,
			laneId: record.laneId ?? record.correlationId,
			agent: record.swarmPrefixedAgent,
			role: record.normalizedAgent,
			sessionId: record.subagentSessionId,
			parentSessionId: record.parentSessionId,
			mode: record.mode,
			workflowLane: record.workflowLane,
			prHeadSha: record.workspace?.prHeadSha ?? undefined,
			gitHead: record.workspace?.gitHead ?? undefined,
			revisionDigest: collectedRevisionDigest,
			scope: record.workspace?.scope ?? undefined,
			source: 'collect_lane_results',
			text: transcript.text,
			messageCount: transcript.messageCount,
			transcriptIncomplete: transcript.transcriptIncomplete,
		});
		await appendDelegationTransition(directory, record.correlationId, {
			status: 'completed',
			result: {
				text: output.output,
				chars: output.output_chars,
				truncated: output.output_truncated,
				digest: output.output_digest,
				...(output.output_ref ? { outputRef: output.output_ref } : {}),
				outputPreviewChars: output.output.length,
				...(output.output_degraded !== undefined
					? { outputDegraded: output.output_degraded }
					: {}),
				...(output.output_artifact_error
					? { outputArtifactError: output.output_artifact_error }
					: {}),
				...(output.transcript_incomplete !== undefined
					? { transcriptIncomplete: output.transcript_incomplete }
					: {}),
				messageCount: transcript.messageCount,
			},
		});
	}
}

function scheduleAsyncLanePrompt(args: {
	session: SessionOps;
	directory: string;
	sessionId: string;
	lane: DispatchLaneSpec;
	timeoutMs: number;
}): void {
	queueMicrotask(() => {
		void startAsyncLanePrompt(args).catch(async (error) => {
			const message = formatError(error);
			await appendAsyncLaneLaunchError(
				args.directory,
				args.session,
				args.sessionId,
				message,
			);
		});
	});
}

async function startAsyncLanePrompt(args: {
	session: SessionOps;
	directory: string;
	sessionId: string;
	lane: DispatchLaneSpec;
	timeoutMs: number;
}): Promise<void> {
	const promptController = new AbortController();
	let promptResult: { data?: unknown; error?: unknown };
	try {
		promptResult = await withTimeout(
			args.session.promptAsync!({
				path: { id: args.sessionId },
				query: { directory: args.directory },
				body: {
					agent: args.lane.agent,
					tools: buildReadOnlyTools(),
					parts: [{ type: 'text', text: args.lane.prompt }],
				},
				signal: promptController.signal,
			}),
			args.timeoutMs,
			`Lane "${args.lane.id}" session.promptAsync launch timed out after ${args.timeoutMs}ms`,
			promptController,
		);
	} catch (error) {
		await appendAsyncLaneLaunchError(
			args.directory,
			args.session,
			args.sessionId,
			formatError(error),
		);
		return;
	}
	if (promptResult.error) {
		await appendAsyncLaneLaunchError(
			args.directory,
			args.session,
			args.sessionId,
			`session.promptAsync launch failed: ${formatError(promptResult.error)}`,
		);
		return;
	}
	await appendDelegationTransition(args.directory, args.sessionId, {
		status: 'running',
	});
}

async function appendAsyncLaneLaunchError(
	directory: string,
	session: SessionOps,
	sessionId: string,
	message: string,
): Promise<void> {
	await appendDelegationTransition(directory, sessionId, {
		status: 'error',
		result: {
			error: message,
			chars: message.length,
			truncated: false,
			digest: digestText(message),
		},
	});
	cleanupAsyncLaunchSession(session, sessionId);
}

async function isLaneReadyForCollection(
	session: SessionOps,
	directory: string,
	sessionId: string,
): Promise<boolean> {
	if (typeof session.status !== 'function') return true;
	try {
		const status = await session.status({ query: { directory } });
		if (status.error || !status.data) return false;
		const current = status.data[sessionId];
		return current === undefined || current.type === 'idle';
	} catch {
		return false;
	}
}

async function sweepStaleAsyncLaneRecords(
	session: SessionOps,
	directory: string,
	records: BackgroundDelegationRecord[],
	staleTimeoutMs: number,
): Promise<void> {
	if (staleTimeoutMs <= 0) return;
	const now = _internals.now();
	for (const record of records) {
		if (
			record.status !== 'pending' &&
			record.status !== 'running' &&
			record.status !== 'ingestion_error'
		)
			continue;
		if (now - record.updatedAt <= staleTimeoutMs) continue;
		const readyForCollection = await isLaneReadyForCollection(
			session,
			directory,
			record.subagentSessionId,
		);
		if (!readyForCollection) continue;
		await appendDelegationTransition(directory, record.correlationId, {
			status: 'stale',
		});
	}
}

function extractAssistantTranscript(
	messages: Array<{
		info?: { role?: string };
		parts?: Array<{ type: string; text?: string }>;
	}>,
): { text: string; messageCount: number; transcriptIncomplete: boolean } {
	const assistantTexts: string[] = [];
	for (const message of messages) {
		if (message.info?.role !== 'assistant') continue;
		const text = extractText(message.parts);
		if (text.trim().length > 0) assistantTexts.push(text);
	}
	return {
		text: assistantTexts.join('\n\n'),
		messageCount: assistantTexts.length,
		// Total message count (not just assistant) is the correct signal: the API
		// limit is applied to all message types, so hitting it means there may be
		// earlier messages of any role — including assistant — that were not fetched.
		transcriptIncomplete: messages.length >= ASYNC_MESSAGE_FETCH_LIMIT,
	};
}

function nextCollectPollInterval(currentMs: number): number {
	if (currentMs <= 0) return COLLECT_POLL_INTERVAL_MS;
	return Math.min(currentMs * 2, MAX_COLLECT_POLL_INTERVAL_MS);
}

async function runLane(
	session: SessionOps,
	dispatcher: ParallelDispatcher,
	lane: DispatchLaneSpec,
	directory: string,
	timeoutMs: number,
	context: DispatchLanesExecutionContext,
): Promise<DispatchLaneResult> {
	const validation = validateLaneAgent(lane.agent, context);
	const role = validation.role;
	const startedAt = isoNow();
	if (!validation.ok) {
		return {
			id: lane.id,
			agent: lane.agent,
			role,
			status: 'rejected',
			started_at: startedAt,
			completed_at: isoNow(),
			error: validation.error,
		};
	}

	const decision = dispatcher.dispatch(lane.id);
	if (decision.action !== 'dispatch') {
		return {
			id: lane.id,
			agent: lane.agent,
			role,
			status: 'failed',
			started_at: startedAt,
			completed_at: isoNow(),
			error: `dispatcher ${decision.action}: ${decision.reason}`,
		};
	}

	const promptController = new AbortController();
	let sessionId: string | undefined;
	try {
		const createTimeoutMessage = `Lane "${lane.id}" session.create timed out after ${timeoutMs}ms`;
		const createPromise = session.create(
			buildLaneSessionCreateArgs(directory, lane, context),
		);
		let createTimedOut = false;
		createPromise
			.then((createResult) => {
				if (createTimedOut && createResult.data?.id) {
					scheduleSessionCleanup(session, createResult.data.id);
				}
			})
			.catch(() => undefined);
		const createResult = await withTimeout(
			createPromise,
			timeoutMs,
			createTimeoutMessage,
		).catch((error) => {
			if (formatError(error) === createTimeoutMessage) {
				createTimedOut = true;
			}
			throw error;
		});
		if (!createResult.data?.id) {
			return failedLane(
				lane,
				role,
				startedAt,
				`session.create failed: ${formatError(createResult.error)}`,
				decision.slot.slotId,
				decision.slot.runId,
			);
		}
		sessionId = createResult.data.id;

		const promptResult = await withTimeout(
			session.prompt({
				path: { id: sessionId },
				body: {
					agent: lane.agent,
					tools: buildReadOnlyTools(),
					parts: [{ type: 'text', text: lane.prompt }],
				},
				signal: promptController.signal,
			}),
			timeoutMs,
			`Lane "${lane.id}" session.prompt timed out after ${timeoutMs}ms`,
			promptController,
		);
		if (!promptResult.data) {
			return failedLane(
				lane,
				role,
				startedAt,
				`session.prompt failed: ${formatError(promptResult.error)}`,
				decision.slot.slotId,
				decision.slot.runId,
				sessionId,
			);
		}

		const laneOutput = prepareLaneOutput({
			directory,
			batchId: `blocking:${sessionId}`,
			laneId: lane.id,
			agent: lane.agent,
			role,
			sessionId,
			parentSessionId: context.sessionID,
			source: 'dispatch_lanes',
			text: extractText(promptResult.data.parts),
		});
		return {
			id: lane.id,
			agent: lane.agent,
			role,
			status: 'completed',
			session_id: sessionId,
			slot_id: decision.slot.slotId,
			run_id: decision.slot.runId,
			started_at: startedAt,
			completed_at: isoNow(),
			...laneOutput,
		};
	} catch (error) {
		return failedLane(
			lane,
			role,
			startedAt,
			formatError(error),
			decision.slot.slotId,
			decision.slot.runId,
			sessionId,
		);
	} finally {
		dispatcher.releaseSlot(decision.slot.slotId);
		promptController.abort();
		if (sessionId) {
			scheduleSessionCleanup(session, sessionId);
		}
	}
}

function buildResult(
	laneResults: DispatchLaneResult[],
	maxConcurrent: number,
	timeoutMs: number,
): DispatchLanesResult {
	const completed = laneResults.filter((lane) => lane.status === 'completed');
	const failed = laneResults.filter((lane) => lane.status === 'failed');
	const rejected = laneResults.filter((lane) => lane.status === 'rejected');
	return {
		success: failed.length === 0 && rejected.length === 0,
		dispatched: laneResults.length,
		completed: completed.length,
		failed: failed.length,
		rejected: rejected.length,
		max_concurrent: maxConcurrent,
		timeout_ms: timeoutMs,
		lane_results: laneResults,
	};
}

function buildCollectResult(
	batchId: string,
	records: BackgroundDelegationRecord[],
	includePending: boolean,
): CollectLaneResultsResult {
	const laneResults = records
		.filter(
			(record) =>
				includePending ||
				(record.status !== 'pending' && record.status !== 'running'),
		)
		.map((record) => recordToLaneResult(record, batchId));
	const completed = records.filter((record) => record.status === 'completed');
	const failed = records.filter(
		(record) =>
			record.status === 'error' || record.status === 'ingestion_error',
	);
	const cancelled = records.filter((record) => record.status === 'cancelled');
	const stale = records.filter((record) => record.status === 'stale');
	const pending = records.filter(
		(record) => record.status === 'pending' || record.status === 'running',
	);
	const consumed = records.filter((record) => record.status === 'consumed');
	return {
		success:
			pending.length === 0 &&
			failed.length === 0 &&
			cancelled.length === 0 &&
			stale.length === 0,
		batch_id: batchId,
		total: records.length,
		completed: completed.length,
		failed: failed.length,
		cancelled: cancelled.length,
		stale: stale.length,
		pending: pending.length,
		consumed: consumed.length,
		all_settled: pending.length === 0,
		lane_results: laneResults,
	};
}

function recordToLaneResult(
	record: BackgroundDelegationRecord,
	batchId: string,
): DispatchLaneResult {
	const status =
		record.status === 'error'
			? 'failed'
			: record.status === 'ingestion_error'
				? 'failed'
				: record.status === 'running'
					? 'pending'
					: record.status;
	const laneId = record.laneId ?? record.correlationId;
	// Only settled lanes have a result worth de-duplicating; a pending/running
	// record has no result text anyway. If the digest is missing we fail open
	// (always deliver) rather than risk silently withholding output forever.
	const digest = record.result?.digest;
	const outputRef = record.result?.outputRef?.trim();
	let alreadyDelivered = false;
	if (
		record.result?.text !== undefined &&
		status !== 'pending' &&
		digest &&
		outputRef
	) {
		const key = `${batchId}\0${laneId}\0${digest}`;
		alreadyDelivered = deliveredLaneOutputs.has(key);
		if (!alreadyDelivered) {
			deliveredLaneOutputs.add(key);
			evictDeliveredLaneOutputsIfOverBound();
		}
	}
	return {
		id: laneId,
		agent: record.swarmPrefixedAgent,
		role: record.normalizedAgent,
		status,
		session_id: record.subagentSessionId,
		started_at: new Date(record.createdAt).toISOString(),
		completed_at: new Date(
			record.completedAt ?? record.updatedAt,
		).toISOString(),
		...(record.result?.text !== undefined
			? {
					...(alreadyDelivered
						? { output_omitted_repeat: true }
						: { output: record.result.text }),
					output_chars: record.result.chars,
					output_truncated: record.result.truncated,
					output_digest: record.result.digest,
					...(record.result.outputRef
						? { output_ref: record.result.outputRef }
						: {}),
					...(record.result.outputPreviewChars !== undefined
						? { output_preview_chars: record.result.outputPreviewChars }
						: {}),
					...(record.result.outputDegraded !== undefined
						? { output_degraded: record.result.outputDegraded }
						: {}),
					...(record.result.outputArtifactError
						? { output_artifact_error: record.result.outputArtifactError }
						: {}),
					...(record.result.transcriptIncomplete !== undefined
						? { transcript_incomplete: record.result.transcriptIncomplete }
						: {}),
					...(record.result.messageCount !== undefined
						? { message_count: record.result.messageCount }
						: {}),
				}
			: {}),
		...(record.result?.error !== undefined
			? { error: record.result.error }
			: {}),
	};
}

function allSettled(records: BackgroundDelegationRecord[]): boolean {
	return records.every(
		(record) => record.status !== 'pending' && record.status !== 'running',
	);
}

function failedLane(
	lane: DispatchLaneSpec,
	role: string,
	startedAt: string,
	error: string,
	slotId?: string,
	runId?: string,
	sessionId?: string,
): DispatchLaneResult {
	return {
		id: lane.id,
		agent: lane.agent,
		role,
		status: 'failed',
		session_id: sessionId,
		slot_id: slotId,
		run_id: runId,
		started_at: startedAt,
		completed_at: isoNow(),
		error,
	};
}

function validateLaneAgent(
	agent: string,
	context: DispatchLanesExecutionContext,
): { ok: true; role: string } | { ok: false; role: string; error: string } {
	const generatedAgentNames = _internals.getGeneratedAgentNames();
	const role = resolveGeneratedAgentRole(agent, generatedAgentNames);
	if (!isKnownCanonicalRole(role)) {
		return {
			ok: false,
			role,
			error: `Agent "${agent}" is not registered as a generated swarm agent or canonical role`,
		};
	}
	if (!READ_ONLY_LANE_ROLES.has(role)) {
		return {
			ok: false,
			role,
			error: `Agent role "${role}" is not allowed for read-only lane dispatch`,
		};
	}

	const callerPrefix = context.callerAgent
		? getGeneratedAgentPrefix(context.callerAgent, generatedAgentNames)
		: null;
	if (callerPrefix) {
		const lanePrefix = getGeneratedAgentPrefix(agent, generatedAgentNames);
		if (lanePrefix !== callerPrefix) {
			return {
				ok: false,
				role,
				error: `Agent "${agent}" does not match caller swarm prefix "${callerPrefix}"`,
			};
		}
	}

	return { ok: true, role };
}

function getGeneratedAgentPrefix(
	agent: string,
	generatedAgentNames: readonly string[],
): string | null {
	const role = resolveGeneratedAgentRole(agent, generatedAgentNames);
	if (!isKnownCanonicalRole(role)) return null;
	const normalized = agent.toLowerCase();
	if (normalized === role) return null;
	for (const separator of AGENT_NAME_SEPARATORS) {
		const suffix = `${separator}${role}`;
		if (normalized.endsWith(suffix)) {
			return normalized.slice(0, -suffix.length);
		}
	}
	return null;
}

function buildReadOnlyTools(): ReadOnlyToolPermissions {
	const tools: Record<string, false> = {};
	for (const toolName of READ_ONLY_TOOL_DENYLIST) {
		tools[toolName] = false;
	}
	tools.write = false;
	tools.edit = false;
	tools.patch = false;
	return tools as ReadOnlyToolPermissions;
}

function prepareLaneOutput(args: {
	directory: string;
	batchId: string;
	laneId: string;
	agent: string;
	role: string;
	sessionId?: string;
	parentSessionId?: string;
	mode?: string;
	workflowLane?: string;
	prHeadSha?: string;
	gitHead?: string;
	revisionDigest?: string;
	scope?: string;
	source: 'dispatch_lanes' | 'collect_lane_results';
	text: string;
	messageCount?: number;
	transcriptIncomplete?: boolean;
}): {
	output: string;
	output_chars: number;
	output_truncated: boolean;
	output_ref?: string;
	output_digest: string;
	output_preview_chars: number;
	output_degraded?: boolean;
	output_artifact_error?: string;
	transcript_incomplete?: boolean;
	message_count?: number;
} {
	const stored = storeLaneOutput(args.directory, {
		batchId: args.batchId,
		laneId: args.laneId,
		agent: args.agent,
		role: args.role,
		sessionId: args.sessionId,
		parentSessionId: args.parentSessionId,
		mode: args.mode,
		workflowLane: args.workflowLane,
		prHeadSha: args.prHeadSha,
		gitHead: args.gitHead,
		revisionDigest: args.revisionDigest,
		scope: args.scope,
		source: args.source,
		text: args.text,
		messageCount: args.messageCount,
		transcriptIncomplete: args.transcriptIncomplete,
	});
	const preview = buildLaneOutputPreview({
		text: args.text,
		ref: stored.ref,
		degraded: stored.degraded,
		maxChars: MAX_LANE_OUTPUT_CHARS,
	});
	return {
		...preview,
		output_ref: stored.ref,
		output_digest: stored.digest,
		output_preview_chars: preview.output.length,
		...(stored.degraded ? { output_degraded: true } : {}),
		...(stored.error ? { output_artifact_error: stored.error } : {}),
		...(args.transcriptIncomplete !== undefined
			? { transcript_incomplete: args.transcriptIncomplete }
			: {}),
		...(args.messageCount !== undefined
			? { message_count: args.messageCount }
			: {}),
	};
}

function failureResult(args: {
	failure_class: 'invalid_args' | 'no_client';
	message: string;
	errors?: string[];
}): DispatchLanesResult {
	return {
		success: false,
		failure_class: args.failure_class,
		message: args.message,
		dispatched: 0,
		completed: 0,
		failed: 0,
		rejected: 0,
		max_concurrent: 0,
		timeout_ms: 0,
		lane_results: [],
		errors: args.errors,
	};
}

function asyncFailureResult(args: {
	failure_class: 'invalid_args' | 'no_client';
	message: string;
	errors?: string[];
}): DispatchLanesAsyncResult {
	return {
		success: false,
		failure_class: args.failure_class,
		message: args.message,
		batch_id: null,
		dispatched: 0,
		pending: 0,
		failed: 0,
		rejected: 0,
		max_concurrent: 0,
		launch_timeout_ms: 0,
		timeout_ms: 0,
		lane_results: [],
		errors: args.errors,
	};
}

function collectFailureResult(args: {
	failure_class: 'invalid_args' | 'not_found' | 'no_client';
	batch_id: string;
	message: string;
	errors?: string[];
}): CollectLaneResultsResult {
	return {
		success: false,
		failure_class: args.failure_class,
		message: args.message,
		batch_id: args.batch_id,
		total: 0,
		completed: 0,
		failed: 0,
		cancelled: 0,
		stale: 0,
		pending: 0,
		consumed: 0,
		all_settled: false,
		lane_results: [],
		errors: args.errors,
	};
}

type ApplyCommonPromptResult =
	| { ok: true; lanes: DispatchLaneSpec[] }
	| { ok: false; errors: string[] };

/**
 * Prepend an optional shared `common_prompt` to every lane prompt so callers can
 * send large shared context once instead of inlining it into each lane (which
 * bloats the tool-call payload and triggers truncated/malformed tool-call JSON).
 * Returns an error when any assembled prompt exceeds the per-lane character limit.
 *
 * Always returns a fresh array the caller owns: a shallow copy of the originals
 * when no `commonPrompt` is provided, or shallow-copied lanes with rewritten
 * prompts when it is. Callers may treat the returned array as their own.
 */
function applyCommonPrompt(
	lanes: DispatchLaneSpec[],
	commonPrompt: string | undefined,
): ApplyCommonPromptResult {
	if (!commonPrompt) return { ok: true, lanes: [...lanes] };
	const errors: string[] = [];
	const merged = lanes.map((lane) => {
		const prompt = `${commonPrompt}${COMMON_PROMPT_SEPARATOR}${lane.prompt}`;
		if (prompt.length > MAX_PROMPT_CHARS) {
			errors.push(
				`Lane "${lane.id}" combined common_prompt + prompt is ${prompt.length} chars ` +
					`(common_prompt ${commonPrompt.length} + separator ${COMMON_PROMPT_SEPARATOR.length} + ` +
					`lane prompt ${lane.prompt.length}; max ${MAX_PROMPT_CHARS})`,
			);
		}
		return { ...lane, prompt };
	});
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, lanes: merged };
}

function applyExplorerFormatSuffix(
	lanes: DispatchLaneSpec[],
): DispatchLaneSpec[] {
	const generatedAgentNames = _internals.getGeneratedAgentNames();
	return lanes.map((lane) => {
		const role = resolveGeneratedAgentRole(lane.agent, generatedAgentNames);
		if (role !== 'explorer') return lane;
		if (lane.prompt.includes('[CANDIDATE]')) return lane;
		const exactLane = lane.workflow_lane ?? lane.id;
		const ownedLanes = lane.owned_workflow_lanes?.length
			? lane.owned_workflow_lanes
			: [exactLane];
		const identity =
			ownedLanes.length === 1
				? `every output row MUST use the exact lane value "${ownedLanes[0]}"`
				: `this consolidated lane covers ${ownedLanes.length} obligations — evaluate EVERY one and emit a distinct [CANDIDATE] row set or fully populated [CLEAN] attestation for EACH of: ${ownedLanes
						.map((owned) => `"${owned}"`)
						.join(
							', ',
						)}; every output row MUST use the exact lane value of the obligation it reports`;
		const prompt = `${lane.prompt}

CONTROLLER-BOUND OUTPUT IDENTITY: ${identity}. Placeholder text such as "workflow_lane" is invalid.${EXPLORER_CANDIDATE_FORMAT_SUFFIX}`;
		if (prompt.length > MAX_PROMPT_CHARS) {
			logger.log(
				`[dispatch-lanes] applyExplorerFormatSuffix: lane "${lane.id}" prompt too long ` +
					`(${lane.prompt.length} chars + suffix = ${prompt.length}, max ${MAX_PROMPT_CHARS}); ` +
					`format enforcement skipped — explorer may not emit [CANDIDATE] rows`,
			);
			return lane;
		}
		return { ...lane, prompt };
	});
}

function applyPrWorkflowPromptContract(
	lanes: DispatchLaneSpec[],
	options: {
		mode?: string;
		prHeadSha?: string;
		revisionDigest?: string;
		scope?: string;
		callerFocus?: string;
	},
): ApplyCommonPromptResult {
	const mode = options.mode;
	if (
		!mode?.startsWith('swarm-pr-review:') &&
		!mode?.startsWith('swarm-pr-feedback:')
	) {
		return { ok: true, lanes: [...lanes] };
	}
	if (!options.prHeadSha || !options.revisionDigest) {
		return {
			ok: false,
			errors: [
				'PR workflow prompts require controller-verified head and revision bindings',
			],
		};
	}
	const errors: string[] = [];
	const contracted = lanes.map((lane) => {
		const workflowLane = lane.workflow_lane ?? '';
		const assignedIds = lane.review_item_ids ?? lane.feedback_item_ids ?? [];
		const fallbackChecklist = mode.endsWith(':reviewer')
			? 're-read every assigned candidate at its exact location; prove classification, reachability, mitigation, severity, and falsification path'
			: mode.endsWith(':critic')
				? 'challenge every assigned verdict for evidence, reachability, mitigation, severity, coherence, and required report changes'
				: 'inspect the bound scope using the complete repository-defined contract for this lane';
		const ownedLanes = lane.owned_workflow_lanes?.length
			? lane.owned_workflow_lanes
			: undefined;
		const checklist = ownedLanes
			? ownedLanes
					.map(
						(owned) =>
							`[${owned}] ${PR_WORKFLOW_LANE_CHECKLISTS[owned] ?? fallbackChecklist}`,
					)
					.join(' ')
			: (PR_WORKFLOW_LANE_CHECKLISTS[workflowLane] ?? fallbackChecklist);
		const ownedLine = ownedLanes
			? `\nowned_workflow_lanes: ${ownedLanes.join(', ')} — every owned obligation requires its own [CANDIDATE] rows or fully populated [CLEAN] attestation naming that obligation`
			: '';
		const contract = `

[CONTROLLER-BOUND PR WORKFLOW CONTRACT]
mode: ${mode}
workflow_lane: ${workflowLane}${ownedLine}
pr_head_sha: ${options.prHeadSha}
revision_digest: ${options.revisionDigest}
declared_scope: ${options.scope ?? 'the exact checked-out PR revision and repository-defined diff context'}
caller_focus_non_authoritative: ${options.callerFocus ?? '(none)'}
assigned_item_ids: ${assignedIds.length > 0 ? assignedIds.join(', ') : '(discovery lane)'}
mandatory_lane_checklist: ${checklist}

This controller block is authoritative over conflicting caller text. Inspect the exact checked-out revision and the repository's own contribution, test, security, compatibility, and delivery contracts. Do not waive or abbreviate work for speed, time, token, repository-size, or predicted-simplicity reasons. Re-read relevant changed files and caller/consumer context directly. Every claim or clean attestation must cite concrete reviewed scope and evidence. Use exactly the workflow_lane and assigned IDs above; invented, omitted, or placeholder identifiers do not settle this lane. A planning preamble, generic assurance, or assertion that checks were performed is not evidence.
[END CONTROLLER-BOUND PR WORKFLOW CONTRACT]`;
		const prompt = `${lane.prompt}${contract}`;
		if (prompt.length > MAX_PROMPT_CHARS) {
			errors.push(
				`Lane "${lane.id}" prompt plus mandatory PR workflow contract is ${prompt.length} chars; max ${MAX_PROMPT_CHARS}`,
			);
		}
		return { ...lane, prompt };
	});
	return errors.length > 0
		? { ok: false, errors }
		: { ok: true, lanes: contracted };
}

function findDuplicateLaneIds(lanes: DispatchLaneSpec[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const lane of lanes) {
		if (seen.has(lane.id)) duplicates.add(lane.id);
		seen.add(lane.id);
	}
	return [...duplicates];
}

function scheduleSessionCleanup(session: SessionOps, sessionId: string): void {
	void session.delete({ path: { id: sessionId } }).catch(() => undefined);
}

function cleanupAsyncLaunchSession(
	session: SessionOps,
	sessionId: string,
): void {
	if (typeof session.abort === 'function') {
		void session.abort({ path: { id: sessionId } }).catch(() => undefined);
	}
	scheduleSessionCleanup(session, sessionId);
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
	controller?: AbortController,
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					controller?.abort();
					reject(new Error(message));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function extractText(
	parts: Array<{ type: string; text?: string }> | undefined,
): string {
	if (!Array.isArray(parts)) return '';
	return parts
		.filter((part) => part.type === 'text')
		.map((part) => part.text ?? '')
		.join('\n');
}

function formatError(error: unknown): string {
	if (error instanceof Error) return error.message;
	const text = typeof error === 'string' ? error : String(error);
	return boundErrorString(text);
}

function boundErrorString(text: string): string {
	if (text.length <= MAX_ERROR_CHARS) return text;
	return `${text.slice(0, MAX_ERROR_CHARS)}${ERROR_TRUNCATION_SUFFIX}`;
}

function isoNow(): string {
	return new Date(_internals.now()).toISOString();
}

function buildLaneSessionCreateArgs(
	directory: string,
	lane: DispatchLaneSpec,
	context: Pick<DispatchLanesExecutionContext, 'sessionID'>,
): {
	body: { parentID?: string; title: string };
	query: { directory: string };
} {
	const parentID = context.sessionID?.trim();
	// Escape parentheses in agent name for title to prevent ambiguous nesting
	const escapedAgent = lane.agent
		.replace(/\(/g, '&#40;')
		.replace(/\)/g, '&#41;');
	return {
		body: {
			...(parentID ? { parentID } : {}),
			title: `${lane.id} (${escapedAgent})`,
		},
		query: { directory },
	};
}

function makeBatchId(): string {
	return `lanes-${_internals.now().toString(36)}`;
}

function promptHash(
	lane: DispatchLaneSpec,
	directory: string,
	batchId: string,
): string {
	return digestText(
		JSON.stringify({
			batchId,
			laneId: lane.id,
			agent: lane.agent,
			directory,
			prompt: lane.prompt.replace(/\r\n/g, '\n'),
		}),
	);
}

function digestText(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

function sleep(ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export const dispatch_lanes: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Dispatch multiple read-only exploration/review lanes concurrently and BLOCK until every lane finishes, returning a structured join result. This blocks the caller until completion; for non-blocking dispatch that lets you keep working while lanes run, prefer dispatch_lanes_async + collect_lane_results and use this blocking variant only when promptAsync is unavailable. Keep each lane prompt compact: send large shared context once via common_prompt (or have lanes read it from a file by absolute path) instead of inlining it into every lane prompt.',
		args: {
			lanes: DispatchLanesArgsSchema.shape.lanes,
			common_prompt: DispatchLanesArgsSchema.shape.common_prompt,
			max_concurrent: DispatchLanesArgsSchema.shape.max_concurrent,
			timeout_ms: DispatchLanesArgsSchema.shape.timeout_ms,
		},
		execute: async (args: unknown, directory: string, ctx): Promise<string> => {
			const result = await executeDispatchLanes(args, directory, {
				callerAgent: getContextAgent(ctx),
				sessionID: getContextSessionID(ctx),
			});
			return JSON.stringify(result, null, 2);
		},
	});

export const dispatch_lanes_async: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Launch multiple read-only advisory lanes with OpenCode promptAsync and return IMMEDIATELY with a batch id and lane session handles (non-blocking). launch_timeout_ms only bounds session creation and promptAsync acceptance; it is NOT a lane runtime timeout. After launching, keep working on non-dependent investigation while lanes run — poll incrementally with collect_lane_results (wait omitted or false) to process settled lanes as they complete, or use wait: true only at workflow boundaries where all results are needed. Keep each lane prompt compact: send large shared context once via common_prompt (or have lanes read it from a file by absolute path) instead of inlining it into every lane prompt, which can produce oversized or malformed tool-call JSON.',
		args: {
			lanes: DispatchLanesAsyncArgsSchema.shape.lanes,
			common_prompt: DispatchLanesAsyncArgsSchema.shape.common_prompt,
			max_concurrent: DispatchLanesAsyncArgsSchema.shape.max_concurrent,
			launch_timeout_ms: DispatchLanesAsyncArgsSchema.shape.launch_timeout_ms,
			timeout_ms: DispatchLanesAsyncArgsSchema.shape.timeout_ms,
			batch_id: DispatchLanesAsyncArgsSchema.shape.batch_id,
			mode: DispatchLanesAsyncArgsSchema.shape.mode,
			pr_head_sha: DispatchLanesAsyncArgsSchema.shape.pr_head_sha,
			base_sha: DispatchLanesAsyncArgsSchema.shape.base_sha,
			base_ref: DispatchLanesAsyncArgsSchema.shape.base_ref,
			scope: DispatchLanesAsyncArgsSchema.shape.scope,
			trigger_evaluation: DispatchLanesAsyncArgsSchema.shape.trigger_evaluation,
			feedback_inventory: DispatchLanesAsyncArgsSchema.shape.feedback_inventory,
		},
		execute: async (args: unknown, directory: string, ctx): Promise<string> => {
			const result = await executeDispatchLanesAsync(args, directory, {
				callerAgent: getContextAgent(ctx),
				sessionID: getContextSessionID(ctx),
			});
			return JSON.stringify(result, null, 2);
		},
	});

export const collect_lane_results: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Collect or poll results for a dispatch_lanes_async batch. Supports two modes: (1) non-blocking poll (wait omitted or false) — performs one collection pass and returns current lane status, including pending lane identities by default, and any settled results so you can process completed lanes while continuing independent work; (2) blocking join (wait: true) — polls until all lanes settle or the collection wait budget expires. Busy/retry lanes do not become stale solely because they run for a long time. Does not advance workflow gates.',
		args: {
			batch_id: CollectLaneResultsArgsSchema.shape.batch_id,
			wait: CollectLaneResultsArgsSchema.shape.wait,
			timeout_ms: CollectLaneResultsArgsSchema.shape.timeout_ms,
			include_pending: CollectLaneResultsArgsSchema.shape.include_pending,
			cancel_pending: CollectLaneResultsArgsSchema.shape.cancel_pending,
		},
		execute: async (args: unknown, directory: string, ctx): Promise<string> => {
			const result = await executeCollectLaneResults(args, directory, {
				sessionID: getContextSessionID(ctx),
			});
			return JSON.stringify(result, null, 2);
		},
	});

function getContextAgent(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== 'object') return undefined;
	const value = (ctx as Record<string, unknown>).agent;
	return typeof value === 'string' ? value : undefined;
}

function getContextSessionID(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== 'object') return undefined;
	const value = (ctx as Record<string, unknown>).sessionID;
	return typeof value === 'string' ? value : undefined;
}
