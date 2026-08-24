import { getSwarmAgents, resolveFallbackModel } from '../agents/index.js';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import { swarmState } from '../state.js';
import { telemetry } from '../telemetry.js';
import { teardownEphemeralSession } from '../utils/ephemeral-session-teardown.js';
import { dispatchWithModelFallback } from '../utils/model-dispatch-fallback.js';
import { isTransientProviderError } from '../utils/provider-error-classification.js';
import { isAbortError } from './abort-utils.js';
import type { CuratorLLMDelegate } from './curator.js';

function resolveConfiguredFallbackModels(
	agentBaseName: string,
	swarmAgents?: Record<
		string,
		{ model?: string; fallback_models?: string[]; disabled?: boolean }
	>,
): string[] {
	const configured = swarmAgents?.[agentBaseName]?.fallback_models;
	if (configured) return configured;

	const inherited: string[] = [];
	for (let fallbackIndex = 1; ; fallbackIndex += 1) {
		const model = resolveFallbackModel(
			agentBaseName,
			fallbackIndex,
			swarmAgents,
		);
		if (!model) break;
		inherited.push(model);
	}
	return inherited;
}

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
	mode: 'init' | 'phase' | 'postmortem' | 'consolidation',
	sessionId?: string,
): string {
	const suffixMap = {
		init: 'curator_init',
		phase: 'curator_phase',
		postmortem: 'curator_postmortem',
		consolidation: 'curator_consolidation',
	} as const;
	const suffix = suffixMap[mode];
	const registeredNamesMap = {
		init: swarmState.curatorInitAgentNames,
		phase: swarmState.curatorPhaseAgentNames,
		postmortem: swarmState.curatorPostmortemAgentNames,
		consolidation: swarmState.curatorConsolidationAgentNames,
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
	mode: 'init' | 'phase' | 'postmortem' | 'consolidation' = 'init',
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

		/**
		 * Best-effort session teardown — never throws. Awaits a graceful
		 * `session.abort()` (so opencode flushes the final part/message) before
		 * the cascade-delete, closing the FOREIGN KEY constraint race (#2123).
		 */
		const cleanup = async (): Promise<void> => {
			if (ephemeralSessionId) {
				const id = ephemeralSessionId;
				ephemeralSessionId = undefined; // prevent double-teardown
				await teardownEphemeralSession(client.session, id);
			}
		};

		// If the caller already aborted, bail.
		if (signal?.aborted) {
			throw new Error('CURATOR_LLM_TIMEOUT');
		}

		// Forward the abort signal to SDK fetch calls so native cancellation
		// is used instead of deleting the session mid-prompt (which caused
		// FK constraint crashes when OpenCode was still writing parts).
		const sdkOpts = signal ? { signal } : {};

		try {
			// 1. Create ephemeral session scoped to project directory.
			// Bind to the calling session as parent so OpenCode treats this as
			// a child session and does not persist it as a new root in the TUI.
			const createResult = await client.session.create({
				...(sessionId
					? {
							body: {
								parentID: sessionId,
								title: `curator_${mode} background`,
							},
						}
					: {}),
				query: { directory },
				...sdkOpts,
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

			// Derive the canonical role + swarm id from the resolved agent name so
			// quota/rate-limit failover can route through the configured curator (or
			// inherited explorer) fallback chain. Uses stripKnownSwarmPrefix — NOT a
			// naive `_`-split — because curator role names themselves contain an
			// underscore (`curator_phase`, `curator_consolidation`), which a split
			// would misread as a swarm prefix. Mirrors src/turbo/lean/reviewer.ts.
			const baseRole = stripKnownSwarmPrefix(agentName);
			const swarmId =
				baseRole !== agentName
					? agentName.slice(0, agentName.length - baseRole.length - 1)
					: undefined;
			const swarmAgents = getSwarmAgents(swarmId);
			const fallbackModels = resolveConfiguredFallbackModels(
				baseRole,
				swarmAgents,
			);

			// Capture the session id as a const so the type narrows to `string`
			// inside the dispatch closure below (the `let` binding is `string |
			// undefined` and cleanup can null it, so flow-narrowing is lost across
			// the closure boundary).
			const promptSessionId = ephemeralSessionId;

			// 3. Prompt using the registered curator agent, failing over to a
			// configured fallback model on a transient/quota dispatch error (#1927,
			// the #1905 follow-up for the opt-in curator site). The fallback wraps
			// only the prompt: the ephemeral session is reused across attempts and
			// still torn down in `finally`.
			const dispatched = await dispatchWithModelFallback({
				dispatch: async (model) => {
					const promptResult = await client.session.prompt({
						path: { id: promptSessionId },
						body: {
							agent: agentName,
							// #1927: per-call model override on a fallback attempt;
							// omitted (undefined) means the registered curator model.
							...(model ? { model } : {}),
							tools: { write: false, edit: false, patch: false },
							parts: [{ type: 'text', text: userInput }],
						},
						...sdkOpts,
					});
					if (!promptResult.data) {
						// Preserve the SDK error envelope so the transient/quota
						// classifier can read the real provider message (#1905
						// envelope-preservation pattern).
						throw new Error(
							`Curator LLM prompt failed: ${JSON.stringify(promptResult.error)}`,
						);
					}
					return promptResult.data;
				},
				scope: sessionId
					? {
							sessionID: sessionId,
							// The host creates one ephemeral session per delegate call. Use
							// that ID as the logical invocation boundary so a fallback or
							// exhausted chain cannot bleed into a later curator prompt in the
							// same parent session.
							invocationID: `curator:${mode}:${promptSessionId}`,
							swarmID: swarmId,
							role: baseRole,
						}
					: undefined,
				primaryModel: swarmAgents?.[baseRole]?.model,
				fallbackModels,
				resolveFallback: (index) =>
					resolveFallbackModel(baseRole, index, swarmAgents),
				// Advance to the next model immediately on a transient/quota error —
				// an instant same-model retry cannot clear an exhausted quota.
				maxTransientRetriesPerModel: 0,
				classify: (err) => {
					// A genuine cancellation is not a provider transient: surface it so
					// the outer catch maps it to CURATOR_LLM_TIMEOUT, and never fail
					// over on abort.
					if (isAbortError(err)) return 'permanent';
					const msg = err instanceof Error ? err.message : String(err);
					return isTransientProviderError(msg) ? 'transient' : 'permanent';
				},
				onFallback: ({ toModel }) => {
					if (sessionId) {
						telemetry.modelFallback(
							sessionId,
							agentName,
							swarmAgents?.[baseRole]?.model ?? 'default',
							toModel,
							'transient_model_error',
						);
					}
				},
			});

			// 4. Extract text parts from response (filter out tool/reasoning parts)
			const textParts = dispatched.result.parts.filter(
				(p): p is typeof p & { text: string } => p.type === 'text',
			);
			return textParts.map((p) => p.text).join('\n');
		} catch (err) {
			// Translate only a genuine cancellation (native AbortError from the
			// forwarded signal) into the CURATOR_LLM_TIMEOUT sentinel. A real
			// failure that happens to coincide with an aborted signal must
			// surface as itself rather than being misreported as a timeout.
			if (isAbortError(err)) {
				throw new Error('CURATOR_LLM_TIMEOUT');
			}
			throw err;
		} finally {
			await cleanup();
		}
	};
}
