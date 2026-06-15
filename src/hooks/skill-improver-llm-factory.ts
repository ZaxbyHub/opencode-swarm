/**
 * Skill-improver LLM delegate factory.
 *
 * Mirrors src/hooks/curator-llm-factory.ts so the skill_improver agent can be
 * dispatched via the same ephemeral-session-per-call pattern. Returns
 * `undefined` when `swarmState.opencodeClient` is null (e.g. in unit tests),
 * letting the caller fall back to deterministic mode behind an opt-in flag.
 *
 * Resolution priority for the registered agent name follows the curator
 * factory exactly: direct lookup via active session → heuristic scan → static
 * fallback. The `mode` parameter is reserved for future role variants (e.g.
 * "review_only" vs "draft_skills"); today both modes resolve to the same
 * `skill_improver` agent.
 */

import { swarmState } from '../state.js';

/**
 * True only for genuine cancellation errors (a native `AbortError` /
 * `TimeoutError` raised when a forwarded `AbortSignal` fires). Used to map
 * cancellation — and only cancellation — onto the `SKILL_IMPROVER_LLM_TIMEOUT`
 * sentinel, so a real failure that merely coincides with an aborted signal
 * still surfaces as itself rather than being misclassified as a timeout.
 */
function isAbortError(err: unknown): boolean {
	if (typeof err !== 'object' || err === null) return false;
	const name = (err as { name?: unknown }).name;
	return name === 'AbortError' || name === 'TimeoutError';
}

export type SkillImproverLLMDelegate = (
	systemPrompt: string,
	userInput: string,
	signal?: AbortSignal,
) => Promise<string>;

function resolveSkillImproverAgentName(sessionId?: string): string {
	const suffix = 'skill_improver';
	const registeredNames = swarmState.skillImproverAgentNames;
	if (registeredNames.length === 1) return registeredNames[0];
	if (registeredNames.length === 0) return suffix;

	const prefixMap = new Map<string, string>();
	for (const name of registeredNames) {
		const prefix = name.endsWith(suffix)
			? name.slice(0, name.length - suffix.length)
			: '';
		prefixMap.set(prefix, name);
	}

	const matchForAgent = (agentName: string): string => {
		let bestPrefix = '';
		let bestName = '';
		for (const [prefix, name] of prefixMap) {
			if (prefix && agentName.startsWith(prefix)) {
				if (prefix.length > bestPrefix.length) {
					bestPrefix = prefix;
					bestName = name;
				}
			}
		}
		return bestName;
	};

	if (sessionId) {
		const callingAgent = swarmState.activeAgent.get(sessionId);
		if (callingAgent) {
			const match = matchForAgent(callingAgent);
			if (match) return match;
			const defaultAgent = prefixMap.get('');
			if (defaultAgent) return defaultAgent;
		}
	}

	for (const activeAgentName of swarmState.activeAgent.values()) {
		const match = matchForAgent(activeAgentName);
		if (match) return match;
	}

	return prefixMap.get('') ?? registeredNames[0];
}

/**
 * Create a SkillImproverLLMDelegate that dispatches the registered
 * skill_improver agent on an ephemeral OpenCode session.
 *
 * Returns `undefined` when no OpenCode client is wired (unit tests, library
 * mode). Callers MUST handle that case explicitly: if the deterministic
 * fallback is disabled, refuse the run BEFORE reserving any quota.
 */
export function createSkillImproverLLMDelegate(
	directory: string,
	sessionId?: string,
): SkillImproverLLMDelegate | undefined {
	const client = swarmState.opencodeClient;
	if (!client) return undefined;

	return async (
		systemPrompt: string,
		userInput: string,
		signal?: AbortSignal,
	): Promise<string> => {
		let ephemeralSessionId: string | undefined;

		const cleanup = () => {
			if (ephemeralSessionId) {
				const id = ephemeralSessionId;
				ephemeralSessionId = undefined;
				client.session.delete({ path: { id } }).catch(() => {});
			}
		};

		// If the caller already aborted, bail.
		if (signal?.aborted) {
			throw new Error('SKILL_IMPROVER_LLM_TIMEOUT');
		}

		// Forward the abort signal to SDK fetch calls so native cancellation
		// is used instead of deleting the session mid-prompt (which caused
		// FK constraint crashes when OpenCode was still writing parts).
		const sdkOpts = signal ? { signal } : {};

		try {
			// Bind to the calling session as parent so OpenCode treats this as
			// a child session and does not persist it as a new root in the TUI.
			const createResult = await client.session.create({
				...(sessionId
					? {
							body: { parentID: sessionId, title: 'skill_improver background' },
						}
					: {}),
				query: { directory },
				...sdkOpts,
			});
			if (!createResult.data) {
				throw new Error(
					`Failed to create skill_improver session: ${JSON.stringify(createResult.error)}`,
				);
			}
			ephemeralSessionId = createResult.data.id;
			if (signal?.aborted) throw new Error('SKILL_IMPROVER_LLM_TIMEOUT');

			const agentName = resolveSkillImproverAgentName(sessionId);

			const prelude = systemPrompt
				? `${systemPrompt}\n\n---\n\n${userInput}`
				: userInput;
			const promptResult = await client.session.prompt({
				path: { id: ephemeralSessionId },
				body: {
					agent: agentName,
					tools: { write: false, edit: false, patch: false },
					parts: [{ type: 'text', text: prelude }],
				},
				...sdkOpts,
			});

			if (!promptResult.data) {
				// A null result while the signal is aborted is the cancellation
				// path, not a real prompt failure.
				if (signal?.aborted) throw new Error('SKILL_IMPROVER_LLM_TIMEOUT');
				throw new Error(
					`skill_improver LLM prompt failed: ${JSON.stringify(promptResult.error)}`,
				);
			}

			const textParts = promptResult.data.parts.filter(
				(p): p is typeof p & { text: string } => p.type === 'text',
			);
			return textParts.map((p) => p.text).join('\n');
		} catch (err) {
			// Translate only a genuine cancellation (native AbortError from the
			// forwarded signal) into the SKILL_IMPROVER_LLM_TIMEOUT sentinel. A
			// real failure that happens to coincide with an aborted signal must
			// surface as itself rather than being misreported as a timeout.
			if (isAbortError(err)) throw new Error('SKILL_IMPROVER_LLM_TIMEOUT');
			throw err;
		} finally {
			cleanup();
		}
	};
}

export const _internals = {
	createSkillImproverLLMDelegate,
	resolveSkillImproverAgentName,
};
