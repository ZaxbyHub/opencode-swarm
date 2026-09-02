/**
 * Trusted background-subagent completion observer.
 *
 * Terminal identity, coder settlement, workflow ingestion, and parent
 * notification are separate durable transitions. Replaying the same synthetic
 * event therefore resumes the first incomplete transition without re-running a
 * completed one.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { completeBackgroundPhaseParticipation } from '../evidence/phase-participation.js';
import { transitionTaskWorkflowEvidence } from '../gate-evidence.js';
import {
	abortStandardWorktreeDispatch,
	awaitingMergeByCallID,
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
import * as logger from '../utils/logger.js';
import { transferCoderSettlementToBackground } from '../workflow/coder-settlement.js';
import {
	GIT_OBJECT_ID_PATTERN,
	type MergeOperationProvenance,
} from '../worktree/merge.js';
import {
	acknowledgeObservedBackgroundAdvisories,
	appendDelegationTransition,
	type BackgroundDelegationRecord,
	type BackgroundDelegationResult,
	type BackgroundTerminalResult,
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
	transferCoderSettlementToBackground,
	markLegacyCoderSettlementTransferPending,
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

	const event = async (input: ObserverEventInput): Promise<void> => {
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
					return;
				}
				const legacyTransfer = await transferLegacyCoderSettlement(
					directory,
					record,
				);
				if (legacyTransfer.disposition === 'retry_pending') {
					legacyTransferPending = true;
				} else if (legacyTransfer.disposition === 'manual_recovery') {
					legacyTransferRequiresManualRecovery = true;
				}
			} else if (!isDuplicate && isBackgroundGateBearingRecord(record)) {
				// On a duplicate event the workspace was already validated
				// during first processing; skip re-validation to preserve scope.
				const freshness = validateStageBWorkspace(directory, record);
				if (freshness.stale) {
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
							legacyTransferPending
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
			await event({
				event: undefined,
				trustedTerminal: {
					record,
					terminal,
					result: terminal.result,
					skipMaintenance: true,
				},
			});
			const refreshed = await findDelegationForCompletion(
				directory,
				record.subagentSessionId,
			);
			return refreshed?.record.status === 'consumed';
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
		event,
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
		if (hasExactPendingLegacyTransfer(pending, transfer)) break;
		if (markerAttempt < 2) {
			await observerInternals.sleep(50 * (markerAttempt + 1));
		}
	}
	if (hasExactPendingLegacyTransfer(pending, transfer)) {
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

async function settleCoder(
	directory: string,
	record: BackgroundDelegationRecord,
	operationId: string,
): Promise<{
	ok: boolean;
	record: BackgroundDelegationRecord;
	outcome: string;
}> {
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
		return { ok: true, record: claim.record, outcome: 'completed and settled' };
	}
	if (claim.disposition === 'preserved') {
		return { ok: false, record: claim.record, outcome: 'settlement preserved' };
	}
	record = claim.record;

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
		const staleReason =
			path.resolve(baseline.directory) !== path.resolve(directory)
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
			const preserved = await updateCoderSettlement(
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
			await appendDelegationTransition(directory, record.correlationId, {
				status: 'stale',
			});
			return {
				ok: false,
				record: preserved ?? record,
				outcome: `stale: ${staleReason ?? 'coder attribution failed'}`,
			};
		}
		const settled = await updateCoderSettlement(
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
		descriptor.callID !== record.callID ||
		descriptor.parentSessionId !== record.parentSessionId ||
		descriptor.planTaskId !== record.planTaskId ||
		path.resolve(context.baseline.directory) !==
			path.resolve(descriptor.worktreePath)
	) {
		const preserved = await updateCoderSettlement(
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
	const observedFiles = changedFilesSinceSnapshot(
		descriptor.worktreePath,
		context.baseline,
	);
	if (observedFiles === null) {
		const preserved = await updateCoderSettlement(
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
	standardWorktreeByCallID.delete(record.callID);
	awaitingMergeByCallID.set(record.callID, {
		callID: record.callID,
		parentSessionID: descriptor.parentSessionId,
		taskId: descriptor.taskId,
		...(descriptor.planTaskId ? { planTaskId: descriptor.planTaskId } : {}),
		branch: descriptor.branchName,
		worktreePath: descriptor.worktreePath,
		mergeStrategy: descriptor.mergeStrategy,
		queuedAt: Date.now(),
	});

	const resume = settlementResume(record);
	const mergeResult = await finishStandardWorktreeDispatch(
		directory,
		dispatch,
		undefined,
		record.callID,
		{
			operationId,
			...(resume ? { resume } : {}),
			onBeforeMerge: async (provenance) => {
				const persisted = await updateCoderSettlement(
					directory,
					record.correlationId,
					{
						operationId,
						state: 'settling',
						sourceHeadAfterCommit: provenance.sourceHead,
						targetHeadBeforeMerge: provenance.targetHeadBefore,
						observedFiles,
					},
				);
				if (!persisted)
					throw new Error('could not persist pre-merge provenance');
				record = persisted;
			},
			onMerged: async (merged) => {
				const provenance = merged.provenance ?? resume;
				const persisted = await updateCoderSettlement(
					directory,
					record.correlationId,
					{
						operationId,
						state: 'settled',
						observedFiles,
						...(provenance
							? {
									sourceHeadAfterCommit: provenance.sourceHead,
									targetHeadBeforeMerge: provenance.targetHeadBefore,
								}
							: {}),
						outcome: {
							kind: 'standard-worktree',
							result:
								provenance &&
								provenance.sourceHead !== provenance.targetHeadBefore
									? 'merged'
									: 'unchanged',
							sourceHeadAfterCommit: provenance?.sourceHead ?? null,
							targetHeadBeforeMerge: provenance?.targetHeadBefore ?? null,
							targetHeadAfterMerge: resolveCurrentGitHead(directory),
						},
					},
				);
				if (!persisted) throw new Error('could not persist merged settlement');
				record = persisted;
			},
		},
	);
	if (mergeResult.outcome === 'merged') {
		const latest =
			(await findDelegationForCompletion(directory, record.correlationId))
				?.record ?? record;
		return { ok: true, record: latest, outcome: 'completed and merged' };
	}
	if (
		mergeResult.outcome === 'failed' &&
		mergeResult.stage === 'settlement-persist'
	) {
		return {
			ok: false,
			record,
			outcome: 'worktree settlement persistence pending retry',
		};
	}
	const preserved = await updateCoderSettlement(
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
