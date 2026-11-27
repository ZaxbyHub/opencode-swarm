/**
 * Trusted background-subagent completion observer.
 *
 * Terminal identity, coder settlement, workflow ingestion, and parent
 * notification are separate durable transitions. Replaying the same synthetic
 * event therefore resumes the first incomplete transition without re-running a
 * completed one.
 */

import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
// r14 audit repair (P0-2): side-effect-free read-back verifier for the
// context-map closeout effect (persistence.ts imports node builtins + types
// only — no cycle, no load cost).
import { loadContextMap } from '../context-map/persistence.js';
import { epicSentinelExists } from '../epic/lifecycle.js';
import { commitEpicResidueAfterDelegation } from '../epic/residue-commit.js';
import { completeBackgroundPhaseParticipation } from '../evidence/phase-participation.js';
import { transitionTaskWorkflowEvidence } from '../gate-evidence.js';
import {
	abortStandardWorktreeDispatch,
	awaitingMergeByCallID,
	cleanupStandardWorktreeForCallId,
	finishStandardWorktreeDispatch,
	type StandardWorktreeDispatch,
	standardWorktreeByCallID,
} from '../hooks/delegation-gate/worktree-isolation.js';
import { isInDeclaredScope } from '../hooks/guardrails/helpers.js';
import { forgetV2StepUsage } from '../host/v2/usage-bridge.js';
import {
	flushRouteRetirementObligation,
	retireRouteInvalidationsForCall,
} from '../review/route-invalidation-registry.js';
import {
	discardReviewerScopeGenerationClaim,
	discardReviewerScopeGenerationForCoderCall,
	recordPhaseAgentDispatch,
	swarmState,
} from '../state.js';
import { pushAdvisory } from '../utils/advisory-queue';
import { sameProjectRoot } from '../utils/canonical-root.js';
import * as logger from '../utils/logger.js';
import { withTimeout } from '../utils/timeout.js';
import { transferCoderSettlementToBackground } from '../workflow/coder-settlement.js';
import {
	GIT_OBJECT_ID_PATTERN,
	type MergeOperationProvenance,
} from '../worktree/merge.js';
import { validateSettlementLane } from '../worktree/settlement-source-recovery.js';
import {
	acknowledgeObservedBackgroundAdvisories,
	appendDelegationTransition,
	type BackgroundAdvisoryInboxEntry,
	type BackgroundDelegationRecord,
	type BackgroundDelegationResult,
	type BackgroundTerminalResult,
	type BackgroundWorkspaceSnapshot,
	type BackgroundWorktreeDescriptor,
	bindBackgroundCoderReservation,
	buildBackgroundCompletionEventId,
	claimCoderSettlement,
	claimDelegationIngestion,
	claimTerminalCloseoutStep,
	claimTerminalResult,
	clearLegacyCoderSettlementTransferPending,
	type DurableIngestionOutcome,
	findDelegationForCompletion,
	initializeTerminalCloseout,
	isIngestionRedriveExhausted,
	isTerminalCloseoutStepPending,
	LEGACY_CODER_SETTLEMENT_PENDING_ADVISORY_MARKER,
	type LegacyCoderSettlementTransfer,
	MAX_INGESTION_REDRIVE_ATTEMPTS,
	maintainBackgroundDelegations,
	markLegacyCoderSettlementTransferPending,
	markTerminalCloseoutStepCompleted,
	markTerminalCloseoutStepFailed,
	preparePendingBackgroundAdvisories,
	promoteDelegationFallback,
	putPendingBackgroundAdvisory,
	putTerminalCloseoutAdvisory,
	type ReplacePendingBackgroundAdvisoryResult,
	readDurableIngestionOutcome,
	recordDelegationIngestionResult,
	registerLegacyCoderSettlementReconciler,
	registerTerminalCloseoutReconciler,
	releaseBackgroundCoderReservation,
	releasePreparedBackgroundAdvisories,
	releaseTerminalCloseoutStepLease,
	replacePendingBackgroundAdvisory,
	type TerminalCloseoutStep,
	updateCoderSettlement,
} from './pending-delegations.js';
import {
	ingestBackgroundStageBCompletion,
	isBackgroundGateBearingRecord,
	validateStageBWorkspace,
} from './stage-b-gates.js';
import { parseTaskEnvelope } from './task-envelope.js';
import {
	captureWorkspaceSnapshot,
	changedFilesSinceSnapshot,
	resolveCurrentGitHead,
	resolveIsWorkingTreeCleanAsync,
} from './workspace-snapshot.js';

// r11: the shared plan-critic approval recorder pulls the plan-ledger module
// graph (ledger, manager). Resolving it lazily — memoized once, on the first
// plan-critic completion — keeps that graph off the observer's load path for
// every non-critic completion (and out of the module cache in co-run test
// processes where an early node:fs mock would otherwise capture it). A
// rejected import must not poison the memo: reset so the next critic
// completion retries instead of skipping approval forever.
let criticApprovalModulePromise: Promise<
	typeof import('../plan/critic-approval.js')
> | null = null;
function resolveCriticApprovalModule(): Promise<
	typeof import('../plan/critic-approval.js')
> {
	let modulePromise = criticApprovalModulePromise;
	if (modulePromise === null) {
		modulePromise = import('../plan/critic-approval.js').catch(
			(err: unknown) => {
				criticApprovalModulePromise = null;
				throw err;
			},
		);
		criticApprovalModulePromise = modulePromise;
	}
	return modulePromise;
}

// r12: the terminal-closeout collaborators (delegation-lifecycle telemetry,
// sounding-board policy, context map) are resolved lazily and memoized once —
// the same shape as resolveCriticApprovalModule above. Keeps their module
// graphs off the observer's load path for non-matching completions, and a
// rejected import never poisons the memo.
let delegationLifecycleModulePromise: Promise<
	typeof import('./delegation-lifecycle.js')
> | null = null;
function resolveDelegationLifecycleModule(): Promise<
	typeof import('./delegation-lifecycle.js')
> {
	let modulePromise = delegationLifecycleModulePromise;
	if (modulePromise === null) {
		modulePromise = import('./delegation-lifecycle.js').catch(
			(err: unknown) => {
				delegationLifecycleModulePromise = null;
				throw err;
			},
		);
		delegationLifecycleModulePromise = modulePromise;
	}
	return modulePromise;
}
let soundingBoardPolicyModulePromise: Promise<
	typeof import('../agents/sounding-board-policy.js')
> | null = null;
function resolveSoundingBoardPolicyModule(): Promise<
	typeof import('../agents/sounding-board-policy.js')
> {
	let modulePromise = soundingBoardPolicyModulePromise;
	if (modulePromise === null) {
		modulePromise = import('../agents/sounding-board-policy.js').catch(
			(err: unknown) => {
				soundingBoardPolicyModulePromise = null;
				throw err;
			},
		);
		soundingBoardPolicyModulePromise = modulePromise;
	}
	return modulePromise;
}
let contextMapModulePromise: Promise<
	typeof import('../context-map/post-agent-update.js')
> | null = null;
/**
 * r15 audit repair (P2): the read-back verifier must prove the CURRENT
 * change persisted, not merely that SOME entry for the task id exists.
 * `updateContextMapAfterAgent` swallows internal errors (save failures) and
 * returns a fallback map — a stale OLD entry would otherwise ack a NEW
 * completion whose write never landed.
 *
 * Accepted as proof that the obligation is durably established:
 * - the freshly read-back entry carries THIS completion's implementation
 *   summary (a fresh write, or an idempotent replay of an identical effect);
 *   when the whole-task release is already proven, the terminal
 *   'approved' (or evidence-merged 'rejected') status must be reflected too;
 * - OR (non-release path only) the entry holds a TERMINAL verdict: the r14
 *   (P1-5) non-overwrite guard deliberately preserves it against a pending
 *   child-level summary — the preserved verdict IS the intended state.
 * Anything else — a missing entry, an unchanged stale summary on a pending
 * entry, an unreadable map — is NOT proof (the caller reports retryable).
 *
 * r16 audit repair (P2): the terminal-verdict branch above acked even when
 * the CURRENT completion's write failed entirely — a suppressed
 * saveContextMap error left the preserved verdict as the only survivor while
 * this completion's DECISIONS (the fresh mandatory payload the non-overwrite
 * guard branch still owes) were lost. Decisions are therefore verified in
 * every branch: each of this completion's decision texts must be present in
 * the read-back map (exact-text presence — the writer's dedup semantics make
 * presence the idempotent-correct check). FILE SUMMARIES are deliberately
 * NOT verified: they are best-effort enrichment (refreshed from declared
 * files), and the closeout obligation does not depend on them — documented
 * weaker guarantee, kept separate from the task-status/decision release.
 */
function verifyContextMapWrite(
	directory: string,
	taskId: string,
	expected: {
		implementationSummary: string;
		releaseProven: boolean;
		decisionTexts: readonly string[];
	},
): boolean {
	try {
		const map = loadContextMap(directory);
		const entry = map?.task_history[taskId];
		if (entry === undefined) return false;
		// r16: this completion's decisions are mandatory closeout payload in
		// every branch (the writer persists them in the same save as the
		// task history; the non-overwrite-guard branch owes them as its only
		// fresh data). A missing decision text means the write did not land
		// (or was trimmed by the bounded log beyond this batch's own cap —
		// the caller bounds the expectation to the writer's cap).
		const presentDecisionTexts = new Set(
			(map?.decisions ?? []).map((decision) =>
				String(decision?.decision ?? '').trim(),
			),
		);
		if (
			!expected.decisionTexts.every((text) => presentDecisionTexts.has(text))
		) {
			return false;
		}
		if (
			entry.implementation_summary === expected.implementationSummary &&
			(!expected.releaseProven ||
				entry.final_status === 'approved' ||
				entry.final_status === 'rejected')
		) {
			return true;
		}
		if (!expected.releaseProven && entry.final_status !== 'pending') {
			// Terminal non-overwrite guard: a pending child-level summary
			// correctly left an existing terminal verdict in place — and the
			// decision check above proved this completion's fresh payload is
			// durably present.
			return true;
		}
		return false;
	} catch {
		return false;
	}
}
function resolveContextMapModule(): Promise<
	typeof import('../context-map/post-agent-update.js')
> {
	let modulePromise = contextMapModulePromise;
	if (modulePromise === null) {
		modulePromise = import('../context-map/post-agent-update.js').catch(
			(err: unknown) => {
				contextMapModulePromise = null;
				throw err;
			},
		);
		contextMapModulePromise = modulePromise;
	}
	return modulePromise;
}

interface ObserverConfig {
	enabled: boolean;
}

interface MaybeTextPart {
	type?: unknown;
	text?: unknown;
	synthetic?: unknown;
	sessionID?: unknown;
}

interface MaybeEvent {
	type?: unknown;
	properties?: { part?: unknown } & Record<string, unknown>;
}

interface TrustedTerminalReplay {
	record: BackgroundDelegationRecord;
	terminal: BackgroundTerminalResult;
	result: BackgroundDelegationResult;
	skipMaintenance?: boolean;
}

interface ObserverEventInput {
	event: unknown;
	trustedTerminal?: TrustedTerminalReplay;
}

export interface PreparedBackgroundAdvisories {
	preparationId: string;
	eventIds: string[];
	messages: string[];
}

type LegacyCoderSettlementTransferDisposition =
	| 'ok'
	| 'retry_pending'
	| 'manual_recovery';

const RETRYABLE_LEGACY_SETTLEMENT_TRANSFER_ERROR_CODES = new Set([
	'CODER_SETTLEMENT_LOCKED',
	'EACCES',
	'EBUSY',
	'EIO',
	'EPERM',
	'ETIMEDOUT',
]);

const observerInternals = {
	/** Epic v2 C3: sentinel probe gating the residue seam (one existsSync). */
	epicSentinelExists,
	/** Epic v2 C3 (X1): commit a background non-coder writer's residue. */
	commitEpicResidueAfterDelegation,
	transferCoderSettlementToBackground,
	markLegacyCoderSettlementTransferPending,
	updateCoderSettlement,
	/** Classification pin surface (#3564 r4): the settle-arm flush predicate. */
	isSettleCoderTerminalByFence,
	sleep: (milliseconds: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
};

/** Test-only dependency seam; production callers should use the observer API. */
export const _internals = observerInternals;

/**
 * r14 audit repair (P0-2): the explicit contract of a journal-gated closeout
 * effect. `void`/no-exception is NOT proof that the business obligation was
 * fulfilled — an effect must REPORT its durable outcome:
 *
 * - `persisted`           — the obligation was durably established now.
 * - `already_persisted`   — an idempotent effect found the obligation already
 *                           durably established (same success class).
 * - `retryable_error`     — the obligation was NOT established; a later
 *                           recovery pass may re-drive the step (it stays
 *                           pending in the journal).
 * - `permanent_failure`   — the obligation can provably never be established
 *                           (deterministic refusal, not an I/O error). The
 *                           step is durably marked failed in the journal —
 *                           the visible recovery record — instead of being
 *                           silently re-driven forever. Classification
 *                           requires PROOF of determinism; an unknown null
 *                           from a store is a retryable_error, never a
 *                           permanent_failure.
 *
 * WEAKER (best-effort) contract: the `delegation_end` telemetry step ACKs the
 * EMISSION ATTEMPT only — the telemetry sink swallows write failures by
 * design, so the journal proves the attempt and NOTHING about durable
 * delivery. No delivery guarantee is claimed for that step.
 */
export type CloseoutEffectResult =
	| { status: 'persisted' }
	| { status: 'already_persisted' }
	| { status: 'retryable_error'; reason: string }
	| { status: 'permanent_failure'; reason: string };

export function createBackgroundCompletionObserver(opts: {
	config: ObserverConfig;
	directory: string;
	onTerminalClaimed?: (record: BackgroundDelegationRecord) => void;
	recordIngestionResult?: typeof recordDelegationIngestionResult;
	/**
	 * r14 audit repair (P0-2): test seams for the journal-gated closeout
	 * machinery. Each performs the real work by default; tests inject
	 * controlled failures (null advisory stores, journal write failures) to
	 * prove the effect contract.
	 */
	initializeTerminalCloseoutImpl?: typeof initializeTerminalCloseout;
	markTerminalCloseoutStepCompletedImpl?: typeof markTerminalCloseoutStepCompleted;
	markTerminalCloseoutStepFailedImpl?: typeof markTerminalCloseoutStepFailed;
	putPendingBackgroundAdvisoryImpl?: typeof putPendingBackgroundAdvisory;
	putTerminalCloseoutAdvisoryImpl?: typeof putTerminalCloseoutAdvisory;
	/**
	 * r14 audit repair (P1-4): test seams for the closeout-step execution
	 * lease machinery (durable worker fencing).
	 */
	claimTerminalCloseoutStepImpl?: typeof claimTerminalCloseoutStep;
	releaseTerminalCloseoutStepLeaseImpl?: typeof releaseTerminalCloseoutStepLease;
	// Accepted from caller for API compatibility; reviewer receipt validation
	// is handled internally by the completion observer when enabled.
	reviewerReceiptOptions?: Record<string, unknown>;
	/**
	 * r12 (async lifecycle F2): context-map post-agent update configuration.
	 * Mirrors the sync Task handoff's config.context_map.enabled gate so the
	 * async completion writes the SAME context-map summary the sync transport
	 * writes — never more often.
	 */
	contextMap?: { enabled: boolean };
}): {
	event: (input: { event: unknown }) => Promise<void>;
	reconcilePending: (record: BackgroundDelegationRecord) => Promise<boolean>;
	notifyLegacyCoderSettlementAdvisoryReplaced: (
		record: BackgroundDelegationRecord,
		replacement: ReplacePendingBackgroundAdvisoryResult,
	) => void;
	prepareAdvisories: (
		parentSessionId: string,
	) => Promise<PreparedBackgroundAdvisories | null>;
	ackObservedAdvisories: (
		parentSessionId: string,
		observedTexts: readonly string[],
	) => Promise<number>;
	releaseAdvisories: (
		parentSessionId: string,
		prepared: PreparedBackgroundAdvisories,
	) => Promise<boolean>;
} {
	const { config, directory } = opts;
	let replayInProgress = false;
	// r13 audit repair (P0-3): correlation ids whose closeout this observer
	// instance is currently driving. The maintenance recovery pass must not
	// re-enter them from inside their own live processing (the nested call
	// would race the very steps the live pass is about to run).
	const inFlightCloseoutCorrelationIds = new Set<string>();
	/**
	 * The applicability set for one terminal: which closeout steps this
	 * record's role and outcome require. Everything else is never journaled,
	 * so recovery never re-drives a non-applicable step forever.
	 */
	const requiredCloseoutSteps = (
		record: BackgroundDelegationRecord,
		terminalStatus: string,
	): TerminalCloseoutStep[] => {
		if (record.batchId !== undefined) return []; // lanes settle elsewhere
		const steps: TerminalCloseoutStep[] = ['delegation_end', 'parent_advisory'];
		if (terminalStatus === 'completed') {
			const taskId = record.evidenceTaskId ?? record.planTaskId;
			if (opts.contextMap?.enabled === true && taskId) {
				steps.push('context_map');
			}
			if (record.normalizedAgent === 'critic_sounding_board') {
				steps.push('sounding_board');
			}
			if (
				[
					'reviewer',
					'test_engineer',
					'critic',
					'critic_sounding_board',
				].includes(record.normalizedAgent)
			) {
				steps.push('pipeline_advisory');
			}
			// Layer 23 (the 3.8 evening wedge): the ingestion-claim set gets
			// its own recoverable step — acked only when the ingestion commits
			// durably, pending otherwise so the r13 re-drive machinery replays
			// the trusted terminal and re-drives the ingestion at every
			// maintenance pass instead of stranding the round.
			if (
				record.normalizedAgent === 'coder' ||
				isBackgroundGateBearingRecord(record)
			) {
				steps.push('ingestion_commit');
			}
			// r14 audit repair (P0-3): the plan-critic approval snapshot is a
			// recoverable closeout step of its own — but ONLY for a
			// host-verified critic record whose dispatch carried the plan
			// binding (planCriticDispatch). A critic record without a provable
			// plan binding (legacy pre-binding records) never gets the step and
			// can never auto-approve.
			if (
				record.normalizedAgent === 'critic' &&
				record.planCriticDispatch !== undefined
			) {
				steps.push('plan_critic_approval');
			}
		}
		return steps;
	};
	// r14 audit repair (P0-2): seam-routed store calls so tests can inject
	// controlled failures (journal write failures, advisory store nulls).
	const initializeJournal =
		opts.initializeTerminalCloseoutImpl ?? initializeTerminalCloseout;
	const markStepCompleted =
		opts.markTerminalCloseoutStepCompletedImpl ??
		markTerminalCloseoutStepCompleted;
	const markStepFailed =
		opts.markTerminalCloseoutStepFailedImpl ?? markTerminalCloseoutStepFailed;
	const putAdvisory =
		opts.putPendingBackgroundAdvisoryImpl ?? putPendingBackgroundAdvisory;
	const putCloseoutAdvisory =
		opts.putTerminalCloseoutAdvisoryImpl ?? putTerminalCloseoutAdvisory;
	// r14 audit repair (P1-4): seam-routed closeout-step lease machinery.
	const claimStep =
		opts.claimTerminalCloseoutStepImpl ?? claimTerminalCloseoutStep;
	const releaseStepLease =
		opts.releaseTerminalCloseoutStepLeaseImpl ??
		releaseTerminalCloseoutStepLease;
	/**
	 * r14 audit repair (P1-4): this observer instance's durable identity for
	 * closeout-step execution leases (stable across the instance's lifetime,
	 * distinct per instance/process).
	 *
	 * r15 audit repair (P1): this id is the observer's IDENTITY only — it is
	 * deliberately NOT used as the lease claimant. Each runCloseoutStep
	 * ATTEMPT derives its own claimant id (`<observerId>:<random>`), because
	 * claimTerminalCloseoutStep treats an unexpired lease held by the SAME
	 * claimant as an idempotent re-claim returning the SAME token: reusing the
	 * instance id let two parallel events inside one observer both "own" the
	 * lease and double-execute the effect. Per-attempt claimants make the
	 * second parallel attempt hit the 'busy' fence instead.
	 */
	const closeoutObserverId = `bg-closeout-${cryptoRandomId()}`;
	/**
	 * r14 audit repair (P0-2): ack a closeout step and VERIFY the ack — a
	 * false return means the durable journal write failed (or, with a lease
	 * token, the ack was fenced out as stale); the step stays pending and
	 * recovery re-drives the (idempotent) effect. Never silent.
	 */
	const ackCloseoutStep = async (
		record: BackgroundDelegationRecord,
		terminalEventId: string,
		step: TerminalCloseoutStep,
		leaseToken?: string,
	): Promise<boolean> => {
		let acked = false;
		try {
			acked = await markStepCompleted(
				directory,
				record.correlationId,
				terminalEventId,
				step,
				leaseToken === undefined ? {} : { leaseToken },
			);
		} catch (error) {
			logger.warn(
				`[background] closeout step '${step}' ack failed for ${record.correlationId} (${terminalEventId}); the step stays pending and recovery re-drives the idempotent effect: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return false;
		}
		if (!acked) {
			logger.warn(
				`[background] closeout step '${step}' ack was refused for ${record.correlationId} (${terminalEventId}); the step stays pending and recovery re-drives the idempotent effect`,
			);
		}
		return acked;
	};
	const notifyLegacyCoderSettlementAdvisoryReplaced = (
		record: BackgroundDelegationRecord,
		replacement: ReplacePendingBackgroundAdvisoryResult,
	): void => {
		const session = swarmState.agentSessions.get(record.parentSessionId);
		if (!session) return;
		removeQueuedLegacyTransferAdvisory(
			session.pendingAdvisoryMessages,
			replacement.advisory.eventId,
		);
		if (replacement.replacedMessage) {
			removeQueuedAdvisoryMessage(session.pendingAdvisoryMessages, [
				replacement.replacedMessage,
			]);
		}
		pushAdvisory(session, replacement.advisory.message);
	};

	const event = async (
		input: ObserverEventInput,
	): Promise<undefined | false> => {
		if (!config.enabled) return;
		try {
			let pending: BackgroundDelegationRecord;
			let result: BackgroundDelegationResult;
			let terminal: BackgroundTerminalResult;
			let record: BackgroundDelegationRecord;
			let text: string;
			let isDuplicate = false;
			// r12: TRUE only when THIS invocation established the immutable
			// terminal event (claim disposition 'claimed'). `isDuplicate` covers
			// only the strict 'duplicate' disposition — a record in
			// ingestion_error replies 'retry_ingestion' and a replayed
			// trustedTerminal is pre-marked duplicate, so `!isDuplicate` is NOT
			// an exactly-once gate. Exactly-once-at-emit closeout side effects
			// (delegation_end telemetry, context map, sounding-board/pipeline
			// advisories) key on THIS flag instead.
			let isFreshTerminalClaim = false;
			if (input.trustedTerminal) {
				pending = input.trustedTerminal.record;
				result = input.trustedTerminal.result;
				terminal = input.trustedTerminal.terminal;
				text = result.error ?? result.text ?? '';
				record = pending;
				isDuplicate = true;
			} else {
				const evt = input?.event as MaybeEvent | undefined;
				if (!evt || evt.type !== 'message.part.updated') return;
				const part = evt.properties?.part as MaybeTextPart | undefined;
				if (
					!part ||
					part.type !== 'text' ||
					part.synthetic !== true ||
					typeof part.text !== 'string'
				) {
					return;
				}

				const envelope = parseTaskEnvelope(part.text);
				if (
					!envelope ||
					(envelope.state !== 'completed' &&
						envelope.state !== 'error' &&
						envelope.state !== 'cancelled')
				) {
					return;
				}
				const parentSessionId =
					typeof part.sessionID === 'string' ? part.sessionID : '';
				const lookup = await findDelegationForCompletion(
					directory,
					envelope.sessionId,
				);
				if (lookup?.source === 'uncertain') {
					// Issue #2511: an unreadable store is not proof of no owner.
					// Leave the source record UNCONSUMED (no ingestion-state
					// transition) — the record stays pending and visible in
					// /swarm status, and the next healthy completion event or
					// settlement reconciliation pass re-attempts this ingestion.
					logger.warn(
						`[background] deferring terminal ingestion: delegation store unreadable for ${envelope.sessionId} (${lookup.uncertain})`,
					);
					return;
				}
				if (!lookup) {
					logger.log(
						`[background] trusted completion for ${envelope.sessionId} has no durable primary or fallback owner; ignored`,
					);
					return;
				}
				if (
					!parentSessionId ||
					lookup.record.parentSessionId !== parentSessionId ||
					lookup.record.subagentSessionId !== envelope.sessionId
				) {
					logger.warn(
						`[background] trusted completion identity mismatch for ${envelope.sessionId}; ignored`,
					);
					return;
				}

				pending = lookup.record;
				if (lookup.source === 'fallback') {
					const promoted = await promoteDelegationFallback(
						directory,
						envelope.sessionId,
					);
					if (!promoted) {
						logger.warn(
							`[background] fallback promotion failed for ${envelope.sessionId}; terminal work remains preserved`,
						);
						// #3564: promotion failed — the fallback artifact stays
						// unpromoted (fallbacks are not swept), so this return would
						// otherwise leave a deferred marker with no remaining
						// retirement owner. Flush the exact obligation here.
						flushRouteRetirementObligation(
							directory,
							pending.parentSessionId,
							pending.callID,
						);
						return;
					}
					pending = promoted.record;
				}

				text =
					envelope.state === 'error' || envelope.state === 'cancelled'
						? (envelope.errorText ?? '')
						: (envelope.resultText ?? '');
				result = {
					...(envelope.state === 'error' ? { error: text } : { text }),
					chars: envelope.resultChars ?? text.length,
					truncated: envelope.resultTruncated ?? false,
					digest: digest(text),
				};
				terminal = {
					eventId: buildBackgroundCompletionEventId({
						correlationId: pending.correlationId,
						jobId: pending.jobId,
						status: envelope.state,
						resultDigest: result.digest,
					}),
					status: envelope.state,
					recordedAt: pending.terminalResult?.recordedAt ?? Date.now(),
					result,
				};
				const terminalClaim = await claimTerminalResult(
					directory,
					pending.correlationId,
					terminal,
				);
				if (!terminalClaim) {
					logger.warn(
						`[background] terminal claim failed for ${pending.correlationId}; ignored`,
					);
					return;
				}
				isDuplicate = terminalClaim.disposition === 'duplicate';
				isFreshTerminalClaim = terminalClaim.disposition === 'claimed';
				record = terminalClaim.record;
			}
			opts.onTerminalClaimed?.(record);

			// r13 audit repair (P0-3): initialize the durable closeout journal
			// for this terminal BEFORE any business effect runs. The immutable
			// terminal claim above proves the terminal; this journal separately
			// acks each closeout effect, so a crash between claim and effect is
			// recoverable instead of silently losing the effect. Idempotent: a
			// replay keeps existing step states.
			//
			// r14 audit repair (P0-2): the RESULT is checked. A false return
			// (journal could not be established — lock/IO failure, or a stale
			// writer whose terminal no longer matches) must not silently lead
			// to UNJOURNALED closeout effects: without the journal a crash
			// cannot re-drive the step, and a stale writer's acks are refused
			// forever (unbounded duplicate side effects). When initialization
			// fails, every journal-gated step below is DEFERRED to recovery —
			// hasPendingTerminalCloseout keeps the record in the recovery set
			// while the journal is missing or unfenced.
			const closeoutJournalReady = await initializeJournal(
				directory,
				record.correlationId,
				terminal.eventId,
				requiredCloseoutSteps(record, terminal.status),
			);
			if (!closeoutJournalReady) {
				logger.warn(
					`[background] terminal closeout journal could not be established for ${record.correlationId} (${terminal.eventId}); journal-gated closeout effects are deferred to recovery instead of running unjournaled`,
				);
			}
			/**
			 * Journal-gated closeout effect under the explicit r14 (P0-2)
			 * effect contract and the r14 (P1-4) durable step lease:
			 *
			 * 1. pending check on the journal (exact terminal event),
			 * 2. durable CAS claim of the step's execution lease (a live
			 *    foreign worker → busy skip; a stale worker → refused),
			 * 3. effect execution (idempotent, stable idempotency key),
			 * 4. durable result interpretation: persisted/already_persisted →
			 *    lease-fenced ACK; retryable → lease released, step pending;
			 *    permanent → lease-fenced durable failure mark.
			 *
			 * Guarantee class (documented): at-least-once EXECUTION with
			 * exactly-once ACK. Exactly-once execution against
			 * non-transactional sinks is impossible (a lease steal after a
			 * crash can re-run an effect the crashed worker already ran) —
			 * which is why every effect is required to be idempotent.
			 */
			const runCloseoutStep = async (
				target: BackgroundDelegationRecord,
				terminalEventId: string,
				step: TerminalCloseoutStep,
				effect: () => Promise<CloseoutEffectResult>,
			): Promise<boolean> => {
				if (!isTerminalCloseoutStepPending(target, terminalEventId, step)) {
					return false;
				}
				if (!closeoutJournalReady) {
					logger.warn(
						`[background] closeout journal is not established for ${target.correlationId} (${terminalEventId}); step '${step}' deferred to recovery instead of running unjournaled`,
					);
					return false;
				}
				// r14 (P1-4): durably claim the step's execution lease BEFORE
				// the effect runs — the ack is fenced on this token.
				// r15 (P1): the claimant id is unique per ATTEMPT. The store
				// idempotently re-claims an unexpired lease for the SAME
				// claimant (same token), which would let a parallel event in
				// this same observer double-execute the effect; a per-attempt
				// claimant is fenced out as 'busy' instead. Lease release and
				// expiry still make the step re-drivable after a failure.
				const claim = await claimStep(
					directory,
					target.correlationId,
					terminalEventId,
					step,
					{
						claimantId: `${closeoutObserverId}:${cryptoRandomId()}`,
					},
				);
				if (claim === null) {
					logger.warn(
						`[background] closeout step '${step}' lease claim failed for ${target.correlationId}; deferred to recovery`,
					);
					return false;
				}
				if (claim.disposition === 'busy') {
					// A live worker owns this step — it alone may run the effect
					// and ack. This instance skips (no duplicate ack race).
					logger.log(
						`[background] closeout step '${step}' for ${target.correlationId} is leased by another live worker; skipped`,
					);
					return false;
				}
				if (claim.disposition === 'closed') {
					return false;
				}
				if (claim.disposition === 'stale') {
					logger.warn(
						`[background] closeout step '${step}' claim for ${target.correlationId} was fenced out (stale terminal); skipped`,
					);
					return false;
				}
				const leaseToken = claim.leaseToken ?? '';
				let effectResult: CloseoutEffectResult;
				try {
					effectResult = await effect();
				} catch (error) {
					logger.warn(
						`[background] closeout step '${step}' failed for ${target.correlationId} (stays pending for recovery): ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
					await releaseStepLease(
						directory,
						target.correlationId,
						terminalEventId,
						step,
						leaseToken,
					);
					return false;
				}
				if (effectResult.status === 'retryable_error') {
					logger.warn(
						`[background] closeout step '${step}' effect for ${target.correlationId} not durably established (stays pending for recovery): ${effectResult.reason}`,
					);
					await releaseStepLease(
						directory,
						target.correlationId,
						terminalEventId,
						step,
						leaseToken,
					);
					return false;
				}
				if (effectResult.status === 'permanent_failure') {
					logger.error(
						`[background] closeout step '${step}' effect for ${target.correlationId} failed permanently: ${effectResult.reason}`,
					);
					const marked = await markStepFailed(
						directory,
						target.correlationId,
						terminalEventId,
						step,
						effectResult.reason,
						{ leaseToken },
					);
					if (!marked) {
						logger.warn(
							`[background] closeout step '${step}' failure state for ${target.correlationId} could not be persisted; the step stays pending as the conservative fallback`,
						);
					}
					return false;
				}
				// persisted | already_persisted: the obligation is durably
				// established — now ACK it (lease-fenced) and verify the ack.
				const acked = await ackCloseoutStep(
					target,
					terminalEventId,
					step,
					leaseToken,
				);
				if (!acked) {
					// The effect is durably established but THIS worker's ack
					// was refused or failed (journal write error / lease lost).
					// Release the lease so recovery can retry the idempotent
					// effect-and-ack immediately; a hard process crash (no
					// release possible) still recovers via lease expiry.
					await releaseStepLease(
						directory,
						target.correlationId,
						terminalEventId,
						step,
						leaseToken,
					);
				}
				return true;
			};

			// Maintenance point P2 (issue #2104): a trusted terminal (or the
			// ingestion rejection handled below) is exactly when orphaned
			// reservations and stale records become provably reclaimable. One
			// bounded, lock-limited pass; best-effort — the settlement paths
			// below must proceed regardless. The closeout recovery inside this
			// pass must not re-enter THIS record (it is in flight right here).
			if (!input.trustedTerminal?.skipMaintenance) {
				inFlightCloseoutCorrelationIds.add(record.correlationId);
				try {
					await maintainBackgroundDelegations(directory, {
						lockTimeoutMs: 1_000,
						reason: 'trusted-terminal',
						onLegacyCoderSettlementReconciled: reconcilePending,
						onLegacyCoderSettlementAdvisoryReplaced:
							notifyLegacyCoderSettlementAdvisoryReplaced,
						onTerminalCloseoutPending: async (pendingRecord) => {
							if (
								inFlightCloseoutCorrelationIds.has(pendingRecord.correlationId)
							) {
								return;
							}
							await reconcilePending(pendingRecord);
						},
					});
				} catch {
					// observation only; another maintenance point will finish
				} finally {
					inFlightCloseoutCorrelationIds.delete(record.correlationId);
				}
				// r15 audit repair (P3): recover context-map task-release
				// promotions lost to a best-effort promotion failure at
				// update_task_status. Idempotent, fail-closed on QA proof,
				// plan stays authoritative. Best-effort here too — the closeout
				// paths below proceed regardless.
				if (opts.contextMap?.enabled === true) {
					try {
						const { reconcileContextMapTaskReleases } =
							await resolveContextMapModule();
						await reconcileContextMapTaskReleases(directory);
					} catch {
						// observation only; the next maintenance point retries
					}
				}
			}

			// Native-async children never reach the synchronous Task consumer
			// (consumeAssistantUsageForTask in src/index.ts), so their usage-bridge
			// totals are released at every verified terminal, before the status
			// branch below: error and cancelled children can record usage too
			// (session.step.failed). Without this the bridge's per-process session
			// cap fills and refuses new sessions, starving sync cost attribution.
			forgetV2StepUsage(record.subagentSessionId);
			let legacyTransferPending = false;
			let legacyTransferRequiresManualRecovery = false;
			if (terminal.status !== 'completed') {
				// #3564: this arm owns the terminal cleanup of a claimed
				// error/cancelled/stale outcome — none of which ever reach the
				// consumption/retirement region below — so flush the call's
				// route-invalidation retirement obligation at arm entry, before
				// any early return (including the duplicate non-coder return).
				// Idempotent: no-op when no obligation exists.
				flushRouteRetirementObligation(
					directory,
					record.parentSessionId,
					record.callID,
				);
				// r12 (F4) + r13 repair (P0-3/P1-5): close the delegation_begin/
				// delegation_end pair for a FAILED/CANCELLED native-async Task
				// terminal. Exactly-once via the durable closeout journal (a
				// crash between claim and emission re-drives it on recovery),
				// NOT via the fresh-claim flag (a crash after the claim lost
				// the emission forever). Lane records are excluded: their
				// terminals settle through settleDelegationTerminal, which
				// already emits the pairing end.
				if (record.batchId === undefined) {
					await runCloseoutStep(
						record,
						terminal.eventId,
						'delegation_end',
						async () => {
							const { emitTaskDelegationTerminalEnd } =
								await resolveDelegationLifecycleModule();
							// r14 (P0-2) BEST-EFFORT contract: the telemetry sink
							// swallows write failures by design. The journal ACK
							// below proves the EMISSION ATTEMPT only — no durable
							// delivery guarantee is claimed for this step.
							emitTaskDelegationTerminalEnd(record, terminal.status);
							return { status: 'persisted' };
						},
					);
				}
				if (isDuplicate && record.normalizedAgent !== 'coder') {
					// Non-coder failure cleanup has no durable sub-transition to
					// resume. r13 repair (P0-3 special case): a crash between the
					// terminal claim and the parent advisory used to lose the
					// failure message FOREVER on the replay (this early return
					// skipped it). The journal-gated advisory below closes that
					// hole: only return early when the durable parent advisory
					// for this exact terminal is already acked. r14 (P0-2): the
					// advisory runs under the explicit effect contract — a null
					// store result leaves the step pending (recovery re-drives)
					// instead of acking a lost message.
					await runCloseoutStep(
						record,
						terminal.eventId,
						'parent_advisory',
						parentAdvisoryEffect(
							directory,
							record,
							terminal.eventId,
							terminal.status === 'cancelled' ? 'cancelled' : 'failed',
							putAdvisory,
						),
					);
					return;
				}
				if (record.normalizedAgent === 'coder') {
					const legacyTransfer = await transferLegacyCoderSettlement(
						directory,
						record,
					);
					if (legacyTransfer.disposition === 'retry_pending') {
						legacyTransferPending = true;
					} else if (legacyTransfer.disposition === 'manual_recovery') {
						legacyTransferRequiresManualRecovery = true;
					}
					if (record.planTaskId) {
						const expectedGeneration =
							record.taskChangeContext?.workflowGeneration;
						if (expectedGeneration === undefined) {
							logger.warn(
								`[background] failed coder ${record.correlationId} has no launch generation for task ${record.planTaskId}`,
							);
						} else {
							try {
								await transitionTaskWorkflowEvidence(
									directory,
									record.planTaskId,
									{
										type: 'dispatch_no_mutation',
										agentType: 'coder',
										expectedGeneration,
										transitionId: `background-coder-terminal:${terminal.eventId}`,
									},
								);
							} catch (error) {
								logger.warn(
									`[background] failed coder retry accounting was fenced for ${record.planTaskId}: ${error instanceof Error ? error.message : String(error)}`,
								);
							}
						}
					}
					try {
						await releaseCoderReservation(directory, record, 'recovered');
					} catch (error) {
						logger.warn(
							`[background] failed coder reservation cleanup will be retried by admission reconciliation: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
					if (record.worktree) {
						const descriptor = record.worktree;
						if (!standardWorktreeByCallID.has(record.callID)) {
							standardWorktreeByCallID.set(record.callID, {
								callID: descriptor.callID,
								parentSessionID: descriptor.parentSessionId,
								taskId: descriptor.taskId,
								...(descriptor.planTaskId
									? { planTaskId: descriptor.planTaskId }
									: {}),
								handle: {
									worktreePath: descriptor.worktreePath,
									branchName: descriptor.branchName,
									purpose: 'lane',
									id: descriptor.worktreeId,
									sessionId: descriptor.worktreeSessionId,
								},
								mergeStrategy: descriptor.mergeStrategy,
								laneIndex: descriptor.laneIndex,
								...(descriptor.worktreeDir
									? { worktree_dir: descriptor.worktreeDir }
									: {}),
							});
						}
						try {
							await abortStandardWorktreeDispatch(
								record.callID,
								'cancelled',
								directory,
							);
						} catch (error) {
							logger.warn(
								`[background] failed coder worktree cleanup preserved the lane for manual recovery: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
					}
				}
				discardScopeForRecord(record);
				// r13 repair (P0-3): journal-gated — a crash before this
				// publish must not permanently lose the failure advisory.
				// EXCEPTION: while a legacy coder settlement transfer is still
				// pending, the advisory text is NOT final — the step stays
				// un-acked so the transfer reconciler's replay re-publishes
				// the corrected (final) message and only then acks it.
				if (legacyTransferPending) {
					if (
						isTerminalCloseoutStepPending(
							record,
							terminal.eventId,
							'parent_advisory',
						)
					) {
						await publishAdvisory(
							directory,
							record,
							terminal.eventId,
							`${terminal.status === 'cancelled' ? 'cancelled' : 'failed'}; legacy coder settlement transfer is pending; durable reconciliation will retry`,
						);
					}
				} else {
					await runCloseoutStep(
						record,
						terminal.eventId,
						'parent_advisory',
						parentAdvisoryEffect(
							directory,
							record,
							terminal.eventId,
							legacyTransferRequiresManualRecovery
								? `${terminal.status === 'cancelled' ? 'cancelled' : 'failed'}; legacy coder settlement requires manual recovery; run /swarm recover for this task (or /swarm reset-session)`
								: terminal.status === 'cancelled'
									? 'cancelled'
									: 'failed',
							putAdvisory,
						),
					);
				}
				if (!legacyTransferPending) {
					await clearLegacyCoderSettlementTransferPending(
						directory,
						record.correlationId,
					);
				}
				return;
			}

			// r11 (async lifecycle F1): a verified plan-critic completion must record
			// its approval snapshot exactly like the synchronous Task transport does
			// (recordPlanCriticApprovalSnapshotIfApplicable in the delegation gate —
			// both call the SAME shared recorder in src/plan/critic-approval.ts). The
			// dispatch-time binding (record.planCriticDispatch) exists only when the
			// launch was classified at dispatch as a plan-critic review; its hash is
			// the plan the critic actually reviewed. Every negative case — non-critic
			// agent, no dispatch binding, non-APPROVED verdict, plan edited since the
			// dispatch, unreadable ledger — fails closed: no snapshot, the
			// critic_pre_plan gate stays blocked, and the audited manual escape hatch
			// (approve_plan_critic) remains the only alternative. The shared recorder
			// is replay-safe (ledger dedup by call id), so duplicate terminal delivery
			// and crash-recovery replays cannot approve twice.
			//
			// r14 audit repair (P0-3): the approval is now a JOURNALED closeout
			// step (plan_critic_approval). A transient failure (unreadable
			// ledger/plan.json, snapshot write failure) no longer log-and-loses a
			// legitimate APPROVED verdict — the step stays pending and recovery
			// re-drives the recorder, which re-applies EVERY authorization check
			// (verdict, plan binding, hash fence, ledger dedup) on each replay.
			// Terminal outcomes close the step: recorded / already recorded /
			// not_approved complete it (no approval required is NOT a retry), a
			// plan-hash conflict is a durable, visible final rejection
			// (permanent_failure), and the manual approve_plan_critic escape hatch
			// is never invoked automatically.
			if (record.normalizedAgent === 'critic' && record.planCriticDispatch) {
				const surfaceCriticApprovalIssue = (
					reason: string,
					permanent: boolean,
				): void => {
					logger.warn(
						`[background] plan critic approval not recorded for call ${record.callID}: ${reason}`,
					);
					const session = swarmState.agentSessions.get(record.parentSessionId);
					if (session) {
						pushAdvisory(
							session,
							`[PLAN CRITIC] The async critic returned APPROVED but no approval snapshot was recorded for call ${record.callID}: ${reason}. ` +
								(permanent
									? 'The plan changed since the critic dispatch — re-run the critic gate against the current plan.'
									: 'The approval step stays pending; durable recovery will retry. If it keeps failing, re-dispatch the critic, or record a manual approval via approve_plan_critic with a reason.'),
						);
					}
				};
				await runCloseoutStep(
					record,
					terminal.eventId,
					'plan_critic_approval',
					async (): Promise<CloseoutEffectResult> => {
						const { recordVerifiedPlanCriticApproval } =
							await resolveCriticApprovalModule();
						let recording: Awaited<
							ReturnType<typeof recordVerifiedPlanCriticApproval>
						>;
						try {
							recording = await recordVerifiedPlanCriticApproval(directory, {
								parentSessionId: record.parentSessionId,
								callId: record.callID,
								verdictText: result.text,
								// Audit P0-1 item 10: a truncated terminal text cannot prove
								// a final verdict — the VERDICT line may be cut off mid-token.
								verdictTruncated: result.truncated === true,
								dispatchPlanStructureHash:
									record.planCriticDispatch?.planStructureHash,
								// r14 (P1-6.2): bind the plan identity and the dispatch
								// prompt payload — the record's stored prompt snapshot
								// digest (sha256 over the FULL prompt) must match the
								// digest bound at dispatch; a mismatch or an
								// unobservable payload is a final refusal.
								dispatchPlanId: record.planCriticDispatch?.planId,
								dispatchPromptDigest:
									record.planCriticDispatch?.promptContentDigest ?? null,
								observedPromptDigest: record.prompt?.digest ?? null,
								transport: 'async_completion',
							});
						} catch (error) {
							// The recorder never throws in contract; an exception is
							// an unexpected fault — retryable, never a silent loss.
							return {
								status: 'retryable_error',
								reason: `plan critic approval recorder threw for call ${record.callID}: ${
									error instanceof Error ? error.message : String(error)
								}`,
							};
						}
						if (recording.outcome === 'recorded') {
							logger.log(
								`[background] plan critic approval snapshot recorded for call ${record.callID} (${terminal.eventId})`,
							);
							return { status: 'persisted' };
						}
						if (recording.outcome === 'not_approved') {
							// Finally no approval required (verdict not APPROVED /
							// truncated) — NOT a retry error. The step closes.
							logger.log(
								`[background] plan critic verdict for call ${record.callID} requires no approval snapshot: ${recording.reason}`,
							);
							return { status: 'persisted' };
						}
						if (recording.outcome === 'skipped') {
							if (recording.reasonCode === 'already_recorded') {
								// The identical approval is already durably stored.
								return { status: 'already_persisted' };
							}
							// reasonCode 'conflict': the plan hash changed since the
							// dispatch — a FINAL rejection, durably visible in the
							// journal as a failed step with its reason.
							surfaceCriticApprovalIssue(recording.reason, true);
							return {
								status: 'permanent_failure',
								reason: recording.reason,
							};
						}
						// outcome 'failed' (ledger_unreadable / plan.json not
						// readable / write_failed): transient — the step MUST stay
						// pending; recovery re-drives the recorder.
						surfaceCriticApprovalIssue(recording.reason, false);
						return {
							status: 'retryable_error',
							reason: `plan critic approval transiently failed for call ${record.callID}: ${recording.reason}`,
						};
					},
				);
			}
			// r12 (async lifecycle F2/F3/F4): the shared BUSINESS closeout for a
			// verified native-async completion — the terminal-record twin of the
			// synchronous Task handoff in src/index.ts. Everything here keys on the
			// durable record identity (parent/child/call/role/terminal event) that
			// was verified and claimed above.
			//
			// r13 audit repair (P0-3/P1-2/P1-5/P2-2): every closeout effect is
			// gated on the DURABLE CLOSEOUT JOURNAL (keyed by the exact terminal
			// event), not on the in-process fresh-claim flag — a crash between
			// the claim and an effect is re-driven by recovery instead of being
			// lost forever. The context-map success summary (F2) moved BELOW
			// coder settlement and Stage-B ingestion and now only records a
			// VERIFIED business success (audit P1-2: a child answering is not
			// the same as its work being accepted). The ledger-idempotent
			// knowledge receipt reconciliation still runs on replays too (crash
			// recovery), with the replay flag suppressing the audit-only
			// observation. LANE records (dispatch_lanes) are excluded: their
			// terminals are settled through settleDelegationTerminal, which
			// already emits the pairing delegation_end and reconciles knowledge
			// receipts — a second emission here would double-book the pair.
			if (record.batchId === undefined) {
				// F4: delegation_end pairing observation (cost axes unknown-honest;
				// the r8 usage bridge stays the usage authority — no double
				// billing). Journal-gated exactly-once (audit P1-5): a crash
				// after the claim no longer loses the pairing end.
				await runCloseoutStep(
					record,
					terminal.eventId,
					'delegation_end',
					async () => {
						const { emitTaskDelegationTerminalEnd } =
							await resolveDelegationLifecycleModule();
						// r14 (P0-2) BEST-EFFORT contract: the telemetry sink
						// swallows write failures by design. The journal ACK below
						// proves the EMISSION ATTEMPT only — no durable delivery
						// guarantee is claimed for this step.
						emitTaskDelegationTerminalEnd(record, terminal.status);
						return { status: 'persisted' };
					},
				);
				// F2 (r13 audit repair P1-2): the context-map success summary MOVED
				// below — it runs only after coder settlement and Stage-B ingestion
				// proved the business outcome, never on the bare child answer.
				// F3: sounding-board verdict — reuse the EXACT policy the sync handoff
				// applies (src/agents/sounding-board-policy.ts). Unparseable output is
				// treated conservatively (treat-as-REPHRASE warning), never approval.
				// r13 (P2-2): the advisory is DURABLE (closeout advisory list, deduped
				// by terminal event id) — it no longer depends on the parent session
				// being live in memory, and it cannot clobber the terminal advisory.
				if (record.normalizedAgent === 'critic_sounding_board') {
					await runCloseoutStep(
						record,
						terminal.eventId,
						'sounding_board',
						async () => {
							const { applySoundingBoardResponsePolicy } =
								await resolveSoundingBoardPolicyModule();
							const rawResponse = result.text ?? '';
							const session = swarmState.agentSessions.get(
								record.parentSessionId,
							);
							// r13 audit repair (P1-3): pass the SAME caller-owned
							// category metadata as the sync transport — the
							// validated category persisted at dispatch time,
							// bound to this exact call/child identity. Model free
							// text can never override it; a legacy record without
							// a persisted category falls back conservatively
							// (identical to a sync dispatch without a category).
							const callerArgs =
								record.soundingBoardCategory !== undefined
									? { category: record.soundingBoardCategory }
									: undefined;
							const parsed = applySoundingBoardResponsePolicy(
								rawResponse,
								callerArgs,
							);
							let verdictMsg: string;
							if (parsed) {
								verdictMsg = `[SOUNDING_BOARD] Verdict: ${parsed.verdict}. ${parsed.reasoning}`;
								if (parsed.category)
									verdictMsg += ` Category: ${parsed.category}`;
								if (parsed.improvedQuestion)
									verdictMsg += ` Rephrase to: ${parsed.improvedQuestion}`;
								if (parsed.answer) verdictMsg += ` Answer: ${parsed.answer}`;
								if (parsed.warning) verdictMsg += ` WARNING: ${parsed.warning}`;
							} else {
								verdictMsg =
									`[SOUNDING_BOARD] WARNING: Could not parse a structured verdict from ` +
									`critic_sounding_board response (${rawResponse.length} chars). ` +
									`Treat as REPHRASE — review the raw response before surfacing to user or escalating. ` +
									`Do not silently accept as resolved.`;
							}
							// Durable first: the step is only acked after the
							// advisory is durably established (r14 P0-2: a null
							// store result is a retryable error, not a silent
							// success). The in-memory push is the fast path for
							// a live session.
							const stored = await putCloseoutAdvisory(
								directory,
								record.correlationId,
								{
									eventId: `${terminal.eventId}:sounding-board`,
									parentSessionId: record.parentSessionId,
									message: verdictMsg,
								},
							);
							if (stored === null) {
								return {
									status: 'retryable_error',
									reason: `sounding-board advisory could not be durably established for ${record.correlationId}`,
								};
							}
							if (session) {
								pushAdvisory(session, stored.message);
								session.lastDelegationReason = 'critic_consultation';
							}
							return { status: 'persisted' };
						},
					);
				}
				// F3/F4 parity: pipeline continuation advisory — same roles and
				// message shape as the sync Task handoff, so the architect resumes
				// the QA gate pipeline after an async completion too. r13 (P2-2):
				// durable + deduped, independent of a live parent session.
				if (
					[
						'reviewer',
						'test_engineer',
						'critic',
						'critic_sounding_board',
					].includes(record.normalizedAgent)
				) {
					await runCloseoutStep(
						record,
						terminal.eventId,
						'pipeline_advisory',
						async () => {
							const message =
								`[PIPELINE] ${record.normalizedAgent} delegation complete for task ${
									record.evidenceTaskId ?? record.planTaskId ?? 'unknown'
								}. ` +
								`Resume the QA gate pipeline — check your task pipeline steps for the next required action. ` +
								`Do not stop here.`;
							const stored = await putCloseoutAdvisory(
								directory,
								record.correlationId,
								{
									eventId: `${terminal.eventId}:pipeline`,
									parentSessionId: record.parentSessionId,
									message,
								},
							);
							if (stored === null) {
								// r14 (P0-2): a null store result is a retryable
								// error — the step stays pending and recovery
								// re-drives the idempotent eventId-keyed put.
								return {
									status: 'retryable_error',
									reason: `pipeline advisory could not be durably established for ${record.correlationId}`,
								};
							}
							const session = swarmState.agentSessions.get(
								record.parentSessionId,
							);
							if (session) {
								pushAdvisory(session, stored.message);
							}
							return { status: 'persisted' };
						},
					);
				}
			}
			// F4: knowledge receipt reconciliation — ledger-idempotent, so it also
			// runs on duplicate/replay delivery (crash recovery); the replay flag
			// suppresses the audit-only unacknowledged observation. Lane records
			// are excluded for the same double-booking reason as above.
			if (result.text && record.batchId === undefined) {
				try {
					const { reconcileDelegationKnowledgeReceipts } =
						await resolveDelegationLifecycleModule();
					await reconcileDelegationKnowledgeReceipts(
						directory,
						record,
						result.text,
						// Replay = anything other than the claim that established
						// this terminal (strict duplicates AND retry_ingestion
						// redelivery).
						!isFreshTerminalClaim,
					);
				} catch (error) {
					// fail-open — reconciliation must never break the settle path
					logger.warn(
						`[background] knowledge receipt reconciliation failed for ${record.correlationId}: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}
			if (record.normalizedAgent === 'coder') {
				const settled = await settleCoder(directory, record, terminal.eventId);
				record = settled.record;
				if (!settled.ok) {
					// #3577 (PRR-003), outcome-aware (#3564 final-critic r3): flush
					// ONLY the settleCoder exits that are terminal-by-ingestion-
					// fence — see isSettleCoderTerminalByFence. Every other ok:false
					// exit ('settlement claim failed', 'settlement persistence
					// failed', 'durable reconciliation will retry', handoff/manual-
					// recovery outcomes) leaves the claim resumable or an explicit
					// replay scheduled, so the obligation is RETAINED for the later
					// delivery that will settle and consume it (#3509 replay
					// retention). Unknown outcomes retain (fail-safe: stranded
					// occupancy is inert; an early flush is the PRR-004 class).
					if (isSettleCoderTerminalByFence(settled.outcome)) {
						flushRouteRetirementObligation(
							directory,
							record.parentSessionId,
							record.callID,
						);
					}
					await publishAdvisory(
						directory,
						record,
						terminal.eventId,
						settled.outcome,
					);
					return false;
				}
				if (!settled.legacyTransferred) {
					const legacyTransfer = await transferLegacyCoderSettlement(
						directory,
						record,
					);
					if (legacyTransfer.disposition === 'retry_pending') {
						legacyTransferPending = true;
					} else if (legacyTransfer.disposition === 'manual_recovery') {
						legacyTransferRequiresManualRecovery = true;
					}
				}
			} else if (!isDuplicate && isBackgroundGateBearingRecord(record)) {
				// On a duplicate event the workspace was already validated
				// during first processing; skip re-validation to preserve scope.
				const freshness = validateStageBWorkspace(directory, record);
				if (freshness.stale) {
					// INTENTIONAL-EVENTLESS: post-claim terminal→terminal flip
					// (issue #2700 disposition) — the record already carries its
					// typed terminal event from the claim that opened this
					// processing; this Stage-B staleness transition establishes
					// no new first-terminal event.
					await appendDelegationTransition(directory, record.correlationId, {
						status: 'stale',
					});
					// #3577 (PRR-003): a 'stale' record is durably terminal —
					// claimDelegationIngestion refuses it and no replay can
					// re-drive it — so the call's route-invalidation marker can
					// never serve its replay-refusal purpose again. Flush the
					// retirement obligation instead of stranding marker + dead
					// occupancy (the #3509 replay-retention contract applies to
					// the FAILED-COMMIT arms below, which stay re-drivable; this
					// arm does not).
					flushRouteRetirementObligation(
						directory,
						record.parentSessionId,
						record.callID,
					);
					discardScopeForRecord(record);
					await publishAdvisory(directory, record, terminal.eventId, 'stale');
					return;
				}
			}

			if (
				record.normalizedAgent === 'coder' ||
				isBackgroundGateBearingRecord(record)
			) {
				if (isIngestionRedriveExhausted(record)) {
					// F-002: the bounded re-drive is spent (deterministic ingestion
					// failure). Give up VISIBLY: mark ingestion_commit failed
					// (r14 P0-2: terminally closed with a reason, so the record
					// drops out of the recovery set), close the same steps the
					// failed-apply arm below closes, and stop claiming — the record
					// then ages and the stale sweep regains authority over it.
					// Journal-gated: without a journal this pass the give-up is
					// deferred to recovery instead of forging a fragment journal.
					const exhaustedReason = `ingestion abandoned after ${MAX_INGESTION_REDRIVE_ATTEMPTS} failed attempts; re-dispatch the task if its result is still needed`;
					logger.warn(
						`[background] ingestion for ${record.correlationId} exhausted its re-drive budget; marking ingestion_commit failed`,
					);
					if (closeoutJournalReady) {
						await markStepFailed(
							directory,
							record.correlationId,
							terminal.eventId,
							'ingestion_commit',
							exhaustedReason,
						);
						await runCloseoutStep(
							record,
							terminal.eventId,
							'parent_advisory',
							parentAdvisoryEffect(
								directory,
								record,
								terminal.eventId,
								exhaustedReason,
								putAdvisory,
							),
						);
						await ackCloseoutStep(record, terminal.eventId, 'context_map');
					}
					return;
				}
				const ingestion = await claimDelegationIngestion(
					directory,
					record.correlationId,
					{ claimantId: terminal.eventId },
				);
				if (ingestion?.disposition === 'consumed') {
					// Layer 23: an earlier pass already committed this
					// ingestion durably (a crash between commit and ack
					// replays here) — ack the step so recovery stops
					// re-driving the record. r14 (P0-2) journal contract:
					// when the journal could not be established this pass,
					// EVERY journal-gated ack is deferred to recovery (the
					// re-drive re-initializes the journal and lands here
					// again); acking into a missing journal would forge a
					// fragment journal and drop the record from the
					// recovery set.
					if (closeoutJournalReady) {
						await markStepCompleted(
							directory,
							record.correlationId,
							terminal.eventId,
							'ingestion_commit',
						);
					}
				}
				if (
					ingestion?.disposition === 'claimed' ||
					ingestion?.disposition === 'retry'
				) {
					// 2026-11-25 swarm_communication_debug (restart-era agent-gate
					// wedge, layer A): the store's result projection can be
					// BODY-LESS — the checkpoint fold strips the text/error bodies
					// from closed summaries, and a trustedTerminal replay or a
					// duplicate claim can surface that body-less shape even for a
					// LIVE record (observed live: a coordination row with
					// result={chars,digest,truncated} and NO text one second after
					// a text-bearing terminal claim). Preferring that body-less
					// record.result over THIS event's result silenced every Stage-B
					// verdict: structuredStageBVerdict got '' for the text, matched
					// nothing, and the ingestion rotated stage_b_failed + rejected
					// — the exact "dispatches fire, receipts never land" pattern
					// since the 2.3-native-async era began. The event result is the
					// authority here: it is parsed from the host-rendered subagent
					// envelope on THIS invocation (full wrapper text, bounded).
					// Fall back to it whenever the persisted result has no body at
					// all; keep the record's copy only when it carries text/error
					// (replay paths where no event result exists).
					const recordResult = ingestion.record.result;
					const recordResultHasBody =
						recordResult !== undefined &&
						((recordResult.text ?? '') !== '' ||
							(recordResult.error ?? '') !== '');
					const applied = await ingestBackgroundStageBCompletion({
						directory,
						record: ingestion.record,
						result: recordResultHasBody && recordResult ? recordResult : result,
						reviewerReceiptOptions: opts.reviewerReceiptOptions as
							| import('../hooks/review-receipt-collector.js').ReviewerReceiptValidationOptions
							| undefined,
					});
					const claimToken = ingestion.record.ingestion?.claimToken;
					if (!claimToken) {
						await publishAdvisory(
							directory,
							record,
							terminal.eventId,
							'ingestion claim token missing',
						);
						return;
					}
					// r14 audit repair (P0-1): derive the semantic outcome of this
					// ingestion and commit it ATOMICALLY with the consumed flip.
					// `applied.ok || applied.consumed` remains the commit condition
					// (a terminal-negative drop is durably consumed too), but the
					// OUTCOME is what a replay routes on — never `consumed` alone.
					const ingestionOutcome: DurableIngestionOutcome | undefined =
						applied.ok
							? 'accepted'
							: applied.consumed
								? applied.skipped
									? 'skipped'
									: applied.stale
										? 'stale'
										: 'rejected'
								: undefined;
					const ingestionCommit = await (
						opts.recordIngestionResult ?? recordDelegationIngestionResult
					)(
						directory,
						record.correlationId,
						claimToken,
						// #3509 (round-5 observer fix): commit CONSUMED for both
						// successful outcomes AND terminal-negative drops
						// (ok:false, consumed:true — invalidated/blocked route,
						// rejected/skipped verdicts). Committing success on
						// applied.ok ALONE mapped terminal drops to
						// ingestion_error/retryable, which would retry the
						// refused completion forever and retain its route
						// invalidation marker forever. Only !ok && !consumed
						// remains retryable. An ok:true, consumed:false
						// successful no-task completion still durably consumes
						// per its own contract (stage-b-gates no-task return).
						applied.ok || applied.consumed,
						{ outcome: ingestionOutcome },
					);
					if (!ingestionCommit) {
						logger.warn(
							`[background] ingestion claim for ${record.correlationId} expired or was fenced before commit; retry remains pending`,
						);
						return;
					}
					if (
						(applied.ok || applied.consumed) &&
						(ingestionCommit.status !== 'consumed' ||
							ingestionCommit.ingestion?.state !== 'consumed' ||
							ingestionCommit.ingestion.claimToken !== claimToken)
					) {
						logger.warn(
							`[background] ingestion commit for ${record.correlationId} did not confirm the exact consumed claim; retry remains pending`,
						);
						return;
					}
					record = ingestionCommit;
					record =
						(await findDelegationForCompletion(directory, record.correlationId))
							?.record ?? record;
					if (applied.ok || applied.consumed) {
						// Layer 23: the ingestion committed durably (success or a
						// terminal-negative outcome) — ack the step so recovery
						// stops re-driving this record. Every failure arm above
						// (null commit, unconfirmed claim, retryable commit)
						// returns WITHOUT acking: the step stays pending and the
						// next maintenance pass replays the trusted terminal.
						// r14 (P0-2): the ack is journal-gated — a pass whose
						// journal initialization failed defers it to recovery
						// instead of forging a fragment journal.
						if (closeoutJournalReady) {
							await markStepCompleted(
								directory,
								record.correlationId,
								terminal.eventId,
								'ingestion_commit',
							);
						}
						// #3509: the ONLY background retirement owner — the
						// durable commit has CONFIRMED the consumed outcome
						// (successful or terminal-negative), so the call-scoped
						// route invalidation marker's work is done. Failed/null
						// commits and retryable ingestion_error outcomes RETAIN
						// the marker (a replay refuses again).
						retireRouteInvalidationsForCall(
							directory,
							record.parentSessionId,
							record.callID,
						);
					}
					if (!applied.ok) {
						// r13 (P0-3): journal-gated; a pending legacy transfer keeps
						// the step un-acked (not-final message, corrected by the
						// transfer reconciler's replay).
						const outcomeMessage = applied.skipped
							? 'skipped (tests not run) — re-dispatch the test gate; reviewer proof preserved; task remains Stage B eligible'
							: legacyTransferPending
								? 'ingestion failed; legacy coder settlement transfer is pending; durable reconciliation will retry'
								: legacyTransferRequiresManualRecovery
									? 'ingestion failed; legacy coder settlement requires manual recovery; run /swarm recover for this task (or /swarm reset-session)'
									: applied.stale
										? 'stale'
										: 'ingestion failed';
						if (legacyTransferPending) {
							if (
								isTerminalCloseoutStepPending(
									record,
									terminal.eventId,
									'parent_advisory',
								)
							) {
								await publishAdvisory(
									directory,
									record,
									terminal.eventId,
									outcomeMessage,
								);
							}
						} else {
							await runCloseoutStep(
								record,
								terminal.eventId,
								'parent_advisory',
								parentAdvisoryEffect(
									directory,
									record,
									terminal.eventId,
									outcomeMessage,
									putAdvisory,
								),
							);
						}
						// r13 (P1-2): the ingestion outcome is terminally negative
						// (rejected/skipped/stale verdict, durably consumed) — this task
						// will NEVER reach business success, so no context-map success
						// summary may ever be written for it. Ack the context_map step
						// as closed so recovery does not re-drive a success write for a
						// rejected outcome forever. r14 (P0-2): the ack is verified —
						// a failed journal write leaves the step pending (recovery
						// re-drives the ack; it is itself idempotent).
						if (applied.consumed) {
							await ackCloseoutStep(record, terminal.eventId, 'context_map');
						}
						// Maintenance point P2b (issue #2104): the ingestion
						// rejection has just been durably recorded — reconcile now
						// so the rejected record and any orphaned reservation are
						// handled at this listed point, not only at the next one.
						inFlightCloseoutCorrelationIds.add(record.correlationId);
						try {
							await maintainBackgroundDelegations(directory, {
								lockTimeoutMs: 1_000,
								reason: 'ingestion-rejection',
								skipLegacyCoderSettlementReconciliation: legacyTransferPending,
								onLegacyCoderSettlementAdvisoryReplaced:
									notifyLegacyCoderSettlementAdvisoryReplaced,
								onTerminalCloseoutPending: async (pendingRecord) => {
									if (
										inFlightCloseoutCorrelationIds.has(
											pendingRecord.correlationId,
										)
									) {
										return;
									}
									await reconcilePending(pendingRecord);
								},
							});
						} catch {
							// observation only; the facts ring records it
						} finally {
							inFlightCloseoutCorrelationIds.delete(record.correlationId);
						}
						return;
					}
				} else if (ingestion?.disposition === 'busy') {
					// Another live observer owns the bounded ingestion lease. It alone
					// may publish terminal success after committing the workflow update.
					return;
				} else if (ingestion?.disposition !== 'consumed') {
					await publishAdvisory(
						directory,
						record,
						terminal.eventId,
						'ingestion pending',
					);
					return;
				} else {
					// r14 audit repair (P0-1): this is a REPLAY of an already
					// durably-consumed ingestion (crash between the ingestion commit
					// and the context-map/parent-advisory closeout, or a duplicate
					// host delivery). `consumed` alone is NOT proof of success —
					// the semantic outcome stored atomically with the consumed
					// commit decides the route. A legacy record without a provable
					// outcome is fail-closed: it must never reach the success
					// context-map closeout below.
					record = ingestion.record;
					const persistedOutcome = readDurableIngestionOutcome(record);
					// The live path retires the call's route-invalidation marker
					// right after a durably confirmed commit (success OR
					// terminal-negative). A crash in that window leaves the marker
					// stranded; retiring here too is idempotent and closes it.
					retireRouteInvalidationsForCall(
						directory,
						record.parentSessionId,
						record.callID,
					);
					if (persistedOutcome.kind !== 'accepted') {
						const outcomeMessage =
							persistedOutcome.kind === 'unverifiable'
								? 'ingestion consumed without a provable semantic outcome (legacy record); fail-closed — not treated as success'
								: persistedOutcome.kind === 'skipped'
									? 'skipped (durable semantic outcome preserved across replay) — re-dispatch the test gate; task remains Stage B eligible'
									: persistedOutcome.kind === 'stale'
										? 'stale (durable semantic outcome preserved across replay)'
										: 'rejected (durable semantic outcome preserved across replay)';
						await runCloseoutStep(
							record,
							terminal.eventId,
							'parent_advisory',
							parentAdvisoryEffect(
								directory,
								record,
								terminal.eventId,
								outcomeMessage,
								putAdvisory,
							),
						);
						// Mirror the live negative path (r13 P1-2): the durable
						// outcome is terminally negative — no success context-map
						// summary may EVER be written for this record. Ack the
						// context_map step as closed so recovery does not re-drive
						// a success write for a negative outcome forever. r14
						// (P0-2): the ack is verified (a failed journal write
						// leaves the step pending; the ack is idempotent).
						await ackCloseoutStep(record, terminal.eventId, 'context_map');
						return;
					}
					// persistedOutcome.kind === 'accepted': the verified success
					// replay continues into the shared success closeout below.
				}
			}

			if (record.normalizedAgent === 'docs') {
				try {
					const recorded = await completeBackgroundPhaseParticipation({
						directory,
						record,
						resultText: text,
					});
					if (!recorded) {
						logger.warn(
							`[background] docs completion ${record.correlationId} did not satisfy its durable phase-participation binding`,
						);
					}
				} catch (error) {
					logger.warn(
						`[background] docs completion ${record.correlationId} could not persist phase participation: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}

			// Foreground Task dispatches register the dispatched role on the
			// child session through the delegation tracker (chat.message); a
			// background child never flows through those hooks, so the
			// in-memory phase-aggregation surface stayed empty and phase_complete
			// reported REQUIRED_AGENTS_MISSING with agentsDispatched: [] even
			// though the role demonstrably ran and its gate receipts landed (the
			// 2026-11-23 swarm_communication_debug pattern). Record the completed
			// role on the dispatching parent session — the same surface
			// recordPhaseAgentDispatch writes for foreground dispatches. This is
			// the live-process surface only; durable cross-restart coverage for
			// coder/reviewer/test_engineer stays with the per-task gate evidence
			// (the phase_complete task-gate inference) and for docs with the
			// durable participation store above. No-op when the parent session is
			// not live in memory (post-restart replay); idempotent by set
			// semantics on replay.
			recordPhaseAgentDispatch(
				record.parentSessionId,
				record.swarmPrefixedAgent,
			);

			// Epic v2 C3 (X1) seam: a background non-coder writer that served
			// a task of the open epic has its attributed main-tree writes
			// committed on the epic branch (the foreground twin lives in the
			// delegation gate's Task after-hook). Gated synchronously: with no
			// open epic it is one existsSync and no extra await. Never throws.
			if (
				record.normalizedAgent !== 'coder' &&
				observerInternals.epicSentinelExists(directory)
			) {
				await observerInternals.commitEpicResidueAfterDelegation({
					directory,
					agent: record.normalizedAgent,
					sessionID: record.parentSessionId,
					resolveTaskIds: async () => {
						const taskId = record.planTaskId ?? record.evidenceTaskId;
						return taskId ? [taskId] : [];
					},
					childSessionIds: async () => [record.subagentSessionId],
				});
			}

			// After successful ingestion, discard the reviewer scope claim
			// so the claimed scope generation is consumed.
			if (record.normalizedAgent === 'reviewer') {
				discardScopeForRecord(record);
			}

			if (record.normalizedAgent === 'coder') {
				await releaseCoderReservation(directory, record, 'consumed');
				if (!legacyTransferPending) {
					await clearLegacyCoderSettlementTransferPending(
						directory,
						record.correlationId,
					);
				}
			}

			// r13 audit repair (P1-2): the context-map success summary now runs
			// HERE — after coder settlement, worktree merge-back, and Stage-B
			// ingestion all proved the business outcome. A child that merely
			// ANSWERED never reaches this point on a negative path (its flow
			// returned above), so a rejected reviewer verdict, a failed
			// test-engineer run, a failed settlement, or a retryable ingestion
			// can never appear as 'approved'. Journal-gated (P0-3): a crash
			// between settlement and this write is re-driven by recovery; the
			// write itself is idempotent (task_history is keyed by task id).
			if (opts.contextMap?.enabled === true && record.batchId === undefined) {
				const closeoutTaskId = record.evidenceTaskId ?? record.planTaskId;
				if (closeoutTaskId) {
					await runCloseoutStep(
						record,
						terminal.eventId,
						'context_map',
						async () => {
							const {
								extractContextDecisionsFromContextMd,
								updateContextMapAfterAgentLocked,
								resolveContextMapTaskReleaseStatus,
								MAX_PERSISTED_DECISIONS,
							} = await resolveContextMapModule();
							// r14 audit repair (P1-5): a single successful child
							// ingestion is NOT a full task release. The summary only
							// maps to 'approved' when the AUTHORITATIVE task status
							// and every required QA gate prove the release; until
							// then the entry stays non-final ('pending') and the
							// authoritative promotion happens at update_task_status
							// (promoteContextMapTaskRelease).
							const taskReleaseStatus =
								await resolveContextMapTaskReleaseStatus(
									directory,
									closeoutTaskId,
								);
							// r16 (P2): extract this completion's decisions ONCE —
							// they are mandatory closeout payload and the read-back
							// verifier must prove they persisted, not just the
							// task-status effect. The expectation mirrors the
							// writer's own filter (empty-text bullets carry no
							// identity) and is bounded to the writer's persisted-
							// decisions cap so a pathological >cap batch cannot
							// wedge the step in an endless retry.
							const decisions = extractContextDecisionsFromContextMd(
								directory,
								{
									agent_role: record.normalizedAgent,
								},
							);
							const expectedDecisionTexts = decisions
								.map((entry) => (entry.decision ?? '').trim())
								.filter((text) => text !== '')
								.slice(-MAX_PERSISTED_DECISIONS);
							// r16 (P2): the COORDINATED write — the whole
							// load→update→save cycle runs under the cross-process
							// context-map lock (awaited so the read-back verification
							// below observes the completed write).
							// r16 (P2): the COORDINATED write — the whole
							// load→update→save cycle runs under the cross-process
							// context-map lock (awaited so the read-back verification
							// below observes the completed write).
							await updateContextMapAfterAgentLocked({
								task_id: closeoutTaskId,
								agent_role: record.normalizedAgent,
								// Best-effort reconstruction from the original
								// delegation (P1-2): the coder's declared files
								// when present, else no attribution.
								files_touched: record.taskChangeContext?.declaredFiles ?? [],
								implementation_summary: (result.text ?? '').slice(0, 500),
								task_goal: '',
								// Only the PROVEN whole-task release maps to 'completed';
								// a child-level success is 'in_progress' (the non-final
								// 'pending' context-map status).
								final_status: taskReleaseStatus,
								decisions,
								directory,
							});
							// r14 audit repair (P0-2): `void` (no exception) is
							// NOT proof — updateContextMapAfterAgent swallows
							// internal errors and returns a fallback map. Verify
							// the CURRENT change persisted by reading it back
							// and comparing THIS completion's summary (r15 P2:
							// an old stale entry must not ack a new completion;
							// r16 P2: this completion's decisions must be present
							// in every branch — a preserved terminal verdict alone
							// must not ack a write that lost them).
							if (
								!verifyContextMapWrite(directory, closeoutTaskId, {
									implementationSummary: (result.text ?? '').slice(0, 500),
									releaseProven: taskReleaseStatus === 'completed',
									decisionTexts: expectedDecisionTexts,
								})
							) {
								return {
									status: 'retryable_error',
									reason: `context-map summary for task ${closeoutTaskId} did not persist (read-back mismatch)`,
								};
							}
							return { status: 'persisted' };
						},
					);
				}
			}

			// r13 repair (P0-3): journal-gated terminal advisory — a crash
			// before this publish is re-driven instead of lost. A pending
			// legacy transfer keeps the step un-acked (the message is not
			// final until the transfer reconciler's replay publishes the
			// corrected outcome).
			if (legacyTransferPending) {
				if (
					isTerminalCloseoutStepPending(
						record,
						terminal.eventId,
						'parent_advisory',
					)
				) {
					await publishAdvisory(
						directory,
						record,
						terminal.eventId,
						record.normalizedAgent === 'coder'
							? 'completed and settled; legacy coder settlement transfer is pending; durable reconciliation will retry'
							: 'completed',
					);
				}
			} else {
				await runCloseoutStep(
					record,
					terminal.eventId,
					'parent_advisory',
					parentAdvisoryEffect(
						directory,
						record,
						terminal.eventId,
						record.normalizedAgent === 'coder'
							? legacyTransferRequiresManualRecovery
								? 'completed and settled; legacy coder settlement requires manual recovery; run /swarm recover for this task (or /swarm reset-session)'
								: 'completed and settled'
							: 'completed',
						putAdvisory,
					),
				);
			}
			logger.log(
				`[background] trusted completion settled: agent=${record.normalizedAgent} task=${taskLabel(record)} parent=${record.parentSessionId}`,
			);
		} catch (err) {
			logger.warn(
				`[background] completion observer error: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
	};

	const reconcilePending = async (
		record: BackgroundDelegationRecord,
	): Promise<boolean> => {
		if (replayInProgress) return false;
		const terminal = record.terminalResult;
		if (!terminal) return false;
		replayInProgress = true;
		try {
			const completion = await event({
				event: undefined,
				trustedTerminal: {
					record,
					terminal,
					result: terminal.result,
					skipMaintenance: true,
				},
			});
			if (completion === false) return false;
			const refreshed = await findDelegationForCompletion(
				directory,
				record.subagentSessionId,
			);
			// Issue #2511: an uncertain or unreadable re-read is "not yet
			// provably consumed" — the replay stays pending and a later healthy
			// pass re-checks, so this reports false rather than guessing.
			return refreshed?.record ? refreshed.record.status === 'consumed' : false;
		} finally {
			replayInProgress = false;
		}
	};

	if (config.enabled) {
		registerLegacyCoderSettlementReconciler(directory, reconcilePending);
		// r13 audit repair (P0-3): register the terminal-closeout reconciler so
		// maintenance passes (admission, status, background-maintenance) re-drive
		// crashed closeouts WITHOUT depending on a new host completion event.
		// The in-flight guard prevents re-entering a record this observer is
		// currently processing live.
		registerTerminalCloseoutReconciler(directory, async (pendingRecord) => {
			if (inFlightCloseoutCorrelationIds.has(pendingRecord.correlationId)) {
				return;
			}
			await reconcilePending(pendingRecord);
		});
	}

	const prepareAdvisories = async (
		parentSessionId: string,
	): Promise<PreparedBackgroundAdvisories | null> => {
		if (!config.enabled || !parentSessionId) return null;
		const preparationId = `bg-prepare:${cryptoRandomId()}`;
		const entries = await preparePendingBackgroundAdvisories(
			directory,
			parentSessionId,
			{ preparationId },
		);
		return entries.length === 0
			? null
			: {
					preparationId,
					eventIds: entries.map((entry) => entry.eventId),
					messages: entries.map((entry) => entry.message),
				};
	};

	return {
		event: async (input) => {
			await event(input);
		},
		reconcilePending,
		notifyLegacyCoderSettlementAdvisoryReplaced,
		prepareAdvisories,
		ackObservedAdvisories: (parentSessionId, observedTexts) =>
			acknowledgeObservedBackgroundAdvisories(
				directory,
				parentSessionId,
				observedTexts,
			),
		releaseAdvisories: (parentSessionId, prepared) =>
			releasePreparedBackgroundAdvisories(
				directory,
				parentSessionId,
				prepared.preparationId,
				prepared.eventIds,
			),
	};
}

async function transferLegacyCoderSettlement(
	directory: string,
	record: BackgroundDelegationRecord,
): Promise<{
	disposition: LegacyCoderSettlementTransferDisposition;
	outcome: string;
}> {
	if (!record.planTaskId) {
		return { disposition: 'ok', outcome: 'no task-scoped legacy settlement' };
	}
	const transfer: LegacyCoderSettlementTransfer = {
		taskId: record.planTaskId,
		transitionId: `coder:${record.callID}`,
	};
	let detail = 'unknown transfer failure';
	let lastErrorCode: string | null = null;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			const outcome =
				await observerInternals.transferCoderSettlementToBackground({
					directory,
					taskId: transfer.taskId,
					transitionId: transfer.transitionId,
				});
			return { disposition: 'ok', outcome };
		} catch (error) {
			lastErrorCode = errorCode(error);
			detail = error instanceof Error ? error.message : String(error);
			if (attempt === 2 || !isRetryableLegacyTransferErrorCode(lastErrorCode)) {
				break;
			}
			await observerInternals.sleep(50 * (attempt + 1));
		}
	}
	logger.warn(
		`[background] legacy coder settlement transfer failed for ${record.planTaskId}: ${detail}`,
	);
	if (!isRetryableLegacyTransferErrorCode(lastErrorCode)) {
		return {
			disposition: 'manual_recovery',
			outcome:
				'legacy coder settlement requires manual recovery; run /swarm recover for this task (or /swarm reset-session)',
		};
	}
	if (await persistLegacyTransferMarker(directory, record, transfer)) {
		return {
			disposition: 'retry_pending',
			outcome:
				'legacy coder settlement transfer is pending; retrying durable reconciliation',
		};
	}
	return {
		disposition: 'manual_recovery',
		outcome:
			'legacy coder settlement requires manual recovery; run /swarm recover for this task (or /swarm reset-session)',
	};
}

async function persistLegacyTransferMarker(
	directory: string,
	record: BackgroundDelegationRecord,
	transfer: LegacyCoderSettlementTransfer,
	validate?: (pending: BackgroundDelegationRecord) => boolean,
): Promise<boolean> {
	if (!validate && hasExactPendingLegacyTransfer(record, transfer)) return true;
	let pending: BackgroundDelegationRecord | null = null;
	for (let markerAttempt = 0; markerAttempt < 3; markerAttempt += 1) {
		try {
			pending =
				await observerInternals.markLegacyCoderSettlementTransferPending(
					directory,
					record.correlationId,
					transfer,
				);
		} catch {
			pending = null;
		}
		if (
			hasExactPendingLegacyTransfer(pending, transfer) &&
			pending &&
			(!validate || validate(pending))
		)
			break;
		if (markerAttempt < 2) {
			await observerInternals.sleep(50 * (markerAttempt + 1));
		}
	}
	return (
		hasExactPendingLegacyTransfer(pending, transfer) &&
		!!pending &&
		(!validate || validate(pending))
	);
}

async function releaseCoderReservation(
	directory: string,
	record: BackgroundDelegationRecord,
	reason: 'consumed' | 'recovered',
): Promise<void> {
	if (!record.coderReservationId) return;
	// Deliberately no `generation` here: binding from a late terminal must not
	// move the reservation's generation (issue #2104).
	const bound = await bindBackgroundCoderReservation(directory, {
		reservationId: record.coderReservationId,
		parentSessionId: record.parentSessionId,
		planTaskId: record.planTaskId,
		callID: record.callID,
		correlationId: record.correlationId,
	});
	if (!bound) {
		logger.warn(
			`[background] coder reservation ${record.coderReservationId} could not be bound for ${record.correlationId}; admission remains fail-closed`,
		);
		return;
	}
	const released = await releaseBackgroundCoderReservation(directory, {
		...bound,
		// The TERMINAL's generation decides: if the reservation has moved on to
		// a newer launch generation, this stale terminal must not release it.
		generation: record.generation ?? 1,
		reason,
	});
	if (!released) {
		logger.warn(
			`[background] coder reservation ${record.coderReservationId} could not be released after ${reason}; the next admission will retry reconciliation`,
		);
	}
}

function sameWorktreeDescriptor(
	left: BackgroundWorktreeDescriptor,
	right: BackgroundWorktreeDescriptor,
): boolean {
	return (
		left.callID === right.callID &&
		left.parentSessionId === right.parentSessionId &&
		left.taskId === right.taskId &&
		left.planTaskId === right.planTaskId &&
		sameProjectRoot(left.worktreePath, right.worktreePath) &&
		left.branchName === right.branchName &&
		left.worktreeId === right.worktreeId &&
		left.worktreeSessionId === right.worktreeSessionId &&
		left.mergeStrategy === right.mergeStrategy &&
		left.laneIndex === right.laneIndex &&
		left.worktreeDir === right.worktreeDir &&
		left.reservationId === right.reservationId &&
		left.generation === right.generation &&
		left.landedUnstaged === right.landedUnstaged &&
		left.provisioningOwner?.reservationId ===
			right.provisioningOwner?.reservationId &&
		left.provisioningOwner?.generation ===
			right.provisioningOwner?.generation &&
		left.provisioningOwner?.branchName === right.provisioningOwner?.branchName
	);
}

function hasExactWorktreeIdentity(
	record: BackgroundDelegationRecord,
	descriptor: BackgroundWorktreeDescriptor,
): boolean {
	const provenance = record.coderSettlement?.provenance;
	return !!(
		provenance &&
		provenance.correlationId === record.correlationId &&
		provenance.callID === record.callID &&
		provenance.parentSessionId === record.parentSessionId &&
		provenance.planTaskId === record.planTaskId &&
		descriptor.callID === record.callID &&
		descriptor.parentSessionId === record.parentSessionId &&
		descriptor.planTaskId === record.planTaskId &&
		provenance.worktree &&
		sameWorktreeDescriptor(provenance.worktree, descriptor) &&
		sameProjectRoot(provenance.baseline.directory, descriptor.worktreePath)
	);
}

function worktreeTrackingMatches(
	descriptor: BackgroundWorktreeDescriptor,
): boolean {
	const active = standardWorktreeByCallID.get(descriptor.callID);
	const awaiting = awaitingMergeByCallID.get(descriptor.callID);
	return (
		(!active ||
			(active.callID === descriptor.callID &&
				active.parentSessionID === descriptor.parentSessionId &&
				active.taskId === descriptor.taskId &&
				(active.planTaskId ?? null) === descriptor.planTaskId &&
				sameProjectRoot(active.handle.worktreePath, descriptor.worktreePath) &&
				active.handle.branchName === descriptor.branchName &&
				active.handle.id === descriptor.worktreeId &&
				active.handle.sessionId === descriptor.worktreeSessionId &&
				active.handle.purpose === 'lane' &&
				active.mergeStrategy === descriptor.mergeStrategy &&
				active.laneIndex === descriptor.laneIndex &&
				(active.worktree_dir ?? null) === descriptor.worktreeDir &&
				active.reservationId === descriptor.reservationId &&
				active.generation === descriptor.generation)) &&
		(!awaiting ||
			(awaiting.callID === descriptor.callID &&
				awaiting.parentSessionID === descriptor.parentSessionId &&
				awaiting.taskId === descriptor.taskId &&
				(awaiting.planTaskId ?? null) === descriptor.planTaskId &&
				sameProjectRoot(awaiting.worktreePath, descriptor.worktreePath) &&
				awaiting.branch === descriptor.branchName &&
				awaiting.mergeStrategy === descriptor.mergeStrategy &&
				awaiting.reservationId === descriptor.reservationId &&
				awaiting.generation === descriptor.generation))
	);
}

function trackAwaitingWorktree(descriptor: BackgroundWorktreeDescriptor): void {
	standardWorktreeByCallID.delete(descriptor.callID);
	awaitingMergeByCallID.set(descriptor.callID, {
		callID: descriptor.callID,
		parentSessionID: descriptor.parentSessionId,
		taskId: descriptor.taskId,
		...(descriptor.planTaskId ? { planTaskId: descriptor.planTaskId } : {}),
		...(descriptor.reservationId
			? { reservationId: descriptor.reservationId }
			: {}),
		...(descriptor.generation !== undefined
			? { generation: descriptor.generation }
			: {}),
		branch: descriptor.branchName,
		worktreePath: descriptor.worktreePath,
		mergeStrategy: descriptor.mergeStrategy,
		queuedAt: Date.now(),
	});
}

async function settlementLaneState(
	path: string,
): Promise<'absent' | 'directory'> {
	try {
		const stat = await withTimeout(
			lstat(path),
			5_000,
			new Error('worktree identity inspection timed out'),
		);
		if (stat.isSymbolicLink() || !stat.isDirectory())
			throw new Error('worktree path is not a direct directory');
		return 'directory';
	} catch (error) {
		if (errorCode(error) === 'ENOENT') return 'absent';
		throw error;
	}
}

async function handoffWorktreeSettlement(
	directory: string,
	record: BackgroundDelegationRecord,
): ReturnType<typeof transferLegacyCoderSettlement> {
	if (record.planTaskId && record.status !== 'consumed') {
		const settlement = record.coderSettlement;
		if (
			!settlement ||
			(settlement.state !== 'settling' && settlement.state !== 'settled')
		)
			return {
				disposition: 'manual_recovery',
				outcome:
					'worktree handoff has no exact settlement; manual recovery required',
			};
		const marked = await persistLegacyTransferMarker(
			directory,
			record,
			{
				taskId: record.planTaskId,
				transitionId: `coder:${record.callID}`,
			},
			(pending) =>
				isExactWorktreeSettlementUpdate(pending, record, {
					operationId: settlement.operationId ?? '',
					state: settlement.state === 'settled' ? 'settled' : 'settling',
					sourceHeadAfterCommit: settlement.sourceHeadAfterCommit,
					targetHeadBeforeMerge: settlement.targetHeadBeforeMerge,
					observedFiles: settlement.observedFiles,
					outcome: settlement.outcome,
				}),
		);
		if (!marked)
			return {
				disposition: 'manual_recovery',
				outcome:
					'worktree handoff retry marker could not be persisted; manual recovery required',
			};
	}
	const transferred = await transferLegacyCoderSettlement(directory, record);
	return record.status === 'consumed' && transferred.disposition !== 'ok'
		? {
				disposition: 'manual_recovery',
				outcome: 'historical worktree handoff requires manual recovery',
			}
		: transferred;
}

async function finishPublishedCoderWorktree(
	directory: string,
	record: BackgroundDelegationRecord,
	operationId: string,
): Promise<{
	ok: boolean;
	record: BackgroundDelegationRecord;
	outcome: string;
	legacyTransferred?: boolean;
}> {
	const settlement = record.coderSettlement;
	const descriptor = record.worktree;
	let replayScheduled = false;
	const failure = (reason: string) => ({
		ok: false,
		record,
		outcome: replayScheduled
			? `worktree cleanup debt remains; durable reconciliation will retry: ${reason}`
			: `worktree cleanup requires manual recovery: ${reason}`,
	});
	if (
		!descriptor ||
		!hasExactWorktreeIdentity(record, descriptor) ||
		(settlement?.state !== 'settled' && settlement?.state !== 'settling') ||
		settlement.operationId !== operationId ||
		settlement.observedFiles === null ||
		settlement.outcome?.kind !== 'standard-worktree' ||
		!['merged', 'unchanged'].includes(settlement.outcome.result) ||
		!settlement.sourceHeadAfterCommit ||
		!GIT_OBJECT_ID_PATTERN.test(settlement.sourceHeadAfterCommit) ||
		settlement.outcome.sourceHeadAfterCommit !==
			settlement.sourceHeadAfterCommit ||
		!settlement.targetHeadBeforeMerge ||
		!GIT_OBJECT_ID_PATTERN.test(settlement.targetHeadBeforeMerge) ||
		settlement.outcome.targetHeadBeforeMerge !==
			settlement.targetHeadBeforeMerge ||
		!worktreeTrackingMatches(descriptor)
	)
		return failure('durable or tracked identity mismatch');
	try {
		if ((await settlementLaneState(descriptor.worktreePath)) === 'directory') {
			await validateSettlementLane(
				descriptor.worktreePath,
				descriptor.branchName,
				settlement.sourceHeadAfterCommit,
			);
			if (
				(await resolveIsWorkingTreeCleanAsync(descriptor.worktreePath)) !== true
			)
				return failure('lane is dirty or could not be inspected');
		}
		const handoff = await handoffWorktreeSettlement(directory, record);
		if (handoff.disposition !== 'ok')
			return { ok: false, record, outcome: handoff.outcome };
		replayScheduled = record.status !== 'consumed' && !!record.planTaskId;
		// Validate both maps again after asynchronous handoff before installing ownership.
		if (!worktreeTrackingMatches(descriptor))
			return failure('tracked identity changed');
		if (settlement.state === 'settling') {
			const input = {
				operationId,
				state: 'settled' as const,
				observedFiles: settlement.observedFiles,
				sourceHeadAfterCommit: settlement.sourceHeadAfterCommit,
				targetHeadBeforeMerge: settlement.targetHeadBeforeMerge,
				outcome: settlement.outcome,
			};
			const persisted = await observerInternals.updateCoderSettlement(
				directory,
				record.correlationId,
				input,
			);
			if (!isExactWorktreeSettlementUpdate(persisted, record, input))
				return failure('exact settled publication failed');
			record = persisted;
		}
		if ((await settlementLaneState(descriptor.worktreePath)) === 'directory') {
			await validateSettlementLane(
				descriptor.worktreePath,
				descriptor.branchName,
				settlement.sourceHeadAfterCommit,
			);
			if (
				(await resolveIsWorkingTreeCleanAsync(descriptor.worktreePath)) !== true
			)
				return failure('lane changed during handoff');
		}
		// No await may separate the final ownership check from map installation.
		if (!worktreeTrackingMatches(descriptor))
			return failure('tracked identity changed during validation');
		trackAwaitingWorktree(descriptor);
		const cleanup = await cleanupStandardWorktreeForCallId(
			record.callID,
			'success',
			directory,
			descriptor.worktreeDir ?? undefined,
			{ retainBranch: true },
		);
		// #3888: a CONFIRMED re-provision skip is success-equivalent — the
		// surviving lane is owned by a live dispatch, not cleanup debt. An
		// UNCERTAIN skip keeps the lane and stays retryable (the tracking entry
		// was retained by the cleanup itself), so report it as debt, not
		// removal failure.
		if (cleanup.skippedReprovisioned) {
			return {
				ok: true,
				record,
				outcome:
					'completed and settled (lane re-provisioned by a live dispatch)',
				legacyTransferred: true,
			};
		}
		if ((await settlementLaneState(descriptor.worktreePath)) !== 'absent')
			return failure(
				cleanup.skippedOwnershipUncertain
					? 'lane ownership was uncertain; cleanup retryable'
					: cleanup.removedWorktree
						? 'lane still exists after cleanup'
						: 'lane removal failed',
			);
		return {
			ok: true,
			record,
			outcome: 'completed and settled',
			legacyTransferred: true,
		};
	} catch (error) {
		return failure(
			error instanceof Error
				? error.message
				: 'lane inspection or cleanup failed',
		);
	}
}

function sameSettlementBaseline(
	left: BackgroundWorkspaceSnapshot,
	right: BackgroundWorkspaceSnapshot,
): boolean {
	return (
		sameProjectRoot(left.directory, right.directory) &&
		left.gitHead === right.gitHead &&
		left.dirtyHash === right.dirtyHash &&
		left.prHeadSha === right.prHeadSha &&
		left.scope === right.scope &&
		(left.changedFiles === right.changedFiles ||
			(!!left.changedFiles &&
				!!right.changedFiles &&
				left.changedFiles.length === right.changedFiles.length &&
				left.changedFiles.every(
					(file, index) => file === right.changedFiles?.[index],
				)))
	);
}

function isExactWorktreeSettlementUpdate(
	persisted: BackgroundDelegationRecord | null,
	record: BackgroundDelegationRecord,
	input: Parameters<typeof updateCoderSettlement>[2],
): persisted is BackgroundDelegationRecord {
	const settlement = persisted?.coderSettlement;
	const originalProvenance = record.coderSettlement?.provenance;
	const descriptor = record.worktree;
	const expectedOutcome = input.outcome;
	const actualOutcome = settlement?.outcome;
	return !!(
		persisted &&
		descriptor &&
		persisted.worktree &&
		persisted.correlationId === record.correlationId &&
		sameWorktreeDescriptor(persisted.worktree, descriptor) &&
		hasExactWorktreeIdentity(persisted, descriptor) &&
		originalProvenance &&
		settlement &&
		sameSettlementBaseline(
			settlement.provenance.baseline,
			originalProvenance.baseline,
		) &&
		settlement?.state === input.state &&
		settlement.operationId === input.operationId &&
		(input.sourceHeadAfterCommit === undefined ||
			settlement.sourceHeadAfterCommit === input.sourceHeadAfterCommit) &&
		(input.targetHeadBeforeMerge === undefined ||
			settlement.targetHeadBeforeMerge === input.targetHeadBeforeMerge) &&
		input.observedFiles &&
		settlement.observedFiles &&
		input.observedFiles.length === settlement.observedFiles.length &&
		input.observedFiles.every((file) =>
			settlement.observedFiles?.includes(file),
		) &&
		(!expectedOutcome ||
			(actualOutcome &&
				actualOutcome.kind === expectedOutcome.kind &&
				actualOutcome.result === expectedOutcome.result &&
				actualOutcome.reason === expectedOutcome.reason &&
				actualOutcome.sourceHeadAfterCommit ===
					expectedOutcome.sourceHeadAfterCommit &&
				actualOutcome.targetHeadBeforeMerge ===
					expectedOutcome.targetHeadBeforeMerge &&
				actualOutcome.targetHeadAfterMerge ===
					expectedOutcome.targetHeadAfterMerge))
	);
}

/**
 * True when a settleCoder ok:false outcome is terminal-by-ingestion-fence:
 * the record was durably flipped 'stale' (shared-root HEAD/PR-head drift or
 * attribution failure) or its settlement was durably 'preserved' — claim
 * disposition preserved, and the worktree identity-mismatch / attribution /
 * merge-refusal sites, each of which PERSISTS state 'preserved' before
 * returning. Both statuses are refused by claimDelegationIngestion and their
 * recovery is operator-only (/swarm recover), never a replay, so the
 * route-invalidation obligation can never be consumed and must flush.
 * 'stale: no coder baseline' is included because its exit is deterministic
 * (immutable closed-summary provenance cannot re-materialize a merge path),
 * so observer consumption is unreachable either way.
 *
 * Everything else is re-drivable and RETAINS the obligation: transient
 * 'settlement claim failed' / 'settlement persistence failed' keep the claim
 * resumable, finishPublishedCoderWorktree's 'durable reconciliation will
 * retry' schedules an explicit replay, and the settleCoder tracking recheck
 * returns 'worktree settlement retry pending: tracked identity changed'
 * WITHOUT persisting 'preserved' (transient race — the 'retry pending'
 * string keeps it in the retain class). Manual-recovery and handoff outcomes
 * retain too (fail-safe — stranded occupancy is inert, an early flush is the
 * PRR-004 class where a stale prior receipt authorizes publication).
 */
function isSettleCoderTerminalByFence(outcome: string): boolean {
	return (
		outcome === 'settlement preserved' ||
		outcome.startsWith('worktree settlement preserved') ||
		outcome.startsWith('stale:')
	);
}

async function settleCoder(
	directory: string,
	record: BackgroundDelegationRecord,
	operationId: string,
): Promise<{
	ok: boolean;
	record: BackgroundDelegationRecord;
	outcome: string;
	legacyTransferred?: boolean;
}> {
	// Closed summaries deliberately omit taskChangeContext. Their immutable
	// settlement provenance is sufficient for cleanup-only replay, never a merge.
	if (record.coderSettlement?.state === 'settled' && record.worktree) {
		return finishPublishedCoderWorktree(directory, record, operationId);
	}
	const context = record.taskChangeContext;
	if (!context) {
		return { ok: false, record, outcome: 'stale: no coder baseline' };
	}
	const claim = await claimCoderSettlement(
		directory,
		record.correlationId,
		operationId,
	);
	if (!claim) {
		return { ok: false, record, outcome: 'settlement claim failed' };
	}
	if (claim.disposition === 'settled') {
		return claim.record.worktree
			? finishPublishedCoderWorktree(directory, claim.record, operationId)
			: { ok: true, record: claim.record, outcome: 'completed and settled' };
	}
	if (claim.disposition === 'preserved') {
		return { ok: false, record: claim.record, outcome: 'settlement preserved' };
	}
	record = claim.record;
	if (record.worktree && record.coderSettlement?.outcome) {
		// A durable successful post-Git receipt authorizes only handoff,
		// terminal publication and cleanup; never invoke the merge adapter again.
		return finishPublishedCoderWorktree(directory, record, operationId);
	}

	if (!record.worktree) {
		const baseline = context.baseline;
		const current = captureWorkspaceSnapshot(directory, {
			scope: baseline.scope,
			prHeadSha: baseline.prHeadSha,
			resolveCurrentPrHeadSha: baseline.prHeadSha !== null,
		});
		const repositoryDelta = changedFilesSinceSnapshot(directory, baseline);
		const declaredFiles = context.declaredFiles;
		const observedFiles =
			repositoryDelta && declaredFiles && declaredFiles.length > 0
				? repositoryDelta.filter((file) =>
						isInDeclaredScope(file, declaredFiles, directory),
					)
				: null;
		const staleReason = !sameProjectRoot(baseline.directory, directory)
			? 'shared-root directory identity changed'
			: !baseline.gitHead || current.gitHead !== baseline.gitHead
				? 'shared-root HEAD changed before coder completion'
				: baseline.prHeadSha !== null &&
						current.prHeadSha !== baseline.prHeadSha
					? 'shared-root PR head changed before coder completion'
					: observedFiles === null
						? 'shared-root coder files could not be attributed to a non-empty declared scope'
						: null;
		if (staleReason || observedFiles === null) {
			const preserved = await observerInternals.updateCoderSettlement(
				directory,
				record.correlationId,
				{
					operationId,
					state: 'preserved',
					observedFiles: null,
					outcome: {
						kind: 'shared-root',
						result: 'failed',
						reason: staleReason ?? 'coder attribution failed',
					},
				},
			);
			// INTENTIONAL-EVENTLESS: post-claim terminal→terminal flip (issue
			// #2700 disposition) — the record's typed terminal event came from
			// the claim that opened this coder settlement; the preserved→stale
			// transition establishes no new first-terminal event.
			await appendDelegationTransition(directory, record.correlationId, {
				status: 'stale',
			});
			return {
				ok: false,
				record: preserved ?? record,
				outcome: `stale: ${staleReason ?? 'coder attribution failed'}`,
			};
		}
		const settled = await observerInternals.updateCoderSettlement(
			directory,
			record.correlationId,
			{
				operationId,
				state: 'settled',
				observedFiles,
				outcome: { kind: 'shared-root', result: 'ready' },
			},
		);
		return settled
			? { ok: true, record: settled, outcome: 'completed and settled' }
			: { ok: false, record, outcome: 'settlement persistence failed' };
	}

	const descriptor = record.worktree;
	if (
		!hasExactWorktreeIdentity(record, descriptor) ||
		!sameProjectRoot(context.baseline.directory, descriptor.worktreePath) ||
		!worktreeTrackingMatches(descriptor)
	) {
		const preserved = await observerInternals.updateCoderSettlement(
			directory,
			record.correlationId,
			{
				operationId,
				state: 'preserved',
				observedFiles: null,
				outcome: {
					kind: 'standard-worktree',
					result: 'failed',
					reason: 'worktree recovery identity does not match the dispatch',
				},
			},
		);
		return {
			ok: false,
			record: preserved ?? record,
			outcome: 'worktree settlement preserved: identity mismatch',
		};
	}
	const resume = settlementResume(record);
	// Once the source was committed, the pre-merge list is authoritative. Reading
	// the lane after Git succeeds would lose its mutation attribution on replay.
	const observedFiles = resume
		? (record.coderSettlement?.observedFiles ?? null)
		: changedFilesSinceSnapshot(descriptor.worktreePath, context.baseline);
	if (observedFiles === null) {
		const preserved = await observerInternals.updateCoderSettlement(
			directory,
			record.correlationId,
			{
				operationId,
				state: 'preserved',
				observedFiles: null,
				outcome: {
					kind: 'standard-worktree',
					result: 'failed',
					reason:
						'worktree files could not be attributed to the clean baseline',
				},
			},
		);
		return {
			ok: false,
			record: preserved ?? record,
			outcome: 'worktree settlement preserved: attribution failed',
		};
	}

	const dispatch: StandardWorktreeDispatch = standardWorktreeByCallID.get(
		record.callID,
	) ?? {
		callID: descriptor.callID,
		parentSessionID: descriptor.parentSessionId,
		taskId: descriptor.taskId,
		...(descriptor.planTaskId ? { planTaskId: descriptor.planTaskId } : {}),
		handle: {
			worktreePath: descriptor.worktreePath,
			branchName: descriptor.branchName,
			purpose: 'lane',
			id: descriptor.worktreeId,
			sessionId: descriptor.worktreeSessionId,
		},
		mergeStrategy: descriptor.mergeStrategy,
		laneIndex: descriptor.laneIndex,
		...(descriptor.worktreeDir ? { worktree_dir: descriptor.worktreeDir } : {}),
	};
	if (!worktreeTrackingMatches(descriptor))
		// RETAIN-class, not preserved: this is the second tracking recheck after
		// an async gap (the first passed) — a concurrent-tracking race a later
		// replay can pass. Nothing was persisted 'preserved' here, so the record
		// stays resumable 'settling' (claimCoderSettlement 'resume') — matching
		// finishPublishedCoderWorktree's identical recheck, which returns the
		// retry-class failure('tracked identity changed').
		return {
			ok: false,
			record,
			outcome: 'worktree settlement retry pending: tracked identity changed',
		};
	trackAwaitingWorktree(descriptor);
	let handoffFailure: string | undefined;
	const mergeResult = await finishStandardWorktreeDispatch(
		directory,
		dispatch,
		undefined,
		record.callID,
		{
			operationId,
			...(resume ? { resume } : {}),
			onBeforeMerge: async (provenance) => {
				const input = {
					operationId,
					state: 'settling' as const,
					sourceHeadAfterCommit: provenance.sourceHead,
					targetHeadBeforeMerge: provenance.targetHeadBefore,
					observedFiles,
				};
				const persisted = await observerInternals.updateCoderSettlement(
					directory,
					record.correlationId,
					input,
				);
				if (!isExactWorktreeSettlementUpdate(persisted, record, input))
					throw new Error('could not persist pre-merge provenance');
				record = persisted;
			},
			onMerged: async (merged) => {
				const provenance = merged.provenance ?? resume;
				const priorOutcome = record.coderSettlement?.outcome;
				if (
					priorOutcome &&
					(priorOutcome.kind !== 'standard-worktree' ||
						!['merged', 'unchanged'].includes(priorOutcome.result) ||
						priorOutcome.sourceHeadAfterCommit !== provenance?.sourceHead ||
						priorOutcome.targetHeadBeforeMerge !== provenance?.targetHeadBefore)
				)
					throw new Error(
						'persisted merge outcome does not match immutable operation',
					);
				// Preserve the first post-Git receipt when a later invocation resumes
				// after handoff or terminal publication failed.
				const input = {
					operationId,
					state: 'settling' as const,
					observedFiles,
					...(provenance
						? {
								sourceHeadAfterCommit: provenance.sourceHead,
								targetHeadBeforeMerge: provenance.targetHeadBefore,
							}
						: {}),
					outcome: priorOutcome ?? {
						kind: 'standard-worktree' as const,
						result:
							provenance &&
							provenance.sourceHead !== provenance.targetHeadBefore
								? ('merged' as const)
								: ('unchanged' as const),
						sourceHeadAfterCommit: provenance?.sourceHead ?? null,
						targetHeadBeforeMerge: provenance?.targetHeadBefore ?? null,
						targetHeadAfterMerge: resolveCurrentGitHead(directory),
					},
				};
				const attributed = await observerInternals.updateCoderSettlement(
					directory,
					record.correlationId,
					input,
				);
				if (!isExactWorktreeSettlementUpdate(attributed, record, input))
					throw new Error('could not persist exact merged attribution');
				record = attributed;
				const handoff = await handoffWorktreeSettlement(directory, record);
				if (handoff.disposition !== 'ok') {
					handoffFailure = handoff.outcome;
					throw new Error(handoff.outcome);
				}
				const terminalInput = { ...input, state: 'settled' as const };
				const persisted = await observerInternals.updateCoderSettlement(
					directory,
					record.correlationId,
					terminalInput,
				);
				if (!isExactWorktreeSettlementUpdate(persisted, record, terminalInput))
					throw new Error('could not persist exact merged settlement');
				record = persisted;
				if (!worktreeTrackingMatches(descriptor))
					throw new Error('tracked identity changed before cleanup');
			},
		},
	);
	if (mergeResult.outcome === 'merged') {
		// #3888: a CONFIRMED re-provision skip is success-equivalent — the
		// surviving lane is owned by a live dispatch, not cleanup debt. An
		// UNCERTAIN skip stays retryable debt (reported below as before).
		if (mergeResult.skippedReprovisioned) {
			const latestSkip =
				(await findDelegationForCompletion(directory, record.correlationId))
					?.record ?? record;
			return {
				ok: true,
				record: latestSkip,
				outcome:
					'completed and settled (lane re-provisioned by a live dispatch)',
			};
		}
		const cleanupDebt = record.planTaskId
			? mergeResult.skippedOwnershipUncertain
				? 'lane ownership was uncertain; cleanup retryable by durable reconciliation'
				: 'worktree cleanup debt remains; durable reconciliation will retry'
			: 'worktree cleanup requires manual recovery';
		try {
			if ((await settlementLaneState(descriptor.worktreePath)) !== 'absent')
				return { ok: false, record, outcome: cleanupDebt };
		} catch {
			return {
				ok: false,
				record,
				outcome: `${cleanupDebt}; removal could not be verified`,
			};
		}
		const latest =
			(await findDelegationForCompletion(directory, record.correlationId))
				?.record ?? record;
		return {
			ok: true,
			record: latest,
			outcome: 'completed and merged',
			legacyTransferred: true,
		};
	}
	if (
		mergeResult.outcome === 'failed' &&
		mergeResult.stage === 'settlement-persist'
	) {
		return {
			ok: false,
			record,
			outcome:
				handoffFailure ?? 'worktree settlement persistence pending retry',
		};
	}
	const preserved = await observerInternals.updateCoderSettlement(
		directory,
		record.correlationId,
		{
			operationId,
			state: 'preserved',
			observedFiles,
			...(mergeResult.provenance
				? {
						sourceHeadAfterCommit: mergeResult.provenance.sourceHead,
						targetHeadBeforeMerge: mergeResult.provenance.targetHeadBefore,
					}
				: {}),
			outcome: {
				kind: 'standard-worktree',
				result: mergeResult.outcome,
				reason: mergeResult.message,
				sourceHeadAfterCommit: mergeResult.provenance?.sourceHead ?? null,
				targetHeadBeforeMerge: mergeResult.provenance?.targetHeadBefore ?? null,
			},
		},
	);
	return {
		ok: false,
		record: preserved ?? record,
		outcome: `worktree settlement preserved: ${mergeResult.message}`,
	};
}

function settlementResume(
	record: BackgroundDelegationRecord,
): MergeOperationProvenance | undefined {
	const settlement = record.coderSettlement;
	const worktree = record.worktree;
	if (
		settlement?.state !== 'settling' ||
		!settlement.operationId ||
		!settlement.sourceHeadAfterCommit ||
		!settlement.targetHeadBeforeMerge ||
		!GIT_OBJECT_ID_PATTERN.test(settlement.sourceHeadAfterCommit) ||
		!GIT_OBJECT_ID_PATTERN.test(settlement.targetHeadBeforeMerge) ||
		!worktree
	) {
		return undefined;
	}
	return {
		operationId: settlement.operationId,
		sourceHead: settlement.sourceHeadAfterCommit,
		targetHeadBefore: settlement.targetHeadBeforeMerge,
		branchName: worktree.branchName,
		strategy: worktree.mergeStrategy,
	};
}

/** The durable result of establishing a terminal advisory (r14 P0-2). */
interface AdvisoryEstablishment {
	/** The durably stored advisory entry; null = NOT established. */
	stored: BackgroundAdvisoryInboxEntry | null;
	/** Replacement metadata when a legacy transfer advisory was corrected. */
	replacement: ReplacePendingBackgroundAdvisoryResult | null;
}

/**
 * Establish the durable parent advisory for a terminal event (r14 audit
 * repair P0-2). Returns the stored entry — or `stored: null` when the
 * advisory could NOT be durably established (lock/IO failure). Null is a
 * FAILURE signal: the caller must not treat it as success.
 */
async function establishBackgroundAdvisory(
	directory: string,
	record: BackgroundDelegationRecord,
	eventId: string,
	outcome: string,
	putAdvisory: typeof putPendingBackgroundAdvisory,
): Promise<AdvisoryEstablishment> {
	const message =
		`[BACKGROUND COMPLETION ${eventId}] ${record.normalizedAgent} task ` +
		`${taskLabel(record)} ${outcome}.`;
	const input = {
		eventId,
		parentSessionId: record.parentSessionId,
		message,
	};
	const needsCorrection = !message.includes(
		LEGACY_CODER_SETTLEMENT_PENDING_ADVISORY_MARKER,
	);
	const replacement =
		(needsCorrection
			? await replacePendingBackgroundAdvisory(
					directory,
					record.correlationId,
					input,
				)
			: null) ?? null;
	const stored =
		replacement?.advisory ??
		(await putAdvisory(directory, record.correlationId, input));
	return { stored, replacement };
}

/**
 * Best-effort in-memory delivery of an established advisory to a live parent
 * session (fast path only — the durable store is the obligation).
 */
function deliverAdvisoryToSession(
	record: BackgroundDelegationRecord,
	eventId: string,
	establishment: AdvisoryEstablishment,
): void {
	if (!establishment.stored) return;
	const message = establishment.stored.message;
	const needsCorrection = !message.includes(
		LEGACY_CODER_SETTLEMENT_PENDING_ADVISORY_MARKER,
	);
	const session = swarmState.agentSessions.get(record.parentSessionId);
	if (session) {
		if (needsCorrection) {
			removeQueuedLegacyTransferAdvisory(
				session.pendingAdvisoryMessages,
				eventId,
			);
			if (establishment.replacement?.replacedMessage) {
				removeQueuedAdvisoryMessage(session.pendingAdvisoryMessages, [
					establishment.replacement.replacedMessage,
				]);
			}
		}
		pushAdvisory(session, message);
	}
}

async function publishAdvisory(
	directory: string,
	record: BackgroundDelegationRecord,
	eventId: string,
	outcome: string,
): Promise<void> {
	const establishment = await establishBackgroundAdvisory(
		directory,
		record,
		eventId,
		outcome,
		putPendingBackgroundAdvisory,
	);
	if (!establishment.stored) return;
	deliverAdvisoryToSession(record, eventId, establishment);
}

/**
 * r14 audit repair (P0-2): the parent_advisory closeout effect under the
 * explicit effect contract. A null store result is a RETRYABLE error (the
 * step stays pending; recovery re-drives the idempotent eventId-keyed put) —
 * never a silent success.
 */
function parentAdvisoryEffect(
	directory: string,
	record: BackgroundDelegationRecord,
	eventId: string,
	outcome: string,
	putAdvisory: typeof putPendingBackgroundAdvisory,
): () => Promise<CloseoutEffectResult> {
	return async () => {
		const establishment = await establishBackgroundAdvisory(
			directory,
			record,
			eventId,
			outcome,
			putAdvisory,
		);
		if (!establishment.stored) {
			return {
				status: 'retryable_error',
				reason: `parent advisory could not be durably established for ${record.correlationId} (advisory store returned null)`,
			};
		}
		deliverAdvisoryToSession(record, eventId, establishment);
		return { status: 'persisted' };
	};
}

function errorCode(error: unknown): string | null {
	if (
		error &&
		typeof error === 'object' &&
		'code' in error &&
		typeof (error as NodeJS.ErrnoException).code === 'string'
	) {
		return (error as NodeJS.ErrnoException).code ?? null;
	}
	const detail = error instanceof Error ? error.message : String(error);
	const match = /^([A-Z][A-Z0-9_]*)(?::|$)/.exec(detail.trim());
	return match?.[1] ?? null;
}

function hasExactPendingLegacyTransfer(
	record: BackgroundDelegationRecord | null,
	transfer: LegacyCoderSettlementTransfer,
): boolean {
	return (
		record?.legacyCoderSettlementTransfer?.taskId === transfer.taskId &&
		record.legacyCoderSettlementTransfer.transitionId === transfer.transitionId
	);
}

function isRetryableLegacyTransferErrorCode(code: string | null): boolean {
	return (
		code !== null && RETRYABLE_LEGACY_SETTLEMENT_TRANSFER_ERROR_CODES.has(code)
	);
}

function removeQueuedAdvisoryMessage(
	queue: string[] | undefined,
	messagesToRemove: readonly string[],
): void {
	if (!queue || queue.length === 0 || messagesToRemove.length === 0) return;
	const remove = new Set(messagesToRemove);
	for (let index = queue.length - 1; index >= 0; index -= 1) {
		if (remove.has(queue[index]!)) {
			queue.splice(index, 1);
		}
	}
}

function removeQueuedLegacyTransferAdvisory(
	queue: string[] | undefined,
	eventId: string,
): void {
	if (!queue || queue.length === 0) return;
	const prefix = `[BACKGROUND COMPLETION ${eventId}]`;
	for (let index = queue.length - 1; index >= 0; index -= 1) {
		const message = queue[index];
		if (
			message?.startsWith(prefix) &&
			message.includes(LEGACY_CODER_SETTLEMENT_PENDING_ADVISORY_MARKER)
		) {
			queue.splice(index, 1);
		}
	}
}

function taskLabel(record: BackgroundDelegationRecord): string {
	return record.evidenceTaskId ?? record.planTaskId ?? 'unknown';
}

/** Discard the reviewer scope generation for a terminal (error/stale) delegation. */
function discardScopeForRecord(record: BackgroundDelegationRecord): void {
	const taskId = record.evidenceTaskId ?? record.planTaskId;
	if (!taskId) return;
	if (record.normalizedAgent === 'reviewer') {
		discardReviewerScopeGenerationClaim({
			parentSessionID: record.parentSessionId,
			taskId,
			reviewerCallID: record.callID,
		});
	} else if (record.normalizedAgent === 'coder') {
		discardReviewerScopeGenerationForCoderCall({
			parentSessionID: record.parentSessionId,
			taskId,
			coderCallID: record.callID,
		});
	}
}

function digest(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

function cryptoRandomId(): string {
	return createHash('sha256')
		.update(`${Date.now()}:${Math.random()}`)
		.digest('hex')
		.slice(0, 24);
}
