/**
 * Final context accounting (#2107 §3).
 *
 * ONE final accounting step, run after every injector has contributed and after
 * `consolidateSystemMessagesInPlace` — the last structure-mutating handler in
 * the `experimental.chat.messages.transform` chain. It measures the actual
 * final model-visible surface exactly once:
 *
 * - `output.messages` (post-consolidation; carries every messages-chain
 *   injection: knowledge, memory recall, the advisory block) via
 *   `computeContextUsage`, which prefers provider-reported token usage when the
 *   latest assistant message carries it;
 * - PLUS the system chain's `output.system` content (system-enhancer banners,
 *   context capsules, the swarm-command banner). Those bytes live in a separate
 *   output structure the messages chain never sees and consolidation never
 *   merges (docs/context-map.md; engineering-invariants § v6.85.1), so they are
 *   added from the per-turn injection ledger's `surface: 'system'` emissions.
 *   Messages-surface producers are attribution-only — their bytes are already
 *   inside the measurement and are NEVER added again.
 *
 * The limit is resolved through the exact same ladder physical pruning uses
 * (`resolveModelLimit` with `context_budget.model_limits` overrides and the
 * live `model.limit.context` relayed from the system.transform hook), so the
 * warning/critical thresholds here are the same thresholds, against the same
 * denominator, that `context-budget.ts` enforces. A 128K–1M-window model can
 * no longer receive a warning computed against a phantom denominator.
 *
 * The warning this step emits is bounded, advisory-only (it never removes
 * content and says so), suppressed to once per session per band, and its own
 * token cost is included in the recorded total AND recorded as a ledger
 * emission — it cannot escape accounting. Fail-open by design: an accounting
 * failure must never break request composition.
 */

import type { PluginConfig } from '../config/index.js';
import {
	getTurnLedgerSummary,
	recordProducerEmission,
} from '../services/injection-budget.js';
import {
	getLiveContextModelIdentity,
	getLiveContextWindow,
	setFinalPromptPressure,
} from '../state.js';
import { log } from '../utils/logger.js';
import { computeContextUsage } from './context-usage.js';
import type { MessageWithParts } from './knowledge-types.js';
import {
	extractModelInfo,
	extractSessionId,
	resolveModelLimit,
} from './model-limits.js';
import { estimateTokens } from './utils.js';

interface FinalAccountingOptions {
	config: PluginConfig;
}

/**
 * Bounded one-shot-per-band warning suppression (AGENTS.md invariant 8).
 * Keyed by sessionID; FIFO-evicted past the cap.
 */
const warningBandSentBySession = new Map<
	string,
	{ warn: boolean; critical: boolean }
>();
const MAX_TRACKED_WARNING_SESSIONS = 256;

function evictionGuard(sessionID: string): void {
	if (
		!warningBandSentBySession.has(sessionID) &&
		warningBandSentBySession.size >= MAX_TRACKED_WARNING_SESSIONS
	) {
		const oldest = warningBandSentBySession.keys().next().value;
		if (oldest !== undefined && oldest !== sessionID) {
			warningBandSentBySession.delete(oldest);
		}
	}
}

/** Test seam: clear warning-suppression state. */
export function _resetFinalAccountingState(): void {
	warningBandSentBySession.clear();
}

export function createFinalContextAccountingStep(
	options: FinalAccountingOptions,
): (
	input: unknown,
	output: { messages?: MessageWithParts[] },
) => Promise<void> {
	const { config } = options;

	return async (_input: unknown, output: { messages?: MessageWithParts[] }) => {
		const messages = output?.messages;
		if (!messages || messages.length === 0) return;

		try {
			const sessionID = extractSessionId(messages);
			if (!sessionID) return;

			// Respect a full context_budget opt-out.
			if (config.context_budget?.enabled === false) return;

			// Model identity ladder — identical to context-budget.ts so this step
			// and physical pruning always agree on the denominator. The live
			// identity/window is relayed from the system.transform hook via
			// session state (this chain receives messages but no Model).
			const liveModelInfo = getLiveContextModelIdentity(sessionID);
			const { modelID, providerID } =
				liveModelInfo ?? extractModelInfo(messages);
			const liveContextLimit = getLiveContextWindow(sessionID, {
				modelID,
				providerID,
			});
			const modelLimit = resolveModelLimit(
				modelID,
				providerID,
				config.context_budget?.model_limits ?? {},
				liveContextLimit,
			);
			if (modelLimit <= 0) return;

			// Measure the final messages surface exactly once. Provider-reported
			// usage (latest assistant info.tokens + estimated tail) is preferred
			// over the pure estimate.
			const usage = computeContextUsage(messages);

			// System-surface emissions from the turn ledger (bytes that live in
			// output.system and are therefore invisible here). Messages-surface
			// producers are skipped: their bytes are already in `usage`.
			const ledger = getTurnLedgerSummary(sessionID);
			let systemSurfaceTokens = 0;
			if (ledger) {
				for (const producer of ledger.producers) {
					if (producer.surface === 'system') {
						systemSurfaceTokens += producer.emitted;
					}
				}
			}

			let usedTokens = usage.tokensUsed + systemSurfaceTokens;
			const warnThreshold = config.context_budget?.warn_threshold ?? 0.7;
			const criticalThreshold =
				config.context_budget?.critical_threshold ?? 0.9;

			// Single fixed-point pass: the warning text and its token cost are
			// computed FIRST; the band is evaluated on the pre-warning total, so
			// the warning can never push itself across a band and re-trigger.
			const pctWithout = (usedTokens / modelLimit) * 100;
			const band: 'critical' | 'warn' | 'ok' =
				pctWithout / 100 > criticalThreshold
					? 'critical'
					: pctWithout / 100 > warnThreshold
						? 'warn'
						: 'ok';

			let warningText = '';
			if (band !== 'ok') {
				evictionGuard(sessionID);
				let bandState = warningBandSentBySession.get(sessionID);
				if (!bandState) {
					bandState = { warn: false, critical: false };
					warningBandSentBySession.set(sessionID, bandState);
				}
				if (
					(band === 'critical' && !bandState.critical) ||
					(band === 'warn' && !bandState.warn)
				) {
					const pctStr = Math.min(999, Math.round(pctWithout)).toString();
					const limitK = Math.round(modelLimit / 1000);
					const source =
						usage.source === 'provider'
							? 'provider-reported usage + estimated tail'
							: 'chars→tokens heuristic estimate';
					warningText =
						band === 'critical'
							? `[CONTEXT PRESSURE — CRITICAL (estimated): ~${pctStr}% of the ~${limitK}K-token window (${source}). Consider compacting now or offloading detail to .swarm/context.md. Advisory only — this message removed no content.]\n\n`
							: `[CONTEXT PRESSURE (estimated): ~${pctStr}% of the ~${limitK}K-token window (${source}). Consider compaction at the next phase boundary. Advisory only — this message removed no content.]\n\n`;
					if (band === 'critical') bandState.critical = true;
					else bandState.warn = true;
				}
			}

			if (warningText) {
				const warningTokens = estimateTokens(warningText);
				// In-place prepend to the last user message's first text part.
				// NEVER reassign output.messages (AGENTS.md invariant 10).
				for (let i = messages.length - 1; i >= 0; i--) {
					if (messages[i]?.info?.role !== 'user') continue;
					const parts = messages[i]?.parts;
					if (!parts) break;
					const textPart = parts.find(
						(p) => p?.type === 'text' && typeof p.text === 'string',
					);
					if (textPart) {
						textPart.text = `${warningText}${textPart.text ?? ''}`;
					}
					break;
				}
				// The warning's own cost is part of the accounted total and is
				// recorded as a ledger emission — it cannot escape accounting.
				recordProducerEmission(
					sessionID,
					'final-accounting-warning',
					warningTokens,
					0,
					'messages',
				);
				usedTokens += warningTokens;
			}

			const pct = (usedTokens / modelLimit) * 100;
			setFinalPromptPressure(sessionID, {
				pct,
				usedTokens,
				limitTokens: modelLimit,
				estimatorSource:
					usage.source === 'provider'
						? 'provider-reported + canonical-estimated tail'
						: 'canonical char→token heuristic (0.33 tok/char)',
				providerReported: usage.source === 'provider',
			});

			log(
				`[swarm] Final context accounting: session=${sessionID} used=${usedTokens} limit=${modelLimit} pct=${pct.toFixed(1)}% source=${usage.source} systemSurface=${systemSurfaceTokens}`,
			);
		} catch (error) {
			// Fail-open: accounting must never break request composition.
			log(
				'[swarm] Final context accounting failed (non-fatal):',
				error instanceof Error ? error.message : String(error),
			);
		}
	};
}
