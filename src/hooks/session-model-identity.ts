/**
 * Shared model identity ladder for messages.transform consumers that lack a
 * host `Model` object (context-budget, knowledge-injector, final accounting,
 * context_status).
 */

import { parseAgentModel } from '../config/agent-model';
import { readV2SessionContextModelIdentity } from '../host/v2/session-client';
import { getLiveContextModelIdentity, swarmState } from '../state';
import {
	extractModelInfo,
	hasUsableModelIdentity,
	mergeModelIdentity,
} from './model-limits';

/** v2 scan when `modelID` is still missing (provider-only partial must not skip). */
export function needsV2ModelIdentityScan(partial: {
	modelID?: string;
	providerID?: string;
}): boolean {
	return !partial.modelID?.trim();
}

/** Latest user message's configured agent model (matches context-budget handoff). */
export function resolveTargetModelInfoFromLatestUserAgent(
	messages: Parameters<typeof extractModelInfo>[0],
	resolveAgentModel: (agentName: string) => string | undefined,
): { modelID?: string; providerID?: string } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const messageInfo = messages[i]?.info;
		if (messageInfo?.role === 'user' && messageInfo.agent) {
			const configuredTargetModel = resolveAgentModel(messageInfo.agent);
			return configuredTargetModel
				? parseAgentModel(configuredTargetModel)
				: undefined;
		}
	}
	return undefined;
}

function normalizeIdentityField(value: string | undefined): string {
	return value?.trim().toLowerCase() ?? '';
}

/**
 * Bind transcript-derived identity to the session's system.transform cache.
 *
 * OpenCode v2 often reports provider token usage on `session.context` entries
 * without model ids. The authoritative model + live `limit.context` live in
 * `liveContextWindows` keyed by sessionID. When the hint lacks a model id (or
 * only disagrees on provider slug), trust the cache for THIS session so
 * context_status and budget hooks use the host denominator. A conflicting hint
 * modelID indicates a handoff — do not reuse the stale cache.
 */
export function reconcileSessionLiveContext(
	sessionID: string | undefined,
	hint: { modelID?: string; providerID?: string },
): {
	modelID?: string;
	providerID?: string;
	liveContextLimit?: number;
} {
	if (!sessionID) {
		return { ...hint };
	}
	const cached = swarmState.liveContextWindows.get(sessionID);
	if (!cached) {
		return { ...hint };
	}

	const cacheIdentity = {
		modelID: cached.modelID,
		providerID: cached.providerID,
	};
	const identity = mergeModelIdentity(hint, cacheIdentity);

	const hintModel = hint.modelID?.trim();
	const cacheModel = cached.modelID?.trim();
	const modelConflict =
		Boolean(hintModel) &&
		Boolean(cacheModel) &&
		normalizeIdentityField(hintModel) !==
			normalizeIdentityField(cacheModel);

	if (modelConflict) {
		return {
			modelID: hint.modelID,
			providerID: hint.providerID,
			liveContextLimit: undefined,
		};
	}

	if (cached.tokens !== undefined) {
		return {
			modelID: identity.modelID,
			providerID: identity.providerID,
			liveContextLimit: cached.tokens,
		};
	}

	return {
		modelID: identity.modelID,
		providerID: identity.providerID,
	};
}

export async function resolveSessionModelIdentity(input: {
	sessionID?: string;
	targetModelInfo?: { modelID?: string; providerID?: string };
	messages: Parameters<typeof extractModelInfo>[0];
}): Promise<{
	modelID?: string;
	providerID?: string;
	liveContextLimit?: number;
}> {
	const liveModelInfo = getLiveContextModelIdentity(input.sessionID);
	const usableLiveModelInfo = hasUsableModelIdentity(liveModelInfo)
		? liveModelInfo
		: undefined;
	const messageModelInfo = extractModelInfo(input.messages);
	const partial = mergeModelIdentity(
		input.targetModelInfo,
		usableLiveModelInfo,
		messageModelInfo,
	);
	const v2ContextIdentity =
		input.sessionID && needsV2ModelIdentityScan(partial)
			? await readV2SessionContextModelIdentity(input.sessionID)
			: undefined;
	const hint = mergeModelIdentity(
		input.targetModelInfo,
		usableLiveModelInfo,
		v2ContextIdentity,
		messageModelInfo,
	);
	return reconcileSessionLiveContext(input.sessionID, hint);
}
