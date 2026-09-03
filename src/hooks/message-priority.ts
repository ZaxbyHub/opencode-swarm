/**
 * Message Priority Classifier Hook
 *
 * Provides zero-cost message priority classification to enable intelligent
 * context pruning. Messages are tagged with priority tiers (0-4) so that
 * low-priority messages are removed first during context budget pressure.
 *
 * Priority tiers:
 * - CRITICAL (0): System prompt, plan state, active instructions
 * - HIGH (1): User messages, current task context, tool definitions
 * - MEDIUM (2): Recent assistant responses, recent tool results
 * - LOW (3): Old assistant responses, old tool results, confirmations
 * - DISPOSABLE (4): Duplicate reads, superseded writes, stale errors
 */

import { isGuidanceCarrier } from './system-guidance-carrier.js';

/**
 * Message priority tiers for context pruning decisions.
 * Lower values = higher priority (kept longer during pruning).
 */
export const MessagePriority = {
	/** System prompt, plan state, active instructions - never prune */
	CRITICAL: 0,
	/** User messages, current task context, tool definitions */
	HIGH: 1,
	/** Recent assistant responses, recent tool results (within recentWindowSize) */
	MEDIUM: 2,
	/** Old assistant responses, old tool results */
	LOW: 3,
	/** Duplicate reads, superseded writes, stale errors - prune first */
	DISPOSABLE: 4,
} as const;

export type MessagePriorityType =
	(typeof MessagePriority)[keyof typeof MessagePriority];

/** Message structure matching the format from context-budget.ts */
interface MessageInfo {
	role?: string;
	agent?: string;
	sessionID?: string;
	modelID?: string;
	providerID?: string;
	[key: string]: unknown;
}

interface MessagePart {
	type?: string;
	text?: string;
	// ToolPart fields (OpenCode SDK `ToolPart`).
	tool?: string;
	state?: ToolStateLike;
	[key: string]: unknown;
}

/**
 * Minimal shape of a `ToolPart.state` value. The OpenCode SDK `ToolState` is a
 * discriminated union on `status`; only `completed` carries `output` and only
 * `error` carries `error`. We read defensively and never mutate `state` in
 * place (see context-budget.ts mask/prune logic — those replace the whole
 * ToolPart with a synthetic text part rather than corrupting the union).
 */
interface ToolStateLike {
	status?: string;
	output?: string;
	error?: string;
	input?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface MessageWithParts {
	info?: MessageInfo;
	parts?: MessagePart[];
}

/**
 * Checks if text contains .swarm/plan or .swarm/context references
 * indicating swarm state that should be preserved.
 *
 * @param text - The text content to check
 * @returns true if the text contains plan/context references
 */
export function containsPlanContent(text: string): boolean {
	if (!text) return false;

	const lowerText = text.toLowerCase();
	return (
		lowerText.includes('.swarm/plan') ||
		lowerText.includes('.swarm/context') ||
		lowerText.includes('swarm/plan.md') ||
		lowerText.includes('swarm/context.md')
	);
}

/**
 * Returns all `ToolPart` objects in a message's `parts[]`.
 *
 * Per the OpenCode SDK contract (`@opencode-ai/sdk` v1+v2), tool results are
 * delivered as `ToolPart` objects (`part.type === 'tool'`, with `part.tool`
 * and `part.state`) inside a message's `parts[]` array — they are NOT separate
 * `role:'tool'` messages and do not carry an `info.toolName` field. A message
 * may contain multiple tool parts (parallel tool calls).
 *
 * @param message - The message to inspect
 * @returns Array of tool parts (empty if none / malformed)
 */
export function getToolParts(message: MessageWithParts): MessagePart[] {
	if (!message?.parts || !Array.isArray(message.parts)) return [];
	return message.parts.filter(
		(part) => part?.type === 'tool' && typeof part === 'object',
	);
}

/**
 * Returns the completed tool outputs in a message — the countable, maskable
 * payloads (`part.state.output` where `state.status === 'completed'`).
 *
 * Pending/running tools have no output; error tools expose `state.error`
 * (diagnostic signal — never masked, only routed via the stale-error →
 * DISPOSABLE pruning path). Completed outputs are the heavy payloads the
 * context budget must count and may mask/prune.
 *
 * @param message - The message to inspect
 * @returns Array of `{ part, output }` for each completed tool part
 */
export function getCompletedToolOutputs(
	message: MessageWithParts,
): Array<{ part: MessagePart; output: string }> {
	const results: Array<{ part: MessagePart; output: string }> = [];
	for (const part of getToolParts(message)) {
		const state = part.state;
		if (
			state &&
			state.status === 'completed' &&
			typeof state.output === 'string'
		) {
			results.push({ part, output: state.output });
		}
	}
	return results;
}

/**
 * Returns the tool names (`part.tool`) for every tool part in a message.
 *
 * @param message - The message to inspect
 * @returns Array of tool name strings (empty if none)
 */
export function getToolNames(message: MessageWithParts): string[] {
	return getToolParts(message)
		.map((part) => part.tool)
		.filter((name): name is string => typeof name === 'string' && !!name);
}

/**
 * Checks if a message carries at least one tool result (a `ToolPart` in its
 * `parts[]`).
 *
 * This detects the real OpenCode SDK shape. The legacy `info.toolName` field
 * never existed on production payloads and was removed (issue #2068).
 *
 * @param message - The message to check
 * @returns true if the message contains at least one tool part
 */
export function isToolResult(message: MessageWithParts): boolean {
	return getToolParts(message).length > 0;
}

/**
 * Checks if two consecutive tool read calls are duplicates
 * (same tool with same first argument).
 *
 * Compares the first tool part in each message (`part.tool` name and the first
 * value of `part.state.input`). Two messages are duplicate reads when both
 * call a read tool whose name contains "read" with the same first input value.
 *
 * @param current - The current message
 * @param previous - The previous message
 * @returns true if this is a duplicate tool read
 */
export function isDuplicateToolRead(
	current: MessageWithParts,
	previous: MessageWithParts,
): boolean {
	const currentTools = getToolNames(current);
	const previousTools = getToolNames(previous);
	if (currentTools.length === 0 || previousTools.length === 0) return false;

	const currentTool = currentTools[0];
	const previousTool = previousTools[0];

	// Must be the same tool
	if (currentTool !== previousTool) return false;

	// Must be read operations
	const isReadTool =
		currentTool.toLowerCase().includes('read') &&
		previousTool.toLowerCase().includes('read');
	if (!isReadTool) return false;

	// Compare first input value from state.input
	const currentInput = getFirstInputValue(current);
	const previousInput = getFirstInputValue(previous);
	if (currentInput === undefined || previousInput === undefined) return false;

	return currentInput === previousInput;
}

/** Returns the first value of `state.input` for the first tool part, or undefined. */
function getFirstInputValue(message: MessageWithParts): unknown {
	const part = getToolParts(message)[0];
	const input = part?.state?.input;
	if (!input || typeof input !== 'object') return undefined;
	const keys = Object.keys(input);
	if (keys.length === 0) return undefined;
	return (input as Record<string, unknown>)[keys[0]];
}

/**
 * Checks if a message contains an error pattern and is stale
 * (more than the specified number of turns old).
 *
 * @param text - The message text to check
 * @param turnsAgo - How many turns ago the message was sent
 * @returns true if the message is a stale error
 */
export function isStaleError(text: string, turnsAgo: number): boolean {
	if (!text) return false;

	// Only check messages older than threshold
	if (turnsAgo <= 6) return false;

	const lowerText = text.toLowerCase();

	// Common error patterns
	const errorPatterns = [
		'error:',
		'failed to',
		'could not',
		'unable to',
		'exception',
		'errno',
		'cannot read',
		'not found',
		'access denied',
		'timeout',
	];

	return errorPatterns.some((pattern) => lowerText.includes(pattern));
}

/**
 * Extracts text content from a message's parts, including completed tool
 * outputs (`ToolPart.state.output`) so classification checks (plan content,
 * stale errors) can see tool-result text.
 *
 * NOTE: a sibling `extractMessageText` lives in `context-budget.ts` for token
 * accounting. They intentionally differ slightly: this one accepts any part
 * with a truthy `.text` (classification is lenient), while the context-budget
 * copy requires `part.type === 'text'` (accounting is strict). Keep both in
 * sync when changing part-walking logic.
 *
 * @param message - The message to extract text from
 * @returns The concatenated text content
 */
function extractMessageText(message: MessageWithParts): string {
	if (!message?.parts || message.parts.length === 0) return '';

	const chunks: string[] = [];
	for (const part of message.parts) {
		if (typeof part?.text === 'string' && part.text) {
			chunks.push(part.text);
		} else if (
			part?.type === 'tool' &&
			part.state?.status === 'completed' &&
			typeof part.state.output === 'string'
		) {
			// Include completed tool output so stale-error / plan-content
			// classification applies to tool results too.
			chunks.push(part.state.output);
		}
	}
	return chunks.join('');
}

/**
 * Classifies a message by priority tier for intelligent pruning.
 *
 * @param message - The message to classify
 * @param index - Position in messages array (0-indexed)
 * @param totalMessages - Total number of messages
 * @param recentWindowSize - Number of recent messages to consider MEDIUM (default 10)
 * @returns Priority tier (0=CRITICAL, 1=HIGH, 2=MEDIUM, 3=LOW, 4=DISPOSABLE)
 */
export function classifyMessage(
	message: MessageWithParts,
	index: number,
	totalMessages: number,
	recentWindowSize: number = 10,
): MessagePriorityType {
	// Extract role and text for classification
	const role = message?.info?.role;
	const text = extractMessageText(message);

	// 1. Check for plan/context content - CRITICAL (preserve swarm state)
	if (containsPlanContent(text)) {
		return MessagePriority.CRITICAL;
	}

	// 2. System messages - CRITICAL (never prune swarm state)
	if (role === 'system') {
		return MessagePriority.CRITICAL;
	}

	// 2b. Guidance carriers - CRITICAL (issue #2526: model-only guidance now
	// rides user-role carriers; without this carve-out they would land at HIGH
	// via the user branch and become prunable, which system entries never were)
	if (role === 'user' && isGuidanceCarrier(message)) {
		return MessagePriority.CRITICAL;
	}

	// 3. User messages - HIGH
	if (role === 'user') {
		return MessagePriority.HIGH;
	}

	// 4. Check for tool results
	if (isToolResult(message)) {
		const positionFromEnd = totalMessages - 1 - index;

		// Recent tool results - MEDIUM
		if (positionFromEnd < recentWindowSize) {
			return MessagePriority.MEDIUM;
		}

		// Check for stale errors
		if (isStaleError(text, positionFromEnd)) {
			return MessagePriority.DISPOSABLE;
		}

		// Older tool results - LOW
		return MessagePriority.LOW;
	}

	// 5. Assistant messages
	if (role === 'assistant') {
		const positionFromEnd = totalMessages - 1 - index;

		// Recent assistant messages - MEDIUM
		if (positionFromEnd < recentWindowSize) {
			return MessagePriority.MEDIUM;
		}

		// Check for stale errors
		if (isStaleError(text, positionFromEnd)) {
			return MessagePriority.DISPOSABLE;
		}

		// Older assistant messages - LOW
		return MessagePriority.LOW;
	}

	// 6. Default: treat as LOW priority
	return MessagePriority.LOW;
}

/**
 * Classifies a batch of messages with duplicate detection.
 * This function should be called in order (oldest to newest) to properly
 * detect consecutive duplicate tool reads.
 *
 * @param messages - Array of messages to classify
 * @param recentWindowSize - Number of recent messages to consider MEDIUM (default 10)
 * @returns Array of priority classifications matching message order
 */
export function classifyMessages(
	messages: MessageWithParts[],
	recentWindowSize: number = 10,
): MessagePriorityType[] {
	const results: MessagePriorityType[] = [];
	const totalMessages = messages.length;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		const priority = classifyMessage(
			message,
			i,
			totalMessages,
			recentWindowSize,
		);

		// Check for consecutive duplicate tool reads (when looking at newer messages)
		// Mark older duplicates as DISPOSABLE
		if (i > 0) {
			const current = messages[i];
			const previous = messages[i - 1];

			if (isDuplicateToolRead(current, previous)) {
				// Only demote if not already CRITICAL or HIGH priority
				if (results[i - 1] >= MessagePriority.MEDIUM) {
					results[i - 1] = MessagePriority.DISPOSABLE;
				}
			}
		}

		results.push(priority);
	}

	return results;
}
