/**
 * Verification tests for src/hooks/knowledge-injector.ts
 *
 * Tests cover:
 * - First-call init (no injection)
 * - Second-call fetch and injection
 * - Cache re-inject (third call)
 * - Phase change invalidates cache
 * - Non-orchestrator agents skipped
 * - Context budget exhaustion
 * - Empty knowledge handling
 * - Tier labels ([HIVE] vs [SWARM])
 * - Star ratings
 * - Rejected pattern warnings
 * - Idempotency
 * - No plan handling
 * - Unknown agent handling
 * - Prompt injection sanitization
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createKnowledgeInjectorHook } from '../../../src/hooks/knowledge-injector.js';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader.js';
import type {
	KnowledgeConfig,
	MessageWithParts,
} from '../../../src/hooks/knowledge-types.js';

// ============================================================================
// Mocks Setup
// ============================================================================

vi.mock('../../../src/hooks/knowledge-reader.js', () => ({
	readContextualKnowledge: vi.fn(async () => []),
	readMergedKnowledge: vi.fn(async () => []),
}));
vi.mock('../../../src/hooks/knowledge-store.js', () => ({
	readRejectedLessons: vi.fn(async () => []),
	enforceKnowledgeCap: async () => {},
	sweepAgedEntries: async () => {},
	sweepStaleTodos: async () => {},
	bumpKnowledgeConfidenceBatch: async () => {},
}));
vi.mock('../../../src/hooks/curator-drift.js', () => ({
	readPriorDriftReports: vi.fn(async () => []),
	buildDriftInjectionText: vi.fn(() => ''),
}));
vi.mock('../../../src/plan/manager.js', () => ({
	loadPlan: vi.fn(async () => null),
	getCurrentTaskId: vi.fn(() => undefined),
	closePlanTerminalState: async () => {},
	_snapshot_test_exports: {},
}));
vi.mock('../../../src/hooks/extractors.js', () => ({
	extractCurrentPhaseFromPlan: vi.fn(() => 'Phase 1: Setup'),
}));
vi.mock('../../../src/config/schema.js', () => ({
	stripKnownSwarmPrefix: vi.fn((name: string) => {
		const prefixes = ['mega_', 'local_', 'paid_'];
		for (const p of prefixes) {
			if (name.startsWith(p)) return name.slice(p.length);
		}
		return name;
	}),
}));
vi.mock('../../../src/services/run-memory.js', () => ({
	getRunMemorySummary: vi.fn(async () => null),
}));
vi.mock('../../../src/hooks/utils.js', () => ({
	readSwarmFileAsync: vi.fn(async () => null),
}));

import { stripKnownSwarmPrefix } from '../../../src/config/schema.js';
import {
	buildDriftInjectionText,
	readPriorDriftReports,
} from '../../../src/hooks/curator-drift.js';
import { extractCurrentPhaseFromPlan } from '../../../src/hooks/extractors.js';
// Import mocked modules
import { readContextualKnowledge } from '../../../src/hooks/knowledge-reader.js';
import { readRejectedLessons } from '../../../src/hooks/knowledge-store.js';
import { readSwarmFileAsync } from '../../../src/hooks/utils.js';
import { loadPlan } from '../../../src/plan/manager.js';
import { getRunMemorySummary } from '../../../src/services/run-memory.js';

// ============================================================================
// Helper Factories
// ============================================================================

function makeOutput(
	agentName: string = 'architect',
	extraChars: number = 0,
): { messages: MessageWithParts[] } {
	return {
		messages: [
			{
				info: { role: 'system', agent: agentName },
				parts: [{ type: 'text', text: 'x'.repeat(extraChars) }],
			},
			{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
		],
	};
}

function makeSwarmEntry(lesson: string, confidence: number = 0.8): RankedEntry {
	return {
		id: 'test-id-' + Math.random().toString(36).substring(2, 9),
		tier: 'swarm',
		lesson,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence,
		status: 'established',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 1,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		relevanceScore: 0.8,
		finalScore: 0.8,
	} as RankedEntry;
}

function makeHiveEntry(lesson: string, confidence: number = 0.8): RankedEntry {
	return {
		id: 'hive-id-' + Math.random().toString(36).substring(2, 9),
		tier: 'hive',
		lesson,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence,
		status: 'established',
		confirmed_by: [
			{
				project_name: 'other-project',
				confirmed_at: new Date().toISOString(),
				phase_number: 1,
			},
		],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 1,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		source_project: 'other-project',
		relevanceScore: 0.8,
		finalScore: 0.8,
	} as RankedEntry;
}

function makeConfig(overrides?: Partial<KnowledgeConfig>): KnowledgeConfig {
	return {
		enabled: true,
		swarm_max_entries: 100,
		hive_max_entries: 200,
		auto_promote_days: 90,
		max_inject_count: 5,
		dedup_threshold: 0.6,
		scope_filter: ['global'],
		hive_enabled: true,
		rejected_max_entries: 20,
		validation_enabled: true,
		evergreen_confidence: 0.9,
		evergreen_utility: 0.8,
		low_utility_threshold: 0.3,
		min_retrievals_for_utility: 3,
		schema_version: 1,
		...overrides,
	};
}

// ============================================================================
// Test Suite: First-call injection (immediate)
// ============================================================================

describe('First-call injection', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
		});
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
	});

	it('Test 1: first invocation with valid orchestrator injects knowledge immediately', async () => {
		const entries = [
			makeSwarmEntry('Use dependency injection for testability', 0.85),
		];
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		await hook({}, output);

		// Should inject knowledge on first call (no initialization skip)
		expect(loadPlan).toHaveBeenCalled();
		expect(readContextualKnowledge).toHaveBeenCalled();
		expect(output.messages.length).toBe(3); // system + knowledge injection + user
		const hasKnowledgeInjection = output.messages.some((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(hasKnowledgeInjection).toBe(true);
	});
});

// ============================================================================
// Test Suite: Cache re-inject (same phase, uses cached text from first call)
// ============================================================================

describe('Cache re-inject', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
		});
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
	});

	it('Test 3: second call same phase reuses cachedInjectionText from first call', async () => {
		// Set up entries BEFORE first call (first call will inject and cache)
		const entries = [
			makeSwarmEntry('Use dependency injection for testability', 0.85),
		];
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// First call - injects and caches
		await hook({}, output);

		// Second call with fresh output - should reuse cache (not re-read)
		const output2 = makeOutput('architect');
		await hook({}, output2);

		// readContextualKnowledge was called on first call only
		expect(readContextualKnowledge).toHaveBeenCalledTimes(1);
		const hasKnowledgeInjection = output2.messages.some((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(hasKnowledgeInjection).toBe(true);
	});
});

// ============================================================================
// Test Suite: Second-call fetch and injection
// ============================================================================

describe('Second-call fetch and injection', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
		});
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
	});

	it('Test 2: second call same phase triggers full knowledge fetch and injects', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// First call - init only
		await hook({}, output);

		// Set up knowledge entries for second call
		const entries = [
			makeSwarmEntry('Use dependency injection for testability', 0.85),
		];
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		// Second call - should inject
		await hook({}, output);

		expect(readContextualKnowledge).toHaveBeenCalled();
		const hasKnowledgeInjection = output.messages.some((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(hasKnowledgeInjection).toBe(true);
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg?.parts[0].text).toContain(
			'Use dependency injection for testability',
		);
	});
});

// ============================================================================
// Test Suite: Cache re-inject
// ============================================================================

describe('Cache re-inject', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
		});
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
	});

	it('Test 3: third call same phase reuses cachedInjectionText, does not call readContextualKnowledge again', async () => {
		// Set up entries BEFORE first call (first call injects and caches)
		const entries = [makeSwarmEntry('Cached lesson for re-inject', 0.85)];
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// First call - injects and caches
		await hook({}, output);

		// Second call with fresh output - should use cache
		const output2 = makeOutput('architect');
		await hook({}, output2);

		// Third call with fresh output - should also use cache
		const output3 = makeOutput('architect');
		await hook({}, output3);

		expect(readContextualKnowledge).toHaveBeenCalledTimes(1); // called once on first call only
		const knowledgeMsg = output3.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg?.parts[0].text).toContain(
			'Cached lesson for re-inject',
		);
	});
});

// ============================================================================
// Test Suite: Phase change
// ============================================================================

describe('Phase change', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
		});
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
	});

	it('Test 4: when plan.current_phase changes, cache is invalidated and knowledge is re-fetched', async () => {
		// First, simulate phase 1 - call hook twice (init + inject)
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// First call - init (phase 1)
		await hook({}, output);

		// Second call - fetches and caches (phase 1)
		const entries1 = [makeSwarmEntry('Phase 1 lesson', 0.85)];
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries1,
		);
		await hook({}, output);

		// Verify phase 1 content injected
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg?.parts[0].text).toContain('Phase 1 lesson');

		// Now simulate phase change - create NEW hook instance
		// (the hook instance maintains internal state, so we need a fresh one or simulate fresh start)
		// But actually, we can test this by loading a different plan

		// Simulate phase change in the mock
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
		});
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 2: Implementation',
		);
		const entries2 = [makeSwarmEntry('Phase 2 lesson', 0.9)];
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries2,
		);

		// The cached state is in the hook closure - we need to reset it
		// We can't directly reset the hook's internal state, but we can create a new hook
		// However, for this test, let's verify the cache invalidation works by checking
		// that readContextualKnowledge gets called with the new phase info

		// Create a fresh hook to simulate new architect call after phase change
		const hook2 = createKnowledgeInjectorHook('/proj', makeConfig());
		const output2 = makeOutput('architect');

		// First call with new hook - init (phase 2)
		await hook2({}, output2);

		// Second call - should fetch fresh (phase 2)
		await hook2({}, output2);

		// Should have fetched knowledge for phase 2
		expect(readContextualKnowledge).toHaveBeenCalled();

		// Check content
		const knowledgeMessages = output2.messages.filter((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMessages.length).toBe(1);
		expect(knowledgeMessages[0].parts[0].text).toContain('Phase 2 lesson');
	});
});

// ============================================================================
// Test Suite: Non-orchestrator agents skipped
// ============================================================================

describe('Non-orchestrator agents skipped', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
		});
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([
			makeSwarmEntry('Some lesson', 0.85),
		]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
	});

	it('Test 5: agent named coder receives no injection', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('coder');

		// First call - init
		await hook({}, output);
		// Second call - should skip
		await hook({}, output);

		const hasKnowledgeInjection = output.messages.some((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(hasKnowledgeInjection).toBe(false);
	});

	it('Test 6: designer agent skipped', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('designer');

		await hook({}, output);
		await hook({}, output);

		const hasKnowledgeInjection = output.messages.some((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(hasKnowledgeInjection).toBe(false);
	});

	it('Test 6: security_reviewer agent skipped', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('security_reviewer');

		await hook({}, output);
		await hook({}, output);

		const hasKnowledgeInjection = output.messages.some((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(hasKnowledgeInjection).toBe(false);
	});

	it('Test 6: test_engineer agent skipped', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('test_engineer');

		await hook({}, output);
		await hook({}, output);

		const hasKnowledgeInjection = output.messages.some((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(hasKnowledgeInjection).toBe(false);
	});

	it('Test 6: explorer agent skipped', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('explorer');

		await hook({}, output);
		await hook({}, output);

		const hasKnowledgeInjection = output.messages.some((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(hasKnowledgeInjection).toBe(false);
	});
});

// ============================================================================
// Test Suite: Context budget exhaustion
// ============================================================================

describe('Context budget exhaustion', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
		});
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([
			makeSwarmEntry('Some lesson', 0.85),
		]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
	});

	it('Test 7: when headroom < 300 chars, no injection', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		// MODEL_LIMIT_CHARS ≈ 387,878. Need existingChars > 387,878 - 300 = ~387,578
		const skipThreshold = Math.floor(128_000 / 0.33) - 200; // leaves ~200 chars headroom (<300)
		const output = makeOutput('architect', skipThreshold);

		await hook({}, output);

		const hasKnowledgeInjection = output.messages.some((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(hasKnowledgeInjection).toBe(false);
	});

	it('Test 7b: at 181k chars (old skip threshold), injection proceeds in moderate regime', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect', 181_000);

		await hook({}, output);

		// 181k chars leaves ~206k headroom — should inject (was skipped before this fix)
		const hasKnowledgeInjection = output.messages.some((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(hasKnowledgeInjection).toBe(true);
	});

	it('Test 7c: at 370k chars, injection proceeds in low regime', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect', 370_000);

		await hook({}, output);

		// 370k chars leaves ~17k headroom — should still inject in low regime
		const hasKnowledgeInjection = output.messages.some((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(hasKnowledgeInjection).toBe(true);
	});
});

// ============================================================================
// Test Suite: Empty knowledge
// ============================================================================

describe('Empty knowledge', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
		});
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
	});

	it('Test 8: when readContextualKnowledge returns [], no injection block added', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// First call - init
		await hook({}, output);
		// Second call - returns empty
		await hook({}, output);

		const hasKnowledgeInjection = output.messages.some((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(hasKnowledgeInjection).toBe(false);
		expect(output.messages.length).toBe(2); // Only original messages
	});
});

// ============================================================================
// Test Suite: Tier labels
// ============================================================================

describe('Tier labels', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
		});
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
	});

	it('Test 9: hive entry gets [HIVE] label, swarm gets [SWARM]', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// First call - init
		await hook({}, output);

		// Set up entries with both tiers
		const entries = [
			makeSwarmEntry('Swarm lesson', 0.8),
			makeHiveEntry('Hive lesson', 0.8),
		];
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		// Second call - inject
		await hook({}, output);

		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		const text = knowledgeMsg?.parts[0].text ?? '';
		// Compact format: [S] for swarm, [H] for hive
		expect(text).toContain('[S]');
		expect(text).toContain('[H]');
		expect(text).toContain('Swarm lesson');
		expect(text).toContain('Hive lesson');
	});
});

// ============================================================================
// Test Suite: Explicit [tier:status] prefixes
// ============================================================================

describe('Explicit [tier:status] prefixes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
		});
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
	});

	it('Test 9a: swarm entry with established status shows [swarm:established] prefix', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Set up entries before call (first call now injects immediately)
		const entries = [makeSwarmEntry('Always validate function inputs', 0.85)];
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		// Single call - injects immediately
		await hook({}, output);

		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		const text = knowledgeMsg?.parts[0].text ?? '';
		// Compact format: [S] for swarm
		expect(text).toContain('[S]');
		// Verify lesson content is preserved
		expect(text).toContain('Always validate function inputs');
	});

	it('Test 9b: hive entry with established status shows [H] prefix', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Set up entries before call (first call now injects immediately)
		const entries = [
			makeHiveEntry('Use dependency injection for testability', 0.9),
		];
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		// Single call - injects immediately
		await hook({}, output);

		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		const text = knowledgeMsg?.parts[0].text ?? '';
		// Compact format: [H] for hive
		expect(text).toContain('[H]');
		// Verify lesson content is preserved
		expect(text).toContain('Use dependency injection for testability');
	});

	it('Test 9c: entry with experimental status shows [tier:experimental] prefix', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Set up entries before call (first call now injects immediately)
		const entries = [
			{
				...makeSwarmEntry('New experimental pattern', 0.85),
				status: 'experimental',
			},
		];
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries as RankedEntry[],
		);

		// Single call - injects immediately
		await hook({}, output);

		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		const text = knowledgeMsg?.parts[0].text ?? '';
		// Compact format: [S] for swarm (status no longer shown)
		expect(text).toContain('[S]');
		// Verify lesson content is preserved
		expect(text).toContain('New experimental pattern');
	});

	it('Test 9d: multiple entries each show correct [tier:status] prefix', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Set up entries before call (first call now injects immediately)
		const entries = [
			{
				...makeSwarmEntry('Swarm established lesson', 0.85),
				status: 'established',
			},
			{
				...makeSwarmEntry('Swarm experimental lesson', 0.85),
				status: 'experimental',
			},
			{
				...makeHiveEntry('Hive established lesson', 0.9),
				status: 'established',
			},
			{
				...makeHiveEntry('Hive experimental lesson', 0.85),
				status: 'experimental',
			},
		];
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries as RankedEntry[],
		);

		// Single call - injects immediately
		await hook({}, output);

		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		const text = knowledgeMsg?.parts[0].text ?? '';
		// Compact format: [S] for swarm, [H] for hive (status no longer shown)
		expect(text).toContain('[S]');
		expect(text).toContain('[H]');
		// Verify all lesson content is preserved
		expect(text).toContain('Swarm established lesson');
		expect(text).toContain('Swarm experimental lesson');
		expect(text).toContain('Hive established lesson');
		expect(text).toContain('Hive experimental lesson');
	});

	it('Test 9e: tier:status prefix appears before lesson content on same line', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Set up entries before call (first call now injects immediately)
		const entries = [makeSwarmEntry('Test lesson content', 0.8)];
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		// Single call - injects immediately
		await hook({}, output);

		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		const text = knowledgeMsg?.parts[0].text ?? '';
		// Find the line containing the lesson
		const lines = text.split('\n');
		const lessonLine = lines.find((line) =>
			line.includes('Test lesson content'),
		);
		expect(lessonLine).toBeDefined();
		// Verify the tier prefix appears before the lesson text on same line
		const prefixEndIndex = lessonLine!.indexOf(']');
		const lessonStartIndex = lessonLine!.indexOf('Test lesson content');
		expect(prefixEndIndex).toBeLessThan(lessonStartIndex);
		// Verify compact format: [S] + space + lesson (no stars, no status)
		expect(lessonLine).toMatch(/^\[S\] Test lesson content/);
	});
});

// ============================================================================
// Test Suite: Star ratings
// ============================================================================

describe('Compact format and confirmation indicators', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
		});
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
	});

	it('Test 10: no star ratings in compact format', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		const entries = [makeSwarmEntry('High confidence lesson', 0.95)];
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		await hook({}, output);

		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		const text = knowledgeMsg?.parts[0].text ?? '';
		expect(text).not.toContain('★');
		expect(text).toContain('[S]');
	});

	it('Test 10b: confirmed_by.length >= 3 shows ✓✓', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		const entry = makeSwarmEntry('Well confirmed lesson', 0.85);
		entry.confirmed_by = [
			{
				project_name: 'p1',
				confirmed_at: new Date().toISOString(),
				phase_number: 1,
			},
			{
				project_name: 'p2',
				confirmed_at: new Date().toISOString(),
				phase_number: 2,
			},
			{
				project_name: 'p3',
				confirmed_at: new Date().toISOString(),
				phase_number: 3,
			},
		];
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([
			entry,
		]);

		await hook({}, output);

		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		const text = knowledgeMsg?.parts[0].text ?? '';
		expect(text).toContain('\u2713\u2713');
	});

	it('Test 10c: confirmed_by.length = 1 shows single ✓', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		const entry = makeSwarmEntry('Once confirmed lesson', 0.85);
		entry.confirmed_by = [
			{
				project_name: 'p1',
				confirmed_at: new Date().toISOString(),
				phase_number: 1,
			},
		];
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([
			entry,
		]);

		await hook({}, output);

		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		const text = knowledgeMsg?.parts[0].text ?? '';
		const lines = text.split('\n');
		const lessonLine = lines.find((l) => l.includes('Once confirmed lesson'));
		expect(lessonLine).toBeDefined();
		// Single check but not double check
		expect(lessonLine).toContain('\u2713');
		expect(lessonLine).not.toContain('\u2713\u2713');
	});

	it('Test 10d: confirmed_by.length = 0 shows no confirmation indicator', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		const entry = makeSwarmEntry('Unconfirmed lesson', 0.85);
		entry.confirmed_by = [];
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([
			entry,
		]);

		await hook({}, output);

		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		const text = knowledgeMsg?.parts[0].text ?? '';
		const lines = text.split('\n');
		const lessonLine = lines.find((l) => l.includes('Unconfirmed lesson'));
		expect(lessonLine).toBeDefined();
		expect(lessonLine).not.toContain('\u2713');
	});

	it('Test 10e: lesson > max_lesson_display_chars truncated with …', async () => {
		const hook = createKnowledgeInjectorHook(
			'/proj',
			makeConfig({ max_lesson_display_chars: 120 }),
		);
		const output = makeOutput('architect');

		const longLesson = 'A'.repeat(280);
		const entry = makeSwarmEntry(longLesson, 0.85);
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([
			entry,
		]);

		await hook({}, output);

		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		const text = knowledgeMsg?.parts[0].text ?? '';
		const lines = text.split('\n');
		const lessonLine = lines.find((l) => l.includes('[S]'));
		expect(lessonLine).toBeDefined();
		// Should be truncated — original 280 chars should not appear in full
		expect(lessonLine!.length).toBeLessThan(200);
		expect(lessonLine).toContain('\u2026'); // ellipsis
	});
});

// ============================================================================
// Test Suite: Rejected pattern warnings
// ============================================================================

describe('Rejected pattern warnings', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
		});
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([
			makeSwarmEntry('Some lesson', 0.85),
		]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
	});

	it('Test 11: when readRejectedLessons returns items, they appear as ⚠️ REJECTED PATTERN: lines', async () => {
		const rejectedLessons = [
			{
				id: 'r1',
				lesson: 'Rejected lesson 1',
				rejection_reason: 'Outdated approach',
				rejected_at: new Date().toISOString(),
				rejection_layer: 1 as const,
			},
			{
				id: 'r2',
				lesson: 'Rejected lesson 2',
				rejection_reason: 'Security issue',
				rejected_at: new Date().toISOString(),
				rejection_layer: 2 as const,
			},
			{
				id: 'r3',
				lesson: 'Rejected lesson 3',
				rejection_reason: 'Not applicable',
				rejected_at: new Date().toISOString(),
				rejection_layer: 1 as const,
			},
		];
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue(
			rejectedLessons,
		);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		await hook({}, output);
		await hook({}, output);

		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		const text = knowledgeMsg?.parts[0].text ?? '';
		expect(text).toContain('⚠️ REJECTED PATTERN:');
	});

	it('Test 11: only last 3 rejected patterns shown', async () => {
		const rejectedLessons = [
			{
				id: 'r1',
				lesson: 'Old rejected 1',
				rejection_reason: 'Reason 1',
				rejected_at: new Date().toISOString(),
				rejection_layer: 1 as const,
			},
			{
				id: 'r2',
				lesson: 'Old rejected 2',
				rejection_reason: 'Reason 2',
				rejected_at: new Date().toISOString(),
				rejection_layer: 1 as const,
			},
			{
				id: 'r3',
				lesson: 'Old rejected 3',
				rejection_reason: 'Reason 3',
				rejected_at: new Date().toISOString(),
				rejection_layer: 1 as const,
			},
			{
				id: 'r4',
				lesson: 'Recent rejected 1',
				rejection_reason: 'Reason 4',
				rejected_at: new Date().toISOString(),
				rejection_layer: 1 as const,
			},
			{
				id: 'r5',
				lesson: 'Recent rejected 2',
				rejection_reason: 'Reason 5',
				rejected_at: new Date().toISOString(),
				rejection_layer: 1 as const,
			},
		];
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue(
			rejectedLessons,
		);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		await hook({}, output);
		await hook({}, output);

		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		const text = knowledgeMsg?.parts[0].text ?? '';
		// Should contain last 3 (indices 2, 3, 4)
		expect(text).toContain('Recent rejected 1');
		expect(text).toContain('Recent rejected 2');
		// Should NOT contain old ones
		expect(text).not.toContain('Old rejected 1');
	});
});

// ============================================================================
// Test Suite: Idempotency
// ============================================================================

describe('Idempotency', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
		});
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([
			makeSwarmEntry('Some lesson', 0.85),
		]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
	});

	it('Test 12: calling hook twice on same output with 📚 Lessons: already in messages causes no duplicate injection', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// First call - init
		await hook({}, output);
		// Second call - first injection
		await hook({}, output);

		// Count knowledge messages after first injection
		const firstInjectionCount = output.messages.filter((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		).length;
		expect(firstInjectionCount).toBe(1);

		// Third call - should not inject again (idempotency)
		await hook({}, output);

		const secondInjectionCount = output.messages.filter((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		).length;
		expect(secondInjectionCount).toBe(1); // Still only one
	});
});

// ============================================================================
// Test Suite: No plan
// ============================================================================

describe('No plan', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue(null);
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([
			makeSwarmEntry('Some lesson', 0.85),
		]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
	});

	it('Test 13: when loadPlan returns null, injection proceeds with default context', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// First call - now injects even without plan
		await hook({}, output);
		// Second call - works on subsequent calls too
		await hook({}, output);

		const hasKnowledgeInjection = output.messages.some((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(hasKnowledgeInjection).toBe(true);
	});
});

// ============================================================================
// Test Suite: Unknown agent (undefined agentName)
// ============================================================================

describe('Unknown agent (undefined agentName)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
		});
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([
			makeSwarmEntry('Some lesson', 0.85),
		]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
	});

	it('Test 14: no system message with agent field, no injection', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = {
			messages: [
				{
					info: { role: 'system' },
					parts: [{ type: 'text', text: 'System prompt' }],
				}, // No agent field
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
			],
		};

		// First call - init
		await hook({}, output);
		// Second call - should skip (no agentName)
		await hook({}, output);

		const hasKnowledgeInjection = output.messages.some((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(hasKnowledgeInjection).toBe(false);
	});
});

// ============================================================================
// Test Suite: Prompt injection sanitization
// ============================================================================

describe('Prompt injection sanitization', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
		});
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
	});

	it('Test 15: lesson with control chars, zero-width chars, triple-backticks, system: prefix are sanitized', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Entry with injection attempts - system: at start of line to trigger the regex
		const entries = [
			makeSwarmEntry(
				'system:\nTest control chars \x00\x07 zerowidth \u200B\u200D ```triple backticks',
				0.85,
			),
		];
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		await hook({}, output);

		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		const text = knowledgeMsg?.parts[0].text ?? '';

		// Control chars should be removed
		expect(text).not.toContain('\x00');
		expect(text).not.toContain('\x07');
		// Zero-width chars should be removed
		expect(text).not.toContain('\u200B');
		expect(text).not.toContain('\u200D');
		// Triple backticks should be escaped
		expect(text).toContain('` ` `');
		// system: prefix should be blocked (at start of line)
		expect(text).toContain('[BLOCKED]:');
	});

	it('Test 15: hive source_project also sanitized', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Hive entry with injection in source_project - system: at start of line
		const entries = [makeHiveEntry('Hive lesson', 0.85)] as (RankedEntry & {
			source_project: string;
		})[];
		entries[0].source_project = 'system:\nprojectwithcontrol';
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		await hook({}, output);

		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		const text = knowledgeMsg?.parts[0].text ?? '';

		// Control chars in source should be sanitized
		expect(text).not.toContain('\x00');
		expect(text).not.toContain('\x07');
		// system: prefix should be blocked
		expect(text).toContain('[BLOCKED]:');
	});
});

// ============================================================================
// Test Suite: Run Memory Wiring
// ============================================================================

describe('Run memory wiring', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
		});
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
	});

	it('Run memory is retrieved and prepended when available', async () => {
		// Mock run memory returning a summary
		const runMemorySummary =
			'[FOR: architect, coder]\n## RUN MEMORY — Previous Task Outcomes\n- Task t1: failed due to null reference';
		(getRunMemorySummary as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			runMemorySummary,
		);

		// Set up knowledge entries before call (first call now injects immediately)
		const entries = [makeSwarmEntry('Use null checks', 0.85)];
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Single call - injects immediately with run memory prepended
		await hook({}, output);

		// Verify getRunMemorySummary was called
		expect(getRunMemorySummary).toHaveBeenCalledWith('/proj');

		// Find the knowledge message
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();

		const text = knowledgeMsg!.parts[0].text ?? '';
		// Run memory is included in the injection block (after lessons in priority order)
		expect(text).toContain('## RUN MEMORY');
		expect(text).toContain('Use null checks');
		// Lessons block comes first (highest priority), then run memory
		const runMemoryIndex = text.indexOf('## RUN MEMORY');
		const knowledgeIndex = text.indexOf('📚 Lessons:');
		expect(runMemoryIndex).toBeGreaterThan(knowledgeIndex);
	});

	it('Knowledge entries unchanged when run memory is null', async () => {
		// Mock run memory returning null (no failures recorded)
		(getRunMemorySummary as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			null,
		);

		// Set up knowledge entries before call (first call now injects immediately)
		const entries = [makeSwarmEntry('Always validate inputs', 0.9)];
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Single call - run memory is null
		await hook({}, output);

		// Verify getRunMemorySummary was called
		expect(getRunMemorySummary).toHaveBeenCalledWith('/proj');

		// Find the knowledge message
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();

		const text = knowledgeMsg!.parts[0].text;
		// Should contain the knowledge entry
		expect(text).toContain('Always validate inputs');
		// Should NOT contain run memory section
		expect(text).not.toContain('## RUN MEMORY');
		// The knowledge section should start with the 📚 emoji
		expect(text).toMatch(/^.*📚 Lessons:/);
	});

	it('[FOR: architect, coder] tag present in output when run memory is available', async () => {
		// Mock run memory returning a summary with the tag
		const runMemorySummary =
			'[FOR: architect, coder]\n## RUN MEMORY — Previous Task Outcomes\n- Task t1: failed';
		(getRunMemorySummary as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			runMemorySummary,
		);

		// Set up knowledge entries before call (first call now injects immediately)
		const entries = [makeSwarmEntry('Test lesson', 0.8)];
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Single call
		await hook({}, output);

		// Find the knowledge message
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();

		const text = knowledgeMsg!.parts[0].text;
		// Verify the [FOR: architect, coder] tag is present in output
		expect(text).toContain('[FOR: architect, coder]');
	});
});

/**
 * Task 5.3: Drift injection fix verification
 *
 * Phase 4.3 fix: Drift injection now works when cachedInjectionText is null
 * (no knowledge entries but drift report exists) — the drift text should be injected.
 *
 * The bug was that drift injection happened AFTER the entries.length === 0 check,
 * so drift was never injected when there were no knowledge entries. The fix moves
 * drift injection BEFORE the entries.length === 0 check.
 */
describe('Task 5.3: Drift injection when cachedInjectionText is null (no knowledge entries)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
		});
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
		(getRunMemorySummary as ReturnType<typeof vi.fn>).mockResolvedValue(null);
	});

	it('Drift report injection works when cachedInjectionText is null (no knowledge entries but drift exists)', async () => {
		// Set up drift report mock to return a valid report
		(readPriorDriftReports as ReturnType<typeof vi.fn>).mockResolvedValue([
			{
				phase: 1,
				alignment: 'MINOR_DRIFT',
				drift_score: 0.3,
				injection_summary: 'Phase 1: minor drift detected',
				first_deviation: {
					phase: 1,
					task: 'task1',
					description: 'Missing test coverage',
				},
				corrections: ['Add more tests'],
			},
		]);
		(buildDriftInjectionText as ReturnType<typeof vi.fn>).mockReturnValue(
			'<drift_report>Phase 1: MINOR_DRIFT (0.30) — Missing test coverage. Add more tests.</drift_report>',
		);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// First call - init
		await hook({}, output);

		// Second call - should inject drift even though entries is empty
		await hook({}, output);

		// Verify readPriorDriftReports was called
		expect(readPriorDriftReports).toHaveBeenCalledWith('/proj');

		// Verify buildDriftInjectionText was called
		expect(buildDriftInjectionText).toHaveBeenCalled();

		// Find the message with drift injection
		const hasDriftInjection = output.messages.some((m) =>
			m.parts?.some((p) => p.text?.includes('<drift_report>')),
		);
		expect(hasDriftInjection).toBe(true);
	});

	it('Drift report is NOT injected when readPriorDriftReports returns empty array', async () => {
		// Set up drift report mock to return empty
		(readPriorDriftReports as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(buildDriftInjectionText as ReturnType<typeof vi.fn>).mockReturnValue('');

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// First call - init
		await hook({}, output);

		// Second call - no drift should be injected
		await hook({}, output);

		// Verify readPriorDriftReports was called
		expect(readPriorDriftReports).toHaveBeenCalledWith('/proj');

		// No drift injection should appear
		const hasDriftInjection = output.messages.some((m) =>
			m.parts?.some((p) => p.text?.includes('<drift_report>')),
		);
		expect(hasDriftInjection).toBe(false);
	});

	it('Drift report injection works when cachedInjectionText is non-null (normal case — drift prepended to knowledge)', async () => {
		// Set up drift report mock to return a valid report
		(readPriorDriftReports as ReturnType<typeof vi.fn>).mockResolvedValue([
			{
				phase: 1,
				alignment: 'MINOR_DRIFT',
				drift_score: 0.3,
				injection_summary: 'Phase 1: minor drift detected',
				first_deviation: {
					phase: 1,
					task: 'task1',
					description: 'Missing test coverage',
				},
				corrections: ['Add more tests'],
			},
		]);
		(buildDriftInjectionText as ReturnType<typeof vi.fn>).mockReturnValue(
			'<drift_report>Phase 1: MINOR_DRIFT (0.30) — Missing test coverage. Add more tests.</drift_report>',
		);

		// Also set up knowledge entries (normal case with both drift and knowledge)
		const entries = [makeSwarmEntry('Knowledge lesson about testing', 0.85)];
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// First call - init
		await hook({}, output);

		// Second call - should inject both drift AND knowledge
		await hook({}, output);

		// Find the knowledge message
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();

		const text = knowledgeMsg!.parts[0].text ?? '';

		// Drift appears AFTER the knowledge section in new priority order (lessons > run memory > drift)
		const driftIndex = text.indexOf('<drift_report>');
		const knowledgeIndex = text.indexOf('📚 Lessons:');

		expect(driftIndex).toBeGreaterThanOrEqual(0);
		expect(knowledgeIndex).toBeGreaterThanOrEqual(0);
		expect(driftIndex).toBeGreaterThan(knowledgeIndex);

		// Knowledge content should still be present
		expect(text).toContain('Knowledge lesson about testing');
	});
});

// ============================================================================
// Test Suite: Drift-only injection idempotency
// ============================================================================

/**
 * Bug fix verification: drift-only injection is idempotent
 *
 * When there are no knowledge entries but a drift report exists,
 * calling the hook twice should only inject drift ONCE.
 *
 * The idempotency guard in injectKnowledgeMessage checks for the
 * <drift_report> marker and skips injection if already present.
 */
describe('Drift-only injection idempotency', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
		});
		(readContextualKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]); // No knowledge entries
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
		(getRunMemorySummary as ReturnType<typeof vi.fn>).mockResolvedValue(null);
		(readSwarmFileAsync as ReturnType<typeof vi.fn>).mockResolvedValue(null); // No briefing
	});

	it('Calling hook twice with drift-only injection results in only ONE drift message', async () => {
		// Set up drift report mock to return a valid report
		(readPriorDriftReports as ReturnType<typeof vi.fn>).mockResolvedValue([
			{
				phase: 1,
				alignment: 'MINOR_DRIFT',
				drift_score: 0.3,
				injection_summary: 'Phase 1: minor drift detected',
				first_deviation: {
					phase: 1,
					task: 'task1',
					description: 'Missing test coverage',
				},
				corrections: ['Add more tests'],
			},
		]);
		(buildDriftInjectionText as ReturnType<typeof vi.fn>).mockReturnValue(
			'<drift_report>Phase 1: MINOR_DRIFT (0.30) — Missing test coverage. Add more tests.</drift_report>',
		);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// First call - init (no injection, sets lastSeenPhase)
		await hook({}, output);

		// Second call - should inject drift (entries is empty, but drift exists)
		await hook({}, output);

		// Count messages with drift content
		const driftMessages = output.messages.filter((m) =>
			m.parts?.some((p) => p.text?.includes('<drift_report>')),
		);

		// Should have exactly ONE drift message
		expect(driftMessages.length).toBe(1);

		// The drift content should be present
		const driftMsg = driftMessages[0];
		expect(driftMsg.parts[0].text).toContain('MINOR_DRIFT');
		expect(driftMsg.parts[0].text).toContain('Missing test coverage');
	});

	it('Third call re-uses cached injection and idempotency guard prevents duplicate', async () => {
		// Set up drift report mock to return a valid report
		(readPriorDriftReports as ReturnType<typeof vi.fn>).mockResolvedValue([
			{
				phase: 1,
				alignment: 'MINOR_DRIFT',
				drift_score: 0.3,
				injection_summary: 'Phase 1: minor drift detected',
				first_deviation: {
					phase: 1,
					task: 'task1',
					description: 'Missing test coverage',
				},
				corrections: ['Add more tests'],
			},
		]);
		(buildDriftInjectionText as ReturnType<typeof vi.fn>).mockReturnValue(
			'<drift_report>Phase 1: MINOR_DRIFT (0.30) — Missing test coverage. Add more tests.</drift_report>',
		);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// First call - init
		await hook({}, output);

		// Second call - injects drift
		await hook({}, output);

		// Third call - re-uses cache, idempotency guard should prevent duplicate
		await hook({}, output);

		// Count messages with drift content
		const driftMessages = output.messages.filter((m) =>
			m.parts?.some((p) => p.text?.includes('<drift_report>')),
		);

		// Should still have exactly ONE drift message (not two)
		expect(driftMessages.length).toBe(1);
	});

	it('calling hook twice with drift-only content injects only once', async () => {
		// Codex Bug 2 fix verification: Drift-only injection is idempotent.
		// The idempotency guard checks for <drift_report> in addition to 📚 Lessons:.
		// On the third call, injectKnowledgeMessage checks for <drift_report> in existing messages,
		// finds it, and skips injection.

		// Set up drift report mock to return a valid report
		(readPriorDriftReports as ReturnType<typeof vi.fn>).mockResolvedValue([
			{
				phase: 1,
				alignment: 'MINOR_DRIFT',
				drift_score: 0.3,
				first_deviation: { description: 'test drift' },
				corrections: [],
			},
		]);
		(buildDriftInjectionText as ReturnType<typeof vi.fn>).mockReturnValue(
			'<drift_report>Phase 1: MINOR_DRIFT (0.30) — test drift</drift_report>',
		);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = {
			messages: [
				{
					info: { role: 'system', agent: 'architect' },
					parts: [{ type: 'text', text: 'system prompt' }],
				},
			],
		};

		// Call 1: INIT - lastSeenPhase null → sets phase, returns
		await hook({}, output);

		// Call 2: INJECT - drift sets cachedInjectionText, entries empty → inject drift
		await hook({}, output);

		// Call 3: RE-INJECT - cache hit → calls injectKnowledgeMessage again
		// But idempotency guard finds <drift_report> already in messages, skips
		await hook({}, output);

		// Count messages containing <drift_report>
		const driftMessageCount = output.messages.filter((m) =>
			m.parts?.some((p) => p.text?.includes('<drift_report>')),
		).length;

		// MUST be exactly 1 - the idempotency guard prevented duplicate drift injection
		expect(driftMessageCount).toBe(1);
	});
});
