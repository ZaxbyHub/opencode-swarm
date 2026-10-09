/**
 * v2 runtime agent-model application (issue #3151, 8.x port of the 7.x #3022
 * AC3 surface).
 *
 * The v1 fallback loop closes through `output.message.model` at the
 * chat.message boundary — a surface the v2 SessionPrompt event does not carry.
 * The v2-native equivalent is rewriting the agent's `model` reference through
 * the host-provided `ctx.agent.transform` entry: the AgentDraft editor is
 * callback-scoped (src/host/v2/agents-commands.ts registers through the same
 * primitive), so the apply re-invokes the stored transform surface at advance
 * time.
 *
 * KEYING CONTRACT: the v2 AgentEditor is keyed by the EXACT REGISTERED agent
 * name (multi-swarm configs register `local_coder` etc.), and
 * `editor.update(id, fn)` is create-or-update — callers MUST pass the
 * registration key, never the bare prefix-stripped role, or a phantom
 * bare-name agent would be created.
 *
 * Everything here is fail-open: with no registered surface (v1 hosts, or a v2
 * host without the agent domain) the apply is a logged no-op.
 */

import { log } from '@opencode-swarm/core';
import { withTimeout } from './timeout';
import type { V2AgentEditor, V2PluginContext, V2Registration } from './types';

const V2_MODEL_APPLY_TIMEOUT_MS = 10_000;

type AgentTransform = V2PluginContext['agent']['transform'];

let registeredTransform: AgentTransform | undefined;

/**
 * Host registrations held per applied agent. Each `transform(...)` returns a
 * Registration whose `dispose()` is the HOST'S UNDO PATH for that transform's
 * rewrites (state re-materializes from initial() plus the remaining
 * transforms), so a registration must neither leak (unbounded) nor be disposed
 * on behalf of a DIFFERENT agent — that would revert the other agent's sticky
 * model rewrite. Keyed by the exact registered agent name; re-apply replaces
 * only that agent's entry; cleanup disposes all. FIFO eviction above MAX
 * disposes the evicted rewrite and is reachable only under implausible
 * distinct-agent churn.
 */
const MAX_HELD_APPLY_REGISTRATIONS = 128;
const registrationsByAgent = new Map<string, V2Registration>();

/**
 * Remember the v2 agent transform surface for later model rewrites. Called
 * once from setup after agent registration; cleared on cleanup.
 */
export function registerV2AgentTransformSurface(ctx: V2PluginContext): void {
	const transform =
		ctx?.agent && typeof ctx.agent.transform === 'function'
			? ctx.agent.transform.bind(ctx.agent)
			: undefined;
	registeredTransform = transform;
	if (transform === undefined) {
		log('v2 agent transform surface absent; runtime model apply disabled', {});
	}
}

/**
 * Drop the registered surface and dispose every held apply registration
 * (v2 cleanup). Best-effort: disposal failure is logged, never thrown.
 */
export function clearV2AgentTransformSurface(): void {
	registeredTransform = undefined;
	const held = [...registrationsByAgent.values()];
	registrationsByAgent.clear();
	for (const reg of held) {
		void reg.dispose().catch((err: unknown) => {
			log('v2 model-apply registration dispose failed (non-fatal)', {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}
}

/** True when a v2 apply surface is registered (test/diagnostic seam). */
export function hasV2AgentTransformSurface(): boolean {
	return registeredTransform !== undefined;
}

/**
 * Rewrite one registered agent's model to `modelString` ('provider/model').
 * Returns true when a surface existed and the transform completed within the
 * budget; false (logged, non-fatal) otherwise. No-op on v1 hosts.
 */
export async function applyV2AgentModelOverride(
	agentName: string,
	modelString: string,
): Promise<boolean> {
	const transform = registeredTransform;
	if (transform === undefined) {
		// v1 host or pre-cleanup: the v1 chat-boundary override owns application.
		return false;
	}
	const separator = modelString.indexOf('/');
	if (
		typeof agentName !== 'string' ||
		agentName.length === 0 ||
		separator <= 0 ||
		separator === modelString.length - 1
	) {
		log('v2 model apply rejected malformed input (non-fatal)', {
			agentName,
			modelString,
		});
		return false;
	}
	const providerID = modelString.slice(0, separator);
	const id = modelString.slice(separator + 1);
	try {
		const applied = await withTimeout(
			Promise.resolve(
				transform((editor: V2AgentEditor) => {
					// update(id, fn) is create-or-update; agentName must be the
					// registered key (see module header KEYING CONTRACT).
					editor.update(agentName, (agent) => {
						agent.model = { providerID, id };
					});
				}),
			),
			V2_MODEL_APPLY_TIMEOUT_MS,
			new Error(
				`[opencode-swarm] v2: model apply for ${agentName} exceeded budget`,
			),
		);
		// Hold this agent's registration, replacing only the SAME agent's
		// previous entry: host dispose is the transform's undo path, so
		// disposing a different agent's registration would revert that agent's
		// sticky model rewrite.
		const previous = registrationsByAgent.get(agentName);
		registrationsByAgent.set(agentName, applied);
		while (registrationsByAgent.size > MAX_HELD_APPLY_REGISTRATIONS) {
			const oldest = registrationsByAgent.keys().next().value;
			if (typeof oldest !== 'string') break;
			const evicted = registrationsByAgent.get(oldest);
			registrationsByAgent.delete(oldest);
			void evicted?.dispose().catch((err: unknown) => {
				log('v2 evicted model-apply registration dispose failed (non-fatal)', {
					agentName: oldest,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}
		if (previous) {
			void previous.dispose().catch((err: unknown) => {
				log('v2 previous model-apply registration dispose failed (non-fatal)', {
					agentName,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}
		log('v2 agent model applied', { agentName, modelString });
		return true;
	} catch (err) {
		log('v2 agent model apply failed (non-fatal)', {
			agentName,
			modelString,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}
