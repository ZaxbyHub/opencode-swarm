/**
 * Messages Transform Handler Factory
 *
 * Extracted from guardrails.ts. Creates the messagesTransform handler
 * used by createGuardrailsHooks. The factory receives shared configuration
 * and closures from the guardrails hooks factory, so the handler can
 * inject warnings, detect loops, and enforce QA gate compliance.
 */

import { getSwarmAgents } from '../../agents/index';
import { parseAgentModel } from '../../config/agent-model';
import {
	isLowCapabilityModel,
	ORCHESTRATOR_NAME,
} from '../../config/constants';
import {
	type GuardrailsConfig,
	stripKnownSwarmPrefix,
} from '../../config/schema';
import { loadPlan } from '../../plan/manager';
import { getActiveWindow, swarmState } from '../../state';
import { telemetry } from '../../telemetry.js';
import { log } from '../../utils';
import { pushAdvisory } from '../../utils/advisory-queue';
import {
	extractStatusCode,
	TRANSIENT_MODEL_ERROR_PATTERN,
	TRANSIENT_STATUS_CODES,
} from '../../utils/provider-error-classification';
import { extractCurrentPhaseFromPlan } from '../extractors';
import { extractModelInfo } from '../model-limits';
import { isExecutionEpisodeArmed } from './execution-episode';
import { hashArgs } from './file-authority';

/**
 * Shared context passed from createGuardrailsHooks to the messagesTransform factory.
 */
export interface MessagesTransformContext {
	/** Resolved working directory for the guardrails hooks */
	effectiveDirectory: string;
	/** Resolved guardrails configuration */
	cfg: GuardrailsConfig;
	/** Required QA gates tool names */
	requiredQaGates: string[];
	/** Whether reviewer/test_engineer delegation is required */
	requireReviewerAndTestEngineer: boolean;
	/** Shared consecutiveNoToolTurns Map (also used by toolBefore) */
	consecutiveNoToolTurns: Map<string, number>;
	/**
	 * Issue #2063 B3 — sessionID → id of the most recent assistant message that
	 * was counted by the MEDIUM band of the runaway detector.
	 *
	 * Keyed on the host message id and NEVER on an array index: compaction
	 * rewrites the window, so an index recorded on one turn points at a
	 * different message on the next. The marker exists so the counter can be
	 * reset when the USER speaks after the counted turn — a user reply means the
	 * "model is narrating instead of acting" hypothesis is no longer the right
	 * explanation for the silence.
	 */
	lastCountedAssistantMsgId: Map<string, string>;
	/** Resolve an explicit model for the exact incoming agent, when available. */
	resolveAgentModel?: (agentName: string) => string | undefined;
}

// ---- Module-level helpers used exclusively by the messagesTransform handler ----

type ChatMessageLike = {
	/**
	 * `id` is a real host-message field (see `src/hooks/pr-workflow-auto-wake.ts`,
	 * which reads `info.id` off host session/message envelopes). It is optional
	 * here because synthetic messages this plugin itself unshifts carry no id.
	 */
	info?: { role?: string; sessionID?: string; id?: string };
	parts?: Array<{ type?: string; text?: unknown }>;
};

const TRANSIENT_PROVIDER_RECOVERY_TAG = 'TRANSIENT PROVIDER RECOVERY';

/**
 * Shared by the runaway-output advisory's TEXT and its once-per-drain dedupe
 * predicate, so the two can never drift apart again. They previously did: the
 * predicate tested for the string 'runaway output', which the pushed message
 * never contained, making the guard permanently inert.
 */
export const RUNAWAY_OUTPUT_ADVISORY_MARKER =
	'Model is generating analysis without taking action';

/**
 * Lower bound of the runaway detector's MEDIUM band (issue #2063 B3), and the
 * same threshold below which a tool-less assistant turn is treated as a short
 * acknowledgement and RESETS the counter.
 *
 * One constant, two call sites, deliberately: the reset boundary and the
 * counting boundary must be the same number or the band between them either
 * double-counts or silently swallows turns. Exported so tests pin the real
 * value instead of a hand-copied literal.
 *
 * The medium band only counts while an execution episode is armed
 * ({@link isExecutionEpisodeArmed}). Ordinary conversation produces plenty of
 * 200–4000 char replies with no tool calls, and treating those as a runaway is
 * the false-positive class this gate exists to prevent. Above 4000 chars the
 * behaviour is unchanged and NOT episode-gated.
 */
export const RUNAWAY_MEDIUM_MIN = 200;

/**
 * Issue #2063 B3 — bound on {@link MessagesTransformContext.lastCountedAssistantMsgId}.
 *
 * AGENTS.md invariant 8: session-keyed state needs an explicit eviction
 * strategy. Least-recently-written wins (delete-before-set), matching the no-op
 * detector's LRU in `guardrails/index.ts` and for the same reason — plain
 * insertion order would evict the long-lived architect session first.
 */
export const MAX_TRACKED_COUNTED_ASSISTANT_MSGS = 200;

function rememberCountedAssistantMsg(
	map: Map<string, string>,
	sessionId: string,
	messageId: string,
): void {
	map.delete(sessionId);
	map.set(sessionId, messageId);
	while (map.size > MAX_TRACKED_COUNTED_ASSISTANT_MSGS) {
		const stalest = map.keys().next().value;
		if (stalest === undefined) break;
		map.delete(stalest);
	}
}

/**
 * Prefix identifying a PRM course correction in the advisory queue
 * (issue #2063 C1).
 *
 * Shared with the producer's test so the forward filter and the rendered
 * dedupe key (`[prm:<pattern>:<level>]`, built in `src/prm/index.ts`) cannot
 * drift apart. This file already carries the scar of exactly that drift:
 * {@link RUNAWAY_OUTPUT_ADVISORY_MARKER} exists because a predicate once tested
 * for a string no producer emitted, leaving the guard permanently inert. A
 * hand-copied literal in a fixture would re-arm the same failure.
 */
export const PRM_ADVISORY_FORWARD_PREFIX = '[prm:';

/**
 * Tier-0 test seam (zero mocks) for the pure LRU helper above. Production code
 * calls the local binding; this exists so the eviction bound required by
 * AGENTS.md invariant 8 can be asserted directly instead of by driving 200+
 * sessions through the whole handler.
 */
export const _test_exports = { rememberCountedAssistantMsg };

/**
 * Drain-level byte budget for the architect [ADVISORIES] block (issue #1976).
 *
 * Advisories are prepended AFTER token accounting and therefore escape the
 * context-budget handler; without a bound, a single turn with many producers
 * (or a handful of large ones) can flood the architect prompt — the same
 * failure mode that produced the PR_REVIEW banner flood (55.3% of non-blank
 * lines in a real transcript).
 *
 * This is a defense-in-depth backstop behind the per-producer
 * `pushAdvisory` helper (dedupe + length cap). When the joined block exceeds
 * the budget, the OLDEST entries are dropped (keep-latest) because high-value
 * advisories tend to arrive LATE in a turn — "keep earliest" is a priority
 * inversion called out in the issue. Truncation is disclosed in the block
 * header so the architect knows recent items were retained over earlier ones.
 */
// Exported so tests pin the real budget instead of a hand-copied literal
// (issue #2063 C1 added a second consumer of both constants).
export const MAX_ADVISORY_BLOCK_BYTES = 6000;
export const ADVISORY_TRUNCATION_NOTE =
	'[advisory block truncated to keep highest-value recent items]';

/**
 * Bound a set of advisory strings to a total byte budget, keeping the latest
 * (dropping oldest from the front). Returns the kept entries and whether any
 * were dropped. Never drops below a single entry (a single oversized advisory
 * is kept verbatim rather than rendered empty).
 */
export function boundAdvisoryBytes(
	advisories: string[],
	maxBytes: number,
): { kept: string[]; truncated: boolean } {
	const kept = [...advisories];
	const sizeOf = (arr: string[]) => arr.reduce((n, m) => n + m.length + 5, 0); // 5 = '\n---\n' separator
	while (sizeOf(kept) > maxBytes && kept.length > 1) {
		kept.shift();
	}
	return { kept, truncated: kept.length < advisories.length };
}

function getMessageText(message: ChatMessageLike | undefined): string {
	if (!message?.parts) return '';
	return message.parts
		.filter((part) => part?.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text as string)
		.join('\n');
}

export function getMostRecentAssistantText(
	messages: ChatMessageLike[],
): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.info?.role === 'assistant') {
			return getMessageText(messages[i]);
		}
	}
	return '';
}

export function isTransientProviderFailureText(text: string): boolean {
	if (!text.trim()) return false;
	const providerFailureMarker =
		/provider[_\s-]?unavailable|network\s+connection\s+lost|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|broken.?pipe|dns(?:[\s_-]+(?:resolution)?)?[\s_-]+fail|name.?not.?resolved|EAI_AGAIN|connection\s+reset|connection\s+refused/i.test(
			text,
		);
	if (!providerFailureMarker) return false;

	const status = extractStatusCode(text);
	const hasTransientStatus =
		status !== null && TRANSIENT_STATUS_CODES.has(status);
	return hasTransientStatus || TRANSIENT_MODEL_ERROR_PATTERN.test(text);
}

export function getProviderFailureFingerprint(text: string): string {
	return String(hashArgs({ providerFailure: text.slice(-4000) }));
}

/**
 * Creates a messagesTransform handler with the given shared context.
 *
 * @param ctx Shared configuration and closures from createGuardrailsHooks
 * @returns The messagesTransform handler function
 */
export function createMessagesTransformHandler(ctx: MessagesTransformContext) {
	const {
		effectiveDirectory,
		cfg,
		requiredQaGates,
		requireReviewerAndTestEngineer,
		consecutiveNoToolTurns,
		lastCountedAssistantMsgId,
	} = ctx;

	return async (
		_input: Record<string, never>,
		output: {
			messages?: Array<{
				// `id` (issue #2063 B3): host message identity, used to anchor the
				// medium-band counter's user-message reset. Optional — synthetic
				// system messages this handler unshifts carry none.
				info: {
					role: string;
					agent?: string;
					sessionID?: string;
					id?: string;
				};
				parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
			}>;
		},
	): Promise<void> => {
		const messages = output.messages;
		if (!messages || messages.length === 0) {
			return;
		}

		// Find the last message
		const lastMessage = messages[messages.length - 1];

		// Determine sessionID from the last message — if absent, skip injection
		const sessionId: string | undefined = lastMessage.info?.sessionID;
		if (!sessionId) {
			return;
		}
		const session = swarmState.agentSessions.get(sessionId);
		const activeAgent =
			swarmState.activeAgent.get(sessionId) ?? session?.agentName;
		const targetAgent = [...messages]
			.reverse()
			.find(
				(message) =>
					message.info?.role === 'user' &&
					typeof message.info.agent === 'string' &&
					message.info.agent.length > 0,
			)?.info.agent;

		// v6.21 Task 4.5: Tier-based behavioral prompt trimming for low-capability models
		{
			const configuredModel = targetAgent
				? ctx.resolveAgentModel?.(targetAgent)
				: undefined;
			const targetModel = configuredModel
				? parseAgentModel(configuredModel)
				: undefined;
			const { modelID } = targetModel ?? extractModelInfo(messages);
			if (modelID && isLowCapabilityModel(modelID)) {
				for (const msg of messages) {
					if (msg.info?.role !== 'system') continue;
					for (const part of msg.parts) {
						try {
							if (part == null) continue;
							if (part.type !== 'text' || typeof part.text !== 'string')
								continue;
							if (!part.text.includes('<!-- BEHAVIORAL_GUIDANCE_START -->'))
								continue;
							part.text = part.text.replace(
								/<!--\s*BEHAVIORAL_GUIDANCE_START\s*-->[\s\S]*?<!--\s*BEHAVIORAL_GUIDANCE_END\s*-->/g,
								'[Enforcement: programmatic gates active]',
							);
						} catch (error) {
							log('[Guardrails] behavioral guidance replacement failed', {
								error: error instanceof Error ? error.message : String(error),
							});
						}
					}
				}
			}
		}

		// v6.12: Self-coding warning injection - now injected into SYSTEM messages only (model-only)
		const isArchitectSession = activeAgent
			? stripKnownSwarmPrefix(activeAgent) === ORCHESTRATOR_NAME
			: session
				? stripKnownSwarmPrefix(session.agentName) === ORCHESTRATOR_NAME
				: false;

		// #1896: model-divergence detection, scoped to the ARCHITECT/primary session
		// (its model is the UI-driven one; swarm fallback only mutates SUBAGENT
		// models, so this scoping avoids a false positive on a swarm-initiated
		// switch). Two one-shot advisories: (a) a model that silently changed across
		// an interrupt/resume, and (b) a configured architect model that the UI has
		// overridden (expected, since the primary's configured model is intentionally
		// not applied — surfaced so the mismatch does not silently confuse the run).
		if (isArchitectSession && session) {
			const { modelID, providerID } = extractModelInfo(messages);
			if (modelID) {
				const observedFull = providerID ? `${providerID}/${modelID}` : modelID;
				const previousObserved = session.lastObservedModel;

				// (a) Silent switch across a resume — compare like-with-like across the
				// interrupt, gated on no swarm fallback being in play (fallback resets
				// model_fallback_index to 0 on rehydrate, and never targets the primary).
				if (
					session.sessionRehydratedAt > 0 &&
					session.model_fallback_index === 0 &&
					previousObserved &&
					previousObserved !== observedFull &&
					!session.resumeModelAdvisoryDone
				) {
					pushAdvisory(
						session,
						`MODEL CHANGED ACROSS RESUME: this run previously observed model "${previousObserved}"; the active model is now "${observedFull}". If this switch was unintended, re-select the intended model (or use /swarm handoff) before continuing.`,
					);
					session.resumeModelAdvisoryDone = true;
				}

				// (b) Config-vs-UI clarification (fires once per session). Gated on
				// no fallback in play: the guardrails toolAfter path can mutate the
				// architect's swarmAgents model to a fallback value, and the observed
				// model would also be that fallback — both unreliable for a
				// "config vs UI" comparison while a fallback is active.
				if (
					!session.configModelAdvisoryDone &&
					session.model_fallback_index === 0
				) {
					const configuredArchitect = getSwarmAgents()?.architect?.model;
					if (
						configuredArchitect &&
						configuredArchitect !== observedFull &&
						configuredArchitect !== modelID
					) {
						pushAdvisory(
							session,
							`MODEL CONFIG NOTE: your config pins the architect to "${configuredArchitect}", but the UI has "${observedFull}" active. The UI selection wins for the primary/architect role (its configured model is intentionally not applied), so this difference is expected — switch the UI model if you meant to run "${configuredArchitect}".`,
						);
						session.configModelAdvisoryDone = true;
					}
				}

				session.lastObservedModel = observedFull;
				session.lastObservedProviderID = providerID;
			}
		}

		// Find system message(s) for model-only guidance injection
		const systemMessages = messages.filter(
			(msg) => msg.info?.role === 'system',
		);

		// v6.35.1: Runaway output detector — catch models streaming without tool calls
		if (isArchitectSession && session) {
			const lastAssistantText = getMostRecentAssistantText(
				messages as ChatMessageLike[],
			);
			if (isTransientProviderFailureText(lastAssistantText)) {
				const fingerprint = getProviderFailureFingerprint(lastAssistantText);
				const alreadyPending = session.pendingAdvisoryMessages?.some(
					(message: string) =>
						message.startsWith(TRANSIENT_PROVIDER_RECOVERY_TAG),
				);
				const alreadyInjected = systemMessages.some((message) =>
					getMessageText(message as ChatMessageLike).includes(
						TRANSIENT_PROVIDER_RECOVERY_TAG,
					),
				);
				if (
					session.lastProviderRecoveryFingerprint !== fingerprint &&
					!alreadyPending &&
					!alreadyInjected
				) {
					pushAdvisory(
						session,
						`${TRANSIENT_PROVIDER_RECOVERY_TAG}: The previous Architect response appears to have been interrupted by a transient provider/network error. On this turn, continue from the last stable step, inspect current repo or plan state if needed, and keep working instead of treating the interrupted response as task completion.`,
					);
					session.lastProviderRecoveryFingerprint = fingerprint;
				}
			} else {
				session.lastProviderRecoveryFingerprint = undefined;
			}
		}

		// Uses module-level consecutiveNoToolTurns Map for state across calls
		if (isArchitectSession) {
			// Issue #2063 B3: user-message reset. If the USER has spoken since the
			// assistant turn the MEDIUM band last counted, the accumulated count no
			// longer describes an unattended narration loop — it describes an
			// ongoing conversation. Anchored on the recorded message ID, never an
			// index: compaction rewrites the window and an index would silently
			// point at an unrelated message.
			const countedMsgId = lastCountedAssistantMsgId.get(sessionId);
			if (countedMsgId !== undefined) {
				const countedIdx = messages.findIndex(
					(m) => m.info?.id === countedMsgId,
				);
				if (countedIdx < 0) {
					// The counted turn is no longer in the window (compaction). The
					// marker can never match again, so drop it — but do NOT reset the
					// counter: absence is not evidence that the user replied.
					lastCountedAssistantMsgId.delete(sessionId);
				} else if (
					messages.slice(countedIdx + 1).some((m) => m.info?.role === 'user')
				) {
					consecutiveNoToolTurns.set(sessionId, 0);
					lastCountedAssistantMsgId.delete(sessionId);
				}
			}

			// Find the last assistant message in conversation
			let lastAssistantMsg: (typeof messages)[0] | undefined;
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].info?.role === 'assistant') {
					lastAssistantMsg = messages[i];
					break;
				}
			}

			if (lastAssistantMsg) {
				const lastHasToolUse = lastAssistantMsg.parts?.some(
					(part) => part.type === 'tool_use',
				);

				if (lastHasToolUse) {
					// Model used a tool — reset counter
					consecutiveNoToolTurns.set(sessionId, 0);
				} else {
					// Check if last assistant message was high-output
					const textLen =
						lastAssistantMsg.parts
							?.filter((p) => p.type === 'text' && typeof p.text === 'string')
							.reduce((sum, p) => sum + (p.text as string).length, 0) ?? 0;

					// Issue #2063 B3 — MEDIUM band. A stalled architect narrates in
					// 200–4000 char turns, well under the 4000-char bar, so the
					// original detector never saw the shape that actually occurs in
					// the field. Counting that band unconditionally would fire on
					// ordinary conversation, so it is gated two ways:
					//
					//   1. an execution episode must be ARMED — the session has
					//      actually attempted execution work this session; and
					//   2. the turn must carry a host message id, so the
					//      user-message reset above has something to anchor on.
					//      Without an id we decline to count rather than approximate
					//      with an array index that compaction invalidates.
					//
					// Above 4000 chars nothing changes: unconditional, no episode
					// gate, no id requirement (pre-existing behaviour, and the
					// existing runaway tests build messages with no id).
					const lastAssistantMsgId = lastAssistantMsg.info?.id;
					const isMediumBand = textLen >= RUNAWAY_MEDIUM_MIN && textLen <= 4000;
					const countsAsMedium =
						isMediumBand &&
						typeof lastAssistantMsgId === 'string' &&
						lastAssistantMsgId.length > 0 &&
						isExecutionEpisodeArmed(sessionId);

					if (countsAsMedium && lastAssistantMsgId) {
						rememberCountedAssistantMsg(
							lastCountedAssistantMsgId,
							sessionId,
							lastAssistantMsgId,
						);
					}

					if (textLen > 4000 || countsAsMedium) {
						const count = (consecutiveNoToolTurns.get(sessionId) ?? 0) + 1;
						consecutiveNoToolTurns.set(sessionId, count);

						const maxTurns = cfg.runaway_output_max_turns;
						if (count >= maxTurns) {
							// Hard STOP — inject into first system message
							const stopMsg = systemMessages[0];
							if (stopMsg) {
								const stopPart = (stopMsg.parts ?? []).find(
									(part): part is { type: string; text: string } =>
										part.type === 'text' && typeof part.text === 'string',
								);
								if (
									stopPart &&
									!stopPart.text.includes('RUNAWAY OUTPUT STOP')
								) {
									stopPart.text =
										`[RUNAWAY OUTPUT STOP]\n` +
										`You have produced ${count} consecutive responses without using any tools. ` +
										`You MUST call a tool in your next response.\n` +
										`[/RUNAWAY OUTPUT STOP]\n\n` +
										stopPart.text;
								}
							}
							// Reset counter after injection
							consecutiveNoToolTurns.set(sessionId, 0);
						} else if (count >= 3) {
							// Advisory warning at 3 consecutive. Dedupe is handled by
							// B6 (issue #1976): the dedupe predicate must match a
							// substring the pushed text actually contains. It previously
							// tested for 'runaway output' — a string no producer emits —
							// so the guard was permanently inert. RUNAWAY_OUTPUT_ADVISORY_MARKER
							// is shared by the text and the predicate so they cannot drift.
							if (session) {
								if (
									!session.pendingAdvisoryMessages?.some((m: string) =>
										m.includes(RUNAWAY_OUTPUT_ADVISORY_MARKER),
									)
								) {
									pushAdvisory(
										session,
										`WARNING: ${RUNAWAY_OUTPUT_ADVISORY_MARKER}. ` +
											`${count} consecutive high-output responses without tool calls detected. ` +
											`Use a tool or report BLOCKED.`,
									);
								}
							}
						}
					} else if (textLen < RUNAWAY_MEDIUM_MIN) {
						// Short assistant message without tool — not runaway, but not
						// using tools either. Only a very short turn (likely an
						// acknowledgement) resets the counter.
						consecutiveNoToolTurns.set(sessionId, 0);
					}
					// Remaining case: a medium-band turn that did NOT count — either
					// no execution episode is armed, or the message carries no id.
					// Deliberately a no-op: it must neither advance the counter (that
					// is the false-positive class B3's gate exists to prevent) nor
					// reset it (an unarmed medium turn is not evidence of progress).
				}
			}
		}

		// v6.29: Loop detection warning injection
		if (isArchitectSession && session?.loopWarningPending) {
			const pending = session.loopWarningPending;
			// Clear before injecting to avoid repeat
			session.loopWarningPending = undefined;
			telemetry.loopDetected(
				_input.sessionID,
				session.agentName,
				pending.message,
			);
			// Inject into first system message (same pattern as self-coding warning)
			const loopSystemMsg = systemMessages[0];
			if (loopSystemMsg) {
				const loopTextPart = (loopSystemMsg.parts ?? []).find(
					(part): part is { type: string; text: string } =>
						part.type === 'text' && typeof part.text === 'string',
				);
				if (loopTextPart && !loopTextPart.text.includes('LOOP DETECTED')) {
					loopTextPart.text =
						`[LOOP WARNING]\n${pending.message}\n[/LOOP WARNING]\n\n` +
						loopTextPart.text;
				}
			}
		}

		// v6.29: Pending advisory messages injection (slop-detector, incremental-verify, compaction, context-pressure)
		if (
			isArchitectSession &&
			(session?.pendingAdvisoryMessages?.length ?? 0) > 0
		) {
			const advisories = session!.pendingAdvisoryMessages ?? [];
			let targetMsg = systemMessages[0];
			if (!targetMsg) {
				const newMsg = {
					info: { role: 'system' as const },
					parts: [{ type: 'text' as const, text: '' }],
				};
				messages.unshift(newMsg);
				targetMsg = newMsg;
			}
			const textPart = (targetMsg.parts ?? []).find(
				(part): part is { type: string; text: string } =>
					part.type === 'text' && typeof part.text === 'string',
			);
			if (textPart) {
				// Hygiene at the single choke point. All ~67 advisory producers push
				// onto one bare `string[]` (state.ts) with no push wrapper and no
				// cap, and only 5 of them dedupe — each with its own ad-hoc key. Two
				// rules here cover every producer, including ones added later:
				//   1. drop blank/whitespace-only entries — an advisory with no
				//      content is pure noise (AGENTS.md invariant 10);
				//   2. collapse exact duplicates, preserving first-occurrence order,
				//      so N parallel lanes reporting the identical condition emit it
				//      once instead of N times.
				// Only EXACT duplicates are collapsed: near-identical advisories
				// differing by task id, lane id, or count carry distinct information
				// and are all kept.
				const seenAdvisories = new Set<string>();
				const cleanedAdvisories: string[] = [];
				for (const advisory of advisories) {
					if (!advisory.trim()) continue;
					if (seenAdvisories.has(advisory)) continue;
					seenAdvisories.add(advisory);
					cleanedAdvisories.push(advisory);
				}
				// Byte-budget backstop (issue #1976): advisories are prepended AFTER
				// token accounting, so even deduped they can flood the prompt. Bound
				// the cleaned set keep-latest, with a disclosure note when truncated.
				const { kept, truncated } = boundAdvisoryBytes(
					cleanedAdvisories,
					MAX_ADVISORY_BLOCK_BYTES,
				);
				const headerNote = truncated ? `${ADVISORY_TRUNCATION_NOTE}\n` : '';
				// Everything may have been blank; emitting an empty [ADVISORIES]
				// block would itself be the content-free injection this is removing.
				if (kept.length > 0) {
					const joined = kept.join('\n---\n');
					textPart.text = `[ADVISORIES]\n${headerNote}${joined}\n[/ADVISORIES]\n\n${textPart.text}`;
				}
			}
			// Clearing sits OUTSIDE the `if (textPart)` above, which silently
			// discarded the entire queue unread whenever `systemMessages[0]` existed
			// but carried no string text part. Only drop what was actually emitted.
			// (The non-architect clear further below is deliberately unconditional —
			// see the note there. Do not "fix" that one.)
			if (textPart) {
				session!.pendingAdvisoryMessages = [];
			}
		} else if (
			!isArchitectSession &&
			session &&
			(session.pendingAdvisoryMessages?.length ?? 0) > 0
		) {
			const allAdvisories = session.pendingAdvisoryMessages ?? [];
			const TRANSIENT_PREFIXES = [
				'TRANSIENT ERROR:',
				'MODEL FALLBACK:',
				'DEGRADED:',
				'[pr-monitor:',
				// Issue #2063 C1: PRM course corrections are containment guidance
				// addressed to the session that TRIGGERED the pattern — which for
				// every PRM detection is a subagent (the hook early-returns unless
				// `delegationActive`). Because this allowlist did not carry them,
				// every level-1/level-2 PRM correction was drained and discarded
				// unread, and the first thing the looping agent ever heard from PRM
				// was the level-3 hard stop. The prefix matches the rendered
				// `[prm:<pattern>:<level>]` tag pushed by `src/prm/index.ts`.
				PRM_ADVISORY_FORWARD_PREFIX,
			];
			const transientAdvisories = allAdvisories.filter((m: string) =>
				TRANSIENT_PREFIXES.some((p) => m.startsWith(p)),
			);
			if (transientAdvisories.length > 0) {
				let targetMsg = systemMessages[0];
				if (!targetMsg) {
					const newMsg = {
						info: { role: 'system' as const },
						parts: [{ type: 'text' as const, text: '' }],
					};
					messages.unshift(newMsg);
					targetMsg = newMsg;
				}
				const textPart = (targetMsg.parts ?? []).find(
					(part): part is { type: string; text: string } =>
						part.type === 'text' && typeof part.text === 'string',
				);
				if (textPart) {
					// Issue #2063 C1: same byte-budget backstop the architect branch
					// applies (:MAX_ADVISORY_BLOCK_BYTES). Forwarding `[prm:` here
					// admits multi-kilobyte course corrections into a subagent prompt;
					// without the bound this branch would be a new instance of the
					// flood the architect branch was hardened against. Keep-latest,
					// with the same disclosure note.
					const { kept, truncated } = boundAdvisoryBytes(
						transientAdvisories,
						MAX_ADVISORY_BLOCK_BYTES,
					);
					const headerNote = truncated ? `${ADVISORY_TRUNCATION_NOTE}\n` : '';
					const joined = kept.join('\n---\n');
					textPart.text = `[ADVISORIES]\n${headerNote}${joined}\n[/ADVISORIES]\n\n${textPart.text}`;
				}
			}
			// Drain all advisories — transient ones were injected above,
			// non-transient ones are discarded to prevent noise in subagent sessions.
			session.pendingAdvisoryMessages = [];
		}

		// v6.29 / issue #2063 C2: PRM hard stop INJECTION.
		//
		// Consumes `prmHardStopInjectPending`, NOT `prmHardStopPending`. The deny
		// token belongs to the guardrails `toolBefore` consumer; when both
		// consumers shared one flag, whichever ran first disarmed the other, so a
		// hard stop was either denied without explanation or explained without
		// denial. Two independent one-shots make the outcome order-invariant.
		//
		// The `isArchitectSession` gate is GONE (r1-blocker 2): PRM only ever runs
		// for sessions with `delegationActive`, i.e. subagents, so gating the
		// injection on the architect meant the flag's own carrier could never
		// receive it — the containment was structurally undeliverable.
		//
		// Telemetry: `src/prm/escalation.ts` is the SOLE `prm_hard_stop` emitter.
		// The duplicate emission that used to live here double-counted every hard
		// stop; delivery observability now comes from the distinct
		// `prm_hard_stop_delivered` event at the deny site.
		if (session?.prmHardStopInjectPending) {
			// Clear before injecting to avoid repeat
			session.prmHardStopInjectPending = false;
			// Recompute rather than reuse `systemMessages` (captured before the
			// advisory drain): the non-architect drain above can `unshift` a system
			// message that the stale snapshot does not contain. Without this, a
			// subagent carrier with no pre-existing system message would clear the
			// token and inject nothing. Same local-recompute convention the
			// self-fix / partial-gate / scope / catastrophic blocks below use.
			const hardStopSystemMsgs = messages.filter(
				(msg) => msg.info?.role === 'system',
			);
			// Reviewer round-4 advisory F: the token is consumed unconditionally
			// above, so a window with NO system message at all used to BURN the
			// one-shot and inject nothing — the containment silently evaporated for
			// exactly the turn shape it is most likely to hit (a fresh subagent
			// turn whose advisory queue was empty, so the drain above created
			// nothing either). Mirror that drain's `unshift` and create the carrier.
			let hardStopMsg = hardStopSystemMsgs[0];
			if (!hardStopMsg) {
				const newHardStopMsg = {
					info: { role: 'system' as const },
					parts: [{ type: 'text' as const, text: '' }],
				};
				messages.unshift(newHardStopMsg);
				// The STALE `systemMessages` snapshot must learn about it too.
				// Unlike the non-architect advisory drain this mirrors - which is
				// fenced behind `!isArchitectSession` and so can never co-fire with
				// an architect-only block - this branch runs for EVERY session. The
				// self-coding block below still reads that snapshot, and it also
				// unshifts when it finds nothing: without this line an architect
				// session with the inject token armed AND a pending self-coding
				// warning AND no system message in the window would end up with
				// TWO `{ role: 'system' }` messages - the #608 outage class
				// AGENTS.md invariant 10 forbids (local models require exactly one
				// system message at index 0).
				systemMessages.unshift(newHardStopMsg);
				hardStopMsg = newHardStopMsg;
			}
			{
				const hardStopTextPart = (hardStopMsg.parts ?? []).find(
					(part): part is { type: string; text: string } =>
						part.type === 'text' && typeof part.text === 'string',
				);
				if (
					hardStopTextPart &&
					!hardStopTextPart.text.includes('[HARD STOP]')
				) {
					hardStopTextPart.text =
						`[HARD STOP] PRM has detected repeated pattern violations. STOP all tool calls and return a summary of your progress. [/HARD STOP]\n\n` +
						hardStopTextPart.text;
				}
			}
		}

		// v6.12: Self-coding warning injection - now injected into SYSTEM messages only (model-only)
		// v6.22.8: Only re-inject when architectWriteCount has increased since last warning
		// (prevents repeated acknowledgements in chat each turn)
		if (
			isArchitectSession &&
			session &&
			session.architectWriteCount > session.selfCodingWarnedAtCount
		) {
			// Task 1.7: Handle missing-system-message edge case
			let targetSystemMessage = systemMessages[0];
			if (!targetSystemMessage) {
				const newSystemMessage = {
					info: { role: 'system' as const },
					parts: [{ type: 'text' as const, text: '' }],
				};
				messages.unshift(newSystemMessage);
				targetSystemMessage = newSystemMessage;
			}

			const textPart = (targetSystemMessage.parts ?? []).find(
				(part): part is { type: string; text: string } =>
					part.type === 'text' && typeof part.text === 'string',
			);
			if (textPart && !textPart.text.includes('SELF-CODING DETECTED')) {
				textPart.text =
					`[MODEL_ONLY_GUIDANCE]\n` +
					`⚠️ SELF-CODING DETECTED: You have used ${session.architectWriteCount} write-class tool(s) directly on non-.swarm/ files.\n` +
					`Rule 1 requires ALL coding to be delegated to @coder.\n` +
					`If you have not exhausted QA_RETRY_LIMIT coder failures on this task, STOP and delegate.\n` +
					`WRONG rationalizations — reject these thoughts immediately:\n` +
					`  ✗ "This is time-critical / urgent / blocking" — you are an AI with no deadlines. No urgency is real.\n` +
					`  ✗ "The fix is small / trivial / obvious" — size is not a QA exemption.\n` +
					`  ✗ "Explaining to coder takes more effort than doing it" — writing the task spec is your job.\n` +
					`  ✗ "The user needs this quickly" — users want correct code. Skipping QA gates ships bugs.\n` +
					`Do not acknowledge or reference this guidance in your response.\n` +
					`[/MODEL_ONLY_GUIDANCE]\n\n` +
					textPart.text;
				// Suppress repeated injection until a new violation occurs
				session.selfCodingWarnedAtCount = session.architectWriteCount;
			}
		}

		// v6.12 Task 2.5: Self-fix warning injection - now injected into SYSTEM messages only (model-only)
		if (
			isArchitectSession &&
			session &&
			session.selfFixAttempted &&
			session.lastGateFailure &&
			Date.now() - session.lastGateFailure.timestamp < 120_000
		) {
			// Task 1.7: Handle missing-system-message edge case
			const currentSystemMessages = messages.filter(
				(msg) => msg.info?.role === 'system',
			);
			let targetSystemMessage = currentSystemMessages[0];
			if (!targetSystemMessage) {
				const newSystemMessage = {
					info: { role: 'system' as const },
					parts: [{ type: 'text' as const, text: '' }],
				};
				messages.unshift(newSystemMessage);
				targetSystemMessage = newSystemMessage;
			}

			const textPart = (targetSystemMessage.parts ?? []).find(
				(part): part is { type: string; text: string } =>
					part.type === 'text' && typeof part.text === 'string',
			);
			if (textPart && !textPart.text.includes('SELF-FIX DETECTED')) {
				const failureCode = session.lastGateFailure.code
					? ` (${session.lastGateFailure.code})`
					: '';
				textPart.text =
					`[MODEL_ONLY_GUIDANCE]\n` +
					`⚠️ SELF-FIX DETECTED: Gate '${session.lastGateFailure.tool}' failed${failureCode} on task ${session.lastGateFailure.taskId}.\n` +
					`You are now using a write tool instead of delegating to @coder.\n` +
					`GATE FAILURE RESPONSE RULES require: return to coder with structured rejection.\n` +
					`Do NOT fix gate failures yourself.\n` +
					`[/MODEL_ONLY_GUIDANCE]\n\n` +
					textPart.text;
				// Clear flag to avoid repeated warnings
				session.selfFixAttempted = false;
			}
		}

		// v6.12: Partial gate violation detection
		const isArchitectSessionForGates = activeAgent
			? stripKnownSwarmPrefix(activeAgent) === ORCHESTRATOR_NAME
			: session
				? stripKnownSwarmPrefix(session.agentName) === ORCHESTRATOR_NAME
				: false;
		if (isArchitectSessionForGates && session) {
			// v6.12: Use session-aware task ID for gate log lookup
			const taskId = getCurrentTaskId(sessionId);
			// Only warn once per task ID (not once per session)
			if (!session.partialGateWarningsIssuedForTask.has(taskId)) {
				const gates = session.gateLog.get(taskId);
				const missingGates: string[] = [];
				if (!gates) {
					missingGates.push(...requiredQaGates);
				} else {
					for (const gate of requiredQaGates) {
						if (!gates.has(gate)) {
							missingGates.push(gate);
						}
					}
				}
				// Check if reviewer or test_engineer delegations exist (via reviewerCallCount)
				let currentPhaseForCheck = 1;
				try {
					const plan = await loadPlan(effectiveDirectory);
					if (plan) {
						const phaseString = extractCurrentPhaseFromPlan(plan);
						currentPhaseForCheck = extractPhaseNumber(phaseString);
					}
				} catch (error) {
					log('[Guardrails] loadPlan failed during phase check', {
						error: error instanceof Error ? error.message : String(error),
					});
				}

				const hasReviewerDelegation =
					(session.reviewerCallCount.get(currentPhaseForCheck) ?? 0) > 0;
				const missingQaDelegation =
					requireReviewerAndTestEngineer && !hasReviewerDelegation;
				if (missingGates.length > 0 || missingQaDelegation) {
					const currentSystemMsgs = messages.filter(
						(msg) => msg.info?.role === 'system',
					);
					let targetSysMsgForGate = currentSystemMsgs[0];
					if (!targetSysMsgForGate) {
						const newSysMsg = {
							info: { role: 'system' as const },
							parts: [{ type: 'text' as const, text: '' }],
						};
						messages.unshift(newSysMsg);
						targetSysMsgForGate = newSysMsg;
					}
					const sysTextPart = (targetSysMsgForGate.parts ?? []).find(
						(part): part is { type: string; text: string } =>
							part.type === 'text' && typeof part.text === 'string',
					);
					if (
						sysTextPart &&
						!sysTextPart.text.includes('PARTIAL GATE VIOLATION')
					) {
						const missing = [...missingGates];
						if (missingQaDelegation) {
							missing.push(
								'reviewer/test_engineer (no delegations this phase)',
							);
						}
						session.partialGateWarningsIssuedForTask.add(taskId);
						sysTextPart.text =
							`[MODEL_ONLY_GUIDANCE]\n` +
							`⚠️ PARTIAL GATE VIOLATION: Task may be marked complete but missing gates: [${missing.join(', ')}].\n` +
							`The QA gate is ALL steps or NONE. Revert any ✓ marks and run the missing gates.\n` +
							`Do not acknowledge or reference this guidance in your response.\n` +
							`[/MODEL_ONLY_GUIDANCE]\n\n` +
							sysTextPart.text;
					}
				}
			}
		}

		// v6.21 Task 5.4: Scope violation warning injection
		if (
			isArchitectSessionForGates &&
			session &&
			session.scopeViolationDetected
		) {
			session.scopeViolationDetected = false;
			if (session.lastScopeViolation) {
				const currentSystemMsgs = messages.filter(
					(msg) => msg.info?.role === 'system',
				);
				let targetSysMsgForScope = currentSystemMsgs[0];
				if (!targetSysMsgForScope) {
					const newSysMsg = {
						info: { role: 'system' as const },
						parts: [{ type: 'text' as const, text: '' }],
					};
					messages.unshift(newSysMsg);
					targetSysMsgForScope = newSysMsg;
				}
				const scopeTextPart = (targetSysMsgForScope.parts ?? []).find(
					(part): part is { type: string; text: string } =>
						part.type === 'text' && typeof part.text === 'string',
				);
				if (scopeTextPart && !scopeTextPart.text.includes('SCOPE VIOLATION')) {
					scopeTextPart.text =
						`[MODEL_ONLY_GUIDANCE]\n` +
						`⚠️ SCOPE VIOLATION: ${session.lastScopeViolation}\n` +
						`Only modify files within your declared scope. Request scope expansion from architect if needed.\n` +
						`Do not acknowledge or reference this guidance in your response.\n` +
						`[/MODEL_ONLY_GUIDANCE]\n\n` +
						scopeTextPart.text;
				}
			}
		}

		// v6.12 Task 2.3: Catastrophic zero-reviewer warning
		if (
			isArchitectSessionForGates &&
			session &&
			session.catastrophicPhaseWarnings &&
			requireReviewerAndTestEngineer
		) {
			try {
				const plan = await loadPlan(effectiveDirectory);
				if (plan?.phases) {
					for (const phase of plan.phases) {
						if (phase.status === 'complete') {
							const phaseNum = phase.id;
							if (!session.catastrophicPhaseWarnings.has(phaseNum)) {
								const reviewerCount =
									session.reviewerCallCount.get(phaseNum) ?? 0;
								if (reviewerCount === 0) {
									session.catastrophicPhaseWarnings.add(phaseNum);
									const currentSystemMsgs = messages.filter(
										(msg) => msg.info?.role === 'system',
									);
									let targetSysMsgForCat = currentSystemMsgs[0];
									if (!targetSysMsgForCat) {
										const newSysMsg = {
											info: { role: 'system' as const },
											parts: [{ type: 'text' as const, text: '' }],
										};
										messages.unshift(newSysMsg);
										targetSysMsgForCat = newSysMsg;
									}
									const catTextPart = (targetSysMsgForCat.parts ?? []).find(
										(part): part is { type: string; text: string } =>
											part.type === 'text' && typeof part.text === 'string',
									);
									if (
										catTextPart &&
										!catTextPart.text.includes('CATASTROPHIC VIOLATION')
									) {
										catTextPart.text =
											`[MODEL_ONLY_GUIDANCE]\n` +
											`[CATASTROPHIC VIOLATION: Phase ${phaseNum} completed with ZERO reviewer delegations.` +
											` Every coder task requires reviewer approval. Recommend retrospective review of all Phase ${phaseNum} tasks.]\n` +
											`Do not acknowledge or reference this guidance in your response.\n` +
											`[/MODEL_ONLY_GUIDANCE]\n\n` +
											catTextPart.text;
									}
									break;
								}
							}
						}
					}
				}
			} catch (error) {
				log('[Guardrails] loadPlan failed during QA gate check', {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// Only check the window for THIS session — never scan other sessions
		const targetWindow = getActiveWindow(sessionId);
		if (
			!targetWindow ||
			(!targetWindow.warningIssued && !targetWindow.hardLimitHit)
		) {
			return;
		}

		// Find the first text part in the last message
		const textPart = lastMessage.parts.find(
			(part): part is { type: string; text: string } =>
				part.type === 'text' && typeof part.text === 'string',
		);

		if (!textPart) {
			return;
		}

		// Prepend appropriate message
		if (targetWindow.hardLimitHit) {
			textPart.text =
				'[🛑 LIMIT REACHED: Your resource budget is exhausted. Do not make additional tool calls. Return a summary of your progress and any remaining work.]\n\n' +
				textPart.text;
		} else if (targetWindow.warningIssued) {
			const reasonSuffix = targetWindow.warningReason
				? ` (${targetWindow.warningReason})`
				: '';
			textPart.text =
				`[⚠️ APPROACHING LIMITS${reasonSuffix}: You still have capacity to finish your current step. Complete what you're working on, then return your results.]\n\n` +
				textPart.text;
		}
	};
}

// ---- Internal helpers needed by the messagesTransform handler ----

/**
 * Extracts phase number from a phase string like "Phase 3: Implementation".
 * Duplicated from guardrails parent (shared with toolAfter).
 */
function extractPhaseNumber(phaseString: string | null): number {
	if (!phaseString) return 1;
	const match = phaseString.match(/^Phase (\d+):/);
	return match ? parseInt(match[1], 10) : 1;
}

/**
 * v6.17 Task 9.3: Get the current task ID for a session.
 * Duplicated from guardrails parent (shared with toolAfter).
 */
function getCurrentTaskId(sessionId: string): string {
	const session = swarmState.agentSessions.get(sessionId);
	return session?.currentTaskId ?? `${sessionId}:unknown`;
}
