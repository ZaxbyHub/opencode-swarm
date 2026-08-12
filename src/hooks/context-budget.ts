/**
 * Context Budget Tracker Hook
 *
 * Estimates token usage across all messages and injects budget warnings
 * when thresholds are exceeded. Uses experimental.chat.messages.transform
 * to provide proactive context management guidance to the architect agent.
 */

import type { PluginConfig } from '../config';
import {
	parseAgentModel,
	resolveConfiguredAgentModel,
} from '../config/agent-model';
import { SUMMARIZER_EXEMPT_TOOL_NAMES } from '../config/constants';
import { stripKnownSwarmPrefix } from '../config/schema';
import { log, warn } from '../utils';
import {
	classifyMessages,
	getCompletedToolOutputs,
	getToolNames,
	getToolParts,
	MessagePriority,
	type MessagePriorityType,
} from './message-priority';
import { extractModelInfo, resolveModelLimit } from './model-limits';
import { estimateTokens } from './utils';

const MAX_TRACKED_SESSIONS = 256;

interface MessageInfo {
	role: string;
	agent?: string;
	sessionID?: string;
	modelID?: string;
	providerID?: string;
	[key: string]: unknown;
}

interface MessagePart {
	type: string;
	text?: string;
	// ToolPart fields (OpenCode SDK `ToolPart`).
	tool?: string;
	state?: {
		status?: string;
		output?: string;
		error?: string;
		input?: Record<string, unknown>;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

interface MessageWithParts {
	info: MessageInfo;
	parts: MessagePart[];
}

/**
 * Creates the experimental.chat.messages.transform hook for context budget tracking.
 * Injects warnings when context usage exceeds configured thresholds.
 * Only operates on messages for the architect agent.
 */
export function createContextBudgetHandler(config: PluginConfig) {
	const enabled = config.context_budget?.enabled !== false;

	if (!enabled) {
		return async (
			_input: Record<string, never>,
			_output: { messages?: MessageWithParts[] },
		) => {
			// No-op function when context budget tracking is disabled
		};
	}

	const warnThreshold = config.context_budget?.warn_threshold ?? 0.7;
	const criticalThreshold = config.context_budget?.critical_threshold ?? 0.9;
	const modelLimitsConfig = config.context_budget?.model_limits ?? {};

	// Track first-call logging to avoid spam
	const loggedLimits = new Set<string>();
	// Agent-switch history is handler-local, session-keyed, exact-name-aware,
	// and bounded so independent plugin sessions cannot contaminate one another.
	const lastSeenAgentBySession = new Map<string, string>();

	// Create the handler function
	const handler = async (
		_input: Record<string, never>,
		output: { messages?: MessageWithParts[] },
	): Promise<void> => {
		const messages = output?.messages;
		if (!messages || messages.length === 0) return;

		// Resolve the incoming target before reading historical assistant metadata.
		// On the first turn after a handoff, the latest assistant still describes
		// the previous agent and can have a materially larger context window.
		let agentName: string | undefined;
		let baseAgent: string | undefined;
		let sessionID: string | undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const messageInfo = messages[i]?.info;
			if (messageInfo?.role === 'user' && messageInfo.agent) {
				agentName = messageInfo.agent;
				baseAgent = stripKnownSwarmPrefix(agentName);
				sessionID =
					typeof messageInfo.sessionID === 'string' &&
					messageInfo.sessionID.trim()
						? messageInfo.sessionID
						: undefined;
				break;
			}
		}

		const configuredTargetModel = agentName
			? resolveConfiguredAgentModel(config, agentName)
			: undefined;
		const targetModelInfo = configuredTargetModel
			? parseAgentModel(configuredTargetModel)
			: undefined;
		const { modelID, providerID } =
			targetModelInfo ?? extractModelInfo(messages);
		const modelLimit = resolveModelLimit(
			modelID,
			providerID,
			modelLimitsConfig,
		);

		// Log on first use of each model/provider combination
		const cacheKey = `${modelID || 'unknown'}::${providerID || 'unknown'}`;
		if (!loggedLimits.has(cacheKey)) {
			loggedLimits.add(cacheKey);
			// Startup diagnostic: debug-gated, not a warning (once per model/provider combination)
			log(
				`[swarm] Context budget: model=${modelID || 'unknown'} provider=${providerID || 'unknown'} limit=${modelLimit}`,
			);
		}

		// Calculate total token usage across all text parts AND completed tool
		// outputs. Tool results are `ToolPart` objects (`part.type === 'tool'`)
		// whose heavy payload lives in `part.state.output` — the previous loop
		// only counted `type === 'text'` parts, so it systematically undercounted
		// real prompt size (issue #2068).
		let totalTokens = 0;
		for (const message of messages) {
			if (!message?.parts) continue;

			for (const part of message.parts) {
				if (part?.type === 'text' && part.text) {
					totalTokens += estimateTokens(part.text);
				}
			}
			// Completed tool outputs are the heavy payloads the provider
			// serializes. Error-state outputs are diagnostic and not counted
			// here (they are routed via stale-error → DISPOSABLE).
			for (const { output } of getCompletedToolOutputs(message)) {
				totalTokens += estimateTokens(output);
			}
		}

		const usagePercent = totalTokens / modelLimit;

		// Agent-switch detection (Task 4.1)
		let ratio = usagePercent; // Declare early for agent-switch override
		const lastSeenAgent = sessionID
			? lastSeenAgentBySession.get(sessionID)
			: undefined;
		if (
			lastSeenAgent !== undefined &&
			agentName !== undefined &&
			agentName !== lastSeenAgent
		) {
			// Agent switch detected
			const enforceOnSwitch =
				config.context_budget?.enforce_on_agent_switch ?? true;
			if (
				enforceOnSwitch &&
				usagePercent > (config.context_budget?.warn_threshold ?? 0.7)
			) {
				// Force enforcement regardless of critical threshold
				warn(
					`[swarm] Agent switch detected: ${lastSeenAgent} → ${agentName}, enforcing context budget`,
					{
						from: lastSeenAgent,
						to: agentName,
					},
				);
				// Set ratio to critical to trigger enforcement
				ratio = 1.0; // Force > criticalThreshold
			}
		}

		if (sessionID && agentName) {
			if (
				!lastSeenAgentBySession.has(sessionID) &&
				lastSeenAgentBySession.size >= MAX_TRACKED_SESSIONS
			) {
				const oldestSessionID = lastSeenAgentBySession.keys().next().value;
				if (oldestSessionID !== undefined) {
					lastSeenAgentBySession.delete(oldestSessionID);
				}
			}
			lastSeenAgentBySession.set(sessionID, agentName);
		}

		// HARD ENFORCEMENT: When ratio >= critical threshold, actively remove messages
		if (ratio >= criticalThreshold) {
			const enforce = config.context_budget?.enforce ?? true;

			if (enforce) {
				// HARD TRUNCATION MODE: actively remove messages
				const targetTokens =
					modelLimit * (config.context_budget?.prune_target ?? 0.7);
				const recentWindow = config.context_budget?.recent_window ?? 10;

				// Step 1: Classify all messages by priority
				const priorities = classifyMessages(
					output.messages || [],
					recentWindow,
				);

				// Compute the protected-turn indices FIRST so that both
				// tool-output masking and observation pruning respect
				// `preserve_last_n_turns`. Without this, a large completed tool
				// result inside the preserved window could be masked away,
				// discarding the substance of a supposedly preserved turn
				// (issue #2068 review).
				const preserveLastNTurns =
					config.context_budget?.preserve_last_n_turns ?? 4;
				const protectedIndices = computeProtectedIndices(
					output.messages || [],
					preserveLastNTurns,
				);

				// Tool output masking (Task 4.2): Replace old tool results with placeholders
				// This runs BEFORE priority-based pruning to reduce token load early.
				// Protected (recent) messages are exempt from masking.
				const toolMaskThreshold =
					config.context_budget?.tool_output_mask_threshold ?? 2000;
				let toolMaskFreedTokens = 0;
				const maskedIndices = new Set<number>();

				for (let i = 0; i < (output.messages || []).length; i++) {
					if (protectedIndices.has(i)) continue;
					const msg = (output.messages || [])[i];
					if (
						shouldMaskToolOutput(
							msg,
							i,
							(output.messages || []).length,
							recentWindow,
							toolMaskThreshold,
						)
					) {
						toolMaskFreedTokens += maskToolOutput(msg, toolMaskThreshold);
						maskedIndices.add(i);
					}
				}

				if (toolMaskFreedTokens > 0) {
					totalTokens -= toolMaskFreedTokens;
					warn(
						`[swarm] Tool output masking: masked ${maskedIndices.size} tool results, freed ~${toolMaskFreedTokens} tokens`,
						{
							maskedCount: maskedIndices.size,
							freedTokens: toolMaskFreedTokens,
						},
					);
				}

				// Step 2: Identify messages to remove (by priority, excluding last N turns)
				const removableMessages = identifyRemovableMessages(
					output.messages || [],
					priorities,
					preserveLastNTurns,
				);

				// Step 3: Remove messages until targetTokens reached.
				// NOTE: extractMessageText reads the POST-MASKING parts (masking
				// already ran above and subtracted toolMaskFreedTokens from
				// totalTokens). So for a message that was masked, this measures
				// only the residual placeholder text — which is the correct
				// amount pruning can still free (masking already credited the
				// heavy tool output). Do NOT add toolMaskFreedTokens here: that
				// would double-count the masking credit.
				let freedTokens = 0;
				const toRemove = new Set<number>();

				for (const idx of removableMessages) {
					if (totalTokens - freedTokens <= targetTokens) break;
					toRemove.add(idx);
					freedTokens += estimateTokens(
						extractMessageText(output.messages![idx]),
					);
				}

				// Step 4: Apply observation masking to removed messages
				const beforeTokens = totalTokens;
				if (toRemove.size > 0) {
					// applyObservationMasking clamps each part's contribution to >= 0
					// (R7 fix), so actualFreedTokens can never be negative here —
					// unlike the toolMaskFreedTokens branch above, this subtraction
					// was previously unconditional and would have silently INCREASED
					// totalTokens had a placeholder ever come out longer than the
					// text it replaced.
					const actualFreedTokens = applyObservationMasking(
						output.messages || [],
						toRemove,
					);
					totalTokens -= actualFreedTokens;

					// Step 5: Log enforcement action
					warn(
						`[swarm] Context enforcement: pruned ${toRemove.size} messages, freed ${actualFreedTokens} tokens (${beforeTokens}→${totalTokens} of ${modelLimit})`,
						{
							pruned: toRemove.size,
							freedTokens: actualFreedTokens,
							before: beforeTokens,
							after: totalTokens,
							limit: modelLimit,
						},
					);
				} else if (
					removableMessages.length === 0 &&
					totalTokens > targetTokens
				) {
					// No removable messages found but still over target - warn about this
					warn(
						`[swarm] Context enforcement: no removable messages found but still ${totalTokens} tokens (target: ${targetTokens})`,
						{
							currentTokens: totalTokens,
							targetTokens,
							limit: modelLimit,
						},
					);
				}
			}
			// WARN-ONLY MODE: existing behavior (backward compatible)
			// Falls through to warning injection below
		}

		// Find the last user message
		let lastUserMessageIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]?.info?.role === 'user') {
				lastUserMessageIndex = i;
				break;
			}
		}

		if (lastUserMessageIndex === -1) return;

		const lastUserMessage = messages[lastUserMessageIndex];
		if (!lastUserMessage?.parts) return;

		const trackedAgents = config.context_budget?.tracked_agents ?? [
			'architect',
		];
		if (baseAgent && !trackedAgents.includes(baseAgent)) return;

		// Find the first text part
		const textPartIndex = lastUserMessage.parts.findIndex(
			(p) => p?.type === 'text' && p.text !== undefined,
		);

		if (textPartIndex === -1) return;

		const pct = Math.round(usagePercent * 100);
		let warningText = '';

		if (usagePercent > criticalThreshold) {
			warningText = `[CONTEXT CRITICAL: ~${pct}% of context budget used. Offload details to .swarm/context.md immediately]\n\n`;
		} else if (usagePercent > warnThreshold) {
			warningText = `[CONTEXT WARNING: ~${pct}% of context budget used. Consider summarizing to .swarm/context.md]\n\n`;
		}

		if (warningText) {
			// Prepend the warning to the existing text
			const originalText = lastUserMessage.parts[textPartIndex].text ?? '';
			lastUserMessage.parts[textPartIndex].text =
				`${warningText}${originalText}`;
		}
	};

	return handler;
}

/**
 * Compute the set of message indices protected from pruning/masking. Walks
 * backward from the newest message, protecting every user/assistant message
 * until `preserveLastNTurns` user messages have been seen (inherited
 * semantics: because `turnCount` increments only on user messages, the
 * effective protected window spans roughly the last `preserveLastNTurns` user
 * turns plus their interleaved assistant/tool messages — wider than the name
 * suggests). Also unconditionally protects the single last user and last
 * assistant message. Extracted so both tool-output masking and observation
 * pruning honor the same protection window (issue #2068 review).
 */
function computeProtectedIndices(
	messages: MessageWithParts[],
	preserveLastNTurns: number,
): Set<number> {
	const protectedIndices = new Set<number>();

	// Walk backward until `preserveLastNTurns` user messages are protected.
	// (Inherited bound: the loop visits up to 2N messages; user-only increment
	// means N user turns + their interleaved assistants are protected.)
	let turnCount = 0;
	for (
		let i = messages.length - 1;
		i >= 0 && turnCount < preserveLastNTurns * 2;
		i--
	) {
		const role = messages[i]?.info?.role;
		if (role === 'user' || role === 'assistant') {
			protectedIndices.add(i);
			if (role === 'user') turnCount++;
		}
	}

	// Also protect the last user message and last assistant message
	let lastUserIdx = -1;
	let lastAssistantIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const role = messages[i]?.info?.role;
		if (role === 'user' && lastUserIdx === -1) {
			lastUserIdx = i;
		}
		if (role === 'assistant' && lastAssistantIdx === -1) {
			lastAssistantIdx = i;
		}
		if (lastUserIdx !== -1 && lastAssistantIdx !== -1) break;
	}

	if (lastUserIdx !== -1) protectedIndices.add(lastUserIdx);
	if (lastAssistantIdx !== -1) protectedIndices.add(lastAssistantIdx);

	return protectedIndices;
}

/**
 * Identify messages that can be safely removed
 * Returns indices in priority removal order (DISPOSABLE, LOW, MEDIUM)
 */
function identifyRemovableMessages(
	messages: MessageWithParts[],
	priorities: MessagePriorityType[],
	preserveLastNTurns: number,
): number[] {
	const protectedIndices = computeProtectedIndices(
		messages,
		preserveLastNTurns,
	);

	// Collect removable indices by priority
	const HIGH = MessagePriority.HIGH;
	const MEDIUM = MessagePriority.MEDIUM;
	const LOW = MessagePriority.LOW;
	const DISPOSABLE = MessagePriority.DISPOSABLE;
	const byPriority: number[][] = [[], [], [], [], []];

	for (let i = 0; i < priorities.length; i++) {
		const priority = priorities[i];
		if (!protectedIndices.has(i) && priority > HIGH) {
			byPriority[priority].push(i);
		}
	}

	// Return in order: DISPOSABLE, LOW, MEDIUM (never CRITICAL, HIGH, or protected)
	return [...byPriority[DISPOSABLE], ...byPriority[LOW], ...byPriority[MEDIUM]];
}

/**
 * Replace message content with an observation-masking placeholder. Text parts
 * are rewritten in place; completed `ToolPart`s are REPLACED with a synthetic
 * text part (never mutating `state` — see `maskToolOutput`). Returns the
 * actual number of tokens freed (clamped to ≥ 0 per part — see R7 note).
 */
function applyObservationMasking(
	messages: MessageWithParts[],
	toRemove: Set<number>,
): number {
	let actualFreedTokens = 0;

	for (const idx of toRemove) {
		const msg = messages[idx];
		if (!msg?.parts || !Array.isArray(msg.parts)) continue;

		for (let i = 0; i < msg.parts.length; i++) {
			const part = msg.parts[i];
			if (part.type === 'text' && part.text) {
				if (
					part.text.includes('[Context pruned') ||
					part.text.includes('[Tool output masked')
				) {
					continue;
				}
				const originalTokens = estimateTokens(part.text);
				const placeholder = `[Context pruned — message from turn ${idx}, ~${originalTokens} tokens freed. ${recoveryHint(part.text)}]`;
				const maskedTokens = estimateTokens(placeholder);
				part.text = placeholder;
				// Clamp to 0 (R7): see matching comment below in maskToolOutput.
				actualFreedTokens += Math.max(0, originalTokens - maskedTokens);
			} else if (
				part.type === 'tool' &&
				part.state?.status === 'completed' &&
				typeof part.state.output === 'string'
			) {
				// Per-part exempt check (mirrors maskToolOutput): exempt tool
				// outputs must stay visible even when the message is pruned.
				const partToolName =
					typeof part.tool === 'string' ? part.tool.toLowerCase() : '';
				if (
					partToolName &&
					(SUMMARIZER_EXEMPT_TOOL_NAMES as readonly string[]).includes(
						partToolName,
					)
				) {
					continue;
				}
				const output = part.state.output;
				if (
					output.includes('[Context pruned') ||
					output.includes('[Tool output masked')
				) {
					continue;
				}
				const originalTokens = estimateTokens(output);
				const placeholder = `[Context pruned — message from turn ${idx}, ~${originalTokens} tokens freed. ${recoveryHint(output)}]`;
				const maskedTokens = estimateTokens(placeholder);
				// Replace the ToolPart with a synthetic text part (do NOT mutate
				// `state` — preserves the SDK discriminated-union shape).
				msg.parts[i] = { type: 'text', text: placeholder };
				actualFreedTokens += Math.max(0, originalTokens - maskedTokens);
			}
		}
	}

	return actualFreedTokens;
}

/** Matches lane-output store refs, e.g. `L1:<sha256>:<sha256>:<sha256>`. */
const LANE_OUTPUT_REF_PATTERN = /L1:[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}/g;

/** Generic fallback hint used when no lane ref is present in the text. */
const GENERIC_RECOVERY_HINT = 'Use retrieve_summary if needed.';

/**
 * Choose the correct recovery pointer for a placeholder that replaces
 * pruned/masked text. Lane artifacts and general tool/summary output live in
 * two different subsystems with two different retrieval tools:
 *   - Generic oversized tool output is stored by tool-summarizer.ts and
 *     retrieved with `retrieve_summary`.
 *   - Lane batch output (dispatch_lanes / collect_lane_results) is stored in
 *     the lane-output store and retrieved with `retrieve_lane_output <ref>`.
 * Pointing a lane-artifact placeholder at `retrieve_summary` is a dead end —
 * that store never held the content. This scans the original text (before
 * truncation) for lane-output refs and, if found, names the correct tool and
 * ref directly, since the truncated excerpt kept in the placeholder does not
 * reliably preserve the ref.
 *
 * R7 fix: capped to ONE ref, not the full unique set. Each `L1:` ref is ~197
 * characters, and the entire purpose of a placeholder is to FREE tokens.
 * Including up to three refs (the prior behavior) could add ~600 characters
 * to a placeholder replacing a short tool result — growing it instead of
 * shrinking it, and driving the computed `freedTokens` negative. One ref is
 * enough for the model to recover the lane payload; it does not need every
 * ref that happened to appear in the excerpt. This does not fully guarantee
 * the placeholder stays shorter than the original (the fixed "First 200
 * chars" excerpt overhead can already exceed a very short original on its
 * own — a separate, pre-existing class of bloat this fix does not attempt to
 * solve), but it removes the ref list as an *additional* multiplier on top
 * of that. `freedTokens` is separately clamped to non-negative at both call
 * sites (`applyObservationMasking`, `maskToolOutput`) so a placeholder that
 * still comes out longer than the original can never corrupt the summed
 * budget accounting.
 */
function recoveryHint(originalText: string): string {
	const matches = originalText.match(LANE_OUTPUT_REF_PATTERN);
	if (matches && matches.length > 0) {
		return `Use retrieve_lane_output with ref ${matches[0]} if needed.`;
	}
	return GENERIC_RECOVERY_HINT;
}

/**
 * Extract plain text from message parts, including completed tool outputs
 * (`ToolPart.state.output`). Used for size checks and freed-token estimates so
 * the heavy tool-result payloads are accounted for (issue #2068).
 *
 * NOTE: a sibling `extractMessageText` lives in `message-priority.ts` for
 * classification. They intentionally differ slightly (see the comment there).
 */
function extractMessageText(msg: MessageWithParts): string {
	if (!msg?.parts) return '';
	const chunks: string[] = [];
	for (const part of msg.parts) {
		if (part.type === 'text' && part.text) {
			chunks.push(part.text);
		} else if (
			part.type === 'tool' &&
			part.state?.status === 'completed' &&
			typeof part.state.output === 'string'
		) {
			chunks.push(part.state.output);
		}
	}
	return chunks.join('\n');
}

/**
 * Check if tool output should be masked.
 * Mask completed tool results that are older than recentWindowSize OR larger
 * than the threshold. Error-state outputs are never masked (diagnostic
 * signal); pending/running have no output. Exempt tools (paged artifacts,
 * summarized task results, reads, ref-carrying lane tools —
 * `SUMMARIZER_EXEMPT_TOOL_NAMES`) are preserved.
 */
function shouldMaskToolOutput(
	msg: MessageWithParts,
	index: number,
	totalMessages: number,
	recentWindowSize: number,
	threshold: number,
): boolean {
	const toolParts = getToolParts(msg);
	if (toolParts.length === 0) return false;

	// Only completed tool outputs are maskable. Error/pending/running carry no
	// maskable output (errors preserve diagnostic signal).
	const maskable = toolParts.filter(
		(p) =>
			p.state?.status === 'completed' && typeof p.state.output === 'string',
	);
	if (maskable.length === 0) return false;

	// Skip if already masked (a synthetic text placeholder replaced the part).
	const text = extractMessageText(msg);
	if (
		text.includes('[Tool output masked') ||
		text.includes('[Context pruned')
	) {
		return false;
	}

	// Exempt tools: only skip when ALL tool parts are exempt.
	const exemptList = SUMMARIZER_EXEMPT_TOOL_NAMES as readonly string[];
	const toolNames = getToolNames(msg).map((n) => n.toLowerCase());
	if (toolNames.length > 0 && toolNames.every((n) => exemptList.includes(n))) {
		return false;
	}

	// Calculate age of message (0 = most recent)
	const age = totalMessages - 1 - index;

	// Mask if old enough OR large enough
	return age > recentWindowSize || text.length > threshold;
}

/**
 * Mask completed tool outputs by REPLACING each `ToolPart` with a synthetic
 * `{ type: 'text', text: placeholder }` part. The OpenCode `ToolState` is a
 * discriminated union on `status`; mutating `state.output` in place would
 * corrupt the shape and break downstream lifecycle/summarizer consumers.
 * Replacing the whole part is the contract-valid way to reduce provider tokens
 * (the host serializes the mutated `parts[]` after the transform hook runs —
 * v6.85.1, v7.4.0). Per-part exempt tools are skipped. Returns the number of
 * tokens freed (clamped to ≥ 0 per part — R7).
 */
function maskToolOutput(msg: MessageWithParts, _threshold: number): number {
	if (!msg?.parts || !Array.isArray(msg.parts)) return 0;

	const exemptList = SUMMARIZER_EXEMPT_TOOL_NAMES as readonly string[];
	let freedTokens = 0;

	for (let i = 0; i < msg.parts.length; i++) {
		const part = msg.parts[i];
		if (
			part?.type !== 'tool' ||
			part.state?.status !== 'completed' ||
			typeof part.state?.output !== 'string'
		) {
			continue;
		}

		// Per-part exempt check: even when the message is eligible (it has at
		// least one non-exempt tool), individual exempt tool outputs must stay
		// visible (issue #2068 review).
		const partToolName =
			typeof part.tool === 'string' ? part.tool.toLowerCase() : '';
		if (partToolName && exemptList.includes(partToolName)) {
			continue;
		}

		const output = part.state.output;
		// Skip if already masked.
		if (
			output.includes('[Tool output masked') ||
			output.includes('[Context pruned')
		) {
			continue;
		}

		const originalTokens = estimateTokens(output);
		const toolName = part.tool || 'unknown';
		const excerpt = output.substring(0, 200).replace(/\n/g, ' ');
		const placeholder = `[Tool output masked — ${toolName} returned ~${originalTokens} tokens. First 200 chars: "${excerpt}..." ${recoveryHint(output)}]`;
		const maskedTokens = estimateTokens(placeholder);

		// Replace the ToolPart with a synthetic text part. This preserves the
		// `parts[]` array contract (no phantom fields on `state`) and reduces
		// the provider-serialized payload.
		msg.parts[i] = { type: 'text', text: placeholder };
		// Clamp to 0 (R7): a placeholder can come out longer than a very short
		// original; never let that show as negative freed tokens (which would
		// silently INCREASE totalTokens in the summed budget accounting).
		freedTokens += Math.max(0, originalTokens - maskedTokens);
	}

	return freedTokens;
}
