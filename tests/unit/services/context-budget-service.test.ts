/**
 * context-budget-service behavioural tests.
 *
 * These previously mocked `validateDirectory` to a no-op so an EMPTY-string
 * directory would flow through, and then asserted on the service's SOURCE TEXT
 * (`expect(source).toContain("config.warningMode === 'once'")`) rather than on
 * its behaviour. Both were consequences of the same defect: the service
 * validated its trusted absolute project root with `validateDirectory`, which
 * rejects every absolute path, so the real function could not be exercised with
 * a realistic directory at all (issue #1619 follow-up).
 *
 * With `validateProjectDirectory` in place the service runs against a real
 * absolute temp directory, so every test below asserts observable behaviour —
 * including the warning-suppression logic that is now reachable in production
 * for the first time. No `mock.module` anywhere.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// node:fs/promises, deliberately: sibling files in tests/unit/services
// (diagnose-service*.test.ts, diagnose-sandbox.test.ts) replace `node:fs`
// process-wide with `existsSync: () => true`, and Bun's mock.module leaks
// across files in the shared runner. node:fs/promises is not mocked anywhere
// here, so these state-file assertions stay honest in a multi-file run.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DEFAULT_MODEL_CONTEXT_TOKENS } from '../../../src/config/schema';
import {
	type ContextBudgetConfig,
	type ContextBudgetReport,
	estimateTokens,
	formatBudgetWarning,
	getDefaultConfig,
} from '../../../src/services/context-budget-service';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function makeConfig(
	overrides: Partial<ContextBudgetConfig> = {},
): ContextBudgetConfig {
	return { ...getDefaultConfig(), ...overrides };
}

function makeReport(
	overrides: Partial<ContextBudgetReport> = {},
): ContextBudgetReport {
	return {
		timestamp: '2026-08-10T00:00:00.000Z',
		systemPromptTokens: 1000,
		planCursorTokens: 100,
		knowledgeTokens: 50,
		runMemoryTokens: 50,
		handoffTokens: 50,
		contextMdTokens: 50,
		swarmTotalTokens: 1300,
		estimatedTurnCount: 1,
		estimatedSessionTokens: 1300,
		budgetPct: 50,
		status: 'ok',
		recommendation: null,
		...overrides,
	};
}

describe('context-budget-service', () => {
	let dir: string;

	beforeEach(async () => {
		dir = canonicalMkdtemp('ctx-budget-');
		await fs.mkdir(path.join(dir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	const stateFile = () =>
		path.join(dir, '.swarm', 'session', 'budget-state.json');

	/** Existence via node:fs/promises — see the import note above. */
	const stateFileExists = async (): Promise<boolean> => {
		try {
			await fs.access(stateFile());
			return true;
		} catch {
			return false;
		}
	};

	describe('estimateTokens', () => {
		test('uses the chars/3.5 formula', () => {
			expect(estimateTokens('hello')).toBe(2); // ceil(5 / 3.5)
			expect(estimateTokens('abcdefghij')).toBe(3); // ceil(10 / 3.5)
			expect(estimateTokens('abcdefg')).toBe(2); // 7 / 3.5 exactly
		});

		test('returns 0 for empty and non-string input', () => {
			expect(estimateTokens('')).toBe(0);
			expect(estimateTokens(null as unknown as string)).toBe(0);
			expect(estimateTokens(undefined as unknown as string)).toBe(0);
		});
	});

	describe('getDefaultConfig', () => {
		test('budget denominator matches the schema default (single source of truth)', () => {
			// Imported, not hardcoded: this value and the schema's
			// `context_budget.model_limits.default` had drifted (40000 vs 128000),
			// so an unconfigured user measured the same swarm context against a
			// 3.2x smaller denominator and saw a spurious ~87% on turn one.
			expect(getDefaultConfig().budgetTokens).toBe(
				DEFAULT_MODEL_CONTEXT_TOKENS,
			);
		});

		test('returns the documented thresholds', () => {
			const config = getDefaultConfig();
			expect(config.enabled).toBe(true);
			expect(config.warningPct).toBe(70);
			expect(config.criticalPct).toBe(90);
			expect(config.warningMode).toBe('once');
			expect(config.warningIntervalTurns).toBe(20);
		});

		test('returns a copy, not the shared object', () => {
			const a = getDefaultConfig();
			const b = getDefaultConfig();
			a.budgetTokens = 99999;
			expect(b.budgetTokens).toBe(DEFAULT_MODEL_CONTEXT_TOKENS);
		});
	});

	describe('formatBudgetWarning', () => {
		test('returns null when status is ok, and writes no state', async () => {
			const result = await formatBudgetWarning(
				makeReport({ status: 'ok', budgetPct: 50 }),
				dir,
				makeConfig({ warningMode: 'every' }),
			);
			expect(result).toBeNull();
			expect(await stateFileExists()).toBe(false);
		});

		test("warningMode 'once' fires on the first crossing and is suppressed after", async () => {
			const config = makeConfig({ warningMode: 'once' });
			const report = makeReport({ status: 'warning', budgetPct: 75 });

			const first = await formatBudgetWarning(report, dir, config);
			expect(first).toContain('[CONTEXT BUDGET: 75.0%');
			// Suppression is persisted, not in-memory: the state file is the proof.
			expect(await stateFileExists()).toBe(true);

			const second = await formatBudgetWarning(
				makeReport({ status: 'warning', budgetPct: 78, estimatedTurnCount: 5 }),
				dir,
				config,
			);
			expect(second).toBeNull();
		});

		test("warningMode 'every' re-fires on each crossing", async () => {
			const config = makeConfig({ warningMode: 'every' });
			const report = makeReport({ status: 'warning', budgetPct: 75 });
			expect(await formatBudgetWarning(report, dir, config)).not.toBeNull();
			expect(await formatBudgetWarning(report, dir, config)).not.toBeNull();
		});

		test("warningMode 'interval' suppresses inside the window and fires past it", async () => {
			const config = makeConfig({
				warningMode: 'interval',
				warningIntervalTurns: 20,
			});
			const first = await formatBudgetWarning(
				makeReport({
					status: 'warning',
					budgetPct: 75,
					estimatedTurnCount: 10,
				}),
				dir,
				config,
			);
			expect(first).not.toBeNull();

			const inside = await formatBudgetWarning(
				makeReport({
					status: 'warning',
					budgetPct: 76,
					estimatedTurnCount: 25,
				}),
				dir,
				config,
			);
			expect(inside).toBeNull();

			const past = await formatBudgetWarning(
				makeReport({
					status: 'warning',
					budgetPct: 77,
					estimatedTurnCount: 31,
				}),
				dir,
				config,
			);
			expect(past).not.toBeNull();
		});

		test('critical is never suppressed and never persists state', async () => {
			// Deliberate: a critical budget must keep surfacing. The absent state
			// write is what makes it unsuppressible, so assert the file too.
			const config = makeConfig({ warningMode: 'once' });
			const report = makeReport({ status: 'critical', budgetPct: 95 });

			const first = await formatBudgetWarning(report, dir, config);
			const second = await formatBudgetWarning(report, dir, config);
			expect(first).toContain('CRITICAL');
			expect(second).toContain('CRITICAL');
			expect(await stateFileExists()).toBe(false);
		});

		test('critical message reports cost at $0.003 per 1K tokens', async () => {
			const result = await formatBudgetWarning(
				makeReport({
					status: 'critical',
					budgetPct: 95,
					swarmTotalTokens: 10000,
				}),
				dir,
				makeConfig(),
			);
			// 10000 / 1000 * 0.003 = 0.030
			expect(result).toContain('$0.030/turn');
			expect(result).toContain('~10,000 tokens/turn');
		});

		test('persists suppression state even when the caller discards the result', async () => {
			// The side effect that forced a source change in
			// src/hooks/system-enhancer.ts: the hook used to call this function
			// unconditionally and then decide whether the ACTIVE AGENT should see
			// the message. Under warningMode 'once' that consumed the architect's
			// single firing on a coder's turn, so the only agent that can act on
			// the warning could never receive it. Callers must gate on the
			// audience BEFORE calling — this test pins the side effect that makes
			// that mandatory.
			const config = makeConfig({ warningMode: 'once' });
			const report = makeReport({ status: 'warning', budgetPct: 75 });

			const discarded = await formatBudgetWarning(report, dir, config);
			expect(discarded).not.toBeNull(); // the "wasted" firing
			expect(await stateFileExists()).toBe(true);

			// A later caller — the one that actually wanted it — now gets nothing.
			expect(await formatBudgetWarning(report, dir, config)).toBeNull();
		});

		test('rejects an unusable project root instead of silently proceeding', async () => {
			const report = makeReport({ status: 'warning', budgetPct: 75 });
			await expect(
				formatBudgetWarning(report, '', makeConfig()),
			).rejects.toThrow('empty');
			await expect(
				formatBudgetWarning(report, 'relative/dir', makeConfig()),
			).rejects.toThrow('absolute path');
		});
	});
});
