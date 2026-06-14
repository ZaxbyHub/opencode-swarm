import { swarmState } from '../state.js';
import type { CuratorLLMDelegate } from './curator.js';

/**
 * Resolve the registered curator agent name for a given swarm session.
 *
 * Resolution priority:
 *   1. **Direct lookup** (preferred): if `sessionId` is provided, look up the
 *      calling agent in `swarmState.activeAgent` and match its swarm prefix
 *      against registered curator names. Deterministic — never affected by
 *      unrelated sessions running in parallel.
 *   2. **Heuristic scan** (fallback when no sessionId): iterate activeAgent
 *      and find the registered curator whose prefix best matches any active
 *      agent, preferring the longest prefix. Correct for single-swarm
 *      deployments and for calls at session init time (only one swarm active).
 *   3. **Static fallback**: default-swarm curator (empty prefix), then first
 *      registered name, then bare suffix string.
 *
 * Prefix extraction: 'swarm1_curator_init' → prefix 'swarm1_' by stripping
 * the known suffix. Longest-match ensures 'alpha_extended_' beats 'alpha_'
 * when both are registered (prefix-collision avoidance).
 */
function resolveCuratorAgentName(
	mode: 'init' | 'phase' | 'postmortem',
	sessionId?: string,
): string {
	const suffixMap = {
		init: 'curator_init',
		phase: 'curator_phase',
		postmortem: 'curator_postmortem',
	} as const;
	const suffix = suffixMap[mode];
	const registeredNamesMap = {
		init: swarmState.curatorInitAgentNames,
		phase: swarmState.curatorPhaseAgentNames,
		postmortem: swarmState.curatorPostmortemAgentNames,
	} as const;
	const registeredNames = registeredNamesMap[mode];

	// Fast path: only one registered (single-swarm or default-only)
	if (registeredNames.length === 1) return registeredNames[0];
	// Ultimate fallback if none registered
	if (registeredNames.length === 0) return suffix;

	// Build prefix map: swarm prefix → full registered agent name.
	//   'swarm1_curator_init' → prefix='swarm1_', name='swarm1_curator_init'
	//   'curator_init'        → prefix='',        name='curator_init'
	const prefixMap = new Map<string, string>();
	for (const name of registeredNames) {
		const prefix = name.endsWith(suffix)
			? name.slice(0, name.length - suffix.length)
			: '';
		prefixMap.set(prefix, name);
	}

	/**
	 * Find the best-matching curator for a given active agent name.
	 * Returns the longest registered prefix that is a prefix of agentName,
	 * or empty string if no named-swarm prefix matches.
	 */
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

	// 1. Direct lookup via calling session — deterministic even under parallel swarms
	if (sessionId) {
		const callingAgent = swarmState.activeAgent.get(sessionId);
		if (callingAgent) {
			const match = matchForAgent(callingAgent);
			if (match) return match;
			// No named-swarm prefix matched → calling agent is on the default swarm.
			// Return the default-swarm curator (empty prefix) explicitly rather than
			// falling through to heuristic scan, which could pick a named-swarm curator.
			const defaultCurator = prefixMap.get('');
			if (defaultCurator) return defaultCurator;
		}
	}

	// 2. Heuristic scan — correct for single-swarm or session-init scenarios
	for (const activeAgentName of swarmState.activeAgent.values()) {
		const match = matchForAgent(activeAgentName);
		if (match) return match;
	}

	// 3. Static fallback: default swarm (empty prefix) → first registered
	return prefixMap.get('') ?? registeredNames[0];
}

/**
 * Create a CuratorLLMDelegate that uses the opencode SDK to call
 * the registered curator agent in CURATOR_INIT or CURATOR_PHASE mode.
 *
 * Uses an ephemeral session (create → prompt → delete) to avoid
 * re-entrancy with the current session's message flow.
 *
 * The `mode` parameter determines which registered named agent is used:
 *   - 'init'       → curator_init       (e.g. 'curator_init' or 'swarm1_curator_init')
 *   - 'phase'      → curator_phase      (e.g. 'curator_phase' or 'swarm1_curator_phase')
 *   - 'postmortem' → curator_postmortem  (e.g. 'curator_postmortem' or 'swarm1_curator_postmortem')
 *
 * The optional `sessionId` parameter enables deterministic swarm resolution:
 * when provided, the factory uses the calling session's registered agent to
 * identify the swarm prefix, rather than scanning all active sessions.
 * Pass `ctx?.sessionID` from tool handlers that have it available.
 *
 * Returns undefined if swarmState.opencodeClient is not set (e.g. in unit tests).
 */
export function createCuratorLLMDelegate(
	directory: string,
	mode: 'init' | 'phase' | 'postmortem' = 'init',
	sessionId?: string,
): CuratorLLMDelegate | undefined {
	const client = swarmState.opencodeClient;
	if (!client) return undefined;

	return async (
		_systemPrompt: string,
		userInput: string,
		signal?: AbortSignal,
	): Promise<string> => {
		let ephemeralSessionId: string | undefined;

		/** Best-effort session cleanup — never throws. */
		const cleanup = () => {
			if (ephemeralSessionId) {
				const id = ephemeralSessionId;
				ephemeralSessionId = undefined; // prevent double-delete
				client.session.delete({ path: { id } }).catch(() => {});
			}
		};

		// If the caller already aborted, clean up immediately and bail.
		if (signal?.aborted) {
			cleanup();
			throw new Error('CURATOR_LLM_TIMEOUT');
		}

		// Wire up abort listener so the ephemeral session is deleted as soon
		// as the timeout fires, rather than waiting for the SDK call to settle.
		signal?.addEventListener('abort', cleanup, { once: true });

		try {
			// 1. Create ephemeral session scoped to project directory
			const createResult = await client.session.create({
				query: { directory },
			});
			if (!createResult.data) {
				throw new Error(
					`Failed to create curator session: ${JSON.stringify(createResult.error)}`,
				);
			}
			ephemeralSessionId = createResult.data.id;

			// Re-check abort after awaiting session creation
			if (signal?.aborted) {
				throw new Error('CURATOR_LLM_TIMEOUT');
			}

			// 2. Resolve the curator agent name for the calling swarm.
			const agentName = resolveCuratorAgentName(mode, sessionId);

			// 3. Prompt using the registered curator agent.
			let promptResult: Awaited<ReturnType<typeof client.session.prompt>>;
			try {
				promptResult = await client.session.prompt({
					path: { id: ephemeralSessionId },
					body: {
						agent: agentName,
						tools: { write: false, edit: false, patch: false },
						parts: [{ type: 'text', text: userInput }],
					},
				});
			} catch (promptErr) {
				// When the abort signal has fired, the abort handler already
				// deleted the ephemeral session. The SDK will throw a
				// NotFoundError ("Session not found") for the now-deleted
				// session. Translate that into CURATOR_LLM_TIMEOUT so the
				// caller sees a clean timeout rather than an unexpected error.
				if (signal?.aborted) {
					throw new Error('CURATOR_LLM_TIMEOUT');
				}
				throw promptErr;
			}

			if (!promptResult.data) {
				throw new Error(
					`Curator LLM prompt failed: ${JSON.stringify(promptResult.error)}`,
				);
			}

			// 4. Extract text parts from response (filter out tool/reasoning parts)
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
