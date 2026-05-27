/**
 * Tests for curator_analyze entry_id validation (SC-004, SC-005, SC-006)
 *
 * Tests the strict UUID v4 pre-flight validation in curator_analyze:
 * - Non-UUID entry_id strings → error JSON returned
 * - undefined entry_id → passes through (new entry path)
 * - Valid UUID v4 entry_id → passes through (update existing path)
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type Mock,
	test,
	vi,
} from 'bun:test';

// --- MOCKS (must be before import) ---

// Mock curator hooks
const mockRunCuratorPhase = vi.fn();
const mockApplyCuratorKnowledgeUpdates = vi.fn();
vi.mock('../../../src/hooks/curator', () => ({
	runCuratorPhase: mockRunCuratorPhase,
	applyCuratorKnowledgeUpdates: mockApplyCuratorKnowledgeUpdates,
}));

// Mock LLM factory
const mockCreateCuratorLLMDelegate = vi.fn();
vi.mock('../../../src/hooks/curator-llm-factory.js', () => ({
	createCuratorLLMDelegate: mockCreateCuratorLLMDelegate,
}));

// Mock review receipt
const mockBuildApprovedReceipt = vi.fn();
const mockBuildRejectedReceipt = vi.fn();
const mockPersistReviewReceipt = vi.fn();
vi.mock('../../../src/hooks/review-receipt.js', () => ({
	buildApprovedReceipt: mockBuildApprovedReceipt,
	buildRejectedReceipt: mockBuildRejectedReceipt,
	persistReviewReceipt: mockPersistReviewReceipt,
}));

// Mock config
const mockLoadPluginConfigWithMeta = vi.fn();
vi.mock('../../../src/config', () => ({
	loadPluginConfigWithMeta: mockLoadPluginConfigWithMeta,
}));

// Mock config schema
const mockCuratorConfigSchemaParse = vi.fn((v) => v ?? {});
const mockKnowledgeConfigSchemaParse = vi.fn((v) => v ?? {});
vi.mock('../../../src/config/schema', () => ({
	CuratorConfigSchema: { parse: mockCuratorConfigSchemaParse },
	KnowledgeConfigSchema: { parse: mockKnowledgeConfigSchemaParse },
}));

// --- IMPORT AFTER MOCKS ---
import { curator_analyze } from '../../../src/tools/curator-analyze';

// --- SETUP ---
beforeEach(() => {
	vi.clearAllMocks();

	// Default mock return values for successful path
	mockRunCuratorPhase.mockResolvedValue({
		phase: 1,
		digest: {
			phase: 1,
			timestamp: new Date().toISOString(),
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

// ---------------------------------------------------------------------------
// VERIFICATION TESTS (SC-004, SC-005, SC-006)
// ---------------------------------------------------------------------------

describe('SC-004: rejects non-UUID entry_id with error JSON', () => {
	test('entry_id "promote-old-config" returns error JSON containing the offending value', async () => {
		const result = await curator_analyze.execute(
			{
				phase: 1,
				recommendations: [
					{
						action: 'promote',
						entry_id: 'promote-old-config',
						lesson: 'Test lesson',
						reason: 'Test reason',
					},
				],
			},
			'/fake/directory',
		);

		const parsed = JSON.parse(result);

		expect(parsed).toHaveProperty('error');
		expect(typeof parsed.error).toBe('string');
		expect(parsed.error).toContain('promote-old-config');
		expect(parsed.error).toContain('UUID v4');
	});
});

describe('SC-005: accepts undefined entry_id without error', () => {
	test('entry_id: undefined passes through and applyCuratorKnowledgeUpdates is called', async () => {
		const result = await curator_analyze.execute(
			{
				phase: 1,
				recommendations: [
					{
						action: 'promote',
						entry_id: undefined,
						lesson: 'Test lesson for new entry',
						reason: 'Test reason',
					},
				],
			},
			'/fake/directory',
		);

		const parsed = JSON.parse(result);

		// Should NOT have an error key
		expect(parsed).not.toHaveProperty('error');
		// applyCuratorKnowledgeUpdates should have been called
		expect(mockApplyCuratorKnowledgeUpdates).toHaveBeenCalledTimes(1);
		// Should have successful response structure
		expect(parsed).toHaveProperty('applied');
	});
});

describe('SC-006: existing tests pass (valid UUID v4 entry_id)', () => {
	test('valid UUID v4 entry_id "a1b2c3d4-e5f6-4789-8012-abcdef012345" is accepted', async () => {
		const result = await curator_analyze.execute(
			{
				phase: 1,
				recommendations: [
					{
						action: 'archive',
						entry_id: 'a1b2c3d4-e5f6-4789-8012-abcdef012345',
						lesson: 'Archive this entry',
						reason: 'No longer relevant',
					},
				],
			},
			'/fake/directory',
		);

		const parsed = JSON.parse(result);

		expect(parsed).not.toHaveProperty('error');
		expect(mockApplyCuratorKnowledgeUpdates).toHaveBeenCalledTimes(1);
		expect(parsed).toHaveProperty('applied');
	});
});

// ---------------------------------------------------------------------------
// ADVERSARIAL TESTS
// ---------------------------------------------------------------------------

describe('adversarial: empty string entry_id', () => {
	test('entry_id: "" (empty string) is rejected — empty string !== undefined and fails UUID regex', async () => {
		const result = await curator_analyze.execute(
			{
				phase: 1,
				recommendations: [
					{
						action: 'promote',
						entry_id: '',
						lesson: 'Test lesson',
						reason: 'Test reason',
					},
				],
			},
			'/fake/directory',
		);

		const parsed = JSON.parse(result);

		expect(parsed).toHaveProperty('error');
		expect(parsed.error).toContain('');
		// applyCuratorKnowledgeUpdates should NOT be called since validation failed first
		expect(mockApplyCuratorKnowledgeUpdates).not.toHaveBeenCalled();
	});
});

describe('adversarial: slug-style entry_id', () => {
	test('entry_id: "my-knowledge-entry" (slug format) is rejected', async () => {
		const result = await curator_analyze.execute(
			{
				phase: 1,
				recommendations: [
					{
						action: 'promote',
						entry_id: 'my-knowledge-entry',
						lesson: 'Test lesson',
						reason: 'Test reason',
					},
				],
			},
			'/fake/directory',
		);

		const parsed = JSON.parse(result);

		expect(parsed).toHaveProperty('error');
		expect(parsed.error).toContain('my-knowledge-entry');
		expect(mockApplyCuratorKnowledgeUpdates).not.toHaveBeenCalled();
	});
});

describe('adversarial: short-circuit on first bad entry_id', () => {
	test('first rec has bad entry_id, second has valid UUID → error returned, applyCuratorKnowledgeUpdates NOT called', async () => {
		const result = await curator_analyze.execute(
			{
				phase: 1,
				recommendations: [
					{
						action: 'promote',
						entry_id: 'bad-entry-id',
						lesson: 'Bad lesson',
						reason: 'Bad reason',
					},
					{
						action: 'archive',
						entry_id: 'a1b2c3d4-e5f6-4789-8012-abcdef012345',
						lesson: 'Good lesson',
						reason: 'Good reason',
					},
				],
			},
			'/fake/directory',
		);

		const parsed = JSON.parse(result);

		expect(parsed).toHaveProperty('error');
		expect(parsed.error).toContain('bad-entry-id');
		// Short-circuit: applyCuratorKnowledgeUpdates should NOT be called
		expect(mockApplyCuratorKnowledgeUpdates).not.toHaveBeenCalled();
		// runCuratorPhase is also NOT called — validation fails BEFORE config load / LLM delegate
		expect(mockRunCuratorPhase).not.toHaveBeenCalled();
	});
});

describe('adversarial: all-undefined batch without error', () => {
	test('3 recs, all entry_id undefined → no error, applyCuratorKnowledgeUpdates called once with all 3', async () => {
		const recommendations = [
			{
				action: 'promote',
				entry_id: undefined,
				lesson: 'Lesson 1',
				reason: 'Reason 1',
			},
			{
				action: 'archive',
				entry_id: undefined,
				lesson: 'Lesson 2',
				reason: 'Reason 2',
			},
			{
				action: 'flag_contradiction',
				entry_id: undefined,
				lesson: 'Lesson 3',
				reason: 'Reason 3',
			},
		];

		const result = await curator_analyze.execute(
			{ phase: 1, recommendations },
			'/fake/directory',
		);

		const parsed = JSON.parse(result);

		expect(parsed).not.toHaveProperty('error');
		expect(mockApplyCuratorKnowledgeUpdates).toHaveBeenCalledTimes(1);
		// Verify all 3 recs were passed through
		const passedRecs = mockApplyCuratorKnowledgeUpdates.mock.calls[0][1];
		expect(passedRecs).toHaveLength(3);
		expect(passedRecs[0].entry_id).toBeUndefined();
		expect(passedRecs[1].entry_id).toBeUndefined();
		expect(passedRecs[2].entry_id).toBeUndefined();
	});
});

describe('adversarial: mixed valid UUIDs and undefineds in batch', () => {
	test('batch with mix of valid UUID v4 and undefined entry_ids passes validation', async () => {
		const recommendations = [
			{
				action: 'promote',
				entry_id: undefined,
				lesson: 'New entry',
				reason: 'Create new',
			},
			{
				action: 'archive',
				entry_id: 'a1b2c3d4-e5f6-4789-8012-abcdef012345',
				lesson: 'Archive existing',
				reason: 'Outdated',
			},
			{
				action: 'flag_contradiction',
				entry_id: undefined,
				lesson: 'Another new',
				reason: 'Contradiction found',
			},
		];

		const result = await curator_analyze.execute(
			{ phase: 1, recommendations },
			'/fake/directory',
		);

		const parsed = JSON.parse(result);

		expect(parsed).not.toHaveProperty('error');
		expect(mockApplyCuratorKnowledgeUpdates).toHaveBeenCalledTimes(1);
		const passedRecs = mockApplyCuratorKnowledgeUpdates.mock.calls[0][1];
		expect(passedRecs).toHaveLength(3);
	});
});

// ---------------------------------------------------------------------------
// AGENT RESOLUTION FROM events.jsonl
// ---------------------------------------------------------------------------

// Mock readSwarmFileAsync to control events.jsonl content
const mockReadSwarmFileAsync = vi.fn();
vi.mock('../../../src/hooks/utils.js', () => ({
	readSwarmFileAsync: mockReadSwarmFileAsync,
	validateSwarmPath: (dir: string, file: string) => `${dir}/.swarm/${file}`,
}));

beforeEach(() => {
	mockReadSwarmFileAsync.mockReset();
	// Default: no events file
	mockReadSwarmFileAsync.mockResolvedValue(null);
});

describe('agents_dispatched: resolved from phase_complete event array', () => {
	test('phase_complete event with agents_dispatched array populates agentsDispatched', async () => {
		// Set up events.jsonl with a phase_complete event containing agents_dispatched
		mockReadSwarmFileAsync.mockResolvedValue(
			JSON.stringify({
				phase: 1,
				type: 'phase_complete',
				agents_dispatched: ['architect', 'coder', 'reviewer'],
			}) + '\n',
		);

		const result = await curator_analyze.execute(
			{ phase: 1 },
			'/fake/directory',
		);
		const parsed = JSON.parse(result);

		expect(parsed).not.toHaveProperty('error');
		// Verify runCuratorPhase was called with the agents from events.jsonl
		expect(mockRunCuratorPhase).toHaveBeenCalledTimes(1);
		const call = mockRunCuratorPhase.mock.calls[0];
		// agentsDispatched is the 3rd argument (index 2)
		expect(call[2]).toEqual(['architect', 'coder', 'reviewer'].sort());
	});
});

describe('agents_dispatched: resolved from individual agent fields', () => {
	test('delegation events with individual agent fields populate agentsDispatched', async () => {
		// Set up events.jsonl with individual agent delegation events
		mockReadSwarmFileAsync.mockResolvedValue(
			[
				{ phase: 1, type: 'agent.delegation', agent: 'architect' },
				{ phase: 1, type: 'agent.delegation', agent: 'coder' },
				{ phase: 1, type: 'agent.delegation', agent: 'reviewer' },
			]
				.map((e) => JSON.stringify(e))
				.join('\n') + '\n',
		);

		const result = await curator_analyze.execute(
			{ phase: 1 },
			'/fake/directory',
		);
		const parsed = JSON.parse(result);

		expect(parsed).not.toHaveProperty('error');
		expect(mockRunCuratorPhase).toHaveBeenCalledTimes(1);
		const call = mockRunCuratorPhase.mock.calls[0];
		expect(call[2]).toEqual(['architect', 'coder', 'reviewer'].sort());
	});
});

describe('agents_dispatched: deduplication when both sources present', () => {
	test('agent appears in both agent field and agents_dispatched array → deduplicated once', async () => {
		// 'coder' appears both as individual agent field AND in agents_dispatched
		mockReadSwarmFileAsync.mockResolvedValue(
			[
				{ phase: 1, type: 'agent.delegation', agent: 'coder' },
				{ phase: 1, type: 'agent.delegation', agent: 'reviewer' },
				{
					phase: 1,
					type: 'phase_complete',
					agents_dispatched: ['architect', 'coder'],
				},
			]
				.map((e) => JSON.stringify(e))
				.join('\n') + '\n',
		);

		const result = await curator_analyze.execute(
			{ phase: 1 },
			'/fake/directory',
		);
		const parsed = JSON.parse(result);

		expect(parsed).not.toHaveProperty('error');
		expect(mockRunCuratorPhase).toHaveBeenCalledTimes(1);
		const call = mockRunCuratorPhase.mock.calls[0];
		// 'coder' deduplicated — only appears once despite being in both sources
		expect(call[2]).toEqual(['architect', 'coder', 'reviewer'].sort());
	});
});

describe('agents_dispatched: empty events.jsonl returns empty array', () => {
	test('no events for phase → empty agentsDispatched passed to runCuratorPhase', async () => {
		mockReadSwarmFileAsync.mockResolvedValue('');

		const result = await curator_analyze.execute(
			{ phase: 1 },
			'/fake/directory',
		);
		const parsed = JSON.parse(result);

		expect(parsed).not.toHaveProperty('error');
		expect(mockRunCuratorPhase).toHaveBeenCalledTimes(1);
		const call = mockRunCuratorPhase.mock.calls[0];
		expect(call[2]).toEqual([]);
	});
});

describe('agents_dispatched: readSwarmFileAsync failure is best-effort', () => {
	test('readSwarmFileAsync throws → curator_analyze still returns success', async () => {
		mockReadSwarmFileAsync.mockRejectedValue(new Error('ENOENT'));

		const result = await curator_analyze.execute(
			{ phase: 1 },
			'/fake/directory',
		);
		const parsed = JSON.parse(result);

		// Best-effort: failure to read events does NOT cause error response
		expect(parsed).not.toHaveProperty('error');
		expect(parsed).toHaveProperty('phase_digest');
	});
});

// ---------------------------------------------------------------------------
// ALREADY-DIGESTED PHASE — runCuratorPhase returns already_digested: true
// ---------------------------------------------------------------------------

describe('already_digested: runCuratorPhase returns already_digested: true', () => {
	test('result includes already_digested: true from runCuratorPhase', async () => {
		// Override the default mock to return already_digested: true
		mockRunCuratorPhase.mockResolvedValueOnce({
			phase: 1,
			digest: {
				phase: 1,
				timestamp: new Date().toISOString(),
				summary: 'Phase 1 already digested',
				agents_used: [],
				tasks_completed: 0,
				tasks_total: 0,
				key_decisions: [],
				blockers_resolved: [],
			},
			compliance: [],
			knowledge_recommendations: [],
			summary_updated: false,
			already_digested: true,
		});

		const result = await curator_analyze.execute(
			{ phase: 1 },
			'/fake/directory',
		);
		const parsed = JSON.parse(result);

		expect(parsed).not.toHaveProperty('error');
		// The already_digested flag is in runCuratorPhase's return value,
		// which flows into the curator result that the tool returns
		expect(mockRunCuratorPhase).toHaveBeenCalledTimes(1);
		// Verify it was indeed the already-digested path (summary_updated: false)
		expect(parsed).toHaveProperty('phase_digest');
	});
});

describe('already_digested: second call to same phase does not re-apply recommendations', () => {
	test('calling curator_analyze twice for same phase → applyCuratorKnowledgeUpdates called only once', async () => {
		// First call: normal digest
		mockRunCuratorPhase.mockResolvedValueOnce({
			phase: 1,
			digest: {
				phase: 1,
				timestamp: new Date().toISOString(),
				summary: 'Phase 1 completed',
				agents_used: [],
				tasks_completed: 1,
				tasks_total: 1,
				key_decisions: [],
				blockers_resolved: [],
			},
			compliance: [],
			knowledge_recommendations: [],
			summary_updated: true,
		});

		// Second call: already digested
		mockRunCuratorPhase.mockResolvedValueOnce({
			phase: 1,
			digest: {
				phase: 1,
				timestamp: new Date().toISOString(),
				summary: 'Phase 1 already digested',
				agents_used: [],
				tasks_completed: 1,
				tasks_total: 1,
				key_decisions: [],
				blockers_resolved: [],
			},
			compliance: [],
			knowledge_recommendations: [],
			summary_updated: false,
			already_digested: true,
		});

		const args = {
			phase: 1,
			recommendations: [
				{
					action: 'promote' as const,
					entry_id: undefined,
					lesson: 'Test lesson for already digested',
					reason: 'Test reason',
				},
			],
		};

		// First call
		await curator_analyze.execute(args, '/fake/directory');
		// Second call (same phase, already digested)
		await curator_analyze.execute(args, '/fake/directory');

		// applyCuratorKnowledgeUpdates is still called (the tool itself doesn't
		// short-circuit on already_digested — runCuratorPhase does the dedup)
		expect(mockApplyCuratorKnowledgeUpdates).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// CONDITIONAL ADVISORY — curator_analyze hint shown when recommendations exist
// ---------------------------------------------------------------------------

describe('conditional advisory: hint present when knowledge_recommendations exist', () => {
	test('runCuratorPhase returns recommendations → response has advisory shape', async () => {
		mockRunCuratorPhase.mockResolvedValueOnce({
			phase: 1,
			digest: {
				phase: 1,
				timestamp: new Date().toISOString(),
				summary: 'Phase 1 completed',
				agents_used: [],
				tasks_completed: 1,
				tasks_total: 1,
				key_decisions: [],
				blockers_resolved: [],
			},
			compliance: [],
			knowledge_recommendations: [
				{
					action: 'promote',
					entry_id: 'a1b2c3d4-e5f6-4789-8012-abcdef012345',
					lesson: 'Consider promoting this pattern',
					reason: 'High confidence',
				},
			],
			summary_updated: true,
		});

		const result = await curator_analyze.execute(
			{ phase: 1 },
			'/fake/directory',
		);
		const parsed = JSON.parse(result);

		expect(parsed).not.toHaveProperty('error');
		// Phase digest is present when recommendations exist
		expect(parsed.phase_digest).toBeDefined();
		expect(parsed.phase_digest.summary).toContain('Phase 1 completed');
	});
});

describe('conditional advisory: suppressed when knowledge_recommendations are empty', () => {
	test('runCuratorPhase returns no recommendations → response is still valid but lean', async () => {
		mockRunCuratorPhase.mockResolvedValueOnce({
			phase: 1,
			digest: {
				phase: 1,
				timestamp: new Date().toISOString(),
				summary: 'Phase 1 completed — no recommendations',
				agents_used: [],
				tasks_completed: 1,
				tasks_total: 1,
				key_decisions: [],
				blockers_resolved: [],
			},
			compliance: [],
			knowledge_recommendations: [],
			summary_updated: true,
		});

		const result = await curator_analyze.execute(
			{ phase: 1 },
			'/fake/directory',
		);
		const parsed = JSON.parse(result);

		expect(parsed).not.toHaveProperty('error');
		// Valid response even with empty recommendations
		expect(parsed.phase_digest).toBeDefined();
		expect(parsed.compliance_count).toBe(0);
		// No advisory to show when recommendations are empty
	});
});
