/**
 * Issue #2486: the consent-gated capture observer.
 *
 * Registered once per plugin init (zero I/O at construction — AGENTS.md
 * invariant 1) into the real hook chain by `src/index.ts`
 * (`messagesTransformTrainingCaptureStep` in the
 * `experimental.chat.messages.transform` chain and a fail-open
 * `tool.execute.after` step consuming the shared callID args snapshot).
 *
 * Every observation re-evaluates the CURRENT active consent (mid-stream
 * revoke/expiry stops capture immediately; captured records keep the consent
 * lineage they were captured under). Plugin-injected guidance carriers
 * (`info.id` prefix `swarm-guidance:`) and `<swarm_system_directive` fenced
 * text are never captured as user content. The observer NEVER throws and
 * never mutates hook output (invariant 10).
 */
import packageJson from '../../package.json' with { type: 'json' };
import { readActiveTrainingConsent, type TrainingConsent } from './consent';
import {
	appendTrainingVaultRecord,
	buildTrainingVaultRecord,
	type TrainingVaultKind,
	type TrainingVaultRecord,
} from './vault';

const PLUGIN_VERSION: string = packageJson.version;
const MAX_DEDUP_PER_SESSION = 4096;
const GUIDANCE_CARRIER_ID_PREFIX = 'swarm-guidance:';
const DIRECTIVE_TEXT_PREFIX = '<swarm_system_directive';

interface MessageLike {
	info?: {
		role?: string;
		id?: string;
		sessionID?: string;
	};
	parts?: Array<{ type?: string; text?: string }>;
}

interface ToolExecutionLike {
	tool: string;
	sessionID?: string;
	input?: unknown;
	output?: unknown;
	error?: unknown;
}

export interface TrainingCaptureObserver {
	observeMessages(output: { messages?: MessageLike[] }): Promise<void>;
	observeToolExecution(event: ToolExecutionLike): Promise<void>;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? '';
	} catch {
		return String(value);
	}
}

export const _internals: {
	appendRecord: typeof appendTrainingVaultRecord;
	readConsent: (directory: string) => TrainingConsent | null;
	buildRecord: typeof buildTrainingVaultRecord;
} = {
	appendRecord: appendTrainingVaultRecord,
	readConsent: (directory) => readActiveTrainingConsent(directory),
	buildRecord: buildTrainingVaultRecord,
};

function kindForRole(role: string): TrainingVaultKind | null {
	if (role === 'user') return 'user_message';
	if (role === 'assistant') return 'assistant_message';
	return null;
}

/**
 * Create the observer. Pure construction — no filesystem access until the
 * first observation (which itself only reads when a message actually arrives).
 */
export function createTrainingCaptureObserver(
	directory: string,
): TrainingCaptureObserver {
	const dedupBySession = new Map<
		string,
		{ order: string[]; seen: Set<string> }
	>();

	function markSeen(sessionId: string, recordId: string): boolean {
		let entry = dedupBySession.get(sessionId);
		if (!entry) {
			entry = { order: [], seen: new Set<string>() };
			dedupBySession.set(sessionId, entry);
		}
		if (entry.seen.has(recordId)) return false;
		entry.seen.add(recordId);
		entry.order.push(recordId);
		if (entry.order.length > MAX_DEDUP_PER_SESSION) {
			const evicted = entry.order.shift();
			if (evicted !== undefined) entry.seen.delete(evicted);
		}
		return true;
	}

	function capture(
		kind: TrainingVaultKind,
		role: string,
		content: string,
		sessionId: string,
		source: 'chat' | 'tool',
	): void {
		const consent = _internals.readConsent(directory);
		if (!consent) return;
		const record: TrainingVaultRecord = _internals.buildRecord({
			directory,
			kind,
			role,
			content,
			sessionId,
			pluginVersion: PLUGIN_VERSION,
			source,
			consent,
		});
		if (!markSeen(sessionId, record.record_id)) return;
		_internals.appendRecord(directory, record);
	}

	return {
		async observeMessages(output: { messages?: MessageLike[] }): Promise<void> {
			try {
				const messages = output?.messages;
				if (!Array.isArray(messages)) return;
				for (const message of messages) {
					try {
						const info = message?.info;
						if (!info) continue;
						const sessionId = info.sessionID;
						if (typeof sessionId !== 'string' || sessionId.length === 0)
							continue;
						if (
							typeof info.id === 'string' &&
							info.id.startsWith(GUIDANCE_CARRIER_ID_PREFIX)
						) {
							continue;
						}
						const kind = kindForRole(info.role ?? '');
						if (!kind) continue;
						const parts = message.parts;
						if (!Array.isArray(parts)) continue;
						for (const part of parts) {
							try {
								if (part?.type !== 'text') continue;
								const text = typeof part.text === 'string' ? part.text : '';
								if (text.length === 0) continue;
								if (text.startsWith(DIRECTIVE_TEXT_PREFIX)) continue;
								capture(kind, info.role ?? '', text, sessionId, 'chat');
							} catch {
								// one bad part must never break the batch
							}
						}
					} catch {
						// one bad message must never break the batch
					}
				}
			} catch {
				// never throw out of a chat-transform observer (invariant 10)
			}
		},

		async observeToolExecution(event: ToolExecutionLike): Promise<void> {
			try {
				const sessionId = event?.sessionID;
				if (typeof sessionId !== 'string' || sessionId.length === 0) return;
				const tool = typeof event?.tool === 'string' ? event.tool : 'unknown';
				const inputSummary = safeStringify(event?.input);
				if (inputSummary.length > 0) {
					capture('tool_call', 'tool', inputSummary, sessionId, 'tool');
				}
				const outputSummary = safeStringify(
					event?.error ?? event?.output ?? '',
				);
				if (outputSummary.length > 0 && outputSummary !== '""') {
					capture(
						'tool_result',
						'tool',
						`${tool}\n${outputSummary}`,
						sessionId,
						'tool',
					);
				}
			} catch {
				// never throw out of a tool-after observer
			}
		},
	};
}
