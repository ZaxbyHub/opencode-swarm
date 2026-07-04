import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

interface GatewayContext {
	directory: string;
	sessionID?: string;
	agentRole?: string;
	agentId?: string;
	runId?: string;
	unitId?: string;
}

interface HooksAndRecorder {
	hooks: ReturnType<typeof createMemoryLifecycleHooks>;
	recalls: RecallMemoryInput[];
	logs: unknown[];
	contexts: GatewayContext[];
}

function makeHooks(
	bundle: RecallBundle,
	extraOptions: Partial<
		Pick<MemoryLifecycleHookOptions, 'getActiveTaskId'>
	> = {},
): HooksAndRecorder {
	const recalls: RecallMemoryInput[] = [];
	const logs: unknown[] = [];
	const contexts: GatewayContext[] = [];
	const createGateway: MemoryLifecycleHookOptions['createGateway'] = (
		context,
	) => {
		contexts.push(context);
		return {
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
		};
	};
	const hooks = createMemoryLifecycleHooks({
		directory: 'C:/repo-a',
		config: { enabled: true },
		getActiveAgentName: () => 'mega_test_engineer',
		createGateway,
		appendRunLog: async (_directory, _runId, event) => {
			logs.push(event);
		},
		...extraOptions,
	});
	return { hooks, recalls, logs, contexts };
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

describe('unitId propagation — injection path (B.1)', () => {
	// Coverage gap flagged by an independent reviewer: the manual swarm_memory_recall
	// tool's unitId resolver is tested (tests/unit/tools/swarm-memory-recall-unit-id.test.ts),
	// but the INJECTION path — getActiveTaskId wired in src/index.ts, threaded through
	// injectIntoMessages/recallForAgent in src/memory/injector.ts — was inspection-verified
	// only. This block closes that gap by capturing the context passed into createGateway
	// (unitId lives there, NOT in the recall() input — see recallForAgent in injector.ts).
	const standardOutput = (sessionID: string) => ({
		messages: [
			{
				info: { role: 'system', sessionID },
				parts: [{ type: 'text', text: 'You are Test Engineer.' }],
			},
			{
				info: { role: 'user', sessionID },
				parts: [{ type: 'text', text: 'TASK: implement the memory join key' }],
			},
		],
	});

	test('positive: getActiveTaskId resolving a task id threads unitId onto the gateway context', async () => {
		const bundle = makeBundle(
			makeRecord('test_pattern', 'Run focused tests with bun --smol test.'),
		);
		const { hooks, contexts } = makeHooks(bundle, {
			getActiveTaskId: (sessionID) =>
				sessionID === 'session-a' ? '1.2' : undefined,
		});

		await hooks.messagesTransform(
			{ sessionID: 'session-a' },
			standardOutput('session-a'),
		);

		expect(contexts).toHaveLength(1);
		expect(contexts[0]?.unitId).toBe('1.2');
	});

	test('degrade: getActiveTaskId returning undefined leaves unitId undefined (no sessionID fallback, no empty string)', async () => {
		const bundle = makeBundle(
			makeRecord('test_pattern', 'Run focused tests with bun --smol test.'),
		);
		const { hooks, contexts } = makeHooks(bundle, {
			// Dominant subagent-session case: no task id is resolvable for this session.
			getActiveTaskId: () => undefined,
		});

		await hooks.messagesTransform(
			{ sessionID: 'session-a' },
			standardOutput('session-a'),
		);

		expect(contexts).toHaveLength(1);
		expect(contexts[0]?.unitId).toBeUndefined();
		// Regression guards: a `?? sessionID` or `?? ''` fallback would surface here.
		expect(contexts[0]?.unitId).not.toBe('session-a');
		expect(contexts[0]?.unitId).not.toBe('');
	});

	test("same-session property: getActiveTaskId is invoked with the recall's own sessionID, exactly once", async () => {
		const bundle = makeBundle(
			makeRecord('test_pattern', 'Run focused tests with bun --smol test.'),
		);
		const receivedSessionIDs: (string | undefined)[] = [];
		const { hooks, contexts } = makeHooks(bundle, {
			getActiveTaskId: (sessionID) => {
				receivedSessionIDs.push(sessionID);
				return '3.4';
			},
		});

		await hooks.messagesTransform(
			{ sessionID: 'session-a' },
			standardOutput('session-a'),
		);

		// Called exactly once, with the recall's own session — never a different one.
		expect(receivedSessionIDs).toHaveLength(1);
		const resolvedFor = receivedSessionIDs[0];
		expect(resolvedFor).toBe('session-a');
		// The context the recall was recorded under must match the SAME sessionID
		// the resolver was called with (bind, don't just compare against a literal twice).
		expect(contexts[0]?.sessionID).toBe(resolvedFor);
		expect(contexts[0]?.runId).toBe(resolvedFor);
		expect(contexts[0]?.unitId).toBe('3.4');
	});
});

describe('unitid-probe — issue #1467 diagnostic (env-gated, inert by default)', () => {
	// Verifies the OPENCODE_SWARM_MEMORY_UNITID_PROBE=1 diagnostic added to
	// injector.ts: a temporary empirical probe that records, per injected
	// recall, whether the subagent's dispatch prompt carries a parseable
	// plan-task-id even when session-state resolution (getActiveTaskId)
	// finds nothing for that session.
	const originalFlag = process.env.OPENCODE_SWARM_MEMORY_UNITID_PROBE;
	let probeDir: string;

	beforeEach(() => {
		probeDir = mkdtempSync(path.join(os.tmpdir(), 'injector-unitid-probe-'));
	});

	afterEach(() => {
		if (originalFlag === undefined) {
			delete process.env.OPENCODE_SWARM_MEMORY_UNITID_PROBE;
		} else {
			process.env.OPENCODE_SWARM_MEMORY_UNITID_PROBE = originalFlag;
		}
		try {
			rmSync(probeDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	function probeFilePath(dir: string): string {
		return path.join(dir, '.swarm', 'memory', 'unitid-probe.jsonl');
	}

	function makeHooksWithDirectory(
		bundle: RecallBundle,
		directory: string,
		extraOptions: Partial<
			Pick<MemoryLifecycleHookOptions, 'getActiveTaskId'>
		> = {},
	): ReturnType<typeof createMemoryLifecycleHooks> {
		const createGateway: MemoryLifecycleHookOptions['createGateway'] = () => ({
			isEnabled: () => true,
			deriveAllowedScopes: () => allowedScopes,
			recall: async () => bundle,
			propose: async () => {
				throw new Error('propose is not exercised by this test');
			},
			dispose: async () => {},
		});
		return createMemoryLifecycleHooks({
			directory,
			config: { enabled: true },
			getActiveAgentName: () => 'mega_test_engineer',
			createGateway,
			appendRunLog: async () => {},
			...extraOptions,
		});
	}

	function textOutput(sessionID: string, userText: string) {
		return {
			messages: [
				{
					info: { role: 'system', sessionID },
					parts: [{ type: 'text', text: 'You are Test Engineer.' }],
				},
				{
					info: { role: 'user', sessionID },
					parts: [{ type: 'text', text: userText }],
				},
			],
		};
	}

	test('flag OFF (default): behavior unchanged and no probe file is written', async () => {
		delete process.env.OPENCODE_SWARM_MEMORY_UNITID_PROBE;
		const bundle = makeBundle(
			makeRecord('test_pattern', 'Run focused tests with bun --smol test.'),
		);
		const hooks = makeHooksWithDirectory(bundle, probeDir);
		const output = textOutput('session-a', 'TASK: 1.2 implement X');

		await hooks.messagesTransform({ sessionID: 'session-a' }, output);

		// Behavior is unaffected: the recall message is still injected.
		const injected = output.messages.some((message) =>
			(message.parts as Array<{ text?: string }>).some(
				(part) =>
					typeof part.text === 'string' &&
					part.text.includes('Retrieved Swarm Memory'),
			),
		);
		expect(injected).toBe(true);
		// No probe side effect when the flag is unset.
		expect(existsSync(probeFilePath(probeDir))).toBe(false);
	});

	test('flag ON: subagent case — resolvedUnitId null, promptTaskIdCandidate parsed from TASK: marker', async () => {
		process.env.OPENCODE_SWARM_MEMORY_UNITID_PROBE = '1';
		const bundle = makeBundle(
			makeRecord('test_pattern', 'Run focused tests with bun --smol test.'),
		);
		const hooks = makeHooksWithDirectory(bundle, probeDir, {
			// Dominant subagent-session case: session-state resolution finds nothing.
			getActiveTaskId: () => undefined,
		});
		const taskPrompt = 'TASK: 1.2 implement X';
		const output = textOutput('session-a', taskPrompt);

		await hooks.messagesTransform({ sessionID: 'session-a' }, output);

		const filePath = probeFilePath(probeDir);
		expect(existsSync(filePath)).toBe(true);
		const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0]);
		expect(record.promptTaskIdCandidate).toBe('1.2');
		expect(record.resolvedUnitId).toBeNull();
		expect(record.sessionID).toBe('session-a');
		expect(record.agentRole).toBe('test_engineer');
		expect(record.bundleId).toBe(bundle.id);
		expect(record.agentTaskSnippet).toBe(taskPrompt.slice(0, 160));
		expect(typeof record.timestamp).toBe('string');
		expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
	});

	test('flag ON, no marker: agentTask without TASK: marker → promptTaskIdCandidate is null', async () => {
		process.env.OPENCODE_SWARM_MEMORY_UNITID_PROBE = '1';
		const bundle = makeBundle(
			makeRecord('test_pattern', 'Run focused tests with bun --smol test.'),
		);
		const hooks = makeHooksWithDirectory(bundle, probeDir, {
			getActiveTaskId: () => undefined,
		});
		const output = textOutput(
			'session-a',
			'Please review the memory injector implementation',
		);

		await hooks.messagesTransform({ sessionID: 'session-a' }, output);

		const filePath = probeFilePath(probeDir);
		expect(existsSync(filePath)).toBe(true);
		const record = JSON.parse(
			readFileSync(filePath, 'utf-8').trim().split('\n')[0],
		);
		expect(record.promptTaskIdCandidate).toBeNull();
		expect(record.resolvedUnitId).toBeNull();
	});

	test('flag ON, zero-item bundle: probe still fires (no-injection case is deliberately observed, not blinded)', async () => {
		process.env.OPENCODE_SWARM_MEMORY_UNITID_PROBE = '1';
		// A produced bundle with zero items — nothing is actually injected into
		// the message stream, but this is the dominant cold-memory subagent case
		// the probe exists to observe, so it must still be recorded.
		const emptyBundle: RecallBundle = {
			id: 'bundle_20260601_empty',
			query: 'query',
			generatedAt: '2026-06-01T00:00:00.000Z',
			items: [],
			tokenEstimate: 0,
			promptBlock: '',
		};
		const hooks = makeHooksWithDirectory(emptyBundle, probeDir, {
			getActiveTaskId: () => undefined,
		});
		const taskPrompt = 'TASK: 2.4 add coverage';
		const output = textOutput('session-a', taskPrompt);

		await hooks.messagesTransform({ sessionID: 'session-a' }, output);

		// No recall message was injected (zero items).
		const injected = output.messages.some((message) =>
			(message.parts as Array<{ text?: string }>).some(
				(part) =>
					typeof part.text === 'string' &&
					part.text.includes('Retrieved Swarm Memory'),
			),
		);
		expect(injected).toBe(false);

		// But the probe row was still written for this no-injection recall.
		const filePath = probeFilePath(probeDir);
		expect(existsSync(filePath)).toBe(true);
		const record = JSON.parse(
			readFileSync(filePath, 'utf-8').trim().split('\n')[0],
		);
		expect(record.promptTaskIdCandidate).toBe('2.4');
		expect(record.resolvedUnitId).toBeNull();
		expect(record.bundleId).toBe(emptyBundle.id);
	});
});
