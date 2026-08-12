/**
 * The context-budget denominator is derived from the LIVE model, not a constant.
 *
 * Before this change `budgetTokens` came from `context_budget.model_limits.default`
 * (schema-defaulted to 128000) or, with no `context_budget` block at all, from
 * `DEFAULT_CONTEXT_BUDGET_CONFIG.budgetTokens` — a hardcoded number either way.
 * Every model with a 200k/256k/1M window was therefore measured against a
 * denominator that could be ~8x too small, firing the budget warning, the
 * `CONTEXT PRESSURE` advisory and the compaction EMERGENCY tier spuriously.
 *
 * These tests drive the REAL `experimental.chat.system.transform` hook with the
 * `model` object the host actually passes (`@opencode-ai/plugin`:
 * `{ sessionID?, model: Model }`, `Model.limit.context`) and assert that the
 * SAME system prompt produces a different verdict on a different model. Both
 * assembly paths are exercised: Path A (scoring off) and Path B (scoring on).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import {
	getLiveContextWindow,
	getSessionBudgetPct,
	getSessionBudgetTokens,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

/** The sessionID runHook() defaults to; the budget record is keyed by it. */
const SESSION = 'model-window-session';

import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/** `estimateTokens` is chars/3.5, so this yields ~`tokens` estimated tokens. */
const promptOf = (tokens: number) => 'x'.repeat(tokens * 3.5);

/**
 * ~120k estimated tokens of system prompt. Against a 128000-token window that
 * is ~94% (CRITICAL); against a 1M window it is ~12% (ok). One prompt, two
 * verdicts — that difference is the entire point of the change.
 */
const HEAVY_PROMPT = promptOf(120_000);

/** A `Model` in the shape the host hands to system.transform. */
const modelOf = (id: string, providerID: string, context: unknown) => ({
	id,
	providerID,
	limit: { context, output: 32000 },
});

const SMALL_WINDOW_MODEL = modelOf('gpt-4.1', 'github-copilot', 128000);
const HUGE_WINDOW_MODEL = modelOf('claude-sonnet-4-5', 'anthropic', 1_000_000);
/** Copilot's real catalog entry — 200000, NOT the 128000 PROVIDER_CAPS claims. */
const COPILOT_CLAUDE_MODEL = modelOf(
	'claude-sonnet-4.5',
	'github-copilot',
	200000,
);

describe('system-enhancer: budget denominator derives from model.limit.context', () => {
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

	/**
	 * `context_budget` present but with NO `model_limits` entry — the shape a
	 * user gets from the schema now that `model_limits` defaults to `{}`.
	 * `scoring.enabled` selects Path B.
	 */
	function configWith(
		extra: Record<string, unknown> = {},
		scoring = false,
	): PluginConfig {
		return {
			...baseConfig,
			context_budget: {
				enabled: true,
				warn_threshold: 0.7,
				critical_threshold: 0.9,
				model_limits: {},
				...(scoring ? { scoring: { enabled: true, max_candidates: 100 } } : {}),
				...extra,
			},
		} as PluginConfig;
	}

	async function runHook(
		config: PluginConfig,
		model: unknown,
		systemPrompt = HEAVY_PROMPT,
		sessionID = 'model-window-session',
	): Promise<string[]> {
		const hook = createSystemEnhancerHook(config, tempDir);
		const transform = hook['experimental.chat.system.transform'] as unknown as (
			input: { sessionID: string; model: unknown },
			output: { system: string[] },
		) => Promise<void>;
		const output = { system: [systemPrompt] };
		await transform({ sessionID, model }, output);
		return output.system;
	}

	const budgetBlockOf = (system: string[]) =>
		system.find((s) => s.includes('[CONTEXT BUDGET:'));

	beforeEach(async () => {
		resetSwarmState();
		tempDir = canonicalMkdtemp('swarm-model-window-');
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

	for (const scoring of [false, true]) {
		const path = scoring ? 'Path B (scoring)' : 'Path A';

		it(`${path}: a 128k model reports CRITICAL for a prompt a 1M model reports as ok`, async () => {
			const smallSystem = await runHook(
				configWith({}, scoring),
				SMALL_WINDOW_MODEL,
			);
			const smallBlock = budgetBlockOf(smallSystem);
			expect(smallBlock).toBeDefined();
			expect(smallBlock).toContain('CRITICAL');
			const smallPct = getSessionBudgetPct(SESSION);
			expect(getSessionBudgetTokens(SESSION)).toBe(128000);

			resetSwarmState();

			const hugeSystem = await runHook(
				configWith({}, scoring),
				HUGE_WINDOW_MODEL,
			);
			// Same prompt, ~8x the window: no warning at all.
			expect(budgetBlockOf(hugeSystem)).toBeUndefined();
			expect(getSessionBudgetTokens(SESSION)).toBe(1_000_000);
			// The percentage itself moved with the model, not just the verdict.
			expect(getSessionBudgetPct(SESSION)).toBeLessThan(smallPct / 5);
			expect(getSessionBudgetPct(SESSION)).toBeGreaterThan(0);
		});

		it(`${path}: a Copilot-capped entry uses the host's 200000, not the stale 128000 table`, async () => {
			await runHook(configWith({}, scoring), COPILOT_CLAUDE_MODEL);
			// PROVIDER_CAPS still says github-copilot === 128000. The live catalog
			// says 200000 for this exact provider/model pair, and the live value
			// wins outright — it is never min-capped against the stale table.
			expect(getSessionBudgetTokens(SESSION)).toBe(200000);
		});

		it(`${path}: an explicit model_limits value beats the live window`, async () => {
			await runHook(
				configWith({ model_limits: { default: 60000 } }, scoring),
				HUGE_WINDOW_MODEL,
			);
			// The user asked for a smaller WORKING budget than the physical window.
			expect(getSessionBudgetTokens(SESSION)).toBe(60000);
		});

		it(`${path}: a malformed limit.context falls back without NaN/Infinity`, async () => {
			// `limit.context: 0` is real: 124 of 6244 entries in the host's model
			// catalog ship it. Dividing by it would report Infinity% and fire the
			// EMERGENCY compaction tier on turn one.
			await runHook(
				configWith({}, scoring),
				modelOf('green-s', 'greenpt', 0),
				promptOf(1000),
			);
			expect(getSessionBudgetTokens(SESSION)).toBe(128000);
			expect(Number.isFinite(getSessionBudgetPct(SESSION))).toBe(true);
			expect(Number.isNaN(getSessionBudgetPct(SESSION))).toBe(false);
			expect(getSessionBudgetPct(SESSION)).toBeGreaterThan(0);
		});

		it(`${path}: an absent model object still produces a finite budget`, async () => {
			// The plugin .d.ts declares `model` as non-optional, but this hook runs
			// on the host boundary and must not throw if it does not arrive.
			await runHook(configWith({}, scoring), undefined, promptOf(1000));
			expect(getSessionBudgetTokens(SESSION)).toBe(128000);
			expect(Number.isFinite(getSessionBudgetPct(SESSION))).toBe(true);
		});
	}

	it('records the live window under the sessionID for the messages-transform consumers', async () => {
		// The messages.transform hooks receive messages but never a Model, so the
		// live window has to be relayed through session state or they keep using
		// the stale static table — and context-budget.ts HARD-PRUNES against it.
		expect(getLiveContextWindow('model-window-session')).toBeUndefined();
		await runHook(configWith(), HUGE_WINDOW_MODEL, promptOf(1000));
		expect(getLiveContextWindow('model-window-session')).toBe(1_000_000);
	});

	it('does not record an implausible live window, and keeps a good earlier one', async () => {
		await runHook(configWith(), HUGE_WINDOW_MODEL, promptOf(1000));
		await runHook(
			configWith(),
			modelOf('green-s', 'greenpt', 0),
			promptOf(1000),
		);
		// One malformed turn must not blank a reading the consumers depend on.
		expect(getLiveContextWindow('model-window-session')).toBe(1_000_000);
	});

	it('pairs the denominator with the percentage on every budget update', async () => {
		// `/swarm status` renders `est. X / Y tokens` from these two values. If
		// only the pct is written, the estimate is reconstructed against a
		// constant and contradicts the percentage printed beside it.
		expect(getSessionBudgetPct(SESSION)).toBe(0);
		expect(getSessionBudgetTokens(SESSION)).toBe(0);
		await runHook(configWith(), COPILOT_CLAUDE_MODEL, promptOf(150_000));
		expect(getSessionBudgetPct(SESSION)).toBeGreaterThan(0);
		expect(getSessionBudgetTokens(SESSION)).toBe(200000);
	});
});
