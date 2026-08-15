/**
 * Budget-overshoot tests for the run-memory section of the knowledge injector.
 *
 * The run-memory block was gated only on `remaining > 300` and then pushed
 * WHOLE, with no `length <= remaining` fit check (unlike the drift preamble
 * and the rejected-warnings block, which both check). getRunMemorySummary is
 * capped at ~500 tokens (~1500 chars), so a large summary could be pushed into
 * a much smaller remaining budget, drive `remaining` negative, and starve every
 * lower-priority section. These tests pin the fit check and prove the
 * starvation is gone.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

afterEach(() => {
	restoreReceiptAuthority();
	swarmState.activeAgent.clear();
	mock.clearAllMocks();
	// Required by scripts/check-mock-cleanup.sh Check 1 (AGENTS.md invariant 7):
	// a file using mock.module must restore, or Bun's shared test-runner process
	// leaks these module mocks into other files. clearAllMocks only resets call
	// history — it does not undo the mocks.
	mock.restore();
});

import {
	createKnowledgeInjectorHook,
	_internals as injectorInternals,
} from '../../../src/hooks/knowledge-injector.js';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader.js';
import type {
	KnowledgeConfig,
	MessageWithParts,
} from '../../../src/hooks/knowledge-types.js';
import { swarmState } from '../../../src/state';
import { installKnowledgeReceiptAuthorityStub } from '../../helpers/knowledge-receipt-authority.js';

const SESSION_ID = 'ki-run-memory-budget-session';
let restoreReceiptAuthority = () => {};

beforeEach(() => {
	restoreReceiptAuthority =
		installKnowledgeReceiptAuthorityStub(injectorInternals);
});

// Spread-real-exports pattern (AGENTS.md invariant 7). Replacing a module with
// a partial object leaks into every other file in Bun's shared test-runner
// process: both `plan/manager` and `services/run-memory` import
// `readSwarmFileAsync`/`validateSwarmPath` from `hooks/utils`, so a stub that
// omits them breaks unrelated suites when co-run. Verified: without these
// spreads, tests/unit/plan/manager-run-memory.test.ts fails 7/7 in a shared run.
import * as realCuratorDrift from '../../../src/hooks/curator-drift.js';
import * as realExtractors from '../../../src/hooks/extractors.js';
import * as realKnowledgeReader from '../../../src/hooks/knowledge-reader.js';
import * as realKnowledgeStore from '../../../src/hooks/knowledge-store.js';
import * as realSearchKnowledge from '../../../src/hooks/search-knowledge.js';
import * as realUtils from '../../../src/hooks/utils.js';
import * as realPlanManager from '../../../src/plan/manager.js';
import * as realRunMemory from '../../../src/services/run-memory.js';

const mockRetrieve = mock(async (): Promise<RankedEntry[]> => []);

mock.module('../../../src/hooks/knowledge-reader.js', () => ({
	...realKnowledgeReader,
	readMergedKnowledge: mock(async () => []),
	scoreDirectiveAgainstContext: mock(() => ({
		triggerHit: false,
		actionHit: false,
		agentHit: false,
		score: 0,
	})),
}));
mock.module('../../../src/hooks/search-knowledge.js', () => ({
	...realSearchKnowledge,
	searchKnowledge: mock(async () => ({
		trace_id: 'trace-test',
		results: (await mockRetrieve()) ?? [],
	})),
}));
mock.module('../../../src/hooks/knowledge-store.js', () => ({
	...realKnowledgeStore,
	readRejectedLessons: mock(async () => []),
	enforceKnowledgeCap: async () => {},
	sweepAgedEntries: async () => {},
	sweepStaleTodos: async () => {},
	bumpKnowledgeConfidenceBatch: async () => {},
}));
mock.module('../../../src/hooks/curator-drift.js', () => ({
	...realCuratorDrift,
	readPriorDriftReports: mock(async () => []),
	buildDriftInjectionText: mock(() => ''),
}));
mock.module('../../../src/plan/manager.js', () => ({
	...realPlanManager,
	loadPlan: mock(async () => null),
	getCurrentTaskId: mock(() => undefined),
	closePlanTerminalState: async () => {},
	_snapshot_test_exports: {},
}));
mock.module('../../../src/hooks/extractors.js', () => ({
	...realExtractors,
	extractCurrentPhaseFromPlan: mock(() => 'Phase 1: Setup'),
}));
mock.module('../../../src/services/run-memory.js', () => ({
	...realRunMemory,
	getRunMemorySummary: mock(async () => null),
}));
mock.module('../../../src/hooks/utils.js', () => ({
	...realUtils,
	readSwarmFileAsync: mock(async () => null),
}));

import { extractCurrentPhaseFromPlan } from '../../../src/hooks/extractors.js';
import { readRejectedLessons } from '../../../src/hooks/knowledge-store.js';
import { loadPlan } from '../../../src/plan/manager.js';
import { getRunMemorySummary } from '../../../src/services/run-memory.js';

/** Fixed fixture timestamp: these tests assert on budget maths, never on
 * time, so the real clock is deliberately not used (check-test-clock.sh). */
const FIXED_TIMESTAMP = '2026-01-01T00:00:00.000Z';

/** Total chars the injector is allowed to emit for this fixture. */
const CHAR_BUDGET = 700;

function makeOutput(agentName = 'architect'): { messages: MessageWithParts[] } {
	swarmState.activeAgent.set(SESSION_ID, agentName);
	return {
		messages: [
			{
				info: { role: 'system', agent: agentName, sessionID: SESSION_ID },
				parts: [{ type: 'text', text: '' }],
			},
			{
				info: { role: 'user', sessionID: SESSION_ID },
				parts: [{ type: 'text', text: 'hello' }],
			},
		],
	};
}

function makeSwarmEntry(lesson: string): RankedEntry {
	return {
		id: `test-id-${Math.random().toString(36).substring(2, 9)}`,
		tier: 'swarm',
		lesson,
		category: 'process',
		tags: [],
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
		created_at: FIXED_TIMESTAMP,
		updated_at: FIXED_TIMESTAMP,
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
		inject_char_budget: CHAR_BUDGET,
		...overrides,
	} as KnowledgeConfig;
}

/** A run-memory summary near the ~500-token cap getRunMemorySummary allows. */
function oversizedRunMemory(): string {
	return (
		'[FOR: architect, coder]\n## RUN MEMORY — Previous Task Outcomes\n' +
		`Task 1.1: FAILED 3 times — last: ${'x'.repeat(1400)}. Still failing.\n` +
		'Use this data to avoid repeating known failure patterns.'
	);
}

function injectedText(output: { messages: MessageWithParts[] }): string {
	const msg = output.messages.find((m) =>
		m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
	);
	expect(msg).toBeDefined();
	return msg?.parts[0].text ?? '';
}

describe('run-memory injection respects the remaining char budget', () => {
	beforeEach(() => {
		mock.clearAllMocks();
		loadPlan.mockResolvedValue({ current_phase: 1, title: 'Test Project' });
		mockRetrieve.mockResolvedValue([makeSwarmEntry('Always validate inputs')]);
		readRejectedLessons.mockResolvedValue([]);
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 1: Setup');
	});

	it('drops a run-memory summary that does not fit in the remaining budget', async () => {
		const summary = oversizedRunMemory();
		expect(summary.length).toBeGreaterThan(CHAR_BUDGET);
		getRunMemorySummary.mockResolvedValueOnce(summary);

		const output = makeOutput();
		await createKnowledgeInjectorHook('/proj', makeConfig())({}, output);

		const text = injectedText(output);
		expect(text).toContain('Always validate inputs');
		expect(text).not.toContain('## RUN MEMORY');
	});

	it('still injects a run-memory summary that does fit', async () => {
		// Regression guard for the fix itself: the fit check must not turn into a
		// blanket "never inject run memory".
		const summary =
			'[FOR: architect, coder]\n## RUN MEMORY — Previous Task Outcomes\n' +
			'Task 1.1: FAILED attempt 1 — QA gate: test_engineer missing. Passed on attempt 2.\n' +
			'Use this data to avoid repeating known failure patterns.';
		expect(summary.length).toBeLessThan(CHAR_BUDGET);
		getRunMemorySummary.mockResolvedValueOnce(summary);

		const output = makeOutput();
		await createKnowledgeInjectorHook('/proj', makeConfig())({}, output);

		const text = injectedText(output);
		expect(text).toContain('## RUN MEMORY');
		expect(text).toContain('test_engineer missing');
	});

	it('an oversized run memory no longer starves lower-priority sections', async () => {
		// This is the harm the missing fit check caused: pushing the oversized
		// block drove `remaining` negative, so the rejected-pattern warnings
		// (priority 4, gated on `remaining > 150`) were silently dropped.
		getRunMemorySummary.mockResolvedValueOnce(oversizedRunMemory());
		readRejectedLessons.mockResolvedValue([
			{ lesson: 'Retry flaky tests blindly', rejection_reason: 'masks bugs' },
		]);

		const output = makeOutput();
		await createKnowledgeInjectorHook('/proj', makeConfig())({}, output);

		const text = injectedText(output);
		expect(text).not.toContain('## RUN MEMORY');
		expect(text).toContain('REJECTED PATTERN');
		expect(text).toContain('masks bugs');
	});

	it('keeps the whole injected block within the configured char budget', async () => {
		getRunMemorySummary.mockResolvedValueOnce(oversizedRunMemory());
		readRejectedLessons.mockResolvedValue([
			{ lesson: 'Retry flaky tests blindly', rejection_reason: 'masks bugs' },
		]);

		const output = makeOutput();
		await createKnowledgeInjectorHook('/proj', makeConfig())({}, output);

		// Before the fix the ~1500-char summary alone blew past this.
		expect(injectedText(output).length).toBeLessThanOrEqual(CHAR_BUDGET);
	});
});
