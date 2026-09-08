import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir';
import type {
	MemoryLifecycleHookOptions,
	RecallBundle,
	RecallMemoryInput,
} from '.';
import { createMemoryLifecycleHooks } from '.';
import type { MemoryProposal, MemoryRecord, MemoryScopeRef } from './types';

/**
 * Issue #2529: memory-recall task-prompt extraction must match the host's REAL
 * task tool spellings — the lowercase `task` name inside Anthropic-shaped
 * tool_use blocks AND host-shaped `{type:'tool', tool:'task', state:{input}}`
 * parts (every ToolState variant carries `input`). Sibling of
 * injector-agent-task.test.ts (which is over the FR-006 500-line cap and
 * cannot grow).
 */

const repositoryScope: MemoryScopeRef = {
	type: 'repository',
	repoId: 'repo-2529',
	repoRoot: 'E:/repo-2529',
};

function makeBundle(): RecallBundle {
	const record: MemoryRecord = {
		id: 'mem_2529aaaaaaaaaaaaaaaaa',
		scope: repositoryScope,
		kind: 'test_pattern',
		text: 'Run focused tests with bun --smol test.',
		tags: ['testing'],
		confidence: 0.9,
		stability: 'durable',
		source: { type: 'file', filePath: 'package.json' },
		createdAt: '2026-05-20T00:00:00.000Z',
		updatedAt: '2026-05-20T00:00:00.000Z',
		contentHash: 'a'.repeat(64),
		metadata: {},
	};
	return {
		id: 'bundle_2529',
		query: 'query',
		generatedAt: '2026-05-24T00:00:00.000Z',
		items: [
			{
				record,
				score: 0.81,
				reason: '2529 fixture',
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
		promptBlock: '## Retrieved Swarm Memory\n\n- fixture',
	};
}

function makeHooks(): {
	hooks: ReturnType<typeof createMemoryLifecycleHooks>;
	recalls: RecallMemoryInput[];
} {
	const recalls: RecallMemoryInput[] = [];
	const createGateway: MemoryLifecycleHookOptions['createGateway'] = () => ({
		isEnabled: () => true,
		deriveAllowedScopes: () => [repositoryScope],
		recall: async (input) => {
			recalls.push(input);
			return makeBundle();
		},
		propose: async () =>
			({
				id: 'prop_2529aaaaaaaaaaaaaa',
				operation: 'add',
				proposedBy: { agentRole: 'coder', runId: 'run-2529' },
				rationale: '2529',
				evidenceRefs: [],
				status: 'pending',
				createdAt: '2026-05-24T00:00:00.000Z',
				metadata: {},
			}) satisfies MemoryProposal,
		dispose: async () => {},
	});
	const hooks = createMemoryLifecycleHooks({
		directory: canonicalMkdtemp('injector-2529-'),
		config: { enabled: true },
		getActiveAgentName: () => 'mega_test_engineer',
		createGateway,
		appendRunLog: async () => {},
	});
	return { hooks, recalls };
}

function userMessage(sessionID: string, text: string) {
	return { info: { role: 'user', sessionID }, parts: [{ type: 'text', text }] };
}

describe('agentTask extraction for the host task tool id (#2529)', () => {
	let configDirectory = '';
	let previousXdgConfigHome: string | undefined;

	beforeEach(() => {
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
		configDirectory = canonicalMkdtemp('injector-2529-config-');
		process.env.XDG_CONFIG_HOME = configDirectory;
	});

	afterEach(() => {
		if (previousXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
		}
		try {
			fs.rmSync(configDirectory, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	});

	test('lowercase-name tool_use recovers agentTask from the prompt', async () => {
		const { hooks, recalls } = makeHooks();
		const taskPrompt = 'Write tests for src/memory/injector.ts';
		const userGoal = 'TASK: unrelated latest user text';
		const output = {
			messages: [
				userMessage('s-2529-a', userGoal),
				{
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							name: 'task',
							id: 'call_2529_a',
							input: { prompt: taskPrompt },
						},
					],
				},
			],
		};
		await hooks.messagesTransform({ sessionID: 's-2529-a' }, output);
		expect(recalls).toHaveLength(1);
		expect(recalls[0]?.task).toBe(taskPrompt);
		expect(recalls[0]?.task).not.toBe(userGoal);
	});

	test('host-shaped ToolPart (type tool, tool task, state.input.prompt) recovers agentTask', async () => {
		const { hooks, recalls } = makeHooks();
		const taskPrompt = 'Refactor the scope binding resolver';
		const userGoal = 'TASK: unrelated latest user text';
		const output = {
			messages: [
				userMessage('s-2529-b', userGoal),
				{
					info: { role: 'assistant', sessionID: 's-2529-b' },
					parts: [
						{
							type: 'tool',
							tool: 'task',
							state: { status: 'running', input: { prompt: taskPrompt } },
						},
					],
				},
			],
		};
		await hooks.messagesTransform({ sessionID: 's-2529-b' }, output);
		expect(recalls).toHaveLength(1);
		expect(recalls[0]?.task).toBe(taskPrompt);
		expect(recalls[0]?.task).not.toBe(userGoal);
	});

	test('legacy capitalised Task tool_use still recovers agentTask (control)', async () => {
		const { hooks, recalls } = makeHooks();
		const taskPrompt = 'Legacy Task prompt must keep working';
		const output = {
			messages: [
				userMessage('s-2529-legacy', 'TASK: unrelated'),
				{
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							name: 'Task',
							id: 'call_2529_legacy',
							input: { prompt: taskPrompt },
						},
					],
				},
			],
		};
		await hooks.messagesTransform({ sessionID: 's-2529-legacy' }, output);
		expect(recalls).toHaveLength(1);
		expect(recalls[0]?.task).toBe(taskPrompt);
	});
});
