/**
 * Tests for agent-scoped knowledge injection in src/hooks/knowledge-injector.ts.
 *
 * History: the original code used a denylist that leaked the architect's
 * knowledge block into non-architect agents. That was replaced by an explicit
 * architect allowlist.
 *
 * REALIGNED for Swarm Learning System / Change 1 (Task 1.1): the injector is no
 * longer architect-only. There are now TWO injection paths:
 *   - architect → the orchestrator block (📚 Lessons / <swarm_knowledge_directives>)
 *   - delegated subagents (coder, reviewer, test_engineer, sme, docs, designer,
 *     critic, curator) → the <delegate_knowledge_directives> block
 * All OTHER agents (critic_sounding_board, critic_drift_verifier, unknown,
 * empty) still receive nothing.
 *
 * The architect must NOT receive a delegate block, and delegates must NOT
 * receive the orchestrator block — the two paths are mutually exclusive.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createKnowledgeInjectorHook } from '../../../src/hooks/knowledge-injector.js';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader.js';
import type {
	KnowledgeConfig,
	MessageWithParts,
} from '../../../src/hooks/knowledge-types.js';

// ============================================================================
// Mocks
// ============================================================================

// mock-prefixed control handle for the retrieval call; the searchKnowledge
// mock delegates to it so per-test mockResolvedValue setups keep working.
const mockRetrieve = vi.fn(async (): Promise<unknown[]> => []);

vi.mock('../../../src/hooks/knowledge-reader.js', () => ({
	readMergedKnowledge: vi.fn(async () => []),
	scoreDirectiveAgainstContext: vi.fn(() => ({
		triggerHit: false,
		actionHit: false,
		agentHit: false,
		score: 0,
	})),
}));
vi.mock('../../../src/hooks/search-knowledge.js', () => ({
	searchKnowledge: vi.fn(
		async (params: {
			directory?: string;
			config?: unknown;
			context?: unknown;
		}) => ({
			trace_id: 'trace-test',
			results:
				(await mockRetrieve(
					params?.directory,
					params?.config,
					params?.context,
				)) ?? [],
		}),
	),
}));
vi.mock('../../../src/hooks/knowledge-store.js', () => ({
	readRejectedLessons: vi.fn(async () => []),
	enforceKnowledgeCap: async () => {},
	sweepAgedEntries: async () => {},
	sweepStaleTodos: async () => {},
	bumpKnowledgeConfidenceBatch: async () => {},
}));
vi.mock('../../../src/plan/manager.js', () => ({
	loadPlan: vi.fn(async () => ({
		current_phase: 1,
		title: 'Test Project',
		phases: [{ id: 1, name: 'Setup', tasks: [] }],
	})),
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
vi.mock('../../../src/hooks/curator-drift.js', () => ({
	readPriorDriftReports: vi.fn(async () => []),
	buildDriftInjectionText: vi.fn(() => ''),
}));
vi.mock('../../../src/services/run-memory.js', () => ({
	getRunMemorySummary: vi.fn(async () => null),
}));
vi.mock('../../../src/hooks/utils.js', () => ({
	readSwarmFileAsync: vi.fn(async () => null),
	safeHook: vi.fn((fn: (...args: unknown[]) => unknown) => fn),
}));

import { extractCurrentPhaseFromPlan } from '../../../src/hooks/extractors.js';
import { readRejectedLessons } from '../../../src/hooks/knowledge-store.js';
import { loadPlan } from '../../../src/plan/manager.js';

// ============================================================================
// Helpers
// ============================================================================

function makeEntry(lesson = 'Always use TypeScript strict mode'): RankedEntry {
	return {
		id: 'entry-' + Math.random().toString(36).slice(2),
		tier: 'swarm',
		lesson,
		category: 'tooling',
		tags: ['typescript'],
		scope: 'global',
		confidence: 0.85,
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
		relevanceScore: 0.85,
		finalScore: 0.85,
	} as RankedEntry;
}

function makeOutput(agentName: string): { messages: MessageWithParts[] } {
	return {
		messages: [
			{
				info: { role: 'system', agent: agentName },
				parts: [{ type: 'text', text: 'system prompt' }],
			},
			{
				info: { role: 'user' },
				parts: [{ type: 'text', text: 'user message' }],
			},
		],
	};
}

function makeConfig(): KnowledgeConfig {
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
	};
}

/** Detects the architect/orchestrator-tier injection block. */
function hasKnowledgeInjection(output: {
	messages: MessageWithParts[];
}): boolean {
	return output.messages.some((m) =>
		m.parts?.some(
			(p) =>
				p.text?.includes('📚 Lessons:') ||
				p.text?.includes('<swarm_knowledge_directives>') ||
				p.text?.includes('<drift_report>') ||
				p.text?.includes('<curator_briefing>'),
		),
	);
}

/** Detects the per-delegate directive block (Change 1). */
function hasDelegateBlock(output: { messages: MessageWithParts[] }): boolean {
	return output.messages.some((m) =>
		m.parts?.some((p) => p.text?.includes('<delegate_knowledge_directives>')),
	);
}

/** Detects any knowledge injection at all (either path). */
function hasAnyInjection(output: { messages: MessageWithParts[] }): boolean {
	return hasKnowledgeInjection(output) || hasDelegateBlock(output);
}

// ============================================================================
// Tests
// ============================================================================

describe('Knowledge injection — architect vs delegate vs none', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test',
			phases: [{ id: 1, name: 'Setup', tasks: [] }],
		});
		(mockRetrieve as ReturnType<typeof vi.fn>).mockResolvedValue([makeEntry()]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
	});

	// --- Architect → orchestrator block, never a delegate block ---

	it('injects the orchestrator block into architect (not a delegate block)', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');
		await hook({} as never, output);
		expect(hasKnowledgeInjection(output)).toBe(true);
		expect(hasDelegateBlock(output)).toBe(false);
	});

	it('injects the orchestrator block into mega_architect (prefix stripped)', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('mega_architect');
		await hook({} as never, output);
		expect(hasKnowledgeInjection(output)).toBe(true);
		expect(hasDelegateBlock(output)).toBe(false);
	});

	it('injects the orchestrator block into "Architect" (case-insensitive)', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('Architect');
		await hook({} as never, output);
		expect(hasKnowledgeInjection(output)).toBe(true);
		expect(hasDelegateBlock(output)).toBe(false);
	});

	// --- Delegated subagents → delegate block, never the orchestrator block ---

	for (const agent of ['coder', 'reviewer', 'sme', 'critic'] as const) {
		it(`injects a delegate block into ${agent} (not the orchestrator block)`, async () => {
			const hook = createKnowledgeInjectorHook('/proj', makeConfig());
			const output = makeOutput(agent);
			await hook({} as never, output);
			expect(hasDelegateBlock(output)).toBe(true);
			expect(hasKnowledgeInjection(output)).toBe(false);
		});
	}

	it('injects a delegate block into mega_sme (prefix stripped to sme)', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('mega_sme');
		await hook({} as never, output);
		expect(hasDelegateBlock(output)).toBe(true);
		expect(hasKnowledgeInjection(output)).toBe(false);
	});

	// --- Non-architect, non-delegate agents → nothing at all ---

	for (const agent of [
		'critic_sounding_board',
		'critic_drift_verifier',
		'mega_critic_drift_verifier',
	] as const) {
		it(`injects nothing into ${agent}`, async () => {
			const hook = createKnowledgeInjectorHook('/proj', makeConfig());
			const output = makeOutput(agent);
			await hook({} as never, output);
			expect(hasAnyInjection(output)).toBe(false);
		});
	}

	it('injects nothing when agent name is empty string', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output: { messages: MessageWithParts[] } = {
			messages: [
				{
					info: { role: 'system', agent: '' },
					parts: [{ type: 'text', text: 'sys' }],
				},
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
			],
		};
		await hook({} as never, output);
		expect(hasAnyInjection(output)).toBe(false);
	});

	it('injects nothing when system message has no agent field', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output: { messages: MessageWithParts[] } = {
			messages: [
				{ info: { role: 'system' }, parts: [{ type: 'text', text: 'sys' }] },
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
			],
		};
		await hook({} as never, output);
		expect(hasAnyInjection(output)).toBe(false);
	});
});
