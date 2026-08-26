import { createHash } from 'node:crypto';
import pLimit from 'p-limit';
import { z } from 'zod';
import { getSwarmAgents } from '../agents/index.js';
import {
	CANDIDATE_FIELD_COUNT,
	CANDIDATE_HEADERS,
	CLEAN_FIELD_COUNT,
	CLEAN_TEMPLATES,
} from '../background/candidate-contract.js';
import {
	hasLaneOutputBeenDelivered,
	markLaneOutputDelivered,
	resetLaneDeliveryStoreForTests,
} from '../background/lane-delivery-store.js';
import {
	buildLaneOutputPreview,
	readLaneOutput,
	storeLaneOutput,
} from '../background/lane-output-store.js';
import {
	appendDelegationTransition,
	type BackgroundDelegationRecord,
	type BackgroundDelegationResult,
	type BackgroundDelegationWorkflowLaneRecovery,
	DEFAULT_STALE_DELEGATION_TIMEOUT_MS,
	findByBatchId,
	findByCorrelationId,
	recordPendingDelegationDetailed,
} from '../background/pending-delegations.js';
import {
	encodePrReviewCollectionReceiptFooter,
	encodePrReviewCollectionReceiptShedMarkerFromReceipt,
	MAX_PR_REVIEW_COLLECTION_RECEIPT_ITEM_IDS,
	PR_REVIEW_COLLECTION_RECEIPT_PREFIX,
	PR_REVIEW_COLLECTION_RECEIPT_SHED_PREFIX,
	parsePrReviewCollectionReceiptFooter,
	parsePrReviewCollectionReceiptShedMarker,
	projectPrReviewCollectionReceipt,
	projectPrReviewCollectionReceiptShedMarker,
} from '../background/pr-review-collection-receipt.js';
import { buildPrReviewContractCard } from '../background/pr-review-contract.js';
import {
	PrReviewInlineTriggerRowSchema,
	validatePrReviewInlineTriggerLedger,
} from '../background/pr-review-trigger-contract.js';
import {
	resolveExactMergeBaseAsync,
	resolvePrWorkflowRevisionDigestAsync,
	resolvePrWorkflowRevisionDigestDetailedAsync,
} from '../background/workspace-snapshot.js';
import { WRITE_TOOL_NAMES } from '../config/constants.js';
import { loadPluginConfig } from '../config/loader.js';
import {
	DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
	isKnownCanonicalRole,
	type PrReviewResilienceConfig,
	resolveGeneratedAgentRole,
	stripKnownSwarmPrefix,
} from '../config/schema.js';
import { classifyProviderFailure } from '../failures/invocation-failure.js';
import {
	activatePrWorkflow,
	assertCurrentCheckoutHead,
	assertPrReviewBaseCoverageSettled,
	bindPrReviewBase,
	bindPrReviewTriggerLedger,
	collectPrWorkflowPendingLaneLiveness,
	declarePrFeedbackInventory,
	describePrWorkflowRevisionDigestFailure,
	enforcePrFeedbackVerificationOwnership,
	enforcePrReviewBaseDimensions,
	enforcePrWorkflowDispatchLanesAsync,
	formatPrReviewLaneValidationFailure,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_BASE_LANE_FLOORS,
	PR_REVIEW_MICRO_LANE_FLOORS,
	type PrReviewDepthTier,
	PrReviewResilienceCircuitOpenError,
	PrReviewResilienceRetryExhaustedError,
	type PrReviewVerdictCollectionReceipt,
	type PrWorkflowPendingLaneLiveness,
	readPrWorkflowGateState,
	recordPrFeedbackGateBatch,
	recordPrReviewValidationBatch,
	rollbackPrReviewBaseAdmissionIfUnlaunched,
	validatePrReviewDiscoveryLaneCompletion,
	validatePrWorkflowTransportRecovery,
} from '../hooks/pr-workflow-gate.js';
import { buildLaneOrientationBlock } from '../hooks/repo-graph-injection.js';
import type { ParallelDispatcher } from '../parallel/dispatcher/parallel-dispatcher.js';
import { createParallelDispatcher } from '../parallel/dispatcher/parallel-dispatcher.js';
import { swarmState } from '../state.js';
import { teardownEphemeralSession } from '../utils/ephemeral-session-teardown.js';
import * as logger from '../utils/logger.js';
import { dispatchWithModelFallback } from '../utils/model-dispatch-fallback.js';
import { isTransientProviderError } from '../utils/provider-error-classification.js';
import { createSwarmTool } from './create-tool.js';

export const MAX_LANES = 8;
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
// One canonical staleness horizon across the delegation subsystem (issue #2242
// R2): the gate's presumed-stale lane settlement and this collector must not
// disagree about when a lane counts as abandoned.
const DEFAULT_ASYNC_STALE_TIMEOUT_MS = DEFAULT_STALE_DELEGATION_TIMEOUT_MS;
const DEFAULT_COLLECT_TIMEOUT_MS = DEFAULT_ASYNC_STALE_TIMEOUT_MS;
const MAX_COLLECT_TIMEOUT_MS = 60 * 60_000;
const COLLECT_POLL_INTERVAL_MS = 500;
const MAX_COLLECT_POLL_INTERVAL_MS = 10_000;
const MAX_STATUS_CALL_BUDGET_MS = 2_000;
const PR_REVIEW_WAIT_FINALIZATION_RESERVE_MS = 250;
// #2276: per-lane-kind final-response budgets for swarm-pr-review lanes. All
// derive from the 20_000-char inline preview window (MAX_LANE_OUTPUT_CHARS):
// every budget stays ≥2_000 under it, so a conforming lane's preview is never
// truncated and its terminal machine-readable rows always ride inside the
// preview. These bound ONLY the final response — never investigation volume.
const PR_REVIEW_RESPONSE_BUDGET_CEILING_CHARS = 18_000;
// A base lane owns one of the six full dimensions with multi-file analysis —
// the largest sustainable budget (observed runs need ~18k of row-bearing text).
const PR_REVIEW_BASE_LANE_RESPONSE_BUDGET_CHARS = 18_000;
// A micro family lane owns a narrow scope; 12k matched every successful
// caller-side budget instruction in the observed tier-L run. A consolidated
// micro lane (owned_workflow_lanes, allowed at depth tiers S/M — see the
// dispatch gate that rejects consolidation only at tier L) settles one
// attestation per owned lane, so its budget scales with the owned count.
const PR_REVIEW_MICRO_LANE_RESPONSE_BUDGET_CHARS = 12_000;
const PR_REVIEW_MICRO_PER_OWNED_LANE_CHARS = 2_000;
// A council lane settles a single attestation: the dispatch gate forbids
// owned_workflow_lanes on council/reviewer/critic lanes outright (consolidation
// applies only to base and micro discovery lanes), so its budget is flat.
const PR_REVIEW_COUNCIL_LANE_RESPONSE_BUDGET_CHARS = 12_000;
// Reviewer/critic verdict rows scale with the assigned item count: a floor
// plus a per-item increment, capped at the ceiling.
const PR_REVIEW_VERDICT_RESPONSE_FLOOR_CHARS = 6_000;
const PR_REVIEW_VERDICT_RESPONSE_PER_ITEM_CHARS = 1_500;
// Terminal-output guidance for lanes without a derived budget (the
// swarm-pr-feedback modes, which #2276 leaves on the pre-existing flat cap).
const PR_WORKFLOW_PROTOCOL_OUTPUT_MAX_CHARS = 12_000;
const MAX_ZOD_ISSUES_LISTED = 20;
const MAX_SESSION_CREATE_GENERATIONS = 2;
const MAX_CREATE_FAILURE_WALK_NODES = 64;
const MAX_CREATE_FAILURE_WALK_DEPTH = 6;
const MAX_CREATE_FAILURE_SIGNAL_CHARS = 8_192;

const TRANSIENT_CREATE_STATUS_CODES = new Set([
	408, 429, 500, 502, 503, 504, 529,
]);
const TRANSIENT_CREATE_SIGNAL_PATTERN =
	/\b(?:408|429|500|502|503|504|529)\b|rate.?limit|timeout|timed.?out|overloaded|temporarily.?unavailable|provider[_\s-]?unavailable|server.?error|network.?connection.?lost|connection.?(?:refused|reset|timeout|lost)|bad.?gateway|gateway.?timeout|internal.?server.?error|service.?unavailable|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|broken.?pipe|dns(?:[\s_-]+(?:resolution)?)?[\s_-]+fail|name.?not.?resolved|EAI_AGAIN/i;
const PERMANENT_CREATE_SIGNAL_PATTERN =
	/authentication|unauthori[sz]ed|forbidden|invalid[_\s-]?(?:api[_\s-]?key|token|credential|configuration|config|agent|model)|unknown[_\s-]?(?:agent|model)|unsupported[_\s-]?(?:agent|model)|model.?not.?found|agent.?not.?found|permission.?denied|access.?denied|quota|usage.?limit|insufficient.?(?:quota|credits?)|payment.?required|credit.?balance|out of credits|billing.?(?:hard.?)?limit/i;
const PERMANENT_CREATE_STATUS_CODES = new Set([
	400, 401, 402, 403, 404, 405, 409, 410, 413, 422,
]);
const CREATE_FAILURE_FIELD_KEYS = [
	'status',
	'statusCode',
	'status_code',
	'httpStatus',
	'http_status',
	'code',
	'errorCode',
	'error_code',
	'message',
	'detail',
	'reason',
	'cause',
	'error',
	'response',
	'data',
	'body',
	'details',
	'errors',
	'isRetryable',
	'retryable',
] as const;
const CREATE_FAILURE_SCALAR_KEYS = new Set<string>(CREATE_FAILURE_FIELD_KEYS);
const CREATE_FAILURE_STATUS_KEYS = new Set([
	'status',
	'statusCode',
	'status_code',
	'httpStatus',
	'http_status',
	'code',
	'errorCode',
	'error_code',
	'response',
]);

const AGENT_NAME_SEPARATORS = ['_', '-', ' '] as const;

/**
 * Lane-output redelivery dedupe (issue #1988 C7, plan §7.4).
 * `collect_lane_results` is polled repeatedly by the PR-review protocol; once
 * a settled lane's output has been delivered once, re-delivering the same
 * bounded preview on every subsequent poll is the dominant controller-context
 * driver behind PR-review compaction loops (see S1.1). Delivery state is
 * tracked per `${batchId}\0${laneId}\0${digest}` key so later polls can omit
 * the `output` field (setting `output_omitted_repeat: true` instead) while
 * still returning every other metadata field unchanged.
 *
 * The state lives in `src/background/lane-delivery-store.ts`: keyed by the
 * collecting session and persisted to `.swarm/lane-delivery-cache.json`
 * (bounded 1024 keys, cross-session FIFO, best-effort write, fail-open load)
 * so dedupe survives plugin restarts and compaction cycles within a session.
 * Session keying also removes the old global-Set cross-session false
 * suppression (two sessions reusing batch_id/laneId/digest). `output` is only
 * ever suppressed when BOTH a digest AND a durable ref (`output_ref`,
 * recoverable via `retrieve_lane_output`) are present; if either is missing
 * — e.g. the artifact write failed — delivery falls open and keeps returning
 * the text inline, since there would otherwise be no way to recover it.
 */

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

const CONTROLLER_FIELD_CONTROL_SEPARATOR_PATTERN = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;

function canonicalizeControllerField(value: string): string {
	return value.replace(CONTROLLER_FIELD_CONTROL_SEPARATOR_PATTERN, ' ').trim();
}

type ControllerTokenClassification =
	| { ok: true; token: string }
	| { ok: false; reason: 'empty' | 'multiple' };

function classifyControllerTokenField(
	value: string,
): ControllerTokenClassification {
	const normalized = canonicalizeControllerField(value);
	if (!normalized) return { ok: false, reason: 'empty' };
	const tokens = normalized.split(/\s+/).filter(Boolean);
	if (tokens.length !== 1) return { ok: false, reason: 'multiple' };
	return { ok: true, token: tokens[0] ?? '' };
}

/**
 * Exported so a test can assert the RENDERED contract, not its source text: the
 * pipe-escaping rule is a backslash inside a template literal, where a single
 * backslash is silently dropped and would instruct lanes to emit the exact
 * character that breaks row parsing.
 */
const EXPLORER_CANDIDATE_COMMON_RULES = `

IMPORTANT — OUTPUT FORMAT REQUIREMENT:
You MUST emit findings as a pipe-delimited [CANDIDATE] table. The FIRST
[CANDIDATE]-prefixed line is the literal column header shown below, copied
verbatim with field NAMES as its values; data rows follow it.

Every candidate data row has exactly ${CANDIDATE_FIELD_COUNT} fields after the
marker. A literal pipe inside any field MUST be written as \\| — an unescaped |
starts a new field, and the row is rejected as malformed. The confidence value
is the final data field and must be exactly one token: HIGH, MEDIUM, or LOW.

Candidate IDs must be globally unique across the run; prefix them with the
exact workflow_lane value from this dispatch. Emit the header and machine rows
as plain text, never inside Markdown code fences; fenced rows are ignored as
quoted or example material.`;

const EXPLORER_CANDIDATE_COMMON_END = `
A [CLEAN] row has exactly ${CLEAN_FIELD_COUNT - 1} fields after the marker and NO
confidence field. A [CLEAN] attestation covers exactly ONE obligation (one lane or
micro_lane identity) that has zero findings for it — never alongside [CANDIDATE] rows
for the SAME obligation. A consolidated lane that owns multiple obligations MAY emit
[CLEAN] alongside [CANDIDATE] rows when they are for DIFFERENT obligations: [CANDIDATE]
rows for obligations where it found issues, and a distinct fully-populated [CLEAN]
attestation for each remaining owned obligation that had zero findings; every owned
obligation must receive exactly one of the two.
Write a substantive coverage_scope of at least 12 characters and concrete evidence of at least 20
characters; bare header-only output is UNATTESTED for every PR-review lane.
Do NOT use the default PROJECT/STRUCTURE output format for this dispatch.`;

export const BASE_EXPLORER_CANDIDATE_FORMAT_SUFFIX = `${EXPLORER_CANDIDATE_COMMON_RULES}

BASE WORKED EXAMPLE — copy only this shape. The first line is the header, not a finding:
${CANDIDATE_HEADERS.base_explorer}
[CANDIDATE] | example-base-001 | example-base | MEDIUM | correctness | src/a.ts:12 | claim without pipes | evidence without pipes | impact without pipes | HIGH

If this base explorer finds zero issues, emit its header followed by exactly:
${CLEAN_TEMPLATES.base_explorer}
${EXPLORER_CANDIDATE_COMMON_END}`;

export const MICRO_EXPLORER_CANDIDATE_FORMAT_SUFFIX = `${EXPLORER_CANDIDATE_COMMON_RULES}

MICRO WORKED EXAMPLE — copy only this shape. The first line is the header, not a finding:
${CANDIDATE_HEADERS.micro_lane}
[CANDIDATE] | example-micro-001 | example-micro | MEDIUM | correctness | src/a.ts:12 | claim without pipes | invariant without pipes | evidence without pipes | HIGH

If this micro or council explorer finds zero issues, emit its header followed by exactly:
${CLEAN_TEMPLATES.micro_lane}
${EXPLORER_CANDIDATE_COMMON_END}`;

/** Generic non-PR compatibility contract. PR-review modes use one family only. */
export const EXPLORER_CANDIDATE_FORMAT_SUFFIX = `${EXPLORER_CANDIDATE_COMMON_RULES}

Choose exactly one family from the dispatch context. Never combine fields from
the two families.

BASE WORKED EXAMPLE:
${CANDIDATE_HEADERS.base_explorer}
[CANDIDATE] | example-base-001 | example-base | MEDIUM | correctness | src/a.ts:12 | claim without pipes | evidence without pipes | impact without pipes | HIGH
Zero findings: ${CLEAN_TEMPLATES.base_explorer}

MICRO WORKED EXAMPLE:
${CANDIDATE_HEADERS.micro_lane}
[CANDIDATE] | example-micro-001 | example-micro | MEDIUM | correctness | src/a.ts:12 | claim without pipes | invariant without pipes | evidence without pipes | HIGH
Zero findings: ${CLEAN_TEMPLATES.micro_lane}
${EXPLORER_CANDIDATE_COMMON_END}`;

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
	'critic_finding_validator',
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
		.max(MAX_PR_REVIEW_COLLECTION_RECEIPT_ITEM_IDS)
		.optional()
		.describe(
			'Candidate/finding IDs owned by a PR-review reviewer or critic lane; every ID requires a parseable verdict row',
		),
});

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
	orientation: z
		.boolean()
		.optional()
		.describe(
			'Prepend a bounded, deterministic repo-graph orientation block (mission-relevant files, repo hubs, freshness line) to common_prompt when the repo graph is fresh and relevant. No schema default: availability depends on graph state, resolved at execute time (omitted ⇒ attempted, skipped when no fresh graph exists). Explicitly false disables the block entirely.',
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
		.describe(
			'Advisory workflow mode, such as deep-dive. PR-review stages are COLON-SUFFIXED and the suffix is required. Accepted values: swarm-pr-review:base, swarm-pr-review:micro, swarm-pr-review:council, swarm-pr-review:reviewer, swarm-pr-review:critic, swarm-pr-feedback:verification. A bare "swarm-pr-review" does NOT enter the PR-review path — it skips the merge-base bind and later fails with "exact merge-base scope was not verified".',
		),
	pr_head_sha: z
		.string()
		.min(1)
		.max(80)
		.optional()
		.describe(
			'Full 40-char SHA of the PR head commit under review. Required when mode starts with swarm-pr-review: or swarm-pr-feedback:.',
		),
	base_sha: z
		.string()
		.regex(/^[0-9a-f]{6,64}$/i)
		.optional()
		.describe(
			'Exact merge base of base_ref and pr_head_sha — NOT the base branch tip. The controller recomputes `git merge-base -- <base_ref> <pr_head_sha>` and rejects any mismatch. Required when mode starts with swarm-pr-review:.',
		),
	base_ref: z
		.string()
		.regex(/^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/)
		.optional()
		.describe(
			'Base branch ref used to recompute the merge base. Use the REMOTE-TRACKING form (origin/main), and compute base_sha against that same ref. A local branch ref (main, refs/heads/main) is only as fresh as the last fetch — the PR-review preflight fetches refs/pull/<N>/head and not the base branch, so a local ref commonly resolves to a different merge base and the dispatch is rejected. Required when mode starts with swarm-pr-review:.',
		),
	scope: z.string().min(1).max(500).optional(),
	trigger_evaluation: z
		.array(PrReviewInlineTriggerRowSchema)
		.min(1)
		.optional()
		.describe(
			'Complete repository-agnostic trigger ledger required for the first swarm-pr-review:micro dispatch. The first successful micro dispatch freezes it in same-session workflow state; any subsequent micro batch may omit this property and reuse that exact frozen ledger. If supplied later, it must remain exactly identical. MATCHED families are dispatched and inapplicable families are NOT_TRIGGERED.',
		),
	feedback_inventory: z
		.array(z.string().trim().min(1).max(120))
		.min(1)
		.optional()
		.describe(
			'Complete immutable feedback item inventory required for swarm-pr-feedback:verification',
		),
	pr_review_wave_stage: z
		.enum(['canary', 'fanout'])
		.optional()
		.describe(
			'PR_REVIEW base-only staged dispatch marker. Required with pr_review_wave_attempt at depth tier M or L while pr_review_resilience is enabled. Use "canary" for the singleton probe lane and "fanout" for the follow-up batch that partitions the remaining unresolved base obligations.',
		),
	pr_review_wave_attempt: z
		.number()
		.int()
		.min(0)
		.max(2)
		.optional()
		.describe(
			'PR_REVIEW base-only staged attempt number, required together with pr_review_wave_stage at depth tier M or L while resilience is enabled: attempt 0 is the initial wave, followed by at most two retry attempts (1 and 2) over the exact unresolved-obligation target left by the previous attempt.',
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
			'BLOCKED: initial PR_REVIEW micro dispatch requires the complete trigger_evaluation ledger; after the first successful same-session micro dispatch freezes it, a later micro batch may omit the property and reuse that exact ledger',
		);
	}
	let validated: ReturnType<typeof validatePrReviewInlineTriggerLedger>;
	try {
		validated = validatePrReviewInlineTriggerLedger(evaluation);
	} catch (error) {
		throw new Error(
			`BLOCKED: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const required = new Set<string>(validated.matchedIds);
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
	// Per-tier consolidation floor for a full sweep of the MATCHED set. The
	// ledger still evaluates all eleven families, but NOT_TRIGGERED families are
	// intentionally absent from dispatch and therefore from this floor.
	// Partial retry batches (a subset of families) are exempt so re-dispatching a
	// failed family never deadlocks; the aggregate floor on the final attestation
	// (write_pr_review_trigger_eval) catches any split-consolidation that dodges
	// this per-batch check.
	const coversAllFamilies =
		required.size > 0 && [...required].every((id) => flattened.includes(id));
	const microFloor = Math.min(
		PR_REVIEW_MICRO_LANE_FLOORS[depthTier],
		required.size,
	);
	if (coversAllFamilies && laneOwnership.length < microFloor) {
		throw new Error(
			`BLOCKED: PR_REVIEW micro dispatch at depth tier ${depthTier} covering all ${required.size} matched risk families requires at least ${microFloor} lanes; received ${laneOwnership.length}. Partial retry batches covering a subset of matched families are exempt; NOT_TRIGGERED families must not be dispatched.`,
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
	| 'ingesting'
	| 'consumed';

export interface DispatchLaneResult {
	id: string;
	agent: string;
	role: string;
	status: DispatchLaneStatus;
	session_id?: string;
	slot_id?: string;
	run_id?: string;
	/** One-based session.create attempt that produced this result. */
	generation?: number;
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
	salvaged_workflow_lanes?: string[];
	salvaged_workflow_lane_recoveries?: Array<{
		workflow_lane: string;
		kind: BackgroundDelegationWorkflowLaneRecovery['kind'];
		reason: string;
	}>;
	accepted_review_item_ids?: string[];
	rejected_review_item_ids?: string[];
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
	failure_class?:
		| 'invalid_args'
		| 'no_client'
		| 'circuit_open'
		| 'retry_exhausted';
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
	/**
	 * Alert-only host liveness advisory for still-pending pr-review lanes past
	 * the pending-liveness threshold (issue #2280 Part B). Present only when at
	 * least one such lane exists; never affects `success`, counts, settlement,
	 * or any lane's state.
	 */
	pending_liveness?: PrWorkflowPendingLaneLiveness[];
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
			model?: { providerID: string; modelID: string };
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
			model?: { providerID: string; modelID: string };
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
			info?: {
				role?: string;
				time?: { completed?: number };
				finish?: string;
				error?: unknown;
			};
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
	loadPluginConfig: typeof loadPluginConfig;
	resolvePrWorkflowRevisionDigestAsync: typeof resolvePrWorkflowRevisionDigestAsync;
	resolveExactMergeBaseAsync: typeof resolveExactMergeBaseAsync;
	validatePrWorkflowTransportRecovery: typeof validatePrWorkflowTransportRecovery;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
} = {
	getSessionOps: () =>
		(swarmState.opencodeClient?.session as unknown as SessionOps | undefined) ??
		null,
	getGeneratedAgentNames: () => swarmState.generatedAgentNames,
	createParallelDispatcher,
	loadPluginConfig,
	resolvePrWorkflowRevisionDigestAsync,
	resolveExactMergeBaseAsync,
	validatePrWorkflowTransportRecovery,
	now: () => Date.now(),
	sleep,
};

export const _test_exports = {
	validatePrReviewMicroDispatch,
	applyCommonPrompt,
	applyExplorerFormatSuffix,
	applyPrWorkflowPromptContract,
	augmentCommonPromptWithOrientation,
	buildCollectResult,
	buildReadOnlyTools,
	buildLaneSessionCreateArgs,
	extractAssistantTranscript,
	formatError,
	nextCollectPollInterval,
	promptHash,
	reserveCollectionLaneCallBudgets,
	isRetryableSessionCreateFailure,
	DispatchLanesArgsSchema,
	DispatchLanesAsyncArgsSchema,
	DEFAULT_TIMEOUT_MS,
	DEFAULT_ASYNC_LAUNCH_TIMEOUT_MS,
	DEFAULT_ASYNC_STALE_TIMEOUT_MS,
	DEFAULT_COLLECT_TIMEOUT_MS,
	/**
	 * Clears the lane-output delivery de-dupe state (see S1.1) so tests can
	 * assert first-poll vs. repeat-poll behavior without cross-test
	 * bleed-through. Delegates to the persistent lane-delivery store's
	 * in-memory reset; disk state is untouched.
	 */
	resetDeliveredLaneOutputs: () => {
		resetLaneDeliveryStoreForTests();
	},
	// Test-only export seam: lets tests exercise the S1.1 output-delivery
	// de-duplication logic directly against in-memory record literals,
	// without round-tripping through the durable delegation store or a
	// SessionOps mock.
	recordToLaneResult,
	appendPrReviewCollectionReceipt,
	parsePrReviewCollectionReceipt,
	resolvePrReviewReceiptFallbacks,
	resolvePrReviewReceiptFallbacksFromState,
	consumePrReviewReceiptAppendFailureLog,
	// #2276: pure per-lane-kind budget derivation, exported beside the prompt
	// contract builder so budget scaling can be asserted without prompt-text
	// parsing (file precedent: prompt-construction internals live here).
	prReviewLaneResponseBudgetChars,
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

function effectivePrReviewResilienceConfig(
	configured: PrReviewResilienceConfig,
	gateState?: {
		prReviewResilience?: {
			policy?: {
				enabled: boolean;
				canaryProbeMs: number;
				statusProbeTimeoutMs: number;
				correlatedFailureThreshold: number;
				maxRetryAttemptsAfterInitial: number;
			};
		};
	},
): PrReviewResilienceConfig {
	const policy = gateState?.prReviewResilience?.policy;
	if (!policy) return configured;
	return {
		enabled: policy.enabled,
		canary_probe_ms: policy.canaryProbeMs,
		status_probe_timeout_ms: policy.statusProbeTimeoutMs,
		correlated_failure_threshold: policy.correlatedFailureThreshold,
		max_retry_attempts_after_initial: policy.maxRetryAttemptsAfterInitial,
	};
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

	const orientedCommonPrompt = await augmentCommonPromptWithOrientation(
		directory,
		parsed.data.lanes,
		parsed.data.common_prompt,
		parsed.data.orientation,
		context.sessionID,
	);
	const common = applyCommonPrompt(parsed.data.lanes, orientedCommonPrompt);
	if (!common.ok) {
		return failureResult({
			failure_class: 'invalid_args',
			message: 'Invalid dispatch_lanes arguments',
			errors: common.errors,
		});
	}
	const requiresMandatoryExplorerFormat = common.lanes.some(
		(lane) =>
			lane.workflow_lane !== undefined ||
			(lane.owned_workflow_lanes?.length ?? 0) > 0,
	);
	const formatted = applyExplorerFormatSuffix(common.lanes, {
		failClosed: requiresMandatoryExplorerFormat,
	});
	if (!formatted.ok) {
		return failureResult({
			failure_class: 'invalid_args',
			message: 'Invalid explorer output-format contract',
			errors: formatted.errors,
		});
	}
	const lanes = formatted.lanes;
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
	// Normalize `mode` ONCE, before any consumer reads it. Roughly twenty sites
	// below branch on `parsed.data.mode` with `startsWith` or strict equality, so
	// surrounding whitespace on an otherwise correct value silently misroutes:
	// " swarm-pr-review:base" fails every `startsWith('swarm-pr-review:')` check
	// and skips the merge-base bind entirely, surfacing much later as "exact
	// merge-base scope was not verified" — the merge base blamed for a typo.
	// "swarm-pr-review:base " passes the bind but fails the strict-equality
	// batch-recording branch. Normalizing in one place is what makes that whole
	// near-miss family impossible, instead of closing one literal at a time.
	if (typeof parsed.data.mode === 'string') {
		const normalizedMode = parsed.data.mode.trim();
		parsed.data.mode = normalizedMode.length > 0 ? normalizedMode : undefined;
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

	const orientedCommonPrompt = await augmentCommonPromptWithOrientation(
		directory,
		parsed.data.lanes,
		parsed.data.common_prompt,
		parsed.data.orientation,
		context.sessionID,
	);
	const common = applyCommonPrompt(parsed.data.lanes, orientedCommonPrompt);
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
	// Reject a bare, colon-less PR workflow mode explicitly. Every downstream
	// check keys on the colon-suffixed prefix, so `mode: "swarm-pr-review"` used
	// to slip past the merge-base bind entirely and surface much later as
	// "exact merge-base scope was not verified" — blaming the merge base for what
	// is actually a mode-string typo, while the caller's base_ref/base_sha were
	// correct. The old `mode` description advertised exactly that bad value.
	const bareWorkflowMode = ['swarm-pr-review', 'swarm-pr-feedback'].find(
		(prefix) => parsed.data.mode?.trim() === prefix,
	);
	if (bareWorkflowMode) {
		return asyncFailureResult({
			failure_class: 'invalid_args',
			message:
				bareWorkflowMode === 'swarm-pr-review'
					? 'BLOCKED: mode "swarm-pr-review" is missing its required stage suffix. Use one of: swarm-pr-review:base, swarm-pr-review:micro, swarm-pr-review:council, swarm-pr-review:reviewer, swarm-pr-review:critic.'
					: 'BLOCKED: mode "swarm-pr-feedback" is missing its required stage suffix. Use swarm-pr-feedback:verification.',
		});
	}
	if (
		(parsed.data.pr_review_wave_stage !== undefined ||
			parsed.data.pr_review_wave_attempt !== undefined) &&
		parsed.data.mode !== 'swarm-pr-review:base'
	) {
		return asyncFailureResult({
			failure_class: 'invalid_args',
			message:
				'BLOCKED: pr_review_wave_stage and pr_review_wave_attempt are valid only when mode is exactly "swarm-pr-review:base".',
		});
	}
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
				parsed.data.mode?.startsWith('swarm-pr-feedback:')
					? 'PR_FEEDBACK'
					: 'PR_REVIEW',
			);
			// Issue #1968 P2.2: name the exact bound that fired. The pre-existing
			// `string | null` seam keeps priority when a test injected it, so every
			// existing fixture drives this path unchanged; production takes the
			// discriminated twin and gets a diagnosable reason.
			const resolvedDigest =
				_internals.resolvePrWorkflowRevisionDigestAsync !==
				resolvePrWorkflowRevisionDigestAsync
					? await _internals
							.resolvePrWorkflowRevisionDigestAsync(
								directory,
								parsed.data.pr_head_sha,
							)
							.then((digest) =>
								digest
									? ({ ok: true, digest } as const)
									: ({ ok: false, reason: 'seam-unavailable' } as const),
							)
					: await resolvePrWorkflowRevisionDigestDetailedAsync(
							directory,
							parsed.data.pr_head_sha,
						);
			if (!resolvedDigest.ok) {
				throw new Error(
					'BLOCKED: PR workflow could not compute a bounded current-revision digest for ' +
						`pr_head_sha "${parsed.data.pr_head_sha}"; ` +
						describePrWorkflowRevisionDigestFailure(resolvedDigest),
				);
			}
			workflowRevisionDigest = resolvedDigest.digest;
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
				// Split the two structurally different failures and print the
				// receipt. Collapsing them into one opaque string told a caller
				// whose ref never resolved that their SHA was wrong, and told a
				// caller with a genuine mismatch nothing about what was computed —
				// leaving trial-and-error as the only recovery. The dominant real
				// cause is ref FORM: a local `main` / `refs/heads/main` is whatever
				// the clone last fetched, while `origin/main` is current, so the
				// same base_sha verifies against one and not the other. Mirrors the
				// diagnostic style already used by write-pr-review-trigger-eval and
				// assertCurrentCheckoutHead.
				if (!resolvedBase) {
					throw new Error(
						`BLOCKED: PR_REVIEW could not resolve a merge base for base_ref="${parsed.data.base_ref}" and pr_head_sha=${parsed.data.pr_head_sha} in "${directory}". The ref may not exist locally — the PR-review preflight fetches only refs/pull/<N>/head, not the base branch. Fetch it and pass the remote-tracking form using two separate standalone commands. First run: git -C "${directory}" fetch origin <base-branch>. Then run: git -C "${directory}" merge-base -- origin/<base-branch> ${parsed.data.pr_head_sha}`,
					);
				}
				if (resolvedBase.toLowerCase() !== parsed.data.base_sha.toLowerCase()) {
					throw new Error(
						`BLOCKED: PR_REVIEW merge-base mismatch. git merge-base -- "${parsed.data.base_ref}" ${parsed.data.pr_head_sha} in "${directory}" resolved to ${resolvedBase}, but base_sha=${parsed.data.base_sha} was passed. If you computed base_sha against a remote-tracking ref, pass that SAME ref as base_ref — a local branch of the same name (main, refs/heads/main) may be stale and yields a different merge base. Verify with: git -C "${directory}" merge-base -- "${parsed.data.base_ref}" ${parsed.data.pr_head_sha}`,
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
	if (
		parsed.data.mode?.startsWith('swarm-pr-review:') &&
		!parsed.data.pr_head_sha
	) {
		return asyncFailureResult({
			failure_class: 'invalid_args',
			message: 'BLOCKED: active PR_REVIEW dispatch requires pr_head_sha',
		});
	}
	if (
		parsed.data.mode?.startsWith('swarm-pr-feedback:') &&
		!parsed.data.pr_head_sha
	) {
		return asyncFailureResult({
			failure_class: 'invalid_args',
			message: 'BLOCKED: PR_FEEDBACK dispatch requires pr_head_sha',
		});
	}
	// Validate every controller-owned prompt before publishing gate ownership.
	// A formatting failure must be a side-effect-free invalid request: otherwise
	// an unlaunchable batch consumes durable workflow state and cannot be retried
	// with the same identity.
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
	const formatted = applyExplorerFormatSuffix(contracted.lanes, {
		failClosed: Boolean(
			parsed.data.mode?.startsWith('swarm-pr-review:') ||
				parsed.data.mode?.startsWith('swarm-pr-feedback:'),
		),
		mode: parsed.data.mode,
	});
	if (!formatted.ok) {
		return asyncFailureResult({
			failure_class: 'invalid_args',
			message: 'Invalid mandatory PR workflow explorer output contract',
			errors: formatted.errors,
		});
	}
	lanes = formatted.lanes;
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
					{ requireCheckoutPreflight: true },
				);
			} else if (
				!gateState &&
				parsed.data.mode === 'swarm-pr-feedback:verification'
			) {
				gateState = await activatePrWorkflow(
					directory,
					context.sessionID,
					'PR_FEEDBACK',
					{ requireCheckoutPreflight: true },
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
					const configuredResilience: PrReviewResilienceConfig =
						_internals.loadPluginConfig(directory).pr_review_resilience ??
						DEFAULT_PR_REVIEW_RESILIENCE_CONFIG;
					const effectiveResilience = effectivePrReviewResilienceConfig(
						configuredResilience,
						gateState,
					);
					const waveStage = parsed.data.pr_review_wave_stage;
					const waveAttempt = parsed.data.pr_review_wave_attempt as
						| 0
						| 1
						| 2
						| undefined;
					if ((waveStage === undefined) !== (waveAttempt === undefined)) {
						throw new Error(
							'BLOCKED: PR_REVIEW staged base dispatch requires both pr_review_wave_stage and pr_review_wave_attempt together',
						);
					}
					if (
						waveStage !== undefined &&
						waveAttempt !== undefined &&
						(!effectiveResilience.enabled || depthTier === 'S')
					) {
						throw new Error(
							'BLOCKED: staged PR_REVIEW base dispatch is valid only when pr_review_resilience is enabled at depth tier M or L',
						);
					}
					if (
						effectiveResilience.enabled &&
						depthTier !== 'S' &&
						(waveStage === undefined || waveAttempt === undefined)
					) {
						throw new Error(
							'BLOCKED: PR_REVIEW base dispatch at depth tier M or L requires canary-first pr_review_wave_stage and pr_review_wave_attempt while pr_review_resilience is enabled',
						);
					}
					const stagedBaseDispatch =
						effectiveResilience.enabled &&
						depthTier !== 'S' &&
						waveStage !== undefined &&
						waveAttempt !== undefined;
					const isInitialBase =
						(gateState.prReviewBaseDispatches?.length ?? 0) === 0;
					if (isInitialBase && !stagedBaseDispatch) {
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
									`BLOCKED: initial PR_REVIEW base dispatch requires exactly six lanes and max_concurrent: 6 at depth tier L (consolidated owned_workflow_lanes are allowed only at tiers S and M); each lane owns exactly one dimension and may set workflow_lane to it, omitting owned_workflow_lanes; valid dimensions: ${PR_REVIEW_BASE_DIMENSION_IDS.join(', ')}`,
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
								`BLOCKED: initial PR_REVIEW base dispatch at depth tier ${depthTier} requires between ${PR_REVIEW_BASE_LANE_FLOORS[depthTier]} and ${PR_REVIEW_BASE_DIMENSION_IDS.length} lanes whose owned_workflow_lanes partition all six dimensions exactly once, with max_concurrent equal to the lane count; valid dimensions: ${PR_REVIEW_BASE_DIMENSION_IDS.join(', ')}; a lane with one dimension may set workflow_lane to it and omit owned_workflow_lanes`,
							);
						}
					}
					if (stagedBaseDispatch) {
						if (waveStage === 'canary') {
							if (
								parsed.data.lanes.length !== 1 ||
								parsed.data.max_concurrent !== 1 ||
								parsed.data.lanes.some(
									(lane) => (lane.owned_workflow_lanes?.length ?? 1) !== 1,
								)
							) {
								throw new Error(
									'BLOCKED: PR_REVIEW staged base canary requires exactly one singleton lane and max_concurrent: 1',
								);
							}
						} else if (
							parsed.data.max_concurrent !== parsed.data.lanes.length
						) {
							throw new Error(
								'BLOCKED: PR_REVIEW staged base fanout requires max_concurrent equal to the lane count',
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
						{
							batchId,
							prHeadSha: headSha,
							// Reuse the digest already resolved above (issue #1968 MS-5).
							// The tier-L retry predicate and the batch GC both need
							// per-dimension artifact state; neither may add a fresh
							// synchronous digest resolution to the dispatch path.
							revisionDigest: workflowRevisionDigest,
							prReviewWaveStage: waveStage,
							prReviewWaveAttempt: waveAttempt,
							prReviewResiliencePolicy: effectiveResilience,
						},
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
					const effectiveTriggerEvaluation =
						parsed.data.trigger_evaluation !== undefined
							? parsed.data.trigger_evaluation
							: gateState.prReviewTriggerLedger;
					validatePrReviewMicroDispatch(
						{
							...parsed.data,
							trigger_evaluation: effectiveTriggerEvaluation,
						},
						depthTier,
					);
					gateState = await bindPrReviewTriggerLedger(
						directory,
						context.sessionID,
						effectiveTriggerEvaluation,
					);
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
				failure_class:
					error instanceof PrReviewResilienceCircuitOpenError
						? 'circuit_open'
						: error instanceof PrReviewResilienceRetryExhaustedError
							? 'retry_exhausted'
							: 'invalid_args',
				message:
					error instanceof Error
						? error.message
						: 'PR workflow gate rejected dispatch',
			});
		}
	}
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
		if (
			parsed.data.mode === 'swarm-pr-review:base' &&
			context.sessionID?.trim() &&
			parsed.data.pr_review_wave_stage !== undefined
		) {
			try {
				await rollbackPrReviewBaseAdmissionIfUnlaunched(
					directory,
					context.sessionID,
					batchId,
				);
			} catch (error) {
				logger.log('pr-review base-admission rollback failed', {
					batchId,
					sessionID: context.sessionID,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		}
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
	const timeoutMs = parsed.data.timeout_ms ?? DEFAULT_COLLECT_TIMEOUT_MS;
	const deadline = _internals.now() + timeoutMs;
	const hostTimeouts = new Set<string>();
	// This call processes at most MAX_LANES records, so this per-invocation set
	// is bounded and prevents a persistently unencodable terminal receipt from
	// logging once per wait-loop poll.
	const receiptAppendFailureLogs = new Set<string>();
	// Issue #2349: bounded the same way (at most MAX_LANES entries, keyed by lane
	// label), and self-clearing when a later poll settles the lane successfully.
	const settleFailureLogs = new Set<string>();
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
	const session = _internals.getSessionOps();
	if (!session || typeof session.messages !== 'function') {
		if (
			parsed.data.wait === true &&
			hasActivePrReviewWaitDeadlineLanes(records)
		) {
			const receiptAppendFailureLogs = new Set<string>();
			await finalizePrReviewWaitDeadlineLanes({
				session: session ?? {},
				directory,
				records,
				deadline: _internals.now(),
				receiptAppendFailureLogs,
			});
			records = findByBatchId(directory, parsed.data.batch_id, batchFilter);
			const reviewReceiptFallbacks = await resolvePrReviewReceiptFallbacks(
				directory,
				context.sessionID,
				records,
			);
			const result = buildCollectResult(
				parsed.data.batch_id,
				records,
				parsed.data.include_pending ?? false,
				{
					directory,
					sessionID: context.sessionID,
					reviewReceipts: reviewReceiptFallbacks,
				},
			);
			result.message =
				'OpenCode session messages client was unavailable; active PR_REVIEW lanes were terminalized locally.';
			result.errors = ['OpenCode session messages client is not available'];
			return result;
		}
		return collectFailureResult({
			failure_class: 'no_client',
			batch_id: parsed.data.batch_id,
			message: 'OpenCode session messages client is not available',
		});
	}

	const prReviewWaitFinalizationBudgetMs =
		parsed.data.wait === true
			? reservePrReviewWaitFinalizationBudgetMs(records, timeoutMs)
			: 0;
	const pollingDeadline =
		prReviewWaitFinalizationBudgetMs > 0
			? Math.max(_internals.now(), deadline - prReviewWaitFinalizationBudgetMs)
			: deadline;
	const skipOrdinaryWaitPolling =
		parsed.data.wait === true &&
		hasActivePrReviewWaitDeadlineLanes(records) &&
		(timeoutMs === 0 ||
			(prReviewWaitFinalizationBudgetMs > 0 &&
				prReviewWaitFinalizationBudgetMs >= timeoutMs));

	let keepPolling = true;
	let pollIntervalMs = COLLECT_POLL_INTERVAL_MS;
	if (!skipOrdinaryWaitPolling) {
		while (keepPolling) {
			await collectOnce(
				session,
				directory,
				records,
				parsed.data.cancel_pending === true,
				pollingDeadline,
				hostTimeouts,
				receiptAppendFailureLogs,
				settleFailureLogs,
			);
			await sweepStaleAsyncLaneRecords(
				session,
				directory,
				records,
				DEFAULT_ASYNC_STALE_TIMEOUT_MS,
				pollingDeadline,
				hostTimeouts,
			);
			records = findByBatchId(directory, parsed.data.batch_id, batchFilter);
			if (allSettled(records) || parsed.data.wait !== true) {
				keepPolling = false;
				continue;
			}
			if (_internals.now() >= pollingDeadline) {
				keepPolling = false;
				continue;
			}
			await _internals.sleep(
				Math.min(
					pollIntervalMs,
					Math.max(0, pollingDeadline - _internals.now()),
				),
			);
			pollIntervalMs = nextCollectPollInterval(pollIntervalMs);
		}
	}
	if (
		parsed.data.wait === true &&
		finalizePrReviewWaitDeadlineNeeded(
			records,
			skipOrdinaryWaitPolling,
			pollingDeadline,
		)
	) {
		await finalizePrReviewWaitDeadlineLanes({
			session,
			directory,
			records,
			deadline,
			receiptAppendFailureLogs,
		});
		records = findByBatchId(directory, parsed.data.batch_id, batchFilter);
	}

	const reviewReceiptFallbacks = await resolvePrReviewReceiptFallbacks(
		directory,
		context.sessionID,
		records,
	);
	const result = buildCollectResult(
		parsed.data.batch_id,
		records,
		parsed.data.include_pending ?? parsed.data.wait !== true,
		{
			directory,
			sessionID: context.sessionID,
			reviewReceipts: reviewReceiptFallbacks,
		},
	);
	if (result.pending > 0) {
		// Issue #2280 Part B: alert-only liveness advisory for long-pending
		// pr-review lanes. Fail-open (degrades per lane on any failure), bounded
		// (at most one host probe call, none below the threshold, none beyond
		// the caller's remaining collection budget), and never mutates lane
		// state or blocks collection.
		const pendingLiveness = await collectPrWorkflowPendingLaneLiveness(
			directory,
			records,
			{ probeBudgetMs: Math.max(0, deadline - _internals.now()) },
		);
		if (pendingLiveness.length > 0) {
			result.pending_liveness = pendingLiveness;
		}
	}
	if (hostTimeouts.size > 0) {
		result.message =
			result.pending > 0
				? 'Collection deadline exhausted while waiting for OpenCode host calls; pending lanes remain safe to retry.'
				: 'Collection recovered and settled all lanes despite bounded OpenCode host-call timeouts; no collection retry is required.';
	}
	// Issue #2349: `errors` is assigned from the UNION of host-call timeouts and
	// terminal-settle write failures. `result.message` stays keyed on
	// `hostTimeouts` alone, so a settle failure never mislabels itself as a
	// collection-deadline exhaustion. Assigning inside the `hostTimeouts` block
	// (as this previously did) meant a settle failure with zero host timeouts
	// never surfaced at all — the exact silent-wedge class this issue exists to
	// close.
	const diagnostics = [...hostTimeouts, ...settleFailureLogs];
	if (diagnostics.length > 0) {
		result.errors = diagnostics;
	}
	return result;
}

type LaneSessionCreateOutcome =
	| {
			ok: true;
			sessionId: string;
			generation: number;
			slotId: string;
			runId: string;
	  }
	| {
			ok: false;
			error: string;
			generation: number;
			slotId?: string;
			runId?: string;
	  };

/**
 * Create a child session before any prompt can execute. Only this pre-execution
 * operation is safe to retry. A failed attempt releases its dispatcher slot and
 * synchronously reacquires before the second attempt, preserving the configured
 * concurrency ceiling without introducing an unbounded waiter.
 */
async function createLaneSession(args: {
	session: SessionOps;
	dispatcher: ParallelDispatcher;
	lane: DispatchLaneSpec;
	directory: string;
	timeoutMs: number;
	context: DispatchLanesExecutionContext;
}): Promise<LaneSessionCreateOutcome> {
	let generation = 1;
	let decision = args.dispatcher.dispatch(args.lane.id);
	while (true) {
		if (decision.action !== 'dispatch') {
			return {
				ok: false,
				generation,
				error: `dispatcher ${decision.action}: ${decision.reason}`,
			};
		}

		const createTimeoutMessage = `Lane "${args.lane.id}" session.create timed out after ${args.timeoutMs}ms`;
		let createPromise: ReturnType<SessionOps['create']>;
		try {
			createPromise = args.session.create(
				buildLaneSessionCreateArgs(args.directory, args.lane, args.context),
			);
		} catch (error) {
			createPromise = Promise.reject(error);
		}
		let createTimedOut = false;
		createPromise
			.then((result) => {
				if (createTimedOut && result.data?.id) {
					scheduleSessionCleanup(args.session, result.data.id);
				}
			})
			.catch(() => undefined);

		let failureSignal: unknown;
		let failureMessage: string;
		try {
			const result = await withTimeout(
				createPromise,
				args.timeoutMs,
				createTimeoutMessage,
			);
			if (result.data?.id) {
				return {
					ok: true,
					sessionId: result.data.id,
					generation,
					slotId: decision.slot.slotId,
					runId: decision.slot.runId,
				};
			}
			failureSignal = result.error;
			failureMessage =
				result.error === undefined || result.error === null
					? 'session.create failed: malformed response without a session id'
					: `session.create failed: ${formatError(result.error)}`;
		} catch (error) {
			failureSignal = error;
			failureMessage = formatError(error);
			if (failureMessage === createTimeoutMessage) createTimedOut = true;
		}

		const retryable =
			createTimedOut || isRetryableSessionCreateFailure(failureSignal);
		if (retryable && generation < MAX_SESSION_CREATE_GENERATIONS) {
			// No await may be inserted between these calls: the released capacity is
			// immediately reclaimed for the same lane generation.
			args.dispatcher.releaseSlot(decision.slot.slotId);
			generation++;
			decision = args.dispatcher.dispatch(args.lane.id);
			continue;
		}

		return {
			ok: false,
			error: failureMessage,
			generation,
			slotId: decision.slot.slotId,
			runId: decision.slot.runId,
		};
	}
}

function isRetryableSessionCreateFailure(error: unknown): boolean {
	if (error === undefined || error === null) return false;
	const seen = new WeakSet<object>();
	const pending: Array<{ value: unknown; depth: number; key?: string }> = [
		{ value: error, depth: 0 },
	];
	let visited = 0;
	let signalChars = 0;
	let transient = false;
	let permanent = false;
	let truncated = false;

	while (pending.length > 0 && visited < MAX_CREATE_FAILURE_WALK_NODES) {
		const current = pending.shift()!;
		visited++;
		const { value, depth, key } = current;
		if ((key === 'isRetryable' || key === 'retryable') && value === false) {
			permanent = true;
		}

		if (typeof value === 'number' && Number.isInteger(value)) {
			if (key === undefined || CREATE_FAILURE_STATUS_KEYS.has(key)) {
				if (TRANSIENT_CREATE_STATUS_CODES.has(value)) transient = true;
				if (PERMANENT_CREATE_STATUS_CODES.has(value)) permanent = true;
			}
			continue;
		}
		if (typeof value === 'string') {
			if (key !== undefined && !CREATE_FAILURE_SCALAR_KEYS.has(key)) continue;
			if (
				key !== undefined &&
				CREATE_FAILURE_STATUS_KEYS.has(key) &&
				/^\d+$/.test(value)
			) {
				const numericStatus = Number(value);
				if (TRANSIENT_CREATE_STATUS_CODES.has(numericStatus)) transient = true;
				if (PERMANENT_CREATE_STATUS_CODES.has(numericStatus)) permanent = true;
			}
			const remaining = MAX_CREATE_FAILURE_SIGNAL_CHARS - signalChars;
			if (remaining <= 0) {
				truncated = true;
				continue;
			}
			const signal = value.slice(0, remaining);
			if (signal.length < value.length) truncated = true;
			signalChars += signal.length;
			if (PERMANENT_CREATE_SIGNAL_PATTERN.test(signal)) permanent = true;
			if (TRANSIENT_CREATE_SIGNAL_PATTERN.test(signal)) transient = true;
			continue;
		}
		if (
			(typeof value !== 'object' && typeof value !== 'function') ||
			value === null
		) {
			continue;
		}
		const object = value as object;
		if (seen.has(object)) continue;
		seen.add(object);
		if (depth >= MAX_CREATE_FAILURE_WALK_DEPTH) {
			truncated = true;
			continue;
		}
		let isArray = false;
		try {
			isArray = Array.isArray(object);
		} catch {
			truncated = true;
			continue;
		}
		if (isArray) {
			let arrayLength: number;
			try {
				const lengthDescriptor = Object.getOwnPropertyDescriptor(
					object,
					'length',
				);
				if (
					!lengthDescriptor ||
					!('value' in lengthDescriptor) ||
					typeof lengthDescriptor.value !== 'number' ||
					!Number.isSafeInteger(lengthDescriptor.value) ||
					lengthDescriptor.value < 0
				) {
					truncated = true;
					continue;
				}
				arrayLength = lengthDescriptor.value;
			} catch {
				truncated = true;
				continue;
			}
			const remainingNodes = MAX_CREATE_FAILURE_WALK_NODES - visited;
			const itemCount = Math.min(arrayLength, remainingNodes);
			if (itemCount < arrayLength) truncated = true;
			for (let index = 0; index < itemCount; index++) {
				let descriptor: PropertyDescriptor | undefined;
				try {
					descriptor = Object.getOwnPropertyDescriptor(object, index);
				} catch {
					truncated = true;
					continue;
				}
				if (!descriptor) continue;
				if (!('value' in descriptor)) {
					truncated = true;
					continue;
				}
				pending.push({
					value: descriptor.value,
					depth: depth + 1,
					key,
				});
			}
			continue;
		}
		for (const propertyKey of CREATE_FAILURE_FIELD_KEYS) {
			if (pending.length + visited >= MAX_CREATE_FAILURE_WALK_NODES) {
				truncated = true;
				break;
			}
			let descriptor: PropertyDescriptor | undefined;
			try {
				descriptor = Object.getOwnPropertyDescriptor(object, propertyKey);
			} catch {
				truncated = true;
				continue;
			}
			if (!descriptor) continue;
			if (!('value' in descriptor)) {
				truncated = true;
				continue;
			}
			pending.push({
				value: descriptor.value,
				depth: depth + 1,
				key: propertyKey,
			});
		}
	}

	if (pending.length > 0) truncated = true;
	return transient && !permanent && !truncated;
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
	const create = await createLaneSession({
		session: args.session,
		dispatcher: args.dispatcher,
		lane: args.lane,
		directory: args.directory,
		timeoutMs: args.timeoutMs,
		context: args.context,
	});
	try {
		if (!create.ok) {
			return failedLane(
				args.lane,
				role,
				startedAt,
				create.error,
				create.slotId,
				create.runId,
				undefined,
				create.generation,
			);
		}
		const sessionId = create.sessionId;

		const pendingOutcome = await recordPendingDelegationDetailed(
			args.directory,
			{
				correlationId: sessionId,
				jobId: null,
				subagentSessionId: sessionId,
				parentSessionId:
					args.context.sessionID?.trim() ||
					`dispatch_lanes_async:${args.batchId}`,
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
				generation: create.generation,
			},
		);
		if (
			pendingOutcome.status === 'duplicate' ||
			pendingOutcome.status === 'conflict'
		) {
			return failedLane(
				args.lane,
				role,
				startedAt,
				pendingOutcome.status === 'duplicate'
					? 'Async lane session.create returned an already-recorded correlation id'
					: 'Async lane session.create returned a correlation id owned by a different background delegation',
				create.slotId,
				create.runId,
				sessionId,
				create.generation,
			);
		}
		if (pendingOutcome.status === 'failed') {
			cleanupAsyncLaunchSession(args.session, sessionId);
			return failedLane(
				args.lane,
				role,
				startedAt,
				'Failed to record async lane in background delegation ledger',
				create.slotId,
				create.runId,
				sessionId,
				create.generation,
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
			slot_id: create.slotId,
			run_id: create.runId,
			generation: create.generation,
			started_at: startedAt,
			completed_at: isoNow(),
		};
	} catch (error) {
		return failedLane(
			args.lane,
			role,
			startedAt,
			formatError(error),
			create.slotId,
			create.runId,
			create.ok ? create.sessionId : undefined,
			create.generation,
		);
	} finally {
		if (create.slotId) args.dispatcher.releaseSlot(create.slotId);
	}
}

async function collectOnce(
	session: SessionOps,
	directory: string,
	records: BackgroundDelegationRecord[],
	cancelPending: boolean,
	deadline: number,
	hostTimeouts: Set<string>,
	receiptAppendFailureLogs: Set<string>,
	/**
	 * Issue #2349: lane labels whose terminal-error settle write did NOT land.
	 * Distinct from `hostTimeouts` on purpose — reusing that set would falsely
	 * claim a host-deadline exhaustion in `result.message`. Entries are removed
	 * again when a later poll settles the same lane, so the diagnostic reflects
	 * current state rather than history.
	 */
	settleFailureLogs: Set<string>,
): Promise<void> {
	const activeRecords = records.filter(
		(record) => record.status === 'pending' || record.status === 'running',
	);
	const pendingSettlements: Promise<void>[] = [];
	for (let index = 0; index < activeRecords.length; index++) {
		const record = activeRecords[index];
		const remainingLaneCount = activeRecords.length - index;
		const needsRevisionDigest = Boolean(record.workspace?.prHeadSha);
		const laneBudgets = reserveCollectionLaneCallBudgets(
			deadline,
			remainingLaneCount,
			typeof session.status === 'function',
			needsRevisionDigest,
		);
		if (cancelPending) {
			if (typeof session.abort === 'function') {
				const timeoutCount = hostTimeouts.size;
				try {
					await withCollectionDeadline(
						() => session.abort!({ path: { id: record.subagentSessionId } }),
						deadline,
						`session.abort for lane session "${record.subagentSessionId}"`,
						hostTimeouts,
						laneBudgets.laneBudgetMs,
					);
				} catch {
					// Preserve the old best-effort behavior for ordinary host errors, but
					// never claim cancellation when the abort request itself timed out.
					if (hostTimeouts.size > timeoutCount) continue;
				}
			}
			await appendDelegationTransition(directory, record.correlationId, {
				status: 'cancelled',
			});
			continue;
		}
		const readiness = await getLaneCollectionReadiness(
			session,
			directory,
			record.subagentSessionId,
			deadline,
			hostTimeouts,
			laneBudgets.statusBudgetMs,
		);
		if (readiness === 'busy') continue;
		let messages: Awaited<ReturnType<NonNullable<SessionOps['messages']>>>;
		try {
			messages = await withCollectionDeadline(
				() =>
					session.messages!({
						path: { id: record.subagentSessionId },
						query: { directory, limit: ASYNC_MESSAGE_FETCH_LIMIT },
					}),
				deadline,
				`session.messages for lane "${record.laneId ?? record.correlationId}"`,
				hostTimeouts,
				laneBudgets.messagesBudgetMs,
			);
		} catch {
			continue;
		}
		if (!messages.data) continue;
		const transcript = extractAssistantTranscript(messages.data);
		// Issue #2349: a lane whose backing session died AFTER promptAsync
		// acceptance (provider quota/billing/auth exhaustion at first inference)
		// records an assistant message carrying `info.error` and zero text parts.
		// Before this branch the `!transcript.text` guard below skipped it on
		// every poll, so the lane sat `pending` until the 30-minute presumed-stale
		// sweep or a manual cancel. Settle it here on POSITIVE error evidence.
		//
		// The predicate deliberately does NOT use elapsed time: readiness collapses
		// six distinct conditions (including status-budget exhaustion caused purely
		// by lane pressure) into 'unknown', so a timer would terminalize healthy
		// lanes. Instead it requires a second, independent turn-over discriminator
		// — a stamped `time.completed` OR an affirmative `idle` — either of which
		// rules out a live in-flight retry, which the host models as an ApiError
		// carried on a still-running message.
		if (
			transcript.terminalError &&
			// Load-bearing: a lane that produced REAL OUTPUT must keep taking the
			// existing settlement route below, so partial findings are preserved
			// rather than replaced by an error settle. Dropping this term silently
			// discards the output of any lane that spoke and then died.
			!transcript.text &&
			// NOT `transcriptIncomplete`: that also folds in the terminal
			// finish==='length'/'content-filter' cases, which would make the
			// output_length classification unreachable. Only the fetch-window
			// truncation term is relevant to "did this lane produce no output".
			!transcript.windowTruncated &&
			(Number.isFinite(transcript.completedAt) || readiness === 'idle')
		) {
			const settledStatus =
				transcript.terminalError.kind === 'aborted' ? 'cancelled' : 'error';
			const reason = laneTerminalErrorReason(transcript.terminalError);
			const settled = await appendDelegationTransition(
				directory,
				record.correlationId,
				{
					status: settledStatus,
					result: {
						error: reason,
						chars: reason.length,
						truncated: false,
						digest: digestText(reason),
					},
					expectedCurrentStatuses: ['pending', 'running'],
				},
			);
			const laneLabel = record.laneId ?? record.correlationId;
			if (settled?.status === settledStatus) {
				// Only tear down once the terminal write is CONFIRMED.
				// `appendDelegationTransition` returns null on an exception path and
				// the UNCHANGED record when its CAS/first-terminal guard rejects;
				// deleting the host session in those cases would leave the record
				// open with no readable session — a permanent wedge strictly worse
				// than the bug being fixed.
				settleFailureLogs.delete(laneLabel);
				cleanupAsyncLaunchSession(session, record.subagentSessionId);
			} else if (
				settled !== null &&
				ASYNC_LANE_TERMINAL_STATUSES.has(settled.status)
			) {
				// Benign: the record was ALREADY terminal, so a concurrent writer
				// (the 30-minute stale sweep, an abort, an earlier pass) settled it
				// first and the first-terminal-wins guard correctly rejected ours.
				// The lane is settled either way, so this is not a failure — logging
				// it would cry wolf on every routine race. Teardown belongs to
				// whoever landed the write, so we do not perform it here.
				settleFailureLogs.delete(laneLabel);
			} else {
				// Genuine failure: the write threw (null) or the record is STILL
				// open, so nothing settled it and the reason would otherwise vanish.
				settleFailureLogs.add(laneLabel);
			}
			continue;
		}
		if (!transcript.text) continue;
		if (readiness === 'unknown' && !transcript.terminalAssistantProof) {
			continue;
		}
		// Start digest/validation settlement without awaiting it here. Host status
		// and transcript collection remain ordered and fair, while one slow digest
		// cannot prevent later lanes from receiving their collection opportunity.
		pendingSettlements.push(
			settleCollectedLane({
				directory,
				record,
				transcript,
				deadline,
				hostTimeouts,
				revisionDigestBudgetMs: laneBudgets.revisionDigestBudgetMs,
				receiptAppendFailureLogs,
			}),
		);
	}
	await Promise.all(pendingSettlements);
}

async function settleCollectedLane(args: {
	directory: string;
	record: BackgroundDelegationRecord;
	transcript: ReturnType<typeof extractAssistantTranscript>;
	deadline: number;
	hostTimeouts: Set<string>;
	revisionDigestBudgetMs: number;
	receiptAppendFailureLogs: Set<string>;
}): Promise<void> {
	const {
		directory,
		record,
		transcript,
		deadline,
		hostTimeouts,
		receiptAppendFailureLogs,
	} = args;
	let collectedRevisionDigest: string | undefined;
	const prHeadSha = record.workspace?.prHeadSha;
	if (prHeadSha) {
		try {
			collectedRevisionDigest =
				(await withCollectionDeadline(
					() =>
						_internals.resolvePrWorkflowRevisionDigestAsync(
							directory,
							prHeadSha,
						),
					deadline,
					`revision digest for lane "${record.laneId ?? record.correlationId}"`,
					hostTimeouts,
					args.revisionDigestBudgetMs,
				)) ?? undefined;
		} catch {
			// Without a bounded, current digest the durable artifact cannot be
			// correlated safely. Leave the lane pending; late completion is ignored.
			return;
		}
	}
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
	let prospectiveResult: BackgroundDelegationResult = {
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
	};
	let terminalStatus: 'completed' | 'error' = 'completed';
	if (
		record.mode === 'swarm-pr-review:base' ||
		record.mode === 'swarm-pr-review:micro' ||
		record.mode === 'swarm-pr-review:council'
	) {
		const artifact = output.output_ref
			? (readLaneOutput(directory, output.output_ref)?.artifact ?? null)
			: null;
		const validation = validatePrReviewDiscoveryLaneCompletion({
			record,
			result: prospectiveResult,
			artifact,
			expected: {
				mode: record.mode,
				workflowLane: record.workflowLane ?? '',
				ownedWorkflowLanes: record.ownedWorkflowLanes,
				prHeadSha: record.workspace?.prHeadSha ?? '',
				gitHead: record.workspace?.gitHead ?? '',
				revisionDigest: collectedRevisionDigest ?? '',
				reviewScope: record.workspace?.scope ?? undefined,
			},
		});
		if (validation.ok && validation.salvaged?.length) {
			// Persist the repair on the durable ledger: a salvaged lane is
			// accepted, so nothing downstream would otherwise record that its
			// artifact needed fixing.
			prospectiveResult.salvagedWorkflowLanes = [...validation.salvaged];
			if (validation.recoveries?.length) {
				prospectiveResult.salvagedWorkflowLaneRecoveries = [
					...validation.recoveries,
				];
			}
		}
		if (!validation.ok) {
			// Unknown status reaches settlement only when the transcript itself has
			// terminal assistant proof. That proof is sufficient to persist a
			// deterministic contract failure instead of leaving the lane pending.
			terminalStatus = 'error';
			const family =
				record.mode === 'swarm-pr-review:base' ? 'base_explorer' : 'micro_lane';
			prospectiveResult.error =
				`PR_REVIEW_DISCOVERY_CONTRACT_INVALID: batch=${record.batchId ?? '(missing)'} lane=${record.laneId ?? '(missing)'} workflow_lane=${record.workflowLane ?? '(missing)'} ` +
				`${formatPrReviewLaneValidationFailure(validation.failure)}; expected candidate row: ${CANDIDATE_HEADERS[family]}; expected clean row: ${CLEAN_TEMPLATES[family]}`;
			prospectiveResult.error = prospectiveResult.error.slice(0, 1_024);
		}
	}
	const isPrReviewVerdictLane =
		record.mode === 'swarm-pr-review:reviewer' ||
		record.mode === 'swarm-pr-review:critic';
	if (
		(isPrReviewVerdictLane ||
			record.mode === 'swarm-pr-feedback:verification' ||
			record.mode === 'swarm-pr-feedback:stage-b-reviewer' ||
			record.mode === 'swarm-pr-feedback:stage-b-test' ||
			record.mode === 'swarm-pr-feedback:closeout-reviewer' ||
			record.mode === 'swarm-pr-feedback:closeout-critic') &&
		(isPrReviewVerdictLane ||
			prospectiveResult.truncated === true ||
			prospectiveResult.transcriptIncomplete === true)
	) {
		const artifact = output.output_ref
			? (readLaneOutput(directory, output.output_ref)?.artifact ?? null)
			: null;
		const transportValidationOperation = `transport recovery validation for lane "${record.laneId ?? record.correlationId}"`;
		const transportValidationDeadlineDiagnosticPrefix = `${transportValidationOperation} exceeded the remaining collect_lane_results budget (`;
		let validation:
			| Awaited<ReturnType<typeof validatePrWorkflowTransportRecovery>>
			| undefined;
		try {
			validation = await withCollectionDeadline(
				() =>
					_internals.validatePrWorkflowTransportRecovery({
						directory,
						record,
						result: prospectiveResult,
						artifact,
						revisionDigest: collectedRevisionDigest ?? '',
					}),
				deadline,
				transportValidationOperation,
				hostTimeouts,
			);
		} catch (error) {
			if (
				formatError(error).startsWith(
					transportValidationDeadlineDiagnosticPrefix,
				)
			) {
				return;
			}
			terminalStatus = 'error';
			prospectiveResult.error =
				`PR_WORKFLOW_CONTRACT_INVALID: batch=${record.batchId ?? '(missing)'} lane=${record.laneId ?? '(missing)'} workflow_lane=${record.workflowLane ?? '(missing)'} ` +
				formatError(error);
			prospectiveResult.error = prospectiveResult.error.slice(0, 1_024);
			await appendDelegationTransition(directory, record.correlationId, {
				status: terminalStatus,
				result: prospectiveResult,
			});
			return;
		}
		if (validation.receipt) {
			const resultWithReceipt = appendPrReviewCollectionReceipt(
				record,
				prospectiveResult,
				validation.receipt,
			);
			// Never publish a reviewer/critic terminal status without its exact retry
			// receipt. A later poll can repeat this deterministic in-memory step.
			if (!resultWithReceipt) {
				if (
					consumePrReviewReceiptAppendFailureLog(
						receiptAppendFailureLogs,
						record.parentSessionId,
						record.correlationId,
					)
				) {
					logger.log(
						`[dispatch-lanes] withheld PR-review terminal result without receipt: correlation=${record.correlationId} batch=${record.batchId ?? '(missing)'} lane=${record.laneId ?? '(missing)'}`,
					);
				}
				return;
			}
			prospectiveResult = resultWithReceipt;
		}
		if (!validation.ok) {
			// See the terminal-proof gate in collectOnce: status unavailability must
			// not suppress a conclusive, lane-atomic rejected receipt.
			terminalStatus = 'error';
			const errorCode =
				validation.failure?.predicate === 'reviewer.verdict_rows' ||
				validation.failure?.predicate === 'critic.verdict_rows'
					? 'PR_REVIEW_VERDICT_CONTRACT_INVALID'
					: 'PR_WORKFLOW_CONTRACT_INVALID';
			prospectiveResult.error = `${errorCode}: batch=${record.batchId ?? '(missing)'} lane=${record.laneId ?? '(missing)'} workflow_lane=${record.workflowLane ?? '(missing)'} ${validation.reason}`;
			prospectiveResult.error = prospectiveResult.error.slice(0, 1_024);
		} else if (validation.recoveries?.length) {
			const workflowLane = record.workflowLane?.trim();
			if (workflowLane) {
				prospectiveResult.salvagedWorkflowLanes = [workflowLane];
			}
			prospectiveResult.salvagedWorkflowLaneRecoveries = [
				...(prospectiveResult.salvagedWorkflowLaneRecoveries ?? []),
				...validation.recoveries,
			];
		}
	}
	await appendDelegationTransition(directory, record.correlationId, {
		status: terminalStatus,
		result: prospectiveResult,
	});
}

function isPrReviewWaitTerminalizableMode(mode: string | undefined): boolean {
	return mode?.startsWith('swarm-pr-review:') ?? false;
}

function hasActivePrReviewWaitDeadlineLanes(
	records: readonly BackgroundDelegationRecord[],
): boolean {
	return records.some(
		(record) =>
			(record.status === 'pending' || record.status === 'running') &&
			isPrReviewWaitTerminalizableMode(record.mode),
	);
}

function reservePrReviewWaitFinalizationBudgetMs(
	records: readonly BackgroundDelegationRecord[],
	timeoutMs: number,
): number {
	if (!hasActivePrReviewWaitDeadlineLanes(records)) return 0;
	return Math.min(timeoutMs, PR_REVIEW_WAIT_FINALIZATION_RESERVE_MS);
}

function finalizePrReviewWaitDeadlineNeeded(
	records: readonly BackgroundDelegationRecord[],
	skipOrdinaryWaitPolling: boolean,
	pollingDeadline: number,
): boolean {
	return (
		hasActivePrReviewWaitDeadlineLanes(records) &&
		(skipOrdinaryWaitPolling || _internals.now() >= pollingDeadline)
	);
}

function remainingCollectionBudgetMs(deadline: number): number {
	return Math.max(0, deadline - _internals.now());
}

function getCurrentPrReviewWaitDeadlineCandidate(
	directory: string,
	record: BackgroundDelegationRecord,
): BackgroundDelegationRecord | null {
	const current = findByCorrelationId(directory, record.correlationId);
	if (!current) return null;
	if (current.subagentSessionId !== record.subagentSessionId) return null;
	if ((current.generation ?? 1) !== (record.generation ?? 1)) return null;
	if (current.status !== 'pending' && current.status !== 'running') return null;
	if (!isPrReviewWaitTerminalizableMode(current.mode)) return null;
	return current;
}

function buildPrReviewWaitDeadlineError(args: {
	record: BackgroundDelegationRecord;
	salvageState: string;
	abortState: string;
	detail?: string;
}): string {
	const message =
		`PR_REVIEW_COLLECTION_DEADLINE_EXCEEDED: batch=${args.record.batchId ?? '(missing)'} lane=${args.record.laneId ?? '(missing)'} workflow_lane=${args.record.workflowLane ?? '(missing)'} ` +
		`runtime deadline exceeded during waited collect; ${args.salvageState}; ${args.abortState}` +
		(args.detail ? `; detail=${args.detail}` : '');
	return message.slice(0, 1_024);
}

async function buildPrReviewWaitDeadlineProspectiveResult(args: {
	directory: string;
	record: BackgroundDelegationRecord;
	transcript: ReturnType<typeof extractAssistantTranscript>;
	deadline: number;
	receiptAppendFailureLogs: Set<string>;
}): Promise<{ result: BackgroundDelegationResult; detail?: string }> {
	let collectedRevisionDigest: string | undefined;
	const remainingDigestBudgetMs = remainingCollectionBudgetMs(args.deadline);
	if (remainingDigestBudgetMs > 0 && args.record.workspace?.prHeadSha) {
		try {
			collectedRevisionDigest =
				(await withTimeout(
					_internals.resolvePrWorkflowRevisionDigestAsync(
						args.directory,
						args.record.workspace.prHeadSha,
					),
					remainingDigestBudgetMs,
					`revision digest for lane "${args.record.laneId ?? args.record.correlationId}" exceeded the runtime-deadline finalization budget (${remainingDigestBudgetMs}ms)`,
				)) ?? undefined;
		} catch {
			collectedRevisionDigest = undefined;
		}
	}

	const forcedTranscript = {
		...args.transcript,
		transcriptIncomplete: true,
	};
	const output = prepareLaneOutput({
		directory: args.directory,
		batchId: args.record.batchId ?? args.record.callID,
		laneId: args.record.laneId ?? args.record.correlationId,
		agent: args.record.swarmPrefixedAgent,
		role: args.record.normalizedAgent,
		sessionId: args.record.subagentSessionId,
		parentSessionId: args.record.parentSessionId,
		mode: args.record.mode,
		workflowLane: args.record.workflowLane,
		prHeadSha: args.record.workspace?.prHeadSha ?? undefined,
		gitHead: args.record.workspace?.gitHead ?? undefined,
		revisionDigest: collectedRevisionDigest,
		scope: args.record.workspace?.scope ?? undefined,
		source: 'collect_lane_results',
		text: forcedTranscript.text,
		messageCount: forcedTranscript.messageCount,
		transcriptIncomplete: true,
	});
	let prospectiveResult: BackgroundDelegationResult = {
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
		transcriptIncomplete: true,
		messageCount: forcedTranscript.messageCount,
	};
	let detail: string | undefined;

	if (
		args.record.mode === 'swarm-pr-review:base' ||
		args.record.mode === 'swarm-pr-review:micro' ||
		args.record.mode === 'swarm-pr-review:council'
	) {
		const artifact = output.output_ref
			? (readLaneOutput(args.directory, output.output_ref)?.artifact ?? null)
			: null;
		const validation = validatePrReviewDiscoveryLaneCompletion({
			record: args.record,
			result: prospectiveResult,
			artifact,
			expected: {
				mode: args.record.mode,
				workflowLane: args.record.workflowLane ?? '',
				ownedWorkflowLanes: args.record.ownedWorkflowLanes,
				prHeadSha: args.record.workspace?.prHeadSha ?? '',
				gitHead: args.record.workspace?.gitHead ?? '',
				revisionDigest: collectedRevisionDigest ?? '',
				reviewScope: args.record.workspace?.scope ?? undefined,
			},
		});
		if (validation.ok && validation.salvaged?.length) {
			prospectiveResult.salvagedWorkflowLanes = [...validation.salvaged];
			if (validation.recoveries?.length) {
				prospectiveResult.salvagedWorkflowLaneRecoveries = [
					...validation.recoveries,
				];
			}
		}
		if (!validation.ok) {
			const family =
				args.record.mode === 'swarm-pr-review:base'
					? 'base_explorer'
					: 'micro_lane';
			detail =
				`PR_REVIEW_DISCOVERY_CONTRACT_INVALID: ${formatPrReviewLaneValidationFailure(validation.failure)}; expected candidate row: ${CANDIDATE_HEADERS[family]}; expected clean row: ${CLEAN_TEMPLATES[family]}`.slice(
					0,
					800,
				);
		}
	}

	const isPrReviewVerdictLane =
		args.record.mode === 'swarm-pr-review:reviewer' ||
		args.record.mode === 'swarm-pr-review:critic';
	if (isPrReviewVerdictLane) {
		const artifact = output.output_ref
			? (readLaneOutput(args.directory, output.output_ref)?.artifact ?? null)
			: null;
		const remainingValidationBudgetMs = remainingCollectionBudgetMs(
			args.deadline,
		);
		if (remainingValidationBudgetMs <= 0) {
			detail =
				'PR_WORKFLOW_CONTRACT_INVALID: transport recovery validation skipped because the runtime-deadline finalization budget was exhausted';
		} else {
			try {
				const validation = await withTimeout(
					_internals.validatePrWorkflowTransportRecovery({
						directory: args.directory,
						record: args.record,
						result: prospectiveResult,
						artifact,
						revisionDigest: collectedRevisionDigest ?? '',
					}),
					remainingValidationBudgetMs,
					`transport recovery validation for lane "${args.record.laneId ?? args.record.correlationId}" exceeded the runtime-deadline finalization budget (${remainingValidationBudgetMs}ms)`,
				);
				if (validation.receipt) {
					const resultWithReceipt = appendPrReviewCollectionReceipt(
						args.record,
						prospectiveResult,
						validation.receipt,
					);
					if (resultWithReceipt) {
						prospectiveResult = resultWithReceipt;
					} else if (
						consumePrReviewReceiptAppendFailureLog(
							args.receiptAppendFailureLogs,
							args.record.parentSessionId,
							args.record.correlationId,
						)
					) {
						logger.log(
							`[dispatch-lanes] withheld PR-review terminal result without receipt during runtime-deadline finalization: correlation=${args.record.correlationId} batch=${args.record.batchId ?? '(missing)'} lane=${args.record.laneId ?? '(missing)'}`,
						);
					}
				}
				if (!validation.ok) {
					const errorCode =
						validation.failure?.predicate === 'reviewer.verdict_rows' ||
						validation.failure?.predicate === 'critic.verdict_rows'
							? 'PR_REVIEW_VERDICT_CONTRACT_INVALID'
							: 'PR_WORKFLOW_CONTRACT_INVALID';
					detail = `${errorCode}: ${validation.reason}`.slice(0, 800);
				} else if (validation.recoveries?.length) {
					const workflowLane = args.record.workflowLane?.trim();
					if (workflowLane) {
						prospectiveResult.salvagedWorkflowLanes = [workflowLane];
					}
					prospectiveResult.salvagedWorkflowLaneRecoveries = [
						...(prospectiveResult.salvagedWorkflowLaneRecoveries ?? []),
						...validation.recoveries,
					];
				}
			} catch (error) {
				detail = `PR_WORKFLOW_CONTRACT_INVALID: ${formatError(error)}`.slice(
					0,
					800,
				);
			}
		}
	}

	return { result: prospectiveResult, detail };
}

async function finalizePrReviewWaitDeadlineLanes(args: {
	session: Pick<SessionOps, 'messages' | 'abort'>;
	directory: string;
	records: readonly BackgroundDelegationRecord[];
	deadline: number;
	receiptAppendFailureLogs: Set<string>;
}): Promise<void> {
	for (const record of args.records) {
		const current = getCurrentPrReviewWaitDeadlineCandidate(
			args.directory,
			record,
		);
		if (!current) continue;

		let prospectiveResult: BackgroundDelegationResult | undefined;
		let detail: string | undefined;
		let salvageState = 'salvage_skipped=no_budget';
		let abortState = 'abort_skipped=no_budget';

		const transcriptBudgetMs = remainingCollectionBudgetMs(args.deadline);
		if (transcriptBudgetMs > 0) {
			try {
				const messages = await withTimeout(
					args.session.messages!({
						path: { id: current.subagentSessionId },
						query: {
							directory: args.directory,
							limit: ASYNC_MESSAGE_FETCH_LIMIT,
						},
					}),
					transcriptBudgetMs,
					`session.messages for lane "${current.laneId ?? current.correlationId}" exceeded the runtime-deadline finalization budget (${transcriptBudgetMs}ms)`,
				);
				if (messages.data) {
					const transcript = extractAssistantTranscript(messages.data);
					if (transcript.text) {
						salvageState = 'salvage_attempted=partial_transcript';
						const built = await buildPrReviewWaitDeadlineProspectiveResult({
							directory: args.directory,
							record: current,
							transcript,
							deadline: args.deadline,
							receiptAppendFailureLogs: args.receiptAppendFailureLogs,
						});
						prospectiveResult = built.result;
						detail = built.detail;
					} else {
						// Issue #2349: same defect class as the steady-state loop —
						// the error evidence was already in hand and discarded, so the
						// operator saw only "empty output" and never the reason. This
						// site already terminalizes at deadline, so naming the cause is
						// a DISCLOSURE improvement, not a settlement change.
						salvageState = transcript.terminalError
							? `salvage_skipped=provider_error:${transcript.terminalError.category}`
							: 'salvage_skipped=empty_output';
					}
				} else {
					salvageState = 'salvage_skipped=no_messages';
				}
			} catch {
				salvageState = 'salvage_skipped=host_timeout';
			}
		}

		const currentBeforeAbort = getCurrentPrReviewWaitDeadlineCandidate(
			args.directory,
			record,
		);
		const abortBudgetMs = remainingCollectionBudgetMs(args.deadline);
		if (
			currentBeforeAbort &&
			abortBudgetMs > 0 &&
			typeof args.session.abort === 'function'
		) {
			try {
				await withTimeout(
					args.session.abort({
						path: { id: currentBeforeAbort.subagentSessionId },
					}),
					abortBudgetMs,
					`session.abort for lane session "${currentBeforeAbort.subagentSessionId}" exceeded the runtime-deadline finalization budget (${abortBudgetMs}ms)`,
				);
				abortState = 'abort_attempted=best_effort';
			} catch {
				abortState = 'abort_failed=budget_or_host_error';
			}
		}

		const finalError = buildPrReviewWaitDeadlineError({
			record: current,
			salvageState,
			abortState,
			detail,
		});
		const terminalResult =
			prospectiveResult ??
			({
				error: finalError,
				chars: finalError.length,
				truncated: false,
				digest: digestText(finalError),
			} satisfies BackgroundDelegationResult);
		terminalResult.error = finalError;
		await appendDelegationTransition(args.directory, current.correlationId, {
			status: 'error',
			result: terminalResult,
			expectedCurrentStatuses: ['pending', 'running'],
		});
	}
}

function consumePrReviewReceiptAppendFailureLog(
	loggedFailures: Set<string>,
	parentSessionId: string,
	correlationId: string,
): boolean {
	const key = `${parentSessionId}\u0000${correlationId}`;
	if (loggedFailures.has(key)) return false;
	loggedFailures.add(key);
	return true;
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
	const baseRole = stripKnownSwarmPrefix(args.lane.agent);
	const swarmID =
		baseRole !== args.lane.agent
			? args.lane.agent.slice(0, args.lane.agent.length - baseRole.length - 1)
			: undefined;
	const swarmAgents = getSwarmAgents(swarmID);
	let promptResult: { data?: unknown; error?: unknown };
	try {
		const dispatched = await dispatchWithModelFallback({
			dispatch: async (model, context) => {
				const result = await withTimeout(
					args.session.promptAsync!({
						path: { id: args.sessionId },
						query: { directory: args.directory },
						body: {
							agent: args.lane.agent,
							...(model ? { model } : {}),
							tools: buildReadOnlyTools(),
							parts: [{ type: 'text', text: args.lane.prompt }],
						},
						signal: promptController.signal,
					}),
					context.remainingMs ?? args.timeoutMs,
					`Lane "${args.lane.id}" session.promptAsync launch timed out after ${context.remainingMs ?? args.timeoutMs}ms`,
					promptController,
				);
				if (result.error) {
					throw new Error(
						`session.promptAsync launch failed: ${formatError(result.error)}`,
					);
				}
				return result;
			},
			classify: (error) => {
				const message = error instanceof Error ? error.message : String(error);
				if (/timed out/i.test(message)) return 'permanent';
				return isTransientProviderError(message) ? 'transient' : 'permanent';
			},
			maxTransientRetriesPerModel: 0,
			deadlineAtMs: _internals.now() + args.timeoutMs,
			now: _internals.now,
			scope: {
				sessionID: args.sessionId,
				invocationID: `dispatch-lanes-async:${args.lane.id}`,
				swarmID,
				role: baseRole,
			},
			primaryModel: swarmAgents?.[baseRole]?.model,
			fallbackModels: swarmAgents?.[baseRole]?.fallback_models ?? [],
		});
		promptResult = dispatched.result;
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

type LaneCollectionReadiness = 'idle' | 'busy' | 'unknown';

async function getLaneCollectionReadiness(
	session: SessionOps,
	directory: string,
	sessionId: string,
	deadline: number,
	hostTimeouts: Set<string>,
	statusBudgetMs: number,
): Promise<LaneCollectionReadiness> {
	if (typeof session.status !== 'function') return 'unknown';
	if (statusBudgetMs <= 0) return 'unknown';
	try {
		const status = await withCollectionDeadline(
			() => session.status!({ query: { directory } }),
			deadline,
			`session.status for lane session "${sessionId}"`,
			hostTimeouts,
			statusBudgetMs,
		);
		if (status.error || !status.data) return 'unknown';
		const current = status.data[sessionId];
		if (current === undefined) return 'unknown';
		if (current.type === 'idle') return 'idle';
		if (current.type === 'busy' || current.type === 'retry') return 'busy';
		return 'unknown';
	} catch {
		return 'unknown';
	}
}

async function sweepStaleAsyncLaneRecords(
	session: SessionOps,
	directory: string,
	records: BackgroundDelegationRecord[],
	staleTimeoutMs: number,
	deadline: number,
	hostTimeouts: Set<string>,
): Promise<void> {
	if (staleTimeoutMs <= 0) return;
	const now = _internals.now();
	for (const record of records) {
		const currentBeforeReadiness = getCurrentStaleSweepCandidate(
			directory,
			record,
			staleTimeoutMs,
			now,
		);
		if (!currentBeforeReadiness) continue;
		const readiness = await getLaneCollectionReadiness(
			session,
			directory,
			currentBeforeReadiness.subagentSessionId,
			deadline,
			hostTimeouts,
			reserveCollectionLaneCallBudgets(
				deadline,
				records.length,
				typeof session.status === 'function',
			).statusBudgetMs,
		);
		if (readiness !== 'idle') continue;
		const currentAfterReadiness = getCurrentStaleSweepCandidate(
			directory,
			record,
			staleTimeoutMs,
			now,
		);
		if (!currentAfterReadiness) continue;
		await appendDelegationTransition(
			directory,
			currentAfterReadiness.correlationId,
			{
				status: 'stale',
				expectedCurrentStatuses: ['pending', 'running', 'ingestion_error'],
			},
		);
	}
}

function getCurrentStaleSweepCandidate(
	directory: string,
	record: BackgroundDelegationRecord,
	staleTimeoutMs: number,
	now: number,
): BackgroundDelegationRecord | null {
	const current = findByCorrelationId(directory, record.correlationId);
	if (!current) return null;
	if (current.subagentSessionId !== record.subagentSessionId) return null;
	if ((current.generation ?? 1) !== (record.generation ?? 1)) return null;
	if (
		current.status !== 'pending' &&
		current.status !== 'running' &&
		current.status !== 'ingestion_error'
	) {
		return null;
	}
	if (now - current.updatedAt <= staleTimeoutMs) return null;
	return current;
}

/**
 * Issue #2349: a terminal error read off the last assistant message of a lane
 * session, classified for settlement.
 *
 * `kind` derives from the SDK's discriminated `AssistantMessage.error` union and
 * is AUTHORITATIVE for the settled lane status. `category`/`retryClass` come
 * from the canonical {@link classifyProviderFailure} and are advisory
 * classification for operator legibility. The two are NOT required to agree: an
 * `APIError` whose message merely contains the word "aborted" settles as an
 * error (the SDK says `APIError`) while carrying `provider.cancelled` from the
 * text classifier. The reason string names both so the divergence is visible.
 */
interface LaneTerminalError {
	kind: 'provider' | 'aborted' | 'output_length' | 'unknown';
	/** SDK discriminator (`error.name`), bounded. */
	name: string;
	/** Sanitized + bounded provider message. */
	message: string;
	statusCode: number | undefined;
	/** `ApiError.data.isRetryable` — host-stated, not inferred. */
	hostRetryable: boolean | undefined;
	category: string;
	retryClass: string;
}

/**
 * Per-field budget for the settled reason string (issue #2349).
 *
 * `classifyTerminalFailureSignature` normalizes to 160 chars
 * (`src/hooks/pr-workflow-gate.ts`), so the DISCRIMINATING content — category
 * and provider message — must lead, and the constant `kind`/`name` suffix must
 * be small enough that it cannot push the discriminator out of the window.
 * Composing in the other order would collapse genuinely different failures into
 * one correlated-failure signature.
 */
const LANE_TERMINAL_REASON_MESSAGE_BUDGET = 100;

/**
 * Mirrors `isTerminal` in `src/background/pending-delegations.ts` — the statuses
 * whose presence makes the first-terminal-wins guard reject a further
 * transition. Used to tell a BENIGN settle race (someone else terminalized the
 * record first) apart from a genuine settle-write failure (the write threw, or
 * the record is still open), so the #2349 diagnostic does not cry wolf.
 */
const ASYNC_LANE_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
	'completed',
	'error',
	'cancelled',
	'stale',
	'consumed',
]);

function laneTerminalErrorReason(error: LaneTerminalError): string {
	const message = error.message.slice(0, LANE_TERMINAL_REASON_MESSAGE_BUDGET);
	const status =
		error.statusCode === undefined ? '' : ` status=${error.statusCode}`;
	const retryable =
		error.hostRetryable === undefined
			? ''
			: ` host_retryable=${error.hostRetryable}`;
	// Discriminating content first (category, message), constant tail last.
	return `${error.category}: ${message} [kind=${error.kind} name=${error.name}${status}${retryable}]`;
}

function readErrorDataRecord(error: unknown): Record<string, unknown> {
	if (typeof error !== 'object' || error === null) return {};
	const data = (error as { data?: unknown }).data;
	return typeof data === 'object' && data !== null
		? (data as Record<string, unknown>)
		: {};
}

/**
 * Issue #2349: classify an `AssistantMessage.error` union value for lane
 * settlement. Host truth (the SDK discriminator and `ApiError.data.isRetryable`)
 * takes precedence over text pattern matching; the provider message is still run
 * through the canonical {@link classifyProviderFailure} for its category and
 * bounded, sanitized display.
 *
 * Never throws: an unrecognized or malformed shape degrades to `unknown`.
 */
function classifyLaneTerminalError(error: unknown): LaneTerminalError {
	const name =
		typeof (error as { name?: unknown } | null)?.name === 'string'
			? (error as { name: string }).name.slice(0, 64)
			: 'UnknownError';
	const data = readErrorDataRecord(error);
	// Shape-agnostic on purpose (issue #2349, AC3). The ASYNC path supplies an
	// `AssistantMessage.error` union (`{ name, data: { message } }`) while the
	// SYNC path supplies a `session.prompt` ENVELOPE error whose message sits at
	// the top level. Normalizing both here is what lets the two paths report the
	// same category for the same underlying provider condition; classifying only
	// one shape would make async strictly better-labeled than sync.
	const topLevelMessage = (error as { message?: unknown } | null)?.message;
	const rawMessage =
		typeof data.message === 'string' && data.message.trim().length > 0
			? data.message
			: typeof topLevelMessage === 'string' && topLevelMessage.trim().length > 0
				? topLevelMessage
				: typeof error === 'string' && error.trim().length > 0
					? error
					: name;
	const statusCode =
		typeof data.statusCode === 'number' && Number.isFinite(data.statusCode)
			? data.statusCode
			: undefined;
	const hostRetryable =
		typeof data.isRetryable === 'boolean' ? data.isRetryable : undefined;
	const kind: LaneTerminalError['kind'] =
		name === 'MessageAbortedError'
			? 'aborted'
			: name === 'MessageOutputLengthError'
				? 'output_length'
				: name === 'APIError' || name === 'ProviderAuthError'
					? 'provider'
					: 'unknown';
	// Reuse the canonical classifier (AGENTS.md invariant 9: structured,
	// source-aware classification with bounded display). `info.error` is a
	// provider channel, not arbitrary tool output, so the provider quota
	// patterns apply correctly here.
	const classified = classifyProviderFailure(rawMessage);
	return {
		kind,
		name,
		message: classified.evidence.display,
		statusCode: statusCode ?? classified.evidence.statusCode,
		hostRetryable,
		category: classified.category,
		retryClass: classified.retryClass,
	};
}

function extractAssistantTranscript(
	messages: Array<{
		info?: {
			role?: string;
			time?: { completed?: number };
			finish?: string;
			error?: unknown;
		};
		parts?: Array<{ type: string; text?: string }>;
	}>,
): {
	text: string;
	messageCount: number;
	transcriptIncomplete: boolean;
	terminalAssistantProof: boolean;
	/**
	 * Issue #2349: `time.completed` of the last assistant message, surfaced so the
	 * collection loop can require positive turn-over evidence before settling a
	 * lane on an error. Previously computed here but discarded.
	 */
	completedAt: number | undefined;
	/**
	 * Issue #2349: the fetch-window truncation term ALONE, deliberately split out
	 * of {@link transcriptIncomplete}. `transcriptIncomplete` also folds in the
	 * TERMINAL `finish === 'length' | 'content-filter'` cases, so gating the
	 * error-settle on it would make the `output_length` classification
	 * unreachable. Only the "there may be unfetched earlier messages" signal is
	 * relevant to "did this lane really produce no output".
	 */
	windowTruncated: boolean;
	/**
	 * Issue #2349: the classified terminal error from the last assistant message,
	 * when present. The host records this on the persisted message; before this
	 * change the value was read only as an `=== undefined` existence test for
	 * {@link terminalAssistantProof} and then discarded, so no caller could ever
	 * learn WHY a lane died.
	 */
	terminalError: LaneTerminalError | undefined;
} {
	const assistantTexts: string[] = [];
	let lastAssistantInfo:
		| {
				role?: string;
				time?: { completed?: number };
				finish?: string;
				error?: unknown;
		  }
		| undefined;
	for (const message of messages) {
		if (message.info?.role !== 'assistant') continue;
		lastAssistantInfo = message.info;
		const text = extractText(message.parts);
		if (text.trim().length > 0) assistantTexts.push(text);
	}
	const completedAt = lastAssistantInfo?.time?.completed;
	const finish =
		typeof lastAssistantInfo?.finish === 'string'
			? lastAssistantInfo.finish.toLowerCase()
			: '';
	const terminalAssistantFinish =
		finish === 'stop' || finish === 'length' || finish === 'content-filter';
	return {
		text: assistantTexts.join('\n\n'),
		messageCount: assistantTexts.length,
		// Total message count (not just assistant) is the correct signal: the API
		// limit is applied to all message types, so hitting it means there may be
		// earlier messages of any role — including assistant — that were not fetched.
		transcriptIncomplete:
			messages.length >= ASYNC_MESSAGE_FETCH_LIMIT ||
			finish === 'length' ||
			finish === 'content-filter',
		terminalAssistantProof:
			typeof completedAt === 'number' &&
			Number.isFinite(completedAt) &&
			terminalAssistantFinish &&
			lastAssistantInfo?.error === undefined,
		completedAt: typeof completedAt === 'number' ? completedAt : undefined,
		windowTruncated: messages.length >= ASYNC_MESSAGE_FETCH_LIMIT,
		terminalError:
			lastAssistantInfo?.error === undefined
				? undefined
				: classifyLaneTerminalError(lastAssistantInfo.error),
	};
}

function reserveCollectionLaneCallBudgets(
	deadline: number,
	remainingLaneCount: number,
	hasStatusCall: boolean,
	hasRevisionDigestCall = false,
): {
	laneBudgetMs: number;
	statusBudgetMs: number;
	messagesBudgetMs: number;
	revisionDigestBudgetMs: number;
} {
	const remainingMs = Math.max(0, deadline - _internals.now());
	if (remainingMs === 0) {
		return {
			laneBudgetMs: 0,
			statusBudgetMs: 0,
			messagesBudgetMs: 0,
			revisionDigestBudgetMs: 0,
		};
	}
	const laneBudgetMs = Math.min(
		remainingMs,
		Math.max(1, Math.floor(remainingMs / Math.max(1, remainingLaneCount))),
	);
	const callCount = 1 + Number(hasStatusCall) + Number(hasRevisionDigestCall);
	const statusBudgetMs = hasStatusCall
		? Math.min(MAX_STATUS_CALL_BUDGET_MS, Math.floor(laneBudgetMs / callCount))
		: 0;
	const afterStatusMs = laneBudgetMs - statusBudgetMs;
	const revisionDigestBudgetMs = hasRevisionDigestCall
		? Math.floor(afterStatusMs / 2)
		: 0;
	return {
		laneBudgetMs,
		statusBudgetMs,
		messagesBudgetMs: afterStatusMs - revisionDigestBudgetMs,
		revisionDigestBudgetMs,
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

	const promptController = new AbortController();
	const create = await createLaneSession({
		session,
		dispatcher,
		lane,
		directory,
		timeoutMs,
		context,
	});
	let sessionId: string | undefined = create.ok ? create.sessionId : undefined;
	try {
		if (!create.ok) {
			return failedLane(
				lane,
				role,
				startedAt,
				create.error,
				create.slotId,
				create.runId,
				undefined,
				create.generation,
			);
		}
		sessionId = create.sessionId;
		const createdSessionId = sessionId;
		const baseRole = stripKnownSwarmPrefix(lane.agent);
		const swarmID =
			baseRole !== lane.agent
				? lane.agent.slice(0, lane.agent.length - baseRole.length - 1)
				: undefined;
		const swarmAgents = getSwarmAgents(swarmID);
		const dispatched = await dispatchWithModelFallback({
			dispatch: async (model, context) => {
				const result = await withTimeout(
					session.prompt({
						path: { id: createdSessionId },
						body: {
							agent: lane.agent,
							...(model ? { model } : {}),
							tools: buildReadOnlyTools(),
							parts: [{ type: 'text', text: lane.prompt }],
						},
						signal: promptController.signal,
					}),
					context.remainingMs ?? timeoutMs,
					`Lane "${lane.id}" session.prompt timed out after ${context.remainingMs ?? timeoutMs}ms`,
					promptController,
				);
				if (!result.data) {
					// Issue #2349 (AC3 parity): this throw — NOT the `!promptResult.data`
					// branch below — is the reachable sync failure path, because
					// dispatchWithModelFallback only ever returns a dispatch-produced
					// result or rethrows. Classify here so the same underlying provider
					// condition reports the same category as the async collect path.
					//
					// The `classify` callback below still reads this message for its
					// transient/permanent decision; the composed reason embeds the raw
					// provider text, so `isTransientProviderError` keeps matching exactly
					// what it matched before.
					throw new Error(
						`session.prompt failed: ${laneTerminalErrorReason(
							classifyLaneTerminalError(result.error),
						)}`,
					);
				}
				return result;
			},
			classify: (error) => {
				const message = error instanceof Error ? error.message : String(error);
				if (/timed out/i.test(message)) return 'permanent';
				return isTransientProviderError(message) ? 'transient' : 'permanent';
			},
			maxTransientRetriesPerModel: 0,
			deadlineAtMs: _internals.now() + timeoutMs,
			now: _internals.now,
			scope: {
				sessionID: sessionId,
				invocationID: `dispatch-lanes-sync:${lane.id}`,
				swarmID,
				role: baseRole,
			},
			primaryModel: swarmAgents?.[baseRole]?.model,
			fallbackModels: swarmAgents?.[baseRole]?.fallback_models ?? [],
		});
		const promptResult = dispatched.result;
		if (!promptResult.data) {
			return failedLane(
				lane,
				role,
				startedAt,
				// NOTE: this branch is defensive and currently UNREACHABLE — the
				// dispatch callback above throws whenever `!result.data`, and
				// dispatchWithModelFallback only returns a dispatch-produced result
				// or rethrows. Left byte-identical to its pre-#2349 form rather than
				// given new behavior, so no unwired code is introduced here; the
				// AC3 classification lives at the reachable throw site above.
				`session.prompt failed: ${formatError(promptResult.error)}`,
				create.slotId,
				create.runId,
				sessionId,
				create.generation,
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
			slot_id: create.slotId,
			run_id: create.runId,
			generation: create.generation,
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
			create.slotId,
			create.runId,
			sessionId,
			create.generation,
		);
	} finally {
		if (create.slotId) dispatcher.releaseSlot(create.slotId);
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
	deliveryContext?: LaneResultDeliveryContext,
): CollectLaneResultsResult {
	const laneResults = records
		.filter(
			(record) =>
				includePending ||
				(record.status !== 'pending' &&
					record.status !== 'running' &&
					record.status !== 'ingesting'),
		)
		.map((record) => recordToLaneResult(record, batchId, deliveryContext));
	const completed = records.filter((record) => record.status === 'completed');
	const failed = records.filter(
		(record) =>
			record.status === 'error' || record.status === 'ingestion_error',
	);
	const cancelled = records.filter((record) => record.status === 'cancelled');
	const stale = records.filter((record) => record.status === 'stale');
	const pending = records.filter(
		(record) =>
			record.status === 'pending' ||
			record.status === 'running' ||
			record.status === 'ingesting',
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

interface LaneResultDeliveryContext {
	directory?: string;
	sessionID?: string;
	reviewReceipts?: ReadonlyMap<string, PrReviewVerdictCollectionReceipt>;
}

async function resolvePrReviewReceiptFallbacks(
	directory: string,
	sessionID: string | undefined,
	records: readonly BackgroundDelegationRecord[],
): Promise<ReadonlyMap<string, PrReviewVerdictCollectionReceipt>> {
	const receipts = new Map<string, PrReviewVerdictCollectionReceipt>();
	if (!sessionID) return receipts;
	const unresolved = records.filter(
		(record) =>
			(record.mode === 'swarm-pr-review:reviewer' ||
				record.mode === 'swarm-pr-review:critic') &&
			!parsePrReviewCollectionReceipt(record) &&
			record.result !== undefined &&
			parsePrReviewCollectionReceiptShedMarker(record, record.result) !== null,
	);
	if (unresolved.length === 0) return receipts;
	let state: Awaited<ReturnType<typeof readPrWorkflowGateState>>;
	try {
		state = await readPrWorkflowGateState(directory, sessionID);
	} catch (error) {
		logger.log(
			`[dispatch-lanes] unable to reconstruct compacted PR-review receipts: ${formatError(error)}`,
		);
		return receipts;
	}
	if (!state || state.mode !== 'PR_REVIEW') return receipts;
	return resolvePrReviewReceiptFallbacksFromState(unresolved, state);
}

interface PrReviewReceiptFallbackState {
	prReviewValidationBatches?: Array<{
		batchId: string;
		phase: string;
		lanes: Array<{
			laneId: string;
			workflowLane: string;
			reviewItemIds?: string[];
		}>;
	}>;
}

function resolvePrReviewReceiptFallbacksFromState(
	records: readonly BackgroundDelegationRecord[],
	state: PrReviewReceiptFallbackState,
): ReadonlyMap<string, PrReviewVerdictCollectionReceipt> {
	const receipts = new Map<string, PrReviewVerdictCollectionReceipt>();
	for (const record of records) {
		const phase =
			record.mode === 'swarm-pr-review:reviewer'
				? 'reviewer'
				: record.mode === 'swarm-pr-review:critic'
					? 'critic'
					: null;
		if (!phase || !record.batchId || !record.laneId) continue;
		if (
			record.status !== 'completed' &&
			record.status !== 'error' &&
			record.status !== 'ingestion_error' &&
			record.status !== 'cancelled' &&
			record.status !== 'stale'
		) {
			continue;
		}
		const lane = (state.prReviewValidationBatches ?? [])
			.find(
				(batch) => batch.batchId === record.batchId && batch.phase === phase,
			)
			?.lanes.find(
				(candidate) =>
					candidate.laneId === record.laneId &&
					candidate.workflowLane === record.workflowLane,
			);
		const itemIds = lane?.reviewItemIds ?? [];
		if (itemIds.length === 0) continue;
		const marker = record.result
			? parsePrReviewCollectionReceiptShedMarker(record, record.result)
			: null;
		const projected = marker
			? projectPrReviewCollectionReceiptShedMarker(marker, itemIds)
			: null;
		if (projected) receipts.set(record.correlationId, projected);
	}
	return receipts;
}

function appendPrReviewCollectionReceipt(
	record: BackgroundDelegationRecord,
	result: BackgroundDelegationResult,
	receipt: PrReviewVerdictCollectionReceipt,
): BackgroundDelegationResult | null {
	const sanitizedPreview = (result.text ?? '')
		.split(/\r?\n/)
		.filter(
			(line) =>
				!line.startsWith(PR_REVIEW_COLLECTION_RECEIPT_PREFIX) &&
				!line.startsWith(PR_REVIEW_COLLECTION_RECEIPT_SHED_PREFIX),
		)
		.join('\n');
	const footer =
		encodePrReviewCollectionReceiptFooter(record, result, receipt) ??
		encodePrReviewCollectionReceiptShedMarkerFromReceipt(
			record,
			result,
			receipt,
		);
	if (!footer) return null;
	const text = sanitizedPreview ? `${sanitizedPreview}\n${footer}` : footer;
	return { ...result, text, outputPreviewChars: text.length };
}

function parsePrReviewCollectionReceipt(
	record: BackgroundDelegationRecord,
): PrReviewVerdictCollectionReceipt | null {
	if (!record.result) return null;
	const payload = parsePrReviewCollectionReceiptFooter(record, record.result);
	return payload ? projectPrReviewCollectionReceipt(payload) : null;
}

function recordToLaneResult(
	record: BackgroundDelegationRecord,
	batchId: string,
	deliveryContext?: LaneResultDeliveryContext,
): DispatchLaneResult {
	const status =
		record.status === 'error'
			? 'failed'
			: record.status === 'ingestion_error'
				? 'failed'
				: record.status === 'running' || record.status === 'ingesting'
					? 'pending'
					: record.status;
	const laneId = record.laneId ?? record.correlationId;
	// Only settled lanes have a result worth de-duplicating; a pending/running
	// record has no result text anyway. If the digest is missing we fail open
	// (always deliver) rather than risk silently withholding output forever.
	const digest = record.result?.digest;
	const outputRef = record.result?.outputRef?.trim();
	let alreadyDelivered = false;
	const reviewReceipt =
		parsePrReviewCollectionReceipt(record) ??
		deliveryContext?.reviewReceipts?.get(record.correlationId);
	if (
		record.result?.text !== undefined &&
		status !== 'pending' &&
		digest &&
		outputRef
	) {
		const key = `${batchId}\0${laneId}\0${digest}`;
		alreadyDelivered = hasLaneOutputBeenDelivered(
			deliveryContext?.directory,
			deliveryContext?.sessionID,
			key,
		);
		if (!alreadyDelivered) {
			markLaneOutputDelivered(
				deliveryContext?.directory,
				deliveryContext?.sessionID,
				key,
			);
		}
	}
	return {
		id: laneId,
		agent: record.swarmPrefixedAgent,
		role: record.normalizedAgent,
		status,
		session_id: record.subagentSessionId,
		generation: record.generation ?? 1,
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
					...(record.result.salvagedWorkflowLanes?.length
						? {
								salvaged_workflow_lanes: [
									...record.result.salvagedWorkflowLanes,
								],
							}
						: {}),
					...(record.result.salvagedWorkflowLaneRecoveries?.length
						? {
								salvaged_workflow_lane_recoveries:
									record.result.salvagedWorkflowLaneRecoveries.map(
										(recovery) => ({
											workflow_lane: recovery.workflowLane,
											kind: recovery.kind,
											reason: recovery.reason,
										}),
									),
							}
						: {}),
				}
			: {}),
		...(record.result?.error !== undefined
			? { error: record.result.error }
			: {}),
		...(reviewReceipt
			? {
					accepted_review_item_ids: [...reviewReceipt.acceptedReviewItemIds],
					rejected_review_item_ids: [...reviewReceipt.rejectedReviewItemIds],
				}
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
	generation?: number,
): DispatchLaneResult {
	return {
		id: lane.id,
		agent: lane.agent,
		role,
		status: 'failed',
		session_id: sessionId,
		slot_id: slotId,
		run_id: runId,
		generation,
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
	failure_class:
		| 'invalid_args'
		| 'no_client'
		| 'circuit_open'
		| 'retry_exhausted';
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
interface OrientationAugmentDeps {
	buildBlock?: typeof buildLaneOrientationBlock;
}

/**
 * Conservative headroom reserved inside the orientation overflow check for the
 * LATER prompt-size appends (applyExplorerFormatSuffix and
 * applyPrWorkflowPromptContract), each of which independently hard-fails the
 * dispatch on MAX_PROMPT_CHARS. Without this reserve, a PR-review lane whose
 * common_prompt + prompt + suffixes fit before could hard-fail purely because
 * a fresh graph made an orientation block available (review finding F-09).
 */
const ORIENTATION_SUFFIX_RESERVE_CHARS = 5_000;

/**
 * Resolve the `orientation` arg into an augmented common_prompt (issue #1988 C2).
 *
 * Execute-time resolution (no zod default — a schema default cannot depend on
 * graph state): `false` skips entirely; `true` or undefined attempts the block,
 * and buildLaneOrientationBlock itself returns null unless a fresh graph
 * exists, so undefined degrades to "false when no fresh graph".
 *
 * Overflow rule: the drop decision runs ONCE here, at the common+lane stage —
 * max over lanes of (common_prompt + orientation + separator + lane.prompt +
 * ORIENTATION_SUFFIX_RESERVE_CHARS) versus MAX_PROMPT_CHARS — BEFORE
 * appending. If any lane would exceed the cap the block is dropped (debug
 * log) rather than truncating content or failing dispatch. The reserve keeps
 * typical suffix appends (fixed worst case ≈3.2k chars) out of failure
 * territory they would not have reached without the block; extreme but
 * schema-valid configurations (maxed item-id/owned-lane arrays) can exceed
 * the reserve, and anything beyond it remains the caller's own size
 * responsibility, as before this feature.
 *
 * Fail-open: any builder error degrades to the un-augmented common_prompt.
 */
async function augmentCommonPromptWithOrientation(
	directory: string,
	lanes: readonly { prompt: string }[],
	commonPrompt: string | undefined,
	orientation: boolean | undefined,
	sessionID: string | undefined,
	deps?: OrientationAugmentDeps,
): Promise<string | undefined> {
	if (orientation === false) return commonPrompt;
	const buildBlock = deps?.buildBlock ?? buildLaneOrientationBlock;
	let block: string | null = null;
	try {
		block = await buildBlock(
			directory,
			lanes.map((lane) => lane.prompt),
			sessionID ? { sessionID } : undefined,
		);
	} catch (error) {
		logger.log('lane orientation block failed open', {
			error: error instanceof Error ? error.message : String(error),
		});
		return commonPrompt;
	}
	if (!block) return commonPrompt;
	const combined = commonPrompt
		? `${commonPrompt}${COMMON_PROMPT_SEPARATOR}${block}`
		: block;
	const overflow = lanes.some(
		(lane) =>
			combined.length +
				COMMON_PROMPT_SEPARATOR.length +
				lane.prompt.length +
				ORIENTATION_SUFFIX_RESERVE_CHARS >
			MAX_PROMPT_CHARS,
	);
	if (overflow) {
		logger.log(
			'lane orientation block dropped: combined common_prompt + orientation + lane prompt + suffix reserve would exceed MAX_PROMPT_CHARS',
			{ maxPromptChars: MAX_PROMPT_CHARS, blockChars: block.length },
		);
		return commonPrompt;
	}
	return combined;
}

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
	options: { failClosed?: boolean; mode?: string } = {},
): ApplyCommonPromptResult {
	const generatedAgentNames = _internals.getGeneratedAgentNames();
	const errors: string[] = [];
	const formatted = lanes.map((lane) => {
		const role = resolveGeneratedAgentRole(lane.agent, generatedAgentNames);
		const isPrReviewCouncilExplorer =
			options.mode === 'swarm-pr-review:council' && role.startsWith('council_');
		if (role !== 'explorer' && !isPrReviewCouncilExplorer) return lane;
		const rowFamilyIdentity =
			options.mode === 'swarm-pr-review:base'
				? 'For this base explorer lane, use the base row family and put the exact workflow_lane only in the `lane` field.'
				: options.mode === 'swarm-pr-review:micro' || isPrReviewCouncilExplorer
					? 'For this micro/council lane, use the micro row family and put the exact workflow_lane only in the `micro_lane` field; do not use the base `lane` field.'
					: "Use the row family applicable to this dispatch and put the exact workflow_lane only in that family's `lane` or `micro_lane` field.";
		const exactLaneInput = lane.workflow_lane ?? lane.id;
		const exactLaneResult = classifyControllerTokenField(exactLaneInput);
		if (!exactLaneResult.ok) {
			const reason =
				exactLaneResult.reason === 'multiple'
					? 'must be exactly one token after controller sanitization'
					: 'must not be empty after controller sanitization';
			const diagnostic = `Lane "${lane.id}" workflow_lane ${reason}`;
			if (options.failClosed) {
				errors.push(diagnostic);
				return lane;
			}
			logger.log(
				`[dispatch-lanes] applyExplorerFormatSuffix: ${diagnostic}; preserving the caller prompt for generic compatibility`,
			);
			return lane;
		}
		const ownedLaneResults = lane.owned_workflow_lanes?.length
			? lane.owned_workflow_lanes.map((owned, index) => ({
					index,
					result: classifyControllerTokenField(owned),
				}))
			: [{ index: 0, result: exactLaneResult }];
		const invalidOwnedLane = ownedLaneResults.find(({ result }) => !result.ok);
		if (invalidOwnedLane) {
			const reason =
				!invalidOwnedLane.result.ok &&
				invalidOwnedLane.result.reason === 'multiple'
					? 'must be exactly one token after controller sanitization'
					: 'must not be empty after controller sanitization';
			const diagnostic = `Lane "${lane.id}" owned_workflow_lanes[${invalidOwnedLane.index}] ${reason}`;
			if (options.failClosed) {
				errors.push(diagnostic);
				return lane;
			}
			logger.log(
				`[dispatch-lanes] applyExplorerFormatSuffix: ${diagnostic}; preserving the caller prompt for generic compatibility`,
			);
			return lane;
		}
		const ownedLanes = ownedLaneResults.map(({ result }) =>
			result.ok ? result.token : '',
		);
		const identity =
			ownedLanes.length === 1
				? `every output row MUST use the exact lane value "${ownedLanes[0]}"`
				: `this consolidated lane covers ${ownedLanes.length} obligations — evaluate EVERY one and emit a distinct [CANDIDATE] row set or fully populated [CLEAN] attestation for EACH of: ${ownedLanes
						.map((owned) => `"${owned}"`)
						.join(
							', ',
						)}; every output row MUST use the exact lane value of the obligation it reports`;
		const formatSuffix =
			options.mode === 'swarm-pr-review:base'
				? BASE_EXPLORER_CANDIDATE_FORMAT_SUFFIX
				: options.mode === 'swarm-pr-review:micro' || isPrReviewCouncilExplorer
					? MICRO_EXPLORER_CANDIDATE_FORMAT_SUFFIX
					: EXPLORER_CANDIDATE_FORMAT_SUFFIX;
		const controllerIdentity = `CONTROLLER-BOUND OUTPUT IDENTITY: ${identity}. Placeholder text such as "workflow_lane" is invalid. ${rowFamilyIdentity}`;
		const knownSuffixes = [
			EXPLORER_CANDIDATE_FORMAT_SUFFIX,
			BASE_EXPLORER_CANDIDATE_FORMAT_SUFFIX,
			MICRO_EXPLORER_CANDIDATE_FORMAT_SUFFIX,
		];
		const embeddedKnownSuffixes = knownSuffixes.filter((suffix) =>
			lane.prompt.includes(suffix),
		);
		const expectedSuffixOccurrences =
			lane.prompt.split(formatSuffix).length - 1;
		if (
			lane.prompt.endsWith(formatSuffix) &&
			lane.prompt.includes(controllerIdentity) &&
			embeddedKnownSuffixes.length === 1 &&
			expectedSuffixOccurrences === 1
		) {
			return lane;
		}
		if (embeddedKnownSuffixes.length > 0) {
			const diagnostic = `Lane "${lane.id}" prompt contains an incompatible, duplicate, or controller-unbound explorer output contract for mode "${options.mode ?? 'generic'}"`;
			if (options.failClosed) {
				errors.push(diagnostic);
				return lane;
			}
			logger.log(
				`[dispatch-lanes] applyExplorerFormatSuffix: ${diagnostic}; preserving the caller prompt for generic compatibility`,
			);
			return lane;
		}
		const prompt = `${lane.prompt}

${controllerIdentity}${formatSuffix}`;
		if (prompt.length > MAX_PROMPT_CHARS) {
			const diagnostic = `Lane "${lane.id}" prompt plus mandatory explorer output contract is ${prompt.length} chars; max ${MAX_PROMPT_CHARS} (a repo-graph orientation block may have been prepended to common_prompt — retry with orientation: false to exclude it)`;
			if (options.failClosed) {
				errors.push(diagnostic);
				return lane;
			}
			logger.log(
				`[dispatch-lanes] applyExplorerFormatSuffix: lane "${lane.id}" prompt too long ` +
					`(${lane.prompt.length} chars + suffix = ${prompt.length}, max ${MAX_PROMPT_CHARS}); ` +
					`format enforcement skipped — explorer may not emit [CANDIDATE] rows`,
			);
			return lane;
		}
		return { ...lane, prompt };
	});
	return errors.length > 0
		? { ok: false, errors }
		: { ok: true, lanes: formatted };
}

/**
 * #2276: derive the final-response character budget for a PR-review lane from
 * the lane's owned workload. Returns `undefined` for modes without a derived
 * budget (the swarm-pr-feedback modes keep their flat
 * {@link PR_WORKFLOW_PROTOCOL_OUTPUT_MAX_CHARS} guidance).
 */
function prReviewLaneResponseBudgetChars(
	mode: string,
	lane: DispatchLaneSpec,
): number | undefined {
	if (mode === 'swarm-pr-review:base') {
		return PR_REVIEW_BASE_LANE_RESPONSE_BUDGET_CHARS;
	}
	if (mode === 'swarm-pr-review:micro') {
		// Consolidated micro lanes (depth tiers S/M) settle one attestation per
		// owned workflow lane; a single-family micro lane (tier L) owns one.
		const owned = Math.max(1, lane.owned_workflow_lanes?.length ?? 1);
		return Math.min(
			PR_REVIEW_RESPONSE_BUDGET_CEILING_CHARS,
			PR_REVIEW_MICRO_LANE_RESPONSE_BUDGET_CHARS +
				(owned - 1) * PR_REVIEW_MICRO_PER_OWNED_LANE_CHARS,
		);
	}
	if (mode === 'swarm-pr-review:council') {
		return PR_REVIEW_COUNCIL_LANE_RESPONSE_BUDGET_CHARS;
	}
	if (
		mode === 'swarm-pr-review:reviewer' ||
		mode === 'swarm-pr-review:critic'
	) {
		const items = Math.max(0, lane.review_item_ids?.length ?? 0);
		return Math.min(
			PR_REVIEW_RESPONSE_BUDGET_CEILING_CHARS,
			PR_REVIEW_VERDICT_RESPONSE_FLOOR_CHARS +
				items * PR_REVIEW_VERDICT_RESPONSE_PER_ITEM_CHARS,
		);
	}
	return undefined;
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
		const normalizedMode = classifyControllerTokenField(mode);
		const workflowLane = classifyControllerTokenField(lane.workflow_lane ?? '');
		const prHeadSha = classifyControllerTokenField(options.prHeadSha ?? '');
		const revisionDigest = classifyControllerTokenField(
			options.revisionDigest ?? '',
		);
		const declaredScope = canonicalizeControllerField(
			options.scope ??
				'the exact checked-out PR revision and repository-defined diff context',
		);
		const callerFocus = canonicalizeControllerField(options.callerFocus ?? '');
		const assignedIdResults = (
			lane.review_item_ids ??
			lane.feedback_item_ids ??
			[]
		).map((itemId) => classifyControllerTokenField(itemId));
		const invalidAssignedId = assignedIdResults.find((result) => !result.ok);
		if (!normalizedMode.ok || !prHeadSha.ok || !revisionDigest.ok) {
			errors.push(
				`Lane "${lane.id}" mandatory PR workflow contract requires non-empty single-token mode, pr_head_sha, and revision_digest values after controller sanitization`,
			);
			return lane;
		}
		if (!workflowLane.ok && workflowLane.reason === 'multiple') {
			errors.push(
				`Lane "${lane.id}" workflow_lane must be exactly one token after controller sanitization`,
			);
			return lane;
		}
		if (invalidAssignedId) {
			errors.push(
				`Lane "${lane.id}" assigned_item_ids must contain exactly one token per item after controller sanitization`,
			);
			return lane;
		}
		const fallbackChecklist = normalizedMode.token.endsWith(':reviewer')
			? 're-read every assigned candidate at its exact location; prove classification, reachability, mitigation, severity, and falsification path'
			: normalizedMode.token.endsWith(':critic')
				? 'challenge every assigned verdict for evidence, reachability, mitigation, severity, coherence, and required report changes'
				: 'inspect the bound scope using the complete repository-defined contract for this lane';
		const ownedLaneResults = lane.owned_workflow_lanes?.length
			? lane.owned_workflow_lanes.map((owned) =>
					classifyControllerTokenField(owned),
				)
			: undefined;
		const invalidOwnedLane = ownedLaneResults?.find((result) => !result.ok);
		if (invalidOwnedLane) {
			errors.push(
				`Lane "${lane.id}" owned_workflow_lanes must contain exactly one token per item after controller sanitization`,
			);
			return lane;
		}
		const ownedLanes = ownedLaneResults?.map((result) =>
			result.ok ? result.token : '',
		);
		const assignedIds = assignedIdResults.map((result) =>
			result.ok ? result.token : '',
		);
		const checklist = ownedLanes
			? ownedLanes
					.map(
						(owned) =>
							`[${owned}] ${PR_WORKFLOW_LANE_CHECKLISTS[owned] ?? fallbackChecklist}`,
					)
					.join(' ')
			: (PR_WORKFLOW_LANE_CHECKLISTS[
					workflowLane.ok ? workflowLane.token : ''
				] ?? fallbackChecklist);
		const ownedLine = ownedLanes
			? `\nowned_workflow_lanes: ${ownedLanes.join(', ')} — every owned obligation requires its own [CANDIDATE] rows or fully populated [CLEAN] attestation naming that obligation`
			: '';
		const responseBudget = prReviewLaneResponseBudgetChars(
			normalizedMode.token,
			lane,
		);
		const budgetLine =
			responseBudget !== undefined
				? `\nfinal_response_char_budget: ${responseBudget}`
				: '';
		const outputCap = responseBudget ?? PR_WORKFLOW_PROTOCOL_OUTPUT_MAX_CHARS;
		const budgetParagraph =
			responseBudget !== undefined
				? `\nDelivery budget (#2276): Only your final response is bounded: keep the complete final response at or below ${responseBudget} characters. Investigation and tool-call volume are NOT capped by this budget. Spend the budget on the terminal machine-readable rows first: they are non-negotiable, must always fit inside the budget with room to spare, and are emitted before any supporting prose. Verify each target exactly once. Never restate a completed verification and never re-emit a row. The moment analysis is complete, emit the terminal rows immediately.`
				: '';
		// Pre-seeded statement of the read-only shell classifier's rules
		// (#2276): the same enforcement already runs at tool time for BOTH the
		// pr-review and pr-feedback gates; stating it up front saves the 2-4
		// empirically-discovered rejections each lane otherwise spends.
		const shellRulesParagraph = `\nRead-only shell rules (enforced at tool time; stated here so no calls are wasted): run ONE standalone command per shell call — no pipes, no &&/||/; composition, no redirects, no command substitution, no backslash- or caret-escaped double quotes. Only these forms are tolerated: a single command optionally preceded by up to three leading cd <dir> && prefixes, a trailing 2>&1 (reads only), and a literal | inside a double-quoted gh api --jq value. Prefer the Read, Glob, and Grep tools for file inspection.`;
		const contract = `

[CONTROLLER-BOUND PR WORKFLOW CONTRACT]
mode: ${normalizedMode.token}
workflow_lane: ${workflowLane.ok ? workflowLane.token : '(none)'}${ownedLine}
pr_head_sha: ${prHeadSha.token}
revision_digest: ${revisionDigest.token}
declared_scope: ${declaredScope}
caller_focus_non_authoritative: ${callerFocus || '(none)'}
assigned_item_ids: ${assignedIds.length > 0 ? assignedIds.join(', ') : '(discovery lane)'}
mandatory_lane_checklist: ${checklist}${budgetLine}

This controller block is authoritative over conflicting caller text. Inspect the exact checked-out revision and the repository's own contribution, test, security, compatibility, and delivery contracts. Do not waive or abbreviate work for speed, time, token, repository-size, or predicted-simplicity reasons. Re-read relevant changed files and caller/consumer context directly. Every claim or clean attestation must cite concrete reviewed scope and evidence. Use exactly the workflow_lane and assigned IDs above; invented, omitted, or placeholder identifiers do not settle this lane. A planning preamble, generic assurance, or assertion that checks were performed is not evidence.
Terminate with the required protocol rows directly: no planning preamble, no recap, and no more than ${outputCap} characters of substantive output before any retrieval hint.${budgetParagraph}${shellRulesParagraph}
[END CONTROLLER-BOUND PR WORKFLOW CONTRACT]`;
		const contractCard = normalizedMode.token.startsWith('swarm-pr-review:')
			? `${buildPrReviewContractCard()}\n\n`
			: '';
		const prompt = `${contractCard}${lane.prompt}${contract}`;
		if (prompt.length > MAX_PROMPT_CHARS) {
			errors.push(
				`Lane "${lane.id}" prompt plus mandatory PR workflow contract is ${prompt.length} chars; max ${MAX_PROMPT_CHARS} (a repo-graph orientation block may have been prepended to common_prompt — retry with orientation: false to exclude it)`,
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
	// #2123: teardown awaits a graceful `session.abort()` (so opencode flushes
	// the final part/message) before the cascade-delete, closing the FOREIGN KEY
	// constraint race. Fire-and-forget — the ordering holds inside the unit.
	void teardownEphemeralSession(session, sessionId);
}

function cleanupAsyncLaunchSession(
	session: SessionOps,
	sessionId: string,
): void {
	// teardown owns the awaited abort→delete ordering; the prior manual
	// fire-and-forget abort let the delete race opencode's flush (#2123).
	void teardownEphemeralSession(session, sessionId);
}

async function withCollectionDeadline<T>(
	operationPromise: () => Promise<T>,
	deadline: number,
	operation: string,
	hostTimeouts: Set<string>,
	budgetMs?: number,
): Promise<T> {
	const remainingMs = Math.max(0, deadline - _internals.now());
	const allowedMs =
		budgetMs === undefined
			? remainingMs
			: Math.min(remainingMs, Math.max(0, budgetMs));
	const diagnostic = `${operation} exceeded the remaining collect_lane_results budget (${allowedMs}ms)`;
	if (allowedMs === 0) {
		hostTimeouts.add(diagnostic);
		throw new Error(diagnostic);
	}
	try {
		return await withTimeout(operationPromise(), allowedMs, diagnostic);
	} catch (error) {
		if (formatError(error) === diagnostic) hostTimeouts.add(diagnostic);
		throw error;
	}
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
	let text: string;
	if (typeof error === 'string') {
		text = error;
	} else if (typeof error === 'object' && error !== null) {
		try {
			text = JSON.stringify(error);
		} catch {
			text = String(error);
		}
	} else {
		text = String(error);
	}
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
			'Dispatch multiple read-only exploration/review lanes concurrently and BLOCK until every lane finishes, returning a structured join result. This blocks the caller until completion; for non-blocking dispatch that lets you keep working while lanes run, prefer dispatch_lanes_async + collect_lane_results and use this blocking variant only when promptAsync is unavailable. Keep each lane prompt compact: send large shared context once via common_prompt (or have lanes read it from a file by absolute path) instead of inlining it into every lane prompt. A bounded repo-graph orientation block is prepended to common_prompt by default when the graph is fresh and relevant (set orientation: false to disable).',
		args: {
			lanes: DispatchLanesArgsSchema.shape.lanes,
			common_prompt: DispatchLanesArgsSchema.shape.common_prompt,
			max_concurrent: DispatchLanesArgsSchema.shape.max_concurrent,
			timeout_ms: DispatchLanesArgsSchema.shape.timeout_ms,
			orientation: DispatchLanesArgsSchema.shape.orientation,
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
			'Launch multiple read-only advisory lanes with OpenCode promptAsync and return IMMEDIATELY with a batch id and lane session handles (non-blocking). launch_timeout_ms only bounds session creation and promptAsync acceptance; it is NOT a lane runtime timeout. After launching, keep working on non-dependent investigation while lanes run — poll incrementally with collect_lane_results (wait omitted or false) to process settled lanes as they complete, or use wait: true only at workflow boundaries where all results are needed. Keep each lane prompt compact: send large shared context once via common_prompt (or have lanes read it from a file by absolute path) instead of inlining it into every lane prompt, which can produce oversized or malformed tool-call JSON. A bounded repo-graph orientation block is prepended to common_prompt by default when the graph is fresh and relevant (set orientation: false to disable).',
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
			pr_review_wave_stage:
				DispatchLanesAsyncArgsSchema.shape.pr_review_wave_stage,
			pr_review_wave_attempt:
				DispatchLanesAsyncArgsSchema.shape.pr_review_wave_attempt,
			orientation: DispatchLanesAsyncArgsSchema.shape.orientation,
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
			'Collect or poll results for a dispatch_lanes_async batch. Supports two modes: (1) non-blocking poll (wait omitted or false) — performs one collection pass and returns current lane status, including pending lane identities by default, and any settled results so you can process completed lanes while continuing independent work; (2) blocking join (wait: true) — polls until all lanes settle or the collection wait budget expires. Busy/retry lanes do not become stale solely because they run for a long time; pr-review lanes pending for minutes additionally carry an alert-only pending_liveness diagnostic (lane id, elapsed ms, host session status, stalledSuspect) that never cancels or replaces anything. Does not advance workflow gates.',
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
