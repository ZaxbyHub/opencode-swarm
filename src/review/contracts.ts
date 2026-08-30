import type { OpencodeClient } from '@opencode-ai/sdk';
import {
	DEFAULT_EPHEMERAL_TIMEOUT_MS,
	DEFAULT_READ_ONLY_TOOLS,
	dispatchEphemeralAgent,
	type EphemeralAgentDispatchResult,
} from '../evaluation/ephemeral-agent-dispatcher.js';
import type { PricingConfig } from '../services/cost-accounting.js';
import type { ModelOverride } from '../utils/model-dispatch-fallback.js';

export type ReviewDispatchRequest = {
	directory: string;
	parentSessionId?: string;
	/** Already-resolved reviewer or validator agent name. */
	agentName: string;
	model?: ModelOverride;
	/** Complete replacement system prompt for the isolated review session. */
	system: string;
	prompt: string;
	title?: string;
	timeoutMs?: number;
	promptByteLimit?: number;
	responseByteLimit?: number;
	abortSignal?: AbortSignal;
};

export type ReviewDispatchResult = EphemeralAgentDispatchResult;

export interface ReviewModelDispatcher {
	dispatch(request: ReviewDispatchRequest): Promise<ReviewDispatchResult>;
}

/**
 * Bind an OpenCode client to the shared ephemeral-session primitive.
 *
 * The returned dispatcher is instance-local and safe to inject into hooks and
 * tools; it does not read or mutate module-level client state.
 */
export function createReviewModelDispatcher(
	client: OpencodeClient,
	pricing?: PricingConfig,
): ReviewModelDispatcher {
	return {
		dispatch: (request) =>
			dispatchEphemeralAgent({
				client,
				directory: request.directory,
				parentSessionId: request.parentSessionId,
				agentName: request.agentName,
				model: request.model,
				system: request.system,
				prompt: request.prompt,
				readOnlyTools: DEFAULT_READ_ONLY_TOOLS,
				title: request.title,
				timeoutMs:
					request.timeoutMs && request.timeoutMs > 0
						? request.timeoutMs
						: DEFAULT_EPHEMERAL_TIMEOUT_MS,
				promptByteLimit: request.promptByteLimit,
				responseByteLimit: request.responseByteLimit,
				abortSignal: request.abortSignal,
				pricing,
			}),
	};
}
