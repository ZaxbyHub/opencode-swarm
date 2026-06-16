import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import { createCuratorLLMDelegate } from '../../../src/hooks/curator-llm-factory';
import { swarmState } from '../../../src/state';

// NOTE: We deliberately do NOT vi.mock('../../../src/state'). Replacing the
// shared state module leaks a stripped-down swarmState (missing fields such as
// agentSessions) into every other test file in Bun's shared test-runner
// process (AGENTS.md #7 — DI over mock.module). Instead we mutate the real
// swarmState singleton and restore the touched fields in afterEach.

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

type CuratorStateFields = {
	opencodeClient: unknown;
	curatorInitAgentNames: string[];
	curatorPhaseAgentNames: string[];
	curatorPostmortemAgentNames: string[];
	activeAgent: Map<string, string>;
};

let savedState: CuratorStateFields;

beforeEach(() => {
	vi.clearAllMocks();
	const s = swarmState as unknown as CuratorStateFields;
	// Snapshot the real fields this suite mutates so afterEach can restore them.
	savedState = {
		opencodeClient: s.opencodeClient,
		curatorInitAgentNames: s.curatorInitAgentNames,
		curatorPhaseAgentNames: s.curatorPhaseAgentNames,
		curatorPostmortemAgentNames: s.curatorPostmortemAgentNames,
		activeAgent: s.activeAgent,
	};
	s.opencodeClient = null;
	s.curatorInitAgentNames = [];
	s.curatorPhaseAgentNames = [];
	s.curatorPostmortemAgentNames = [];
	s.activeAgent = new Map();
});

afterEach(() => {
	const s = swarmState as unknown as CuratorStateFields;
	s.opencodeClient = savedState.opencodeClient;
	s.curatorInitAgentNames = savedState.curatorInitAgentNames;
	s.curatorPhaseAgentNames = savedState.curatorPhaseAgentNames;
	s.curatorPostmortemAgentNames = savedState.curatorPostmortemAgentNames;
	s.activeAgent = savedState.activeAgent;
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

	// ─── Single-swarm resolution ────────────────────────────────────

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

	// ─── Multi-swarm active-agent resolution ─────────────────────────

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

	// ─── Direct sessionId lookup ────────────────────────────────────

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

	// ─── Finding 1 fix: default-swarm sessionId hole ──────────────────────

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

	// ─── Prefix collision (longest-match) ────────────────────────────

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

	// ─── Session lifecycle ───────────────────────────────────────

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

	test('aborted signal during prompt is forwarded to the SDK and mapped to CURATOR_LLM_TIMEOUT', async () => {
		// Fix C: the AbortSignal is forwarded to session.create AND
		// session.prompt so the SDK cancels natively (instead of the old
		// abort-handler-deletes-session path). A native AbortError surfaced by
		// the SDK is then translated into the CURATOR_LLM_TIMEOUT sentinel.
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			['curator_init'];
		mockCreate.mockResolvedValue({ data: { id: 'sess-abort' } });

		const ac = new AbortController();
		// The forwarded signal fires mid-flight; the SDK surfaces an AbortError.
		mockPrompt.mockImplementation(async () => {
			ac.abort();
			const err = new Error('The operation was aborted');
			err.name = 'AbortError';
			throw err;
		});

		const delegate = createCuratorLLMDelegate('/tmp/test')!;
		await expect(delegate('SYS', 'input', ac.signal)).rejects.toThrow(
			'CURATOR_LLM_TIMEOUT',
		);

		// Fix C: signal must be forwarded to BOTH SDK calls (native cancellation).
		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({ signal: ac.signal }),
		);
		expect(mockPrompt).toHaveBeenCalledWith(
			expect.objectContaining({ signal: ac.signal }),
		);
	});

	test('pre-aborted signal bails before any SDK call (CURATOR_LLM_TIMEOUT)', async () => {
		// F-003: the early `if (signal?.aborted)` guard must short-circuit
		// before session.create is invoked.
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			['curator_init'];

		const ac = new AbortController();
		ac.abort();

		const delegate = createCuratorLLMDelegate('/tmp/test')!;
		await expect(delegate('SYS', 'input', ac.signal)).rejects.toThrow(
			'CURATOR_LLM_TIMEOUT',
		);
		expect(mockCreate).not.toHaveBeenCalled();
	});

	test('real prompt failure that coincides with an aborted signal is NOT mislabeled as timeout', async () => {
		// cubic P2: only a genuine AbortError maps to the sentinel. A real
		// failure must surface as itself even if the signal happens to be aborted.
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			['curator_init'];
		mockCreate.mockResolvedValue({ data: { id: 'sess-realfail' } });

		const ac = new AbortController();
		mockPrompt.mockImplementation(async () => {
			ac.abort(); // signal becomes aborted, but the error below is the real cause
			throw new Error('UPSTREAM_500');
		});

		const delegate = createCuratorLLMDelegate('/tmp/test')!;
		await expect(delegate('SYS', 'input', ac.signal)).rejects.toThrow(
			'UPSTREAM_500',
		);
	});

	// ─── Background session parenting (Fix A) ────────────────────────

	test('forwards parentID + descriptive title when sessionId is provided', async () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			['curator_init'];
		mockCreate.mockResolvedValue({ data: { id: 'sess-parent' } });
		mockPrompt.mockResolvedValue({
			data: { info: {}, parts: [{ type: 'text', text: 'ok' }] },
		});

		const delegate = createCuratorLLMDelegate(
			'/tmp/test',
			'phase',
			'parent-sess',
		)!;
		await delegate('SYS', 'input');

		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				body: {
					parentID: 'parent-sess',
					title: expect.stringContaining('background'),
				},
			}),
		);
	});

	test('omits body (root session fallback) when no sessionId is provided', async () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = mockClient;
		(swarmState as { curatorInitAgentNames: string[] }).curatorInitAgentNames =
			['curator_init'];
		mockCreate.mockResolvedValue({ data: { id: 'sess-root' } });
		mockPrompt.mockResolvedValue({
			data: { info: {}, parts: [{ type: 'text', text: 'ok' }] },
		});

		const delegate = createCuratorLLMDelegate('/tmp/test', 'init')!;
		await delegate('SYS', 'input');

		const createArg = mockCreate.mock.calls[0][0] as { body?: unknown };
		expect(createArg.body).toBeUndefined();
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
