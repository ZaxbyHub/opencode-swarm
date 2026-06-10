/**
 * Background subagent completion OBSERVER (issue #1151, PR 2 Stage A).
 *
 * Registers as a swarm `event` hook to watch for the upstream background-completion signal:
 * a message part with `synthetic === true` whose text is a task envelope with
 * `state="completed"` or `state="error"`. When such a part correlates to a durable pending
 * background-delegation record, it is logged (debug-gated) as the empirical confirmation
 * instrument operators use to verify the runtime signal in a real environment.
 *
 * Stage A is strictly READ-ONLY: this observer NEVER advances workflow gates, records gate
 * evidence, or mutates the durable store. Gate-affecting completion ingestion is Stage B,
 * gated on runtime confirmation produced by exactly this observer.
 *
 * The `synthetic` flag is the trust gate (set by OpenCode, not the model/user). Non-synthetic
 * text that merely looks like an envelope is ignored. The observer is fail-open: any error is
 * swallowed so it can never block event delivery or plugin load (Invariant 1/10).
 */

import * as logger from '../utils/logger.js';
import { findByCorrelationId } from './pending-delegations.js';
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
 * Build the Stage A completion observer. Returns an `event` handler suitable for the
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
					`[background] observed synthetic completion (state=${envelope.state}) for subagent ${envelope.sessionId} in parent ${parentSessionId} with NO matching pending record — ignored (Stage A observe-only)`,
				);
				return;
			}

			logger.log(
				`[background] observed trusted completion (state=${envelope.state}) correlated to pending delegation: ` +
					`agent=${pending.normalizedAgent} task=${pending.evidenceTaskId ?? pending.planTaskId ?? 'unknown'} ` +
					`parent=${pending.parentSessionId} observedParent=${parentSessionId} pendingStatus=${pending.status} ` +
					'(Stage A observe-only — no gate effect; Stage B will ingest completion)',
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
