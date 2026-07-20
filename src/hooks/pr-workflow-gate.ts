import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { readLaneOutput } from '../background/lane-output-store.js';
import {
	findByBatchId,
	readDelegations,
} from '../background/pending-delegations.js';
import {
	resolveCommitCountSince,
	resolveCurrentGitHead,
	resolveCurrentUpstreamPushTarget,
	resolveCurrentUpstreamRemoteRef,
	resolveExactRemoteBranchHead,
	resolveIsExactSingleChildCommit,
	resolveIsWorkingTreeClean,
	resolvePrWorkflowRevisionDigest,
	resolvePrWorkflowRevisionDigestAsync,
	resolveRemoteRefsContainingHead,
} from '../background/workspace-snapshot.js';
import { WRITE_TOOL_NAMES } from '../config/constants.js';
import { resolveGeneratedAgentRole } from '../config/schema.js';
import { getPrWorkflowToolCapability } from '../tools/tool-metadata.js';
import { validateSwarmPath } from './utils.js';

export const PR_REVIEW_BASE_DIMENSION_IDS = [
	'intent-architecture',
	'correctness-state',
	'tests-falsifiability',
	'security-trust',
	'reliability-performance',
	'compatibility-delivery',
] as const;

export const PR_REVIEW_REQUIRED_MICRO_LANE_IDS = [
	'auth-identity-secrets',
	'untrusted-input-boundaries',
	'subprocess-platform',
	'concurrency-state',
	'dependencies-build-release',
	'api-schema-migrations',
	'test-infrastructure',
	'ui-accessibility-i18n',
	'privacy-observability',
	'generated-provenance',
	'unclassified-risk',
] as const;

export type PrReviewBaseDimensionId =
	(typeof PR_REVIEW_BASE_DIMENSION_IDS)[number];
export type PrWorkflowMode = 'PR_REVIEW' | 'PR_FEEDBACK';

export interface PrWorkflowLaneSpec {
	laneId?: string;
	workflowLane?: string;
	reviewItemIds?: string[];
}

export interface PrFeedbackLaneOwnership {
	laneId: string;
	ownedItemIds: string[];
}

interface PrReviewBaseDispatchRecord {
	batchId: string;
	lanes: Array<{
		laneId: string;
		workflowLane: PrReviewBaseDimensionId;
	}>;
	validatedAt: string;
}

interface PrFeedbackVerificationRecord {
	batchId: string;
	ownership: PrFeedbackLaneOwnership[];
	validatedAt: string;
}

export type PrFeedbackGatePhase =
	| 'stage-b-reviewer'
	| 'stage-b-test'
	| 'closeout-reviewer'
	| 'closeout-critic';

export type PrFeedbackStageACategory =
	| 'build'
	| 'typecheck'
	| 'lint'
	| 'diff-check'
	| 'reproduction';

export interface PrFeedbackStageACheckReceipt {
	category: PrFeedbackStageACategory;
	workingDirectory?: string;
	obligationId?: string;
	validatorContract?: { path: string; id: string };
	command: string[];
	targets?: string[];
	feedbackTargets?: Array<{
		feedbackItemId: string;
		target: string;
		expectedBehavior: string;
	}>;
	durationMs: number;
}

interface PrFeedbackStageARecord {
	revisionDigest: string;
	checks: PrFeedbackStageACheckReceipt[];
	feedbackItemIds?: string[];
	applicableCategories?: Array<'build' | 'typecheck' | 'lint'>;
	applicableObligations?: Array<{
		id: string;
		category: 'build' | 'typecheck' | 'lint';
		workingDirectory: string;
		source: string;
		validatorContract?: { path: string; id: string };
	}>;
	validatedAt: string;
}

interface PrFeedbackGateBatchRecord {
	batchId: string;
	phase: PrFeedbackGatePhase;
	laneId: string;
	itemIds: string[];
	revisionDigest: string;
	validatedAt: string;
}

interface PrFeedbackReadyToPublishRecord {
	revisionDigest: string;
	localHead: string;
	remoteName: string;
	remoteBranchRef: string;
	remoteRef: string;
	validatedAt: string;
}

export type PrWorkflowCompletionStatus = 'completed' | 'ready-to-publish';

export type PrReviewValidationPhase = 'council' | 'reviewer' | 'critic';
export type PrReviewArtifactBoundary =
	| 'post_explorer'
	| 'post_reviewer'
	| 'post_critic';

type PrReviewArtifactRecord = {
	finding_id: string;
	status: 'PENDING' | 'CONFIRMED' | 'DISPROVED' | 'PRE_EXISTING';
	next_action:
		| 'route_to_reviewer'
		| 'route_to_critic'
		| 'report'
		| 'suppress_with_reason'
		| 'handoff_to_feedback';
	severity?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
};

interface PrFeedbackScopeDeclarationRecord {
	taskId: string;
	files: string[];
	revisionDigest: string;
	declaredAt: string;
	consumedByCallId?: string;
}

interface PrReviewValidationBatchRecord {
	batchId: string;
	phase: PrReviewValidationPhase;
	lanes: Array<{
		laneId: string;
		workflowLane: string;
		reviewItemIds?: string[];
	}>;
	validatedAt: string;
}

export interface PrWorkflowGateState {
	schemaVersion: 1;
	/** Monotonic durable revision used to reject stale same-session transitions. */
	revision: number;
	sessionID: string;
	mode: PrWorkflowMode;
	activatedAt: string;
	updatedAt: string;
	prHeadSha?: string;
	prReviewBaseRef?: string;
	prReviewBaseSha?: string;
	prReviewBaseDispatches?: PrReviewBaseDispatchRecord[];
	/** @deprecated Compatibility projection of the most recent base dispatch. */
	prReviewBaseDispatch?: PrReviewBaseDispatchRecord;
	prReviewTriggerEvalPath?: string;
	prReviewValidationBatches?: PrReviewValidationBatchRecord[];
	prReviewArtifactRunId?: string;
	prReviewFindingsPath?: string;
	prReviewArtifactBoundaries?: PrReviewArtifactBoundary[];
	prReviewHandoffPath?: string;
	prReviewHandoffRequired?: boolean;
	prFeedbackInventory?: string[];
	prFeedbackVerifications?: PrFeedbackVerificationRecord[];
	/** @deprecated Compatibility projection of the most recent verification dispatch. */
	prFeedbackVerification?: PrFeedbackVerificationRecord;
	prFeedbackStageA?: PrFeedbackStageARecord;
	prFeedbackGateBatches?: PrFeedbackGateBatchRecord[];
	prFeedbackReadyToPublish?: PrFeedbackReadyToPublishRecord;
	prFeedbackScopes?: PrFeedbackScopeDeclarationRecord[];
}

interface SessionStateMutationLock {
	ownerToken: string;
	pid: number;
	createdAtMs: number;
}

const GATE_SCHEMA_VERSION = 1 as const;
const MAX_TRACKED_SESSIONS = 200;
const MAX_WORKFLOW_BATCHES = 128;
const WINDOWS_RENAME_MAX_RETRIES = 3;
const RENAME_RETRY_DELAY_MS = 10;
const STATE_MUTATION_LOCK_MAX_ATTEMPTS = 50;
const STATE_MUTATION_LOCK_RETRY_DELAY_MS = 10;
const STATE_MUTATION_LOCK_UNINITIALIZED_STALE_MS = 30_000;
const DISPATCH_TOOL_NAME = 'dispatch_lanes_async';
const BLOCKING_DISPATCH_TOOL_NAME = 'dispatch_lanes';
const WORKFLOW_GATE_DIR = 'pr-workflow-gates';
const trackedStatesByProjectSession = new Map<string, PrWorkflowGateState>();
const pendingStateMutationsByProjectSession = new Map<string, Promise<void>>();

const PrReviewBaseDispatchRecordSchema = z
	.object({
		batchId: z.string().min(1),
		lanes: z
			.array(
				z
					.object({
						laneId: z.string().min(1),
						workflowLane: z.enum([
							'intent-architecture',
							'correctness-state',
							'tests-falsifiability',
							'security-trust',
							'reliability-performance',
							'compatibility-delivery',
						]),
					})
					.strict(),
			)
			.min(1),
		validatedAt: z.string().min(1),
	})
	.strict();

const PrFeedbackLaneOwnershipSchema = z
	.object({
		laneId: z.string().min(1),
		ownedItemIds: z.array(z.string().min(1)).min(1),
	})
	.strict();

const PrFeedbackVerificationRecordSchema = z
	.object({
		batchId: z.string().min(1),
		ownership: z.array(PrFeedbackLaneOwnershipSchema).min(1),
		validatedAt: z.string().min(1),
	})
	.strict();

const PrFeedbackStageACheckReceiptSchema = z
	.object({
		category: z.enum([
			'build',
			'typecheck',
			'lint',
			'diff-check',
			'reproduction',
		]),
		workingDirectory: z.string().min(1).optional(),
		obligationId: z.string().min(1).optional(),
		validatorContract: z
			.object({ path: z.string().min(1), id: z.string().min(1) })
			.strict()
			.optional(),
		command: z.array(z.string().min(1)).min(1),
		targets: z.array(z.string().min(1)).min(1).optional(),
		feedbackTargets: z
			.array(
				z
					.object({
						feedbackItemId: z.string().min(1),
						target: z.string().min(1),
						expectedBehavior: z.string().min(8),
					})
					.strict(),
			)
			.min(1)
			.optional(),
		durationMs: z.number().nonnegative(),
	})
	.strict();

const PrFeedbackStageARecordSchema = z
	.object({
		revisionDigest: z.string().min(1),
		checks: z.array(PrFeedbackStageACheckReceiptSchema).min(2).max(258),
		feedbackItemIds: z.array(z.string().min(1)).min(1).optional(),
		applicableCategories: z
			.array(z.enum(['build', 'typecheck', 'lint']))
			.max(3)
			.optional(),
		applicableObligations: z
			.array(
				z
					.object({
						id: z.string().min(1),
						category: z.enum(['build', 'typecheck', 'lint']),
						workingDirectory: z.string().min(1),
						source: z.string().min(1),
						validatorContract: z
							.object({ path: z.string().min(1), id: z.string().min(1) })
							.strict()
							.optional(),
					})
					.strict(),
			)
			.max(256)
			.optional(),
		validatedAt: z.string().min(1),
	})
	.strict();

const PrFeedbackGateBatchRecordSchema = z
	.object({
		batchId: z.string().min(1),
		phase: z.enum([
			'stage-b-reviewer',
			'stage-b-test',
			'closeout-reviewer',
			'closeout-critic',
		]),
		laneId: z.string().min(1),
		itemIds: z.array(z.string().min(1)).min(1),
		revisionDigest: z.string().min(1),
		validatedAt: z.string().min(1),
	})
	.strict();

const PrFeedbackReadyToPublishRecordSchema = z
	.object({
		revisionDigest: z.string().min(1),
		localHead: z.string().min(1),
		remoteName: z.string().min(1),
		remoteBranchRef: z.string().startsWith('refs/heads/'),
		remoteRef: z.string().startsWith('refs/remotes/'),
		validatedAt: z.string().min(1),
	})
	.strict();

const PrReviewValidationBatchRecordSchema = z
	.object({
		batchId: z.string().min(1),
		phase: z.enum(['council', 'reviewer', 'critic']),
		lanes: z
			.array(
				z
					.object({
						laneId: z.string().min(1),
						workflowLane: z.string().min(1),
						reviewItemIds: z.array(z.string().min(1)).min(1).optional(),
					})
					.strict(),
			)
			.min(1),
		validatedAt: z.string().min(1),
	})
	.strict();

const PrFeedbackScopeDeclarationRecordSchema = z
	.object({
		taskId: z.string().regex(/^\d+\.\d+(?:\.\d+)*$/),
		files: z.array(z.string().min(1)).min(1).max(10_000),
		revisionDigest: z.string().min(1),
		declaredAt: z.string().min(1),
		consumedByCallId: z.string().min(1).optional(),
	})
	.strict();

const PrWorkflowGateStateSchema = z
	.object({
		schemaVersion: z.literal(GATE_SCHEMA_VERSION),
		revision: z.number().int().nonnegative().default(0),
		sessionID: z.string().min(1),
		mode: z.enum(['PR_REVIEW', 'PR_FEEDBACK']),
		activatedAt: z.string().min(1),
		updatedAt: z.string().min(1),
		prHeadSha: z.string().min(1).optional(),
		prReviewBaseRef: z.string().min(1).optional(),
		prReviewBaseSha: z.string().min(1).optional(),
		prReviewBaseDispatches: z
			.array(PrReviewBaseDispatchRecordSchema)
			.max(MAX_WORKFLOW_BATCHES)
			.optional(),
		prReviewBaseDispatch: PrReviewBaseDispatchRecordSchema.optional(),
		prReviewTriggerEvalPath: z.string().min(1).optional(),
		prReviewValidationBatches: z
			.array(PrReviewValidationBatchRecordSchema)
			.max(MAX_WORKFLOW_BATCHES)
			.optional(),
		prReviewArtifactRunId: z.string().min(1).optional(),
		prReviewFindingsPath: z.string().min(1).optional(),
		prReviewArtifactBoundaries: z
			.array(z.enum(['post_explorer', 'post_reviewer', 'post_critic']))
			.max(3)
			.optional(),
		prReviewHandoffPath: z.string().min(1).optional(),
		prReviewHandoffRequired: z.boolean().optional(),
		prFeedbackInventory: z.array(z.string().min(1)).min(1).optional(),
		prFeedbackVerifications: z
			.array(PrFeedbackVerificationRecordSchema)
			.max(MAX_WORKFLOW_BATCHES)
			.optional(),
		prFeedbackVerification: PrFeedbackVerificationRecordSchema.optional(),
		prFeedbackStageA: PrFeedbackStageARecordSchema.optional(),
		prFeedbackGateBatches: z
			.array(PrFeedbackGateBatchRecordSchema)
			.max(MAX_WORKFLOW_BATCHES)
			.optional(),
		prFeedbackReadyToPublish: PrFeedbackReadyToPublishRecordSchema.optional(),
		prFeedbackScopes: z
			.array(PrFeedbackScopeDeclarationRecordSchema)
			.max(MAX_WORKFLOW_BATCHES)
			.optional(),
	})
	.strict();

export async function activatePrWorkflow(
	directory: string,
	sessionID: string,
	mode: PrWorkflowMode,
	options: { prHeadSha?: string } = {},
): Promise<PrWorkflowGateState> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	const existing = await readPrWorkflowGateState(
		directory,
		normalizedSessionID,
	);
	if (existing?.mode === mode) {
		return options.prHeadSha
			? bindPrWorkflowHead(directory, normalizedSessionID, options.prHeadSha)
			: existing;
	}
	if (existing) {
		throw new Error(
			`BLOCKED: session "${normalizedSessionID}" already has an active ${existing.mode} workflow; complete it before starting ${mode}`,
		);
	}
	const initialHead = options.prHeadSha
		? assertCurrentCheckoutHead(directory, options.prHeadSha)
		: undefined;
	const timestamp = isoNow();
	const nextState: PrWorkflowGateState = {
		schemaVersion: GATE_SCHEMA_VERSION,
		revision: 0,
		sessionID: normalizedSessionID,
		mode,
		activatedAt: timestamp,
		updatedAt: timestamp,
		...(initialHead ? { prHeadSha: initialHead } : {}),
	};
	await persistState(directory, nextState);
	return nextState;
}

export async function readPrWorkflowGateState(
	directory: string,
	sessionID: string,
): Promise<PrWorkflowGateState | null> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	// State is shared by plugin processes. The bounded cache is an eviction aid
	// for locally persisted snapshots, never an authority over the durable file.
	const state = await readPrWorkflowGateStateFromDisk(
		directory,
		normalizedSessionID,
	);
	if (state) {
		rememberState(directory, state);
	} else {
		trackedStatesByProjectSession.delete(
			stateCacheKey(directory, normalizedSessionID),
		);
	}
	return state;
}

export async function clearPrWorkflowGateState(
	directory: string,
	sessionID: string,
	expectedRevision?: number,
): Promise<void> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	await withSessionStateMutation(directory, normalizedSessionID, async () => {
		const current = await readPrWorkflowGateStateFromDisk(
			directory,
			normalizedSessionID,
		);
		if (
			expectedRevision !== undefined &&
			(!current || current.revision !== expectedRevision)
		) {
			throw new Error(
				'BLOCKED: PR workflow gate state changed during terminal completion; revalidate the current session state before retrying',
			);
		}
		try {
			await fsp.rm(workflowGateStatePath(directory, normalizedSessionID), {
				force: true,
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}
		trackedStatesByProjectSession.delete(
			stateCacheKey(directory, normalizedSessionID),
		);
	});
}

/**
 * Abort an active PR workflow gate without reaching terminal completion.
 *
 * This is the escape hatch for the deadlock where `/swarm pr-review` activates
 * a PR_REVIEW gate without binding a PR head and the architect cannot reach
 * `completePrWorkflow` (compound `git fetch && git checkout` rejected by the
 * read-only shell classifier, missing PR ref, model confusion, etc.). Without
 * this path the durable gate is permanent for the session and the response
 * gate's auto-resume loop runs unbounded.
 *
 * Fail-closed semantics, checked in order:
 *   1. Authorization: operates on the raw caller `sessionID` only. A lane or
 *      child session whose ID has no gate record throws "no active gate" —
 *      lanes must not abort the controller's gate.
 *   2. Mode match when `expectedMode` is supplied.
 *   3. Refuses while `prFeedbackReadyToPublish` is set — clearing an armed
 *      gate would drop the immutable-commit binding and leave a half-published
 *      commit. The tool gate refuses armed abort too (defense in depth).
 *   4. Refuses while open `swarm-pr-*` delegations exist, matching
 *      `completePrWorkflow` — aborting mid-flight would orphan running lanes.
 *
 * Records a non-fatal audit event into the existing `.swarm/events.jsonl`
 * (no new ledger file), then delegates to `clearPrWorkflowGateState`.
 */
export async function abortPrWorkflow(
	directory: string,
	sessionID: string,
	options: { expectedMode?: PrWorkflowMode; reason?: string } = {},
): Promise<{
	mode: PrWorkflowMode;
	prHeadSha?: string;
	openLanes: number;
}> {
	const state = await requireAnyActiveState(directory, sessionID);
	if (options.expectedMode && state.mode !== options.expectedMode) {
		throw wrongModeError(state, options.expectedMode);
	}
	if (state.prFeedbackReadyToPublish) {
		throw new Error(
			`BLOCKED: ${state.mode} is armed for publication; abort is blocked. Complete the workflow with complete_pr_workflow (or push the bound commit first) before aborting.`,
		);
	}
	const openLanes = readDelegations(directory).filter(
		(record) =>
			record.parentSessionId === state.sessionID &&
			record.mode?.startsWith('swarm-pr-') &&
			(record.status === 'pending' || record.status === 'running'),
	);
	if (openLanes.length > 0) {
		const laneIds = openLanes
			.map((record) => record.laneId ?? record.subagentSessionId ?? 'unknown')
			.filter(Boolean)
			.slice(0, 10)
			.join(', ');
		throw new Error(
			`BLOCKED: ${state.mode} abort refused while ${openLanes.length} PR workflow lane(s) are still in flight (lane ids: ${laneIds}). Collect their results or let them settle before aborting.`,
		);
	}
	const sanitizedReason =
		typeof options.reason === 'string'
			? options.reason.trim().slice(0, 500)
			: undefined;
	const abortEvent = {
		type: 'pr_workflow_aborted',
		timestamp: isoNow(),
		sessionID: state.sessionID,
		mode: state.mode,
		...(state.prHeadSha ? { prHeadSha: state.prHeadSha } : {}),
		openLanes: openLanes.length,
		...(sanitizedReason ? { reason: sanitizedReason } : {}),
	};
	try {
		const eventsPath = validateSwarmPath(directory, 'events.jsonl');
		await fsp.appendFile(
			eventsPath,
			`${JSON.stringify(abortEvent)}\n`,
			'utf-8',
		);
	} catch {
		// Non-fatal: the audit trail is best-effort. The gate must clear
		// regardless so the deadlock does not persist because of a write error.
	}
	// Pass the revision snapshot as a CAS guard, matching completePrWorkflow's
	// concurrency discipline: if the gate state changed between our reads and
	// this clear, the clear is rejected and the caller revalidates. Self-heals
	// on retry and prevents a late concurrent mutation from being silently
	// dropped by our clear.
	await clearPrWorkflowGateState(directory, sessionID, state.revision);
	return {
		mode: state.mode,
		...(state.prHeadSha ? { prHeadSha: state.prHeadSha } : {}),
		openLanes: openLanes.length,
	};
}

/** Bind an active PR workflow to one immutable PR head. */
export async function bindPrWorkflowHead(
	directory: string,
	sessionID: string,
	prHeadSha: string,
): Promise<PrWorkflowGateState> {
	const state = await requireAnyActiveState(directory, sessionID);
	const normalizedHead = normalizePrHeadSha(prHeadSha);
	assertCurrentCheckoutHead(directory, normalizedHead);
	if (state.mode === 'PR_REVIEW') assertPrReviewCleanCheckout(directory);
	if (state.prHeadSha && state.prHeadSha !== normalizedHead) {
		throw new Error(
			`BLOCKED: active ${state.mode} workflow is bound to PR head "${state.prHeadSha}"; received "${normalizedHead}"`,
		);
	}
	if (state.prHeadSha === normalizedHead) return state;
	const nextState = {
		...state,
		prHeadSha: normalizedHead,
		updatedAt: isoNow(),
	};
	await persistState(directory, nextState);
	return nextState;
}

/** Bind an active PR_REVIEW workflow to one immutable merge-base scope. */
export async function bindPrReviewBase(
	directory: string,
	sessionID: string,
	options: { prHeadSha: string; baseRef: string; baseSha: string },
): Promise<PrWorkflowGateState> {
	let state = await bindPrWorkflowHead(directory, sessionID, options.prHeadSha);
	if (state.mode !== 'PR_REVIEW') {
		throw new Error('BLOCKED: only PR_REVIEW can bind a review merge base');
	}
	const baseRef = options.baseRef.trim();
	const baseSha = normalizePrHeadSha(options.baseSha).toLowerCase();
	if (!baseRef)
		throw new Error('BLOCKED: PR_REVIEW base_ref must not be empty');
	if (
		(state.prReviewBaseRef && state.prReviewBaseRef !== baseRef) ||
		(state.prReviewBaseSha && state.prReviewBaseSha !== baseSha)
	) {
		throw new Error(
			`BLOCKED: active PR_REVIEW is bound to merge-base scope "${state.prReviewBaseRef ?? '(unbound)'}" at "${state.prReviewBaseSha ?? '(unbound)'}"; received "${baseRef}" at "${baseSha}"`,
		);
	}
	if (state.prReviewBaseRef === baseRef && state.prReviewBaseSha === baseSha) {
		return state;
	}
	state = {
		...state,
		prReviewBaseRef: baseRef,
		prReviewBaseSha: baseSha,
		updatedAt: isoNow(),
	};
	await persistState(directory, state);
	return state;
}

/** Prove that caller-provided PR identity equals the actual checked-out commit. */
export function assertCurrentCheckoutHead(
	directory: string,
	expectedHead: string,
): string {
	const normalizedExpected = normalizePrHeadSha(expectedHead);
	const currentHead = _test_exports.resolveCurrentGitHead(directory)?.trim();
	if (!currentHead) {
		throw new Error(
			`BLOCKED: cannot verify the current Git HEAD against PR head "${normalizedExpected}"`,
		);
	}
	if (currentHead.toLowerCase() !== normalizedExpected.toLowerCase()) {
		throw new Error(
			`BLOCKED: current checkout HEAD "${currentHead}" does not match PR head "${normalizedExpected}"`,
		);
	}
	return normalizedExpected;
}

/** Prove that every PR-review lane reads the immutable checked-out PR tree. */
export function assertPrReviewCleanCheckout(directory: string): void {
	if (_test_exports.resolveIsWorkingTreeClean(directory) !== true) {
		throw new Error(
			'BLOCKED: PR_REVIEW requires a clean index and working tree at the exact PR head',
		);
	}
}

export async function enforcePrWorkflowDispatchLanesAsync(
	directory: string,
	sessionID: string,
	toolName: string,
): Promise<PrWorkflowGateState | null> {
	const state = await readPrWorkflowGateState(directory, sessionID);
	if (!state) return null;
	if (toolName === DISPATCH_TOOL_NAME) return state;
	if (toolName === BLOCKING_DISPATCH_TOOL_NAME) {
		throw new Error(
			`BLOCKED: active ${state.mode} workflow for session "${state.sessionID}" requires ${DISPATCH_TOOL_NAME}; ${BLOCKING_DISPATCH_TOOL_NAME} is not allowed`,
		);
	}
	return state;
}

export async function enforcePrReviewBaseDimensions(
	directory: string,
	sessionID: string,
	lanes: readonly PrWorkflowLaneSpec[],
	options: { batchId: string; prHeadSha: string },
): Promise<PrWorkflowGateState> {
	const state = await bindPrWorkflowHead(
		directory,
		sessionID,
		options.prHeadSha,
	);
	if (state.mode !== 'PR_REVIEW') {
		throw wrongModeError(state, 'PR_REVIEW');
	}
	const normalizedLanes = normalizeWorkflowLanes(lanes);
	const workflowLaneIds = normalizedLanes.map((lane) => lane.workflowLane);
	const extras = workflowLaneIds.filter(
		(laneId) =>
			!PR_REVIEW_BASE_DIMENSION_IDS.includes(laneId as PrReviewBaseDimensionId),
	);
	if (extras.length > 0) {
		const expected = PR_REVIEW_BASE_DIMENSION_IDS.join(', ');
		const received = workflowLaneIds.join(', ') || '(none)';
		throw new Error(
			`BLOCKED: PR_REVIEW base dispatch lane ids must be drawn from: ${expected}. Received: ${received}`,
		);
	}
	const batchId = normalizeBatchId(options.batchId);
	const previous = state.prReviewBaseDispatches ?? [];
	if (previous.some((record) => record.batchId === batchId)) {
		throw new Error(
			`BLOCKED: PR_REVIEW base batch id "${batchId}" is already recorded`,
		);
	}
	if (previous.length >= MAX_WORKFLOW_BATCHES) {
		throw new Error('BLOCKED: PR_REVIEW base batch limit reached');
	}
	const record: PrReviewBaseDispatchRecord = {
		batchId,
		lanes: normalizedLanes.map((lane) => ({
			laneId: lane.laneId,
			workflowLane: lane.workflowLane as PrReviewBaseDimensionId,
		})),
		validatedAt: isoNow(),
	};

	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prReviewBaseDispatches: [...previous, record],
		prReviewBaseDispatch: record,
	};
	await persistState(directory, nextState);
	return nextState;
}

/** Validate durable exact-six PR review evidence across all base and retry batches. */
export async function assertPrReviewBaseCoverageSettled(
	directory: string,
	sessionID: string,
): Promise<PrWorkflowGateState> {
	const state = await requireBoundState(directory, sessionID, 'PR_REVIEW');
	const batches = state.prReviewBaseDispatches ?? [];
	if (batches.length === 0) {
		throw new Error('BLOCKED: PR_REVIEW requires at least one base batch');
	}
	const covered = new Set<PrReviewBaseDimensionId>();
	for (const batch of batches) {
		const successful = successfulObligationsFromExactBatch(
			directory,
			state,
			batch.batchId,
			batch.lanes,
			'swarm-pr-review:base',
			batch.validatedAt,
		);
		for (const obligation of successful) {
			covered.add(obligation as PrReviewBaseDimensionId);
		}
	}
	const missing = PR_REVIEW_BASE_DIMENSION_IDS.filter(
		(dimension) => !covered.has(dimension),
	);
	if (
		missing.length > 0 ||
		covered.size !== PR_REVIEW_BASE_DIMENSION_IDS.length
	) {
		throw new Error(
			`BLOCKED: PR_REVIEW base coverage is incomplete; missing dimensions: ${missing.join(', ') || '(none)'}`,
		);
	}
	return state;
}

/** Persist a council/reviewer/critic validation batch before launch. */
export async function recordPrReviewValidationBatch(
	directory: string,
	sessionID: string,
	phase: PrReviewValidationPhase,
	lanes: readonly PrWorkflowLaneSpec[],
	options: { batchId: string; prHeadSha: string },
): Promise<PrWorkflowGateState> {
	let state = await bindPrWorkflowHead(directory, sessionID, options.prHeadSha);
	if (state.mode !== 'PR_REVIEW') throw wrongModeError(state, 'PR_REVIEW');
	if (!state.prReviewTriggerEvalPath) {
		throw new Error(
			'BLOCKED: PR_REVIEW validation dispatch requires a completed trigger evaluation',
		);
	}
	if (
		phase === 'reviewer' &&
		(state.prReviewValidationBatches ?? []).some(
			(batch) => batch.phase === 'council',
		)
	) {
		state = await assertPrReviewValidationSettled(
			directory,
			sessionID,
			'council',
		);
	} else if (phase === 'critic') {
		state = await assertPrReviewValidationSettled(
			directory,
			sessionID,
			'reviewer',
		);
	}
	const normalizedLanes = normalizeWorkflowLanes(lanes);
	if (
		(phase === 'reviewer' || phase === 'critic') &&
		normalizedLanes.some((lane) => !lane.reviewItemIds?.length)
	) {
		throw new Error(
			`BLOCKED: PR_REVIEW ${phase} lanes require non-empty review_item_ids ownership`,
		);
	}
	if (phase === 'reviewer' || phase === 'critic') {
		assertNoDuplicates(
			normalizedLanes.flatMap((lane) => lane.reviewItemIds ?? []),
			`PR_REVIEW ${phase} review item ownership`,
		);
		const assigned = normalizedLanes.flatMap(
			(lane) => lane.reviewItemIds ?? [],
		);
		const required =
			phase === 'reviewer'
				? derivePrReviewCandidateInventory(directory, state)
				: derivePrReviewCriticInventory(directory, state);
		assertExactStringSet(assigned, required, `PR_REVIEW ${phase} ownership`);
	}
	const batchId = normalizeBatchId(options.batchId);
	const previous = state.prReviewValidationBatches ?? [];
	if (previous.some((batch) => batch.batchId === batchId)) {
		throw new Error(
			`BLOCKED: PR_REVIEW validation batch id "${batchId}" is already recorded`,
		);
	}
	if (previous.length >= MAX_WORKFLOW_BATCHES) {
		throw new Error('BLOCKED: PR_REVIEW validation batch limit reached');
	}
	const record: PrReviewValidationBatchRecord = {
		batchId,
		phase,
		lanes: normalizedLanes,
		validatedAt: isoNow(),
	};
	// Any new reviewer verdict set invalidates every prior critic receipt. A
	// critic is meaningful only for the reviewer inventory that immediately
	// precedes it; stale critic batches must never certify later severities.
	const retained =
		phase === 'reviewer'
			? previous.filter((batch) => batch.phase !== 'critic')
			: previous;
	const nextState = {
		...state,
		updatedAt: isoNow(),
		prReviewValidationBatches: [...retained, record],
	};
	await persistState(directory, nextState);
	return nextState;
}

/** Validate that every declared council/reviewer/critic obligation has a successful retry. */
export async function assertPrReviewValidationSettled(
	directory: string,
	sessionID: string,
	phase?: PrReviewValidationPhase,
): Promise<PrWorkflowGateState> {
	const state = await requireBoundState(directory, sessionID, 'PR_REVIEW');
	const declaredPhases = new Set(
		(state.prReviewValidationBatches ?? []).map((batch) => batch.phase),
	);
	const phases: PrReviewValidationPhase[] = phase
		? [phase]
		: (['council', 'reviewer', 'critic'] as const).filter((candidate) =>
				declaredPhases.has(candidate),
			);
	for (const requiredPhase of phases) {
		const validationBatches = state.prReviewValidationBatches ?? [];
		const forbiddenSubagentSessionIds = new Set<string>();
		if (requiredPhase === 'critic') {
			for (const reviewerBatch of validationBatches.filter(
				(batch) => batch.phase === 'reviewer',
			)) {
				for (const record of findByBatchId(directory, reviewerBatch.batchId, {
					parentSessionId: state.sessionID,
				})) {
					const subagentSessionId = record.subagentSessionId?.trim();
					if (subagentSessionId) {
						forbiddenSubagentSessionIds.add(subagentSessionId);
					}
				}
			}
		}
		let batches = validationBatches.filter(
			(batch) => batch.phase === requiredPhase,
		);
		if (requiredPhase === 'reviewer') {
			let latestCouncilIndex = -1;
			for (let index = 0; index < validationBatches.length; index++) {
				if (validationBatches[index]?.phase === 'council') {
					latestCouncilIndex = index;
				}
			}
			if (latestCouncilIndex >= 0) {
				batches = validationBatches
					.slice(latestCouncilIndex + 1)
					.filter((batch) => batch.phase === 'reviewer');
			}
		}
		if (batches.length === 0) {
			throw new Error(
				requiredPhase === 'reviewer' && declaredPhases.has('council')
					? 'BLOCKED: PR_REVIEW requires at least one reviewer batch after the latest council batch'
					: `BLOCKED: PR_REVIEW requires at least one ${requiredPhase} batch`,
			);
		}
		const allObligations = new Set(
			batches.flatMap((batch) => batch.lanes.map((lane) => lane.workflowLane)),
		);
		const settled = new Set<string>();
		let hasFullySuccessfulExactBatch = false;
		for (const batch of batches) {
			const successful = successfulObligationsFromExactBatch(
				directory,
				state,
				batch.batchId,
				batch.lanes,
				`swarm-pr-review:${requiredPhase}`,
				batch.validatedAt,
				true,
				forbiddenSubagentSessionIds,
			);
			if (
				successful.size === batch.lanes.length &&
				batch.lanes.every((lane) => successful.has(lane.workflowLane))
			) {
				hasFullySuccessfulExactBatch = true;
			}
			for (const obligation of successful) {
				settled.add(obligation);
			}
		}
		if (
			(requiredPhase === 'reviewer' || requiredPhase === 'critic') &&
			!hasFullySuccessfulExactBatch
		) {
			throw new Error(
				`BLOCKED: PR_REVIEW ${requiredPhase} requires one fully successful exact batch; complementary partial retries are not a coherent verdict set`,
			);
		}
		const missing = [...allObligations].filter(
			(obligation) => !settled.has(obligation),
		);
		if (missing.length > 0) {
			throw new Error(
				`BLOCKED: PR_REVIEW ${requiredPhase} obligations lack successful exact artifacts: ${missing.join(', ')}`,
			);
		}
	}
	return state;
}

export async function declarePrFeedbackInventory(
	directory: string,
	sessionID: string,
	inventoryIds: readonly string[],
	options: { prHeadSha: string },
): Promise<PrWorkflowGateState> {
	const state = await bindPrWorkflowHead(
		directory,
		sessionID,
		options.prHeadSha,
	);
	if (state.mode !== 'PR_FEEDBACK') {
		throw wrongModeError(state, 'PR_FEEDBACK');
	}
	const normalizedInventory = normalizeInventoryIds(inventoryIds);
	if (state.prFeedbackInventory) {
		if (!sameStringArray(state.prFeedbackInventory, normalizedInventory)) {
			throw new Error(
				'BLOCKED: PR_FEEDBACK inventory is immutable after declaration',
			);
		}
		return state;
	}
	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prFeedbackInventory: normalizedInventory,
		prFeedbackVerifications: [],
	};
	await persistState(directory, nextState);
	return nextState;
}

export async function enforcePrFeedbackVerificationOwnership(
	directory: string,
	sessionID: string,
	ownership: readonly PrFeedbackLaneOwnership[],
	options: { batchId: string; prHeadSha: string },
): Promise<PrWorkflowGateState> {
	const state = await bindPrWorkflowHead(
		directory,
		sessionID,
		options.prHeadSha,
	);
	if (state.mode !== 'PR_FEEDBACK') {
		throw wrongModeError(state, 'PR_FEEDBACK');
	}
	const inventory = state.prFeedbackInventory;
	if (!inventory || inventory.length === 0) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK verification for session "${state.sessionID}" requires a declared feedback inventory before dispatch`,
		);
	}

	const normalizedOwnership = normalizeOwnership(ownership);
	const inventorySet = new Set(inventory);
	const claimedByItemId = new Map<string, string>();
	const previous = state.prFeedbackVerifications ?? [];
	const batchId = normalizeBatchId(options.batchId);
	if (previous.some((record) => record.batchId === batchId)) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK verification batch id "${batchId}" is already recorded`,
		);
	}
	if (previous.length >= MAX_WORKFLOW_BATCHES) {
		throw new Error('BLOCKED: PR_FEEDBACK verification batch limit reached');
	}
	for (const record of previous) {
		for (const lane of record.ownership) {
			for (const itemId of lane.ownedItemIds) {
				claimedByItemId.set(itemId, lane.laneId);
			}
		}
	}

	for (const lane of normalizedOwnership) {
		for (const itemId of lane.ownedItemIds) {
			if (!inventorySet.has(itemId)) {
				throw new Error(
					`BLOCKED: PR_FEEDBACK verification lane "${lane.laneId}" owns undeclared item "${itemId}"`,
				);
			}
			const previousLane = claimedByItemId.get(itemId);
			if (previousLane && previousLane !== lane.laneId) {
				throw new Error(
					`BLOCKED: PR_FEEDBACK verification item "${itemId}" is owned by both "${previousLane}" and "${lane.laneId}"`,
				);
			}
			claimedByItemId.set(itemId, lane.laneId);
		}
	}

	const record: PrFeedbackVerificationRecord = {
		batchId,
		ownership: normalizedOwnership,
		validatedAt: isoNow(),
	};

	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prFeedbackVerifications: [...previous, record],
		prFeedbackVerification: record,
	};
	await persistState(directory, nextState);
	return nextState;
}

/** Validate cumulative exact inventory ownership and settled verification artifacts. */
export async function assertPrFeedbackVerificationSettled(
	directory: string,
	sessionID: string,
): Promise<PrWorkflowGateState> {
	const state = await requireBoundState(directory, sessionID, 'PR_FEEDBACK');
	const currentDigest = await currentPrFeedbackRevisionDigest(directory, state);
	const inventory = state.prFeedbackInventory;
	const batches = state.prFeedbackVerifications ?? [];
	if (!inventory || batches.length === 0) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK requires an immutable inventory and verification batches',
		);
	}
	const covered = new Set<string>();
	for (const batch of batches) {
		const successfulLaneIds = successfulObligationsFromExactBatch(
			directory,
			state,
			batch.batchId,
			batch.ownership.map((lane) => ({
				laneId: lane.laneId,
				workflowLane: lane.laneId,
			})),
			'swarm-pr-feedback:verification',
			batch.validatedAt,
			false,
			new Set(),
			currentDigest,
		);
		for (const lane of batch.ownership) {
			if (!successfulLaneIds.has(lane.laneId)) continue;
			if (
				!feedbackArtifactCoversItems(
					directory,
					state,
					batch.batchId,
					lane.laneId,
					lane.ownedItemIds,
				)
			)
				continue;
			for (const itemId of lane.ownedItemIds) covered.add(itemId);
		}
	}
	const missing = inventory.filter((itemId) => !covered.has(itemId));
	if (missing.length > 0 || covered.size !== inventory.length) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK verification ownership is incomplete; missing inventory items: ${missing.join(', ') || '(none)'}`,
		);
	}
	return state;
}

const PR_FEEDBACK_PHASE_ORDER: readonly PrFeedbackGatePhase[] = [
	'stage-b-reviewer',
	'stage-b-test',
	'closeout-reviewer',
	'closeout-critic',
];

/** Persist an actually executed Stage A receipt and invalidate later approvals. */
export async function recordPrFeedbackStageA(
	directory: string,
	sessionID: string,
	revisionDigest: string,
	checks: readonly PrFeedbackStageACheckReceipt[],
	options: {
		applicableCategories?: ReadonlyArray<'build' | 'typecheck' | 'lint'>;
		applicableObligations?: ReadonlyArray<{
			id: string;
			category: 'build' | 'typecheck' | 'lint';
			workingDirectory: string;
			source: string;
			validatorContract?: { path: string; id: string };
		}>;
	} = {},
): Promise<PrWorkflowGateState> {
	const state = await assertPrFeedbackVerificationSettled(directory, sessionID);
	const currentDigest = await currentPrFeedbackRevisionDigest(directory, state);
	if (revisionDigest !== currentDigest) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK Stage A receipt is stale because the working-tree revision changed during validation',
		);
	}
	if (checks.length < 2 || checks.length > 258) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK Stage A requires two to 258 controller-created check receipts',
		);
	}
	const optionalCategoryOrder = ['build', 'typecheck', 'lint'] as const;
	const applicableCategories =
		options.applicableCategories ??
		optionalCategoryOrder.filter((category) =>
			checks.some((check) => check.category === category),
		);
	assertNoDuplicates(
		applicableCategories,
		'PR_FEEDBACK Stage A applicable categories',
	);
	if (
		applicableCategories.some(
			(category) => !optionalCategoryOrder.includes(category),
		)
	) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK Stage A applicability may contain only build, typecheck, and lint',
		);
	}
	const required = new Set<PrFeedbackStageACategory>([
		'diff-check',
		'reproduction',
		...applicableCategories,
	]);
	const singletonSeen = new Set<string>();
	const applicableObligations = [...(options.applicableObligations ?? [])];
	assertNoDuplicates(
		applicableObligations.map(({ id }) => id),
		'PR_FEEDBACK Stage A applicable obligations',
	);
	const requiredObligationIds = new Set(
		applicableObligations.map(({ id }) => id),
	);
	const commandDigests = new Set<string>();
	let reproductionFeedbackItemIds: string[] = [];
	for (const check of checks) {
		if (
			['diff-check', 'reproduction'].includes(check.category) &&
			singletonSeen.has(check.category)
		) {
			throw new Error(
				`BLOCKED: PR_FEEDBACK Stage A contains duplicate category "${check.category}"`,
			);
		}
		singletonSeen.add(check.category);
		required.delete(check.category);
		if (check.obligationId) {
			const obligation = applicableObligations.find(
				(candidate) => candidate.id === check.obligationId,
			);
			if (
				!obligation ||
				obligation.category !== check.category ||
				obligation.workingDirectory !== (check.workingDirectory ?? '.') ||
				!requiredObligationIds.delete(check.obligationId)
			) {
				throw new Error(
					`BLOCKED: PR_FEEDBACK Stage A receipt does not match one exact applicable obligation: ${check.obligationId}`,
				);
			}
			const sourceContract = obligation.source.includes('.pr-validation.json#')
				? {
						path: obligation.source.slice(
							0,
							obligation.source.lastIndexOf('#'),
						),
						id: obligation.source.slice(obligation.source.lastIndexOf('#') + 1),
					}
				: undefined;
			const requiredContract = obligation.validatorContract ?? sourceContract;
			if (
				requiredContract &&
				(check.validatorContract?.path !== requiredContract.path ||
					check.validatorContract.id !== requiredContract.id)
			) {
				throw new Error(
					`BLOCKED: PR_FEEDBACK Stage A obligation ${obligation.id} requires exact validator contract provenance`,
				);
			}
		}
		const commandDigest = createHash('sha256')
			.update(
				`${check.obligationId ?? check.category}\0${check.workingDirectory ?? '.'}\0${check.command.join('\0')}`,
			)
			.digest('hex');
		if (commandDigests.has(commandDigest)) {
			throw new Error(
				'BLOCKED: PR_FEEDBACK Stage A cannot reuse one command as multiple check receipts',
			);
		}
		commandDigests.add(commandDigest);
		if (
			check.category === 'diff-check' &&
			!sameStringArray(check.command, ['git', 'diff', '--check'])
		) {
			throw new Error(
				'BLOCKED: PR_FEEDBACK Stage A diff-check receipt is not the exact git diff --check command',
			);
		}
		if (
			check.category === 'reproduction' &&
			(!check.targets?.length ||
				!check.feedbackTargets?.length ||
				check.targets.some(
					(target) => !check.command.join(' ').includes(target),
				))
		) {
			throw new Error(
				'BLOCKED: PR_FEEDBACK Stage A reproduction receipt requires exact selected targets',
			);
		}
		if (check.category === 'reproduction') {
			reproductionFeedbackItemIds = check.feedbackTargets!.map(
				(mapping) => mapping.feedbackItemId,
			);
			assertNoDuplicates(
				reproductionFeedbackItemIds,
				'PR_FEEDBACK Stage A reproduction feedback item mappings',
			);
			if (
				check.feedbackTargets!.some(
					(mapping) => !check.targets!.includes(mapping.target),
				)
			) {
				throw new Error(
					'BLOCKED: PR_FEEDBACK Stage A feedback mappings must reference exact executed reproduction targets',
				);
			}
		}
	}
	if (required.size > 0) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK Stage A is missing required checks: ${[...required].join(', ')}`,
		);
	}
	if (requiredObligationIds.size > 0) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK Stage A is missing applicable workspace obligations: ${[...requiredObligationIds].join(', ')}`,
		);
	}
	if (
		!sameStringArray(
			reproductionFeedbackItemIds,
			state.prFeedbackInventory ?? [],
		)
	) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK Stage A reproduction must map every immutable feedback item exactly once and in declared order',
		);
	}
	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prFeedbackStageA: {
			revisionDigest: currentDigest,
			checks: [...checks],
			feedbackItemIds: reproductionFeedbackItemIds,
			applicableCategories: optionalCategoryOrder.filter((category) =>
				applicableCategories.includes(category),
			),
			applicableObligations,
			validatedAt: isoNow(),
		},
		prFeedbackGateBatches: [],
		prFeedbackReadyToPublish: undefined,
	};
	await persistState(directory, nextState);
	return nextState;
}

/** Record one ordered, single-lane feedback validation phase before launch. */
export async function recordPrFeedbackGateBatch(
	directory: string,
	sessionID: string,
	phase: PrFeedbackGatePhase,
	lane: PrFeedbackLaneOwnership,
	options: { batchId: string; prHeadSha: string; revisionDigest: string },
): Promise<PrWorkflowGateState> {
	let state = await bindPrWorkflowHead(directory, sessionID, options.prHeadSha);
	if (state.mode !== 'PR_FEEDBACK') throw wrongModeError(state, 'PR_FEEDBACK');
	const inventory = state.prFeedbackInventory;
	if (!inventory?.length) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK ordered gates require an immutable feedback inventory',
		);
	}
	const normalized = normalizeOwnership([lane])[0];
	if (!sameStringArray(normalized.ownedItemIds, inventory)) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK ${phase} must own every inventory item exactly once and in declared order`,
		);
	}
	const phaseIndex = PR_FEEDBACK_PHASE_ORDER.indexOf(phase);
	const prerequisite = PR_FEEDBACK_PHASE_ORDER[phaseIndex - 1];
	if (prerequisite) {
		state = await assertPrFeedbackGatePhaseSettled(
			directory,
			sessionID,
			prerequisite,
		);
	}
	// The prerequisite check may await independent evidence. Refresh the durable
	// state and digest afterwards so the newly-recorded batch cannot bind an
	// earlier content snapshot.
	const stageA = state.prFeedbackStageA;
	const refreshedInventory = state.prFeedbackInventory;
	const currentDigest = await currentPrFeedbackRevisionDigest(directory, state);
	if (
		!stageA ||
		!refreshedInventory ||
		stageA.revisionDigest !== currentDigest ||
		!sameStringArray(stageA.feedbackItemIds ?? [], refreshedInventory) ||
		options.revisionDigest !== currentDigest
	) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK ${phase} requires fresh Stage A checks on the current revision`,
		);
	}
	const batchId = normalizeBatchId(options.batchId);
	const previous = state.prFeedbackGateBatches ?? [];
	if (previous.some((batch) => batch.batchId === batchId)) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK gate batch id "${batchId}" is already recorded`,
		);
	}
	const retained = previous.filter(
		(batch) => PR_FEEDBACK_PHASE_ORDER.indexOf(batch.phase) < phaseIndex,
	);
	const record: PrFeedbackGateBatchRecord = {
		batchId,
		phase,
		laneId: normalized.laneId,
		itemIds: normalized.ownedItemIds,
		revisionDigest: currentDigest,
		validatedAt: isoNow(),
	};
	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prFeedbackGateBatches: [...retained, record],
	};
	await persistState(directory, nextState);
	return nextState;
}

/** Require the latest receipt for a feedback gate phase to be positive and fresh. */
export async function assertPrFeedbackGatePhaseSettled(
	directory: string,
	sessionID: string,
	phase: PrFeedbackGatePhase,
): Promise<PrWorkflowGateState> {
	const state = await requireBoundState(directory, sessionID, 'PR_FEEDBACK');
	const currentDigest = await currentPrFeedbackRevisionDigest(directory, state);
	if (state.prFeedbackStageA?.revisionDigest !== currentDigest) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK ${phase} cannot use stale Stage A evidence`,
		);
	}
	if (
		!sameStringArray(
			state.prFeedbackStageA?.feedbackItemIds ?? [],
			state.prFeedbackInventory ?? [],
		)
	) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK ${phase} Stage A reproduction is not bound to the exact immutable feedback inventory`,
		);
	}
	const batch = [...(state.prFeedbackGateBatches ?? [])]
		.reverse()
		.find((candidate) => candidate.phase === phase);
	if (!batch || batch.revisionDigest !== currentDigest) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK ${phase} has no validation batch on the current revision`,
		);
	}
	const successful = successfulObligationsFromExactBatch(
		directory,
		state,
		batch.batchId,
		[
			{
				laneId: batch.laneId,
				workflowLane: phase,
				reviewItemIds: batch.itemIds,
			},
		],
		`swarm-pr-feedback:${phase}`,
		batch.validatedAt,
		true,
		new Set(),
		currentDigest,
	);
	if (!successful.has(phase)) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK ${phase} requires one complete, non-degraded positive verdict row per inventory item`,
		);
	}
	const record = findByBatchId(directory, batch.batchId, {
		parentSessionId: state.sessionID,
	}).find((candidate) => candidate.laneId === batch.laneId);
	if (record?.workspace?.dirtyHash !== currentDigest) {
		throw new Error(
			`BLOCKED: PR_FEEDBACK ${phase} artifact is not bound to the current revision digest`,
		);
	}
	assertIndependentFeedbackGateSessions(directory, state, phase);
	return state;
}

const PR_FEEDBACK_PHASE_ROLE: Readonly<Record<PrFeedbackGatePhase, string>> = {
	'stage-b-reviewer': 'reviewer',
	'stage-b-test': 'test_engineer',
	'closeout-reviewer': 'reviewer',
	'closeout-critic': 'critic',
};

/** Prove each ordered gate came from a distinct, correctly-typed child session. */
function assertIndependentFeedbackGateSessions(
	directory: string,
	state: PrWorkflowGateState,
	throughPhase: PrFeedbackGatePhase,
): void {
	const throughIndex = PR_FEEDBACK_PHASE_ORDER.indexOf(throughPhase);
	const batches = (state.prFeedbackGateBatches ?? []).filter(
		(batch) => PR_FEEDBACK_PHASE_ORDER.indexOf(batch.phase) <= throughIndex,
	);
	const seenSessions = new Set<string>();
	for (const batch of batches) {
		const matching = findByBatchId(directory, batch.batchId, {
			parentSessionId: state.sessionID,
		}).filter((record) => record.laneId === batch.laneId);
		if (matching.length !== 1) {
			throw new Error(
				`BLOCKED: PR_FEEDBACK ${batch.phase} must resolve from exactly one durable child session`,
			);
		}
		const record = matching[0];
		const expectedRole = PR_FEEDBACK_PHASE_ROLE[batch.phase];
		const roleMatches =
			record.normalizedAgent === expectedRole ||
			(expectedRole === 'critic' &&
				record.normalizedAgent.startsWith('critic_'));
		if (!roleMatches) {
			throw new Error(
				`BLOCKED: PR_FEEDBACK ${batch.phase} requires role ${expectedRole}, received ${record.normalizedAgent || '(unknown)'}`,
			);
		}
		if (seenSessions.has(record.subagentSessionId)) {
			throw new Error(
				`BLOCKED: PR_FEEDBACK independent phases reused child session "${record.subagentSessionId}"`,
			);
		}
		seenSessions.add(record.subagentSessionId);
	}
}

/** Require every ordered feedback gate on one unchanged revision. */
export async function assertPrFeedbackReadyToPublish(
	directory: string,
	sessionID: string,
): Promise<PrWorkflowGateState> {
	let state = await assertPrFeedbackVerificationSettled(directory, sessionID);
	for (const phase of PR_FEEDBACK_PHASE_ORDER) {
		state = await assertPrFeedbackGatePhaseSettled(directory, sessionID, phase);
	}
	return state;
}

async function assertPrFeedbackPublicationArmed(
	directory: string,
	sessionID: string,
): Promise<PrWorkflowGateState> {
	const state = await requireBoundState(directory, sessionID, 'PR_FEEDBACK');
	const armed = state.prFeedbackReadyToPublish;
	if (!armed) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK publication is not armed; call complete_pr_workflow once after every ordered gate passes',
		);
	}
	const currentDigest = await currentPrFeedbackRevisionDigest(directory, state);
	if (armed.revisionDigest !== currentDigest) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK changed after publication was armed; rerun Stage A and every independent gate',
		);
	}
	if (
		_test_exports.resolveCurrentGitHead(directory)?.trim() !== armed.localHead
	) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK current Git HEAD changed after publication was armed',
		);
	}
	if (_test_exports.resolveIsWorkingTreeClean(directory) !== true) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK working tree changed after publication was armed',
		);
	}
	const currentTarget =
		_test_exports.resolveCurrentUpstreamPushTarget(directory);
	if (
		!currentTarget ||
		currentTarget.remoteName !== armed.remoteName ||
		currentTarget.remoteBranchRef !== armed.remoteBranchRef ||
		currentTarget.remoteTrackingRef !== armed.remoteRef
	) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK upstream publication target changed after publication was armed',
		);
	}
	return state;
}

export async function markPrReviewTriggerEvaluationComplete(
	directory: string,
	sessionID: string,
	artifactPath: string,
): Promise<PrWorkflowGateState> {
	const state = await assertPrReviewBaseCoverageSettled(directory, sessionID);
	const normalizedPath = artifactPath.trim();
	if (!normalizedPath) {
		throw new Error('BLOCKED: PR_REVIEW trigger artifact path is required');
	}
	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prReviewTriggerEvalPath: normalizedPath,
	};
	await persistState(directory, nextState);
	return nextState;
}

export async function assertPrReviewArtifactBoundary(
	directory: string,
	sessionID: string,
	runId: string,
	boundary: PrReviewArtifactBoundary,
	findingIds: string[],
): Promise<PrWorkflowGateState> {
	let state = await requireBoundState(directory, sessionID, 'PR_REVIEW');
	if (!state.prReviewTriggerEvalPath) {
		throw new Error(
			'BLOCKED: PR_REVIEW findings persistence requires the trigger evaluation artifact',
		);
	}
	const persistedBoundaries = state.prReviewArtifactBoundaries ?? [];
	const boundaryOrder: readonly PrReviewArtifactBoundary[] = [
		'post_explorer',
		'post_reviewer',
		'post_critic',
	];
	const boundaryIndex = boundaryOrder.indexOf(boundary);
	const requiredPriorBoundary = boundaryOrder[boundaryIndex - 1];
	if (
		requiredPriorBoundary &&
		!persistedBoundaries.includes(requiredPriorBoundary)
	) {
		throw new Error(
			`BLOCKED: PR_REVIEW ${boundary} findings require the prior ${requiredPriorBoundary} checkpoint`,
		);
	}
	if (
		persistedBoundaries.some(
			(persisted) => boundaryOrder.indexOf(persisted) > boundaryIndex,
		)
	) {
		throw new Error(
			`BLOCKED: PR_REVIEW ${boundary} findings cannot be persisted after a later checkpoint`,
		);
	}
	if (boundary === 'post_reviewer') {
		state = await assertPrReviewValidationSettled(
			directory,
			sessionID,
			'reviewer',
		);
	} else if (boundary === 'post_critic') {
		await assertPrReviewValidationSettled(directory, sessionID, 'reviewer');
		if (derivePrReviewCriticInventory(directory, state).length > 0) {
			state = await assertPrReviewValidationSettled(
				directory,
				sessionID,
				'critic',
			);
		}
	}
	if (state.prReviewArtifactRunId && state.prReviewArtifactRunId !== runId) {
		throw new Error(
			`BLOCKED: PR_REVIEW artifacts are already bound to run "${state.prReviewArtifactRunId}"`,
		);
	}
	const expectedFindingIds = derivePrReviewCandidateInventory(directory, state);
	const normalizedFindingIds = [...new Set(findingIds)].sort();
	if (
		normalizedFindingIds.length !== findingIds.length ||
		JSON.stringify(normalizedFindingIds) !==
			JSON.stringify([...expectedFindingIds].sort())
	) {
		throw new Error(
			`BLOCKED: PR_REVIEW ${boundary} findings must exactly cover the discovered candidate inventory`,
		);
	}
	return state;
}

/**
 * Artifact records are a projection of lane receipts, never a caller-controlled
 * replacement for them. Keep their workflow status/action aligned with the
 * reviewer and critic rows that the gate already authenticated.
 */
export async function assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts(
	directory: string,
	sessionID: string,
	boundary: PrReviewArtifactBoundary,
	records: readonly PrReviewArtifactRecord[],
): Promise<void> {
	const state = await requireBoundState(directory, sessionID, 'PR_REVIEW');
	if (boundary === 'post_explorer') {
		for (const record of records) {
			if (
				record.status !== 'PENDING' ||
				record.next_action !== 'route_to_reviewer'
			) {
				throw new Error(
					`BLOCKED: PR_REVIEW post_explorer record ${record.finding_id} must remain PENDING and route_to_reviewer`,
				);
			}
		}
		return;
	}

	const reviewerVerdicts = deriveLatestPrReviewReviewerVerdicts(
		directory,
		state,
	);
	const criticVerdicts =
		boundary === 'post_critic'
			? deriveLatestPrReviewCriticVerdicts(directory, state)
			: undefined;
	for (const record of records) {
		const reviewer = reviewerVerdicts.get(record.finding_id);
		if (!reviewer) {
			throw new Error(
				`BLOCKED: PR_REVIEW ${boundary} record ${record.finding_id} has no authoritative reviewer verdict`,
			);
		}
		if (record.severity && record.severity !== reviewer.severity) {
			throw new Error(
				`BLOCKED: PR_REVIEW ${boundary} record ${record.finding_id} severity differs from its reviewer verdict`,
			);
		}
		const requiresCritic =
			reviewer.classification === 'CONFIRMED' &&
			['CRITICAL', 'HIGH', 'MEDIUM'].includes(reviewer.severity);
		if (boundary === 'post_reviewer') {
			const expectedStatus =
				reviewer.classification === 'UNVERIFIED'
					? 'PENDING'
					: reviewer.classification;
			if (record.status !== expectedStatus) {
				throw new Error(
					`BLOCKED: PR_REVIEW post_reviewer record ${record.finding_id} status differs from its reviewer verdict`,
				);
			}
			const expectedAction = requiresCritic
				? 'route_to_critic'
				: reviewer.classification === 'CONFIRMED' ||
						reviewer.classification === 'PRE_EXISTING'
					? 'report'
					: reviewer.classification === 'DISPROVED'
						? 'suppress_with_reason'
						: 'route_to_reviewer';
			if (record.next_action !== expectedAction) {
				throw new Error(
					`BLOCKED: PR_REVIEW post_reviewer record ${record.finding_id} action does not match reviewer disposition`,
				);
			}
			continue;
		}

		if (!requiresCritic) {
			const expectedStatus =
				reviewer.classification === 'UNVERIFIED'
					? 'PENDING'
					: reviewer.classification;
			const expectedAction =
				reviewer.classification === 'CONFIRMED' ||
				reviewer.classification === 'PRE_EXISTING'
					? 'report'
					: reviewer.classification === 'DISPROVED'
						? 'suppress_with_reason'
						: 'route_to_reviewer';
			if (
				record.status !== expectedStatus ||
				record.next_action !== expectedAction
			) {
				throw new Error(
					`BLOCKED: PR_REVIEW post_critic record ${record.finding_id} cannot override its non-critic reviewer disposition`,
				);
			}
			continue;
		}

		const critic = criticVerdicts?.get(record.finding_id);
		if (!critic) {
			throw new Error(
				`BLOCKED: PR_REVIEW post_critic record ${record.finding_id} has no authoritative critic verdict`,
			);
		}
		if (record.severity && record.severity !== critic.severity) {
			throw new Error(
				`BLOCKED: PR_REVIEW post_critic record ${record.finding_id} severity differs from its critic verdict`,
			);
		}
		if (critic.status === 'DISPROVED') {
			if (
				record.status !== 'DISPROVED' ||
				record.next_action !== 'suppress_with_reason'
			) {
				throw new Error(
					`BLOCKED: PR_REVIEW post_critic record ${record.finding_id} must preserve the critic DISPROVED disposition`,
				);
			}
		} else if (
			record.status !== 'CONFIRMED' ||
			!['report', 'handoff_to_feedback'].includes(record.next_action)
		) {
			throw new Error(
				`BLOCKED: PR_REVIEW post_critic record ${record.finding_id} action does not match its critic verdict`,
			);
		}
	}
}

export async function markPrReviewArtifactBoundary(
	directory: string,
	sessionID: string,
	runId: string,
	boundary: PrReviewArtifactBoundary,
	artifactPath: string,
	findingIds: string[],
	handoffRequired: boolean,
): Promise<PrWorkflowGateState> {
	const state = await assertPrReviewArtifactBoundary(
		directory,
		sessionID,
		runId,
		boundary,
		findingIds,
	);
	const boundaries = new Set(state.prReviewArtifactBoundaries ?? []);
	boundaries.add(boundary);
	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prReviewArtifactRunId: runId,
		prReviewFindingsPath: artifactPath,
		prReviewArtifactBoundaries: [...boundaries],
		prReviewHandoffRequired: handoffRequired,
	};
	await persistState(directory, nextState);
	return nextState;
}

export async function markPrReviewHandoffComplete(
	directory: string,
	sessionID: string,
	runId: string,
	artifactPath: string,
): Promise<PrWorkflowGateState> {
	const state = await requireBoundState(directory, sessionID, 'PR_REVIEW');
	if (
		state.prReviewArtifactRunId !== runId ||
		!(state.prReviewArtifactBoundaries ?? []).includes('post_critic')
	) {
		throw new Error(
			'BLOCKED: PR_REVIEW handoff requires the final findings boundary for the same run',
		);
	}
	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prReviewHandoffPath: artifactPath,
	};
	await persistState(directory, nextState);
	return nextState;
}

export async function declarePrFeedbackScope(
	directory: string,
	sessionID: string,
	taskId: string,
	files: string[],
): Promise<PrWorkflowGateState> {
	const state = await assertPrFeedbackVerificationSettled(directory, sessionID);
	const revisionDigest = await currentPrFeedbackRevisionDigest(
		directory,
		state,
	);
	const previous = state.prFeedbackScopes ?? [];
	const existing = previous.find((entry) => entry.taskId === taskId);
	if (existing?.consumedByCallId) {
		throw new Error(
			`SCOPE_NOT_DECLARED: PR-feedback scope ${taskId} was already consumed; use a fresh task_id for any retry`,
		);
	}
	const record: PrFeedbackScopeDeclarationRecord = {
		taskId,
		files,
		revisionDigest,
		declaredAt: isoNow(),
	};
	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prFeedbackScopes: [
			...previous.filter((entry) => entry.taskId !== taskId),
			record,
		],
	};
	await persistState(directory, nextState);
	return nextState;
}

export async function resolvePrFeedbackScopeDeclaration(
	directory: string,
	sessionID: string,
	taskId: string,
): Promise<PrFeedbackScopeDeclarationRecord | null> {
	const state = await readPrWorkflowGateState(directory, sessionID);
	if (state?.mode !== 'PR_FEEDBACK') return null;
	const declaration = (state.prFeedbackScopes ?? []).find(
		(entry) => entry.taskId === taskId,
	);
	if (!declaration) return null;
	await assertPrFeedbackVerificationSettled(directory, sessionID);
	const currentDigest = await currentPrFeedbackRevisionDigest(directory, state);
	return currentDigest === declaration.revisionDigest ? declaration : null;
}

export async function consumePrFeedbackScopeDeclaration(
	directory: string,
	sessionID: string,
	taskId: string,
	callID: string,
): Promise<PrFeedbackScopeDeclarationRecord | null> {
	const declaration = await resolvePrFeedbackScopeDeclaration(
		directory,
		sessionID,
		taskId,
	);
	if (!declaration) return null;
	if (declaration.consumedByCallId && declaration.consumedByCallId !== callID) {
		throw new Error(
			`SCOPE_NOT_DECLARED: PR-feedback scope ${taskId} was already consumed by another Task call`,
		);
	}
	if (declaration.consumedByCallId === callID) return declaration;
	const state = await requireBoundState(directory, sessionID, 'PR_FEEDBACK');
	const nextState: PrWorkflowGateState = {
		...state,
		updatedAt: isoNow(),
		prFeedbackScopes: (state.prFeedbackScopes ?? []).map((entry) =>
			entry.taskId === taskId ? { ...entry, consumedByCallId: callID } : entry,
		),
	};
	await persistState(directory, nextState);
	return { ...declaration, consumedByCallId: callID };
}

export async function validatePrFeedbackScopeBinding(
	directory: string,
	binding: {
		taskId: string;
		files: string[];
		dispatchCallId?: string;
		workflowSessionId?: string;
		workflowRevisionDigest?: string;
	},
): Promise<boolean> {
	if (!binding.workflowSessionId || !binding.workflowRevisionDigest)
		return false;
	const declaration = await resolvePrFeedbackScopeDeclaration(
		directory,
		binding.workflowSessionId,
		binding.taskId,
	);
	return Boolean(
		declaration &&
			declaration.consumedByCallId === binding.dispatchCallId &&
			declaration.revisionDigest === binding.workflowRevisionDigest &&
			JSON.stringify(declaration.files) === JSON.stringify(binding.files),
	);
}

export async function enforcePrWorkflowToolBefore(
	directory: string,
	sessionID: string,
	toolName: string,
	args: Record<string, unknown> | undefined,
	generatedAgentNames: readonly string[] = [],
): Promise<void> {
	const state = await readPrWorkflowGateState(directory, sessionID);
	if (!state) return;
	const normalizedTool = toolName.toLowerCase();
	const isDirectAgentTask =
		normalizedTool === 'task' || normalizedTool === 'run_agent';
	const requestedAgentFields = (['subagent_type', 'agent'] as const).filter(
		(field) => Object.hasOwn(args ?? {}, field),
	);
	const requestedRoles = requestedAgentFields.map((field) => {
		const value = args?.[field];
		if (typeof value !== 'string' || !value.trim()) return '';
		return resolveGeneratedAgentRole(value.trim(), generatedAgentNames);
	});
	const isDirectWrite = (WRITE_TOOL_NAMES as readonly string[]).includes(
		normalizedTool,
	);
	const command = typeof args?.command === 'string' ? args.command.trim() : '';
	const serializedArgs = JSON.stringify(args ?? {});
	const referencesProtectedWorkflowEvidence = containsProtectedWorkflowPath(
		command || serializedArgs,
	);
	const isInternalWorkflowTool = isPrWorkflowControllerTool(
		state.mode,
		normalizedTool,
	);
	const isShellTool = normalizedTool === 'bash' || normalizedTool === 'shell';
	const isReadOnlyShell =
		isShellTool &&
		command.length > 0 &&
		isAllowedPrWorkflowReadOnlyShell(command, {
			allowCheckout: !state.prHeadSha,
			allowFetch: !state.prHeadSha,
			allowTrackingFetch: Boolean(state.prHeadSha),
			trackingFetchTarget: state.prHeadSha
				? _test_exports.resolveCurrentUpstreamPushTarget(directory)
				: null,
		});
	const trustedCapability = getPrWorkflowToolCapability(
		normalizedTool,
		state.mode,
	);
	const isTrustedWorkflowTool =
		trustedCapability !== null &&
		isTrustedPrWorkflowToolInvocationSafe(normalizedTool, args ?? {});
	const isNamedReadOnlyTool =
		isTrustedWorkflowTool ||
		(normalizedTool !== 'build_check' &&
			isAllowedPrReviewReadOnlyToolName(normalizedTool) &&
			readOnlyToolArgumentsAreSafe(args ?? {}));
	if (
		referencesProtectedWorkflowEvidence &&
		!isInternalWorkflowTool &&
		!isNamedReadOnlyTool &&
		!isReadOnlyShell
	) {
		throw new Error(
			`BLOCKED: active ${state.mode} workflow evidence under .swarm is controller-owned and cannot be modified directly`,
		);
	}
	const isShellCommandRequiringVerification =
		isShellTool && command.length > 0 && !isReadOnlyShell;
	const isRemoteReviewTool =
		/(?:git|github|pull|(?:^|[_-])pr(?:[_-]|$)|issue|review)/i.test(
			normalizedTool,
		);
	const hasRemoteMutationVerb =
		/(?:^|[_-])(?:add|approve|cancel|close|comment|commit|convert|create|delete|dismiss|edit|mark|merge|push|ready|reopen|rerun|resolve|submit|transfer|unresolve|update)(?:[_-]|$)/i.test(
			normalizedTool,
		);
	const hasRemoteReadVerb =
		/(?:^|[_-])(?:github|git)[_-]+(?:check|checks|checkout|diff|fetch|get|inspect|list|read|search|status|view)(?:[_-]|$)/i.test(
			normalizedTool,
		) ||
		/(?:^|[_-])(?:github|git)[_-]+(?:pull[_-]+request|pr|issue|review[_-]+thread)[_-]+(?:check|checks|checkout|diff|fetch|get|inspect|list|read|search|status|view)(?:[_-]|$)/i.test(
			normalizedTool,
		);
	const isRemoteMutationTool =
		isRemoteReviewTool && (hasRemoteMutationVerb || !hasRemoteReadVerb);
	const isRemoteCheckoutTool =
		/(?:^|[_-])(?:github|git)[_-]+checkout(?:[_-]|$)/i.test(normalizedTool);
	const isShellCheckout =
		(normalizedTool === 'bash' || normalizedTool === 'shell') &&
		(/\bgit\b(?:(?![;&|]).){0,200}\b(?:checkout|switch)\b/i.test(command) ||
			/\bgh\s+pr\s+checkout\b/i.test(command));
	const containsGitCommitShell =
		isShellCommandRequiringVerification &&
		/\bgit\b(?:(?![;&|]).){0,200}\bcommit\b/i.test(command);
	const isStandaloneGitCommitShell =
		containsGitCommitShell && isSafeStandaloneGitCommit(command);
	const isPublicationShell =
		isShellCommandRequiringVerification &&
		(/\bgit\b(?:(?![;&|]).){0,200}\bpush\b/i.test(command) ||
			/\bgh\s+(?:api|pr|issue|run)\b/i.test(command));
	const isPublicationTool = !isInternalWorkflowTool && isRemoteMutationTool;
	const isCoderTask =
		isDirectAgentTask &&
		requestedRoles.length > 0 &&
		requestedRoles.every((role) => role === 'coder');
	if (state.mode === 'PR_REVIEW') {
		const isAllowedReviewTool =
			isInternalWorkflowTool || isNamedReadOnlyTool || isReadOnlyShell;
		if (
			!isAllowedReviewTool ||
			(Boolean(state.prHeadSha) && (isRemoteCheckoutTool || isShellCheckout))
		) {
			throw new Error(
				'BLOCKED: PR_REVIEW is read-only and fail-closed; only controller tools and positively classified observation tools are allowed, and every agent lane requires structured dispatch_lanes_async',
			);
		}
		return;
	}
	if (isDirectAgentTask && !isCoderTask) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK reviewer, test, critic, explorer, and unknown agent lanes require structured dispatch_lanes_async provenance',
		);
	}
	if (
		!isInternalWorkflowTool &&
		!isDirectAgentTask &&
		!isDirectWrite &&
		!isShellTool &&
		!isNamedReadOnlyTool
	) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK rejects unclassified plugin/MCP tools; use positively classified observation tools, built-in structured write tools after verification, or the workflow controller',
		);
	}
	if (state.prHeadSha && (isShellCheckout || isRemoteCheckoutTool)) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK checkout is immutable after exact PR head binding',
		);
	}
	if (containsGitCommitShell && state.prFeedbackReadyToPublish) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK is armed for publication; the approved commit is immutable',
		);
	}
	if (
		(containsGitCommitShell || isPublicationShell) &&
		hasUnsafeShellControlSyntax(command)
	) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK publication commands must be standalone shell commands without control, redirection, or command-substitution syntax',
		);
	}
	if (containsGitCommitShell && !isStandaloneGitCommitShell) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK commit must use a standalone git commit command after every ordered local gate passes',
		);
	}
	if (state.prFeedbackReadyToPublish) {
		// NOTE: abort_pr_workflow is deliberately NOT allowed in the armed
		// state. Clearing an armed gate would drop the immutable-commit /
		// upstream binding and leave a half-published commit; once state is
		// null, enforcePrWorkflowToolBefore returns early and arbitrary
		// pushes would become allowed. abortPrWorkflow also refuses armed
		// state at the hook level (defense in depth). The armed workflow
		// must be completed (or explicitly un-armed by a human) before any
		// abort path opens.
		if (normalizedTool === 'complete_pr_workflow') return;
		if (isNamedReadOnlyTool) return;
		if (
			(normalizedTool === 'bash' || normalizedTool === 'shell') &&
			command.length > 0 &&
			isAllowedPrWorkflowReadOnlyShell(command, {
				allowCheckout: false,
				allowFetch: false,
				allowTrackingFetch: false,
			})
		)
			return;
		if (normalizedTool === 'bash' || normalizedTool === 'shell') {
			const armedState = await assertPrFeedbackPublicationArmed(
				directory,
				sessionID,
			);
			const armed = armedState.prFeedbackReadyToPublish!;
			if (isSafeExactBoundPush(command, armed)) return;
			throw new Error(
				`BLOCKED: PR_FEEDBACK is armed for publication; only the exact approved push is allowed: ${expectedBoundPushCommand(armed)}`,
			);
		}
		throw new Error(
			'BLOCKED: PR_FEEDBACK is armed for publication; only read-only inspection, the exact approved push, and complete_pr_workflow are allowed',
		);
	}
	if (isStandaloneGitCommitShell) {
		await assertPrFeedbackReadyToPublish(directory, sessionID);
		return;
	}
	if (isPublicationShell || isPublicationTool) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK publication is not armed; finish every ordered gate, create the one approved commit, and call complete_pr_workflow before publishing',
		);
	}
	if (isShellCommandRequiringVerification) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK shell commands fail closed unless they are explicit read-only intake or the one standalone approved git commit; use structured coder/write tools for fixes and run_pr_feedback_stage_a for validation',
		);
	}
	if (
		!isDirectWrite &&
		!isShellCommandRequiringVerification &&
		!isRemoteMutationTool &&
		!isCoderTask &&
		normalizedTool !== 'prepare_pr_feedback_scope'
	)
		return;
	// abort_pr_workflow is a pure escape hatch, not a publication-adjacent
	// operation. It must be reachable from a bound-but-unverified PR_FEEDBACK
	// state — that is exactly the deadlock scenario it exists to resolve
	// (architect cannot complete the ordered gates). The hook itself enforces
	// the armed-state refusal, so letting it past the verification gate here
	// does not weaken publication safety.
	if (normalizedTool === 'abort_pr_workflow') return;
	await assertPrFeedbackVerificationSettled(directory, sessionID);
}

/** Validate the terminal PR workflow contract before removing its durable gate. */
export async function completePrWorkflow(
	directory: string,
	sessionID: string,
	expectedMode: PrWorkflowMode,
	prHeadSha: string,
): Promise<PrWorkflowCompletionStatus> {
	const state = await requireBoundState(directory, sessionID, expectedMode);
	const normalizedHead = normalizePrHeadSha(prHeadSha);
	if (state.prHeadSha !== normalizedHead) {
		throw new Error(
			`BLOCKED: cannot complete ${expectedMode} at PR head "${normalizedHead}"; workflow is bound to "${state.prHeadSha}"`,
		);
	}
	const open = readDelegations(directory).filter(
		(record) =>
			record.parentSessionId === state.sessionID &&
			record.mode?.startsWith('swarm-pr-') &&
			(record.status === 'pending' || record.status === 'running'),
	);
	if (open.length > 0) {
		throw new Error(
			`BLOCKED: ${expectedMode} completion has ${open.length} unsettled PR workflow lane(s)`,
		);
	}
	if (expectedMode === 'PR_REVIEW') {
		assertPrReviewCleanCheckout(directory);
		await assertPrReviewBaseCoverageSettled(directory, sessionID);
		if (!state.prReviewTriggerEvalPath) {
			throw new Error(
				'BLOCKED: PR_REVIEW completion requires a persisted trigger evaluation artifact',
			);
		}
		if (
			(state.prReviewValidationBatches ?? []).some(
				(batch) => batch.phase === 'council',
			)
		) {
			await assertPrReviewValidationSettled(directory, sessionID, 'council');
		}
		await assertPrReviewValidationSettled(directory, sessionID, 'reviewer');
		const criticInventory = derivePrReviewCriticInventory(directory, state);
		if (criticInventory.length > 0) {
			if (
				!(state.prReviewValidationBatches ?? []).some(
					(batch) => batch.phase === 'critic',
				)
			) {
				throw new Error(
					`BLOCKED: PR_REVIEW reviewer verdicts require critic coverage for: ${criticInventory.join(', ')}`,
				);
			}
			await assertPrReviewValidationSettled(directory, sessionID, 'critic');
		}
		const requiredArtifactBoundaries: PrReviewArtifactBoundary[] = [
			'post_explorer',
			'post_reviewer',
			'post_critic',
		];
		const persistedBoundaries = new Set(state.prReviewArtifactBoundaries ?? []);
		const missingArtifactBoundaries = requiredArtifactBoundaries.filter(
			(boundary) => !persistedBoundaries.has(boundary),
		);
		if (!state.prReviewFindingsPath || missingArtifactBoundaries.length > 0) {
			throw new Error(
				`BLOCKED: PR_REVIEW completion requires durable findings checkpoints; missing: ${missingArtifactBoundaries.join(', ') || 'findings path'}`,
			);
		}
		if (state.prReviewHandoffRequired && !state.prReviewHandoffPath) {
			throw new Error(
				'BLOCKED: PR_REVIEW actionable findings require a persisted feedback handoff artifact',
			);
		}
	} else {
		const readyState = await assertPrFeedbackReadyToPublish(
			directory,
			sessionID,
		);
		const currentDigest = await currentPrFeedbackRevisionDigest(
			directory,
			readyState,
		);
		const armed = readyState.prFeedbackReadyToPublish;
		if (!armed) {
			const localHead = _test_exports.resolveCurrentGitHead(directory)?.trim();
			if (!localHead) {
				throw new Error(
					'BLOCKED: PR_FEEDBACK cannot arm publication without a verified local Git HEAD',
				);
			}
			const commitCount = _test_exports.resolveCommitCountSince(
				directory,
				state.prHeadSha!,
				localHead,
			);
			if (commitCount !== 1) {
				throw new Error(
					'BLOCKED: PR_FEEDBACK publication requires exactly one descendant commit after the immutable intake head',
				);
			}
			if (
				_test_exports.resolveIsExactSingleChildCommit(
					directory,
					state.prHeadSha!,
					localHead,
				) !== true
			) {
				throw new Error(
					'BLOCKED: PR_FEEDBACK publication commit must be a non-merge direct child of the immutable intake head',
				);
			}
			if (_test_exports.resolveIsWorkingTreeClean(directory) !== true) {
				throw new Error(
					'BLOCKED: PR_FEEDBACK publication requires a clean index and working tree so all approved content is captured by the bound commit',
				);
			}
			const upstreamTarget =
				_test_exports.resolveCurrentUpstreamPushTarget(directory);
			if (!upstreamTarget) {
				throw new Error(
					'BLOCKED: PR_FEEDBACK cannot arm publication without a current branch bound to an exact remote name, remote branch ref, and remote-tracking ref',
				);
			}
			await persistState(directory, {
				...readyState,
				updatedAt: isoNow(),
				prFeedbackReadyToPublish: {
					revisionDigest: currentDigest,
					localHead,
					remoteName: upstreamTarget.remoteName,
					remoteBranchRef: upstreamTarget.remoteBranchRef,
					remoteRef: upstreamTarget.remoteTrackingRef,
					validatedAt: isoNow(),
				},
			});
			return 'ready-to-publish';
		}
		if (armed.revisionDigest !== currentDigest) {
			throw new Error(
				'BLOCKED: PR_FEEDBACK publication revision differs from the independently approved content digest',
			);
		}
		const publishedHead = _test_exports
			.resolveCurrentGitHead(directory)
			?.trim();
		const remoteRefs = publishedHead
			? _test_exports.resolveRemoteRefsContainingHead(directory, publishedHead)
			: null;
		const remoteHead = _test_exports.resolveExactRemoteBranchHead(
			directory,
			armed.remoteName,
			armed.remoteBranchRef,
		);
		if (
			!publishedHead ||
			publishedHead !== armed.localHead ||
			!remoteRefs?.includes(armed.remoteRef) ||
			remoteHead?.toLowerCase() !== armed.localHead.toLowerCase()
		) {
			throw new Error(
				`BLOCKED: PR_FEEDBACK completion requires approved commit ${armed.localHead} at current Git HEAD and intended remote-tracking ref ${armed.remoteRef} at that exact commit`,
			);
		}
	}
	await _test_exports.beforeTerminalClear?.();
	await clearPrWorkflowGateState(directory, sessionID, state.revision);
	return 'completed';
}

export const _test_exports = {
	workflowGateStateRelativePath,
	workflowGateStateLockRelativePath,
	resetTrackedStateCache: () => {
		trackedStatesByProjectSession.clear();
		pendingStateMutationsByProjectSession.clear();
		_test_exports.beforeTerminalClear = undefined;
	},
	beforeTerminalClear: undefined as (() => Promise<void>) | undefined,
	resolveCurrentGitHead,
	resolveCurrentUpstreamPushTarget,
	resolveCurrentUpstreamRemoteRef,
	resolveExactRemoteBranchHead,
	resolveCommitCountSince,
	resolveIsWorkingTreeClean,
	resolveIsExactSingleChildCommit,
	resolvePrWorkflowRevisionDigest,
	resolveRemoteRefsContainingHead,
	parseCriticVerdict,
	isProcessAlive,
	nowMs: () => Date.now(),
};

async function requireAnyActiveState(
	directory: string,
	sessionID: string,
): Promise<PrWorkflowGateState> {
	const state = await readPrWorkflowGateState(directory, sessionID);
	if (!state) {
		throw new Error(
			`BLOCKED: no active PR workflow gate for session "${normalizeSessionID(sessionID)}"`,
		);
	}
	return state;
}

async function requireBoundState(
	directory: string,
	sessionID: string,
	expectedMode: PrWorkflowMode,
): Promise<PrWorkflowGateState> {
	const state = await requireAnyActiveState(directory, sessionID);
	if (state.mode !== expectedMode) {
		throw wrongModeError(state, expectedMode);
	}
	if (!state.prHeadSha) {
		throw new Error(
			`BLOCKED: active ${expectedMode} workflow is not bound to a PR head`,
		);
	}
	if (expectedMode === 'PR_REVIEW') {
		assertCurrentCheckoutHead(directory, state.prHeadSha);
		assertPrReviewCleanCheckout(directory);
	}
	return state;
}

function wrongModeError(
	state: PrWorkflowGateState,
	expectedMode: PrWorkflowMode,
): Error {
	return new Error(
		`BLOCKED: session "${state.sessionID}" is active in ${state.mode}, not ${expectedMode}`,
	);
}

function normalizeWorkflowLanes(
	lanes: readonly PrWorkflowLaneSpec[],
): Array<{ laneId: string; workflowLane: string; reviewItemIds?: string[] }> {
	if (!Array.isArray(lanes) || lanes.length === 0) {
		throw new Error(
			'BLOCKED: PR workflow lane validation requires at least one lane',
		);
	}
	const normalized = lanes.map((lane) => {
		const workflowLane = lane.workflowLane?.trim();
		const laneId = lane.laneId?.trim() || workflowLane;
		if (!workflowLane || !laneId) {
			throw new Error(
				'BLOCKED: PR workflow lane validation requires every lane to have non-empty laneId and workflow_lane values',
			);
		}
		const reviewItemIds = lane.reviewItemIds?.map((itemId: string) =>
			itemId.trim(),
		);
		if (reviewItemIds?.some((itemId: string) => !itemId)) {
			throw new Error(
				'BLOCKED: PR workflow review_item_ids must not contain empty values',
			);
		}
		if (reviewItemIds) {
			assertNoDuplicates(reviewItemIds, 'review item ids within one lane');
		}
		return {
			laneId,
			workflowLane,
			...(reviewItemIds ? { reviewItemIds } : {}),
		};
	});
	assertNoDuplicates(
		normalized.map((lane) => lane.laneId),
		'lane ids',
	);
	assertNoDuplicates(
		normalized.map((lane) => lane.workflowLane),
		'workflow lane ids',
	);
	return normalized;
}

function normalizeInventoryIds(inventoryIds: readonly string[]): string[] {
	if (!Array.isArray(inventoryIds) || inventoryIds.length === 0) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK inventory declaration requires at least one feedback item id',
		);
	}
	const normalized = inventoryIds.map((inventoryId) => {
		const itemId = inventoryId.trim();
		if (!itemId) {
			throw new Error(
				'BLOCKED: PR_FEEDBACK inventory declaration contains an empty item id',
			);
		}
		return itemId;
	});
	assertNoDuplicates(normalized, 'inventory item ids');
	return normalized.sort();
}

function normalizeOwnership(
	ownership: readonly PrFeedbackLaneOwnership[],
): PrFeedbackLaneOwnership[] {
	if (!Array.isArray(ownership) || ownership.length === 0) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK verification ownership requires at least one lane declaration',
		);
	}
	const normalized = ownership.map((lane) => {
		const laneId = lane.laneId?.trim();
		if (!laneId) {
			throw new Error(
				'BLOCKED: PR_FEEDBACK verification ownership requires every lane to have a non-empty laneId',
			);
		}
		const ownedItemIds = normalizeInventoryIds(lane.ownedItemIds);
		return { laneId, ownedItemIds };
	});
	assertNoDuplicates(
		normalized.map((lane) => lane.laneId),
		'PR_FEEDBACK verification lane ids',
	);
	return normalized;
}

function assertNoDuplicates(values: readonly string[], label: string): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) {
			throw new Error(`BLOCKED: duplicate ${label} are not allowed: ${value}`);
		}
		seen.add(value);
	}
}

function containsProtectedWorkflowPath(value: string): boolean {
	return /(?:^|[^A-Za-z0-9_.-])\.swarm(?:[\\/]|$)/i.test(
		value.replace(/\\\\/g, '\\'),
	);
}

const PR_WORKFLOW_SHARED_CONTROLLER_TOOLS = new Set([
	'abort_pr_workflow',
	'collect_lane_results',
	'complete_pr_workflow',
	'dispatch_lanes_async',
	'get_async_result',
	'get_async_status',
]);

const PR_REVIEW_CONTROLLER_TOOLS = new Set([
	'parse_lane_candidates',
	'write_pr_review_artifact',
	'write_pr_review_trigger_eval',
]);

const PR_FEEDBACK_CONTROLLER_TOOLS = new Set([
	'prepare_pr_feedback_scope',
	'run_pr_feedback_stage_a',
]);

function isPrWorkflowControllerTool(
	mode: PrWorkflowMode,
	toolName: string,
): boolean {
	if (PR_WORKFLOW_SHARED_CONTROLLER_TOOLS.has(toolName)) return true;
	return mode === 'PR_REVIEW'
		? PR_REVIEW_CONTROLLER_TOOLS.has(toolName)
		: PR_FEEDBACK_CONTROLLER_TOOLS.has(toolName);
}

const PR_REVIEW_READ_ONLY_TOOL_NAMES = new Set([
	'ast_grep_search',
	'codesearch',
	'glob',
	'grep',
	'lsp',
	'open',
	'read',
	'search',
	'skill',
	'tree',
	'view',
	'webfetch',
	'websearch',
]);

function isTrustedPrWorkflowToolInvocationSafe(
	toolName: string,
	args: Record<string, unknown>,
): boolean {
	if (toolName === 'lint') return args.mode === 'check';
	if (toolName === 'sast_scan') return args.capture_baseline !== true;
	return true;
}

/**
 * Positive classifier for non-shell tools usable during PR_REVIEW.
 *
 * Connector and MCP tools are intentionally fail-closed: an unknown name is
 * blocked unless it carries a recognized observation verb and no mutation
 * verb. This prevents newly installed tools such as filesystem_write_file or
 * mcp.filesystem.write_file from silently bypassing the workflow boundary.
 */
function isAllowedPrReviewReadOnlyToolName(toolName: string): boolean {
	if (PR_REVIEW_READ_ONLY_TOOL_NAMES.has(toolName)) return true;
	const tokens = toolName.split(/[._:/-]+/).filter(Boolean);
	if (
		tokens.some((token) =>
			/^(?:add|alter|and|append|apply|approve|cancel|checkout|close|comment|commit|convert|create|delete|destroy|dismiss|drop|edit|execute|grant|insert|mark|merge|move|patch|prepend|publish|push|ready|remove|rename|replace|resolve|rerun|revoke|run|send|submit|then|transfer|truncate|unresolve|update|upload|write)$/i.test(
				token,
			),
		)
	) {
		return false;
	}
	return tokens.some((token) =>
		/^(?:check|checks|diff|fetch|find|get|glob|grep|hover|inspect|list|lookup|open|read|references|scan|screenshot|search|show|status|symbols|tree|view)$/i.test(
			token,
		),
	);
}

function readOnlyToolArgumentsAreSafe(
	value: unknown,
	key = '',
	depth = 0,
): boolean {
	if (depth > 8) return false;
	const keyTokens = key
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.split(/[._:/-]+/)
		.filter(Boolean);
	if (
		keyTokens.some((token) =>
			/^(?:append|body|content|create|data|delete|destination|destroy|edit|insert|mutation|output|patch|payload|prepend|remove|replace|save|set|truncate|update|upload|write)$/i.test(
				token,
			),
		)
	) {
		return false;
	}
	if (keyTokens.some((token) => /^(?:method|verb)$/i.test(token))) {
		return typeof value === 'string' && /^(?:GET|HEAD)$/i.test(value.trim());
	}
	if (
		keyTokens.length === 1 &&
		keyTokens.some((token) => /^(?:action|operation)$/i.test(token))
	) {
		return (
			typeof value === 'string' &&
			/^(?:check|diff|fetch|find|get|inspect|list|lookup|open|read|scan|search|show|status|view)$/i.test(
				value.trim(),
			)
		);
	}
	if (/^mode$/i.test(key) && typeof value === 'string') {
		return /^(?:r|rb|read)$/i.test(value.trim());
	}
	if (typeof value === 'string') {
		if (
			keyTokens.some((token) =>
				/^(?:query|request|sql|statement)$/i.test(token),
			) &&
			/(?:\b(?:alter|call|comment|create|delete|drop|exec(?:ute)?|grant|insert|merge|mutation|replace|revoke|truncate|update|upsert)\b|\bselect\b[\s\S]{0,4000}\binto\s+[A-Za-z_"'`])/i.test(
				value,
			)
		) {
			return false;
		}
		return !/(?:^(?:POST|PUT|PATCH|DELETE|CONNECT|TRACE|write|edit|patch|create|delete|destroy|remove|replace|truncate|update|upload)$|(?:^|[\r\n])\s*(?:POST|PUT|PATCH|DELETE|CONNECT|TRACE)\s+\S+(?:\s+HTTP\/\d(?:\.\d)?)?|\bmutation\b|\b(?:create|drop|alter|truncate)\s+(?:or\s+replace\s+)?(?:table|database|schema|index|view|function|procedure|trigger|sequence)\b|\b(?:delete\s+from|insert\s+into|merge\s+into|replace\s+into|upsert\s+into)\b|\bupdate\s+[A-Za-z0-9_."'`-]+(?:\s+(?:AS\s+)?[A-Za-z0-9_"'`-]+)?\s+set\b|\b(?:grant|revoke)\s+\S+\s+(?:on|from|to)\b|\b(?:call|exec(?:ute)?)\s+[A-Za-z0-9_."'`-]+|\b(?:rm|rmdir|del|remove-item|move-item|set-content|add-content)\b)/i.test(
			value,
		);
	}
	if (
		value === null ||
		value === undefined ||
		typeof value === 'number' ||
		typeof value === 'boolean'
	) {
		return true;
	}
	if (Array.isArray(value)) {
		return value.every((entry) =>
			readOnlyToolArgumentsAreSafe(entry, key, depth + 1),
		);
	}
	if (typeof value === 'object') {
		return Object.entries(value).every(([childKey, childValue]) =>
			readOnlyToolArgumentsAreSafe(childValue, childKey, depth + 1),
		);
	}
	return false;
}

function isAllowedPrWorkflowReadOnlyShell(
	command: string,
	options: {
		allowCheckout: boolean;
		allowFetch: boolean;
		allowTrackingFetch: boolean;
		trackingFetchTarget?: {
			remoteName: string;
			remoteBranchRef: string;
		} | null;
	},
): boolean {
	const normalized = command.trim().replace(/\s+/g, ' ');
	if (!normalized) return false;

	// A pre-verification shell is an intake-only surface. Reject composition,
	// redirection, interpolation, and multiline scripts before considering an
	// individual command. This deliberately fails closed for unknown syntax.
	if (/[\r\n;&|<>`]/.test(command) || /\$\(|@\(/.test(command)) return false;

	const gitMatch = normalized.match(
		/^git(?: -C (?:"[^"]+"|'[^']+'|\S+))* (.+)$/i,
	);
	if (gitMatch?.[1]) return isAllowedPrWorkflowGitIntake(gitMatch[1], options);

	if (/^gh /i.test(normalized)) return isAllowedPrFeedbackGhIntake(normalized);

	if (
		/^rg\b/i.test(normalized) &&
		/\s--pre(?:-glob)?(?:\s|=|$)/i.test(normalized)
	)
		return false;

	return /^(?:rg|grep|cat|Get-Content|Select-String|Test-Path|Get-ChildItem|ls|dir|pwd)(?:\s|$)/i.test(
		normalized,
	);
}

function hasUnsafeShellControlSyntax(command: string): boolean {
	return /[;&|<>`\r\n]/.test(command) || /\$\(/.test(command);
}

function isSafeStandaloneGitCommit(command: string): boolean {
	if (hasUnsafeShellControlSyntax(command)) return false;
	if (/(?:^|\s)--(?:allow-empty|amend)(?:\s|=|$)/i.test(command)) return false;
	return /^git(?:\s+-C(?:=|\s+)(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s;&|<>`]+))?\s+commit(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|<>`]+))*\s*$/i.test(
		command.trim(),
	);
}

function boundPushTarget(
	armed: PrFeedbackReadyToPublishRecord,
): { remote: string; branch: string } | null {
	const remote = armed.remoteName;
	const branch = armed.remoteBranchRef.slice('refs/heads/'.length);
	if (!armed.remoteBranchRef.startsWith('refs/heads/') || !branch) return null;
	if (/\s|[;&|<>`]/.test(remote) || /\s|[;&|<>`]/.test(branch)) return null;
	return { remote, branch };
}

function expectedBoundPushCommand(
	armed: PrFeedbackReadyToPublishRecord,
): string {
	const target = boundPushTarget(armed);
	return target
		? `git push ${target.remote} ${armed.localHead}:refs/heads/${target.branch}`
		: '(invalid bound remote-tracking ref; restart the workflow)';
}

/** Permit one non-force, single-ref push of only the content-bound commit. */
function isSafeExactBoundPush(
	command: string,
	armed: PrFeedbackReadyToPublishRecord,
): boolean {
	if (hasUnsafeShellControlSyntax(command)) return false;
	const target = boundPushTarget(armed);
	if (!target) return false;
	const match = command
		.trim()
		.match(/^git\s+push\s+([^\s;&|<>`]+)\s+([^\s;&|<>`]+)\s*$/i);
	if (!match) return false;
	return (
		match[1] === target.remote &&
		match[2] === `${armed.localHead}:refs/heads/${target.branch}`
	);
}

function isAllowedPrWorkflowGitIntake(
	gitArgs: string,
	options: {
		allowCheckout: boolean;
		allowFetch: boolean;
		allowTrackingFetch: boolean;
		trackingFetchTarget?: {
			remoteName: string;
			remoteBranchRef: string;
		} | null;
	},
): boolean {
	if (
		/(?:--ext-diff|--textconv|--open-files-in-pager|--output(?:=|\s)|--upload-pack(?:=|\s)|--exec(?:=|\s))/i.test(
			gitArgs,
		)
	)
		return false;

	if (
		/^(?:status|log|show|diff|rev-parse|merge-base|ls-files|grep|blame|cat-file|for-each-ref)(?:\s|$)/i.test(
			gitArgs,
		)
	)
		return true;

	if (options.allowFetch && /^fetch(?:\s|$)/i.test(gitArgs)) return true;
	if (
		options.allowTrackingFetch &&
		isAllowedBoundRemoteTrackingFetch(gitArgs, options.trackingFetchTarget)
	)
		return true;

	if (/^remote(?:\s+-v)?$/i.test(gitArgs)) return true;

	// Checkout/switch are limited to one existing ref (optionally detached).
	// Branch creation and path restoration therefore cannot pass this allowlist.
	if (options.allowCheckout && isAllowedPreBindBranchSetup(gitArgs))
		return true;

	if (
		options.allowCheckout &&
		/^(?:checkout|switch)\s+(?:--detach\s+)?[^\s-][^\s]*$/i.test(gitArgs)
	)
		return true;

	// Config intake must select a read operation. Scope/origin flags alone never
	// authorize a key/value write.
	return /^config\s+(?:(?:--show-origin|--show-scope|--global|--local|--system|--worktree)\s+)*(?:--list|--get(?:-all)?\s+\S+)$/i.test(
		gitArgs,
	);
}

function isAllowedBoundRemoteTrackingFetch(
	gitArgs: string,
	target: { remoteName: string; remoteBranchRef: string } | null | undefined,
): boolean {
	if (!target?.remoteName || !target.remoteBranchRef.startsWith('refs/heads/'))
		return false;
	const tokens = gitArgs.trim().split(/\s+/);
	if (tokens.length !== 3 || tokens[0].toLowerCase() !== 'fetch') return false;
	const [, remote, remoteBranch] = tokens;
	const expectedBranch = target.remoteBranchRef.slice('refs/heads/'.length);
	return (
		isSafeGitRefToken(remote) &&
		!remote.includes('/') &&
		isSafeGitRefToken(remoteBranch) &&
		!remoteBranch.startsWith('-') &&
		!remoteBranch.includes(':') &&
		remote === target.remoteName &&
		remoteBranch === expectedBranch
	);
}

function isAllowedPreBindBranchSetup(gitArgs: string): boolean {
	const tokens = gitArgs.trim().split(/\s+/);
	if (tokens.length === 5) {
		const [verb, createFlag, localBranch, trackFlag, upstream] = tokens;
		return (
			(verb === 'checkout' || verb === 'switch') &&
			(createFlag === '-b' || createFlag === '-c') &&
			trackFlag === '--track' &&
			isSafeGitRefToken(localBranch) &&
			isSafeGitRefToken(upstream) &&
			upstream.includes('/')
		);
	}
	if (tokens.length === 3 && tokens[0] === 'branch') {
		const upstream = tokens[1].match(/^--set-upstream-to=(.+)$/)?.[1];
		return Boolean(
			upstream &&
				isSafeGitRefToken(upstream) &&
				upstream.includes('/') &&
				isSafeGitRefToken(tokens[2]),
		);
	}
	return false;
}

function isSafeGitRefToken(value: string): boolean {
	return (
		/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
		!value.includes('..') &&
		!value.includes('//') &&
		!value.includes('@{') &&
		!value.endsWith('/') &&
		!value.endsWith('.') &&
		!value.endsWith('.lock')
	);
}

function isAllowedPrFeedbackGhIntake(command: string): boolean {
	if (
		/^gh\s+pr\s+(?:view|diff|checks|status|list|checkout)(?:\s|$)/i.test(
			command,
		) ||
		/^gh\s+run\s+(?:view|list|watch)(?:\s|$)/i.test(command) ||
		/^gh\s+issue\s+(?:view|list)(?:\s|$)/i.test(command) ||
		/^gh\s+search\s+(?:code|commits|issues|prs|repos)(?:\s|$)/i.test(command) ||
		/^gh\s+auth\s+status(?:\s|$)/i.test(command)
	)
		return true;

	if (!/^gh\s+api(?:\s|$)/i.test(command)) return false;
	if (/\bmutation\b/i.test(command)) return false;
	const method = command.match(
		/\s(?:--method(?:\s+|=)|-X(?:\s+|=)?)([A-Z]+)/i,
	)?.[1];
	if (method && method.toUpperCase() !== 'GET') return false;
	if (
		/\s(?:--input|--raw-field)(?:\s|=)/i.test(command) ||
		/\s-F(?:\s|=|\S)/.test(command)
	)
		return false;

	// REST defaults to GET. GraphQL queries may use `-f query=...`; the explicit
	// mutation rejection above keeps that review-thread intake read-only.
	return !/\s(?:--field|-f)(?:\s|=)(?!query=)/i.test(command);
}

function normalizePrHeadSha(prHeadSha: string): string {
	const normalized = prHeadSha.trim();
	if (!normalized) {
		throw new Error('BLOCKED: PR workflow requires a non-empty pr_head_sha');
	}
	return normalized;
}

async function currentPrFeedbackRevisionDigest(
	directory: string,
	state: PrWorkflowGateState,
): Promise<string> {
	if (!state.prHeadSha) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK revision binding requires pr_head_sha',
		);
	}
	const digest = await resolvePrWorkflowRevisionDigestForGate(
		directory,
		state.prHeadSha,
	);
	if (!digest) {
		throw new Error(
			'BLOCKED: PR_FEEDBACK could not compute a bounded current-revision digest',
		);
	}
	return digest;
}

/**
 * Production gate calls use the non-blocking, chunked digest implementation.
 * Keep the synchronous seam for existing focused tests and explicit test
 * injection; it is never selected while the production implementation is in
 * place.
 */
async function resolvePrWorkflowRevisionDigestForGate(
	directory: string,
	baseHeadSha: string,
): Promise<string | null> {
	if (
		_test_exports.resolvePrWorkflowRevisionDigest !==
		resolvePrWorkflowRevisionDigest
	) {
		return _test_exports.resolvePrWorkflowRevisionDigest(
			directory,
			baseHeadSha,
		);
	}
	return resolvePrWorkflowRevisionDigestAsync(directory, baseHeadSha);
}

function normalizeBatchId(batchId: string): string {
	const normalized = batchId.trim();
	if (!normalized) {
		throw new Error('BLOCKED: PR workflow requires a non-empty batch id');
	}
	return normalized;
}

function sameStringArray(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

function assertExactStringSet(
	actual: readonly string[],
	expected: readonly string[],
	label: string,
): void {
	const actualSet = new Set(actual);
	const expectedSet = new Set(expected);
	const missing = [...expectedSet].filter((value) => !actualSet.has(value));
	const extra = [...actualSet].filter((value) => !expectedSet.has(value));
	if (
		actual.length !== actualSet.size ||
		actualSet.size !== expectedSet.size ||
		missing.length > 0 ||
		extra.length > 0
	) {
		throw new Error(
			`BLOCKED: ${label} must exactly cover the mechanically derived inventory; missing: ${missing.join(', ') || '(none)'}; extra: ${extra.join(', ') || '(none)'}`,
		);
	}
}

function derivePrReviewCandidateInventory(
	directory: string,
	state: PrWorkflowGateState,
): string[] {
	const sources: Array<{
		batchId: string;
		laneId: string;
		mode: string;
		workflowLane?: string;
	}> = [];
	const selectedBaseDimensions = new Set<string>();
	for (const batch of [...(state.prReviewBaseDispatches ?? [])].reverse()) {
		const successful = successfulObligationsFromExactBatch(
			directory,
			state,
			batch.batchId,
			batch.lanes,
			'swarm-pr-review:base',
			batch.validatedAt,
		);
		for (const lane of batch.lanes) {
			if (
				successful.has(lane.workflowLane) &&
				!selectedBaseDimensions.has(lane.workflowLane)
			) {
				sources.push({
					batchId: batch.batchId,
					laneId: lane.laneId,
					mode: 'swarm-pr-review:base',
				});
				selectedBaseDimensions.add(lane.workflowLane);
			}
		}
	}
	const selectedCouncilLanes = new Set<string>();
	for (const batch of [...(state.prReviewValidationBatches ?? [])].reverse()) {
		if (batch.phase !== 'council') continue;
		const successful = successfulObligationsFromExactBatch(
			directory,
			state,
			batch.batchId,
			batch.lanes,
			'swarm-pr-review:council',
			batch.validatedAt,
		);
		for (const lane of batch.lanes) {
			if (
				successful.has(lane.workflowLane) &&
				!selectedCouncilLanes.has(lane.workflowLane)
			) {
				sources.push({
					batchId: batch.batchId,
					laneId: lane.laneId,
					mode: 'swarm-pr-review:council',
				});
				selectedCouncilLanes.add(lane.workflowLane);
			}
		}
	}
	if (state.prReviewTriggerEvalPath) {
		const triggerPath = validateSwarmPath(
			directory,
			state.prReviewTriggerEvalPath,
		);
		let triggerArtifact: unknown;
		try {
			triggerArtifact = JSON.parse(readFileSync(triggerPath, 'utf-8'));
		} catch {
			throw new Error(
				'BLOCKED: PR_REVIEW trigger evaluation artifact is missing or invalid',
			);
		}
		const rows = (triggerArtifact as { rows?: unknown }).rows;
		if (!Array.isArray(rows)) {
			throw new Error('BLOCKED: PR_REVIEW trigger evaluation rows are invalid');
		}
		const rowIds = rows.map((row) =>
			typeof row === 'object' && row !== null
				? (row as { trigger_id?: unknown }).trigger_id
				: undefined,
		);
		const provenanceTuples = rows.map((row) => {
			if (typeof row !== 'object' || row === null) return '';
			const batchId = (row as { source_batch_id?: unknown }).source_batch_id;
			const laneId = (row as { source_lane_id?: unknown }).source_lane_id;
			return typeof batchId === 'string' &&
				typeof laneId === 'string' &&
				batchId.trim() &&
				laneId.trim()
				? `${batchId}\0${laneId}`
				: '';
		});
		const exactMandatorySet =
			rows.length === PR_REVIEW_REQUIRED_MICRO_LANE_IDS.length &&
			new Set(rowIds).size === PR_REVIEW_REQUIRED_MICRO_LANE_IDS.length &&
			provenanceTuples.every(Boolean) &&
			new Set(provenanceTuples).size ===
				PR_REVIEW_REQUIRED_MICRO_LANE_IDS.length &&
			PR_REVIEW_REQUIRED_MICRO_LANE_IDS.every((id) => rowIds.includes(id)) &&
			rows.every(
				(row) =>
					typeof row === 'object' &&
					row !== null &&
					(row as { result?: unknown }).result === 'MATCHED',
			);
		if (!exactMandatorySet) {
			throw new Error(
				'BLOCKED: PR_REVIEW requires the exact all-MATCHED repository-agnostic micro-lane set with unique source provenance',
			);
		}
		for (const row of rows) {
			if (
				typeof row === 'object' &&
				row !== null &&
				(row as { result?: unknown }).result === 'MATCHED' &&
				typeof (row as { source_batch_id?: unknown }).source_batch_id ===
					'string' &&
				typeof (row as { source_lane_id?: unknown }).source_lane_id === 'string'
			) {
				sources.push({
					batchId: (row as { source_batch_id: string }).source_batch_id,
					laneId: (row as { source_lane_id: string }).source_lane_id,
					mode: 'swarm-pr-review:micro',
					workflowLane: (row as { trigger_id: string }).trigger_id,
				});
			}
		}
	}
	const candidateIds: string[] = [];
	for (const source of sources) {
		let resolvedArtifact = false;
		for (const record of findByBatchId(directory, source.batchId, {
			parentSessionId: state.sessionID,
		})) {
			if (
				record.laneId !== source.laneId ||
				record.mode !== source.mode ||
				record.status !== 'completed' ||
				record.workspace?.prHeadSha !== state.prHeadSha ||
				record.workspace?.gitHead !== state.prHeadSha ||
				record.result?.outputDegraded === true ||
				record.result?.transcriptIncomplete === true ||
				record.result?.truncated === true
			)
				continue;
			const ref = record.result?.outputRef?.trim();
			const artifact = ref
				? readLaneOutput(directory, ref)?.artifact
				: undefined;
			if (
				!artifact ||
				!workflowArtifactHasContractMarker(
					directory,
					state,
					record,
					source.mode,
					source.workflowLane ?? record.workflowLane ?? source.laneId,
				)
			)
				continue;
			if (
				source.workflowLane &&
				(record.workflowLane !== source.workflowLane ||
					!prReviewDiscoveryArtifactCoversLane(
						artifact.text,
						source.workflowLane,
					))
			)
				continue;
			resolvedArtifact = true;
			candidateIds.push(...extractCandidateIds(artifact.text));
		}
		if (source.mode === 'swarm-pr-review:micro' && !resolvedArtifact) {
			throw new Error(
				`BLOCKED: PR_REVIEW mandatory micro-lane provenance is missing or invalid for ${source.workflowLane ?? source.laneId}`,
			);
		}
	}
	assertNoDuplicates(candidateIds, 'PR_REVIEW discovery candidate ids');
	return candidateIds.length > 0 ? candidateIds.sort() : ['CLEAN-REVIEW'];
}

function extractCandidateIds(text: string): string[] {
	const candidateIds: string[] = [];
	let markerHeaderSeen = false;
	for (const line of text.split(/\r?\n/)) {
		const fields = pipeFields(line);
		if (
			fields[0] === '[CANDIDATE]' &&
			fields[1]?.toLowerCase() === 'candidate_id'
		) {
			markerHeaderSeen = true;
			continue;
		}
		if (
			fields[0] === '[CANDIDATE]' &&
			fields.length >= 10 &&
			fields.slice(1, 10).every(Boolean)
		) {
			candidateIds.push(fields[1]);
			continue;
		}
		if (
			markerHeaderSeen &&
			fields.length >= 9 &&
			fields[0] &&
			!fields[0].startsWith('[') &&
			fields.slice(0, 9).every(Boolean)
		) {
			candidateIds.push(fields[0]);
		}
	}
	return candidateIds;
}

function derivePrReviewCriticInventory(
	directory: string,
	state: PrWorkflowGateState,
): string[] {
	const verdicts = deriveLatestPrReviewReviewerVerdicts(directory, state);
	return [...verdicts.entries()]
		.filter(
			([, verdict]) =>
				verdict.classification === 'CONFIRMED' &&
				['CRITICAL', 'HIGH', 'MEDIUM'].includes(verdict.severity),
		)
		.map(([itemId]) => itemId)
		.sort();
}

function deriveLatestPrReviewCriticVerdicts(
	directory: string,
	state: PrWorkflowGateState,
): Map<string, { status: string; severity: string }> {
	const reviewerVerdicts = deriveLatestPrReviewReviewerVerdicts(
		directory,
		state,
	);
	const criticBatches = (state.prReviewValidationBatches ?? []).filter(
		(batch) => batch.phase === 'critic',
	);
	for (const batch of [...criticBatches].reverse()) {
		const successful = successfulObligationsFromExactBatch(
			directory,
			state,
			batch.batchId,
			batch.lanes,
			'swarm-pr-review:critic',
			batch.validatedAt,
		);
		if (
			batch.lanes.some((lane) => !successful.has(lane.workflowLane)) ||
			successful.size !== batch.lanes.length
		) {
			continue;
		}
		const required = batch.lanes.flatMap((lane) => lane.reviewItemIds ?? []);
		const verdicts = new Map<string, { status: string; severity: string }>();
		for (const lane of batch.lanes) {
			const record = findByBatchId(directory, batch.batchId, {
				parentSessionId: state.sessionID,
			}).find((candidate) => candidate.laneId === lane.laneId);
			const ref = record?.result?.outputRef?.trim();
			const artifact = ref
				? readLaneOutput(directory, ref)?.artifact
				: undefined;
			if (!artifact) continue;
			for (const itemId of lane.reviewItemIds ?? []) {
				const verdict = parseCriticVerdict(
					artifact.text,
					itemId,
					reviewerVerdicts.get(itemId)?.severity,
				);
				if (verdict) verdicts.set(itemId, verdict);
			}
		}
		if (required.every((itemId) => verdicts.has(itemId))) return verdicts;
	}
	return new Map();
}

function deriveLatestPrReviewReviewerVerdicts(
	directory: string,
	state: PrWorkflowGateState,
): Map<string, ReviewerVerdict> {
	const reviewerBatches = (state.prReviewValidationBatches ?? []).filter(
		(batch) => batch.phase === 'reviewer',
	);
	for (const batch of [...reviewerBatches].reverse()) {
		const successful = successfulObligationsFromExactBatch(
			directory,
			state,
			batch.batchId,
			batch.lanes,
			'swarm-pr-review:reviewer',
			batch.validatedAt,
		);
		if (
			batch.lanes.some((lane) => !successful.has(lane.workflowLane)) ||
			successful.size !== batch.lanes.length
		) {
			continue;
		}
		const required = batch.lanes.flatMap((lane) => lane.reviewItemIds ?? []);
		const verdicts = new Map<string, ReviewerVerdict>();
		for (const lane of batch.lanes) {
			const record = findByBatchId(directory, batch.batchId, {
				parentSessionId: state.sessionID,
			}).find((candidate) => candidate.laneId === lane.laneId);
			const ref = record?.result?.outputRef?.trim();
			const artifact = ref
				? readLaneOutput(directory, ref)?.artifact
				: undefined;
			if (!artifact) continue;
			for (const itemId of lane.reviewItemIds ?? []) {
				const verdict = parseReviewerVerdict(artifact.text, itemId);
				if (verdict) verdicts.set(itemId, verdict);
			}
		}
		if (required.every((itemId) => verdicts.has(itemId))) {
			return verdicts;
		}
	}
	return new Map();
}

function successfulObligationsFromExactBatch(
	directory: string,
	state: PrWorkflowGateState,
	batchId: string,
	expectedLanes: ReadonlyArray<{
		laneId: string;
		workflowLane: string;
		reviewItemIds?: string[];
	}>,
	expectedMode: string,
	validatedAt: string,
	checkWorkflowLane = true,
	forbiddenSubagentSessionIds: ReadonlySet<string> = new Set(),
	expectedRevisionDigest?: string,
): Set<string> {
	const records = findByBatchId(directory, batchId, {
		parentSessionId: state.sessionID,
	});
	const successful = new Set<string>();
	const validatedAtMs = Date.parse(validatedAt);
	if (!Number.isFinite(validatedAtMs)) return successful;
	const expectedByLaneId = new Map(
		expectedLanes.map((lane) => [lane.laneId, lane]),
	);
	if (expectedByLaneId.size !== expectedLanes.length) return successful;
	const recordCountByLaneId = new Map<string, number>();
	const recordCountBySubagentSessionId = new Map<string, number>();
	for (const record of records) {
		if (!record.laneId || !expectedByLaneId.has(record.laneId)) continue;
		recordCountByLaneId.set(
			record.laneId,
			(recordCountByLaneId.get(record.laneId) ?? 0) + 1,
		);
		const subagentSessionId = record.subagentSessionId?.trim();
		if (subagentSessionId) {
			recordCountBySubagentSessionId.set(
				subagentSessionId,
				(recordCountBySubagentSessionId.get(subagentSessionId) ?? 0) + 1,
			);
		}
	}
	for (const record of records) {
		const expectedLane = record.laneId
			? expectedByLaneId.get(record.laneId)
			: undefined;
		const expectedWorkflowLane = expectedLane?.workflowLane;
		const subagentSessionId = record.subagentSessionId?.trim();
		if (
			expectedWorkflowLane !== undefined &&
			record.laneId !== undefined &&
			recordCountByLaneId.get(record.laneId) === 1 &&
			Boolean(subagentSessionId) &&
			recordCountBySubagentSessionId.get(subagentSessionId!) === 1 &&
			!forbiddenSubagentSessionIds.has(subagentSessionId!) &&
			record.createdAt >= validatedAtMs &&
			(!checkWorkflowLane || record.workflowLane === expectedWorkflowLane) &&
			record.mode === expectedMode &&
			record.workspace?.prHeadSha === state.prHeadSha &&
			record.workspace?.gitHead === state.prHeadSha &&
			record.status === 'completed' &&
			record.result?.outputDegraded !== true &&
			record.result?.transcriptIncomplete !== true &&
			record.result?.truncated !== true &&
			(record.result?.chars ?? 0) > 0 &&
			Boolean(record.result?.digest?.trim()) &&
			Boolean(record.result?.outputRef?.trim()) &&
			workflowArtifactHasContractMarker(
				directory,
				state,
				record,
				expectedMode,
				expectedWorkflowLane,
				expectedLane?.reviewItemIds,
				expectedRevisionDigest,
			)
		) {
			successful.add(expectedWorkflowLane);
		}
	}
	return successful;
}

function workflowArtifactHasContractMarker(
	directory: string,
	state: PrWorkflowGateState,
	record: ReturnType<typeof findByBatchId>[number],
	expectedMode: string,
	expectedWorkflowLane: string,
	reviewItemIds?: readonly string[],
	expectedRevisionDigest?: string,
): boolean {
	const ref = record.result?.outputRef?.trim();
	if (!ref) return false;
	const loaded = readLaneOutput(directory, ref);
	if (!loaded) return false;
	const artifact = loaded.artifact;
	const recordPrHeadSha = record.workspace?.prHeadSha;
	const recordGitHead = record.workspace?.gitHead;
	const resolvedRevisionDigest =
		expectedRevisionDigest ??
		(recordPrHeadSha
			? _test_exports.resolvePrWorkflowRevisionDigest(
					directory,
					recordPrHeadSha,
				)
			: null);
	const expectedReviewScope =
		state.mode === 'PR_REVIEW' && state.prReviewBaseSha && state.prHeadSha
			? `complete PR diff ${state.prReviewBaseSha}...${state.prHeadSha}`
			: undefined;
	if (
		artifact.batchId !== record.batchId ||
		artifact.laneId !== record.laneId ||
		artifact.mode !== expectedMode ||
		artifact.sessionId !== record.subagentSessionId ||
		artifact.parentSessionId !== record.parentSessionId ||
		artifact.agent !== record.swarmPrefixedAgent ||
		artifact.role !== record.normalizedAgent ||
		artifact.source !== 'collect_lane_results' ||
		artifact.workflowLane !== record.workflowLane ||
		artifact.workflowLane !== expectedWorkflowLane ||
		!recordPrHeadSha ||
		artifact.prHeadSha !== recordPrHeadSha ||
		!recordGitHead ||
		artifact.gitHead !== recordGitHead ||
		!resolvedRevisionDigest ||
		artifact.revisionDigest !== resolvedRevisionDigest ||
		(expectedReviewScope !== undefined &&
			(record.workspace?.scope !== expectedReviewScope ||
				artifact.scope !== expectedReviewScope)) ||
		artifact.digest !== record.result?.digest ||
		artifact.chars !== record.result?.chars
	) {
		return false;
	}
	if (expectedMode === 'swarm-pr-review:reviewer') {
		return Boolean(
			reviewItemIds?.length &&
				reviewItemIds.every((itemId) =>
					Boolean(parseReviewerVerdict(artifact.text, itemId)),
				),
		);
	}
	if (expectedMode === 'swarm-pr-review:critic') {
		const reviewerVerdicts = deriveLatestPrReviewReviewerVerdicts(
			directory,
			state,
		);
		return Boolean(
			reviewItemIds?.length &&
				reviewItemIds.every((itemId) =>
					Boolean(
						parseCriticVerdict(
							artifact.text,
							itemId,
							reviewerVerdicts.get(itemId)?.severity,
						),
					),
				),
		);
	}
	if (expectedMode === 'swarm-pr-feedback:verification') {
		return /^\[FEEDBACK-VERIFIED\]\s*\|/m.test(artifact.text);
	}
	const feedbackVerdict = {
		'swarm-pr-feedback:stage-b-reviewer': ['[STAGE-B-REVIEW]', 'APPROVE'],
		'swarm-pr-feedback:stage-b-test': ['[STAGE-B-TEST]', 'PASS'],
		'swarm-pr-feedback:closeout-reviewer': ['[CLOSEOUT-REVIEW]', 'APPROVE'],
		'swarm-pr-feedback:closeout-critic': ['[CLOSEOUT-CRITIC]', 'APPROVE'],
	}[expectedMode];
	if (feedbackVerdict) {
		return Boolean(
			reviewItemIds?.length &&
				reviewItemIds.every((itemId) =>
					artifactHasExactPositiveVerdictRow(
						artifact.text,
						feedbackVerdict[0],
						itemId,
						feedbackVerdict[1],
					),
				),
		);
	}
	return prReviewDiscoveryArtifactCoversLane(
		artifact.text,
		expectedWorkflowLane,
	);
}

/** Require at least one real discovery row or a lane-bound CLEAN attestation. */
export function prReviewDiscoveryArtifactCoversLane(
	text: string,
	expectedWorkflowLane: string,
): boolean {
	const lines = text.split(/\r?\n/);
	let candidateHeaderSeen = false;
	for (const line of lines) {
		const fields = pipeFields(line);
		if (fields.length === 0) continue;
		if (
			fields[0] === '[CLEAN]' &&
			fields.length >= 4 &&
			fields[1] === expectedWorkflowLane &&
			fields.slice(1, 4).every(Boolean) &&
			fields[2].length >= 12 &&
			fields[3].length >= 20
		)
			return true;
		if (fields[0] === '[CANDIDATE]') {
			if (fields[1]?.toLowerCase() === 'candidate_id') {
				candidateHeaderSeen = true;
				continue;
			}
			if (
				fields.length >= 10 &&
				fields[2] === expectedWorkflowLane &&
				fields.slice(1, 10).every(Boolean)
			)
				return true;
			continue;
		}
		if (
			candidateHeaderSeen &&
			fields.length >= 9 &&
			fields[0]?.toLowerCase() !== 'candidate_id' &&
			fields[1] === expectedWorkflowLane &&
			fields.slice(0, 9).every(Boolean)
		)
			return true;
	}
	return false;
}

const REVIEWER_CLASSIFICATIONS = new Set([
	'CONFIRMED',
	'DISPROVED',
	'UNVERIFIED',
	'PRE_EXISTING',
]);
const REVIEWER_EVIDENCE_TYPES = new Set([
	'STRUCTURALLY_PROVEN',
	'EXECUTION_PROVEN',
	'STATIC_TRACE_PROVEN',
	'PLAUSIBLE_BUT_UNVERIFIED',
]);
const REVIEW_SEVERITIES = new Set([
	'CRITICAL',
	'HIGH',
	'MEDIUM',
	'LOW',
	'INFO',
	'NONE',
]);
const CRITIC_STATUSES = new Set([
	'UPHELD',
	'DOWNGRADED',
	'DISPROVED',
	'NEEDS_MORE_EVIDENCE',
]);
const FEEDBACK_CLASSIFICATIONS = new Set([
	'CONFIRMED',
	'PARTIAL',
	'DISPROVED',
	'PRE_EXISTING',
	'NEEDS_MORE_EVIDENCE',
	'NEEDS_USER_DECISION',
]);

interface ReviewerVerdict {
	classification: string;
	severity: string;
}

function parseReviewerVerdict(
	text: string,
	itemId: string,
): ReviewerVerdict | null {
	const rows = text
		.split(/\r?\n/)
		.map(pipeFields)
		.filter((fields) => fields[0] === '[REVIEWED]' && fields[1] === itemId);
	if (rows.length !== 1) return null;
	const fields = rows[0];
	if (fields.length !== 10 || !fields.slice(1).every(Boolean)) return null;
	const introduced = fields[5]
		.replace(/^introduced_by_pr\s*:\s*/i, '')
		.toUpperCase();
	if (
		!REVIEWER_CLASSIFICATIONS.has(fields[2]) ||
		!REVIEWER_EVIDENCE_TYPES.has(fields[3]) ||
		!REVIEW_SEVERITIES.has(fields[4]) ||
		!['YES', 'NO', 'UNKNOWN'].includes(introduced)
	)
		return null;
	if (fields[7].length < 8 || fields[8].length < 5 || fields[9].length < 3)
		return null;
	return { classification: fields[2], severity: fields[4] };
}

function parseCriticVerdict(
	text: string,
	itemId: string,
	reviewerSeverity?: string,
): { status: string; severity: string } | null {
	const rows = text
		.split(/\r?\n/)
		.map(pipeFields)
		.filter((fields) => fields[0] === '[CRITIC]' && fields[1] === itemId);
	if (rows.length !== 1) return null;
	const fields = rows[0];
	if (
		fields.length !== 6 ||
		!fields.slice(1).every(Boolean) ||
		!CRITIC_STATUSES.has(fields[2]) ||
		!REVIEW_SEVERITIES.has(fields[3])
	)
		return null;
	if (fields[2] === 'NEEDS_MORE_EVIDENCE') return null;
	if (fields[2] === 'DISPROVED' && fields[3] !== 'NONE') return null;
	if (
		fields[2] === 'UPHELD' &&
		!['CRITICAL', 'HIGH', 'MEDIUM'].includes(fields[3])
	)
		return null;
	if (fields[2] === 'DOWNGRADED' && fields[3] === 'CRITICAL') return null;
	if (reviewerSeverity) {
		const severityRank = new Map([
			['NONE', 0],
			['INFO', 1],
			['LOW', 2],
			['MEDIUM', 3],
			['HIGH', 4],
			['CRITICAL', 5],
		]);
		const reviewerRank = severityRank.get(reviewerSeverity);
		const criticRank = severityRank.get(fields[3]);
		if (reviewerRank === undefined || criticRank === undefined) return null;
		if (fields[2] === 'UPHELD' && criticRank !== reviewerRank) return null;
		if (fields[2] === 'DOWNGRADED' && criticRank >= reviewerRank) return null;
	}
	if (fields[4].length < 6 || fields[5].length < 6) return null;
	return { status: fields[2], severity: fields[3] };
}

function artifactHasExactPositiveVerdictRow(
	text: string,
	marker: string,
	itemId: string,
	positiveVerdict: string,
): boolean {
	const rows = text
		.split(/\r?\n/)
		.map(pipeFields)
		.filter((fields) => fields[0] === marker && fields[1] === itemId);
	return (
		rows.length === 1 &&
		rows[0].length >= 4 &&
		rows[0][2] === positiveVerdict &&
		rows[0].slice(1, 4).every(Boolean)
	);
}

function pipeFields(line: string): string[] {
	if (!line.includes('|')) return [];
	return line.split('|').map((field) => field.trim());
}

function feedbackArtifactCoversItems(
	directory: string,
	state: PrWorkflowGateState,
	batchId: string,
	laneId: string,
	itemIds: readonly string[],
): boolean {
	const record = findByBatchId(directory, batchId, {
		parentSessionId: state.sessionID,
	}).find((candidate) => candidate.laneId === laneId);
	const ref = record?.result?.outputRef?.trim();
	const loaded = ref ? readLaneOutput(directory, ref) : null;
	if (!loaded) return false;
	const rows = loaded.artifact.text
		.split(/\r?\n/)
		.map(pipeFields)
		.filter((fields) => fields[0] === '[FEEDBACK-VERIFIED]');
	if (rows.length !== itemIds.length) return false;
	return itemIds.every((itemId) => {
		const matches = rows.filter((fields) => fields[1] === itemId);
		return (
			matches.length === 1 &&
			matches[0].length === 4 &&
			matches[0].slice(1, 4).every(Boolean) &&
			FEEDBACK_CLASSIFICATIONS.has(matches[0][2])
		);
	});
}

async function persistState(
	directory: string,
	state: PrWorkflowGateState,
): Promise<void> {
	const validated = PrWorkflowGateStateSchema.parse(state);
	await withSessionStateMutation(directory, validated.sessionID, async () => {
		const current = await readPrWorkflowGateStateFromDisk(
			directory,
			validated.sessionID,
		);
		if (
			current
				? current.revision !== validated.revision
				: validated.revision !== 0
		) {
			throw new Error(
				'BLOCKED: PR workflow gate state changed concurrently; reload the active session state before retrying',
			);
		}
		const nextRevision = validated.revision + 1;
		const nextState = { ...validated, revision: nextRevision };
		const filePath = workflowGateStatePath(directory, validated.sessionID);
		await fsp.mkdir(path.dirname(filePath), { recursive: true });
		await writeAtomicJson(filePath, nextState);
		Object.assign(state, nextState);
		rememberState(directory, nextState);
	});
}

/** Serialize in-process mutations; the durable revision rejects stale callers. */
async function withSessionStateMutation<T>(
	directory: string,
	sessionID: string,
	action: () => Promise<T>,
): Promise<T> {
	const key = stateCacheKey(directory, sessionID);
	const previous =
		pendingStateMutationsByProjectSession.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = previous.then(() => current);
	pendingStateMutationsByProjectSession.set(key, queued);
	await previous;
	try {
		const lock = await acquireSessionStateMutationLock(directory, sessionID);
		try {
			return await action();
		} finally {
			await releaseSessionStateMutationLock(lock);
		}
	} finally {
		release();
		if (pendingStateMutationsByProjectSession.get(key) === queued) {
			pendingStateMutationsByProjectSession.delete(key);
		}
	}
}

async function acquireSessionStateMutationLock(
	directory: string,
	sessionID: string,
): Promise<{ path: string; ownerToken: string }> {
	const lockPath = workflowGateStateLockPath(directory, sessionID);
	await fsp.mkdir(path.dirname(lockPath), { recursive: true });
	for (let attempt = 0; attempt < STATE_MUTATION_LOCK_MAX_ATTEMPTS; attempt++) {
		try {
			const handle = await fsp.open(lockPath, 'wx');
			const lock: SessionStateMutationLock = {
				ownerToken: randomUUID(),
				pid: process.pid,
				createdAtMs: _test_exports.nowMs(),
			};
			try {
				await handle.writeFile(JSON.stringify(lock), 'utf-8');
				await handle.close();
			} catch (error) {
				await removeSessionStateMutationLockIfOwned(lockPath, lock.ownerToken);
				throw error;
			}
			return { path: lockPath, ownerToken: lock.ownerToken };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			if (await reclaimAbandonedSessionStateMutationLock(lockPath)) continue;
			if (attempt < STATE_MUTATION_LOCK_MAX_ATTEMPTS - 1) {
				await delay(STATE_MUTATION_LOCK_RETRY_DELAY_MS);
			}
		}
	}
	throw new Error(
		'BLOCKED: PR workflow gate state is being mutated by another process; retry after that session transition finishes',
	);
}

async function releaseSessionStateMutationLock(lock: {
	path: string;
	ownerToken: string;
}): Promise<void> {
	try {
		await removeSessionStateMutationLockIfOwned(lock.path, lock.ownerToken);
	} catch {
		// Best-effort cleanup; a crash-recovered lock is reclaimed by the next mutation.
	}
}

async function reclaimAbandonedSessionStateMutationLock(
	lockPath: string,
): Promise<boolean> {
	const lock = await readSessionStateMutationLock(lockPath);
	if (lock) {
		if (_test_exports.isProcessAlive(lock.pid)) return false;
		return removeSessionStateMutationLockIfOwned(lockPath, lock.ownerToken);
	}
	try {
		const stat = await fsp.stat(lockPath);
		if (
			_test_exports.nowMs() - stat.mtimeMs <
			STATE_MUTATION_LOCK_UNINITIALIZED_STALE_MS
		) {
			return false;
		}
		await fsp.rm(lockPath, { force: true });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
		throw error;
	}
}

async function readSessionStateMutationLock(
	lockPath: string,
): Promise<SessionStateMutationLock | null> {
	let raw: string;
	try {
		raw = await fsp.readFile(lockPath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			typeof (parsed as SessionStateMutationLock).ownerToken === 'string' &&
			(parsed as SessionStateMutationLock).ownerToken.length > 0 &&
			typeof (parsed as SessionStateMutationLock).pid === 'number' &&
			Number.isInteger((parsed as SessionStateMutationLock).pid) &&
			(parsed as SessionStateMutationLock).pid > 0 &&
			typeof (parsed as SessionStateMutationLock).createdAtMs === 'number' &&
			Number.isFinite((parsed as SessionStateMutationLock).createdAtMs)
		) {
			return parsed as SessionStateMutationLock;
		}
	} catch {
		// A crash between exclusive create and metadata write is recovered below.
	}
	return null;
}

async function removeSessionStateMutationLockIfOwned(
	lockPath: string,
	ownerToken: string,
): Promise<boolean> {
	const lock = await readSessionStateMutationLock(lockPath);
	if (!lock || lock.ownerToken !== ownerToken) return false;
	try {
		await fsp.rm(lockPath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// Permission errors prove the process exists. Unknown errors fail closed.
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}

async function readPrWorkflowGateStateFromDisk(
	directory: string,
	sessionID: string,
): Promise<PrWorkflowGateState | null> {
	const filePath = workflowGateStatePath(directory, sessionID);
	let raw: string;
	try {
		raw = await fsp.readFile(filePath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch {
		throw new Error(
			`BLOCKED: PR workflow gate state for session "${sessionID}" is not valid JSON`,
		);
	}
	const parsed = PrWorkflowGateStateSchema.safeParse(parsedJson);
	if (!parsed.success) {
		throw new Error(
			`BLOCKED: PR workflow gate state for session "${sessionID}" is invalid`,
		);
	}
	return parsed.data;
}

function rememberState(directory: string, state: PrWorkflowGateState): void {
	const cacheKey = stateCacheKey(directory, state.sessionID);
	trackedStatesByProjectSession.delete(cacheKey);
	trackedStatesByProjectSession.set(cacheKey, state);
	while (trackedStatesByProjectSession.size > MAX_TRACKED_SESSIONS) {
		const oldestKey = trackedStatesByProjectSession.keys().next().value;
		if (!oldestKey) break;
		trackedStatesByProjectSession.delete(oldestKey);
	}
}

function stateCacheKey(directory: string, sessionID: string): string {
	const resolved = path.normalize(path.resolve(directory));
	const canonicalDirectory =
		process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	return `${canonicalDirectory}\u0000${normalizeSessionID(sessionID)}`;
}

function workflowGateStatePath(directory: string, sessionID: string): string {
	return validateSwarmPath(directory, workflowGateStateRelativePath(sessionID));
}

function workflowGateStateLockPath(
	directory: string,
	sessionID: string,
): string {
	return validateSwarmPath(
		directory,
		workflowGateStateLockRelativePath(sessionID),
	);
}

function workflowGateStateLockRelativePath(sessionID: string): string {
	return path.join(WORKFLOW_GATE_DIR, `${safeSessionFileStem(sessionID)}.lock`);
}

function workflowGateStateRelativePath(sessionID: string): string {
	return path.join(WORKFLOW_GATE_DIR, `${safeSessionFileStem(sessionID)}.json`);
}

function safeSessionFileStem(sessionID: string): string {
	const normalized = normalizeSessionID(sessionID);
	const slug =
		normalized.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'session';
	const digest = createHash('sha256')
		.update(normalized)
		.digest('hex')
		.slice(0, 12);
	return `${slug}-${digest}`;
}

function normalizeSessionID(sessionID: string): string {
	const normalized = sessionID.trim();
	if (!normalized) {
		throw new Error('BLOCKED: PR workflow gate requires a non-empty sessionID');
	}
	return normalized;
}

async function writeAtomicJson(
	filePath: string,
	value: unknown,
): Promise<void> {
	const tempPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
	let lastError: unknown;
	try {
		await fsp.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf-8');
		for (let attempt = 0; attempt < WINDOWS_RENAME_MAX_RETRIES; attempt++) {
			try {
				await fsp.rename(tempPath, filePath);
				lastError = undefined;
				break;
			} catch (error) {
				lastError = error;
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY') {
					break;
				}
				if (attempt < WINDOWS_RENAME_MAX_RETRIES - 1) {
					await delay(RENAME_RETRY_DELAY_MS);
				}
			}
		}
		if (lastError) {
			throw lastError;
		}
	} finally {
		try {
			await fsp.rm(tempPath, { force: true });
		} catch {
			// best-effort temp cleanup
		}
	}
}

function isoNow(): string {
	return new Date().toISOString();
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
