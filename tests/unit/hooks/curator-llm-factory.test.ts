import { beforeEach, describe, expect, test, vi } from 'bun:test';
import { createCuratorLLMDelegate } from '../../../src/hooks/curator-llm-factory';
import { swarmState } from '../../../src/state';

// Mock swarmState so we can control opencodeClient and curator agent names
vi.mock('../../../src/state', () => ({
	swarmState: {
		opencodeClient: null,
		curatorInitAgentNames: [] as string[],
		curatorPhaseAgentNames: [] as string[],
		curatorPostmortemAgentNames: [] as string[],
		activeAgent: new Map<string, string>(),
	},
}));

const mockDelete = vi.fn().mockResolvedValue({ data: undefined });
const mockPrompt = vi.fn();
const mockCreate = vi.fn();

const mockClient = {
	session: {
		create: mockCreate,
		prompt: mockPrompt,
		delete: mockDelete,
	},
} as never;

beforeEach(() => {
	vi.clearAllMocks();
	(swarmState as { opencodeClient: unknown }).opencodeClient = null;
	(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
		[];
	(swarmState as { curatorPhaseAgentNames: string[] }).curatorPhaseAgentNames =
		[];
	(
		swarmState as { curatorPostmortemAgentNames: string[] }
	).curatorPostmortemAgentNames = [];
	(swarmState as { activeAgent: Map<string, string> }).activeAgent = new Map();
});

describe('createCuratorLLMDelegate', () => {
	test('returns undefined when opencodeClient is null', () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = null;
		const delegate = createCuratorLLMDelegate('/tmp/test');
		expect(delegate).toBeUndefined();
	});

	test('returns a delegate function when client is available', () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		const delegate = createCuratorLLMDelegate('/tmp/test');
		expect(typeof delegate).toBe('function');
	});

	// ─── Single-swarm resolution ─────────────────────────────────────────────

	test('single default swarm: uses curator_init', async () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			['curator_init'];
		mockCreate.mockResolvedValue({ data: { id: 'sess-1' } });
		mockPrompt.mockResolvedValue({
			data: { info: {}, parts: [{ type: 'text', text: 'BRIEFING: ok' }] },
		});

		const delegate = createCuratorLLMDelegate('/tmp/test', 'init')!;
		await delegate('SYS', 'input');

		expect(mockPrompt).toHaveBeenCalledWith({
			path: { id: 'sess-1' },
			body: expect.objectContaining({ agent: 'curator_init' }),
		});
	});

	test('single named swarm: uses prefixed curator_init', async () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			['local_curator_init'];
		mockCreate.mockResolvedValue({ data: { id: 'sess-2' } });
		mockPrompt.mockResolvedValue({
			data: { info: {}, parts: [{ type: 'text', text: 'ok' }] },
		});

		const delegate = createCuratorLLMDelegate('/tmp/test', 'init')!;
		await delegate('SYS', 'input');

		expect(mockPrompt).toHaveBeenCalledWith({
			path: { id: 'sess-2' },
			body: expect.objectContaining({ agent: 'local_curator_init' }),
		});
	});

	// ─── Multi-swarm active-agent resolution ─────────────────────────────────

	test('multi-swarm: picks curator for active swarm via prefix matching', async () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		// 5 custom swarms
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			[
				'alpha_curator_init',
				'beta_curator_init',
				'gamma_curator_init',
				'delta_curator_init',
				'epsilon_curator_init',
			];
		// gamma_architect is currently active
		(swarmState as { activeAgent: Map<string, string> }).activeAgent = new Map([
			['sess-gamma', 'gamma_architect'],
		]);
		mockCreate.mockResolvedValue({ data: { id: 'sess-x' } });
		mockPrompt.mockResolvedValue({
			data: { info: {}, parts: [{ type: 'text', text: 'ok' }] },
		});

		const delegate = createCuratorLLMDelegate('/tmp/test', 'init')!;
		await delegate('SYS', 'input');

		expect(mockPrompt).toHaveBeenCalledWith({
			path: { id: 'sess-x' },
			body: expect.objectContaining({ agent: 'gamma_curator_init' }),
		});
	});

	test('multi-swarm: phase mode picks correct swarm curator_phase', async () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(
			swarmState as { curatorPhaseAgentNames: string[] }
		).curatorPhaseAgentNames = ['alpha_curator_phase', 'beta_curator_phase'];
		(swarmState as { activeAgent: Map<string, string> }).activeAgent = new Map([
			['sess-b', 'beta_coder'],
		]);
		mockCreate.mockResolvedValue({ data: { id: 'sess-y' } });
		mockPrompt.mockResolvedValue({
			data: { info: {}, parts: [{ type: 'text', text: 'ok' }] },
		});

		const delegate = createCuratorLLMDelegate('/tmp/test', 'phase')!;
		await delegate('SYS', 'input');

		expect(mockPrompt).toHaveBeenCalledWith({
			path: { id: 'sess-y' },
			body: expect.objectContaining({ agent: 'beta_curator_phase' }),
		});
	});

	test('multi-swarm: postmortem mode picks correct swarm curator_postmortem', async () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(
			swarmState as { curatorPostmortemAgentNames: string[] }
		).curatorPostmortemAgentNames = [
			'alpha_curator_postmortem',
			'beta_curator_postmortem',
		];
		(swarmState as { activeAgent: Map<string, string> }).activeAgent = new Map([
			['sess-a', 'alpha_reviewer'],
		]);
		mockCreate.mockResolvedValue({ data: { id: 'sess-pm' } });
		mockPrompt.mockResolvedValue({
			data: { info: {}, parts: [{ type: 'text', text: 'ok' }] },
		});

		const delegate = createCuratorLLMDelegate('/tmp/test', 'postmortem')!;
		await delegate('SYS', 'input');

		expect(mockPrompt).toHaveBeenCalledWith({
			path: { id: 'sess-pm' },
			body: expect.objectContaining({ agent: 'alpha_curator_postmortem' }),
		});
	});

	test('multi-swarm: falls back to default swarm when no active session matches named swarm', async () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		// Mix of default and named swarms
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			[
				'curator_init', // default swarm (empty prefix)
				'local_curator_init', // named swarm
			];
		// No active sessions at all (e.g. called at plugin init before sessions start)
		(swarmState as { activeAgent: Map<string, string> }).activeAgent =
			new Map();
		mockCreate.mockResolvedValue({ data: { id: 'sess-fb' } });
		mockPrompt.mockResolvedValue({
			data: { info: {}, parts: [{ type: 'text', text: 'ok' }] },
		});

		const delegate = createCuratorLLMDelegate('/tmp/test', 'init')!;
		await delegate('SYS', 'input');

		// Falls back to default swarm (empty prefix) since no active session
		expect(mockPrompt).toHaveBeenCalledWith({
			path: { id: 'sess-fb' },
			body: expect.objectContaining({ agent: 'curator_init' }),
		});
	});

	test('multi-swarm: falls back to first registered when no active session and no default swarm', async () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		// Only non-default swarms registered
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			['alpha_curator_init', 'beta_curator_init'];
		// No active sessions
		(swarmState as { activeAgent: Map<string, string> }).activeAgent =
			new Map();
		mockCreate.mockResolvedValue({ data: { id: 'sess-fb2' } });
		mockPrompt.mockResolvedValue({
			data: { info: {}, parts: [{ type: 'text', text: 'ok' }] },
		});

		const delegate = createCuratorLLMDelegate('/tmp/test', 'init')!;
		await delegate('SYS', 'input');

		// Falls back to first registered
		expect(mockPrompt).toHaveBeenCalledWith({
			path: { id: 'sess-fb2' },
			body: expect.objectContaining({ agent: 'alpha_curator_init' }),
		});
	});

	test('no registered agents: falls back to bare suffix name', async () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			[];
		mockCreate.mockResolvedValue({ data: { id: 'sess-bare' } });
		mockPrompt.mockResolvedValue({
			data: { info: {}, parts: [{ type: 'text', text: 'ok' }] },
		});

		const delegate = createCuratorLLMDelegate('/tmp/test', 'init')!;
		await delegate('SYS', 'input');

		expect(mockPrompt).toHaveBeenCalledWith({
			path: { id: 'sess-bare' },
			body: expect.objectContaining({ agent: 'curator_init' }),
		});
	});

	// ─── Direct sessionId lookup ─────────────────────────────────────────────

	test('sessionId direct lookup: ignores other active sessions, picks calling swarm', async () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			['alpha_curator_init', 'beta_curator_init'];
		// Both alpha and beta sessions are active simultaneously
		(swarmState as { activeAgent: Map<string, string> }).activeAgent = new Map([
			['sess-alpha', 'alpha_architect'],
			['sess-beta', 'beta_architect'],
		]);
		mockCreate.mockResolvedValue({ data: { id: 'sess-x' } });
		mockPrompt.mockResolvedValue({
			data: { info: {}, parts: [{ type: 'text', text: 'ok' }] },
		});

		// beta session calls — must get beta_curator_init, not alpha
		const delegate = createCuratorLLMDelegate(
			'/tmp/test',
			'init',
			'sess-beta',
		)!;
		await delegate('SYS', 'input');

		expect(mockPrompt).toHaveBeenCalledWith({
			path: { id: 'sess-x' },
			body: expect.objectContaining({ agent: 'beta_curator_init' }),
		});
	});

	test('sessionId direct lookup: alpha session gets alpha_curator_init even if beta is first in map', async () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			['alpha_curator_init', 'beta_curator_init'];
		// beta is inserted first (would win under heuristic scan)
		(swarmState as { activeAgent: Map<string, string> }).activeAgent = new Map([
			['sess-beta', 'beta_architect'],
			['sess-alpha', 'alpha_architect'],
		]);
		mockCreate.mockResolvedValue({ data: { id: 'sess-y' } });
		mockPrompt.mockResolvedValue({
			data: { info: {}, parts: [{ type: 'text', text: 'ok' }] },
		});

		const delegate = createCuratorLLMDelegate(
			'/tmp/test',
			'init',
			'sess-alpha',
		)!;
		await delegate('SYS', 'input');

		expect(mockPrompt).toHaveBeenCalledWith({
			path: { id: 'sess-y' },
			body: expect.objectContaining({ agent: 'alpha_curator_init' }),
		});
	});

	// ─── Finding 1 fix: default-swarm sessionId hole ─────────────────────────

	test('default-swarm session uses curator_init even when named swarms also registered', async () => {
		// Finding 1 fix: direct lookup must return default-swarm curator (empty prefix)
		// for a session whose agent has no named-swarm prefix, rather than falling through
		// to heuristic scan which could pick a named-swarm curator.
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			[
				'curator_init', // default swarm (empty prefix)
				'local_curator_init', // named swarm
				'prod_curator_init', // named swarm
			];
		// Default-swarm architect and named-swarm architect both active
		(swarmState as { activeAgent: Map<string, string> }).activeAgent = new Map([
			['sess-default', 'architect'], // default swarm — no prefix
			['sess-local', 'local_architect'], // named swarm
		]);
		mockCreate.mockResolvedValue({ data: { id: 'sess-x' } });
		mockPrompt.mockResolvedValue({
			data: { info: {}, parts: [{ type: 'text', text: 'ok' }] },
		});

		// Default-swarm session calls — must get curator_init, NOT local_curator_init
		const delegate = createCuratorLLMDelegate(
			'/tmp/test',
			'init',
			'sess-default',
		)!;
		await delegate('SYS', 'input');

		expect(mockPrompt).toHaveBeenCalledWith({
			path: { id: 'sess-x' },
			body: expect.objectContaining({ agent: 'curator_init' }),
		});
	});

	// ─── Prefix collision (longest-match) ────────────────────────────────────

	test('prefix collision: alpha_extended_ beats alpha_ for alpha_extended_architect', async () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			['alpha_curator_init', 'alpha_extended_curator_init'];
		(swarmState as { activeAgent: Map<string, string> }).activeAgent = new Map([
			['sess-ext', 'alpha_extended_architect'],
		]);
		mockCreate.mockResolvedValue({ data: { id: 'sess-coll' } });
		mockPrompt.mockResolvedValue({
			data: { info: {}, parts: [{ type: 'text', text: 'ok' }] },
		});

		const delegate = createCuratorLLMDelegate('/tmp/test', 'init', 'sess-ext')!;
		await delegate('SYS', 'input');

		expect(mockPrompt).toHaveBeenCalledWith({
			path: { id: 'sess-coll' },
			// alpha_extended_ (17 chars) wins over alpha_ (6 chars)
			body: expect.objectContaining({ agent: 'alpha_extended_curator_init' }),
		});
	});

	test('prefix collision: shorter prefix alpha_ used when active session is alpha_architect', async () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			['alpha_curator_init', 'alpha_extended_curator_init'];
		(swarmState as { activeAgent: Map<string, string> }).activeAgent = new Map([
			['sess-plain', 'alpha_architect'],
		]);
		mockCreate.mockResolvedValue({ data: { id: 'sess-plain2' } });
		mockPrompt.mockResolvedValue({
			data: { info: {}, parts: [{ type: 'text', text: 'ok' }] },
		});

		const delegate = createCuratorLLMDelegate(
			'/tmp/test',
			'init',
			'sess-plain',
		)!;
		await delegate('SYS', 'input');

		expect(mockPrompt).toHaveBeenCalledWith({
			path: { id: 'sess-plain2' },
			// alpha_extended_ does NOT match 'alpha_architect' — only alpha_ matches
			body: expect.objectContaining({ agent: 'alpha_curator_init' }),
		});
	});

	// ─── Session lifecycle ────────────────────────────────────────────────────

	test('system prompt parameter is NOT forwarded — registered agent uses its own baked-in prompt', async () => {
		// Finding 3 fix: removing system: override allows registered custom prompts to take effect.
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			['curator_init'];
		mockCreate.mockResolvedValue({ data: { id: 'sess-sys' } });
		mockPrompt.mockResolvedValue({
			data: { info: {}, parts: [{ type: 'text', text: 'result' }] },
		});

		const delegate = createCuratorLLMDelegate('/tmp/test', 'init')!;
		const result = await delegate('MY_SYSTEM_PROMPT', 'user input');

		expect(mockPrompt).toHaveBeenCalledWith({
			path: { id: 'sess-sys' },
			body: {
				agent: 'curator_init',
				// No system: field — registered agent baked-in prompt is used instead
				tools: { write: false, edit: false, patch: false },
				parts: [{ type: 'text', text: 'user input' }],
			},
		});
		expect(result).toBe('result');
	});

	test('ephemeral session deleted in finally block', async () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			['curator_init'];
		mockCreate.mockResolvedValue({ data: { id: 'sess-del' } });
		mockPrompt.mockResolvedValue({
			data: { info: {}, parts: [{ type: 'text', text: 'ok' }] },
		});

		const delegate = createCuratorLLMDelegate('/tmp/test')!;
		await delegate('SYS', 'input');

		expect(mockDelete).toHaveBeenCalledWith({ path: { id: 'sess-del' } });
	});

	test('session deleted in finally even on prompt error', async () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			['curator_init'];
		mockCreate.mockResolvedValue({ data: { id: 'sess-err' } });
		mockPrompt.mockRejectedValue(new Error('LLM_FAILURE'));

		const delegate = createCuratorLLMDelegate('/tmp/test')!;
		await expect(delegate('SYS', 'input')).rejects.toThrow('LLM_FAILURE');

		expect(mockDelete).toHaveBeenCalledWith({ path: { id: 'sess-err' } });
	});

	test('throws if session.create fails', async () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		mockCreate.mockResolvedValue({ data: undefined, error: 'server error' });

		const delegate = createCuratorLLMDelegate('/tmp/test')!;
		await expect(delegate('SYS', 'input')).rejects.toThrow(
			'Failed to create curator session',
		);
	});

	test('multiple text parts are joined with newline', async () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			['curator_init'];
		mockCreate.mockResolvedValue({ data: { id: 'sess-multi' } });
		mockPrompt.mockResolvedValue({
			data: {
				info: {},
				parts: [
					{ type: 'text', text: 'part one' },
					{ type: 'tool', id: 'tool-1' },
					{ type: 'text', text: 'part two' },
				],
			},
		});

		const delegate = createCuratorLLMDelegate('/tmp/test')!;
		const result = await delegate('SYS', 'input');

		expect(result).toBe('part one\npart two');
	});

	test('non-text parts are filtered out', async () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			['curator_init'];
		mockCreate.mockResolvedValue({ data: { id: 'sess-filter' } });
		mockPrompt.mockResolvedValue({
			data: {
				info: {},
				parts: [
					{ type: 'reasoning', text: 'internal thought' },
					{ type: 'text', text: 'final answer' },
				],
			},
		});

		const delegate = createCuratorLLMDelegate('/tmp/test')!;
		const result = await delegate('SYS', 'input');

		expect(result).toBe('final answer');
	});

	test('NotFoundError from prompt is converted to CURATOR_LLM_TIMEOUT when signal aborts during prompt', async () => {
		// Regression test: when an AbortController fires (timeout) while
		// session.prompt() is in flight, the abort handler deletes the
		// ephemeral session and session.prompt() throws NotFoundError.
		// Without the fix this becomes an unhandled rejection rather than a
		// clean CURATOR_LLM_TIMEOUT. This test exercises the NEW catch block
		// added around session.prompt(), not the existing pre-abort early check.
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			['curator_init'];
		mockCreate.mockResolvedValue({ data: { id: 'sess-abort' } });

		const ac = new AbortController();
		// Simulate: the abort fires DURING prompt execution, then the SDK
		// throws NotFoundError because the session was deleted by cleanup.
		mockPrompt.mockImplementation(async () => {
			// Abort happens mid-flight (abort handler fires, deletes session)
			ac.abort();
			const err = new Error('Session not found: sess-abort');
			err.name = 'NotFoundError';
			throw err;
		});

		// Signal is NOT pre-aborted; it aborts inside mockPrompt above.
		const delegate = createCuratorLLMDelegate('/tmp/test')!;
		await expect(delegate('SYS', 'input', ac.signal)).rejects.toThrow(
			'CURATOR_LLM_TIMEOUT',
		);
		// session.create() and session.prompt() must both have been called
		expect(mockCreate).toHaveBeenCalledTimes(1);
		expect(mockPrompt).toHaveBeenCalledTimes(1);
	});

	test('non-abort NotFoundError from prompt is re-thrown unchanged', async () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			['curator_init'];
		mockCreate.mockResolvedValue({ data: { id: 'sess-notfound' } });

		const notFoundErr = new Error('Session not found: sess-notfound');
		notFoundErr.name = 'NotFoundError';
		mockPrompt.mockRejectedValue(notFoundErr);

		// No abort signal — error should propagate as-is
		const delegate = createCuratorLLMDelegate('/tmp/test')!;
		await expect(delegate('SYS', 'input')).rejects.toThrow(
			'Session not found: sess-notfound',
		);
	});
});
