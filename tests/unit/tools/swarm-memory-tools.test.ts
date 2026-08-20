import { afterEach, describe, expect, mock, test } from 'bun:test';
import { TOOL_MANIFEST } from '../../../src/tools/manifest';
import {
	_internals as outcomeInternals,
	swarm_memory_outcome,
} from '../../../src/tools/swarm-memory-outcome';
import {
	_internals as proposeInternals,
	swarm_memory_propose,
} from '../../../src/tools/swarm-memory-propose';
import {
	_internals as recallInternals,
	swarm_memory_recall,
} from '../../../src/tools/swarm-memory-recall';
import { TOOL_METADATA } from '../../../src/tools/tool-metadata';
import { TOOL_NAME_SET, TOOL_NAMES } from '../../../src/tools/tool-names';

const originalRecallLoadConfig = recallInternals.loadPluginConfigWithMeta;
const originalRecallCreateGateway = recallInternals.createMemoryGateway;
const originalProposeLoadConfig = proposeInternals.loadPluginConfigWithMeta;
const originalProposeCreateGateway = proposeInternals.createMemoryGateway;
const originalOutcomeLoadConfig = outcomeInternals.loadPluginConfigWithMeta;
const originalOutcomeCreateGateway = outcomeInternals.createMemoryGateway;
const originalOutcomeGetAgentSession = outcomeInternals.getAgentSession;
const originalRecordOutcome = outcomeInternals.recordOutcomeWithReflection;

afterEach(() => {
	recallInternals.loadPluginConfigWithMeta = originalRecallLoadConfig;
	recallInternals.createMemoryGateway = originalRecallCreateGateway;
	proposeInternals.loadPluginConfigWithMeta = originalProposeLoadConfig;
	proposeInternals.createMemoryGateway = originalProposeCreateGateway;
	outcomeInternals.loadPluginConfigWithMeta = originalOutcomeLoadConfig;
	outcomeInternals.createMemoryGateway = originalOutcomeCreateGateway;
	outcomeInternals.getAgentSession = originalOutcomeGetAgentSession;
	outcomeInternals.recordOutcomeWithReflection = originalRecordOutcome;
	mock.restore();
});

describe('swarm memory tools', () => {
	test('registers outcome coherently across metadata, manifest, and derived names', () => {
		expect(TOOL_METADATA.swarm_memory_outcome.agents).toEqual([]);
		expect(
			TOOL_METADATA.swarm_memory_outcome.description.length,
		).toBeGreaterThan(0);
		expect(TOOL_MANIFEST.swarm_memory_outcome()).toBe(swarm_memory_outcome);
		expect(TOOL_NAMES).toContain('swarm_memory_outcome');
		expect(TOOL_NAME_SET.has('swarm_memory_outcome')).toBe(true);
	});

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
		const dispose = mock(async () => {});
		recallInternals.createMemoryGateway = mock(() => ({
			recall: mock(async () => ({
				id: 'bundle_20260524120000_abcdef12',
				items: [{ record: { id: 'mem_aaaaaaaaaaaaaaaa' } }],
				tokenEstimate: 42,
				promptBlock: '## Retrieved Swarm Memory\n- [mem_aaaaaaaaaaaaaaaa] fact',
			})),
			dispose,
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
		expect(dispose).toHaveBeenCalledTimes(1);
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
		const dispose = mock(async () => {});
		proposeInternals.createMemoryGateway = mock(() => ({
			propose: mock(async () => ({
				id: 'prop_aaaaaaaaaaaaaaaa',
				status: 'pending',
				operation: 'add',
				proposedRecord: { id: 'mem_bbbbbbbbbbbbbbbb' },
			})),
			dispose,
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
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	test('outcome rejects ambiguous selectors and corrected results without text', async () => {
		outcomeInternals.loadPluginConfigWithMeta = mock(() => ({
			config: { memory: { enabled: true } },
		})) as any;

		const ambiguous = JSON.parse(
			await swarm_memory_outcome.execute(
				{
					memory_id: 'mem_aaaaaaaaaaaaaaaa',
					question: 'Which parser?',
					outcome: 'useful',
				},
				process.cwd(),
			),
		);
		const missingCorrection = JSON.parse(
			await swarm_memory_outcome.execute(
				{ question: 'Which parser?', outcome: 'corrected' },
				process.cwd(),
			),
		);

		expect(ambiguous.error).toContain('exactly one');
		expect(missingCorrection.error).toContain('require correction text');
	});

	test('outcome returns a clear disabled result without creating a gateway', async () => {
		outcomeInternals.loadPluginConfigWithMeta = mock(() => ({
			config: {},
		})) as any;
		outcomeInternals.createMemoryGateway = mock(() => {
			throw new Error('must not create a gateway while disabled');
		}) as any;

		const parsed = JSON.parse(
			await swarm_memory_outcome.execute(
				{ question: 'Which parser?', outcome: 'useful' },
				process.cwd(),
			),
		);

		expect(parsed.disabled).toBe(true);
		expect(outcomeInternals.createMemoryGateway).not.toHaveBeenCalled();
	});

	test('outcome awaits write-through regeneration and disposes the gateway', async () => {
		outcomeInternals.loadPluginConfigWithMeta = mock(() => ({
			config: {
				memory: {
					enabled: true,
					reflection: { enabled: false, halfLifeDays: 30 },
				},
			},
		})) as any;
		const dispose = mock(async () => {});
		const gateway = { dispose };
		let capturedContext: { unitId?: string } | undefined;
		outcomeInternals.getAgentSession = mock(() => ({
			currentTaskId: 'task-7',
		})) as any;
		outcomeInternals.createMemoryGateway = mock((context) => {
			capturedContext = context;
			return gateway;
		}) as any;
		outcomeInternals.recordOutcomeWithReflection = mock(async () => ({
			record: {
				id: 'mem_aaaaaaaaaaaaaaaa',
				outcomes: [{ outcome: 'useful', at: '2026-08-19T12:00:00.000Z' }],
			},
			eventId: 'tool-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			outcomeRecorded: true,
			reflectionUpdated: true,
			digest: { generatedFrom: { entries: 1 } },
		})) as any;

		const result = await (
			swarm_memory_outcome as unknown as {
				execute: (
					args: Record<string, unknown>,
					ctx: Record<string, unknown>,
				) => Promise<string>;
			}
		).execute(
			{
				memory_id: 'mem_aaaaaaaaaaaaaaaa',
				outcome: 'useful',
				anchors: [{ file: 'src/parser.ts', symbol: 'parse' }],
			},
			{
				directory: process.cwd(),
				sessionID: 'session-a',
				messageID: 'message-a',
				agent: 'coder',
			},
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(true);
		expect(parsed.outcome_recorded).toBe(true);
		expect(parsed.event_id).toBe('tool-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
		expect(parsed.reflection_updated).toBe(true);
		expect(outcomeInternals.recordOutcomeWithReflection).toHaveBeenCalledTimes(
			1,
		);
		expect(capturedContext?.unitId).toBe('task-7');
		expect(dispose).toHaveBeenCalledTimes(1);
	});
});
