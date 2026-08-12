/**
 * System-enhancer ↔ context-budget wiring.
 *
 * Every test in this file used to set `context_budget: { enabled: false }`,
 * assert its claims in COMMENTS, and finish with `expect(true).toBe(true)`. The
 * stated reason was "a known bug on Windows where validateDirectory rejects
 * Windows absolute paths". That was not a Windows bug: `validateDirectory`
 * guards untrusted RELATIVE sub-paths and rejects EVERY absolute path on every
 * platform, so the budget check threw on all hosts and the feature was dead in
 * production behind a debug-gated catch (issue #1619 follow-up).
 *
 * `getContextBudgetReport` / `formatBudgetWarning` now validate their trusted
 * project root with `validateProjectDirectory`, so the budget check is ENABLED
 * in every test below and each assertion is on real hook output.
 *
 * Budget arithmetic here is deliberate: `estimateTokens` is chars/3.5, and the
 * seeded system prompt dominates the few hundred tokens the enhancer injects,
 * so the resulting percentage is stable without pinning an exact value.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import { resetSwarmState, swarmState } from '../../../src/state';

const BUDGET_TOKENS = 100_000;
/** chars = tokens * 3.5 */
const promptOf = (tokens: number) => 'x'.repeat(tokens * 3.5);

const OK_PROMPT = promptOf(10_000); // 10% of budget
const WARNING_PROMPT = promptOf(80_000); // 80% — between warn (70) and critical (90)
const CRITICAL_PROMPT = promptOf(96_000); // 96% — above critical

describe('System Enhancer Hook - Context Budget Wiring', () => {
	let tempDir: string;

	const baseConfig: PluginConfig = {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		hooks: {
			system_enhancer: true,
			compaction: true,
			agent_activity: true,
			delegation_tracker: false,
			delegation_gate: false,
			agent_awareness_max_chars: 300,
			delegation_max_chars: 1000,
		},
		automation: {
			mode: 'manual',
			capabilities: {
				decision_drift_detection: false,
				plan_sync: false,
				phase_preflight: false,
				config_doctor_on_startup: false,
				config_doctor_autofix: false,
				evidence_auto_summaries: false,
			},
		},
		adversarial_detection: {
			enabled: false,
			policy: 'warn',
			pairs: [['coder', 'reviewer']],
		},
	};

	function configWithBudget(extra: Record<string, unknown> = {}): PluginConfig {
		return {
			...baseConfig,
			context_budget: {
				enabled: true,
				warn_threshold: 0.7,
				critical_threshold: 0.9,
				model_limits: { default: BUDGET_TOKENS },
				...extra,
			},
		} as PluginConfig;
	}

	async function runHook(
		config: PluginConfig,
		systemPrompt: string,
		sessionID = 'test-session',
	): Promise<string[]> {
		const hook = createSystemEnhancerHook(config, tempDir);
		const transform = hook['experimental.chat.system.transform'] as unknown as (
			input: { sessionID: string },
			output: { system: string[] },
		) => Promise<void>;
		const output = { system: [systemPrompt] };
		await transform({ sessionID }, output);
		return output.system;
	}

	const budgetBlockOf = (system: string[]) =>
		system.find((s) => s.includes('[CONTEXT BUDGET:'));

	beforeEach(async () => {
		resetSwarmState();
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-test-'));
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
		await writeFile(
			join(tempDir, '.swarm', 'plan.md'),
			'# Project Plan\n## Phase 1: Setup [IN PROGRESS]\n- [ ] 1.1: Initial task\n',
		);
	});

	afterEach(async () => {
		resetSwarmState();
		await rm(tempDir, { recursive: true, force: true });
	});

	it('runs the budget check and injects a warning above the warn threshold', async () => {
		const system = await runHook(configWithBudget(), WARNING_PROMPT);
		const block = budgetBlockOf(system);
		expect(block).toBeDefined();
		expect(block).toContain('[FOR: architect]');
		expect(block).toContain('tokens/turn');
		expect(block).not.toContain('CRITICAL');
	});

	it('injects the CRITICAL variant above the critical threshold', async () => {
		const block = budgetBlockOf(
			await runHook(configWithBudget(), CRITICAL_PROMPT),
		);
		expect(block).toContain('CRITICAL');
		expect(block).toContain('/turn'); // cost projection
	});

	it('injects nothing when the budget is ok', async () => {
		expect(
			budgetBlockOf(await runHook(configWithBudget(), OK_PROMPT)),
		).toBeUndefined();
	});

	it('publishes the measured percentage to swarmState for downstream consumers', async () => {
		// swarmState.lastBudgetPct drives the CONTEXT PRESSURE advisory in
		// src/index.ts and the compaction service tiers. While the budget check
		// threw, it stayed at 0 and both of those were dormant.
		expect(swarmState.lastBudgetPct).toBe(0);
		await runHook(configWithBudget(), WARNING_PROMPT);
		expect(swarmState.lastBudgetPct).toBeGreaterThan(70);
		expect(swarmState.lastBudgetPct).toBeLessThan(90);
	});

	it('measures the budget AFTER the rest of the system prompt is assembled', async () => {
		// The old file asserted (in a comment) that the budget warning is the
		// FINAL block. That was never true: the pre-flight binary advisory is
		// pushed after it. What IS true — and what matters — is that the budget
		// is computed over the already-assembled prompt, so the block appears
		// after the seeded prompt and after the phase/plan injections.
		const system = await runHook(configWithBudget(), WARNING_PROMPT);
		expect(system.length).toBeGreaterThan(1);
		const budgetIndex = system.findIndex((s) => s.includes('[CONTEXT BUDGET:'));
		expect(budgetIndex).toBeGreaterThan(0);
	});

	it('only the architect sees the warning', async () => {
		swarmState.activeAgent.set('session-coder', 'coder');
		const coderSystem = await runHook(
			configWithBudget(),
			WARNING_PROMPT,
			'session-coder',
		);
		expect(budgetBlockOf(coderSystem)).toBeUndefined();
	});

	// NOTE — no filesystem assertions in this file. Sibling suites in
	// tests/unit/hooks (knowledge-reader.test.ts:107-116 among others) replace
	// BOTH `node:fs` and `node:fs/promises` process-wide, and Bun's mock.module
	// leaks across files in the shared runner, so any assertion here about
	// .swarm/session/budget-state.json would pass alone and fail in a full run.
	// Suppression persistence, `.swarm/` containment, and the
	// "a discarded formatBudgetWarning still burns the one-shot warning"
	// regression guard for the architect-check ordering all live in
	// tests/unit/services/context-budget-service.test.ts, where the filesystem
	// is trustworthy.

	it('the scoring path (Path B) wires the budget check too', async () => {
		// Path A and Path B have separate, duplicated budget-check blocks; a fix
		// applied to only one would leave the other dead.
		const config = configWithBudget({
			scoring: { enabled: true },
		});
		const block = budgetBlockOf(await runHook(config, WARNING_PROMPT));
		expect(block).toBeDefined();
		expect(block).toContain('[FOR: architect]');
	});

	it('respects context_budget.enabled === false', async () => {
		const config = configWithBudget({ enabled: false });
		expect(
			budgetBlockOf(await runHook(config, CRITICAL_PROMPT)),
		).toBeUndefined();
		expect(swarmState.lastBudgetPct).toBe(0);
	});
});
