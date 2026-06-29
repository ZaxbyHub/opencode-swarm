import type { PluginConfig } from '../../../src/config';
import {
	ensureAgentSession,
	getTaskState,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

// Re-export everything from the main test file for consumers
export { createDelegationGateHook } from '../../../src/hooks/delegation-gate';

export function makeConfig(overrides?: Record<string, unknown>): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		hooks: {
			system_enhancer: true,
			compaction: true,
			agent_activity: true,
			delegation_tracker: false,
			agent_awareness_max_chars: 300,
			delegation_gate: true,
			delegation_max_chars: 4000,
			...(overrides?.hooks as Record<string, unknown>),
		},
	} as PluginConfig;
}

export function makeMessages(
	text: string,
	agent?: string,
	sessionID: string | undefined | null = 'test-session',
) {
	return {
		messages: [
			{
				info: {
					role: 'user' as const,
					agent,
					sessionID: sessionID ?? undefined,
				},
				parts: [{ type: 'text', text }],
			},
		],
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MessageWithParts = any;

// Helper to find user messages in the array (accounts for injected system messages)
export function findUserMessage(messages: { messages: MessageWithParts[] }) {
	return messages.messages.find(
		(m: MessageWithParts) => m.info?.role === 'user',
	);
}

// Helper to find system messages (for [NEXT] guidance)
export function findSystemMessage(messages: { messages: MessageWithParts[] }) {
	return messages.messages.find(
		(m: MessageWithParts) => m.info?.role === 'system',
	);
}

// Helper to get concatenated text from all system messages (for warning assertions)
export function getSystemWarningText(messages: {
	messages: MessageWithParts[];
}): string {
	return messages.messages
		.filter((m: MessageWithParts) => m.info?.role === 'system')
		.map((m: MessageWithParts) => m.parts?.[0]?.text ?? '')
		.join('\n');
}

// Helper to get the primary text content - finds user message text if present, otherwise first message
export function getPrimaryText(messages: {
	messages: MessageWithParts[];
}): string {
	const userMsg = findUserMessage(messages);
	if (userMsg?.parts?.[0]) {
		return userMsg.parts[0].text ?? '';
	}
	// Fallback to first message if no user message found
	return messages.messages[0]?.parts?.[0]?.text ?? '';
}
