/**
 * Tests for the isOrchestratorAgent allowlist fix in src/hooks/knowledge-injector.ts
 *
 * Bug fixed: the original implementation used a denylist, allowing knowledge
 * injection into non-architect agents like 'sme', 'critic_sounding_board', and
 * 'critic_drift_verifier'. The fix replaced the denylist with an explicit
 * allowlist that only permits injection into the 'architect' agent.
 *
 * Covers:
 * 1. 'architect' agent → injection occurs
 * 2. 'sme' agent → injection blocked
 * 3. 'critic_sounding_board' agent → injection blocked
 * 4. 'critic_drift_verifier' agent → injection blocked
 * 5. 'coder' agent → injection blocked
 * 6. 'reviewer' agent → injection blocked
 * 7. 'mega_architect' (prefixed) → injection occurs (allowlist applies after strip)
 * 8. 'mega_sme' (prefixed non-architect) → injection blocked
 * 9. Case: 'Architect' (capitalized) → injection occurs (lowercase compare)
 * 10. Empty agent name → injection blocked
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

function hasKnowledgeInjection(output: {
	messages: MessageWithParts[];
}): boolean {
	return output.messages.some((m) =>
		m.parts?.some(
			(p) =>
				p.text?.includes('📚 Lessons:') ||
				p.text?.includes('<drift_report>') ||
				p.text?.includes('<curator_briefing>'),
		),
	);
}

// ============================================================================
// Tests
// ============================================================================

describe('Knowledge injection allowlist — architect only', () => {
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

	it('injects into architect', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');
		await hook({} as never, output);
		expect(hasKnowledgeInjection(output)).toBe(true);
	});

	it('blocks injection into sme', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('sme');
		await hook({} as never, output);
		expect(hasKnowledgeInjection(output)).toBe(false);
	});

	it('blocks injection into critic_sounding_board', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('critic_sounding_board');
		await hook({} as never, output);
		expect(hasKnowledgeInjection(output)).toBe(false);
	});

	it('blocks injection into critic_drift_verifier', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('critic_drift_verifier');
		await hook({} as never, output);
		expect(hasKnowledgeInjection(output)).toBe(false);
	});

	it('blocks injection into coder', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('coder');
		await hook({} as never, output);
		expect(hasKnowledgeInjection(output)).toBe(false);
	});

	it('blocks injection into reviewer', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('reviewer');
		await hook({} as never, output);
		expect(hasKnowledgeInjection(output)).toBe(false);
	});

	it('injects into mega_architect (prefix stripped to architect)', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('mega_architect');
		await hook({} as never, output);
		expect(hasKnowledgeInjection(output)).toBe(true);
	});

	it('blocks injection into mega_sme (prefix stripped to sme)', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('mega_sme');
		await hook({} as never, output);
		expect(hasKnowledgeInjection(output)).toBe(false);
	});

	it('blocks injection into mega_critic_drift_verifier', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('mega_critic_drift_verifier');
		await hook({} as never, output);
		expect(hasKnowledgeInjection(output)).toBe(false);
	});

	it('injects into "Architect" (case-insensitive allowlist)', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('Architect');
		await hook({} as never, output);
		expect(hasKnowledgeInjection(output)).toBe(true);
	});

	it('blocks injection when agent name is empty string', async () => {
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
		expect(hasKnowledgeInjection(output)).toBe(false);
	});

	it('blocks injection when system message has no agent field', async () => {
		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output: { messages: MessageWithParts[] } = {
			messages: [
				{ info: { role: 'system' }, parts: [{ type: 'text', text: 'sys' }] },
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
			],
		};
		await hook({} as never, output);
		expect(hasKnowledgeInjection(output)).toBe(false);
	});
});
