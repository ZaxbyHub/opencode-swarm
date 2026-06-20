/**
 * Background subagent completion observer/ingester.
 *
 * Trusted synthetic background completions always settle the durable
 * background-delegation ledger. Correctness-critical Stage B completions then
 * pass through workspace freshness validation before gate evidence, receipts, or
 * task workflow state can advance.
 */

import { createHash } from 'node:crypto';
import * as logger from '../utils/logger.js';
import {
	appendDelegationTransition,
	findByCorrelationId,
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
}): {
	event: (input: { event: unknown }) => Promise<void>;
} {
	const { config, directory } = opts;

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
				pending.status !== 'ingestion_error'
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
			if (
				envelope.state === 'completed' &&
				isBackgroundGateBearingRecord(pending)
			) {
				const freshness = validateStageBWorkspace(directory, pending);
				if (freshness.stale) {
					const reason =
						freshness.reason ??
						'workspace changed before background Stage B completion';
					await appendDelegationTransition(directory, envelope.sessionId, {
						status: 'stale',
						result: {
							error: reason,
							chars: reason.length,
							truncated: false,
							digest: digest(reason),
						},
					});
					logger.warn(
						`[background] stale Stage B completion ignored: agent=${pending.normalizedAgent} task=${pending.evidenceTaskId ?? pending.planTaskId ?? 'unknown'} reason=${reason}`,
					);
					return;
				}
			}
			const terminal = await appendDelegationTransition(
				directory,
				envelope.sessionId,
				{
					status: envelope.state === 'error' ? 'error' : 'completed',
					result,
				},
			);

			if (envelope.state === 'completed' && terminal) {
				const ingested = await ingestBackgroundStageBCompletion({
					directory,
					record: terminal,
					result: terminal.result ?? result,
				});
				if (ingested.consumed) {
					await appendDelegationTransition(directory, envelope.sessionId, {
						status: 'consumed',
					});
				}
				if (!ingested.ok) {
					await appendDelegationTransition(directory, envelope.sessionId, {
						status: 'ingestion_error',
						result: terminal.result ?? result,
					});
					logger.warn(
						`[background] Stage B completion was not applied: agent=${terminal.normalizedAgent} task=${terminal.evidenceTaskId ?? terminal.planTaskId ?? 'unknown'} reason=${ingested.reason ?? 'unknown'}`,
					);
				}
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
