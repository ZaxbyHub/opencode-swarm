import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	formatStatusMarkdown,
	type StatusData,
} from '../../../src/services/status-service';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

describe('context-transparency', () => {
	const TEST_SESSION_ID = 'test-session-context-transparency';

	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	describe('formatStatusMarkdown context utilization', () => {
		test('1: includes context utilization line when contextBudgetPct is 34', () => {
			// The denominator is now carried on the snapshot (`contextBudgetTokens`,
			// written next to the pct by system-enhancer) instead of being
			// reconstructed from a constant. This test previously asserted
			// `13,600 / 40,000` against the then-hardcoded
			// DEFAULT_CONTEXT_BUDGET_CONFIG.budgetTokens; both that number and the
			// idea of a single global denominator are gone, because the window is
			// derived per model from `model.limit.context` (issue #1619).
			const status: StatusData = {
				hasPlan: true,
				currentPhase: 'Phase 1',
				completedTasks: 3,
				totalTasks: 5,
				agentCount: 7,
				isLegacy: false,
				turboMode: false,
				contextBudgetPct: 34,
				contextBudgetTokens: 200000,
				compactionCount: 0,
				lastSnapshotAt: null,
			};

			const output = formatStatusMarkdown(status);

			// 34% of 200,000 = 68,000 — the estimate tracks the snapshot's own
			// denominator, so it can no longer contradict the percentage.
			// (#2107 §3) the label is now the swarm injection footprint (an
			// intermediate per-turn measurement), not window usage.
			expect(output).toContain(
				'**Swarm injection footprint**: 34.0% of model window (intermediate measurement; est. 68,000 / 200,000 tokens)',
			);
			expect(output).toContain('68,000 / 200,000 tokens');
		});

		test('1b: renders the percentage alone when the denominator is unknown', () => {
			// Unreachable in production (the pct and the denominator are written on
			// the same statement), but a snapshot without one must not have a
			// token estimate fabricated against a constant.
			const status: StatusData = {
				hasPlan: true,
				currentPhase: 'Phase 1',
				completedTasks: 3,
				totalTasks: 5,
				agentCount: 7,
				isLegacy: false,
				turboMode: false,
				contextBudgetPct: 34,
				compactionCount: 0,
				lastSnapshotAt: null,
			};

			const output = formatStatusMarkdown(status);

			expect(output).toContain(
				'**Swarm injection footprint**: 34.0% of model window (intermediate measurement)',
			);
			expect(output).not.toContain('tokens)');
		});

		test('2: does NOT include context line when contextBudgetPct is null', () => {
			const status: StatusData = {
				hasPlan: true,
				currentPhase: 'Phase 1',
				completedTasks: 3,
				totalTasks: 5,
				agentCount: 7,
				isLegacy: false,
				turboMode: false,
				contextBudgetPct: null,
				compactionCount: 0,
				lastSnapshotAt: null,
			};

			const output = formatStatusMarkdown(status);

			expect(output).not.toContain('Context');
			expect(output).not.toContain('% used');
			expect(output).not.toContain('tokens');
		});

		test('3: does NOT include context line when contextBudgetPct is 0', () => {
			const status: StatusData = {
				hasPlan: true,
				currentPhase: 'Phase 1',
				completedTasks: 3,
				totalTasks: 5,
				agentCount: 7,
				isLegacy: false,
				turboMode: false,
				contextBudgetPct: 0,
				compactionCount: 0,
				lastSnapshotAt: null,
			};

			const output = formatStatusMarkdown(status);

			expect(output).not.toContain('Context');
			expect(output).not.toContain('% used');
			expect(output).not.toContain('tokens');
		});
	});

	describe('contextPressureWarningSent flag', () => {
		test('4: after resetSwarmState, new session contextPressureWarningSent is falsy', () => {
			// resetSwarmState is called in beforeEach

			// Ensure a new session
			const session = ensureAgentSession(TEST_SESSION_ID, 'test-agent');

			// contextPressureWarningSent should be undefined (falsy)
			expect(session.contextPressureWarningSent).toBeFalsy();
		});

		test('5: after setting contextPressureWarningSent = true, !session.contextPressureWarningSent is false', () => {
			// Get a fresh session
			const session = ensureAgentSession(TEST_SESSION_ID, 'test-agent');

			// Set the flag to true
			session.contextPressureWarningSent = true;

			// Verify the flag is true
			expect(session.contextPressureWarningSent).toBe(true);

			// Verify that !session.contextPressureWarningSent is false (won't re-fire)
			expect(!session.contextPressureWarningSent).toBe(false);
		});
	});
});
