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
	return {
		value: {
			app: {
				agents: async () => ({
					data: (options?.agents ?? ['reviewer']).map((name) => ({ name })),
				}),
			},
			session: {
				create:
					options?.create ?? (async () => ({ data: { id: 'session-1' } })),
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
		promptRequest: () =>
			promptRequest as {
				body: Record<string, unknown>;
			},
	};
}

function request(overrides: Record<string, unknown> = {}) {
	return {
		directory: process.cwd(),
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
		expect(debugLog).toHaveBeenCalledWith('evaluation session cleanup failed', {
			sessionId: 'session-1',
			error: 'cleanup denied',
		});
	});

	test('bounds and reports stalled session cleanup', async () => {
		const debugLog = mock(() => {});
		_internals.log = debugLog;
		const fake = fakeClient({ remove: () => new Promise(() => {}) });
		const startedAt = performance.now();
		await _internals.boundedDelete(fake.value, 'session-1', 10);
		expect(performance.now() - startedAt).toBeLessThan(250);
		expect(debugLog).toHaveBeenCalledWith(
			'evaluation session cleanup timed out',
			{
				sessionId: 'session-1',
				timeoutMs: 10,
			},
		);
	});
});
