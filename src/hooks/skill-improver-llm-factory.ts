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

		if (signal?.aborted) {
			cleanup();
			throw new Error('SKILL_IMPROVER_LLM_TIMEOUT');
		}
		signal?.addEventListener('abort', cleanup, { once: true });

		try {
			const createResult = await client.session.create({
				query: { directory },
			});
			if (!createResult.data) {
				throw new Error(
					`Failed to create skill_improver session: ${JSON.stringify(createResult.error)}`,
				);
			}
			ephemeralSessionId = createResult.data.id;
			if (signal?.aborted) throw new Error('SKILL_IMPROVER_LLM_TIMEOUT');

			const agentName = resolveSkillImproverAgentName(sessionId);

			let promptResult: Awaited<ReturnType<typeof client.session.prompt>>;
			try {
				const prelude = systemPrompt
					? `${systemPrompt}\n\n---\n\n${userInput}`
					: userInput;
				promptResult = await client.session.prompt({
					path: { id: ephemeralSessionId },
					body: {
						agent: agentName,
						tools: { write: false, edit: false, patch: false },
						parts: [{ type: 'text', text: prelude }],
					},
				});
			} catch (err) {
				if (signal?.aborted) throw new Error('SKILL_IMPROVER_LLM_TIMEOUT');
				throw err;
			}

			if (!promptResult.data) {
				throw new Error(
					`skill_improver LLM prompt failed: ${JSON.stringify(promptResult.error)}`,
				);
			}

			const textParts = promptResult.data.parts.filter(
				(p): p is typeof p & { text: string } => p.type === 'text',
			);
			return textParts.map((p) => p.text).join('\n');
		} finally {
			signal?.removeEventListener('abort', cleanup);
			cleanup();
		}
	};
}

export const _internals = {
	createSkillImproverLLMDelegate,
	resolveSkillImproverAgentName,
};
