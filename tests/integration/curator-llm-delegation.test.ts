import { beforeEach, describe, expect, test, vi } from 'bun:test';
import { CuratorConfigSchema } from '../../src/config/schema';
import {
	type CuratorLLMDelegate,
	parseKnowledgeRecommendations,
	runCuratorInit,
	runCuratorPhase,
} from '../../src/hooks/curator';
import type { CuratorConfig } from '../../src/hooks/curator-types';

// Mock file I/O
vi.mock('../../src/hooks/utils', () => ({
	readSwarmFileAsync: vi.fn().mockResolvedValue(null),
	validateSwarmPath: vi
		.fn()
		.mockReturnValue('/tmp/test/.swarm/curator-summary.json'),
}));
vi.mock('../../src/hooks/knowledge-store', () => ({
	readKnowledge: vi.fn().mockResolvedValue([]),
	appendKnowledge: vi.fn().mockResolvedValue(undefined),
	rewriteKnowledge: vi.fn().mockResolvedValue(undefined),
	resolveSwarmKnowledgePath: vi
		.fn()
		.mockReturnValue('/tmp/test/.swarm/knowledge.jsonl'),
	enforceKnowledgeCap: async () => {},
	sweepAgedEntries: async () => {},
	sweepStaleTodos: async () => {},
	bumpKnowledgeConfidenceBatch: async () => {},
}));
vi.mock('../../src/background/event-bus', () => ({
	getGlobalEventBus: vi.fn().mockReturnValue({ publish: vi.fn() }),
}));

const defaultConfig: CuratorConfig = CuratorConfigSchema.parse({});

describe('curator LLM delegation', () => {
	test('runCuratorPhase invokes llmDelegate in CURATOR_PHASE mode', async () => {
		const delegate: CuratorLLMDelegate = vi
			.fn()
			.mockResolvedValue(
				'KNOWLEDGE_UPDATES:\n- promote entry_1: good lesson\n',
			);
		const result = await runCuratorPhase(
			'/tmp/test',
			1,
			['coder', 'reviewer'],
			defaultConfig,
			{},
			delegate,
		);
		expect(delegate).toHaveBeenCalledTimes(1);
		expect(result.knowledge_recommendations.length).toBeGreaterThanOrEqual(1);
	});

	test('runCuratorInit invokes llmDelegate in CURATOR_INIT mode', async () => {
		const delegate: CuratorLLMDelegate = vi
			.fn()
			.mockResolvedValue('BRIEFING:\nSome analysis\n');
		const result = await runCuratorInit('/tmp/test', defaultConfig, delegate);
		expect(delegate).toHaveBeenCalledTimes(1);
		expect(result.briefing).toContain('LLM-Enhanced Analysis');
	});

	test('LLM failure falls back to data-only mode with warning', async () => {
		const delegate: CuratorLLMDelegate = vi
			.fn()
			.mockRejectedValue(new Error('LLM_ERROR'));
		const result = await runCuratorPhase(
			'/tmp/test',
			1,
			['coder'],
			defaultConfig,
			{},
			delegate,
		);
		expect(delegate).toHaveBeenCalledTimes(1);
		expect(result.knowledge_recommendations).toEqual([]);
		expect(result.summary_updated).toBe(true);
	});

	test('curator enabled by default', () => {
		const config = CuratorConfigSchema.parse({});
		expect(config.enabled).toBe(true);
	});

	test('parseKnowledgeRecommendations parses promote actions', () => {
		const output =
			'KNOWLEDGE_UPDATES:\n- promote entry_1: good lesson\n- archive entry_2: outdated\n';
		const recs = parseKnowledgeRecommendations(output);
		expect(recs).toHaveLength(2);
		expect(recs[0].action).toBe('promote');
		expect(recs[1].action).toBe('archive');
	});

	test('parseKnowledgeRecommendations returns empty for no section', () => {
		const recs = parseKnowledgeRecommendations(
			'No knowledge updates section here',
		);
		expect(recs).toHaveLength(0);
	});
});
