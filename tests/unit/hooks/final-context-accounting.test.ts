import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PluginConfig } from '../../../src/config';
import {
	_resetFinalAccountingState,
	createFinalContextAccountingStep,
} from '../../../src/hooks/final-context-accounting';
import type { MessageWithParts } from '../../../src/hooks/knowledge-types';
import { estimateTokens } from '../../../src/hooks/utils';
import {
	beginTurnLedger,
	clearTurnLedger,
	getTurnLedgerSummary,
	recordProducerEmission,
} from '../../../src/services/injection-budget';
import {
	getFinalPromptPressure,
	resetSwarmState,
	setLiveContextWindow,
} from '../../../src/state';

/**
 * #2107 §3: the ONE final accounting step measures the actual final
 * model-visible surface exactly once (messages + the system chain's
 * output.system bytes via ledger emissions; never double-counting a
 * messages-surface producer), resolves the REAL model limit, and emits a
 * bounded advisory warning whose own cost is part of the accounting.
 */

const SESSION = 'final-accounting-session';

function messageOf(
	role: string,
	text: string,
	extra: Record<string, unknown> = {},
): MessageWithParts {
	return {
		info: { role, sessionID: SESSION, ...extra },
		parts: [{ type: 'text', text }],
	} as unknown as MessageWithParts;
}

function makeConfig(extra: Record<string, unknown> = {}): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		context_budget: {
			enabled: true,
			warn_threshold: 0.7,
			critical_threshold: 0.9,
			model_limits: { default: 100_000 },
			...extra,
		},
	} as unknown as PluginConfig;
}

/** ~1 token per 3 chars under the canonical 0.33 heuristic. */
const TEXT_10K_TOKENS = 'x'.repeat(30_000);

describe('final context accounting (#2107 §3)', () => {
	beforeEach(() => {
		resetSwarmState();
		_resetFinalAccountingState();
		clearTurnLedger(SESSION);
	});

	afterEach(() => {
		resetSwarmState();
		_resetFinalAccountingState();
		clearTurnLedger(SESSION);
	});

	test('measures the final surface and records the snapshot', async () => {
		const step = createFinalContextAccountingStep({ config: makeConfig() });
		const messages = [messageOf('user', TEXT_10K_TOKENS)];
		await step({}, { messages });

		const snapshot = getFinalPromptPressure(SESSION);
		expect(snapshot).toBeDefined();
		expect(snapshot?.limitTokens).toBe(100_000);
		expect(snapshot?.usedTokens).toBeGreaterThan(0);
		expect(snapshot?.providerReported).toBe(false);
		expect(snapshot?.estimatorSource).toContain('0.33');
		// ~10K tokens of text → ~10% of a 100K window; far from warn.
		expect(snapshot?.pct).toBeLessThan(20);
	});

	test('adds system-surface ledger emissions to the measured total', async () => {
		beginTurnLedger(SESSION, 4000, true);
		// A system-surface producer (e.g. system-enhancer banners) pushed to
		// output.system — invisible to the messages measurement.
		recordProducerEmission(SESSION, 'system-enhancer', 3000, 0, 'system');
		// A messages-surface producer whose bytes are ALREADY in the messages
		// array below — must never be added again.
		recordProducerEmission(SESSION, 'knowledge-injector', 5000, 0, 'messages');

		const step = createFinalContextAccountingStep({ config: makeConfig() });
		const messages = [
			messageOf('system', 'sys'),
			messageOf('user', TEXT_10K_TOKENS), // ~10,000 tokens measured
		];
		await step({}, { messages });

		const snapshot = getFinalPromptPressure(SESSION);
		// ≈ measured(~10,001) + systemSurface(3,000); the 5,000-token
		// messages-surface emission is attribution-only.
		expect(snapshot?.usedTokens).toBeGreaterThanOrEqual(12_500);
		expect(snapshot?.usedTokens).toBeLessThan(13_500);
	});

	test('resolves the real model limit — no phantom 40K denominator', async () => {
		// A 200K model with ~10K used tokens must be at ~5%, nowhere near
		// warn/critical — the pre-#2107 advisory used a 40K tracker that would
		// have called this 25%+. No user model_limits here so the live window
		// wins the resolution ladder (live > static table > 128000 floor).
		setLiveContextWindow(SESSION, 200_000);
		const step = createFinalContextAccountingStep({
			config: makeConfig({ model_limits: {} }),
		});
		await step({}, { messages: [messageOf('user', TEXT_10K_TOKENS)] });

		const snapshot = getFinalPromptPressure(SESSION);
		expect(snapshot?.limitTokens).toBe(200_000);
		expect(snapshot?.pct).toBeLessThan(20);
	});

	test('configured model_limits overrides are honored', async () => {
		const step = createFinalContextAccountingStep({
			config: makeConfig({ model_limits: { default: 50_000 } }),
		});
		await step({}, { messages: [messageOf('user', TEXT_10K_TOKENS)] });
		expect(getFinalPromptPressure(SESSION)?.limitTokens).toBe(50_000);
	});

	test('warn-band warning is advisory, bounded, self-accounted, once per band', async () => {
		// ~79K tokens against a 100K default limit → warn band. Begin a
		// turn ledger (ceiling inactive — default config) so the warning's
		// own emission is recorded into it.
		beginTurnLedger(SESSION, 4000, false);
		const step = createFinalContextAccountingStep({ config: makeConfig() });
		const messages = [messageOf('user', 'y'.repeat(240_000))]; // ~80K tokens
		await step({}, { messages });

		const lastUserText = String(
			(messages[0]?.parts?.[0] as { text?: string })?.text ?? '',
		);
		expect(lastUserText).toContain('[CONTEXT PRESSURE (estimated):');
		expect(lastUserText).toContain(
			'Advisory only — this message removed no content.',
		);
		expect(lastUserText).toContain('chars→tokens heuristic');

		const snapshot = getFinalPromptPressure(SESSION);
		expect(snapshot?.pct).toBeGreaterThan(78);

		// The warning's own cost cannot escape accounting: the recorded total
		// exceeds the raw measured tokens by exactly the warning's estimate.
		// (The step records the warning as a ledger emission and then
		// CONSUMES the ledger — advanceTurnGeneration — so later turns can never
		// read stale system-surface entries; the ledger is therefore empty
		// for direct inspection here.)
		const rawTokens = estimateTokens('y'.repeat(240_000));
		expect(snapshot?.usedTokens).toBeGreaterThan(rawTokens);
		expect(getTurnLedgerSummary(SESSION)).toBeNull();

		// Second run in the same band is suppressed (once per session per band).
		const messages2 = [messageOf('user', 'y'.repeat(240_000))];
		await step({}, { messages: messages2 });
		const text2 = String(
			(messages2[0]?.parts?.[0] as { text?: string })?.text ?? '',
		);
		expect(text2).not.toContain('[CONTEXT PRESSURE');
	});

	test('bands are independent: warn latch does not suppress a later critical warning', async () => {
		const step = createFinalContextAccountingStep({ config: makeConfig() });
		const warnMessages = [messageOf('user', 'y'.repeat(240_000))]; // ~79% → warn
		await step({}, { messages: warnMessages });
		expect(
			String((warnMessages[0]?.parts?.[0] as { text?: string })?.text ?? ''),
		).toContain('[CONTEXT PRESSURE (estimated):');
		const critMessages = [messageOf('user', 'z'.repeat(330_000))]; // ~109% → critical
		await step({}, { messages: critMessages });
		const critText = String(
			(critMessages[0]?.parts?.[0] as { text?: string })?.text ?? '',
		);
		expect(critText).toContain('CRITICAL (estimated)');
	});

	test('critical band wording distinguishes advisory from actual pruning', async () => {
		const step = createFinalContextAccountingStep({ config: makeConfig() });
		const messages = [messageOf('user', 'z'.repeat(330_000))]; // ~110K > critical
		await step({}, { messages });
		const text = String(
			(messages[0]?.parts?.[0] as { text?: string })?.text ?? '',
		);
		expect(text).toContain('CRITICAL (estimated)');
		expect(text).toContain('this message removed no content');
		expect(text).toContain('Consider compacting');
	});

	test('distinguishes provider-reported usage from estimation', async () => {
		const step = createFinalContextAccountingStep({ config: makeConfig() });
		const messages: MessageWithParts[] = [
			messageOf('user', TEXT_10K_TOKENS),
			{
				info: {
					role: 'assistant',
					sessionID: SESSION,
					tokens: { input: 40_000, cache: { read: 0, write: 0 } },
				},
				parts: [{ type: 'text', text: 'done' }],
			} as unknown as MessageWithParts,
			messageOf('user', 'next turn'),
		];
		await step({}, { messages });
		const snapshot = getFinalPromptPressure(SESSION);
		expect(snapshot?.providerReported).toBe(true);
		expect(snapshot?.estimatorSource).toContain('provider-reported');
	});

	test('fail-open: disabled context_budget writes nothing', async () => {
		const step = createFinalContextAccountingStep({
			config: makeConfig({ enabled: false }),
		});
		await step({}, { messages: [messageOf('user', TEXT_10K_TOKENS)] });
		expect(getFinalPromptPressure(SESSION)).toBeUndefined();
	});

	test('consumes the ledger: a later accounting pass without a fresh begin reads no stale emissions', async () => {
		beginTurnLedger(SESSION, 4000, false);
		recordProducerEmission(SESSION, 'system-enhancer', 3000, 0, 'system');
		const step = createFinalContextAccountingStep({ config: makeConfig() });
		await step({}, { messages: [messageOf('user', TEXT_10K_TOKENS)] });
		// Ledger consumed by the first pass...
		expect(getTurnLedgerSummary(SESSION)).toBeNull();
		// ...so a second pass WITHOUT beginTurnLedger measures only the
		// messages surface — no prior-turn system-surface contamination.
		await step({}, { messages: [messageOf('user', TEXT_10K_TOKENS)] });
		const second = getFinalPromptPressure(SESSION);
		expect(second?.usedTokens).toBeLessThan(11_000);
	});

	test('never throws on malformed input', async () => {
		const step = createFinalContextAccountingStep({ config: makeConfig() });
		await expect(
			step({}, { messages: [null as unknown as MessageWithParts] }),
		).resolves.toBeUndefined();
	});
});
