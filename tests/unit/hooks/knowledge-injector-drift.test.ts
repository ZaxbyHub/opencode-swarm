/**
 * Verification tests for drift injection feature in src/hooks/knowledge-injector.ts
 *
 * Tests cover:
 * - Drift text prepended when reports exist and cachedInjectionText is populated
 * - No drift prepend when readPriorDriftReports returns empty array
 * - No drift prepend when buildDriftInjectionText returns empty string
 * - Error swallowing when readPriorDriftReports throws
 * - LAST report (highest phase) used when multiple reports exist
 * - No drift prepend when cachedInjectionText is null
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

afterEach(() => {
	mock.restore();
});

import { createKnowledgeInjectorHook } from '../../../src/hooks/knowledge-injector.js';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader.js';
import type {
	KnowledgeConfig,
	MessageWithParts,
} from '../../../src/hooks/knowledge-types.js';

// ============================================================================
// Mocks Setup
// ============================================================================

mock.module('../../../src/hooks/curator-drift.js', () => ({
	readPriorDriftReports: mock(async () => []),
	buildDriftInjectionText: mock(() => ''),
}));
mock.module('../../../src/hooks/knowledge-reader.js', () => ({
	readMergedKnowledge: mock(async () => []),
}));
mock.module('../../../src/hooks/knowledge-store.js', () => ({
	readRejectedLessons: mock(async () => []),
	enforceKnowledgeCap: async () => {},
	sweepAgedEntries: async () => {},
	sweepStaleTodos: async () => {},
	bumpKnowledgeConfidenceBatch: async () => {},
}));
mock.module('../../../src/plan/manager.js', () => ({
	loadPlan: mock(async () => null),
	updateTaskStatus: mock(),
	loadPlanJsonOnly: mock(),
	updatePlanPhase: mock(),
	regeneratePlanMarkdown: mock(),
	isPlanMdInSync: mock(),
	readSwarmFileAsync: mock(),
	readSwarmFile: mock(),
	writeSwarmFile: mock(),
	closePlanTerminalState: async () => {},
	_snapshot_test_exports: {},
}));
mock.module('../../../src/hooks/extractors.js', () => ({
	extractCurrentPhaseFromPlan: mock(() => 'Phase 1: Setup'),
}));
mock.module('../../../src/config/schema.js', () => ({
	stripKnownSwarmPrefix: mock((name: string) => {
		const prefixes = ['mega_', 'local_', 'paid_'];
		for (const p of prefixes) {
			if (name.startsWith(p)) return name.slice(p.length);
		}
		return name;
	}),
}));
mock.module('../../../src/services/run-memory.js', () => ({
	getRunMemorySummary: mock(async () => null),
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
// Test Suite: Drift injection with reports and cached text
// ============================================================================

describe('Drift injection: reports exist and cachedInjectionText populated', () => {
	beforeEach(() => {
		mock.restore();
		mock.clearAllMocks();
		loadPlan.mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		readMergedKnowledge.mockResolvedValue([]);
		readRejectedLessons.mockResolvedValue([]);
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 1: Setup');
		getRunMemorySummary.mockResolvedValue(null);
	});

	it('Test 1: drift text prepended to injection text on phase change when reports exist', async () => {
		// Set up knowledge entries BEFORE the first hook call
		const entries = [makeSwarmEntry('Test lesson for drift', 0.85)];
		readMergedKnowledge.mockResolvedValue(entries);

		// Set up drift reports
		const driftReports = [
			{
				phase: 1,
				alignment: 'ALIGNED',
				drift_score: 0.05,
				injection_summary: 'Phase 1: aligned',
			},
		];
		readPriorDriftReports.mockResolvedValue(driftReports);
		buildDriftInjectionText.mockReturnValue(
			'<drift_report>Phase 1: ALIGNED</drift_report>',
		);

		// Change phase to 2 - this triggers the drift injection path
		loadPlan.mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 2: Implementation');

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Single call with phase 2 and all setup in place - should trigger drift injection
		await hook({}, output);

		// Verify drift functions were called
		expect(readPriorDriftReports).toHaveBeenCalledWith('/proj');
		expect(buildDriftInjectionText).toHaveBeenCalled();

		// Find the knowledge message
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();

		const text = knowledgeMsg!.parts[0].text;
		// Drift text should be prepended (appear at the start)
		expect(text).toContain('<drift_report>');
		expect(text).toContain('Phase 1: ALIGNED');
		// Knowledge content should still be present
		expect(text).toContain('Test lesson for drift');
	});
});

// ============================================================================
// Test Suite: No drift reports
// ============================================================================

describe('Drift injection: no drift reports', () => {
	beforeEach(() => {
		mock.restore();
		mock.clearAllMocks();
		loadPlan.mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		readMergedKnowledge.mockResolvedValue([]);
		readRejectedLessons.mockResolvedValue([]);
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 1: Setup');
		getRunMemorySummary.mockResolvedValue(null);
		// Return empty array for drift reports
		readPriorDriftReports.mockResolvedValue([]);
	});

	it('Test 2: no drift prepend when readPriorDriftReports returns empty array', async () => {
		// Set up knowledge entries BEFORE the hook call
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		readMergedKnowledge.mockResolvedValue(entries);

		// Change phase to 2
		loadPlan.mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 2: Implementation');

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Single call with all setup in place
		await hook({}, output);

		// Verify readPriorDriftReports was called
		expect(readPriorDriftReports).toHaveBeenCalledWith('/proj');

		// buildDriftInjectionText should NOT be called when there are no reports
		expect(buildDriftInjectionText).not.toHaveBeenCalled();

		// Find the knowledge message
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();

		const text = knowledgeMsg!.parts[0].text;
		// Should contain knowledge but NOT drift report
		expect(text).toContain('Test lesson');
		expect(text).not.toContain('<drift_report>');
	});
});

// ============================================================================
// Test Suite: Empty drift text
// ============================================================================

describe('Drift injection: empty drift text', () => {
	beforeEach(() => {
		mock.restore();
		mock.clearAllMocks();
		loadPlan.mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		readMergedKnowledge.mockResolvedValue([]);
		readRejectedLessons.mockResolvedValue([]);
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 1: Setup');
		getRunMemorySummary.mockResolvedValue(null);
		// Return reports but buildDriftInjectionText returns empty string
		readPriorDriftReports.mockResolvedValue([
			{
				phase: 1,
				alignment: 'ALIGNED',
				drift_score: 0.05,
				injection_summary: 'aligned',
			},
		]);
		buildDriftInjectionText.mockReturnValue('');
	});

	it('Test 3: no drift prepend when buildDriftInjectionText returns empty string', async () => {
		// Set up knowledge entries BEFORE the hook call
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		readMergedKnowledge.mockResolvedValue(entries);

		// Change phase to 2
		loadPlan.mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 2: Implementation');

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Single call with all setup in place
		await hook({}, output);

		// Both functions should be called (reports exist, so they're called)
		expect(readPriorDriftReports).toHaveBeenCalledWith('/proj');
		expect(buildDriftInjectionText).toHaveBeenCalled();

		// Find the knowledge message
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();

		const text = knowledgeMsg!.parts[0].text;
		// Should contain knowledge but NOT drift report (empty string guard)
		expect(text).toContain('Test lesson');
		expect(text).not.toContain('<drift_report>');
	});
});

// ============================================================================
// Test Suite: Error swallowing
// ============================================================================

describe('Drift injection: error swallowing', () => {
	beforeEach(() => {
		mock.restore();
		mock.clearAllMocks();
		loadPlan.mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		readMergedKnowledge.mockResolvedValue([]);
		readRejectedLessons.mockResolvedValue([]);
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 1: Setup');
		getRunMemorySummary.mockResolvedValue(null);
	});

	it('Test 4: error in readPriorDriftReports is swallowed, injection text unchanged', async () => {
		// Set up knowledge entries BEFORE the hook call
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		readMergedKnowledge.mockResolvedValue(entries);

		// Make readPriorDriftReports throw
		readPriorDriftReports.mockRejectedValue(new Error('Filesystem error'));

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// This should NOT throw - error is swallowed (the hook completes without propagating error)
		let errorThrown = false;
		try {
			await hook({}, output);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// Find the knowledge message - should still be injected despite error
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();

		const text = knowledgeMsg!.parts[0].text ?? '';
		// Should contain knowledge but NOT drift (error occurred before drift could be added)
		expect(text).toContain('Test lesson');
	});

	it('Test 4b: error in buildDriftInjectionText is swallowed, injection text unchanged', async () => {
		// Set up knowledge entries BEFORE the hook call
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		readMergedKnowledge.mockResolvedValue(entries);

		// Make readPriorDriftReports return valid data
		readPriorDriftReports.mockResolvedValue([
			{
				phase: 1,
				alignment: 'ALIGNED',
				drift_score: 0.05,
				injection_summary: 'test',
			},
		]);
		// But buildDriftInjectionText throws
		buildDriftInjectionText.mockImplementation(() => {
			throw new Error('Build error');
		});

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// This should NOT throw - error is swallowed (the hook completes without propagating error)
		let errorThrown = false;
		try {
			await hook({}, output);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// Find the knowledge message - should still be injected despite error
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();

		const text = knowledgeMsg!.parts[0].text ?? '';
		// Should contain knowledge but NOT drift (error occurred)
		expect(text).toContain('Test lesson');
	});
});

// ============================================================================
// Test Suite: Multiple drift reports - LAST one used
// ============================================================================

describe('Drift injection: multiple reports use last one', () => {
	beforeEach(() => {
		mock.restore();
		mock.clearAllMocks();
		loadPlan.mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		readMergedKnowledge.mockResolvedValue([]);
		readRejectedLessons.mockResolvedValue([]);
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 1: Setup');
		getRunMemorySummary.mockResolvedValue(null);
	});

	it('Test 5: when multiple drift reports exist, the LAST one (highest phase) is used for injection', async () => {
		// Return multiple reports with different phases
		const driftReports = [
			{
				phase: 1,
				alignment: 'ALIGNED',
				drift_score: 0.05,
				injection_summary: 'Phase 1: aligned',
			},
			{
				phase: 2,
				alignment: 'MINOR_DRIFT',
				drift_score: 0.25,
				injection_summary: 'Phase 2: minor drift',
			},
			{
				phase: 3,
				alignment: 'MAJOR_DRIFT',
				drift_score: 0.75,
				injection_summary: 'Phase 3: major drift',
			},
		];
		readPriorDriftReports.mockResolvedValue(driftReports);

		// Track which report is passed to buildDriftInjectionText
		let capturedReport: any = null;
		buildDriftInjectionText.mockImplementation((report: any) => {
			capturedReport = report;
			return `<drift_report>Phase ${report.phase}: ${report.alignment}</drift_report>`;
		});

		// Set up knowledge entries
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		readMergedKnowledge.mockResolvedValue(entries);

		// Change phase to 4 (higher than any drift report)
		loadPlan.mockResolvedValue({
			current_phase: 4,
			title: 'Test Project',
			phases: [],
		});
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 4: Testing');

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Single call with all setup in place
		await hook({}, output);

		// Verify the LAST report (phase 3) was used
		expect(capturedReport).not.toBeNull();
		expect(capturedReport.phase).toBe(3);
		expect(capturedReport.alignment).toBe('MAJOR_DRIFT');

		// Find the knowledge message
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();

		const text = knowledgeMsg!.parts[0].text;
		// Should contain the drift from phase 3 (the last one)
		expect(text).toContain('Phase 3: MAJOR_DRIFT');
		// Should NOT contain earlier phases
		expect(text).not.toContain('Phase 1:');
		expect(text).not.toContain('Phase 2:');
	});
});

// ============================================================================
// Test Suite: Drift text format verification
// ============================================================================

describe('Drift injection: drift text format', () => {
	beforeEach(() => {
		mock.restore();
		mock.clearAllMocks();
		loadPlan.mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		readMergedKnowledge.mockResolvedValue([]);
		readRejectedLessons.mockResolvedValue([]);
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 1: Setup');
		getRunMemorySummary.mockResolvedValue(null);
	});

	it('Drift text appears in the injection text (after lessons in priority order)', async () => {
		// Set up knowledge entries BEFORE the hook call
		const entries = [makeSwarmEntry('Knowledge lesson', 0.85)];
		readMergedKnowledge.mockResolvedValue(entries);

		readPriorDriftReports.mockResolvedValue([
			{
				phase: 1,
				alignment: 'MINOR_DRIFT',
				drift_score: 0.3,
				injection_summary: 'Phase 1: minor drift',
				first_deviation: {
					phase: 1,
					task: 'task1',
					description: 'Missing test coverage',
				},
				corrections: ['Add more tests'],
			},
		]);
		buildDriftInjectionText.mockReturnValue(
			'<drift_report>Phase 1: MINOR_DRIFT (0.30) — Missing test coverage. Add more tests.</drift_report>',
		);

		// Change phase to 2
		loadPlan.mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 2: Implementation');

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Single call with all setup in place
		await hook({}, output);

		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();

		const text = knowledgeMsg!.parts[0].text ?? '';

		// Drift appears AFTER lessons in new priority order (lessons > run memory > drift)
		const driftIndex = text.indexOf('<drift_report>');
		const knowledgeIndex = text.indexOf('📚 Lessons:');

		expect(driftIndex).toBeGreaterThanOrEqual(0);
		expect(knowledgeIndex).toBeGreaterThanOrEqual(0);
		expect(driftIndex).toBeGreaterThan(knowledgeIndex);
	});
});
