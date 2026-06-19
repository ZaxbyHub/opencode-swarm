/**
 * Background subagent completion observer/ingester.
 *
 * Registers as a swarm `event` hook to watch for the upstream background-completion signal:
 * a message part with `synthetic === true` whose text is a task envelope with
 * `state="completed"` or `state="error"`. When such a part correlates to a durable pending
 * background-delegation record, it is logged (debug-gated) as the empirical confirmation
 * instrument operators use to verify the runtime signal in a real environment.
 *
 * PR1 async advisory lanes ingest trusted terminal completions into the durable
 * background-delegation ledger only. This still NEVER advances workflow gates or records
 * gate evidence; gate-bearing execution is intentionally outside this advisory path.
 *
 * The `synthetic` flag is the trust gate (set by OpenCode, not the model/user). Non-synthetic
 * text that merely looks like an envelope is ignored. The observer is fail-open: any error is
 * swallowed so it can never block event delivery or plugin load (Invariant 1/10).
 */

import { createHash } from 'node:crypto';
import * as logger from '../utils/logger.js';
import {
	appendDelegationTransition,
	findByCorrelationId,
} from './pending-delegations.js';
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

/**
 * Build the background completion observer. Returns an `event` handler suitable for the
 * OpenCode plugin `event` hook. No-op (cheap early return) when the feature is disabled.
 */
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

			// Trust gate: only OpenCode-set synthetic parts are considered.
			if (part.synthetic !== true) return;
			if (typeof part.text !== 'string') return;

			const envelope = parseTaskEnvelope(part.text);
			if (!envelope) return;
			// Only terminal states are completion signals; running placeholders are dispatch.
			if (envelope.state !== 'completed' && envelope.state !== 'error') return;

			const pending = findByCorrelationId(directory, envelope.sessionId);
			const parentSessionId =
				typeof part.sessionID === 'string' ? part.sessionID : 'unknown';

			if (!pending) {
				// Synthetic completion with no matching durable record — log for visibility
				// but take no action (could be a non-swarm background task or a spoof).
				logger.log(
					`[background] observed synthetic completion (state=${envelope.state}) for subagent ${envelope.sessionId} in parent ${parentSessionId} with NO matching pending record — ignored`,
				);
				return;
			}
			if (pending.parentSessionId !== parentSessionId) {
				logger.warn(
					`[background] observed synthetic completion for ${envelope.sessionId} with parent mismatch: expected=${pending.parentSessionId} observed=${parentSessionId}; ignored`,
				);
				return;
			}
			if (pending.status !== 'pending' && pending.status !== 'running') {
				logger.log(
					`[background] observed duplicate/late completion for ${envelope.sessionId}; current status=${pending.status}; ignored`,
				);
				return;
			}

			const text =
				envelope.state === 'error'
					? (envelope.errorText ?? '')
					: (envelope.resultText ?? '');
			await appendDelegationTransition(directory, envelope.sessionId, {
				status: envelope.state === 'error' ? 'error' : 'completed',
				result: {
					...(envelope.state === 'error' ? { error: text } : { text }),
					chars: envelope.resultChars ?? text.length,
					truncated: envelope.resultTruncated ?? false,
					digest: digest(text),
				},
			});

			logger.log(
				`[background] observed trusted completion (state=${envelope.state}) correlated to pending delegation: ` +
					`agent=${pending.normalizedAgent} task=${pending.evidenceTaskId ?? pending.planTaskId ?? 'unknown'} ` +
					`parent=${pending.parentSessionId} observedParent=${parentSessionId} pendingStatus=${pending.status} ` +
					'(advisory ledger update only — no gate effect)',
			);
		} catch (err) {
			// Fail-open: never block event delivery.
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
