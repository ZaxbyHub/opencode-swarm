import type { OpencodeClient } from '@opencode-ai/sdk';
import type { DelegationCostFields } from '../services/cost-accounting.js';
import { buildDelegationCostFields } from '../services/cost-accounting.js';
import { TOOL_NAMES } from '../tools/tool-metadata.js';
import { log } from '../utils/logger.js';
import type { ModelOverride } from '../utils/model-dispatch-fallback.js';

export const DEFAULT_EPHEMERAL_TIMEOUT_MS = 120_000;
export const DEFAULT_EPHEMERAL_CLEANUP_TIMEOUT_MS = 500;
export const DEFAULT_EPHEMERAL_PROMPT_BYTE_LIMIT = 512 * 1024;
export const MAX_EPHEMERAL_PROMPT_BYTE_LIMIT = 3 * 1024 * 1024;
export const DEFAULT_EPHEMERAL_RESPONSE_BYTE_LIMIT = 64 * 1024;

export type ReadOnlyToolDenials = Readonly<Record<string, false>>;

const EPHEMERAL_BUILTIN_TOOL_DENIALS = [
	'write',
	'edit',
	'patch',
	'apply_patch',
	'create_file',
	'insert',
	'replace',
	'append',
	'prepend',
	'extract_code_blocks',
	'multiedit',
	'multi_edit',
	'bash',
	'shell',
	'task',
	'batch',
	'todowrite',
	'todo_write',
] as const;

/**
 * Fail-closed tool policy for isolated review/evaluation agents.
 *
 * OpenCode merges this request map with the selected agent's configured tools,
 * so omitting a registered plugin tool leaves it enabled. Deny every canonical
 * plugin tool (including deceptively mutable tools such as lint and recursive
 * tools such as swarm_command) plus built-in mutation/dispatch escape hatches.
 * Upstream read-only discovery tools remain available.
 */
export const DEFAULT_READ_ONLY_TOOLS: ReadOnlyToolDenials = Object.freeze(
	Object.fromEntries(
		[...new Set([...TOOL_NAMES, ...EPHEMERAL_BUILTIN_TOOL_DENIALS])].map(
			(name) => [name, false] as const,
		),
	),
);

export type EphemeralAgentDispatchRequest = {
	client: OpencodeClient;
	directory: string;
	parentSessionId?: string;
	/** Already-resolved OpenCode agent name. Agent lookup belongs to the caller. */
	agentName: string;
	model?: ModelOverride;
	/** Optional system prompt for this isolated session. */
	system?: string;
	prompt: string;
	/** Explicit false-only tool map. The primitive never grants tools implicitly. */
	readOnlyTools: ReadOnlyToolDenials;
	title?: string;
	timeoutMs: number;
	cleanupTimeoutMs?: number;
	promptByteLimit?: number;
	responseByteLimit?: number;
	abortSignal?: AbortSignal;
};

export type EphemeralAgentDispatchResult = {
	status: 'completed' | 'timeout' | 'cancelled' | 'error';
	agentName: string;
	modelId?: string;
	text: string;
	error?: string;
	durationMs: number;
	promptBytes: number;
	responseBytes: number;
	costFields?: DelegationCostFields;
};

function formatSdkError(prefix: string, error: unknown): string {
	let detail: string;
	try {
		detail = JSON.stringify(error);
	} catch {
		detail = String(error);
	}
	return `${prefix}: ${detail}`;
}

function modelIdentifier(model?: ModelOverride): string | undefined {
	return model ? `${model.providerID}/${model.modelID}` : undefined;
}

function unavailableCostFields(model?: string): DelegationCostFields {
	return buildDelegationCostFields({ model });
}

async function awaitWithAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) throw new Error('ephemeral agent dispatch aborted');
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error('ephemeral agent dispatch aborted'));
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(resolve, reject).finally(() => {
			signal.removeEventListener('abort', onAbort);
		});
	});
}

export async function boundedDeleteEphemeralSession(
	client: OpencodeClient,
	sessionId: string,
	timeoutMs = DEFAULT_EPHEMERAL_CLEANUP_TIMEOUT_MS,
): Promise<void> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const outcome = await Promise.race([
			client.session
				.delete({
					path: { id: sessionId },
					signal: controller.signal,
				})
				.then(() => 'deleted' as const),
			new Promise<'timed-out'>((resolve) => {
				timer = setTimeout(
					() => {
						controller.abort();
						resolve('timed-out');
					},
					Math.max(1, timeoutMs),
				);
			}),
		]);
		if (outcome === 'timed-out') {
			_internals.log('ephemeral agent session cleanup timed out', {
				sessionId,
				timeoutMs,
			});
		}
	} catch (error) {
		_internals.log('ephemeral agent session cleanup failed', {
			sessionId,
			error: error instanceof Error ? error.message : String(error),
		});
	} finally {
		if (timer) clearTimeout(timer);
		controller.abort();
	}
}

export const _internals: {
	boundedDelete: typeof boundedDeleteEphemeralSession;
	log: typeof log;
} = {
	boundedDelete: boundedDeleteEphemeralSession,
	log,
};

/**
 * Dispatch one read-only agent in a fresh, parent-bound session.
 *
 * This is deliberately policy-free: callers resolve the agent and model, provide
 * the replacement system prompt, and own retry/fallback policy. The primitive
 * owns only bounded session creation/prompting, transcript caps, accounting, and
 * awaited best-effort cleanup.
 */
export async function dispatchEphemeralAgent(
	request: EphemeralAgentDispatchRequest,
): Promise<EphemeralAgentDispatchResult> {
	const startedAt = Date.now();
	const requestedModelId = modelIdentifier(request.model);
	const promptBytes =
		(request.system === undefined
			? 0
			: Buffer.byteLength(request.system, 'utf8')) +
		Buffer.byteLength(request.prompt, 'utf8');
	const base = {
		agentName: request.agentName,
		modelId: requestedModelId,
		text: '',
		durationMs: 0,
		promptBytes,
		responseBytes: 0,
		costFields: unavailableCostFields(requestedModelId),
	};

	if (request.abortSignal?.aborted) {
		return { ...base, status: 'cancelled' };
	}
	if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
		return {
			...base,
			status: 'error',
			error: 'ephemeral agent timeoutMs must be a positive finite number',
		};
	}

	const requestedPromptByteLimit =
		request.promptByteLimit ?? DEFAULT_EPHEMERAL_PROMPT_BYTE_LIMIT;
	if (
		!Number.isFinite(requestedPromptByteLimit) ||
		requestedPromptByteLimit <= 0 ||
		requestedPromptByteLimit > MAX_EPHEMERAL_PROMPT_BYTE_LIMIT
	) {
		return {
			...base,
			status: 'error',
			error: `ephemeral agent promptByteLimit must be between 1 and ${MAX_EPHEMERAL_PROMPT_BYTE_LIMIT} bytes`,
		};
	}
	const promptByteLimit = Math.floor(requestedPromptByteLimit);
	if (promptBytes > promptByteLimit) {
		return {
			...base,
			status: 'error',
			error: `Ephemeral agent prompt exceeded ${promptByteLimit} bytes`,
		};
	}

	let sessionId: string | undefined;
	let timedOut = false;
	let cancelled = false;
	const controller = new AbortController();
	const onCallerAbort = () => {
		cancelled = true;
		controller.abort();
	};
	request.abortSignal?.addEventListener('abort', onCallerAbort, { once: true });
	const timeoutHandle = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, request.timeoutMs);

	try {
		const sessionBody =
			request.parentSessionId || request.title
				? {
						...(request.parentSessionId
							? { parentID: request.parentSessionId }
							: {}),
						...(request.title ? { title: request.title } : {}),
					}
				: undefined;
		const createResult = await awaitWithAbort(
			request.client.session.create({
				...(sessionBody ? { body: sessionBody } : {}),
				query: { directory: request.directory },
				signal: controller.signal,
			}),
			controller.signal,
		);
		sessionId = createResult.data?.id;
		if (!sessionId) {
			throw new Error(
				formatSdkError(
					'Ephemeral agent session creation returned no data',
					createResult.error,
				),
			);
		}

		const response = await awaitWithAbort(
			request.client.session.prompt({
				path: { id: sessionId },
				body: {
					agent: request.agentName,
					...(request.model ? { model: request.model } : {}),
					...(request.system === undefined ? {} : { system: request.system }),
					tools: request.readOnlyTools,
					parts: [{ type: 'text', text: request.prompt }],
				},
				signal: controller.signal,
			}),
			controller.signal,
		);
		if (!response.data) {
			throw new Error(
				formatSdkError(
					'Ephemeral agent session returned no data',
					response.error,
				),
			);
		}

		const responseByteLimit =
			request.responseByteLimit ?? DEFAULT_EPHEMERAL_RESPONSE_BYTE_LIMIT;
		const textParts: string[] = [];
		let responseBytes = 0;
		for (const part of response.data.parts) {
			if (part.type !== 'text') continue;
			const text = part.text ?? '';
			responseBytes += Buffer.byteLength(text, 'utf8');
			if (textParts.length > 0) responseBytes += 1;
			if (responseBytes > responseByteLimit) {
				throw new Error(
					`Ephemeral agent response exceeded ${responseByteLimit} bytes`,
				);
			}
			textParts.push(text);
		}
		const text = textParts.join('\n');
		const info = response.data.info;
		const actualModelId =
			info?.providerID && info?.modelID
				? `${info.providerID}/${info.modelID}`
				: requestedModelId;
		return {
			status: 'completed',
			agentName: request.agentName,
			modelId: actualModelId,
			text,
			durationMs: Date.now() - startedAt,
			promptBytes,
			responseBytes,
			costFields: buildDelegationCostFields({
				raw: response.data,
				model: actualModelId,
			}),
		};
	} catch (error) {
		return {
			...base,
			status: cancelled ? 'cancelled' : timedOut ? 'timeout' : 'error',
			durationMs: Date.now() - startedAt,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timeoutHandle);
		request.abortSignal?.removeEventListener('abort', onCallerAbort);
		controller.abort();
		if (sessionId) {
			await _internals.boundedDelete(
				request.client,
				sessionId,
				request.cleanupTimeoutMs,
			);
		}
	}
}
