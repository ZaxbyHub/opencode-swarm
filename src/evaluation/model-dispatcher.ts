import type { Agent, OpencodeClient } from '@opencode-ai/sdk';
import { log } from '../utils/logger.js';

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
};

export type EvaluationModelDispatcher = (
	request: EvaluationModelDispatchRequest,
) => Promise<EvaluationModelDispatchResult>;

const READ_ONLY_TOOLS = {
	write: false,
	edit: false,
	patch: false,
	bash: false,
	task: false,
	todowrite: false,
} as const;

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

async function boundedDelete(
	client: OpencodeClient,
	sessionId: string,
	timeoutMs = 500,
): Promise<void> {
	const DELETED = 'deleted' as const;
	const TIMED_OUT = 'timed-out' as const;
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const outcome = await Promise.race([
			client.session
				.delete({
					path: { id: sessionId },
					signal: controller.signal,
				})
				.then(() => DELETED),
			new Promise<typeof TIMED_OUT>((resolve) => {
				timer = setTimeout(() => {
					controller.abort();
					resolve(TIMED_OUT);
				}, timeoutMs);
			}),
		]);
		if (outcome === TIMED_OUT) {
			_internals.log('evaluation session cleanup timed out', {
				sessionId,
				timeoutMs,
			});
		}
	} catch (error) {
		_internals.log('evaluation session cleanup failed', {
			sessionId,
			error: error instanceof Error ? error.message : String(error),
		});
	} finally {
		if (timer) clearTimeout(timer);
		controller.abort();
	}
}

export const _internals: {
	boundedDelete: typeof boundedDelete;
	log: typeof log;
} = {
	boundedDelete,
	log,
};

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

		let sessionId: string | undefined;
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
			const operation = async () => {
				const requestedModel = parseRequestedModel(request.modelId);
				const agentsResult = await client.app.agents({
					query: { directory: request.directory },
					signal: controller.signal,
				});
				if (!agentsResult.data) {
					throw new Error('Failed to list registered evaluation agents');
				}
				resolvedAgentName = resolveEvaluationAgentName(
					agentsResult.data,
					request.agentName,
					request.preferredSwarm,
				);
				const createResult = await client.session.create({
					body: {
						...(request.parentSessionId
							? { parentID: request.parentSessionId }
							: {}),
						title: `evaluation gate (${resolvedAgentName})`,
					},
					query: { directory: request.directory },
					signal: controller.signal,
				});
				sessionId = createResult.data?.id;
				if (!sessionId) throw new Error('Failed to create evaluation session');

				const response = await client.session.prompt({
					path: { id: sessionId },
					body: {
						agent: resolvedAgentName,
						...(requestedModel ? { model: requestedModel } : {}),
						...(request.system ? { system: request.system } : {}),
						tools: READ_ONLY_TOOLS,
						parts: [{ type: 'text', text: request.prompt }],
					},
					signal: controller.signal,
				});
				if (!response.data)
					throw new Error('Evaluation session returned no data');
				const text = response.data.parts
					.filter((part) => part.type === 'text')
					.map((part) => part.text ?? '')
					.join('\n');
				if (Buffer.byteLength(text, 'utf8') > 64 * 1024) {
					throw new Error('Evaluation model output exceeded 65536 bytes');
				}
				const actualModel = response.data.info;
				return {
					status: 'completed' as const,
					modelId:
						actualModel.providerID && actualModel.modelID
							? `${actualModel.providerID}/${actualModel.modelID}`
							: request.modelId,
					agentName: resolvedAgentName,
					text,
					durationMs: Date.now() - startedAt,
				};
			};

			return await Promise.race([
				operation(),
				new Promise<never>((_, reject) => {
					controller.signal.addEventListener(
						'abort',
						() => reject(new Error('evaluation dispatch aborted')),
						{ once: true },
					);
				}),
			]);
		} catch (error) {
			const cancelled = request.abortSignal?.aborted === true;
			return {
				status: cancelled ? 'cancelled' : timedOut ? 'timeout' : 'error',
				modelId: request.modelId,
				agentName: resolvedAgentName,
				text: '',
				durationMs: Date.now() - startedAt,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			clearTimeout(timeoutHandle);
			request.abortSignal?.removeEventListener('abort', abortListener);
			controller.abort();
			if (sessionId) await _internals.boundedDelete(client, sessionId);
		}
	};
}
