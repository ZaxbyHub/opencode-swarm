/**
 * The `messages.transform` consumers use the LIVE model window too.
 *
 * `experimental.chat.messages.transform` receives messages but never a `Model`
 * — only `experimental.chat.system.transform` gets one. So the live
 * `model.limit.context` is recorded per session by the system hook and relayed
 * through `swarmState.liveContextWindows`.
 *
 * This matters more here than for the advisory text: `context-budget.ts`
 * HARD-PRUNES messages once `usage >= critical_threshold × modelLimit`. Against
 * a stale 128000 denominator on a 1M-window model, the hook deletes context the
 * model still needed — a silent data-loss bug, not a cosmetic warning.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolveRuntimeAgentModel } from '../../../src/config/agent-model';
import { createContextBudgetHandler } from '../../../src/hooks/context-budget';
import {
	resetSwarmState,
	setLiveContextWindow,
	swarmState,
} from '../../../src/state';

const SESSION_ID = 'relay-session';

/**
 * ~150k estimated tokens across a preserved user turn plus a prunable tool
 * result. `estimateTokens` is chars/3.5.
 *
 * Against a 128000 window that is >100% (well past `critical_threshold` 0.9,
 * so hard enforcement runs). Against a 1_000_000 window it is ~15% — nothing
 * should be touched.
 */
const HEAVY_CHARS = Math.floor(150_000 * 3.5);

/** Index of the heavy tool message inside `heavyConversation()`. */
const HEAVY_INDEX = 1;

/**
 * The heavy tool result sits at index 1, followed by enough short turns that it
 * falls OUTSIDE `preserve_last_n_turns` (default 4, which protects roughly the
 * last 8 user messages plus their interleaved assistants). Without that tail
 * the heavy message is protected and enforcement is a no-op regardless of the
 * denominator — which would make the "nothing was pruned" assertions vacuous.
 */
function heavyConversation() {
	const messages: Array<Record<string, unknown>> = [
		{
			info: { role: 'user', agent: 'architect', sessionID: SESSION_ID },
			parts: [{ type: 'text', text: 'kick off' }],
		},
		{
			info: {
				role: 'assistant',
				modelID: 'claude-sonnet-4-5',
				providerID: 'anthropic',
				sessionID: SESSION_ID,
			},
			parts: [
				{
					type: 'tool',
					tool: 'grep',
					state: {
						status: 'completed',
						input: {},
						output: 'x'.repeat(HEAVY_CHARS),
						title: 'grep',
						metadata: {},
						time: { start: 0, end: 1 },
					},
				},
			],
		},
	];
	for (let i = 0; i < 10; i++) {
		messages.push({
			info: { role: 'user', agent: 'architect', sessionID: SESSION_ID },
			parts: [{ type: 'text', text: `turn ${i}` }],
		});
		messages.push({
			info: { role: 'assistant', sessionID: SESSION_ID },
			parts: [{ type: 'text', text: `ack ${i}` }],
		});
	}
	messages.push({
		info: { role: 'user', agent: 'architect', sessionID: SESSION_ID },
		parts: [{ type: 'text', text: 'continue' }],
	});
	return messages as any[];
}

/** The final user message — where the advisory text is prepended. */
function lastUserText(messages: unknown[]): string {
	const last = messages[messages.length - 1] as {
		parts?: Array<{ text?: string }>;
	};
	return last?.parts?.[0]?.text ?? '';
}

/** `model_limits: {}` — the shape the schema now produces by default. */
const config = {
	context_budget: {
		enabled: true,
		warn_threshold: 0.7,
		critical_threshold: 0.9,
		model_limits: {},
		enforce: true,
	},
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
} as any;

/** True once the heavy tool result has been masked or pruned away. */
function toolOutputWasDestroyed(messages: unknown[]): boolean {
	const msg = messages[HEAVY_INDEX] as {
		parts?: Array<{ type?: string; state?: { output?: unknown } }>;
	};
	const toolPart = msg?.parts?.[0];
	if (!toolPart) return true;
	if (toolPart.type !== 'tool') return true; // replaced by a text placeholder
	const output = toolPart.state?.output;
	return typeof output !== 'string' || output.length < HEAVY_CHARS;
}

describe('context-budget hook — live window relay (issue #1619)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	test('with NO live window recorded, the stale static rungs still enforce', async () => {
		// Pre-existing behaviour, deliberately preserved: on the very first turn
		// of a session no system.transform has run, so there is nothing to relay.
		// `claude-sonnet-4-5` on `anthropic` prefix-matches the static table at
		// 200000, and 150k/200k = 75% — under critical, so no pruning, but the
		// CONTEXT WARNING advisory fires.
		const messages = heavyConversation();
		await createContextBudgetHandler(config)({}, { messages });

		expect(toolOutputWasDestroyed(messages)).toBe(false);
		expect(lastUserText(messages)).toContain('[CONTEXT WARNING');
	});

	test('with a 1M live window recorded, nothing is pruned and no advisory fires', async () => {
		setLiveContextWindow(SESSION_ID, 1_000_000, {
			modelID: 'claude-sonnet-4-5',
			providerID: 'anthropic',
		});
		const messages = heavyConversation();
		await createContextBudgetHandler(config)({}, { messages });

		expect(toolOutputWasDestroyed(messages)).toBe(false);
		expect(lastUserText(messages)).toBe('continue');
	});

	test('with a small live window recorded, hard enforcement DOES run', async () => {
		// Falsifiability for the test above: the same payload against a genuinely
		// small window must still trigger the destructive path, so "nothing was
		// pruned" above is a consequence of the denominator, not of the fixture
		// being harmless.
		setLiveContextWindow(SESSION_ID, 100_000, {
			modelID: 'claude-sonnet-4-5',
			providerID: 'anthropic',
		});
		const messages = heavyConversation();
		await createContextBudgetHandler(config)({}, { messages });

		expect(toolOutputWasDestroyed(messages)).toBe(true);
		expect(lastUserText(messages)).toContain('[CONTEXT CRITICAL');
	});

	test('an explicit model_limits entry still outranks the live window', async () => {
		setLiveContextWindow(SESSION_ID, 1_000_000, {
			modelID: 'claude-sonnet-4-5',
			providerID: 'anthropic',
		});
		const messages = heavyConversation();
		await createContextBudgetHandler({
			...config,
			context_budget: {
				...config.context_budget,
				model_limits: { default: 100_000 },
			},
		})({}, { messages });

		expect(toolOutputWasDestroyed(messages)).toBe(true);
	});

	test('the relay is keyed per session — another session does not leak in', async () => {
		setLiveContextWindow('some-other-session', 1_000_000, {
			modelID: 'claude-sonnet-4-5',
			providerID: 'anthropic',
		});
		const messages = heavyConversation();
		await createContextBudgetHandler(config)({}, { messages });

		// Falls back to the static rungs (200000 → 75% → warning, no pruning),
		// not to the other session's 1M window.
		expect(lastUserText(messages)).toContain('[CONTEXT WARNING');
	});

	test('a same-session handoff cannot reuse the outgoing model window', async () => {
		setLiveContextWindow(SESSION_ID, 1_000_000, {
			modelID: 'gpt-5',
			providerID: 'openai',
		});
		const messages = heavyConversation();
		await createContextBudgetHandler(
			config,
			() => 'anthropic/claude-sonnet-4-5',
		)({}, { messages });

		// The incoming target has no matching live reading, so its 200k static
		// limit applies. Reusing the outgoing 1M window would suppress this warning.
		expect(toolOutputWasDestroyed(messages)).toBe(false);
		expect(lastUserText(messages)).toContain('[CONTEXT WARNING');
	});

	test('an embedded variant reuses the matching registered live window', async () => {
		setLiveContextWindow(SESSION_ID, 1_000_000, {
			modelID: 'model',
			providerID: 'provider',
		});
		const messages = heavyConversation();
		(messages[messages.length - 1] as any).info.agent = 'coder';
		const variantConfig = {
			...config,
			agents: { coder: { model: 'provider/model/high' } },
		};
		const registered = {
			coder: { mode: 'subagent', model: 'provider/model' },
		};
		await createContextBudgetHandler(variantConfig, (agentName) =>
			resolveRuntimeAgentModel(variantConfig, registered, agentName),
		)({}, { messages });

		expect(toolOutputWasDestroyed(messages)).toBe(false);
		expect(lastUserText(messages)).toBe('continue');
	});

	test('setLiveContextWindow rejects junk and is FIFO-bounded', async () => {
		for (const bad of [
			0,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			'1000',
			null,
		]) {
			setLiveContextWindow('junk-session', bad);
		}
		expect(swarmState.liveContextWindows.has('junk-session')).toBe(false);

		// Invariant 8: module-level session-keyed state needs explicit eviction.
		for (let i = 0; i < 600; i++) {
			setLiveContextWindow(`s-${i}`, 200000);
		}
		expect(swarmState.liveContextWindows.size).toBeLessThanOrEqual(500);
		expect(swarmState.liveContextWindows.get('s-599')?.tokens).toBe(200000);
		expect(swarmState.liveContextWindows.has('s-0')).toBe(false);
	});
});
