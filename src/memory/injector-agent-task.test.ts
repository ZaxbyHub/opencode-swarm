import { describe, expect, mock, test } from 'bun:test';
import type {
	MemoryLifecycleHookOptions,
	RecallBundle,
	RecallMemoryInput,
} from '.';
import { createMemoryLifecycleHooks } from '.';
import type { MemoryProposal, MemoryRecord, MemoryScopeRef } from './types';

const repositoryScope: MemoryScopeRef = {
	type: 'repository',
	repoId: 'repo-a',
	repoRoot: 'C:/repo-a',
};
const allowedScopes: MemoryScopeRef[] = [
	{ type: 'workspace', workspaceId: 'workspace-a' },
	repositoryScope,
	{ type: 'run', runId: 'session-a' },
	{ type: 'agent', agentId: 'test_engineer', runId: 'session-a' },
];

function makeRecord(kind: MemoryRecord['kind'], text: string): MemoryRecord {
	return {
		id: `mem_${kind === 'test_pattern' ? '1' : '2'}111111111111111`,
		scope: repositoryScope,
		kind,
		text,
		tags: ['testing'],
		confidence: 0.9,
		stability: 'durable',
		source: { type: 'file', filePath: 'package.json' },
		createdAt: '2026-05-20T00:00:00.000Z',
		updatedAt: '2026-05-20T00:00:00.000Z',
		contentHash:
			'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		metadata: {},
	};
}

function makeBundle(record: MemoryRecord): RecallBundle {
	return {
		id: 'bundle_20260524_abcd',
		query: 'query',
		generatedAt: '2026-05-24T00:00:00.000Z',
		items: [
			{
				record,
				score: 0.81,
				reason: 'test fixture',
				signals: {
					textOverlap: 0.5,
					tagOverlap: 0,
					fileOverlap: 0,
					symbolOverlap: 0,
					kindMatch: true,
					scopeMatch: true,
				},
			},
		],
		tokenEstimate: 64,
		promptBlock: [
			'## Retrieved Swarm Memory',
			'',
			'- [mem_1111111111111111] kind=test_pattern scope=repository confidence=0.90 age=4d score=0.81',
			'  Run focused tests with bun --smol test.',
		].join('\n'),
	};
}

interface HooksAndRecorder {
	hooks: ReturnType<typeof createMemoryLifecycleHooks>;
	recalls: RecallMemoryInput[];
	logs: unknown[];
}

function makeHooks(bundle: RecallBundle): HooksAndRecorder {
	const recalls: RecallMemoryInput[] = [];
	const logs: unknown[] = [];
	const createGateway: MemoryLifecycleHookOptions['createGateway'] = () => ({
		isEnabled: () => true,
		deriveAllowedScopes: () => allowedScopes,
		recall: async (input) => {
			recalls.push(input);
			return bundle;
		},
		propose: async () => {
			const proposal: MemoryProposal = {
				id: 'prop_1111111111111111',
				operation: 'add',
				proposedBy: { agentRole: 'coder', runId: 'session-a' },
				rationale: 'test',
				evidenceRefs: [],
				status: 'pending',
				createdAt: '2026-05-24T00:00:00.000Z',
				metadata: {},
			};
			return proposal;
		},
		dispose: async () => {},
	});
	const hooks = createMemoryLifecycleHooks({
		directory: 'C:/repo-a',
		config: { enabled: true },
		getActiveAgentName: () => 'mega_test_engineer',
		createGateway,
		appendRunLog: async (_directory, _runId, event) => {
			logs.push(event);
		},
	});
	return { hooks, recalls, logs };
}

describe('agentTask propagation — SC-017 and SC-018', () => {
	describe('SC-017: Task tool_use with prompt', () => {
		test('agentTask carries the Task tool prompt when tool_use block exists', async () => {
			const bundle = makeBundle(
				makeRecord('test_pattern', 'Run focused tests with bun --smol test.'),
			);
			const { hooks, recalls } = makeHooks(bundle);
			const taskPrompt = 'Write tests for src/memory/injector.ts';

			const output = {
				messages: [
					{
						info: { role: 'system', sessionID: 'session-a' },
						parts: [{ type: 'text', text: 'You are Test Engineer.' }],
					},
					{
						info: { role: 'user', sessionID: 'session-a' },
						parts: [
							{
								type: 'text',
								text: 'TASK: verify tests/unit/memory and write new tests',
							},
						],
					},
					{
						role: 'assistant',
						content: [
							{
								type: 'tool_use',
								name: 'Task',
								id: 'call_task_1',
								input: { prompt: taskPrompt },
							},
						],
					},
				],
			};

			await hooks.messagesTransform({ sessionID: 'session-a' }, output);

			expect(recalls).toHaveLength(1);
			// SC-017: agentTask carries the Task tool prompt
			expect(recalls[0].task).toBe(taskPrompt);
		});

		test('agentTask uses Task tool prompt even when userGoal is different', async () => {
			const bundle = makeBundle(
				makeRecord('code_pattern', 'Use the singleton pattern for providers.'),
			);
			const { hooks, recalls } = makeHooks(bundle);
			const taskPrompt = 'Implement the provider singleton for memory gateway';
			const userGoal = 'Review the memory provider implementation';

			const output = {
				messages: [
					{
						info: { role: 'system', sessionID: 'session-a' },
						parts: [{ type: 'text', text: 'You are Architect.' }],
					},
					{
						info: { role: 'user', sessionID: 'session-a' },
						parts: [{ type: 'text', text: userGoal }],
					},
					{
						role: 'assistant',
						content: [
							{
								type: 'tool_use',
								name: 'Task',
								id: 'call_task_1',
								input: { prompt: taskPrompt },
							},
						],
					},
				],
			};

			await hooks.messagesTransform({ sessionID: 'session-a' }, output);

			expect(recalls).toHaveLength(1);
			// SC-017: agentTask should be the Task prompt, NOT the userGoal
			expect(recalls[0].task).toBe(taskPrompt);
			expect(recalls[0].task).not.toBe(userGoal);
		});
	});

	describe('SC-018: fallback to latestUserText', () => {
		test('no Task tool_use → agentTask falls back to latestUserText', async () => {
			const bundle = makeBundle(
				makeRecord('test_pattern', 'Run focused tests with bun --smol test.'),
			);
			const { hooks, recalls } = makeHooks(bundle);
			const userGoal = 'TASK: verify tests/unit/memory';

			const output = {
				messages: [
					{
						info: { role: 'system', sessionID: 'session-a' },
						parts: [{ type: 'text', text: 'You are Test Engineer.' }],
					},
					{
						info: { role: 'user', sessionID: 'session-a' },
						parts: [{ type: 'text', text: userGoal }],
					},
				],
			};

			await hooks.messagesTransform({ sessionID: 'session-a' }, output);

			expect(recalls).toHaveLength(1);
			// SC-018: fallback to latestUserText
			expect(recalls[0].task).toBe(userGoal);
		});

		test('Task tool_use without prompt field → agentTask falls back to latestUserText', async () => {
			const bundle = makeBundle(
				makeRecord('test_pattern', 'Run focused tests with bun --smol test.'),
			);
			const { hooks, recalls } = makeHooks(bundle);
			const userGoal = 'TASK: verify the test suite';

			const output = {
				messages: [
					{
						info: { role: 'system', sessionID: 'session-a' },
						parts: [{ type: 'text', text: 'You are Test Engineer.' }],
					},
					{
						info: { role: 'user', sessionID: 'session-a' },
						parts: [{ type: 'text', text: userGoal }],
					},
					{
						role: 'assistant',
						content: [
							{
								type: 'tool_use',
								name: 'Task',
								id: 'call_task_1',
								input: {}, // no prompt field
							},
						],
					},
				],
			};

			await hooks.messagesTransform({ sessionID: 'session-a' }, output);

			expect(recalls).toHaveLength(1);
			// SC-018: fallback since prompt is missing
			expect(recalls[0].task).toBe(userGoal);
		});

		test('non-Task tool_use blocks → agentTask falls back to latestUserText', async () => {
			const bundle = makeBundle(
				makeRecord('test_pattern', 'Run focused tests with bun --smol test.'),
			);
			const { hooks, recalls } = makeHooks(bundle);
			const userGoal = 'TASK: review the code changes';

			const output = {
				messages: [
					{
						info: { role: 'system', sessionID: 'session-a' },
						parts: [{ type: 'text', text: 'You are Reviewer.' }],
					},
					{
						info: { role: 'user', sessionID: 'session-a' },
						parts: [{ type: 'text', text: userGoal }],
					},
					{
						role: 'assistant',
						content: [
							{
								type: 'tool_use',
								name: 'Read',
								id: 'call_read_1',
								input: { path: 'src/memory/injector.ts' },
							},
							{
								type: 'tool_use',
								name: 'grep',
								id: 'call_grep_1',
								input: { pattern: 'extractTaskToolPrompt' },
							},
						],
					},
				],
			};

			await hooks.messagesTransform({ sessionID: 'session-a' }, output);

			expect(recalls).toHaveLength(1);
			// SC-018: fallback since no Task tool_use exists
			expect(recalls[0].task).toBe(userGoal);
		});
	});

	describe('multiple Task tool_use blocks → most recent one wins', () => {
		test('most recent Task tool_use prompt is used', async () => {
			const bundle = makeBundle(
				makeRecord('test_pattern', 'Run focused tests with bun --smol test.'),
			);
			const { hooks, recalls } = makeHooks(bundle);
			const olderPrompt = 'First task: write tests';
			const recentPrompt = 'Second task: verify tests pass';

			const output = {
				messages: [
					{
						info: { role: 'system', sessionID: 'session-a' },
						parts: [{ type: 'text', text: 'You are Test Engineer.' }],
					},
					{
						info: { role: 'user', sessionID: 'session-a' },
						parts: [{ type: 'text', text: 'TASK: complete the test suite' }],
					},
					// Earlier assistant message
					{
						role: 'assistant',
						content: [
							{
								type: 'tool_use',
								name: 'Task',
								id: 'call_task_old',
								input: { prompt: olderPrompt },
							},
						],
					},
					// More recent assistant message (later in array)
					{
						role: 'assistant',
						content: [
							{
								type: 'tool_use',
								name: 'Read',
								id: 'call_read_1',
								input: { path: 'src/memory/injector.ts' },
							},
							{
								type: 'tool_use',
								name: 'Task',
								id: 'call_task_recent',
								input: { prompt: recentPrompt },
							},
						],
					},
				],
			};

			await hooks.messagesTransform({ sessionID: 'session-a' }, output);

			expect(recalls).toHaveLength(1);
			// Most recent Task tool_use (in later message) should be used
			expect(recalls[0].task).toBe(recentPrompt);
			expect(recalls[0].task).not.toBe(olderPrompt);
		});

		test('most recent Task tool_use within same message content array', async () => {
			const bundle = makeBundle(
				makeRecord('test_pattern', 'Run focused tests with bun --smol test.'),
			);
			const { hooks, recalls } = makeHooks(bundle);
			const firstPrompt = 'Task one: plan the implementation';
			const secondPrompt = 'Task two: implement the feature';

			const output = {
				messages: [
					{
						info: { role: 'system', sessionID: 'session-a' },
						parts: [{ type: 'text', text: 'You are Coder.' }],
					},
					{
						info: { role: 'user', sessionID: 'session-a' },
						parts: [{ type: 'text', text: 'TASK: build the feature' }],
					},
					{
						role: 'assistant',
						content: [
							{
								type: 'tool_use',
								name: 'Task',
								id: 'call_task_1',
								input: { prompt: firstPrompt },
							},
							{
								type: 'tool_use',
								name: 'Task',
								id: 'call_task_2',
								input: { prompt: secondPrompt },
							},
						],
					},
				],
			};

			await hooks.messagesTransform({ sessionID: 'session-a' }, output);

			expect(recalls).toHaveLength(1);
			// Most recent within the same message (second in array since iterating backwards)
			expect(recalls[0].task).toBe(secondPrompt);
			expect(recalls[0].task).not.toBe(firstPrompt);
		});
	});

	describe('edge cases', () => {
		test('Task tool_use with empty string prompt falls back to latestUserText', async () => {
			const bundle = makeBundle(
				makeRecord('test_pattern', 'Run focused tests with bun --smol test.'),
			);
			const { hooks, recalls } = makeHooks(bundle);
			const userGoal = 'TASK: run the test suite';

			const output = {
				messages: [
					{
						info: { role: 'system', sessionID: 'session-a' },
						parts: [{ type: 'text', text: 'You are Test Engineer.' }],
					},
					{
						info: { role: 'user', sessionID: 'session-a' },
						parts: [{ type: 'text', text: userGoal }],
					},
					{
						role: 'assistant',
						content: [
							{
								type: 'tool_use',
								name: 'Task',
								id: 'call_task_1',
								input: { prompt: '' }, // empty string prompt
							},
						],
					},
				],
			};

			await hooks.messagesTransform({ sessionID: 'session-a' }, output);

			expect(recalls).toHaveLength(1);
			// Empty prompt string should trigger fallback
			expect(recalls[0].task).toBe(userGoal);
		});

		test('assistant message with non-array content is handled gracefully', async () => {
			const bundle = makeBundle(
				makeRecord('test_pattern', 'Run focused tests with bun --smol test.'),
			);
			const { hooks, recalls } = makeHooks(bundle);
			const userGoal = 'TASK: review memory implementation';

			const output = {
				messages: [
					{
						info: { role: 'system', sessionID: 'session-a' },
						parts: [{ type: 'text', text: 'You are Reviewer.' }],
					},
					{
						info: { role: 'user', sessionID: 'session-a' },
						parts: [{ type: 'text', text: userGoal }],
					},
					// assistant message with string content instead of array
					{
						role: 'assistant',
						content: 'Some assistant text response',
					} as unknown,
				],
			};

			await hooks.messagesTransform({ sessionID: 'session-a' }, output);

			expect(recalls).toHaveLength(1);
			// No Task tool_use found, falls back to latestUserText
			expect(recalls[0].task).toBe(userGoal);
		});

		test('Task tool_use with non-string prompt field falls back', async () => {
			const bundle = makeBundle(
				makeRecord('test_pattern', 'Run focused tests with bun --smol test.'),
			);
			const { hooks, recalls } = makeHooks(bundle);
			const userGoal = 'TASK: analyze the code';

			const output = {
				messages: [
					{
						info: { role: 'system', sessionID: 'session-a' },
						parts: [{ type: 'text', text: 'You are Analyst.' }],
					},
					{
						info: { role: 'user', sessionID: 'session-a' },
						parts: [{ type: 'text', text: userGoal }],
					},
					{
						role: 'assistant',
						content: [
							{
								type: 'tool_use',
								name: 'Task',
								id: 'call_task_1',
								input: { prompt: 123 as unknown as string }, // number instead of string
							},
						],
					},
				],
			};

			await hooks.messagesTransform({ sessionID: 'session-a' }, output);

			expect(recalls).toHaveLength(1);
			// Non-string prompt should trigger fallback
			expect(recalls[0].task).toBe(userGoal);
		});
	});
});
