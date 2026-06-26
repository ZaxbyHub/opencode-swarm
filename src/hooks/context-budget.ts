/**
 * Context Budget Tracker Hook
 *
 * Estimates token usage across all messages and injects budget warnings
 * when thresholds are exceeded. Uses experimental.chat.messages.transform
 * to provide proactive context management guidance to the architect agent.
 */

import type { PluginConfig } from '../config';
import { stripKnownSwarmPrefix } from '../config/schema';
import { log, warn } from '../utils';
import {
	classifyMessages,
	isToolResult,
	MessagePriority,
	type MessagePriorityType,
} from './message-priority';
import { extractModelInfo, resolveModelLimit } from './model-limits';
import { estimateTokens } from './utils';

// Module-level state to track last-seen agent for agent-switch detection (Task 4.1)
let lastSeenAgent: string | undefined;

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

	// Create the handler function
	const handler = async (
		_input: Record<string, never>,
		output: { messages?: MessageWithParts[] },
	): Promise<void> => {
		const messages = output?.messages;
		if (!messages || messages.length === 0) return;

		// Extract model and provider info from messages
		const { modelID, providerID } = extractModelInfo(messages);
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

		// Calculate total token usage across all text parts
		let totalTokens = 0;
		for (const message of messages) {
			if (!message?.parts) continue;

			for (const part of message.parts) {
				if (part?.type === 'text' && part.text) {
					totalTokens += estimateTokens(part.text);
				}
			}
		}

		const usagePercent = totalTokens / modelLimit;

		// Extract agent info from last user message for agent-switch detection
		let baseAgent: string | undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg?.info?.role === 'user' && msg?.info?.agent) {
				baseAgent = stripKnownSwarmPrefix(msg.info.agent);
				break;
			}
		}

		// Agent-switch detection (Task 4.1)
		let ratio = usagePercent; // Declare early for agent-switch override
		if (
			lastSeenAgent !== undefined &&
			baseAgent !== undefined &&
			baseAgent !== lastSeenAgent
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
					`[swarm] Agent switch detected: ${lastSeenAgent} → ${baseAgent}, enforcing context budget`,
					{
						from: lastSeenAgent,
						to: baseAgent,
					},
				);
				// Set ratio to critical to trigger enforcement
				ratio = 1.0; // Force > criticalThreshold
			}
		}

		// Update lastSeenAgent for next call
		lastSeenAgent = baseAgent;

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

				// Tool output masking (Task 4.2): Replace old tool results with placeholders
				// This runs BEFORE priority-based pruning to reduce token load early
				const toolMaskThreshold =
					config.context_budget?.tool_output_mask_threshold ?? 2000;
				let toolMaskFreedTokens = 0;
				const maskedIndices = new Set<number>();

				for (let i = 0; i < (output.messages || []).length; i++) {
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
				const preserveLastNTurns =
					config.context_budget?.preserve_last_n_turns ?? 4;
				const removableMessages = identifyRemovableMessages(
					output.messages || [],
					priorities,
					preserveLastNTurns,
				);

				// Step 3: Remove messages until targetTokens reached
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
 * Identify messages that can be safely removed
 * Returns indices in priority removal order (DISPOSABLE, LOW, MEDIUM)
 */
function identifyRemovableMessages(
	messages: MessageWithParts[],
	priorities: MessagePriorityType[],
	preserveLastNTurns: number,
): number[] {
	// Find last N user+assistant pairs (turn boundaries)
	let turnCount = 0;
	const protectedIndices = new Set<number>();

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
 * Replace message content with observation masking placeholder
 * Returns the actual number of tokens freed (original - masked placeholder)
 */
function applyObservationMasking(
	messages: MessageWithParts[],
	toRemove: Set<number>,
): number {
	let actualFreedTokens = 0;

	for (const idx of toRemove) {
		const msg = messages[idx];
		if (msg?.parts) {
			for (const part of msg.parts) {
				if (part.type === 'text' && part.text) {
					const originalTokens = estimateTokens(part.text);
					const placeholder = `[Context pruned — message from turn ${idx}, ~${originalTokens} tokens freed. Use retrieve_summary if needed.]`;
					const maskedTokens = estimateTokens(placeholder);
					part.text = placeholder;
					actualFreedTokens += originalTokens - maskedTokens;
				}
			}
		}
	}

	return actualFreedTokens;
}

/**
 * Extract plain text from message parts
 */
function extractMessageText(msg: MessageWithParts): string {
	if (!msg?.parts) return '';
	return msg.parts
		.filter((p) => p.type === 'text' && p.text)
		.map((p) => p.text)
		.join('\n');
}

/**
 * Extract tool name from tool output text
 * Looks for common patterns like "read_file", "write", "edit", etc.
 */
function extractToolName(text: string): string | undefined {
	// Try to extract tool name from common patterns
	const match = text.match(
		/^(read_file|write|edit|apply_patch|swarm_apply_patch|task|bun|npm|git|bash|glob|grep|mkdir|cp|mv|rm)\b/i,
	);
	return match?.[1];
}

/**
 * Check if tool output should be masked
 * Mask if older than recentWindowSize OR larger than threshold
 */
function shouldMaskToolOutput(
	msg: MessageWithParts,
	index: number,
	totalMessages: number,
	recentWindowSize: number,
	threshold: number,
): boolean {
	// Only mask tool result messages
	if (!isToolResult(msg)) return false;

	// Check if already masked (contains placeholder text)
	const text = extractMessageText(msg);
	if (
		text.includes('[Tool output masked') ||
		text.includes('[Context pruned')
	) {
		return false;
	}

	// Exempt retrieval tools and small read/task outputs.
	// - retrieve_lane_output / retrieve_summary: paged artifacts must stay visible so the
	//   architect can page through them; masking defeats the delivery mechanism.
	// - task: results are already summarized by the agent that created the task call
	// Check structured tool name first (reliable); fall back to text heuristic for
	// legacy tool result formats that may not carry toolName in msg.info.
	const structuredToolName = msg.info.toolName as string | undefined;
	const exemptList = [
		'retrieve_summary',
		'retrieve_lane_output',
		'task',
		'read',
	];
	if (
		structuredToolName &&
		exemptList.includes(structuredToolName.toLowerCase())
	) {
		return false;
	}
	const toolName = extractToolName(text);
	if (toolName && exemptList.includes(toolName.toLowerCase())) {
		return false;
	}

	// Calculate age of message (0 = most recent)
	const age = totalMessages - 1 - index;

	// Mask if old enough OR large enough (changed from AND to OR for v6.14.12)
	return age > recentWindowSize || text.length > threshold;
}

/**
 * Mask tool output with placeholder
 * Returns the number of tokens freed (original - masked)
 */
function maskToolOutput(msg: MessageWithParts, _threshold: number): number {
	if (!msg?.parts) return 0;

	let freedTokens = 0;

	for (const part of msg.parts) {
		if (part.type === 'text' && part.text) {
			// Skip if already masked
			if (
				part.text.includes('[Tool output masked') ||
				part.text.includes('[Context pruned')
			) {
				continue;
			}

			const originalTokens = estimateTokens(part.text);
			const toolName = extractToolName(part.text) || 'unknown';
			const excerpt = part.text.substring(0, 200).replace(/\n/g, ' ');

			const placeholder = `[Tool output masked — ${toolName} returned ~${originalTokens} tokens. First 200 chars: "${excerpt}..." Use retrieve_summary if needed.]`;
			const maskedTokens = estimateTokens(placeholder);
			part.text = placeholder;
			freedTokens += originalTokens - maskedTokens;
		}
	}

	return freedTokens;
}
