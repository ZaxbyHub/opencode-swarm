import { afterEach, describe, expect, test } from 'bun:test';
import {
	_internals,
	createContextBudgetHandler,
} from '../../../src/hooks/context-budget';

type BudgetMessage = {
	info: {
		role: string;
		agent?: string;
		sessionID?: string;
		modelID?: string;
		providerID?: string;
		tokens?: {
			input: number;
			cache: { read: number; write: number };
		};
	};
	parts: Array<{
		type: string;
		text?: string;
		tool?: string;
		state?: {
			status: string;
			input?: unknown;
			output?: string;
			error?: string;
		};
	}>;
};

const originalTelemetryContextPruned = _internals.telemetryContextPruned;

function makeConfig(overrides: Record<string, unknown> = {}) {
	return {
		context_budget: {
			enabled: true,
			warn_threshold: 0.4,
			critical_threshold: 0.5,
			enforce: true,
			prune_target: 0.3,
			recent_window: 1,
			preserve_last_n_turns: 0,
			tool_output_mask_threshold: 50,
			tracked_agents: ['architect'],
			model_limits: { default: 100 },
			...overrides,
		},
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
	};
}

function textMsg(
	text: string,
	role = 'user',
	sessionID = 'budget-session',
	agent = 'architect',
): BudgetMessage {
	return {
		info: { role, sessionID, ...(role === 'user' ? { agent } : {}) },
		parts: [{ type: 'text', text }],
	};
}

function toolMsg(output: string, sessionID = 'budget-session'): BudgetMessage {
	return {
		info: { role: 'assistant', sessionID },
		parts: [
			{
				type: 'tool',
				tool: 'bash',
				state: { status: 'completed', output },
			},
		],
	};
}

function toolInputMsg(
	input: unknown,
	output: string,
	sessionID = 'budget-session',
): BudgetMessage {
	return {
		info: { role: 'assistant', sessionID },
		parts: [
			{
				type: 'tool',
				tool: 'bash',
				state: { status: 'completed', input, output },
			},
		],
	};
}

function toolErrorMsg(
	error: string,
	sessionID = 'budget-session',
): BudgetMessage {
	return {
		info: { role: 'assistant', sessionID },
		parts: [
			{
				type: 'tool',
				tool: 'bash',
				state: { status: 'error', error },
			},
		],
	};
}

afterEach(() => {
	_internals.telemetryContextPruned = originalTelemetryContextPruned;
});

describe('context-budget context_pruned telemetry', () => {
	test('emits one aggregate event for masking-only mutations', async () => {
		const events: Array<Record<string, unknown>> = [];
		_internals.telemetryContextPruned = ((payload) => {
			events.push(payload);
		}) as typeof _internals.telemetryContextPruned;

		const handler = createContextBudgetHandler(
			makeConfig({
				model_limits: { default: 1000 },
				prune_target: 0.95,
			}),
		);
		const output = {
			messages: [
				textMsg('start'),
				toolMsg('x'.repeat(5000)),
				textMsg('assistant reply', 'assistant'),
				textMsg('final user turn'),
			],
		};

		await handler({}, output);

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			sessionId: 'budget-session',
			usageSource: 'estimated',
			maskedMessages: 1,
			prunedMessages: 0,
		});
		expect(Number(events[0].maskedTokensFreed)).toBeGreaterThan(0);
		expect(Number(events[0].prunedTokensFreed)).toBe(0);
		expect(Number(events[0].afterTokens)).toBeLessThan(
			Number(events[0].beforeTokens),
		);
	});

	test('emits one aggregate event for pruning-only mutations', async () => {
		const events: Array<Record<string, unknown>> = [];
		_internals.telemetryContextPruned = ((payload) => {
			events.push(payload);
		}) as typeof _internals.telemetryContextPruned;

		const handler = createContextBudgetHandler(makeConfig());
		const output = {
			messages: [
				textMsg('x'.repeat(220), 'assistant'),
				textMsg('y'.repeat(220), 'assistant'),
				textMsg('final user turn'),
			],
		};

		await handler({}, output);

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			sessionId: 'budget-session',
			usageSource: 'estimated',
			maskedMessages: 0,
			prunedMessages: 1,
		});
		expect(Number(events[0].maskedTokensFreed)).toBe(0);
		expect(Number(events[0].prunedTextParts)).toBeGreaterThan(0);
		expect(Number(events[0].prunedTokensFreed)).toBeGreaterThan(0);
	});

	test('uses full tool input size when selecting the minimum messages to prune', async () => {
		const events: Array<Record<string, unknown>> = [];
		_internals.telemetryContextPruned = ((payload) => {
			events.push(payload);
		}) as typeof _internals.telemetryContextPruned;

		const handler = createContextBudgetHandler(
			makeConfig({
				model_limits: { default: 10_000 },
				recent_window: 100,
				tool_output_mask_threshold: 1_000_000,
			}),
		);
		const ordinaryMessages = Array.from({ length: 8 }, (_unused, index) =>
			textMsg(`ordinary-${index}-${'x'.repeat(300)}`, 'assistant'),
		);
		const output = {
			messages: [
				toolInputMsg({ command: 'x'.repeat(100_000) }, 'ok'),
				...ordinaryMessages,
				textMsg('final user turn'),
			],
		};

		await handler({}, output);

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			maskedMessages: 0,
			prunedMessages: 1,
			prunedToolParts: 1,
		});
		expect(output.messages[0].parts[0].text).toContain('[Context pruned');
		for (let index = 1; index <= ordinaryMessages.length; index++) {
			expect(output.messages[index].parts[0].text).toContain(
				`ordinary-${index - 1}-`,
			);
			expect(output.messages[index].parts[0].text).not.toContain(
				'[Context pruned',
			);
		}
	});

	test('keeps provider-source pruning credits conservative and nonnegative', async () => {
		const events: Array<Record<string, unknown>> = [];
		_internals.telemetryContextPruned = ((payload) => {
			events.push(payload);
		}) as typeof _internals.telemetryContextPruned;

		const handler = createContextBudgetHandler(
			makeConfig({
				model_limits: { default: 10_000 },
				recent_window: 100,
				tool_output_mask_threshold: 1_000_000,
			}),
		);
		const providerAnchor = textMsg('provider anchor', 'assistant');
		providerAnchor.info.tokens = {
			input: 6_000,
			cache: { read: 0, write: 0 },
		};
		const output = {
			messages: [
				toolInputMsg({ command: 'x'.repeat(100_000) }, 'ok'),
				providerAnchor,
				textMsg('final user turn'),
			],
		};

		await handler({}, output);

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			usageSource: 'provider',
			prunedMessages: 1,
			prunedToolParts: 1,
		});
		const beforeTokens = Number(events[0].beforeTokens);
		const afterTokens = Number(events[0].afterTokens);
		const creditedPrunedTokens = Number(events[0].prunedTokensFreed);
		expect(beforeTokens).toBeGreaterThan(0);
		expect(afterTokens).toBeGreaterThanOrEqual(0);
		expect(afterTokens).toBe(3_000);
		expect(creditedPrunedTokens).toBeLessThanOrEqual(beforeTokens);
		expect(beforeTokens - creditedPrunedTokens).toBe(afterTokens);
	});

	test('does not emit when enforcement makes no transcript mutation', async () => {
		const events: Array<Record<string, unknown>> = [];
		_internals.telemetryContextPruned = ((payload) => {
			events.push(payload);
		}) as typeof _internals.telemetryContextPruned;

		const handler = createContextBudgetHandler(
			makeConfig({
				model_limits: { default: 10_000 },
				critical_threshold: 0.9,
			}),
		);
		await handler(
			{},
			{
				messages: [textMsg('tiny turn')],
			},
		);

		expect(events).toHaveLength(0);
	});

	test('does not emit when enforcement selects only non-mutable error tool parts', async () => {
		const events: Array<Record<string, unknown>> = [];
		_internals.telemetryContextPruned = ((payload) => {
			events.push(payload);
		}) as typeof _internals.telemetryContextPruned;

		const handler = createContextBudgetHandler(makeConfig());
		await handler(
			{},
			{
				messages: [toolErrorMsg('x'.repeat(220)), textMsg('final user turn')],
			},
		);

		expect(events).toHaveLength(0);
	});

	test('skips non-mutable error tools and selects a later removable message', async () => {
		const events: Array<Record<string, unknown>> = [];
		_internals.telemetryContextPruned = ((payload) => {
			events.push(payload);
		}) as typeof _internals.telemetryContextPruned;

		const handler = createContextBudgetHandler(
			makeConfig({
				model_limits: { default: 1_000 },
				prune_target: 0.7,
			}),
		);
		const errorText = 'e'.repeat(900);
		const removableText = 'r'.repeat(1_500);
		const output = {
			messages: [
				toolErrorMsg(errorText),
				textMsg(removableText, 'assistant'),
				textMsg('protected latest assistant', 'assistant'),
				textMsg('final user turn'),
			],
		};

		await handler({}, output);

		expect(output.messages[0].parts[0].state?.error).toBe(errorText);
		expect(output.messages[1].parts[0].text).toContain('[Context pruned');
		expect(output.messages[1].parts[0].text).not.toBe(removableText);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			prunedMessages: 1,
			prunedTextParts: 1,
			prunedToolParts: 0,
		});
		expect(Number(events[0].afterTokens)).toBeLessThanOrEqual(700);
	});

	test('does not replace short text when the prune placeholder would be longer', async () => {
		const events: Array<Record<string, unknown>> = [];
		_internals.telemetryContextPruned = ((payload) => {
			events.push(payload);
		}) as typeof _internals.telemetryContextPruned;

		const handler = createContextBudgetHandler(
			makeConfig({
				model_limits: { default: 10 },
			}),
		);
		const output = {
			messages: [
				textMsg('ok', 'assistant'),
				textMsg('x'.repeat(40), 'assistant'),
				textMsg('final user turn'),
			],
		};

		await handler({}, output);

		expect(events).toHaveLength(0);
		expect(output.messages[0].parts[0].text).toBe('ok');
	});

	test('does not mask short tool output when the mask placeholder would be longer', async () => {
		const events: Array<Record<string, unknown>> = [];
		_internals.telemetryContextPruned = ((payload) => {
			events.push(payload);
		}) as typeof _internals.telemetryContextPruned;

		const handler = createContextBudgetHandler(
			makeConfig({
				model_limits: { default: 20 },
				recent_window: 0,
				prune_target: 0.99,
				tool_output_mask_threshold: 0,
			}),
		);
		const output = {
			messages: [
				textMsg('seed'),
				toolMsg('ok'),
				textMsg('x'.repeat(40), 'assistant'),
				textMsg('final user turn'),
			],
		};

		await handler({}, output);

		expect(events).toHaveLength(0);
		expect(output.messages[1].parts[0]).toMatchObject({
			type: 'tool',
			state: { status: 'completed', output: 'ok' },
		});
	});

	test('does not fabricate a session id when one is missing', async () => {
		const events: Array<Record<string, unknown>> = [];
		_internals.telemetryContextPruned = ((payload) => {
			events.push(payload);
		}) as typeof _internals.telemetryContextPruned;

		const handler = createContextBudgetHandler(makeConfig());
		await handler(
			{},
			{
				messages: [
					{
						info: { role: 'assistant' },
						parts: [{ type: 'text', text: 'x'.repeat(220) }],
					},
					{
						info: { role: 'assistant' },
						parts: [{ type: 'text', text: 'y'.repeat(220) }],
					},
					{
						info: { role: 'user' },
						parts: [{ type: 'text', text: 'final user turn' }],
					},
				],
			},
		);

		expect(events).toHaveLength(0);
	});

	test('fails open when telemetry emission throws', async () => {
		_internals.telemetryContextPruned = (() => {
			throw new Error('telemetry unavailable');
		}) as typeof _internals.telemetryContextPruned;

		const handler = createContextBudgetHandler(makeConfig());
		const output = {
			messages: [
				textMsg('x'.repeat(220), 'assistant'),
				textMsg('y'.repeat(220), 'assistant'),
				textMsg('final user turn'),
			],
		};

		await expect(handler({}, output)).resolves.toBeUndefined();
		expect(output.messages[0].parts[0].text).toContain('[Context pruned');
	});

	test('returns immediately for explicitly untracked agents', async () => {
		const events: Array<Record<string, unknown>> = [];
		_internals.telemetryContextPruned = ((payload) => {
			events.push(payload);
		}) as typeof _internals.telemetryContextPruned;

		const handler = createContextBudgetHandler(makeConfig());
		const output = {
			messages: [
				textMsg('x'.repeat(300), 'user', 'budget-session', 'explorer'),
			],
		};

		await handler({}, output);

		expect(events).toHaveLength(0);
		expect(output.messages[0].parts[0].text).toBe('x'.repeat(300));
	});
});
