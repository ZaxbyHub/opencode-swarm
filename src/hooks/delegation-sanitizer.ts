/**
 * Delegation message sanitization - Layer 2 defense against inter-agent manipulation.
 * Strips attempt metadata, urgency references, and consequence claims from gate agent messages.
 */

import { appendCoreEventSync } from '../events/core-events.js';
import { safeHook } from './utils.js';

interface MessageInfo {
	role: string;
	agent?: string;
	sessionID?: string;
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

// Patterns to strip from gate agent messages
const SANITIZATION_PATTERNS = [
	// Attempt counts
	/\b\d+(st|nd|rd|th)\s+(attempt|try|time)\b/gi,
	/\b(5th|fifth|final|last)\s+attempt\b/gi,
	/attempt\s+\d+\s*\/\s*\d+/gi,

	// Urgency references
	/\bthis\s+is\s+(the\s+)?(5th|fifth|final|last)\b/gi,
	/\bwe('re|\s+are)\s+(behind|late)\b/gi,
	/\buser\s+is\s+waiting\b/gi,
	/\bship\s+(this|it)\s+now\b/gi,

	// Consequence claims
	/\bor\s+I('ll|\s+will)\s+(stop|halt|alert)\b/gi,
	/\bor\s+all\s+work\s+stops\b/gi,
	/\bthis\s+will\s+(delay|block)\s+everything\b/gi,

	// Emotional pressure
	/\b(I'm|I\s+am)\s+(frustrated|disappointed)\b/gi,
];

/**
 * Sanitize a message by stripping manipulation patterns.
 * Returns sanitized text and logs if any stripping occurred.
 */
export function sanitizeMessage(
	text: string,
	patterns: RegExp[] = SANITIZATION_PATTERNS,
): {
	sanitized: string;
	modified: boolean;
	stripped: string[];
} {
	let sanitized = text;
	const stripped: string[] = [];

	for (const pattern of patterns) {
		const matches = sanitized.match(pattern);
		if (matches) {
			stripped.push(...matches);
			sanitized = sanitized.replace(pattern, '');
		}
	}

	// Clean up extra whitespace
	sanitized = sanitized.replace(/\s+/g, ' ').trim();

	return {
		sanitized,
		modified: stripped.length > 0,
		stripped,
	};
}

/**
 * Check if message is to a gate agent (reviewer, test_engineer, critic).
 */
export function isGateAgentMessage(agentName: string): boolean {
	const gateAgents = ['reviewer', 'test_engineer', 'critic', 'test-engineer'];
	const normalized = agentName.toLowerCase().replace(/-/g, '_');
	return gateAgents.includes(normalized);
}

/**
 * Create a hook that sanitizes delegation messages to gate agents.
 * @param directory - The project directory containing the .swarm folder
 */
export function createDelegationSanitizerHook(
	directory: string,
): (input: unknown, output: unknown) => Promise<void> {
	const hook = async (_input: unknown, output: unknown): Promise<void> => {
		// Extract messages from output
		const messages = (output as { messages?: unknown })?.messages;
		if (!messages || !Array.isArray(messages)) {
			return;
		}

		// Process each message
		for (const message of messages as MessageWithParts[]) {
			const info = message?.info;
			if (!info) continue;

			// Check if message is to a gate agent
			const agent = info.agent;
			if (!agent || !isGateAgentMessage(agent)) {
				continue;
			}

			// Process each text part in the message
			if (!message.parts || !Array.isArray(message.parts)) {
				continue;
			}

			for (const part of message.parts as MessagePart[]) {
				if (part?.type !== 'text' || !part.text) {
					continue;
				}

				const originalText = part.text;
				const result = sanitizeMessage(originalText);

				if (result.modified) {
					// Update the message in place
					part.text = result.sanitized;

					// Log sanitization event to events.jsonl
					try {
						const event = {
							event: 'message_sanitized',
							agent,
							original_length: originalText.length,
							stripped_count: result.stripped.length,
							stripped_patterns: result.stripped,
							timestamp: new Date().toISOString(),
						};
						appendCoreEventSync(directory, event);
					} catch {
						// Silently swallow errors - non-fatal operation
					}
				}
			}
		}
	};

	return safeHook(hook);
}

export { SANITIZATION_PATTERNS };
