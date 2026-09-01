/**
 * PR-review completion / coverage-settlement authority (issues #2383, #2385).
 *
 * The six-dimension coverage reduction and terminal report eligibility
 * machinery, moved out of `src/hooks/pr-workflow-gate.ts` behind the
 * `src/pr-review/` boundary (issue #2385). This module owns:
 *
 * - the coverage-disclosure record vocabulary (v2 plural + legacy v1 singular),
 *   its Zod schemas, and the single legacy→v2 normalization read boundary;
 * - the per-dimension attempt summary (`summarizePrReviewBaseDimensionAttempts`)
 *   and the terminal N-of-6 settlement derivation
 *   (`derivePrReviewDimensionSettlement`);
 * - the disclosure admission / rollback / settled-assertion state machine
 *   (`admitPrReviewPartialBaseCoverage`,
 *   `rollbackPrReviewPartialBaseCoverageAdmission`,
 *   `assertPrReviewBaseCoverageSettled`);
 * - the verdict eligibility matrix for terminal reports
 *   (`allowedPrReviewReportVerdicts`) and the read-only report projection
 *   (`readPrReviewTerminalCoverageForReport`).
 *
 * Binding contract (same precedent as `bindPrReviewReentryBindingReader` in
 * `authorization.ts`): the boundary must never import the orchestration gate
 * back. Gate-owned derivation helpers (`successfulObligationsFromExactBatch`,
 * `recordsPassingBatchIntegrity`, `validatePrReviewDiscoveryLaneCompletion`,
 * `validateExactStructuredReceiptCoverage`, `readBoundedSwarmRegularFile`,
 * `createPrReviewGateContext`, `requireBoundState`,
 * `readPrWorkflowGateStateFromDisk`) are supplied by the owning gate through
 * `bindPrReviewCompletionHelpers`, bound once at gate module init.
 *
 * State typing: the moved functions read only the PR-review slice of
 * `PrWorkflowGateState`, expressed as the local structural interface
 * `PrReviewCompletionState`. The gate passes its full state, which satisfies
 * the slice structurally. Durable reads/writes still go through
 * `src/pr-review/persistence.ts` (the atomic persistence boundary) — this
 * module never writes state outside `withSessionStateMutation` /
 * `writeStateWhileLocked`.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import {
	type LaneOutputArtifact,
	readLaneOutput,
} from '../background/lane-output-store.js';
import {
	type BackgroundDelegationRecord,
	type BackgroundDelegationResult,
	type BackgroundDelegationWorkflowLaneFailureClass,
	findByBatchId,
} from '../background/pending-delegations.js';
import {
	PR_REVIEW_BASE_DIMENSION_IDS,
	type PrReviewBaseDimensionId,
	type PrReviewResultReceipt,
	type PrReviewResultUnresolvedReason,
	PrReviewRunIdSchema,
} from '../background/pr-review-contract.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { CIRCUIT_TERMINAL_DELEGATION_STATUSES } from './circuit.js';
import {
	isoNow,
	normalizeSessionID,
	withSessionStateMutation,
	writeAtomicJson,
	writeStateWhileLocked,
} from './persistence.js';

// ---------------------------------------------------------------------------
// Structural state slice + gate-helper binding seam
// ---------------------------------------------------------------------------

/** Declared lane shape of a base dispatch, as the settlement reads it. */
export interface PrReviewCompletionLane {
	laneId: string;
	workflowLane: string;
	ownedWorkflowLanes?: readonly string[];
}

/** Base dispatch batch, as the settlement reads it. */
export interface PrReviewCompletionBaseDispatchRecord {
	batchId: string;
	lanes: ReadonlyArray<PrReviewCompletionLane>;
	validatedAt: string;
}

/**
 * The PR-review slice of the owning gate's `PrWorkflowGateState`: exactly the
 * fields the moved settlement machinery reads. The gate's full state type
 * satisfies this structurally, so the gate passes its state without a
 * projection step. `schemaVersion`/`revision`/`sessionID` mirror
 * `PrWorkflowPersistedStateBase` in `persistence.ts` so the CAS write generic
 * accepts the slice.
 */
export interface PrReviewCompletionState {
	schemaVersion: number;
	revision: number;
	sessionID: string;
	workflowInstanceId?: string;
	mode?: string;
	prHeadSha?: string;
	prReviewBaseSha?: string;
	prReviewBaseDispatches?: PrReviewCompletionBaseDispatchRecord[];
	prReviewContractRetryDimensions?: PrReviewBaseDimensionId[];
	prReviewReservedRunId?: string;
	prReviewArtifactRunId?: string;
	prReviewArtifactBoundaries?: Array<
		'post_explorer' | 'post_reviewer' | 'post_critic'
	>;
	prReviewDimensionCancellations?: Partial<
		Record<PrReviewBaseDimensionId, PrReviewDimensionCancellationRecord>
	>;
	prReviewPartialBaseCoverage?: PrReviewPartialBaseCoverageRecord;
	prReviewCoverageDisclosurePath?: string;
	prReviewCoverageDisclosureDigest?: string;
}

/** The gate-context surface the settlement consumes (full ctx is gate-owned). */
export interface PrReviewCompletionGateContext {
	readonly revisionDigest: string;
}

/** A batch-integrity-qualified record, as the settlement consumes it. */
export interface PrReviewCompletionQualifiedRecord {
	record: BackgroundDelegationRecord;
	expectedLane: PrReviewCompletionLane;
	expectedWorkflowLane: string;
	expectedOwnedLanes: string[];
}

/** Discovery-lane validation input, as the settlement supplies it. */
export interface PrReviewCompletionDiscoveryValidationInput {
	record: BackgroundDelegationRecord;
	result: BackgroundDelegationResult;
	artifact: LaneOutputArtifact | null;
	expected: {
		mode: string;
		workflowLane: string;
		ownedWorkflowLanes?: readonly string[];
		prHeadSha: string;
		gitHead: string;
		revisionDigest: string;
		workflowInstanceId?: string;
		workflowRevision?: number;
		baseSha?: string;
		reviewScope?: string;
		checkWorkflowLane?: boolean;
	};
}

/** Structured-receipt coverage verdict, as the settlement consumes it. */
export type PrReviewCompletionStructuredReceiptCoverage =
	| { status: 'absent' }
	| { status: 'accepted'; receipt: PrReviewResultReceipt }
	| { status: 'rejected' };

/**
 * Gate-owned derivation helpers, bound by the owning gate at module init so
 * this boundary never imports the gate back. Declared with method syntax on
 * purpose: the gate's implementations accept/return its FULL state and result
 * types, which are structural supersets of the slices below, and interface
 * method parameters are checked bivariantly.
 */
export interface PrReviewCompletionGateHelpers {
	createPrReviewGateContext(
		directory: string,
		state: PrReviewCompletionState,
	): Promise<PrReviewCompletionGateContext>;
	requireBoundState(
		directory: string,
		sessionID: string,
		expectedMode: string,
	): Promise<PrReviewCompletionState>;
	readPrWorkflowGateStateFromDisk(
		directory: string,
		sessionID: string,
	): Promise<PrReviewCompletionState | null>;
	readBoundedSwarmRegularFile(
		directory: string,
		relativePath: string,
		maxBytes: number,
		label: string,
	): Promise<string>;
	successfulObligationsFromExactBatch(
		directory: string,
		state: PrReviewCompletionState,
		batchId: string,
		expectedLanes: ReadonlyArray<PrReviewCompletionLane>,
		expectedMode: string,
		validatedAt: string,
		checkWorkflowLane?: boolean,
		forbiddenSubagentSessionIds?: ReadonlySet<string>,
		expectedRevisionDigest?: string,
		diagnostics?: string[],
	): Set<string>;
	recordsPassingBatchIntegrity(
		directory: string,
		state: PrReviewCompletionState,
		batchId: string,
		expectedLanes: ReadonlyArray<PrReviewCompletionLane>,
		expectedMode: string,
		validatedAt: string,
		checkWorkflowLane?: boolean,
		forbiddenSubagentSessionIds?: ReadonlySet<string>,
		diagnostics?: string[],
	): PrReviewCompletionQualifiedRecord[];
	validatePrReviewDiscoveryLaneCompletion(
		input: PrReviewCompletionDiscoveryValidationInput,
	): { ok: boolean };
	validateExactStructuredReceiptCoverage(
		input: PrReviewCompletionDiscoveryValidationInput,
	): PrReviewCompletionStructuredReceiptCoverage;
}

let gateHelpers: PrReviewCompletionGateHelpers | undefined;

export function bindPrReviewCompletionHelpers(
	helpers: PrReviewCompletionGateHelpers,
): void {
	gateHelpers = helpers;
}

function requireBoundHelpers(): PrReviewCompletionGateHelpers {
	if (!gateHelpers) {
		throw new Error(
			'BLOCKED: completion settlement helpers are not bound (the PR workflow gate must bind them at module init)',
		);
	}
	return gateHelpers;
}

// Call-time dispatchers over the binding, so the moved function bodies below
// read exactly as they did in the gate.

function createPrReviewGateContext(
	directory: string,
	state: PrReviewCompletionState,
): Promise<PrReviewCompletionGateContext> {
	return requireBoundHelpers().createPrReviewGateContext(directory, state);
}

function requireBoundState(
	directory: string,
	sessionID: string,
	expectedMode: string,
): Promise<PrReviewCompletionState> {
	return requireBoundHelpers().requireBoundState(
		directory,
		sessionID,
		expectedMode,
	);
}

function readPrWorkflowGateStateFromDisk(
	directory: string,
	sessionID: string,
): Promise<PrReviewCompletionState | null> {
	return requireBoundHelpers().readPrWorkflowGateStateFromDisk(
		directory,
		sessionID,
	);
}

function readBoundedSwarmRegularFile(
	directory: string,
	relativePath: string,
	maxBytes: number,
	label: string,
): Promise<string> {
	return requireBoundHelpers().readBoundedSwarmRegularFile(
		directory,
		relativePath,
		maxBytes,
		label,
	);
}

function successfulObligationsFromExactBatch(
	directory: string,
	state: PrReviewCompletionState,
	batchId: string,
	expectedLanes: ReadonlyArray<PrReviewCompletionLane>,
	expectedMode: string,
	validatedAt: string,
	checkWorkflowLane?: boolean,
	forbiddenSubagentSessionIds?: ReadonlySet<string>,
	expectedRevisionDigest?: string,
	diagnostics?: string[],
): Set<string> {
	return requireBoundHelpers().successfulObligationsFromExactBatch(
		directory,
		state,
		batchId,
		expectedLanes,
		expectedMode,
		validatedAt,
		checkWorkflowLane,
		forbiddenSubagentSessionIds,
		expectedRevisionDigest,
		diagnostics,
	);
}

function recordsPassingBatchIntegrity(
	directory: string,
	state: PrReviewCompletionState,
	batchId: string,
	expectedLanes: ReadonlyArray<PrReviewCompletionLane>,
	expectedMode: string,
	validatedAt: string,
	checkWorkflowLane?: boolean,
	forbiddenSubagentSessionIds?: ReadonlySet<string>,
	diagnostics?: string[],
): PrReviewCompletionQualifiedRecord[] {
	return requireBoundHelpers().recordsPassingBatchIntegrity(
		directory,
		state,
		batchId,
		expectedLanes,
		expectedMode,
		validatedAt,
		checkWorkflowLane,
		forbiddenSubagentSessionIds,
		diagnostics,
	);
}

function validatePrReviewDiscoveryLaneCompletion(
	input: PrReviewCompletionDiscoveryValidationInput,
): { ok: boolean } {
	return requireBoundHelpers().validatePrReviewDiscoveryLaneCompletion(input);
}

function validateExactStructuredReceiptCoverage(
	input: PrReviewCompletionDiscoveryValidationInput,
): PrReviewCompletionStructuredReceiptCoverage {
	return requireBoundHelpers().validateExactStructuredReceiptCoverage(input);
}

// ---------------------------------------------------------------------------
// Coverage record vocabulary (moved from the gate, issue #2385)
// ---------------------------------------------------------------------------

/**
 * Normalized terminal state of one canonical base dimension (issue #2383).
 * Every dimension ends in exactly one of these; completion requires every
 * LAUNCHED lane to be terminal (COVERED/FAILED) or explicitly cancelled, with
 * no in-flight lane and no late result creditable to the active generation.
 */
export type PrReviewDimensionTerminalState =
	| 'COVERED'
	| 'FAILED'
	| 'CANCELLED'
	| 'NOT_LAUNCHED';

/** Gate-derived per-dimension terminal evidence for an unresolved dimension. */
export interface PrReviewUnresolvedDimensionRecord {
	dimension: PrReviewBaseDimensionId;
	terminalState: 'FAILED' | 'CANCELLED' | 'NOT_LAUNCHED';
	reasonKind: 'lane_failure' | 'cancelled' | 'not_launched';
	failureClass?: BackgroundDelegationWorkflowLaneFailureClass;
	terminalEventId?: string;
	/** Contributing lane/batch identity, when available. */
	batchId?: string;
	laneId?: string;
	/**
	 * Bounded safe detail derived from the failure-class vocabulary — never
	 * lane output, prompts, or secrets.
	 */
	safeDetail?: string;
}

/** v2 terminal-settlement disclosure (issue #2383). The ONLY shape new writers emit. */
export interface PrReviewPartialBaseCoverageRecordV2 {
	schemaVersion: 2;
	runId: string;
	prHeadSha: string;
	revisionDigest: string;
	unresolvedDimensions: PrReviewUnresolvedDimensionRecord[];
	admittedAt: string;
}

/**
 * Legacy v1 disclosure (pre-#2383): singular `missingDimension` with a typed
 * terminal failure. Read-only — normalized to the v2 in-memory view at the
 * single read boundary; never rewritten on disk.
 */
export interface PrReviewPartialBaseCoverageRecordV1 {
	runId: string;
	prHeadSha: string;
	revisionDigest: string;
	missingDimension: PrReviewBaseDimensionId;
	failureClass: BackgroundDelegationWorkflowLaneFailureClass;
	terminalEventId: string;
	admittedAt: string;
}

export type PrReviewPartialBaseCoverageRecord =
	| PrReviewPartialBaseCoverageRecordV2
	| PrReviewPartialBaseCoverageRecordV1;

/** Terminal report kind of an N-of-6 settlement (issue #2383). */
export type PrReviewTerminalCoverageKind =
	| 'COMPLETE'
	| 'PARTIAL'
	| 'NO_COVERAGE';

/** Controller-declared terminal verdict for a PR_REVIEW completion (issue #2383). */
export const PR_REVIEW_REPORT_VERDICTS = [
	'APPROVE',
	'REQUEST_CHANGES',
	'INCOMPLETE',
] as const;

export type PrReviewReportVerdict = (typeof PR_REVIEW_REPORT_VERDICTS)[number];

/**
 * Verdicts a terminal report may carry by coverage kind (issue #2383):
 * PARTIAL may only request changes or declare itself incomplete; NO_COVERAGE
 * is a forced INCOMPLETE operational report. Neither may ever APPROVE or
 * claim a full review.
 */
export function allowedPrReviewReportVerdicts(
	kind: PrReviewTerminalCoverageKind,
): readonly PrReviewReportVerdict[] {
	if (kind === 'COMPLETE') return PR_REVIEW_REPORT_VERDICTS;
	if (kind === 'PARTIAL') return ['REQUEST_CHANGES', 'INCOMPLETE'];
	return ['INCOMPLETE'];
}

export interface PrReviewTerminalCoverageSettlement {
	kind: PrReviewTerminalCoverageKind;
	coveredDimensions: PrReviewBaseDimensionId[];
	unresolvedDimensions: PrReviewUnresolvedDimensionRecord[];
	/** False while any dimension still has a live (in-flight) lane. */
	allLaunchedTerminal: boolean;
}

/** Per-dimension explicit cancellation, written by armed recovery (issue #2383). */
export interface PrReviewDimensionCancellationRecord {
	reason: string;
	cancelledAt: string;
	source: 'armed_recovery';
}

// ---------------------------------------------------------------------------
// Coverage record schemas + legacy normalization (moved from the gate)
// ---------------------------------------------------------------------------

const PR_REVIEW_FAILURE_CLASS_SAFE_DETAILS: Record<
	BackgroundDelegationWorkflowLaneFailureClass,
	string
> = {
	contract:
		'lane failed its output contract after the bounded retry budget was exhausted',
	resource: 'lane exhausted its resource budget before producing valid output',
	deadline: 'lane passed its collection deadline without valid terminal output',
};

const PrReviewUnresolvedDimensionRecordSchema = z
	.object({
		dimension: z.enum(PR_REVIEW_BASE_DIMENSION_IDS),
		terminalState: z.enum(['FAILED', 'CANCELLED', 'NOT_LAUNCHED']),
		reasonKind: z.enum(['lane_failure', 'cancelled', 'not_launched']),
		failureClass: z.enum(['contract', 'resource', 'deadline']).optional(),
		terminalEventId: z.string().min(1).max(256).optional(),
		batchId: z.string().min(1).max(128).optional(),
		laneId: z.string().min(1).max(128).optional(),
		safeDetail: z.string().max(200).optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			value.terminalState === 'FAILED' &&
			value.reasonKind !== 'lane_failure'
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['reasonKind'],
				message: 'FAILED dimensions must use reasonKind "lane_failure"',
			});
		}
		if (
			(value.terminalState === 'CANCELLED' &&
				value.reasonKind !== 'cancelled') ||
			(value.terminalState === 'NOT_LAUNCHED' &&
				value.reasonKind !== 'not_launched')
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['reasonKind'],
				message: `reasonKind must match terminalState "${value.terminalState}"`,
			});
		}
		if (
			value.terminalState !== 'FAILED' &&
			(value.failureClass !== undefined || value.terminalEventId !== undefined)
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['failureClass'],
				message:
					'failureClass/terminalEventId are legal only on FAILED dimensions',
			});
		}
	});

const PrReviewPartialBaseCoverageRecordV2Schema = z
	.object({
		schemaVersion: z.literal(2),
		runId: z.string().min(1).max(128),
		prHeadSha: z.string().regex(/^[0-9a-f]{6,64}$/i),
		revisionDigest: z.string().min(1).max(256),
		unresolvedDimensions: z
			.array(PrReviewUnresolvedDimensionRecordSchema)
			.min(1)
			.max(PR_REVIEW_BASE_DIMENSION_IDS.length),
		admittedAt: z.string().datetime(),
	})
	.strict()
	.superRefine((value, ctx) => {
		const seen = new Set<string>();
		for (const entry of value.unresolvedDimensions) {
			if (seen.has(entry.dimension)) {
				ctx.addIssue({
					code: 'custom',
					path: ['unresolvedDimensions'],
					message: `must not contain duplicate dimension "${entry.dimension}"`,
				});
				return;
			}
			seen.add(entry.dimension);
		}
	});

/** Legacy pre-#2383 singular disclosure; read-only, normalized on read. */
const PrReviewPartialBaseCoverageRecordV1Schema = z
	.object({
		runId: z.string().min(1).max(128),
		prHeadSha: z.string().regex(/^[0-9a-f]{6,64}$/i),
		revisionDigest: z.string().min(1).max(256),
		missingDimension: z.enum(PR_REVIEW_BASE_DIMENSION_IDS),
		failureClass: z.enum(['contract', 'resource', 'deadline']),
		terminalEventId: z.string().min(1).max(256),
		admittedAt: z.string().datetime(),
	})
	.strict();

export const PrReviewPartialBaseCoverageRecordSchema = z.union([
	PrReviewPartialBaseCoverageRecordV2Schema,
	PrReviewPartialBaseCoverageRecordV1Schema,
]);

export const PrReviewDimensionCancellationRecordSchema = z
	.object({
		reason: z.string().min(1).max(500),
		cancelledAt: z.string().datetime(),
		source: z.literal('armed_recovery'),
	})
	.strict();

/**
 * Normalize any disclosure record to the v2 in-memory view. A legacy v1
 * record maps to exactly one FAILED entry; the durable file is never
 * rewritten (its digest stays bound to the original bytes).
 */
export function normalizePrReviewPartialBaseCoverageRecord(
	record: PrReviewPartialBaseCoverageRecord,
): PrReviewPartialBaseCoverageRecordV2 {
	if ('missingDimension' in record) {
		return {
			schemaVersion: 2,
			runId: record.runId,
			prHeadSha: record.prHeadSha,
			revisionDigest: record.revisionDigest,
			unresolvedDimensions: [
				{
					dimension: record.missingDimension,
					terminalState: 'FAILED',
					reasonKind: 'lane_failure',
					failureClass: record.failureClass,
					terminalEventId: record.terminalEventId,
					safeDetail: PR_REVIEW_FAILURE_CLASS_SAFE_DETAILS[record.failureClass],
				},
			],
			admittedAt: record.admittedAt,
		};
	}
	return record;
}

// ---------------------------------------------------------------------------
// Per-dimension attempt summary + typed terminal evidence
// (moved from the gate, issue #2385)
// ---------------------------------------------------------------------------

/**
 * Delegation statuses that prove a lane will produce nothing further.
 *
 * Enumerated here rather than reusing `isTerminal`
 * (`src/background/pending-delegations.ts:3555`) because that helper is private
 * to its module and because the two sets deliberately differ: `consumed` is a
 * *successfully ingested* terminal state, so treating it as a failure would let
 * a healthy lane be consolidated over. `pending` / `running` / `ingesting` /
 * `ingestion_error` are in flight or retryable. Any unrecognized (future) status
 * is treated as "not proven failed" and denies consolidation — default-deny.
 *
 * `completed` is included because completion alone is not success: a completed
 * record whose durable artifact is degraded, empty, identity-mismatched, or
 * semantically invalid is exactly the ran-and-failed case the tier-L retry
 * exception exists for. Preview truncation alone is recoverable when the durable
 * artifact validates. This set is therefore only consulted after both identity
 * and revision-independent semantic validation.
 *
 * Issue #2385: the set itself is owned by `src/pr-review/circuit.ts`
 * (`CIRCUIT_TERMINAL_DELEGATION_STATUSES`) — one vocabulary, no mirror.
 */
const TERMINAL_FAILED_DELEGATION_STATUSES =
	CIRCUIT_TERMINAL_DELEGATION_STATUSES;

export interface PrReviewBaseDimensionAttempts {
	/** Dimensions with a currently authoritative successful artifact. */
	successful: Set<string>;
	/** Dimensions with a currently in-flight or retryable recorded lane. */
	inFlight: Set<string>;
	/** Dimensions whose terminal record was a contract failure. */
	contractFailed: Set<string>;
	/** Dimensions that already consumed the dedicated contract retry channel. */
	contractRetried: Set<string>;
	/**
	 * The subset of `successful` supplied by a lane that owns that dimension
	 * alone. Used by the cumulative tier-L lane floor to decide when an earlier
	 * consolidated lane has been superseded and no longer spends lane budget.
	 */
	dedicatedSuccessful: Set<string>;
	/** Dimensions whose recorded lane ran to a terminal, non-successful end. */
	terminallyFailed: Set<string>;
}

/**
 * Per-dimension success/failure across every recorded base batch.
 *
 * The two halves deliberately use different evidence:
 *
 * - **successful** is revision-aware (`successfulObligationsFromExactBatch`
 *   compares each artifact's `revisionDigest` against the current worktree), so
 *   a stale artifact is correctly not a current source.
 * - **terminallyFailed** is revision-INdependent on purpose.
 *   `recordsPassingBatchIntegrity` plus
 *   `hasRevisionIndependentDiscoverySemantics` use the artifact's recorded
 *   revision rather than the current worktree digest. If failure were
 *   derived from the revision-aware set instead, any working-tree edit would
 *   make all six dimensions read as "failed" at once and a caller could then
 *   consolidate the whole base wave into two lanes — re-opening the tier-L lane
 *   floor by a second route (issue #1968 BL-4).
 */
export function summarizePrReviewBaseDimensionAttempts(
	directory: string,
	state: PrReviewCompletionState,
	revisionDigest: string,
): PrReviewBaseDimensionAttempts {
	const successful = new Set<string>();
	const inFlight = new Set<string>();
	const contractFailed = new Set<string>();
	const contractRetried = new Set<string>(
		state.prReviewContractRetryDimensions ?? [],
	);
	const dedicatedSuccessful = new Set<string>();
	const terminallyFailed = new Set<string>();
	for (const batch of state.prReviewBaseDispatches ?? []) {
		const batchSuccessful = successfulObligationsFromExactBatch(
			directory,
			state,
			batch.batchId,
			batch.lanes,
			'swarm-pr-review:base',
			batch.validatedAt,
			true,
			new Set(),
			revisionDigest,
		);
		for (const obligation of batchSuccessful) {
			successful.add(obligation);
		}
		for (const lane of batch.lanes) {
			if ((lane.ownedWorkflowLanes?.length ?? 1) !== 1) continue;
			const dimension = lane.ownedWorkflowLanes?.[0] ?? lane.workflowLane;
			if (batchSuccessful.has(dimension)) dedicatedSuccessful.add(dimension);
		}
		const semanticallyValidLaneIds = new Set(
			recordsPassingBatchIntegrity(
				directory,
				state,
				batch.batchId,
				batch.lanes,
				'swarm-pr-review:base',
				batch.validatedAt,
			)
				.filter((qualified) =>
					hasRevisionIndependentDiscoverySemantics(directory, qualified, state),
				)
				.map((qualified) => qualified.record.laneId),
		);
		const records = findByBatchId(directory, batch.batchId, {
			parentSessionId: state.sessionID,
		});
		for (const lane of batch.lanes) {
			if (semanticallyValidLaneIds.has(lane.laneId)) continue;
			const laneRecords = records.filter(
				(record) => record.laneId === lane.laneId,
			);
			// No record at all: never dispatched. Any recorded lane not wholly in
			// the terminal failure set is still in flight or retryable; it is not a
			// failed obligation yet, but it must stay out of retry targets.
			if (laneRecords.length === 0) {
				continue;
			}
			if (
				!laneRecords.every((record) =>
					TERMINAL_FAILED_DELEGATION_STATUSES.has(record.status),
				)
			) {
				for (const dimension of lane.ownedWorkflowLanes?.length
					? lane.ownedWorkflowLanes
					: [lane.workflowLane]) {
					inFlight.add(dimension);
				}
				continue;
			}
			for (const dimension of lane.ownedWorkflowLanes?.length
				? lane.ownedWorkflowLanes
				: [lane.workflowLane]) {
				terminallyFailed.add(dimension);
				if (
					laneRecords.at(-1)?.result?.workflowLaneFailureClass === 'contract'
				) {
					contractFailed.add(dimension);
				}
			}
		}
	}
	return {
		successful,
		inFlight,
		contractFailed,
		contractRetried,
		dedicatedSuccessful,
		terminallyFailed,
	};
}

function hasRevisionIndependentDiscoverySemantics(
	directory: string,
	qualified: PrReviewCompletionQualifiedRecord,
	state: PrReviewCompletionState,
): boolean {
	const ref = qualified.record.result?.outputRef?.trim();
	if (!ref) return false;
	const artifact = readLaneOutput(directory, ref)?.artifact ?? null;
	if (!artifact?.revisionDigest?.trim()) return false;
	return validatePrReviewDiscoveryLaneCompletion({
		record: qualified.record,
		result: qualified.record.result!,
		artifact,
		expected: {
			mode: 'swarm-pr-review:base',
			workflowLane: qualified.expectedWorkflowLane,
			ownedWorkflowLanes: qualified.expectedOwnedLanes,
			prHeadSha: state.prHeadSha ?? '',
			gitHead: state.prHeadSha ?? '',
			revisionDigest: artifact.revisionDigest,
			workflowInstanceId: state.workflowInstanceId,
			workflowRevision: state.revision,
			baseSha: state.prReviewBaseSha,
			reviewScope:
				state.prReviewBaseSha && state.prHeadSha
					? `complete PR diff ${state.prReviewBaseSha}...${state.prHeadSha}`
					: undefined,
		},
	}).ok;
}

interface PrReviewLatestTypedFailure {
	failureClass: BackgroundDelegationWorkflowLaneFailureClass;
	terminalEventId: string;
	recordedAt: number;
	/** Contributing lane/batch identity, when available (issue #2383). */
	batchId?: string;
	laneId?: string;
}

function latestTypedFailureForBaseDimension(
	directory: string,
	state: PrReviewCompletionState,
	dimension: PrReviewBaseDimensionId,
): PrReviewLatestTypedFailure | null {
	let latest: PrReviewLatestTypedFailure | null = null;
	for (const batch of state.prReviewBaseDispatches ?? []) {
		for (const lane of batch.lanes) {
			const owned = lane.ownedWorkflowLanes?.length
				? lane.ownedWorkflowLanes
				: [lane.workflowLane];
			if (!owned.includes(dimension)) continue;
			for (const record of findByBatchId(directory, batch.batchId, {
				parentSessionId: state.sessionID,
			}).filter((candidate) => candidate.laneId === lane.laneId)) {
				const terminal = record.terminalResult;
				const result = terminal?.result ?? record.result;
				const failureClass = result?.workflowLaneFailureClass;
				if (!terminal || !failureClass || terminal.status === 'completed')
					continue;
				const candidate = {
					failureClass,
					terminalEventId: terminal.eventId,
					recordedAt: terminal.recordedAt,
					batchId: batch.batchId,
					laneId: lane.laneId,
				};
				if (
					latest === null ||
					candidate.recordedAt > latest.recordedAt ||
					(candidate.recordedAt === latest.recordedAt &&
						candidate.terminalEventId.localeCompare(latest.terminalEventId) > 0)
				) {
					latest = candidate;
				}
			}
		}
	}
	return latest;
}

interface PrReviewLatestStructuredUnresolved {
	failureClass: BackgroundDelegationWorkflowLaneFailureClass;
	recordedAt: number;
	batchId: string;
	laneId: string;
	safeDetail: string;
}

function failureClassFromStructuredUnresolvedReason(
	reason: PrReviewResultUnresolvedReason,
): BackgroundDelegationWorkflowLaneFailureClass {
	switch (reason) {
		case 'RESOURCE_LIMIT':
			return 'resource';
		case 'DEADLINE_EXCEEDED':
			return 'deadline';
		default:
			return 'contract';
	}
}

function safeDetailFromStructuredUnresolvedReason(
	reason: PrReviewResultUnresolvedReason,
): string {
	switch (reason) {
		case 'NOT_EXECUTED':
			return 'structured receipt reported this lane was never executed';
		case 'PARTIAL_OUTPUT':
			return 'structured receipt reported partial output that could not settle this lane';
		case 'CONTRACT_FAILURE':
			return 'structured receipt reported contract-invalid output for this lane';
		case 'RESOURCE_LIMIT':
			return 'structured receipt reported the lane exhausted its resource budget';
		case 'DEADLINE_EXCEEDED':
			return 'structured receipt reported the lane exceeded its collection deadline';
		case 'STALE_BINDING':
			return 'structured receipt reported stale workflow binding for this lane';
		case 'PARENT_CANCELLED':
			return 'structured receipt reported parent-side cancellation before settlement';
	}
}

function latestStructuredReceiptUnresolvedForBaseDimension(
	directory: string,
	state: PrReviewCompletionState,
	revisionDigest: string,
	dimension: PrReviewBaseDimensionId,
): PrReviewLatestStructuredUnresolved | null {
	let latest: PrReviewLatestStructuredUnresolved | null = null;
	const reviewScope =
		state.prReviewBaseSha && state.prHeadSha
			? `complete PR diff ${state.prReviewBaseSha}...${state.prHeadSha}`
			: undefined;
	for (const batch of state.prReviewBaseDispatches ?? []) {
		const records = findByBatchId(directory, batch.batchId, {
			parentSessionId: state.sessionID,
		});
		for (const lane of batch.lanes) {
			const ownedWorkflowLanes = lane.ownedWorkflowLanes?.length
				? lane.ownedWorkflowLanes
				: [lane.workflowLane];
			if (!ownedWorkflowLanes.includes(dimension)) continue;
			for (const record of records.filter(
				(candidate) => candidate.laneId === lane.laneId,
			)) {
				const result = record.result;
				if (!result) continue;
				const structured = validateExactStructuredReceiptCoverage({
					record,
					result,
					artifact: null,
					expected: {
						mode: 'swarm-pr-review:base',
						workflowLane: lane.workflowLane,
						ownedWorkflowLanes,
						prHeadSha: state.prHeadSha ?? '',
						gitHead: state.prHeadSha ?? '',
						revisionDigest,
						workflowInstanceId: state.workflowInstanceId,
						workflowRevision: state.revision,
						baseSha: state.prReviewBaseSha,
						reviewScope,
					},
				});
				if (structured.status !== 'accepted') continue;
				const unresolved = structured.receipt.envelope.unresolved.find(
					(entry) => entry.workflowLane === dimension,
				);
				if (!unresolved) continue;
				const candidate = {
					failureClass: failureClassFromStructuredUnresolvedReason(
						unresolved.reason,
					),
					recordedAt: record.updatedAt,
					batchId: batch.batchId,
					laneId: lane.laneId,
					safeDetail: safeDetailFromStructuredUnresolvedReason(
						unresolved.reason,
					),
				};
				if (
					latest === null ||
					candidate.recordedAt > latest.recordedAt ||
					(candidate.recordedAt === latest.recordedAt &&
						`${candidate.batchId}\0${candidate.laneId}`.localeCompare(
							`${latest.batchId}\0${latest.laneId}`,
						) > 0)
				) {
					latest = candidate;
				}
			}
		}
	}
	return latest;
}

// ---------------------------------------------------------------------------
// Terminal N-of-6 settlement + disclosure admission state machine
// (moved from the gate, issue #2385)
// ---------------------------------------------------------------------------

const PR_REVIEW_COVERAGE_DISCLOSURE_MAX_BYTES = 4_096;

export function coverageDisclosureRelativePath(runId: string): string {
	return path.join('pr-review', runId, 'coverage-disclosure.json');
}

/**
 * Derive the normalized terminal N-of-6 settlement (issue #2383).
 *
 * Pure over durable state: no mutation, no audit. Every dimension maps to
 * exactly one view — COVERED, a terminal unresolved record (FAILED /
 * CANCELLED / NOT_LAUNCHED), or a live (in-flight) dimension that blocks
 * settlement. Coverage success is revision-aware (a stale artifact never
 * counts on the current worktree), and a FAILED dimension carries the typed
 * terminal-failure evidence plus its contributing lane/batch identity.
 */
export function derivePrReviewDimensionSettlement(
	directory: string,
	state: PrReviewCompletionState,
	revisionDigest: string,
): PrReviewTerminalCoverageSettlement & {
	liveDimensions: PrReviewBaseDimensionId[];
} {
	const attempts = summarizePrReviewBaseDimensionAttempts(
		directory,
		state,
		revisionDigest,
	);
	const cancellations: Partial<
		Record<PrReviewBaseDimensionId, PrReviewDimensionCancellationRecord>
	> = state.prReviewDimensionCancellations ?? {};
	// Dimensions for which some declared lane actually dispatched (has
	// delegation records). A declared-but-never-dispatched lane leaves its
	// dimensions NOT_LAUNCHED, mirroring `summarizePrReviewBaseDimension-
	// Attempts`'s "no record at all: never dispatched" reading.
	const dispatched = new Set<string>();
	for (const batch of state.prReviewBaseDispatches ?? []) {
		const records = findByBatchId(directory, batch.batchId, {
			parentSessionId: state.sessionID,
		});
		for (const lane of batch.lanes) {
			if (!records.some((record) => record.laneId === lane.laneId)) continue;
			for (const dimension of lane.ownedWorkflowLanes?.length
				? lane.ownedWorkflowLanes
				: [lane.workflowLane]) {
				dispatched.add(dimension);
			}
		}
	}
	const coveredDimensions: PrReviewBaseDimensionId[] = [];
	const unresolvedDimensions: PrReviewUnresolvedDimensionRecord[] = [];
	const liveDimensions: PrReviewBaseDimensionId[] = [];
	for (const dimension of PR_REVIEW_BASE_DIMENSION_IDS) {
		if (attempts.successful.has(dimension)) {
			coveredDimensions.push(dimension);
			continue;
		}
		if (attempts.inFlight.has(dimension)) {
			// A live lane is not terminal: settlement consumers must refuse
			// completion while any launched lane can still produce a result
			// creditable to the active generation.
			liveDimensions.push(dimension);
			continue;
		}
		const cancellation = cancellations[dimension];
		if (cancellation) {
			unresolvedDimensions.push({
				dimension,
				terminalState: 'CANCELLED',
				reasonKind: 'cancelled',
				safeDetail: `explicitly cancelled by the audited armed-recovery operation at ${cancellation.cancelledAt}`,
			});
			continue;
		}
		const latestFailure = latestTypedFailureForBaseDimension(
			directory,
			state,
			dimension,
		);
		const latestStructuredUnresolved =
			latestStructuredReceiptUnresolvedForBaseDimension(
				directory,
				state,
				revisionDigest,
				dimension,
			);
		if (
			attempts.terminallyFailed.has(dimension) ||
			latestStructuredUnresolved
		) {
			const unresolvedFailure =
				latestStructuredUnresolved &&
				(!latestFailure ||
					latestStructuredUnresolved.recordedAt >= latestFailure.recordedAt)
					? latestStructuredUnresolved
					: latestFailure;
			unresolvedDimensions.push({
				dimension,
				terminalState: 'FAILED',
				reasonKind: 'lane_failure',
				failureClass: unresolvedFailure?.failureClass,
				terminalEventId:
					unresolvedFailure && 'terminalEventId' in unresolvedFailure
						? unresolvedFailure.terminalEventId
						: undefined,
				batchId: unresolvedFailure?.batchId,
				laneId: unresolvedFailure?.laneId,
				safeDetail:
					unresolvedFailure && 'safeDetail' in unresolvedFailure
						? unresolvedFailure.safeDetail
						: unresolvedFailure
							? PR_REVIEW_FAILURE_CLASS_SAFE_DETAILS[
									unresolvedFailure.failureClass
								]
							: 'lane terminated without a typed failure class',
			});
			continue;
		}
		if (dispatched.has(dimension)) {
			// Dispatched but neither successful, live, terminally failed, nor
			// cancelled: treat as NOT_LAUNCHED evidence-wise is a lie; surface
			// it as unresolved-not-launched only when nothing was ever
			// dispatched. A dispatched-yet-unresolved dimension blocks honest
			// settlement instead of inventing a terminal state.
			liveDimensions.push(dimension);
			continue;
		}
		unresolvedDimensions.push({
			dimension,
			terminalState: 'NOT_LAUNCHED',
			reasonKind: 'not_launched',
			safeDetail: 'no lane for this dimension was ever dispatched',
		});
	}
	const kind: PrReviewTerminalCoverageKind =
		coveredDimensions.length === PR_REVIEW_BASE_DIMENSION_IDS.length
			? 'COMPLETE'
			: coveredDimensions.length > 0
				? 'PARTIAL'
				: 'NO_COVERAGE';
	return {
		kind,
		coveredDimensions,
		unresolvedDimensions,
		liveDimensions,
		allLaunchedTerminal: liveDimensions.length === 0,
	};
}

async function readAndVerifyCoverageDisclosure(
	directory: string,
	state: PrReviewCompletionState,
): Promise<PrReviewPartialBaseCoverageRecordV2 | null> {
	const record = state.prReviewPartialBaseCoverage;
	const relativePath = state.prReviewCoverageDisclosurePath;
	const expectedDigest = state.prReviewCoverageDisclosureDigest;
	if (!record && !relativePath && !expectedDigest) return null;
	if (!record || !relativePath || !expectedDigest) {
		throw new Error(
			'BLOCKED: PR_REVIEW partial base coverage disclosure state is incomplete',
		);
	}
	const expectedPath = coverageDisclosureRelativePath(record.runId)
		.split(path.sep)
		.join('/');
	if (relativePath !== expectedPath) {
		throw new Error(
			'BLOCKED: PR_REVIEW partial base coverage disclosure path does not match its bound run',
		);
	}
	const raw = await readBoundedSwarmRegularFile(
		directory,
		relativePath,
		PR_REVIEW_COVERAGE_DISCLOSURE_MAX_BYTES,
		'PR_REVIEW partial base coverage disclosure',
	);
	const digest = createHash('sha256').update(raw, 'utf8').digest('hex');
	if (digest !== expectedDigest) {
		throw new Error(
			'BLOCKED: PR_REVIEW partial base coverage disclosure digest does not match durable state',
		);
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(raw);
	} catch {
		throw new Error(
			'BLOCKED: PR_REVIEW partial base coverage disclosure is invalid JSON',
		);
	}
	const parsed = PrReviewPartialBaseCoverageRecordSchema.safeParse(decoded);
	if (
		!parsed.success ||
		JSON.stringify(parsed.data) !== JSON.stringify(record)
	) {
		throw new Error(
			'BLOCKED: PR_REVIEW partial base coverage disclosure does not match durable state',
		);
	}
	// Issue #2383 single read boundary: legacy singular disclosures normalize
	// to the v2 view in memory; the durable file and its digest are never
	// rewritten.
	return normalizePrReviewPartialBaseCoverageRecord(parsed.data);
}

export async function admitPrReviewPartialBaseCoverage(
	directory: string,
	sessionID: string,
	runId: string,
	unresolvedDimensions: readonly PrReviewBaseDimensionId[],
): Promise<PrReviewCompletionState> {
	return withSessionStateMutation(directory, sessionID.trim(), async () => {
		const state = await readPrWorkflowGateStateFromDisk(
			directory,
			sessionID.trim(),
		);
		if (!state || state.mode !== 'PR_REVIEW' || !state.prHeadSha) {
			throw new Error(
				'BLOCKED: partial base coverage requires an active head-bound PR_REVIEW workflow',
			);
		}
		const normalizedRunId = PrReviewRunIdSchema.parse(runId);
		if (
			state.prReviewReservedRunId &&
			state.prReviewReservedRunId !== normalizedRunId
		) {
			throw new Error(
				'BLOCKED: partial base coverage run does not match the reserved PR-review run',
			);
		}
		const declared = [...new Set(unresolvedDimensions)];
		if (declared.length !== unresolvedDimensions.length) {
			throw new Error(
				'BLOCKED: partial base coverage unresolved_dimensions contains duplicates',
			);
		}
		if (declared.length === 0) {
			throw new Error(
				'BLOCKED: partial base coverage requires at least one unresolved dimension; a fully covered run needs no disclosure',
			);
		}
		const ctx = await createPrReviewGateContext(directory, state);
		const settlement = derivePrReviewDimensionSettlement(
			directory,
			state,
			ctx.revisionDigest,
		);
		if (settlement.liveDimensions.length > 0) {
			const liveDeclared = settlement.liveDimensions.filter((dimension) =>
				declared.includes(dimension),
			);
			if (liveDeclared.length > 0) {
				throw new Error(
					`BLOCKED: partial base coverage dimensions still have in-flight lanes: ${liveDeclared.join(', ')}. Completion is allowed only once every launched lane is terminal or explicitly cancelled.`,
				);
			}
		}
		const derivedIds = settlement.unresolvedDimensions.map(
			(entry) => entry.dimension,
		);
		const declaredSet = new Set(declared);
		const derivedSet = new Set(derivedIds);
		const missingFromDeclaration = derivedIds.filter(
			(dimension) => !declaredSet.has(dimension),
		);
		const unknownInDeclaration = declared.filter(
			(dimension) => !derivedSet.has(dimension),
		);
		if (
			missingFromDeclaration.length > 0 ||
			unknownInDeclaration.length > 0 ||
			derivedIds.length !== declared.length
		) {
			throw new Error(
				`BLOCKED: partial base coverage declaration must exactly match the derived terminal settlement; declared: [${declared.join(', ')}]` +
					`; derived unresolved: [${derivedIds.join(', ') || '(none)'}]` +
					(unknownInDeclaration.length > 0
						? `; declared-but-not-unresolved: [${unknownInDeclaration.join(', ')}]`
						: '') +
					(settlement.liveDimensions.length > 0
						? `; still-live (not settleable): [${settlement.liveDimensions.join(', ')}]`
						: ''),
			);
		}
		for (const entry of settlement.unresolvedDimensions) {
			if (entry.terminalState === 'FAILED' && !entry.failureClass) {
				throw new Error(
					`BLOCKED: partial base coverage dimension "${entry.dimension}" lacks a typed terminal failure`,
				);
			}
			if (
				entry.terminalState === 'CANCELLED' &&
				!state.prReviewDimensionCancellations?.[entry.dimension]
			) {
				throw new Error(
					`BLOCKED: partial base coverage dimension "${entry.dimension}" declared CANCELLED without a persisted cancellation record`,
				);
			}
		}
		const existing = await readAndVerifyCoverageDisclosure(directory, state);
		if (existing) {
			const sameSettlement =
				existing.runId === normalizedRunId &&
				existing.prHeadSha === state.prHeadSha &&
				existing.revisionDigest === ctx.revisionDigest &&
				JSON.stringify(existing.unresolvedDimensions) ===
					JSON.stringify(settlement.unresolvedDimensions);
			if (sameSettlement) {
				return state;
			}
			throw new Error(
				'BLOCKED: partial base coverage admission differs from the immutable existing disclosure',
			);
		}
		const record: PrReviewPartialBaseCoverageRecordV2 = {
			schemaVersion: 2,
			runId: normalizedRunId,
			prHeadSha: state.prHeadSha,
			revisionDigest: ctx.revisionDigest,
			unresolvedDimensions: settlement.unresolvedDimensions,
			admittedAt: isoNow(),
		};
		const relativePath = coverageDisclosureRelativePath(normalizedRunId)
			.split(path.sep)
			.join('/');
		const absolutePath = validateSwarmPath(directory, relativePath);
		const raw = JSON.stringify(record, null, 2);
		if (
			Buffer.byteLength(raw, 'utf8') > PR_REVIEW_COVERAGE_DISCLOSURE_MAX_BYTES
		) {
			throw new Error(
				'BLOCKED: partial base coverage disclosure exceeds its write bound',
			);
		}
		let disclosureWasMissing = false;
		const removeNewDisclosure = async (): Promise<void> => {
			if (!disclosureWasMissing) return;
			try {
				if ((await fsp.readFile(absolutePath, 'utf8')) === raw) {
					await fsp.rm(absolutePath, { force: true });
				}
			} catch {
				// Preserve the original admission error; cleanup is best effort.
			}
		};
		try {
			const persisted = readFileSync(absolutePath, 'utf8');
			if (persisted !== raw) {
				throw new Error(
					'BLOCKED: partial base coverage disclosure path already contains different content',
				);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				disclosureWasMissing = true;
				try {
					await writeAtomicJson(directory, absolutePath, record);
				} catch (writeError) {
					await removeNewDisclosure();
					throw writeError;
				}
			} else {
				throw error;
			}
		}
		const digest = createHash('sha256').update(raw, 'utf8').digest('hex');
		try {
			return await writeStateWhileLocked(directory, {
				...state,
				updatedAt: isoNow(),
				prReviewPartialBaseCoverage: record,
				prReviewCoverageDisclosurePath: relativePath,
				prReviewCoverageDisclosureDigest: digest,
			});
		} catch (error) {
			await removeNewDisclosure();
			throw error;
		}
	});
}

/**
 * Undo a newly admitted partial-base disclosure when the findings checkpoint
 * cannot be completed. The compare-and-clear checks keep a stale writer from
 * deleting a disclosure that another writer has already committed.
 */
export async function rollbackPrReviewPartialBaseCoverageAdmission(
	directory: string,
	sessionID: string,
	options: {
		runId: string;
		boundary: 'post_explorer' | 'post_reviewer' | 'post_critic';
		relativePath: string;
		digest: string;
	},
): Promise<boolean> {
	return withSessionStateMutation(directory, sessionID.trim(), async () => {
		const state = await readPrWorkflowGateStateFromDisk(
			directory,
			sessionID.trim(),
		);
		const record = state?.prReviewPartialBaseCoverage;
		if (!state || !record || record.runId !== options.runId) return false;
		if ((state.prReviewArtifactBoundaries ?? []).includes(options.boundary)) {
			return false;
		}
		if (
			state.prReviewCoverageDisclosurePath !== options.relativePath ||
			state.prReviewCoverageDisclosureDigest !== options.digest
		) {
			return false;
		}
		const absolutePath = validateSwarmPath(directory, options.relativePath);
		try {
			const raw = await fsp.readFile(absolutePath, 'utf8');
			const digest = createHash('sha256').update(raw, 'utf8').digest('hex');
			if (digest !== options.digest) return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		await fsp.rm(absolutePath, { force: true });
		await writeStateWhileLocked(directory, {
			...state,
			updatedAt: isoNow(),
			prReviewPartialBaseCoverage: undefined,
			prReviewCoverageDisclosurePath: undefined,
			prReviewCoverageDisclosureDigest: undefined,
		});
		return true;
	});
}

/**
 * Validate durable terminal N-of-6 coverage evidence (issue #2383).
 *
 * Returns the settlement: COMPLETE when all six dimensions are covered, or
 * PARTIAL / NO_COVERAGE when an admitted, still-accurate disclosure exactly
 * matches the currently derived terminal settlement. Throws while any
 * unresolved dimension still has a live lane, or when the disclosure has been
 * invalidated by later evidence (e.g. a late success landing on the same
 * revision) — the disclosure is immutable, so such a run must re-settle or
 * restart rather than silently re-crediting.
 */
export async function assertPrReviewBaseCoverageSettled(
	directory: string,
	sessionID: string,
	gateContext?: PrReviewCompletionGateContext,
): Promise<{
	state: PrReviewCompletionState;
	settlement: PrReviewTerminalCoverageSettlement & {
		liveDimensions: PrReviewBaseDimensionId[];
	};
}> {
	const state = await requireBoundState(directory, sessionID, 'PR_REVIEW');
	const batches = state.prReviewBaseDispatches ?? [];
	if (batches.length === 0) {
		throw new Error('BLOCKED: PR_REVIEW requires at least one base batch');
	}
	const ctx =
		gateContext ?? (await createPrReviewGateContext(directory, state));
	const settlement = derivePrReviewDimensionSettlement(
		directory,
		state,
		ctx.revisionDigest,
	);
	if (settlement.kind === 'COMPLETE') {
		return { state, settlement };
	}
	if (settlement.liveDimensions.length > 0) {
		throw new Error(
			`BLOCKED: PR_REVIEW base coverage is incomplete and still has live lanes for: ${settlement.liveDimensions.join(', ')}. Completion is allowed only once every launched lane is terminal or explicitly cancelled.`,
		);
	}
	const disclosure = await readAndVerifyCoverageDisclosure(directory, state);
	const disclosureIds = (disclosure?.unresolvedDimensions ?? []).map(
		(entry) => entry.dimension,
	);
	const derivedIds = settlement.unresolvedDimensions.map(
		(entry) => entry.dimension,
	);
	if (
		disclosure &&
		JSON.stringify(disclosureIds) === JSON.stringify(derivedIds) &&
		JSON.stringify(disclosure?.unresolvedDimensions) ===
			JSON.stringify(settlement.unresolvedDimensions) &&
		disclosure.prHeadSha === state.prHeadSha &&
		disclosure.revisionDigest === ctx.revisionDigest &&
		disclosure.runId ===
			(state.prReviewArtifactRunId ?? state.prReviewReservedRunId)
	) {
		return { state, settlement };
	}
	const reason =
		disclosure === null
			? 'no terminal settlement disclosure is admitted; settle via write_pr_review_artifact partial_base_coverage.unresolved_dimensions'
			: disclosureIds.join(',') !== derivedIds.join(',')
				? `the admitted disclosure [${disclosureIds.join(', ')}] no longer matches the derived terminal settlement [${derivedIds.join(', ')}] — later evidence invalidated it; the disclosure is immutable, so re-run the affected dimensions or restart the review`
				: 'the admitted disclosure no longer matches the derived per-dimension terminal evidence';
	throw new Error(
		`BLOCKED: PR_REVIEW base coverage is ${settlement.kind} (${settlement.coveredDimensions.length}/${PR_REVIEW_BASE_DIMENSION_IDS.length} dimensions covered; unresolved: ${derivedIds.join(', ') || '(none)'}); ${reason}`,
	);
}

/**
 * Read-only terminal-coverage projection for the completion report surface
 * (issue #2383). Pure derivation over the CURRENT state; returns null when no
 * active PR_REVIEW gate exists. The completion tool reads this BEFORE the
 * terminal clear so the response carries the truthful settlement summary.
 */
export async function readPrReviewTerminalCoverageForReport(
	directory: string,
	sessionID: string,
): Promise<{
	kind: PrReviewTerminalCoverageKind;
	coveredDimensions: PrReviewBaseDimensionId[];
	unresolvedDimensions: Array<{
		dimension: PrReviewBaseDimensionId;
		terminal_state: PrReviewUnresolvedDimensionRecord['terminalState'];
		reason_kind: PrReviewUnresolvedDimensionRecord['reasonKind'];
		failure_class?: BackgroundDelegationWorkflowLaneFailureClass;
	}>;
	liveDimensions: PrReviewBaseDimensionId[];
	allowedVerdicts: readonly PrReviewReportVerdict[];
} | null> {
	const state = await readPrWorkflowGateStateFromDisk(
		directory,
		normalizeSessionID(sessionID),
	);
	if (!state || state.mode !== 'PR_REVIEW' || !state.prHeadSha) return null;
	const ctx = await createPrReviewGateContext(directory, state);
	const settlement = derivePrReviewDimensionSettlement(
		directory,
		state,
		ctx.revisionDigest,
	);
	return {
		kind: settlement.kind,
		coveredDimensions: settlement.coveredDimensions,
		unresolvedDimensions: settlement.unresolvedDimensions.map((entry) => ({
			dimension: entry.dimension,
			terminal_state: entry.terminalState,
			reason_kind: entry.reasonKind,
			failure_class: entry.failureClass,
		})),
		liveDimensions: settlement.liveDimensions,
		allowedVerdicts: allowedPrReviewReportVerdicts(settlement.kind),
	};
}
