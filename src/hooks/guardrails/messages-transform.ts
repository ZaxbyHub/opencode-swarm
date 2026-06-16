/**
 * Messages Transform Handler Factory
 *
 * Extracted from guardrails.ts. Creates the messagesTransform handler
 * used by createGuardrailsHooks. The factory receives shared configuration
 * and closures from the guardrails hooks factory, so the handler can
 * inject warnings, detect loops, and enforce QA gate compliance.
 */

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
import { extractCurrentPhaseFromPlan } from '../extractors';
import { extractModelInfo } from '../model-limits';
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
}

// ---- Module-level helpers used exclusively by the messagesTransform handler ----

type ChatMessageLike = {
	info?: { role?: string; sessionID?: string };
	parts?: Array<{ type?: string; text?: unknown }>;
};

/** v6.33: Known HTTP status codes that indicate transient provider errors. */
const TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504, 529]);

/**
 * v6.33: Regex pattern for transient model errors that should trigger fallback.
 * Matches: rate limits, overloaded, timeouts, model not found, temporary failures.
 */
const TRANSIENT_MODEL_ERROR_PATTERN =
	/rate.?limit|429|500|502|503|504|529|timeout|overloaded|model.?not.?found|temporarily.?unavailable|provider[_\s-]?unavailable|server.?error|network.?connection.?lost|connection.?(refused|reset|timeout|lost)|bad.?gateway|gateway.?timeout|internal.?server.?error|service.?unavailable|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|broken.?pipe|dns(?:[\s_-]+(?:resolution)?)?[\s_-]+fail|name.?not.?resolved|EAI_AGAIN/i;

const TRANSIENT_PROVIDER_RECOVERY_TAG = 'TRANSIENT PROVIDER RECOVERY';

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

function extractStatusCode(errorMsg: string): number | null {
	const match = errorMsg.match(/\b(408|429|500|502|503|504|529)\b/);
	if (match) {
		return parseInt(match[1], 10);
	}
	return null;
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
	} = ctx;

	return async (
		_input: Record<string, never>,
		output: {
			messages?: Array<{
				info: { role: string; agent?: string; sessionID?: string };
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

		// v6.21 Task 4.5: Tier-based behavioral prompt trimming for low-capability models
		{
			const { modelID } = extractModelInfo(messages);
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
		const session = swarmState.agentSessions.get(sessionId);
		const activeAgent = swarmState.activeAgent.get(sessionId);
		const isArchitectSession = activeAgent
			? stripKnownSwarmPrefix(activeAgent) === ORCHESTRATOR_NAME
			: session
				? stripKnownSwarmPrefix(session.agentName) === ORCHESTRATOR_NAME
				: false;

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
				session.pendingAdvisoryMessages ??= [];
				const alreadyPending = session.pendingAdvisoryMessages.some(
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
					session.pendingAdvisoryMessages.push(
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

					if (textLen > 4000) {
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
							// Advisory warning at 3 consecutive
							if (session) {
								session.pendingAdvisoryMessages ??= [];
								if (
									!session.pendingAdvisoryMessages.some((m: string) =>
										m.includes('runaway output'),
									)
								) {
									session.pendingAdvisoryMessages.push(
										`WARNING: Model is generating analysis without taking action. ` +
											`${count} consecutive high-output responses without tool calls detected. ` +
											`Use a tool or report BLOCKED.`,
									);
								}
							}
						}
					} else {
						// Short assistant message without tool — not runaway, but not using tools either
						// Only reset if the message is very short (likely acknowledgment)
						const shortLen =
							lastAssistantMsg.parts
								?.filter((p) => p.type === 'text' && typeof p.text === 'string')
								.reduce((sum, p) => sum + (p.text as string).length, 0) ?? 0;
						if (shortLen < 200) {
							consecutiveNoToolTurns.set(sessionId, 0);
						}
					}
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
				const joined = advisories.join('\n---\n');
				textPart.text = `[ADVISORIES]\n${joined}\n[/ADVISORIES]\n\n${textPart.text}`;
			}
			session!.pendingAdvisoryMessages = [];
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
					const joined = transientAdvisories.join('\n---\n');
					textPart.text = `[ADVISORIES]\n${joined}\n[/ADVISORIES]\n\n${textPart.text}`;
				}
			}
			// Drain all advisories — transient ones were injected above,
			// non-transient ones are discarded to prevent noise in subagent sessions.
			session.pendingAdvisoryMessages = [];
		}

		// v6.29: PRM hard stop injection (Task 2.1)
		if (isArchitectSession && session?.prmHardStopPending) {
			// Clear before injecting to avoid repeat
			session.prmHardStopPending = false;
			// Emit telemetry for hard stop injection
			const lastPattern = session.prmLastPatternDetected;
			const patternType = lastPattern?.pattern ?? 'unknown';
			const occurrenceCount = session.prmPatternCounts.get(patternType) ?? 0;
			telemetry.prmHardStop(
				_input.sessionID,
				patternType,
				session.prmEscalationLevel,
				occurrenceCount,
			);
			// Inject into first system message
			const hardStopMsg = systemMessages[0];
			if (hardStopMsg) {
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
				textPart.text =
					`[MODEL_ONLY_GUIDANCE]\n` +
					`⚠️ SELF-FIX DETECTED: Gate '${session.lastGateFailure.tool}' failed on task ${session.lastGateFailure.taskId}.\n` +
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
