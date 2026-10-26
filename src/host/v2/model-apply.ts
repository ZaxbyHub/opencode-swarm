/**
 * v2 runtime agent-model application (issue #3022, AC3).
 *
 * The v1 fallback loop closes through `output.message.model` at the
 * chat.message boundary — a surface the v2 SessionPrompt event does not carry
 * (docs/host/v2-hook-inventory.md row 13). The v2-native equivalent is
 * rewriting the agent's `model` reference through the host-provided
 * `ctx.agent.transform` entry: the AgentDraft editor is callback-scoped
 * (src/host/v2/agents-commands.ts registers through the same primitive), so
 * the apply re-invokes the stored transform surface at advance time.
 *
 * KEYING CONTRACT (plan-critic round 2): the v2 AgentEditor is keyed by the
 * EXACT REGISTERED agent name (multi-swarm configs register `local_coder`
 * etc.), and `editor.update(id, fn)` is create-or-update — callers MUST pass
 * the registration key (`routeModel.exactAgentName`), never the bare
 * prefix-stripped role, or a phantom bare-name agent would be created.
 *
 * Everything here is fail-open: with no registered surface (v1 hosts, or a v2
 * host without the agent domain) the apply is a logged no-op.
 *
 * #3352 / #2910 W5: the surface is OWNER-TOKEN-KEYED (see the registry
 * comment below) — setup.ts passes its per-instance token on register and on
 * owner-scoped clear, so concurrent live setups own disjoint surfaces.
 */

import { log } from '../../utils';
import { withTimeout } from '../../utils/timeout';
import type { V2AgentEditor, V2PluginContext, V2Registration } from './types';

const V2_MODEL_APPLY_TIMEOUT_MS = 10_000;

type AgentTransform = V2PluginContext['agent']['transform'];

/**
 * #3352 / #2910 W5: the apply surface is OWNER-TOKEN-KEYED. Each v2 setup
 * instance registers its own entry (setup.ts generates the token); a legacy
 * no-argument register call uses the '__default__' owner so every pre-W5
 * call site and test keeps working. `applyV2AgentModelOverride` resolves
 * through the MOST-RECENTLY-REGISTERED owner that carries a transform, and
 * `clearV2AgentTransformSurface(token)` clears ONLY that owner's surface +
 * held registrations — one instance's cleanup can never destroy another live
 * instance's surface (the base-defect class this port closes).
 */
const DEFAULT_V2_MODEL_APPLY_OWNER = '__default__';

interface V2ModelApplyOwnerState {
	transform: AgentTransform | undefined;
	/**
	 * Host registrations held per applied agent (#3029 review F-002), keyed by
	 * the exact registered agent name; re-apply replaces only that agent's
	 * entry; owner cleanup disposes all. FIFO eviction above MAX disposes the
	 * evicted rewrite and is reachable only under implausible distinct-agent
	 * churn.
	 */
	registrationsByAgent: Map<string, V2Registration>;
}

const MAX_HELD_APPLY_REGISTRATIONS = 128;
const modelApplyOwners = new Map<string, V2ModelApplyOwnerState>();

/** Re-register at the END so Map insertion order == registration recency. */
function touchModelApplyOwner(token: string): V2ModelApplyOwnerState {
	const existing = modelApplyOwners.get(token);
	if (existing !== undefined) {
		modelApplyOwners.delete(token);
		modelApplyOwners.set(token, existing);
		return existing;
	}
	const state: V2ModelApplyOwnerState = {
		transform: undefined,
		registrationsByAgent: new Map(),
	};
	modelApplyOwners.set(token, state);
	return state;
}

/** Best-effort dispose of one owner's held registrations (never throws). */
function disposeHeldRegistrations(
	owner: V2ModelApplyOwnerState,
	label: string,
): void {
	const held = [...owner.registrationsByAgent.values()];
	owner.registrationsByAgent.clear();
	for (const reg of held) {
		void reg.dispose().catch((err: unknown) => {
			log(`v2 model-apply registration dispose failed (${label}; non-fatal)`, {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}
}

/**
 * Remember the v2 agent transform surface for later model rewrites. Called
 * once from setup after agent registration (with the setup's owner token);
 * a no-argument call registers the legacy '__default__' owner. Cleared on
 * cleanup via `clearV2AgentTransformSurface(token)`.
 */
export function registerV2AgentTransformSurface(
	ctx: V2PluginContext,
	token?: string,
): void {
	const ownerToken = token ?? DEFAULT_V2_MODEL_APPLY_OWNER;
	const transform =
		ctx?.agent && typeof ctx.agent.transform === 'function'
			? ctx.agent.transform.bind(ctx.agent)
			: undefined;
	const owner = touchModelApplyOwner(ownerToken);
	owner.transform = transform;
	if (transform === undefined) {
		log('v2 agent transform surface absent; runtime model apply disabled', {});
	}
}

/**
 * Drop a registered surface and dispose every held apply registration.
 * WITH token: clears/disposes ONLY that owner's surface + held registrations
 * (v2 setup cleanup — a concurrent live instance is untouched). WITHOUT
 * token: LEGACY ADMINISTRATIVE clear-all (kept for the pre-W5 test seams
 * model-apply-3022 / setup-wiring-3022 / review-followup-3029). Best-effort:
 * disposal failure is logged, never thrown.
 */
export function clearV2AgentTransformSurface(token?: string): void {
	if (token === undefined) {
		for (const [ownerToken, owner] of [...modelApplyOwners.entries()]) {
			disposeHeldRegistrations(owner, `clear-all ${ownerToken}`);
		}
		modelApplyOwners.clear();
		return;
	}
	const owner = modelApplyOwners.get(token);
	if (owner === undefined) return;
	owner.transform = undefined;
	disposeHeldRegistrations(owner, `owner ${token}`);
	if (owner.transform === undefined && owner.registrationsByAgent.size === 0) {
		modelApplyOwners.delete(token);
	}
}

/** True when any live owner carries a v2 apply surface (test/diagnostic seam). */
export function hasV2AgentTransformSurface(): boolean {
	for (const owner of modelApplyOwners.values()) {
		if (owner.transform !== undefined) return true;
	}
	return false;
}

/** The most-recently-registered owner that carries a transform, if any. */
function resolveActiveModelApplyOwner(): V2ModelApplyOwnerState | undefined {
	const tokens = [...modelApplyOwners.keys()];
	for (let i = tokens.length - 1; i >= 0; i -= 1) {
		const owner = modelApplyOwners.get(tokens[i] ?? '');
		if (owner?.transform !== undefined) return owner;
	}
	return undefined;
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
	const owner = resolveActiveModelApplyOwner();
	const transform = owner?.transform;
	if (owner === undefined || transform === undefined) {
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
		// previous entry (F-002): host dispose is the transform's undo path,
		// so disposing a different agent's registration would revert that
		// agent's sticky model rewrite.
		const previous = owner.registrationsByAgent.get(agentName);
		owner.registrationsByAgent.set(agentName, applied);
		while (owner.registrationsByAgent.size > MAX_HELD_APPLY_REGISTRATIONS) {
			const oldest = owner.registrationsByAgent.keys().next().value;
			if (typeof oldest !== 'string') break;
			const evicted = owner.registrationsByAgent.get(oldest);
			owner.registrationsByAgent.delete(oldest);
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
