import type { Agent, OpencodeClient } from '@opencode-ai/sdk';
import type { DelegationCostFields } from '../services/cost-accounting.js';
import {
	isQuotaError,
	isTransientProviderError,
} from '../utils/provider-error-classification';
import {
	DEFAULT_READ_ONLY_TOOLS,
	dispatchEphemeralAgent,
	_internals as ephemeralDispatcherInternals,
} from './ephemeral-agent-dispatcher.js';

export type EvaluationModelDispatchRequest = {
	directory: string;
	agentName: string;
	modelId: string;
	prompt: string;
	system?: string;
	timeoutMs: number;
	parentSessionId?: string;
	preferredSwarm?: string;
	abortSignal?: AbortSignal;
};

export type EvaluationModelDispatchResult = {
	status: 'completed' | 'timeout' | 'cancelled' | 'error';
	modelId: string;
	agentName?: string;
	text: string;
	durationMs: number;
	error?: string;
	promptBytes?: number;
	responseBytes?: number;
	costFields?: DelegationCostFields;
};

export type EvaluationModelDispatcher = (
	request: EvaluationModelDispatchRequest,
) => Promise<EvaluationModelDispatchResult>;

function parseRequestedModel(
	modelId: string,
): { providerID: string; modelID: string } | undefined {
	if (modelId === 'configured') return undefined;
	const separator = modelId.indexOf('/');
	if (separator <= 0 || separator === modelId.length - 1) {
		throw new Error(
			'explicit evaluation models must use provider/model syntax',
		);
	}
	return {
		providerID: modelId.slice(0, separator),
		modelID: modelId.slice(separator + 1),
	};
}

export function resolveEvaluationAgentName(
	agents: readonly Pick<Agent, 'name'>[],
	logicalName: string,
	preferredSwarm?: string,
): string {
	const names = agents.map((agent) => agent.name);
	if (preferredSwarm) {
		const preferred = `${preferredSwarm}_${logicalName}`;
		if (names.includes(preferred)) return preferred;
		throw new Error(
			`preferred swarm ${preferredSwarm} does not provide evaluation agent ${logicalName}`,
		);
	}
	if (names.includes(logicalName)) return logicalName;
	const prefixed = names
		.filter((name) => name.endsWith(`_${logicalName}`))
		.sort((left, right) => left.localeCompare(right));
	if (prefixed.length === 1) return prefixed[0]!;
	if (prefixed.length > 1) {
		throw new Error(
			`multiple swarms provide ${logicalName}; preferredSwarm is required`,
		);
	}
	throw new Error(`evaluation agent ${logicalName} is not registered`);
}

/**
 * Compatibility proxy for the existing evaluation test seam. The shared
 * primitive remains the single owner of cleanup and logging behavior.
 */
export const _internals: {
	boundedDelete: typeof ephemeralDispatcherInternals.boundedDelete;
	log: typeof ephemeralDispatcherInternals.log;
} = Object.defineProperties(
	{},
	{
		boundedDelete: {
			enumerable: true,
			get: () => ephemeralDispatcherInternals.boundedDelete,
			set: (value) => {
				ephemeralDispatcherInternals.boundedDelete = value;
			},
		},
		log: {
			enumerable: true,
			get: () => ephemeralDispatcherInternals.log,
			set: (value) => {
				ephemeralDispatcherInternals.log = value;
			},
		},
	},
) as {
	boundedDelete: typeof ephemeralDispatcherInternals.boundedDelete;
	log: typeof ephemeralDispatcherInternals.log;
};

async function awaitWithAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) throw new Error('evaluation dispatch aborted');
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error('evaluation dispatch aborted'));
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(resolve, reject).finally(() => {
			signal.removeEventListener('abort', onAbort);
		});
	});
}

export function createEvaluationModelDispatcher(
	client: OpencodeClient,
): EvaluationModelDispatcher {
	return async (request) => {
		const startedAt = Date.now();
		if (request.abortSignal?.aborted) {
			return {
				status: 'cancelled',
				modelId: request.modelId,
				text: '',
				durationMs: 0,
			};
		}

		let resolvedAgentName: string | undefined;
		const controller = new AbortController();
		let timedOut = false;
		const abortListener = () => controller.abort();
		request.abortSignal?.addEventListener('abort', abortListener, {
			once: true,
		});
		const timeoutHandle = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, request.timeoutMs);

		try {
			// #1896 (evaluation deviation): `request.modelId` is the benchmark
			// subject. Never substitute a fallback model because doing so corrupts
			// attribution. A bounded same-model retry still absorbs transient quota
			// blips; each attempt is cleaned up by dispatchEphemeralAgent.
			const maxSameModelRetries = 2;
			for (let attempt = 0; ; attempt++) {
				try {
					const requestedModel = parseRequestedModel(request.modelId);
					// Agent resolution is evaluation policy. The shared primitive
					// receives only an already-resolved agent name.
					// eslint-disable-next-line no-await-in-loop
					const agentsResult = await awaitWithAbort(
						client.app.agents({
							query: { directory: request.directory },
							signal: controller.signal,
						}),
						controller.signal,
					);
					if (!agentsResult.data) {
						throw new Error(
							`Failed to list registered evaluation agents: ${JSON.stringify(agentsResult.error)}`,
						);
					}
					resolvedAgentName = resolveEvaluationAgentName(
						agentsResult.data,
						request.agentName,
						request.preferredSwarm,
					);
					const remainingMs = Math.max(
						1,
						request.timeoutMs - (Date.now() - startedAt),
					);
					// eslint-disable-next-line no-await-in-loop
					const result = await dispatchEphemeralAgent({
						client,
						directory: request.directory,
						parentSessionId: request.parentSessionId,
						agentName: resolvedAgentName,
						model: requestedModel,
						...(request.system === undefined ? {} : { system: request.system }),
						prompt: request.prompt,
						readOnlyTools: DEFAULT_READ_ONLY_TOOLS,
						title: `evaluation gate (${resolvedAgentName})`,
						timeoutMs: remainingMs,
						abortSignal: controller.signal,
					});
					if (result.status === 'completed') {
						return {
							status: 'completed',
							modelId: result.modelId ?? request.modelId,
							agentName: resolvedAgentName,
							text: result.text,
							durationMs: Date.now() - startedAt,
							promptBytes: result.promptBytes,
							responseBytes: result.responseBytes,
							costFields: result.costFields,
						};
					}
					if (result.status === 'timeout') timedOut = true;
					throw new Error(
						result.error ?? `evaluation dispatch ${result.status}`,
					);
				} catch (error) {
					const cancelled = request.abortSignal?.aborted === true;
					const msg = error instanceof Error ? error.message : String(error);
					const retryable =
						!cancelled &&
						!timedOut &&
						attempt < maxSameModelRetries &&
						isTransientProviderError(msg);
					if (!retryable) {
						return {
							status: cancelled ? 'cancelled' : timedOut ? 'timeout' : 'error',
							modelId: request.modelId,
							agentName: resolvedAgentName,
							text: '',
							durationMs: Date.now() - startedAt,
							error: isQuotaError(msg)
								? `${msg} (model quota/usage limit; retried the same model ${attempt} time(s) — not substituted, to preserve benchmark attribution)`
								: msg,
						};
					}
				}
			}
		} finally {
			clearTimeout(timeoutHandle);
			request.abortSignal?.removeEventListener('abort', abortListener);
			controller.abort();
		}
	};
}
