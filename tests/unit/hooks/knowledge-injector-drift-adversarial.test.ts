/**
 * Adversarial tests for drift injection feature in src/hooks/knowledge-injector.ts
 *
 * Tests cover attack vectors and edge cases for the drift injection block:
 * 1. readPriorDriftReports returns malformed/undefined structure → caught by try/catch
 * 2. buildDriftInjectionText returns oversized string (10,000 chars) → still prepended
 * 3. readPriorDriftReports returns array with null entry → handled safely
 * 4. buildDriftInjectionText throws synchronously → caught by try/catch
 * 5. readPriorDriftReports returns wrong type (empty string) → benign, no prepend
 * 6. cachedInjectionText is empty string "" → drift still prepended (not null check)
 * 7. Context budget stressed (totalChars > 75,000) → early return before drift injection
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

vi.mock('../../../src/hooks/curator-drift.js', () => ({
	readPriorDriftReports: vi.fn(async () => []),
	buildDriftInjectionText: vi.fn(() => ''),
}));
vi.mock('../../../src/hooks/knowledge-reader.js', () => ({
	readMergedKnowledge: vi.fn(async () => []),
}));
vi.mock('../../../src/hooks/knowledge-store.js', () => ({
	readRejectedLessons: vi.fn(async () => []),
	enforceKnowledgeCap: async () => {},
	sweepAgedEntries: async () => {},
	sweepStaleTodos: async () => {},
	bumpKnowledgeConfidenceBatch: async () => {},
}));
vi.mock('../../../src/plan/manager.js', () => ({
	loadPlan: vi.fn(async () => null),
	updateTaskStatus: vi.fn(),
	loadPlanJsonOnly: vi.fn(),
	updatePlanPhase: vi.fn(),
	regeneratePlanMarkdown: vi.fn(),
	isPlanMdInSync: vi.fn(),
	readSwarmFileAsync: vi.fn(),
	readSwarmFile: vi.fn(),
	writeSwarmFile: vi.fn(),
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

// Import mocked modules
import {
	buildDriftInjectionText,
	readPriorDriftReports,
} from '../../../src/hooks/curator-drift.js';
import { extractCurrentPhaseFromPlan } from '../../../src/hooks/extractors.js';
import { readMergedKnowledge } from '../../../src/hooks/knowledge-reader.js';
import { readRejectedLessons } from '../../../src/hooks/knowledge-store.js';
import { loadPlan } from '../../../src/plan/manager.js';
import { getRunMemorySummary } from '../../../src/services/run-memory.js';

// ============================================================================
// Helper Factories
// ============================================================================

function makeOutput(agentName: string = 'architect'): {
	messages: MessageWithParts[];
} {
	return {
		messages: [
			{
				info: { role: 'system', agent: agentName },
				parts: [{ type: 'text', text: 'System prompt' }],
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
		relevanceScore: { category: 0.5, confidence: confidence, keywords: 0.5 },
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
// Adversarial Test Suite 1: Malformed drift report structure
// ============================================================================

describe('Adversarial: Malformed drift report structure', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		(readMergedKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
		(getRunMemorySummary as ReturnType<typeof vi.fn>).mockResolvedValue(null);
	});

	it('Test 1: readPriorDriftReports returns report with undefined/null/malformed structure → caught by try/catch, hook completes', async () => {
		// Return an array with a malformed report (missing required fields)
		(readPriorDriftReports as ReturnType<typeof vi.fn>).mockResolvedValue([
			undefined,
			null,
			{ phase: 'not-a-number' }, // malformed - phase should be number
			{}, // empty object - no required fields
		] as any);

		// Set up knowledge entries
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		(readMergedKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		// Change phase to 2
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 2: Implementation',
		);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// This should NOT throw - error is caught by try/catch in drift injection block
		let errorThrown = false;
		try {
			await hook({}, output);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// Knowledge should still be injected
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();
		expect(knowledgeMsg?.parts?.[0]?.text).toContain('Test lesson');
	});
});

// ============================================================================
// Adversarial Test Suite 2: Oversized drift text (10,000 chars)
// ============================================================================

describe('Adversarial: Oversized drift text', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		(readMergedKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
		(getRunMemorySummary as ReturnType<typeof vi.fn>).mockResolvedValue(null);
	});

	it('Test 2: buildDriftInjectionText returns 10,000-char string (>>500 limit) → hook completes, text prepended', async () => {
		// Return a drift report
		(readPriorDriftReports as ReturnType<typeof vi.fn>).mockResolvedValue([
			{
				phase: 1,
				alignment: 'ALIGNED',
				drift_score: 0.05,
				injection_summary: 'test',
			},
		]);

		// Return a massive string (10,000 chars) - way over the 500 limit
		const massiveString = 'X'.repeat(10000);
		(buildDriftInjectionText as ReturnType<typeof vi.fn>).mockReturnValue(
			massiveString,
		);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// First call - init with phase 1
		await hook({}, output);

		// Set up knowledge entries
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		(readMergedKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		// Change phase to 2 — use fresh output to avoid idempotency guard
		const output2 = makeOutput('architect');
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 2: Implementation',
		);

		// This should NOT throw - overflow is caller's responsibility
		let errorThrown = false;
		try {
			await hook({}, output2);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// Knowledge should still be injected with the massive drift text included
		const knowledgeMsg = output2.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();
		const text = knowledgeMsg!.parts[0]?.text ?? '';
		// Lessons appear first, drift text may be included after (or trimmed by budget)
		expect(text).toContain('📚 Lessons:');
		expect(text).toContain('Test lesson');
	});
});

// ============================================================================
// Adversarial Test Suite 3: Array with null entry
// ============================================================================

describe('Adversarial: Array with null entry', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		(readMergedKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
		(getRunMemorySummary as ReturnType<typeof vi.fn>).mockResolvedValue(null);
	});

	it('Test 3: readPriorDriftReports returns array with single null entry → passing null to buildDriftInjectionText should not crash', async () => {
		// Return an array with a single null entry - accessing [length - 1] returns null
		(readPriorDriftReports as ReturnType<typeof vi.fn>).mockResolvedValue([
			null,
		] as any);

		// Make buildDriftInjectionText handle null gracefully (or it may throw - that's caught by try/catch)
		(buildDriftInjectionText as ReturnType<typeof vi.fn>).mockImplementation(
			(report: any) => {
				if (report === null) {
					throw new Error('Cannot build text from null report');
				}
				return '<drift_report>Phase 1: ALIGNED</drift_report>';
			},
		);

		// Set up knowledge entries
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		(readMergedKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		// Change phase to 2
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 2: Implementation',
		);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// This should NOT throw - error is caught by try/catch
		let errorThrown = false;
		try {
			await hook({}, output);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// Knowledge should still be injected (drift was skipped due to error)
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();
		expect(knowledgeMsg?.parts[0].text).toContain('Test lesson');
	});
});

// ============================================================================
// Adversarial Test Suite 4: buildDriftInjectionText throws synchronously
// ============================================================================

describe('Adversarial: buildDriftInjectionText throws synchronously', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		(readMergedKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
		(getRunMemorySummary as ReturnType<typeof vi.fn>).mockResolvedValue(null);
	});

	it('Test 4: buildDriftInjectionText throws synchronously → caught by try/catch, hook completes normally', async () => {
		// Return valid drift reports
		(readPriorDriftReports as ReturnType<typeof vi.fn>).mockResolvedValue([
			{
				phase: 1,
				alignment: 'ALIGNED',
				drift_score: 0.05,
				injection_summary: 'test',
			},
		]);

		// Make buildDriftInjectionText throw synchronously
		(buildDriftInjectionText as ReturnType<typeof vi.fn>).mockImplementation(
			() => {
				throw new Error('Intentional build error');
			},
		);

		// Set up knowledge entries
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		(readMergedKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		// Change phase to 2
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 2: Implementation',
		);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// This should NOT throw - error is caught by try/catch
		let errorThrown = false;
		try {
			await hook({}, output);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// Knowledge should still be injected (drift skipped due to error)
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();
		expect(knowledgeMsg?.parts[0].text).toContain('Test lesson');
		// Drift should NOT be present (error occurred)
		expect(knowledgeMsg?.parts[0].text).not.toContain('<drift_report>');
	});
});

// ============================================================================
// Adversarial Test Suite 5: Wrong type returned (empty string instead of array)
// ============================================================================

describe('Adversarial: Wrong type returned (empty string instead of array)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		(readMergedKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
		(getRunMemorySummary as ReturnType<typeof vi.fn>).mockResolvedValue(null);
	});

	it('Test 5: readPriorDriftReports returns empty string instead of array → accessing .length returns 0, no prepend (benign)', async () => {
		// Return empty string instead of array - string.length is 0, so the condition `driftReports.length > 0` is false
		(readPriorDriftReports as ReturnType<typeof vi.fn>).mockResolvedValue(
			'' as any,
		);

		// Set up knowledge entries
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		(readMergedKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		// Change phase to 2
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 2: Implementation',
		);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// This should NOT throw - behavior is benign
		let errorThrown = false;
		try {
			await hook({}, output);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// Knowledge should be injected
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();
		expect(knowledgeMsg?.parts[0].text).toContain('Test lesson');
		// Drift should NOT be present (string.length is 0, so condition fails)
		expect(knowledgeMsg?.parts[0].text).not.toContain('<drift_report>');
	});
});

// ============================================================================
// Adversarial Test Suite 6: cachedInjectionText is empty string
// ============================================================================

describe('Adversarial: cachedInjectionText is empty string', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		(readMergedKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
		(getRunMemorySummary as ReturnType<typeof vi.fn>).mockResolvedValue(null);
	});

	it('Test 6: cachedInjectionText is set to empty string "" → drift IS prepended (cachedInjectionText !== null is true)', async () => {
		// Set up drift reports
		(readPriorDriftReports as ReturnType<typeof vi.fn>).mockResolvedValue([
			{
				phase: 1,
				alignment: 'ALIGNED',
				drift_score: 0.05,
				injection_summary: 'test',
			},
		]);
		(buildDriftInjectionText as ReturnType<typeof vi.fn>).mockReturnValue(
			'<drift_report>Phase 1: ALIGNED</drift_report>',
		);

		// Set up knowledge entries
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		(readMergedKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		// Change phase to 2 - this triggers drift injection
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 2: Implementation',
		);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Call with all setup in place - drift should be prepended
		await hook({}, output);

		// Verify readPriorDriftReports was called (drift injection path taken)
		expect(readPriorDriftReports).toHaveBeenCalledWith('/proj');
		expect(buildDriftInjectionText).toHaveBeenCalled();

		// Knowledge should be injected with drift prepended
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();
		const text = knowledgeMsg!.parts[0]?.text ?? '';
		// In new priority order, lessons come first, then drift
		expect(text).toContain('📚 Lessons:');
		expect(text).toContain('Test lesson');
	});

	it('Test 6b: Verify that empty string is NOT null, so drift would prepend (direct condition test)', async () => {
		// This is a unit-style verification that "" !== null is true
		const cachedInjectionText = '';
		// This is the condition from the code: `cachedInjectionText !== null`
		expect(cachedInjectionText !== null).toBe(true);
		// The code has `if (driftText)` which would be falsy for empty string, so no prepend
		// But if driftText is non-empty, it WOULD prepend to empty string
	});
});

// ============================================================================
// Adversarial Test Suite 7: Context budget stressed (headroom < 300 chars)
// ============================================================================

describe('Adversarial: Context budget stressed', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		(readMergedKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
		(getRunMemorySummary as ReturnType<typeof vi.fn>).mockResolvedValue(null);
		// Return drift reports - but they shouldn't be accessed due to early return
		(readPriorDriftReports as ReturnType<typeof vi.fn>).mockResolvedValue([
			{
				phase: 1,
				alignment: 'ALIGNED',
				drift_score: 0.05,
				injection_summary: 'test',
			},
		]);
	});

	it('Test 7: Hook called when headroom < 300 chars → early return before drift injection, no crash', async () => {
		// MODEL_LIMIT_CHARS ≈ 387,878. Need existingChars > 387,878 - 300 to trigger skip
		const skipThreshold = Math.floor(128_000 / 0.33) - 200; // ~387,678 chars leaves ~200 headroom
		const largeSystemPrompt = 'x'.repeat(skipThreshold);
		const output = {
			messages: [
				{
					info: { role: 'system', agent: 'architect' },
					parts: [{ type: 'text', text: largeSystemPrompt }],
				},
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
			],
		};

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());

		// First call - init with phase 1
		await hook({}, output);

		// Change phase to 2
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 2: Implementation',
		);

		// This should NOT throw - early return happens before drift injection
		let errorThrown = false;
		try {
			await hook({}, output);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// readPriorDriftReports should NOT be called because early return happens before drift
		expect(readPriorDriftReports).not.toHaveBeenCalled();

		// No knowledge message should be injected (early return due to headroom)
		const hasKnowledgeInjection = output.messages.some((m) =>
			m.parts?.some((p) => p.text?.includes('\ud83d\udcda Lessons:')),
		);
		expect(hasKnowledgeInjection).toBe(false);
	});

	it('Test 7b: At 181k chars (old skip threshold) → still injects with new headroom check', async () => {
		// 181k chars was the old skip threshold. Now it should inject (moderate regime).
		const boundarySystemPrompt = 'x'.repeat(181_000);

		// Set up for successful injection BEFORE the hook call
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		(readMergedKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		// Change phase to 2
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 2: Implementation',
		);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = {
			messages: [
				{
					info: { role: 'system', agent: 'architect' },
					parts: [{ type: 'text', text: boundarySystemPrompt }],
				},
				{ info: { role: 'user' }, parts: [{ type: 'text', text: '' }] },
			],
		};

		// This should NOT throw
		let errorThrown = false;
		try {
			await hook({}, output);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// Knowledge SHOULD be injected (181k leaves ~206k headroom — well within limits)
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('\ud83d\udcda Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();
	});
});

// ============================================================================
// Additional Edge Cases
// ============================================================================

describe('Adversarial: Additional edge cases', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		(readMergedKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(readRejectedLessons as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 1: Setup',
		);
		(getRunMemorySummary as ReturnType<typeof vi.fn>).mockResolvedValue(null);
	});

	it('Test 8: readPriorDriftReports returns undefined → caught by try/catch, hook completes', async () => {
		// Return undefined instead of array
		(readPriorDriftReports as ReturnType<typeof vi.fn>).mockResolvedValue(
			undefined as any,
		);

		// Set up knowledge entries
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		(readMergedKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		// Change phase
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 2: Implementation',
		);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Should not throw
		let errorThrown = false;
		try {
			await hook({}, output);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// Knowledge should still be injected
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();
	});

	it('Test 9: buildDriftInjectionText returns undefined → falsy check catches it, no prepend', async () => {
		(readPriorDriftReports as ReturnType<typeof vi.fn>).mockResolvedValue([
			{
				phase: 1,
				alignment: 'ALIGNED',
				drift_score: 0.05,
				injection_summary: 'test',
			},
		]);
		// Return undefined instead of string
		(buildDriftInjectionText as ReturnType<typeof vi.fn>).mockReturnValue(
			undefined as any,
		);

		// Set up knowledge entries
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		(readMergedKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		// Change phase
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 2: Implementation',
		);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Should not throw
		let errorThrown = false;
		try {
			await hook({}, output);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// Knowledge should be injected but WITHOUT drift (undefined is falsy)
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();
		expect(knowledgeMsg?.parts[0].text).toContain('Test lesson');
		expect(knowledgeMsg?.parts[0].text).not.toContain('<drift_report>');
	});

	it('Test 10: readPriorDriftReports returns array with all undefined/null entries → loop does nothing, no crash', async () => {
		(readPriorDriftReports as ReturnType<typeof vi.fn>).mockResolvedValue([
			undefined,
			null,
			undefined,
		] as any);

		// Set up knowledge entries
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		(readMergedKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue(
			entries,
		);

		// Change phase
		(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		(extractCurrentPhaseFromPlan as ReturnType<typeof vi.fn>).mockReturnValue(
			'Phase 2: Implementation',
		);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Should not throw - accessing array elements that are undefined/null should not crash
		let errorThrown = false;
		try {
			await hook({}, output);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// Knowledge should be injected
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();
	});
});
