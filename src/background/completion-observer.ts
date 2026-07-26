/**
 * Background subagent completion observer/ingester.
 *
 * Trusted synthetic background completions always settle the durable
 * background-delegation ledger. Correctness-critical Stage B completions then
 * pass through workspace freshness validation before gate evidence, receipts, or
 * task workflow state can advance.
 */

import { createHash } from 'node:crypto';
import type { ReviewerReceiptValidationOptions } from '../hooks/review-receipt-collector.js';
import {
	discardReviewerScopeGenerationClaim,
	discardReviewerScopeGenerationForCoderCall,
} from '../state.js';
import * as logger from '../utils/logger.js';
import {
	appendDelegationTransition,
	claimDelegationIngestion,
	findByCorrelationId,
	settleDelegationIngestion,
} from './pending-delegations.js';
import {
	ingestBackgroundStageBCompletion,
	isBackgroundGateBearingRecord,
	validateStageBWorkspace,
} from './stage-b-gates.js';
import { parseTaskEnvelope } from './task-envelope.js';

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

export function createBackgroundCompletionObserver(opts: {
	config: ObserverConfig;
	directory: string;
	reviewerReceiptOptions?: ReviewerReceiptValidationOptions;
}): {
	event: (input: { event: unknown }) => Promise<void>;
} {
	const { config, directory, reviewerReceiptOptions } = opts;

	const event = async (input: { event: unknown }): Promise<void> => {
		if (!config.enabled) return;
		try {
			const evt = input?.event as MaybeEvent | undefined;
			if (!evt || evt.type !== 'message.part.updated') return;
			const part = evt.properties?.part as MaybeTextPart | undefined;
			if (!part || part.type !== 'text') return;

			if (part.synthetic !== true) return;
			if (typeof part.text !== 'string') return;

			const envelope = parseTaskEnvelope(part.text);
			if (!envelope) return;
			if (envelope.state !== 'completed' && envelope.state !== 'error') return;

			const pending = findByCorrelationId(directory, envelope.sessionId);
			const parentSessionId =
				typeof part.sessionID === 'string' ? part.sessionID : 'unknown';

			if (!pending) {
				logger.log(
					`[background] observed synthetic completion (state=${envelope.state}) for subagent ${envelope.sessionId} in parent ${parentSessionId} with NO matching pending record - ignored`,
				);
				return;
			}
			if (pending.parentSessionId !== parentSessionId) {
				logger.warn(
					`[background] observed synthetic completion for ${envelope.sessionId} with parent mismatch: expected=${pending.parentSessionId} observed=${parentSessionId}; ignored`,
				);
				return;
			}
			if (
				pending.status !== 'pending' &&
				pending.status !== 'running' &&
				pending.status !== 'ingestion_error' &&
				pending.status !== 'ingesting'
			) {
				logger.log(
					`[background] observed duplicate/late completion for ${envelope.sessionId}; current status=${pending.status}; ignored`,
				);
				return;
			}

			const text =
				envelope.state === 'error'
					? (envelope.errorText ?? '')
					: (envelope.resultText ?? '');
			const result = {
				...(envelope.state === 'error' ? { error: text } : { text }),
				chars: envelope.resultChars ?? text.length,
				truncated: envelope.resultTruncated ?? false,
				digest: digest(text),
			};
			const taskId = pending.evidenceTaskId ?? pending.planTaskId;
			const discardTerminalScope = (): void => {
				if (!taskId) return;
				if (pending.normalizedAgent === 'reviewer') {
					discardReviewerScopeGenerationClaim({
						parentSessionID: pending.parentSessionId,
						taskId,
						reviewerCallID: pending.callID,
					});
				} else if (pending.normalizedAgent === 'coder') {
					discardReviewerScopeGenerationForCoderCall({
						parentSessionID: pending.parentSessionId,
						taskId,
						coderCallID: pending.callID,
					});
				}
			};
			if (
				envelope.state === 'completed' &&
				isBackgroundGateBearingRecord(pending)
			) {
				const freshness = validateStageBWorkspace(directory, pending);
				if (freshness.stale) {
					const reason =
						freshness.reason ??
						'workspace changed before background Stage B completion';
					const stale = await appendDelegationTransition(
						directory,
						envelope.sessionId,
						{
							status: 'stale',
							result: {
								error: reason,
								chars: reason.length,
								truncated: false,
								digest: digest(reason),
							},
						},
					);
					if (stale?.status === 'stale') discardTerminalScope();
					logger.warn(
						`[background] stale Stage B completion ignored: agent=${pending.normalizedAgent} task=${pending.evidenceTaskId ?? pending.planTaskId ?? 'unknown'} reason=${reason}`,
					);
					return;
				}
			}
			const terminal =
				pending.status === 'ingesting'
					? pending
					: await appendDelegationTransition(directory, envelope.sessionId, {
							status: envelope.state === 'error' ? 'error' : 'completed',
							result,
						});

			const hasEvidenceTask =
				typeof (pending.evidenceTaskId ?? pending.planTaskId) === 'string';
			const requiresIngestion =
				hasEvidenceTask &&
				(pending.normalizedAgent === 'coder' ||
					isBackgroundGateBearingRecord(pending));
			if (envelope.state === 'completed' && terminal && requiresIngestion) {
				const claim = await claimDelegationIngestion(
					directory,
					envelope.sessionId,
					result.digest,
				);
				if (claim.outcome !== 'claimed') {
					logger.log(
						`[background] completion ingestion not claimed for ${envelope.sessionId}; outcome=${claim.outcome}`,
					);
					return;
				}
				const ingested = await ingestBackgroundStageBCompletion({
					directory,
					record: claim.record,
					result: claim.record.result ?? result,
					reviewerReceiptOptions,
				});
				if (ingested.consumed) {
					await settleDelegationIngestion(
						directory,
						envelope.sessionId,
						claim.ingestionId,
						{ status: 'consumed' },
					);
				}
				if (!ingested.ok) {
					await settleDelegationIngestion(
						directory,
						envelope.sessionId,
						claim.ingestionId,
						{
							status: 'ingestion_error',
							result: claim.record.result ?? result,
						},
					);
					logger.warn(
						`[background] Stage B completion was not applied: agent=${claim.record.normalizedAgent} task=${claim.record.evidenceTaskId ?? claim.record.planTaskId ?? 'unknown'} reason=${ingested.reason ?? 'unknown'}`,
					);
				}
			}
			if (envelope.state === 'error' && terminal?.status === 'error') {
				discardTerminalScope();
			}

			logger.log(
				`[background] observed trusted completion (state=${envelope.state}) correlated to pending delegation: ` +
					`agent=${pending.normalizedAgent} task=${pending.evidenceTaskId ?? pending.planTaskId ?? 'unknown'} ` +
					`parent=${pending.parentSessionId} observedParent=${parentSessionId} pendingStatus=${pending.status} ` +
					`stageB=${isBackgroundGateBearingRecord(pending)}`,
			);
		} catch (err) {
			logger.warn(
				`[background] completion observer error: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	};

	return { event };
}

function digest(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}
