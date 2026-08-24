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

import { getSwarmAgents, resolveFallbackModel } from '../agents/index.js';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import { swarmState } from '../state.js';
import { telemetry } from '../telemetry.js';
import { teardownEphemeralSession } from '../utils/ephemeral-session-teardown.js';
import { dispatchWithModelFallback } from '../utils/model-dispatch-fallback.js';
import { isTransientProviderError } from '../utils/provider-error-classification.js';
import { isAbortError } from './abort-utils.js';

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

		const cleanup = async (): Promise<void> => {
			if (ephemeralSessionId) {
				const id = ephemeralSessionId;
				ephemeralSessionId = undefined;
				await teardownEphemeralSession(client.session, id);
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

			// Derive the canonical role + swarm id so quota/rate-limit failover can
			// route through the configured skill_improver fallback chain. Uses
			// stripKnownSwarmPrefix — NOT a naive `_`-split — because `skill_improver`
			// itself contains an underscore. Mirrors src/turbo/lean/reviewer.ts.
			const baseRole = stripKnownSwarmPrefix(agentName);
			const swarmId =
				baseRole !== agentName
					? agentName.slice(0, agentName.length - baseRole.length - 1)
					: undefined;
			const swarmAgents = getSwarmAgents(swarmId);

			// Capture the session id as a const so the type narrows to `string`
			// inside the dispatch closure below (the `let` binding is `string |
			// undefined` and cleanup can null it, so flow-narrowing is lost across
			// the closure boundary).
			const promptSessionId = ephemeralSessionId;

			const prelude = systemPrompt
				? `${systemPrompt}\n\n---\n\n${userInput}`
				: userInput;
			// Prompt the registered skill_improver agent, failing over to a
			// configured fallback model on a transient/quota dispatch error (#1927,
			// the #1905 follow-up for the opt-in skill-improvement site). The
			// fallback wraps only the prompt: the ephemeral session is reused across
			// attempts and still torn down in `finally`.
			const dispatched = await dispatchWithModelFallback({
				dispatch: async (model) => {
					const promptResult = await client.session.prompt({
						path: { id: promptSessionId },
						body: {
							agent: agentName,
							// #1927: per-call model override on a fallback attempt;
							// omitted (undefined) means the registered skill_improver model.
							...(model ? { model } : {}),
							tools: { write: false, edit: false, patch: false },
							parts: [{ type: 'text', text: prelude }],
						},
						...sdkOpts,
					});
					if (!promptResult.data) {
						// Preserve the SDK error envelope so the transient/quota
						// classifier can read the real provider message (#1905
						// envelope-preservation pattern).
						throw new Error(
							`skill_improver LLM prompt failed: ${JSON.stringify(promptResult.error)}`,
						);
					}
					return promptResult.data;
				},
				scope: sessionId
					? {
							sessionID: sessionId,
							// Each ephemeral prompt session is an independent logical
							// invocation. Scoping by its host-issued ID prevents a prior call's
							// fallback/exhaustion state from contaminating the next call.
							invocationID: `skill-improver:${promptSessionId}`,
							swarmID: swarmId,
							role: baseRole,
						}
					: undefined,
				primaryModel: swarmAgents?.[baseRole]?.model,
				fallbackModels: swarmAgents?.[baseRole]?.fallback_models ?? [],
				resolveFallback: (index) =>
					resolveFallbackModel(baseRole, index, swarmAgents),
				// Advance to the next model immediately on a transient/quota error —
				// an instant same-model retry cannot clear an exhausted quota.
				maxTransientRetriesPerModel: 0,
				classify: (err) => {
					// A genuine cancellation is not a provider transient: surface it so
					// the outer catch maps it to SKILL_IMPROVER_LLM_TIMEOUT, and never
					// fail over on abort.
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

			const textParts = dispatched.result.parts.filter(
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
			await cleanup();
		}
	};
}

export const _internals = {
	createSkillImproverLLMDelegate,
	resolveSkillImproverAgentName,
};
