import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
	_internals,
	createEvaluationModelDispatcher,
	resolveEvaluationAgentName,
} from '../../../src/evaluation/model-dispatcher.js';

const originalLog = _internals.log;
const originalBoundedDelete = _internals.boundedDelete;

afterEach(() => {
	_internals.log = originalLog;
	_internals.boundedDelete = originalBoundedDelete;
});

const assistantInfo = {
	id: 'message-1',
	sessionID: 'session-1',
	role: 'assistant',
	time: { created: 1, completed: 2 },
	parentID: 'parent-message',
	modelID: 'actual-model',
	providerID: 'actual-provider',
	mode: 'reviewer',
	agent: 'reviewer',
	path: { cwd: 'C:/repo', root: 'C:/repo' },
	cost: 0,
	tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
	finish: 'stop',
} as const;

function fakeClient(options?: {
	agents?: string[];
	create?: () => Promise<unknown>;
	prompt?: (request: unknown) => Promise<unknown>;
	remove?: () => Promise<unknown>;
}) {
	let deleted = 0;
	let promptRequest: unknown;
	let agentsDirectory: string | undefined;
	let createDirectory: string | undefined;
	return {
		value: {
			app: {
				agents: async (req?: { query?: { directory?: string } }) => {
					agentsDirectory = req?.query?.directory;
					return {
						data: (options?.agents ?? ['reviewer']).map((name) => ({
							name,
						})),
					};
				},
			},
			session: {
				create:
					options?.create ??
					(async (req?: { query?: { directory?: string } }) => {
						createDirectory = req?.query?.directory;
						return { data: { id: 'session-1' } };
					}),
				prompt: async (request: unknown) => {
					promptRequest = request;
					return options?.prompt
						? options.prompt(request)
						: {
								data: {
									info: assistantInfo,
									parts: [{ type: 'text', text: '{"v":1,"caught":true}' }],
								},
							};
				},
				delete: async () => {
					deleted++;
					return options?.remove?.();
				},
			},
		} as never,
		deleted: () => deleted,
		agentsDirectory: () => agentsDirectory,
		createDirectory: () => createDirectory,
		promptRequest: () =>
			promptRequest as {
				body: Record<string, unknown>;
			},
	};
}

function request(overrides: Record<string, unknown> = {}) {
	return {
		sessionDirectory: process.cwd(),
		agentName: 'reviewer',
		modelId: 'configured',
		prompt: 'inspect',
		timeoutMs: 1_000,
		...overrides,
	};
}

describe('evaluation agent resolution', () => {
	test('supports legacy and one prefixed swarm role', () => {
		expect(resolveEvaluationAgentName([{ name: 'reviewer' }], 'reviewer')).toBe(
			'reviewer',
		);
		expect(
			resolveEvaluationAgentName([{ name: 'mega_reviewer' }], 'reviewer'),
		).toBe('mega_reviewer');
	});

	test('requires a preferred swarm when multiple prefixes exist', () => {
		const agents = [{ name: 'local_reviewer' }, { name: 'mega_reviewer' }];
		expect(() => resolveEvaluationAgentName(agents, 'reviewer')).toThrow(
			'preferredSwarm',
		);
		expect(resolveEvaluationAgentName(agents, 'reviewer', 'mega')).toBe(
			'mega_reviewer',
		);
	});

	test('honors a preferred swarm when the legacy role is also registered', () => {
		const agents = [{ name: 'reviewer' }, { name: 'mega_reviewer' }];
		expect(resolveEvaluationAgentName(agents, 'reviewer', 'mega')).toBe(
			'mega_reviewer',
		);
	});

	test('rejects a preferred swarm that does not register the requested role', () => {
		expect(() =>
			resolveEvaluationAgentName([{ name: 'reviewer' }], 'reviewer', 'mega'),
		).toThrow('preferred swarm mega');
		expect(() =>
			resolveEvaluationAgentName(
				[{ name: 'local_reviewer' }],
				'reviewer',
				'mega',
			),
		).toThrow('preferred swarm mega');
	});
});

describe('evaluation model dispatcher', () => {
	test('selects the explicit model, reports actual identity, and is read-only', async () => {
		const debugLog = mock(() => {});
		_internals.log = debugLog;
		const fake = fakeClient({ agents: ['mega_reviewer'] });
		const dispatch = createEvaluationModelDispatcher(fake.value);
		const result = await dispatch(
			request({
				modelId: 'requested-provider/requested-model',
				preferredSwarm: 'mega',
				system: 'immutable candidate payload',
			}),
		);
		expect(result).toMatchObject({
			status: 'completed',
			modelId: 'actual-provider/actual-model',
			agentName: 'mega_reviewer',
		});
		expect(fake.promptRequest().body).toMatchObject({
			agent: 'mega_reviewer',
			model: {
				providerID: 'requested-provider',
				modelID: 'requested-model',
			},
			system: 'immutable candidate payload',
			tools: {
				write: false,
				edit: false,
				patch: false,
				bash: false,
				task: false,
				todowrite: false,
			},
		});
		expect(fake.deleted()).toBe(1);
		expect(debugLog).not.toHaveBeenCalled();
	});

	test('#2009: forwards sessionDirectory to both agent discovery and session create (same permission partition)', async () => {
		// OpenCode keys permission state per directory. The session directory MUST
		// be the invoking instance's directory so the ephemeral session lands in
		// the SAME permission universe — a foreign directory gets an empty
		// approved list and a private pending map the TUI cannot reach, so a
		// prompt raised there hangs forever. Both app.agents and session.create
		// must receive the SAME sessionDirectory (agents are registered per-dir
		// for the plugin; the session must match).
		const fake = fakeClient();
		const dispatch = createEvaluationModelDispatcher(fake.value);
		const sessionDir = '/project/root';
		await dispatch(request({ sessionDirectory: sessionDir }));
		expect(fake.agentsDirectory()).toBe(sessionDir);
		expect(fake.createDirectory()).toBe(sessionDir);
	});

	test('omits the system field when evaluation supplies no override', async () => {
		const fake = fakeClient();
		const result = await createEvaluationModelDispatcher(fake.value)(request());

		expect(result.status).toBe('completed');
		expect(fake.promptRequest().body).not.toHaveProperty('system');
	});

	test('bounds a stalled session create before prompt', async () => {
		const fake = fakeClient({ create: () => new Promise(() => {}) });
		const result = await createEvaluationModelDispatcher(fake.value)(
			request({ timeoutMs: 10 }),
		);
		expect(result.status).toBe('timeout');
		expect(fake.deleted()).toBe(0);
	});

	test('bounds a stalled prompt and awaits session cleanup', async () => {
		const fake = fakeClient({ prompt: () => new Promise(() => {}) });
		const result = await createEvaluationModelDispatcher(fake.value)(
			request({ timeoutMs: 10 }),
		);
		expect(result.status).toBe('timeout');
		expect(fake.deleted()).toBe(1);
	});

	test('returns despite cleanup failure', async () => {
		const debugLog = mock(() => {});
		_internals.log = debugLog;
		const fake = fakeClient({
			remove: async () => {
				throw new Error('cleanup denied');
			},
		});
		const result = await createEvaluationModelDispatcher(fake.value)(request());
		expect(result.status).toBe('completed');
		expect(fake.deleted()).toBe(1);
		expect(debugLog).toHaveBeenCalledWith(
			'ephemeral agent session cleanup failed',
			{
				sessionId: 'session-1',
				error: 'cleanup denied',
			},
		);
	});

	test('bounds and reports stalled session cleanup', async () => {
		const debugLog = mock(() => {});
		_internals.log = debugLog;
		const fake = fakeClient({ remove: () => new Promise(() => {}) });
		const startedAt = performance.now();
		await _internals.boundedDelete(fake.value, 'session-1', 10);
		expect(performance.now() - startedAt).toBeLessThan(250);
		expect(debugLog).toHaveBeenCalledWith(
			'ephemeral agent session cleanup timed out',
			{
				sessionId: 'session-1',
				timeoutMs: 10,
			},
		);
	});
});

/**
 * #1896: the evaluation dispatcher retries a transient/quota error on the SAME
 * model (never substitutes a fallback — `request.modelId` is the benchmark
 * subject, so substitution would corrupt attribution). Each failed attempt's
 * session is cleaned up via `boundedDelete` before the retry so no ephemeral
 * session leaks. After `maxSameModelRetries` (2) the enriched error string
 * records the retry count. A permanent error short-circuits with no retry.
 */
describe('evaluation model dispatcher — same-model quota retry (#1896)', () => {
	// fakeClient variant whose `prompt` records every call's body.model and can
	// be programmed to throw a quota error N times before succeeding.
	function fakeClientWithRetryPrompt(opts: {
		failTimes: number;
		errorMessage: string;
		succeedText?: string;
	}) {
		let promptCalls = 0;
		let deleteCalls = 0;
		const modelsRequested: Array<unknown> = [];
		const client = {
			app: {
				agents: async () => ({ data: [{ name: 'reviewer' }] }),
			},
			session: {
				create: async () => ({ data: { id: `session-${++promptCalls}` } }),
				prompt: async (req: { body: { model?: unknown } }) => {
					modelsRequested.push(req.body?.model);
					// Throw the configured error for the first `failTimes` calls.
					// Use promptCalls as the monotonic counter (incremented in create).
					const attempt = promptCalls;
					if (attempt <= opts.failTimes) {
						throw new Error(opts.errorMessage);
					}
					return {
						data: {
							info: assistantInfo,
							parts: [
								{
									type: 'text',
									text: opts.succeedText ?? '{"v":1,"caught":true}',
								},
							],
						},
					};
				},
				delete: async () => {
					deleteCalls++;
					return {};
				},
			},
		} as never;
		return {
			client,
			modelsRequested: () => modelsRequested,
			deleteCalls: () => deleteCalls,
		};
	}

	test('retries a quota error on the SAME model and eventually succeeds (no substitution)', async () => {
		// Fail twice on quota, succeed on the 3rd attempt (initial + 2 retries).
		const fake = fakeClientWithRetryPrompt({
			failTimes: 2,
			errorMessage: '429 insufficient_quota: usage limit exceeded',
		});
		const dispatch = createEvaluationModelDispatcher(fake.client);
		const result = await dispatch(
			request({ modelId: 'bench-provider/bench-model', timeoutMs: 5_000 }),
		);

		// Recovered → completed.
		expect(result.status).toBe('completed');
		// Every prompt attempt used the SAME requested model — NO fallback
		// substitution (the benchmark-attribution invariant).
		expect(fake.modelsRequested()).toHaveLength(3);
		for (const model of fake.modelsRequested()) {
			expect(model).toEqual({
				providerID: 'bench-provider',
				modelID: 'bench-model',
			});
		}
		// The result is attributed to the requested subject model (actual-model
		// from assistantInfo is reported, but the request was never substituted).
		expect(result.modelId).toBe('actual-provider/actual-model');
	});

	test('cleans up each failed attempt session before retrying (no leak)', async () => {
		// Fail once on quota, succeed on the 2nd attempt.
		const fake = fakeClientWithRetryPrompt({
			failTimes: 1,
			errorMessage: '429 insufficient_quota: usage limit exceeded',
		});
		const dispatch = createEvaluationModelDispatcher(fake.client);
		const result = await dispatch(request({ timeoutMs: 5_000 }));

		expect(result.status).toBe('completed');
		// 2 prompt attempts → 1 failed session cleaned up mid-retry + 1 final
		// session cleaned up in the finally clause = at least 2 deletes. (The
		// mid-retry boundedDelete fires for attempt 1's session; the finally
		// fires for attempt 2's session.)
		expect(fake.deleteCalls()).toBeGreaterThanOrEqual(2);
	});

	test('enriches the error string with the retry count when quota exhausts all retries', async () => {
		// Fail on every attempt (initial + 2 retries = 3 quota failures).
		const fake = fakeClientWithRetryPrompt({
			failTimes: 5,
			errorMessage: '429 insufficient_quota: usage limit exceeded',
		});
		const dispatch = createEvaluationModelDispatcher(fake.client);
		const result = await dispatch(request({ timeoutMs: 5_000 }));

		// All 3 attempts (1 initial + 2 retries) burned on the same model.
		expect(result.status).toBe('error');
		expect(fake.modelsRequested()).toHaveLength(3);
		// The enriched error records that the same model was retried 2 times and
		// was NOT substituted (benchmark-attribution preservation).
		expect(typeof result.error).toBe('string');
		expect(result.error as string).toContain(
			'retried the same model 2 time(s) — not substituted',
		);
		expect(result.error as string).toContain('quota/usage limit');
	});

	test('does NOT retry a permanent (non-transient, non-quota) error', async () => {
		// 401 unauthorized is permanent — no retry, immediate error return.
		const fake = fakeClientWithRetryPrompt({
			failTimes: 5,
			errorMessage: '401 unauthorized: invalid api key',
		});
		const dispatch = createEvaluationModelDispatcher(fake.client);
		const result = await dispatch(request({ timeoutMs: 5_000 }));

		expect(result.status).toBe('error');
		// Only ONE prompt attempt — no retry on a permanent error.
		expect(fake.modelsRequested()).toHaveLength(1);
		// No quota-suffix enrichment on a non-quota error.
		expect(result.error).toBe('401 unauthorized: invalid api key');
	});
});
