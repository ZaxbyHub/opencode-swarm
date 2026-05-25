import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
	_internals as proposeInternals,
	swarm_memory_propose,
} from '../../../src/tools/swarm-memory-propose';
import {
	_internals as recallInternals,
	swarm_memory_recall,
} from '../../../src/tools/swarm-memory-recall';

const originalRecallLoadConfig = recallInternals.loadPluginConfigWithMeta;
const originalRecallCreateGateway = recallInternals.createMemoryGateway;
const originalProposeLoadConfig = proposeInternals.loadPluginConfigWithMeta;
const originalProposeCreateGateway = proposeInternals.createMemoryGateway;

afterEach(() => {
	recallInternals.loadPluginConfigWithMeta = originalRecallLoadConfig;
	recallInternals.createMemoryGateway = originalRecallCreateGateway;
	proposeInternals.loadPluginConfigWithMeta = originalProposeLoadConfig;
	proposeInternals.createMemoryGateway = originalProposeCreateGateway;
	mock.restore();
});

describe('swarm memory tools', () => {
	test('recall returns a clear disabled result when memory is absent', async () => {
		recallInternals.loadPluginConfigWithMeta = mock(() => ({
			config: {},
		})) as any;

		const result = await swarm_memory_recall.execute(
			{ query: 'testing patterns' },
			process.cwd(),
		);
		const parsed = JSON.parse(result);

		expect(parsed.disabled).toBe(true);
		expect(parsed.message).toContain('Swarm memory is disabled');
	});

	test('recall returns compact markdown and memory IDs from the gateway', async () => {
		recallInternals.loadPluginConfigWithMeta = mock(() => ({
			config: { memory: { enabled: true } },
		})) as any;
		recallInternals.createMemoryGateway = mock(() => ({
			recall: mock(async () => ({
				id: 'bundle_20260524120000_abcdef12',
				items: [{ record: { id: 'mem_aaaaaaaaaaaaaaaa' } }],
				tokenEstimate: 42,
				promptBlock: '## Retrieved Swarm Memory\n- [mem_aaaaaaaaaaaaaaaa] fact',
			})),
		})) as any;

		const result = await swarm_memory_recall.execute(
			{ query: 'testing patterns', maxItems: 1 },
			process.cwd(),
			{ sessionID: 'session-a' } as any,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(true);
		expect(parsed.memory_ids).toEqual(['mem_aaaaaaaaaaaaaaaa']);
		expect(parsed.prompt_block).toContain('Retrieved Swarm Memory');
	});

	test('propose returns disabled without writing when memory is absent', async () => {
		proposeInternals.loadPluginConfigWithMeta = mock(() => ({
			config: {},
		})) as any;

		const result = await swarm_memory_propose.execute(
			{
				operation: 'add',
				kind: 'repo_convention',
				text: 'This repo uses bun.',
				rationale: 'Useful later.',
				evidenceRefs: ['package.json'],
			},
			process.cwd(),
		);
		const parsed = JSON.parse(result);

		expect(parsed.disabled).toBe(true);
		expect(parsed.message).toContain('Swarm memory is disabled');
	});

	test('propose creates a pending proposal and reports that durable memory was not written', async () => {
		proposeInternals.loadPluginConfigWithMeta = mock(() => ({
			config: { memory: { enabled: true } },
		})) as any;
		proposeInternals.createMemoryGateway = mock(() => ({
			propose: mock(async () => ({
				id: 'prop_aaaaaaaaaaaaaaaa',
				status: 'pending',
				operation: 'add',
				proposedRecord: { id: 'mem_bbbbbbbbbbbbbbbb' },
			})),
		})) as any;

		const result = await swarm_memory_propose.execute(
			{
				operation: 'add',
				kind: 'repo_convention',
				text: 'This repo uses bun.',
				rationale: 'Useful later.',
				evidenceRefs: ['package.json'],
			},
			process.cwd(),
			{ sessionID: 'session-a' } as any,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(true);
		expect(parsed.proposal_id).toBe('prop_aaaaaaaaaaaaaaaa');
		expect(parsed.memory_id).toBe('mem_bbbbbbbbbbbbbbbb');
		expect(parsed.message).toContain('Durable memory was not written');
	});
});
