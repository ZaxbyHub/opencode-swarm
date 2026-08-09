import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_READ_ONLY_TOOLS,
	dispatchEphemeralAgent,
} from '../../../src/evaluation/ephemeral-agent-dispatcher.js';
import { createReviewModelDispatcher } from '../../../src/review/contracts.js';
import { TOOL_NAMES } from '../../../src/tools/tool-metadata.js';

const directory = process.cwd();

function assistantInfo(overrides: Record<string, unknown> = {}) {
	return {
		id: 'message-1',
		sessionID: 'review-session',
		role: 'assistant',
		time: { created: 1, completed: 2 },
		parentID: 'parent-message',
		modelID: 'actual-model',
		providerID: 'actual-provider',
		mode: 'reviewer',
		agent: 'reviewer',
		path: { cwd: directory, root: directory },
		cost: 0.125,
		tokens: {
			input: 17,
			output: 9,
			reasoning: 3,
			cache: { read: 4, write: 2 },
		},
		finish: 'stop',
		...overrides,
	};
}

function fakeClient(options?: {
	create?: (request: unknown) => Promise<unknown>;
	prompt?: (request: unknown) => Promise<unknown>;
	remove?: (request: unknown) => Promise<unknown>;
}) {
	let createRequest: unknown;
	let promptRequest: unknown;
	let deleteRequest: unknown;
	return {
		client: {
			session: {
				create: async (request: unknown) => {
					createRequest = request;
					return options?.create
						? options.create(request)
						: { data: { id: 'review-session' } };
				},
				prompt: async (request: unknown) => {
					promptRequest = request;
					return options?.prompt
						? options.prompt(request)
						: {
								data: {
									info: assistantInfo(),
									parts: [{ type: 'text', text: 'review output' }],
								},
							};
				},
				delete: async (request: unknown) => {
					deleteRequest = request;
					return options?.remove ? options.remove(request) : {};
				},
			},
		} as never,
		createRequest: () =>
			createRequest as {
				body: Record<string, unknown>;
				query: Record<string, unknown>;
				signal: AbortSignal;
			},
		promptRequest: () =>
			promptRequest as {
				body: Record<string, unknown>;
				signal: AbortSignal;
			},
		deleteRequest: () =>
			deleteRequest as {
				path: Record<string, unknown>;
				signal: AbortSignal;
			},
	};
}

describe('ephemeral agent dispatcher', () => {
	test('denies every registered plugin tool and built-in mutation or recursion escape hatch', () => {
		for (const toolName of TOOL_NAMES) {
			expect(DEFAULT_READ_ONLY_TOOLS[toolName]).toBe(false);
		}
		expect(DEFAULT_READ_ONLY_TOOLS.lint).toBe(false);
		expect(DEFAULT_READ_ONLY_TOOLS.swarm_command).toBe(false);
		expect(DEFAULT_READ_ONLY_TOOLS.task).toBe(false);
		expect(DEFAULT_READ_ONLY_TOOLS.batch).toBe(false);
		expect(DEFAULT_READ_ONLY_TOOLS.bash).toBe(false);
		expect(DEFAULT_READ_ONLY_TOOLS.shell).toBe(false);
	});

	test('binds the parent, replaces the system prompt, denies mutating tools, and extracts cost', async () => {
		const fake = fakeClient();
		const result = await dispatchEphemeralAgent({
			client: fake.client,
			directory,
			parentSessionId: 'parent-session',
			agentName: 'mega_reviewer',
			model: { providerID: 'requested-provider', modelID: 'requested-model' },
			system: 'replacement system',
			prompt: 'inspect this diff',
			readOnlyTools: DEFAULT_READ_ONLY_TOOLS,
			title: 'bounded review',
			timeoutMs: 1_000,
		});

		expect(result).toMatchObject({
			status: 'completed',
			text: 'review output',
			agentName: 'mega_reviewer',
			modelId: 'actual-provider/actual-model',
			promptBytes: Buffer.byteLength(
				'replacement systeminspect this diff',
				'utf8',
			),
			responseBytes: Buffer.byteLength('review output', 'utf8'),
			costFields: {
				tokens_input: 17,
				tokens_output: 9,
				tokens_reasoning: 3,
				tokens_cache: 6,
				cost_usd: 0.125,
				cost_source: 'reported',
				model: 'actual-provider/actual-model',
			},
		});
		expect(fake.createRequest()).toMatchObject({
			body: { parentID: 'parent-session', title: 'bounded review' },
			query: { directory },
		});
		expect(fake.promptRequest().body).toEqual({
			agent: 'mega_reviewer',
			model: {
				providerID: 'requested-provider',
				modelID: 'requested-model',
			},
			system: 'replacement system',
			tools: DEFAULT_READ_ONLY_TOOLS,
			parts: [{ type: 'text', text: 'inspect this diff' }],
		});
		expect(fake.deleteRequest().path).toEqual({ id: 'review-session' });
	});

	test('omits the system field when no system prompt is supplied', async () => {
		const fake = fakeClient();
		const result = await dispatchEphemeralAgent({
			client: fake.client,
			directory,
			agentName: 'reviewer',
			prompt: 'inspect this diff',
			readOnlyTools: DEFAULT_READ_ONLY_TOOLS,
			timeoutMs: 1_000,
		});

		expect(result.status).toBe('completed');
		expect(fake.promptRequest().body).not.toHaveProperty('system');
		expect(result.promptBytes).toBe(
			Buffer.byteLength('inspect this diff', 'utf8'),
		);
	});

	test('aborts a stalled prompt and awaits bounded cleanup before returning', async () => {
		let promptSignal: AbortSignal | undefined;
		let releaseDelete: (() => void) | undefined;
		const fake = fakeClient({
			prompt: async (request: unknown) => {
				promptSignal = (request as { signal: AbortSignal }).signal;
				return new Promise(() => {});
			},
			remove: () =>
				new Promise<void>((resolve) => {
					releaseDelete = resolve;
				}),
		});
		let settled = false;
		const pending = dispatchEphemeralAgent({
			client: fake.client,
			directory,
			agentName: 'reviewer',
			system: 'system',
			prompt: 'prompt',
			readOnlyTools: DEFAULT_READ_ONLY_TOOLS,
			timeoutMs: 15,
			cleanupTimeoutMs: 250,
		}).then((value) => {
			settled = true;
			return value;
		});

		await Bun.sleep(40);
		expect(promptSignal?.aborted).toBe(true);
		expect(fake.deleteRequest().path).toEqual({ id: 'review-session' });
		expect(settled).toBe(false);
		releaseDelete?.();

		const result = await pending;
		expect(result.status).toBe('timeout');
	});

	test('caps the response transcript and preserves SDK error envelopes', async () => {
		const promptCapped = await dispatchEphemeralAgent({
			client: fakeClient().client,
			directory,
			agentName: 'reviewer',
			system: 'system',
			prompt: 'prompt',
			readOnlyTools: DEFAULT_READ_ONLY_TOOLS,
			promptByteLimit: 4,
			timeoutMs: 1_000,
		});
		expect(promptCapped.status).toBe('error');
		expect(promptCapped.error).toContain('prompt exceeded 4 bytes');

		const oversized = fakeClient({
			prompt: async () => ({
				data: {
					info: assistantInfo(),
					parts: [{ type: 'text', text: 'too large' }],
				},
			}),
		});
		const capped = await dispatchEphemeralAgent({
			client: oversized.client,
			directory,
			agentName: 'reviewer',
			system: 'system',
			prompt: 'prompt',
			readOnlyTools: DEFAULT_READ_ONLY_TOOLS,
			responseByteLimit: 4,
			timeoutMs: 1_000,
		});
		expect(capped.status).toBe('error');
		expect(capped.error).toContain('exceeded 4 bytes');

		const envelope = fakeClient({
			prompt: async () => ({
				data: null,
				error: { statusCode: 429, message: 'insufficient_quota' },
			}),
		});
		const failed = await dispatchEphemeralAgent({
			client: envelope.client,
			directory,
			agentName: 'reviewer',
			system: 'system',
			prompt: 'prompt',
			readOnlyTools: DEFAULT_READ_ONLY_TOOLS,
			timeoutMs: 1_000,
		});
		expect(failed.status).toBe('error');
		expect(failed.error).toContain('"statusCode":429');
		expect(failed.error).toContain('insufficient_quota');
	});

	test('distinguishes caller cancellation from timeout', async () => {
		const controller = new AbortController();
		const fake = fakeClient({
			prompt: async () => new Promise(() => {}),
		});
		const pending = dispatchEphemeralAgent({
			client: fake.client,
			directory,
			agentName: 'reviewer',
			system: 'system',
			prompt: 'prompt',
			readOnlyTools: DEFAULT_READ_ONLY_TOOLS,
			timeoutMs: 1_000,
			abortSignal: controller.signal,
		});
		controller.abort();
		expect((await pending).status).toBe('cancelled');
	});
});

describe('review model dispatcher adapter', () => {
	test('uses the bounded primitive with the complete read-only tool denial set', async () => {
		const fake = fakeClient();
		const dispatcher = createReviewModelDispatcher(fake.client);
		const result = await dispatcher.dispatch({
			directory,
			parentSessionId: 'parent-session',
			agentName: 'critic_finding_validator',
			model: { providerID: 'provider', modelID: 'model' },
			system: 'validator replacement system',
			prompt: 'validate findings',
			timeoutMs: 1_000,
			title: 'finding validation',
		});

		expect(result.status).toBe('completed');
		expect(fake.promptRequest().body).toMatchObject({
			agent: 'critic_finding_validator',
			system: 'validator replacement system',
			tools: DEFAULT_READ_ONLY_TOOLS,
		});
	});

	test('keeps separately bound client instances isolated during concurrent dispatch', async () => {
		const first = fakeClient({
			prompt: async () => ({
				data: {
					info: assistantInfo({
						providerID: 'first-provider',
						modelID: 'first-model',
					}),
					parts: [{ type: 'text', text: 'first response' }],
				},
			}),
		});
		const second = fakeClient({
			prompt: async () => ({
				data: {
					info: assistantInfo({
						providerID: 'second-provider',
						modelID: 'second-model',
					}),
					parts: [{ type: 'text', text: 'second response' }],
				},
			}),
		});
		const [firstResult, secondResult] = await Promise.all([
			createReviewModelDispatcher(first.client).dispatch({
				directory,
				agentName: 'first_reviewer',
				system: 'first system',
				prompt: 'first prompt',
			}),
			createReviewModelDispatcher(second.client).dispatch({
				directory,
				agentName: 'second_reviewer',
				system: 'second system',
				prompt: 'second prompt',
			}),
		]);

		expect(firstResult).toMatchObject({
			text: 'first response',
			modelId: 'first-provider/first-model',
		});
		expect(secondResult).toMatchObject({
			text: 'second response',
			modelId: 'second-provider/second-model',
		});
		expect(first.promptRequest().body.agent).toBe('first_reviewer');
		expect(second.promptRequest().body.agent).toBe('second_reviewer');
	});
});
