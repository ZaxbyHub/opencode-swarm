/**
 * Shared model identity ladder for messages.transform consumers that lack a
 * host `Model` object (context-budget, knowledge-injector, final accounting,
 * context_status).
 */

import { parseAgentModel } from '../config/agent-model';
import { readV2SessionContextModelIdentity } from '../host/v2/session-client';
import { getLiveContextModelIdentity } from '../state';
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

export async function resolveSessionModelIdentity(input: {
	sessionID?: string;
	targetModelInfo?: { modelID?: string; providerID?: string };
	messages: Parameters<typeof extractModelInfo>[0];
}): Promise<{ modelID?: string; providerID?: string }> {
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
	return mergeModelIdentity(
		input.targetModelInfo,
		usableLiveModelInfo,
		v2ContextIdentity,
		messageModelInfo,
	);
}
