/**
 * CC Command Intercept Hook
 *
 * Runtime message pipeline hook that detects bare Claude Code commands in agent
 * messages and performs safe interventions:
 *  - CRITICAL destructive (/reset, /clear): hard-blocks via output mutation
 *  - CRITICAL non-destructive (/plan): soft-corrects to /swarm plan
 *  - HIGH severity: advisory log only, no text modification
 *
 * Designed for <5ms execution on 10k-token messages via simple regex/string ops.
 * Idempotent: skips text already annotated with [CC_COMMAND_INTERCEPT].
 */

import {
	CONFLICT_MAP,
	type ConflictSeverity,
} from '../commands/conflict-registry';
import { CLAUDE_CODE_NATIVE_COMMANDS } from '../config/constants';
import * as logger from '../utils/logger';

export interface CcInterceptConfig {
	/** Severities to process (default: ['CRITICAL', 'HIGH']) */
	intercept: ConflictSeverity[];
	/** Whether to hard-block CRITICAL destructive commands (default: true) */
	blockDestructive: boolean;
	/** Whether to log intercept events (default: true) */
	logIntercepts: boolean;
}

interface MessageWithParts {
	info: {
		role: string;
		agent?: string;
		sessionID?: string;
		[key: string]: unknown;
	};
	parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
}

/**
 * Creates a messagesTransform hook that intercepts bare CC commands.
 *
 * @param config - Optional configuration overrides
 * @returns Hook object with messagesTransform function
 */
export function createCcCommandInterceptHook(
	config: Partial<CcInterceptConfig> = {},
): {
	messagesTransform: (
		input: Record<string, never>,
		output: { messages?: MessageWithParts[] },
	) => Promise<void>;
} {
	const {
		intercept = ['CRITICAL', 'HIGH'],
		blockDestructive = true,
		logIntercepts = true,
	} = config;

	const messagesTransform = async (
		_input: Record<string, never>,
		output: { messages?: MessageWithParts[] },
	): Promise<void> => {
		const messages = output.messages;
		if (!messages || messages.length === 0) return;

		const lastMsg = messages[messages.length - 1];
		if (!lastMsg?.parts) return;

		// Skip architect messages (the orchestrator, not a delegated agent)
		const agent = lastMsg.info?.agent ?? '';
		if (!agent || agent.includes('architect')) return;

		for (const part of lastMsg.parts) {
			if (part.type !== 'text' || !part.text) continue;

			// Idempotency: skip if already processed
			if (part.text.includes('[CC_COMMAND_INTERCEPT]')) continue;

			// Process the text content
			const modified = part.text;
			let hasCalls = false;
			let hasBlocked = false;

			// Split into lines for line-by-line detection
			const lines = modified.split('\n');
			let inCodeBlock = false;
			const resultLines: string[] = [];

			for (const line of lines) {
				// Track code block fences
				if (line.trimStart().startsWith('```')) {
					inCodeBlock = !inCodeBlock;
					resultLines.push(line);
					continue;
				}

				if (inCodeBlock) {
					resultLines.push(line);
					continue;
				}

				// Skip inline code
				const stripped = line.trim();
				if (stripped.startsWith('`') && stripped.endsWith('`')) {
					resultLines.push(line);
					continue;
				}

				// Skip URLs
				if (/^https?:\/\//i.test(stripped)) {
					resultLines.push(line);
					continue;
				}

				// Skip comments
				if (stripped.startsWith('//') || stripped.startsWith('#')) {
					resultLines.push(line);
					continue;
				}

				// Skip properly namespaced /swarm commands
				if (/^\/swarm\b/i.test(stripped)) {
					resultLines.push(line);
					continue;
				}

				// Detect bare CC command: line starting with /commandName
				const bareCmdMatch = stripped.match(/^\/(\w[\w-]*)\b/i);
				if (!bareCmdMatch) {
					resultLines.push(line);
					continue;
				}

				const bareCmd = bareCmdMatch[1].toLowerCase();

				// Special case: /clear is a CC alias for /reset (in CC's alias chain)
				// CONFLICT_MAP doesn't have 'clear' as a key since the conflict is on 'reset'
				const effectiveCmd = bareCmd === 'clear' ? 'reset' : bareCmd;

				// Check if it's a known CC command with a conflict
				const conflict = CONFLICT_MAP.get(effectiveCmd);
				if (!conflict) {
					// Check if it's in the native commands set (non-conflicting CC command)
					if (CLAUDE_CODE_NATIVE_COMMANDS.has(bareCmd)) {
						// Still log as a CC command reference
						if (logIntercepts) {
							logger.warn(
								`[CC_COMMAND_INTERCEPT] Agent referenced bare CC command /${bareCmd}`,
							);
						}
					}
					resultLines.push(line);
					continue;
				}

				const severity = conflict.severity;

				// Only process if severity is in our intercept list
				if (!intercept.includes(severity)) {
					resultLines.push(line);
					continue;
				}

				// Handle CRITICAL destructive commands (hard block via output mutation)
				if (
					blockDestructive &&
					conflict.severity === 'CRITICAL' &&
					(bareCmd === 'reset' ||
						bareCmd === 'clear' ||
						bareCmd === 'checkpoint')
				) {
					hasBlocked = true;
					resultLines.push(
						`[CC_COMMAND_INTERCEPT] BLOCKED: /${bareCmd} — this wipes conversation context. Use /swarm ${bareCmd} instead where applicable.`,
					);
					continue;
				}

				// Handle CRITICAL non-destructive (soft-correct /plan)
				if (conflict.severity === 'CRITICAL' && bareCmd === 'plan') {
					// Preserve leading whitespace in the replacement
					const indent = line.slice(0, line.length - line.trimStart().length);
					const corrected = `${indent}/swarm plan`;
					resultLines.push(corrected);
					resultLines.push('');
					resultLines.push(
						`[CC_COMMAND_INTERCEPT] Corrected /plan → /swarm plan to prevent CC plan mode activation.`,
					);
					hasCalls = true;
					continue;
				}

				// Handle HIGH severity (advisory, don't modify)
				if (conflict.severity === 'HIGH') {
					if (logIntercepts) {
						logger.warn(
							`[CC_COMMAND_INTERCEPT] Agent referenced bare CC command /${bareCmd} — interpret as /swarm ${conflict.swarmCommand}`,
						);
					}
					resultLines.push(line);
					continue;
				}

				resultLines.push(line);
			}

			if (hasBlocked || hasCalls) {
				part.text = resultLines.join('\n');
			}
		}
	};

	return { messagesTransform };
}
