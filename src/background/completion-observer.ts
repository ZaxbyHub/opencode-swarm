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
import {
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
import type { MergeOperationProvenance } from '../worktree/merge.js';
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
	findDelegationForCompletion,
	preparePendingBackgroundAdvisories,
	promoteDelegationFallback,
	putPendingBackgroundAdvisory,
	recordDelegationIngestionResult,
	releaseBackgroundCoderReservation,
	releasePreparedBackgroundAdvisories,
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

export interface PreparedBackgroundAdvisories {
	preparationId: string;
	eventIds: string[];
	messages: string[];
}

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

	const event = async (input: { event: unknown }): Promise<void> => {
		if (!config.enabled) return;
		try {
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
				(envelope.state !== 'completed' && envelope.state !== 'error')
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

			let pending = lookup.record;
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

			const text =
				envelope.state === 'error'
					? (envelope.errorText ?? '')
					: (envelope.resultText ?? '');
			const result: BackgroundDelegationResult = {
				...(envelope.state === 'error' ? { error: text } : { text }),
				chars: envelope.resultChars ?? text.length,
				truncated: envelope.resultTruncated ?? false,
				digest: digest(text),
			};
			const terminal: BackgroundTerminalResult = {
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
			const isDuplicate = terminalClaim.disposition === 'duplicate';
			let record = terminalClaim.record;
			opts.onTerminalClaimed?.(record);

			if (terminal.status !== 'completed') {
				if (isDuplicate) {
					// Duplicate error/cancelled event: scope was already preserved
					// on first processing; just return without re-discarding.
					return;
				}
				if (record.normalizedAgent === 'coder' && !record.worktree) {
					await releaseCoderReservation(directory, record, 'recovered');
				}
				discardScopeForRecord(record);
				await publishAdvisory(
					directory,
					record,
					terminal.eventId,
					terminal.status === 'cancelled' ? 'cancelled' : 'failed',
				);
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
							applied.stale ? 'stale' : 'ingestion failed',
						);
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

			// After successful ingestion, discard the reviewer scope claim
			// so the claimed scope generation is consumed.
			if (record.normalizedAgent === 'reviewer') {
				discardScopeForRecord(record);
			}

			if (record.normalizedAgent === 'coder') {
				await releaseCoderReservation(directory, record, 'consumed');
			}
			await publishAdvisory(
				directory,
				record,
				terminal.eventId,
				record.normalizedAgent === 'coder'
					? 'completed and settled'
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

async function releaseCoderReservation(
	directory: string,
	record: BackgroundDelegationRecord,
	reason: 'consumed' | 'recovered',
): Promise<void> {
	if (!record.coderReservationId) return;
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
	const stored = await putPendingBackgroundAdvisory(
		directory,
		record.correlationId,
		{
			eventId,
			parentSessionId: record.parentSessionId,
			message,
		},
	);
	if (!stored) return;
	const session = swarmState.agentSessions.get(record.parentSessionId);
	if (session) {
		pushAdvisory(session, stored.message);
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
