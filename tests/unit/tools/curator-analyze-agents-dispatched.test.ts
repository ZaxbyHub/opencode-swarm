/**
 * #2039 split (FR-006): curator-analyze resolves `agents_dispatched` from the
 * real bounded core event store (readCoreEvents), which the parent suite's
 * readSwarmFileAsync mock cannot feed. These tests seed real legacy-format
 * store files; the curator/LLM/receipt/config dependencies stay mocked.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	test,
	vi,
} from 'bun:test';
import { withFrozenClock } from '../../helpers/test-clock.js';

/** Deterministic fixture timestamp (test-clock lint, issue #1782). */
const FIXED_TS = withFrozenClock(() => new Date().toISOString());

import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const mockRunCuratorPhase = vi.fn();
const mockApplyCuratorKnowledgeUpdates = vi.fn();
// Spread the real module (invariant 7): the tool uses real filterPhaseEvents.
const realCurator = await import('../../../src/hooks/curator.js');
mock.module('../../../src/hooks/curator.js', () => ({
	...realCurator,
	runCuratorPhase: mockRunCuratorPhase,
	applyCuratorKnowledgeUpdates: mockApplyCuratorKnowledgeUpdates,
}));

const mockCreateCuratorLLMDelegate = vi.fn();
vi.mock('../../../src/hooks/curator-llm-factory.js', () => ({
	createCuratorLLMDelegate: mockCreateCuratorLLMDelegate,
}));

const mockBuildApprovedReceipt = vi.fn();
const mockBuildRejectedReceipt = vi.fn();
const mockPersistReviewReceipt = vi.fn();
vi.mock('../../../src/hooks/review-receipt.js', () => ({
	buildApprovedReceipt: mockBuildApprovedReceipt,
	buildRejectedReceipt: mockBuildRejectedReceipt,
	persistReviewReceipt: mockPersistReviewReceipt,
}));

const mockLoadPluginConfigWithMeta = vi.fn();
vi.mock('../../../src/config', () => ({
	loadPluginConfigWithMeta: mockLoadPluginConfigWithMeta,
}));

const mockCuratorConfigSchemaParse = vi.fn((v) => v ?? {});
const mockKnowledgeConfigSchemaParse = vi.fn((v) => v ?? {});
vi.mock('../../../src/config/schema', () => ({
	CuratorConfigSchema: { parse: mockCuratorConfigSchemaParse },
	KnowledgeConfigSchema: { parse: mockKnowledgeConfigSchemaParse },
}));

import { curator_analyze } from '../../../src/tools/curator-analyze';

/** Seed a real legacy-format store file; returns the project root. */
function seedEventsStore(lines: Array<Record<string, unknown>>): string {
	const dir = canonicalMkdtemp('curator-analyze-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'events.jsonl'),
		`${lines.map((e) => JSON.stringify(e)).join('\n')}\n`,
		'utf-8',
	);
	return dir;
}

afterEach(() => {
	mock.restore();
});

beforeEach(() => {
	vi.clearAllMocks();
	mockRunCuratorPhase.mockResolvedValue({
		phase: 1,
		digest: {
			phase: 1,
			timestamp: FIXED_TS,
			summary: 'Test digest',
			agents_used: [],
			tasks_completed: 0,
			tasks_total: 0,
			key_decisions: [],
			blockers_resolved: [],
		},
		compliance: [],
		knowledge_recommendations: [],
		summary_updated: false,
	});
	mockApplyCuratorKnowledgeUpdates.mockResolvedValue({
		applied: 1,
		skipped: 0,
	});
	mockCreateCuratorLLMDelegate.mockReturnValue({});
	mockBuildApprovedReceipt.mockReturnValue({});
	mockBuildRejectedReceipt.mockReturnValue({});
	mockPersistReviewReceipt.mockResolvedValue(undefined);
	mockLoadPluginConfigWithMeta.mockReturnValue({
		config: { curator: {}, knowledge: {} },
		meta: {},
	});
});

describe('agents_dispatched: resolved from phase_complete event array', () => {
	test('phase_complete event with agents_dispatched array populates agentsDispatched', async () => {
		const dir = seedEventsStore([
			{
				phase: 1,
				type: 'phase_complete',
				agents_dispatched: ['architect', 'coder', 'reviewer'],
			},
		]);

		const result = await curator_analyze.execute({ phase: 1 }, {
			directory: dir,
		} as Parameters<typeof curator_analyze.execute>[1]);
		const parsed = JSON.parse(result);

		expect(parsed).not.toHaveProperty('error');
		expect(mockRunCuratorPhase).toHaveBeenCalledTimes(1);
		const call = mockRunCuratorPhase.mock.calls[0];
		// agentsDispatched is the 3rd argument (index 2)
		expect(call?.[2]).toEqual(['architect', 'coder', 'reviewer'].sort());
	});
});

describe('agents_dispatched: resolved from individual agent fields', () => {
	test('delegation events with individual agent fields populate agentsDispatched', async () => {
		const dir = seedEventsStore([
			{ phase: 1, type: 'agent.delegation', agent: 'architect' },
			{ phase: 1, type: 'agent.delegation', agent: 'coder' },
			{ phase: 1, type: 'agent.delegation', agent: 'reviewer' },
		]);

		const result = await curator_analyze.execute({ phase: 1 }, {
			directory: dir,
		} as Parameters<typeof curator_analyze.execute>[1]);
		const parsed = JSON.parse(result);

		expect(parsed).not.toHaveProperty('error');
		expect(mockRunCuratorPhase).toHaveBeenCalledTimes(1);
		const call = mockRunCuratorPhase.mock.calls[0];
		expect(call?.[2]).toEqual(['architect', 'coder', 'reviewer'].sort());
	});
});

describe('agents_dispatched: deduplication when both sources present', () => {
	test('agent appears in both agent field and agents_dispatched array → deduplicated once', async () => {
		// 'coder' appears both as individual agent field AND in agents_dispatched
		const dir = seedEventsStore([
			{ phase: 1, type: 'agent.delegation', agent: 'coder' },
			{ phase: 1, type: 'agent.delegation', agent: 'reviewer' },
			{
				phase: 1,
				type: 'phase_complete',
				agents_dispatched: ['architect', 'coder'],
			},
		]);

		const result = await curator_analyze.execute({ phase: 1 }, {
			directory: dir,
		} as Parameters<typeof curator_analyze.execute>[1]);
		const parsed = JSON.parse(result);

		expect(parsed).not.toHaveProperty('error');
		expect(mockRunCuratorPhase).toHaveBeenCalledTimes(1);
		const call = mockRunCuratorPhase.mock.calls[0];
		// 'coder' deduplicated — only appears once despite being in both sources
		expect(call?.[2]).toEqual(['architect', 'coder', 'reviewer'].sort());
	});
});
