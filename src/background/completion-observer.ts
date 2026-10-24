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
import {
	discardReviewerScopeGenerationClaim,
	discardReviewerScopeGenerationForCoderCall,
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
	type BackgroundDelegationRecord,
	type BackgroundDelegationResult,
	type BackgroundTerminalResult,
	type BackgroundWorkspaceSnapshot,
	type BackgroundWorktreeDescriptor,
	bindBackgroundCoderReservation,
	buildBackgroundCompletionEventId,
	claimCoderSettlement,
	claimDelegationIngestion,
	claimTerminalResult,
	clearLegacyCoderSettlementTransferPending,
	findDelegationForCompletion,
	LEGACY_CODER_SETTLEMENT_PENDING_ADVISORY_MARKER,
	type LegacyCoderSettlementTransfer,
	maintainBackgroundDelegations,
	markLegacyCoderSettlementTransferPending,
	preparePendingBackgroundAdvisories,
	promoteDelegationFallback,
	putPendingBackgroundAdvisory,
	type ReplacePendingBackgroundAdvisoryResult,
	recordDelegationIngestionResult,
	registerLegacyCoderSettlementReconciler,
	releaseBackgroundCoderReservation,
	releasePreparedBackgroundAdvisories,
	replacePendingBackgroundAdvisory,
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
	sleep: (milliseconds: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
};

/** Test-only dependency seam; production callers should use the observer API. */
export const _internals = observerInternals;

export function createBackgroundCompletionObserver(opts: {
	config: ObserverConfig;
	directory: string;
	onTerminalClaimed?: (record: BackgroundDelegationRecord) => void;
	recordIngestionResult?: typeof recordDelegationIngestionResult;
	// Accepted from caller for API compatibility; reviewer receipt validation
	// is handled internally by the completion observer when enabled.
	reviewerReceiptOptions?: Record<string, unknown>;
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
				record = terminalClaim.record;
			}
			opts.onTerminalClaimed?.(record);

			// Maintenance point P2 (issue #2104): a trusted terminal (or the
			// ingestion rejection handled below) is exactly when orphaned
			// reservations and stale records become provably reclaimable. One
			// bounded, lock-limited pass; best-effort — the settlement paths
			// below must proceed regardless.
			if (!input.trustedTerminal?.skipMaintenance) {
				try {
					await maintainBackgroundDelegations(directory, {
						lockTimeoutMs: 1_000,
						reason: 'trusted-terminal',
						onLegacyCoderSettlementReconciled: reconcilePending,
						onLegacyCoderSettlementAdvisoryReplaced:
							notifyLegacyCoderSettlementAdvisoryReplaced,
					});
				} catch {
					// observation only; another maintenance point will finish
				}
			}

			let legacyTransferPending = false;
			let legacyTransferRequiresManualRecovery = false;
			if (terminal.status !== 'completed') {
				if (isDuplicate && record.normalizedAgent !== 'coder') {
					// Non-coder failure cleanup has no durable sub-transition to resume.
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
				await publishAdvisory(
					directory,
					record,
					terminal.eventId,
					legacyTransferPending
						? `${terminal.status === 'cancelled' ? 'cancelled' : 'failed'}; legacy coder settlement transfer is pending; durable reconciliation will retry`
						: legacyTransferRequiresManualRecovery
							? `${terminal.status === 'cancelled' ? 'cancelled' : 'failed'}; legacy coder settlement requires manual recovery; run /swarm recover for this task (or /swarm reset-session)`
							: terminal.status === 'cancelled'
								? 'cancelled'
								: 'failed',
				);
				if (!legacyTransferPending) {
					await clearLegacyCoderSettlementTransferPending(
						directory,
						record.correlationId,
					);
				}
				return;
			}

			if (record.normalizedAgent === 'coder') {
				const settled = await settleCoder(directory, record, terminal.eventId);
				record = settled.record;
				if (!settled.ok) {
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
					discardScopeForRecord(record);
					await publishAdvisory(directory, record, terminal.eventId, 'stale');
					return;
				}
			}

			if (
				record.normalizedAgent === 'coder' ||
				isBackgroundGateBearingRecord(record)
			) {
				const ingestion = await claimDelegationIngestion(
					directory,
					record.correlationId,
					{ claimantId: terminal.eventId },
				);
				if (
					ingestion?.disposition === 'claimed' ||
					ingestion?.disposition === 'retry'
				) {
					const applied = await ingestBackgroundStageBCompletion({
						directory,
						record: ingestion.record,
						result: ingestion.record.result ?? result,
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
					const ingestionCommit = await (
						opts.recordIngestionResult ?? recordDelegationIngestionResult
					)(directory, record.correlationId, claimToken, applied.ok);
					if (!ingestionCommit) {
						logger.warn(
							`[background] ingestion claim for ${record.correlationId} expired or was fenced before commit; retry remains pending`,
						);
						return;
					}
					if (
						applied.ok &&
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
					if (!applied.ok) {
						await publishAdvisory(
							directory,
							record,
							terminal.eventId,
							applied.skipped
								? 'skipped (tests not run) — re-dispatch the test gate; reviewer proof preserved; task remains Stage B eligible'
								: legacyTransferPending
									? 'ingestion failed; legacy coder settlement transfer is pending; durable reconciliation will retry'
									: legacyTransferRequiresManualRecovery
										? 'ingestion failed; legacy coder settlement requires manual recovery; run /swarm recover for this task (or /swarm reset-session)'
										: applied.stale
											? 'stale'
											: 'ingestion failed',
						);
						// Maintenance point P2b (issue #2104): the ingestion
						// rejection has just been durably recorded — reconcile now
						// so the rejected record and any orphaned reservation are
						// handled at this listed point, not only at the next one.
						try {
							await maintainBackgroundDelegations(directory, {
								lockTimeoutMs: 1_000,
								reason: 'ingestion-rejection',
								skipLegacyCoderSettlementReconciliation: legacyTransferPending,
								onLegacyCoderSettlementAdvisoryReplaced:
									notifyLegacyCoderSettlementAdvisoryReplaced,
							});
						} catch {
							// observation only; the facts ring records it
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
			await publishAdvisory(
				directory,
				record,
				terminal.eventId,
				record.normalizedAgent === 'coder'
					? legacyTransferPending
						? 'completed and settled; legacy coder settlement transfer is pending; durable reconciliation will retry'
						: legacyTransferRequiresManualRecovery
							? 'completed and settled; legacy coder settlement requires manual recovery; run /swarm recover for this task (or /swarm reset-session)'
							: 'completed and settled'
					: 'completed',
			);
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
		if ((await settlementLaneState(descriptor.worktreePath)) !== 'absent')
			return failure(
				cleanup.removedWorktree
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
		return {
			ok: false,
			record,
			outcome: 'worktree settlement preserved: tracked identity changed',
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
		const cleanupDebt = record.planTaskId
			? 'worktree cleanup debt remains; durable reconciliation will retry'
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

async function publishAdvisory(
	directory: string,
	record: BackgroundDelegationRecord,
	eventId: string,
	outcome: string,
): Promise<void> {
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
		(await putPendingBackgroundAdvisory(
			directory,
			record.correlationId,
			input,
		));
	if (!stored) return;
	const session = swarmState.agentSessions.get(record.parentSessionId);
	if (session) {
		if (needsCorrection) {
			removeQueuedLegacyTransferAdvisory(
				session.pendingAdvisoryMessages,
				eventId,
			);
			if (replacement?.replacedMessage) {
				removeQueuedAdvisoryMessage(session.pendingAdvisoryMessages, [
					replacement.replacedMessage,
				]);
			}
		}
		pushAdvisory(session, stored.message);
	}
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
