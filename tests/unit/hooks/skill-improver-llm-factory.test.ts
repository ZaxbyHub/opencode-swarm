import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import { createSkillImproverLLMDelegate } from '../../../src/hooks/skill-improver-llm-factory';
import { swarmState } from '../../../src/state';

// As with curator-llm-factory.test.ts we mutate the real swarmState singleton
// and restore the touched fields in afterEach, rather than vi.mock-ing the
// shared state module (which leaks across Bun's shared test-runner process —
// AGENTS.md #7).

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

type SkillImproverStateFields = {
	opencodeClient: unknown;
	skillImproverAgentNames: string[];
	activeAgent: Map<string, string>;
};

let savedState: SkillImproverStateFields;

beforeEach(() => {
	vi.clearAllMocks();
	const s = swarmState as unknown as SkillImproverStateFields;
	savedState = {
		opencodeClient: s.opencodeClient,
		skillImproverAgentNames: s.skillImproverAgentNames,
		activeAgent: s.activeAgent,
	};
	s.opencodeClient = mockClient;
	s.skillImproverAgentNames = ['skill_improver'];
	s.activeAgent = new Map();
});

afterEach(() => {
	const s = swarmState as unknown as SkillImproverStateFields;
	s.opencodeClient = savedState.opencodeClient;
	s.skillImproverAgentNames = savedState.skillImproverAgentNames;
	s.activeAgent = savedState.activeAgent;
});

describe('createSkillImproverLLMDelegate', () => {
	test('returns undefined when opencodeClient is null', () => {
		(swarmState as { opencodeClient: unknown }).opencodeClient = null;
		expect(createSkillImproverLLMDelegate('/tmp/test')).toBeUndefined();
	});

	// ─── Background session parenting (Fix A) ────────────────────────

	test('forwards parentID + descriptive title when sessionId is provided', async () => {
		mockCreate.mockResolvedValue({ data: { id: 'sess-parent' } });
		mockPrompt.mockResolvedValue({
			data: { parts: [{ type: 'text', text: 'ok' }] },
		});

		const delegate = createSkillImproverLLMDelegate(
			'/tmp/test',
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
		mockCreate.mockResolvedValue({ data: { id: 'sess-root' } });
		mockPrompt.mockResolvedValue({
			data: { parts: [{ type: 'text', text: 'ok' }] },
		});

		const delegate = createSkillImproverLLMDelegate('/tmp/test')!;
		await delegate('SYS', 'input');

		const createArg = mockCreate.mock.calls[0][0] as { body?: unknown };
		expect(createArg.body).toBeUndefined();
	});

	// ─── Abort handling (Fix C + cubic P2) ───────────────────────────

	test('pre-aborted signal bails before any SDK call (SKILL_IMPROVER_LLM_TIMEOUT)', async () => {
		const ac = new AbortController();
		ac.abort();

		const delegate = createSkillImproverLLMDelegate('/tmp/test')!;
		await expect(delegate('SYS', 'input', ac.signal)).rejects.toThrow(
			'SKILL_IMPROVER_LLM_TIMEOUT',
		);
		expect(mockCreate).not.toHaveBeenCalled();
	});

	test('aborted signal during prompt is forwarded to the SDK and mapped to SKILL_IMPROVER_LLM_TIMEOUT', async () => {
		mockCreate.mockResolvedValue({ data: { id: 'sess-abort' } });

		const ac = new AbortController();
		mockPrompt.mockImplementation(async () => {
			ac.abort();
			const err = new Error('The operation was aborted');
			err.name = 'AbortError';
			throw err;
		});

		const delegate = createSkillImproverLLMDelegate('/tmp/test')!;
		await expect(delegate('SYS', 'input', ac.signal)).rejects.toThrow(
			'SKILL_IMPROVER_LLM_TIMEOUT',
		);

		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({ signal: ac.signal }),
		);
		expect(mockPrompt).toHaveBeenCalledWith(
			expect.objectContaining({ signal: ac.signal }),
		);
	});

	test('real prompt failure that coincides with an aborted signal is NOT mislabeled as timeout', async () => {
		mockCreate.mockResolvedValue({ data: { id: 'sess-realfail' } });

		const ac = new AbortController();
		mockPrompt.mockImplementation(async () => {
			ac.abort();
			throw new Error('UPSTREAM_500');
		});

		const delegate = createSkillImproverLLMDelegate('/tmp/test')!;
		await expect(delegate('SYS', 'input', ac.signal)).rejects.toThrow(
			'UPSTREAM_500',
		);
	});
});
