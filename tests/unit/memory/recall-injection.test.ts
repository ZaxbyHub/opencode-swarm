import { describe, expect, test } from 'bun:test';
import type {
	MemoryLifecycleHookOptions,
	ProposeMemoryInput,
	RecallMemoryInput,
} from '../../../src/memory';
import {
	createMemoryLifecycleHooks,
	normalizeMemoryAgentRole,
	resolveMemoryRecallProfile,
} from '../../../src/memory';
import { _test_exports as injectorTestExports } from '../../../src/memory/injector';
import type {
	MemoryProposal,
	MemoryRecord,
	MemoryScopeRef,
	RecallBundle,
} from '../../../src/memory/types';

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
		items: [{ record, score: 0.81, reason: 'test fixture' }],
		tokenEstimate: 64,
		promptBlock: [
			'## Retrieved Swarm Memory',
			'',
			'- [mem_1111111111111111] kind=test_pattern scope=repository confidence=0.90 age=4d score=0.81',
			'  Run focused tests with bun --smol test.',
		].join('\n'),
	};
}

function makeHooks(
	bundle: RecallBundle,
	enabled = true,
	options: {
		propose?: (input: ProposeMemoryInput) => Promise<MemoryProposal>;
	} = {},
): {
	hooks: ReturnType<typeof createMemoryLifecycleHooks>;
	recalls: RecallMemoryInput[];
	proposals: ProposeMemoryInput[];
	logs: unknown[];
} {
	const recalls: RecallMemoryInput[] = [];
	const proposals: ProposeMemoryInput[] = [];
	const logs: unknown[] = [];
	const createGateway: MemoryLifecycleHookOptions['createGateway'] = () => ({
		isEnabled: () => enabled,
		deriveAllowedScopes: () => allowedScopes,
		recall: async (input) => {
			recalls.push(input);
			return bundle;
		},
		propose: async (input) => {
			if (options.propose) return options.propose(input);
			proposals.push(input);
			const proposal: MemoryProposal = {
				id: 'prop_1111111111111111',
				operation: input.operation,
				proposedBy: { agentRole: 'coder', runId: 'session-a' },
				rationale: input.rationale,
				evidenceRefs: input.evidenceRefs ?? [],
				status: 'pending',
				createdAt: '2026-05-24T00:00:00.000Z',
				metadata: {},
			};
			return proposal;
		},
	});
	const hooks = createMemoryLifecycleHooks({
		directory: 'C:/repo-a',
		config: { enabled },
		getActiveAgentName: () => 'mega_test_engineer',
		createGateway,
		appendRunLog: async (_directory, _runId, event) => {
			logs.push(event);
		},
	});
	return { hooks, recalls, proposals, logs };
}

describe('memory recall role profiles', () => {
	test('normalizes prefixed QA and security roles', () => {
		expect(normalizeMemoryAgentRole('mega_test_engineer')).toBe('qa');
		expect(normalizeMemoryAgentRole('local_reviewer')).toBe('qa');
		expect(normalizeMemoryAgentRole('critic_drift_verifier')).toBe('security');
		expect(normalizeMemoryAgentRole('unknown_specialist')).toBe('coder');
	});

	test('coder profile recalls code, test, and failure patterns', () => {
		const profile = resolveMemoryRecallProfile('coder');
		expect(profile.kinds).toContain('code_pattern');
		expect(profile.kinds).toContain('test_pattern');
		expect(profile.kinds).toContain('failure_pattern');
	});
});

describe('memory lifecycle injection', () => {
	test('messages transform injects scoped recall before the user task', async () => {
		const { hooks, recalls, logs } = makeHooks(
			makeBundle(
				makeRecord('test_pattern', 'Run focused tests with bun --smol test.'),
			),
		);
		const output = {
			messages: [
				{
					info: { role: 'system', sessionID: 'session-a' },
					parts: [{ type: 'text', text: 'You are Test Engineer.' }],
				},
				{
					info: { role: 'user', sessionID: 'session-a' },
					parts: [{ type: 'text', text: 'TASK: verify tests/unit/memory' }],
				},
			],
		};

		await hooks.messagesTransform({ sessionID: 'session-a' }, output);

		expect(output.messages).toHaveLength(3);
		expect(output.messages[1].info.role).toBe('system');
		expect(output.messages[1].parts[0].text).toContain(
			'## Retrieved Swarm Memory',
		);
		expect(output.messages[2].parts[0].text).toContain('TASK: verify');
		expect(recalls[0].scopes).toEqual(allowedScopes);
		expect(recalls[0].kinds).toEqual([
			'test_pattern',
			'failure_pattern',
			'repo_convention',
			'security_note',
		]);
		expect(logs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ event: 'recall_requested' }),
				expect.objectContaining({ event: 'recall_returned' }),
				expect.objectContaining({
					event: 'prompt_injected',
					memoryIds: ['mem_1111111111111111'],
					tokenEstimate: 64,
				}),
			]),
		);
	});

	test('missing memory is a no-op', async () => {
		const emptyBundle: RecallBundle = {
			...makeBundle(makeRecord('repo_convention', 'unused')),
			items: [],
			promptBlock: '## Retrieved Swarm Memory',
		};
		const { hooks } = makeHooks(emptyBundle);
		const output = {
			messages: [
				{ info: { role: 'system' }, parts: [{ type: 'text', text: 'system' }] },
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
			],
		};

		await hooks.messagesTransform({ sessionID: 'session-a' }, output);

		expect(output.messages).toHaveLength(2);
	});

	test('existing recall block prevents duplicate injection', async () => {
		const { hooks, recalls } = makeHooks(
			makeBundle(makeRecord('repo_convention', 'unused')),
		);
		const output = {
			messages: [
				{
					info: { role: 'system' },
					parts: [
						{ type: 'text', text: '## Retrieved Swarm Memory\nexisting' },
					],
				},
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
			],
		};

		await hooks.messagesTransform({ sessionID: 'session-a' }, output);

		expect(output.messages).toHaveLength(2);
		expect(recalls).toHaveLength(0);
		expect(injectorTestExports.messagesContainRecall(output.messages)).toBe(
			true,
		);
	});

	test('compactText preserves complete unicode code points at the length cap', () => {
		const prefix = 'a'.repeat(1999);
		const compacted = injectorTestExports.compactText(`${prefix}😀 trailing`);

		expect(Array.from(compacted)).toHaveLength(2000);
		expect(compacted.endsWith('😀')).toBe(true);
		expect(compacted).not.toContain('\uFFFD');
	});

	test('memory disabled leaves messages and proposals unchanged', async () => {
		const { hooks, recalls, proposals } = makeHooks(
			makeBundle(makeRecord('repo_convention', 'disabled')),
			false,
		);
		const output = {
			messages: [
				{ info: { role: 'system' }, parts: [{ type: 'text', text: 'system' }] },
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
			],
		};

		await hooks.messagesTransform({ sessionID: 'session-a' }, output);
		await hooks.toolAfter(
			{
				tool: 'task',
				sessionID: 'session-a',
				args: { subagent_type: 'coder', prompt: 'TASK: implement' },
			},
			{
				output: JSON.stringify({
					memoryProposals: [
						{
							operation: 'add',
							kind: 'repo_convention',
							text: 'This repo uses bun.',
							rationale: 'Observed package manager.',
							evidenceRefs: ['package.json'],
						},
					],
				}),
			},
		);

		expect(output.messages).toHaveLength(2);
		expect(recalls).toHaveLength(0);
		expect(proposals).toHaveLength(0);
	});

	test('Task output memoryProposals are captured as pending proposals', async () => {
		const { hooks, proposals, logs } = makeHooks(
			makeBundle(makeRecord('repo_convention', 'unused')),
		);

		await hooks.toolAfter(
			{
				tool: 'task',
				sessionID: 'session-a',
				args: { subagent_type: 'coder', prompt: 'TASK: implement' },
			},
			{
				output: JSON.stringify({
					result: 'done',
					memoryProposals: [
						{
							operation: 'add',
							kind: 'repo_convention',
							text: 'This repo uses bun.',
							rationale: 'Observed package manager.',
							evidenceRefs: ['package.json'],
						},
					],
				}),
			},
		);

		expect(proposals).toHaveLength(1);
		expect(proposals[0].operation).toBe('add');
		expect(logs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: 'proposal_created',
					proposalId: 'prop_1111111111111111',
				}),
			]),
		);
	});

	test('Task output proposal errors are logged without throwing', async () => {
		const { hooks, logs } = makeHooks(
			makeBundle(makeRecord('repo_convention', 'unused')),
			true,
			{
				propose: async () => {
					throw new Error('provider rejected proposal');
				},
			},
		);

		await hooks.toolAfter(
			{
				tool: 'task',
				sessionID: 'session-a',
				args: { subagent_type: 'coder', prompt: 'TASK: implement' },
			},
			{
				output: JSON.stringify({
					memoryProposals: [
						{
							operation: 'add',
							kind: 'repo_convention',
							text: 'This repo uses bun.',
							rationale: 'Observed package manager.',
							evidenceRefs: ['package.json'],
						},
					],
				}),
			},
		);

		expect(logs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: 'proposal_rejected_by_validation',
					rejectionReason: 'provider rejected proposal',
				}),
			]),
		);
	});

	test('invalid Task output proposals are logged and dropped', async () => {
		const { hooks, proposals, logs } = makeHooks(
			makeBundle(makeRecord('repo_convention', 'unused')),
		);

		await hooks.toolAfter(
			{
				tool: 'task',
				sessionID: 'session-a',
				args: { subagent_type: 'coder', prompt: 'TASK: implement' },
			},
			{
				output: JSON.stringify({
					memoryProposals: [{ operation: 'add', text: 'Missing rationale' }],
				}),
			},
		);

		expect(proposals).toHaveLength(0);
		expect(logs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: 'proposal_rejected_by_validation',
				}),
			]),
		);
	});
});
