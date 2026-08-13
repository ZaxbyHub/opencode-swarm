import { describe, expect, test } from 'bun:test';
import { DEFAULT_MODELS } from '../../../src/config/constants';
import type { PluginConfig } from '../../../src/config/schema';
import { createContextBudgetHandler } from '../../../src/hooks/context-budget';

type Message = {
	info: {
		role: string;
		agent?: string;
		sessionID?: string;
		modelID?: string;
		providerID?: string;
	};
	parts: Array<{
		type: string;
		text?: string;
		tool?: string;
		state?: { status: string; output: string };
	}>;
};

function makeConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
	return {
		agents: {
			architect: { model: 'provider/model-large' },
			coder: { model: 'provider/model-small' },
		},
		context_budget: {
			enabled: true,
			warn_threshold: 0.65,
			critical_threshold: 0.9,
			enforce: true,
			enforce_on_agent_switch: true,
			prune_target: 0.7,
			recent_window: 1,
			preserve_last_n_turns: 1,
			tool_output_mask_threshold: 50,
			tracked_agents: ['architect', 'coder'],
			model_limits: {
				'provider/model-large': 1_000,
				'provider/model-small': 100,
				[DEFAULT_MODELS.coder]: 100,
			},
		},
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		...overrides,
	} as PluginConfig;
}

function budgetOutput(
	targetAgent: string,
	sessionID: string | undefined,
	toolCharacters = 600,
): { messages: Message[] } {
	const withSession = sessionID ? { sessionID } : {};
	return {
		messages: [
			{
				info: { role: 'user', agent: 'architect', ...withSession },
				parts: [{ type: 'text', text: 'start' }],
			},
			{
				info: {
					role: 'assistant',
					modelID: 'model-large',
					providerID: 'provider',
					...withSession,
				},
				parts: [
					{
						type: 'tool',
						tool: 'bash',
						state: {
							status: 'completed',
							output: 'x'.repeat(toolCharacters),
						},
					},
				],
			},
			{
				info: { role: 'user', agent: 'architect', ...withSession },
				parts: [{ type: 'text', text: 'continue' }],
			},
			{
				info: {
					role: 'assistant',
					modelID: 'model-large',
					providerID: 'provider',
					...withSession,
				},
				parts: [{ type: 'text', text: 'ready' }],
			},
			{
				info: { role: 'user', agent: targetAgent, ...withSession },
				parts: [{ type: 'text', text: 'take over' }],
			},
		],
	};
}

function identityOutput(
	agent: string,
	sessionID: string,
): { messages: Message[] } {
	return {
		messages: [
			{
				info: { role: 'user', agent, sessionID },
				parts: [{ type: 'text', text: 'hello' }],
			},
		],
	};
}

function expectMasked(
	output: { messages: Message[] },
	warning = '[CONTEXT CRITICAL',
): void {
	expect(output.messages[1].parts[0].type).toBe('text');
	expect(output.messages[1].parts[0].text).toContain('[Tool output masked');
	expect(output.messages[4].parts[0].text).toContain(warning);
}

function expectUnmasked(output: { messages: Message[] }): void {
	expect(output.messages[1].parts[0].type).toBe('tool');
}

describe('context-budget target model handoff enforcement (#2122)', () => {
	test('enforces the incoming agent limit before its first assistant message', async () => {
		const handler = createContextBudgetHandler(makeConfig());
		const output = budgetOutput('coder', 'session-handoff');

		await handler({}, output);

		expectMasked(output);
	});

	test('uses the exact named-swarm target model', async () => {
		const handler = createContextBudgetHandler(
			makeConfig({
				agents: undefined,
				swarms: {
					large: {
						agents: { coder: { model: 'provider/model-large' } },
					},
					small: {
						agents: { coder: { model: 'provider/model-small' } },
					},
				},
			}),
		);
		const output = budgetOutput('small_coder', 'session-named');

		await handler({}, output);

		expectMasked(output);
	});

	test('detects a same-role switch between exact swarm agent names', async () => {
		const handler = createContextBudgetHandler(
			makeConfig({
				agents: undefined,
				swarms: {
					large: {
						agents: { coder: { model: 'provider/model-large' } },
					},
					small: {
						agents: { coder: { model: 'provider/model-small' } },
					},
				},
			}),
		);

		await handler({}, identityOutput('large_coder', 'session-switch'));
		const output = budgetOutput('small_coder', 'session-switch', 190);
		await handler({}, output);

		expectMasked(output, '[CONTEXT WARNING');
	});

	test('does not leak switch history across interleaved sessions', async () => {
		const handler = createContextBudgetHandler(makeConfig());

		await handler({}, identityOutput('architect', 'session-a'));
		const output = budgetOutput('coder', 'session-b', 190);
		await handler({}, output);

		expectUnmasked(output);
	});

	test('does not share switch history when session identity is missing', async () => {
		const handler = createContextBudgetHandler(makeConfig());

		await handler({}, budgetOutput('architect', undefined, 10));
		const output = budgetOutput('coder', undefined, 190);
		await handler({}, output);

		expectUnmasked(output);
	});

	test('does not treat a repeated same-agent transform as a switch', async () => {
		const handler = createContextBudgetHandler(makeConfig());

		await handler({}, identityOutput('coder', 'session-repeat'));
		const output = budgetOutput('coder', 'session-repeat', 190);
		await handler({}, output);

		expectUnmasked(output);
	});

	test('evicts old session history at the bounded capacity', async () => {
		const handler = createContextBudgetHandler(makeConfig());

		await handler({}, identityOutput('architect', 'session-oldest'));
		for (let i = 0; i < 256; i++) {
			await handler({}, identityOutput('coder', `session-${i}`));
		}
		const output = budgetOutput('coder', 'session-oldest', 190);
		await handler({}, output);

		expectUnmasked(output);
		expect(output.messages[4].parts[0].text).toContain('[CONTEXT WARNING');
	});

	test('enforces the registered default for a subagent without an explicit model', async () => {
		// Previous code returned undefined for this exact target and reused the
		// outgoing assistant's large limit, reproducing #2122 for default models.
		const handler = createContextBudgetHandler(
			makeConfig({ agents: { architect: { model: 'provider/model-large' } } }),
			(agentName) => (agentName === 'coder' ? DEFAULT_MODELS.coder : undefined),
		);
		const output = budgetOutput('coder', 'session-unconfigured');

		await handler({}, output);

		expectMasked(output);
	});

	test('preserves assistant metadata for a primary target controlled by the UI', async () => {
		const handler = createContextBudgetHandler(makeConfig(), () => undefined);
		const output = budgetOutput('coder', 'session-primary');

		await handler({}, output);

		expectUnmasked(output);
	});

	test('preserves assistant metadata when target model is malformed', async () => {
		const handler = createContextBudgetHandler(
			makeConfig({
				agents: {
					architect: { model: 'provider/model-large' },
					coder: { model: '/model-small' },
				},
			}),
		);
		const output = budgetOutput('coder', 'session-malformed');

		await handler({}, output);

		expectUnmasked(output);
	});

	test('preserves assistant metadata for an unmatched swarm prefix', async () => {
		const handler = createContextBudgetHandler(
			makeConfig({
				agents: undefined,
				swarms: {
					small: {
						agents: { coder: { model: 'provider/model-small' } },
					},
				},
			}),
		);
		const output = budgetOutput('unknown_coder', 'session-unknown');

		await handler({}, output);

		expectUnmasked(output);
	});
});
