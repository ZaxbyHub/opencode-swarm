/**
 * Production wiring regressions for issue #2122.
 *
 * These tests boot the real plugin and invoke its composed
 * `experimental.chat.messages.transform` chain. They therefore prove that
 * `src/index.ts` passes the runtime agent-model resolver into context-budget;
 * source-text assertions can pass when the matching text is dead or commented.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_MODELS } from '../../../src/config/constants';
import { resetSwarmState } from '../../../src/state';
import {
	bootKnowledgeHost,
	createKnowledgeProject,
} from '../../helpers/knowledge-real-host';
import { safeRmRecursive } from '../../helpers/safe-test-dir';

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

function handoffMessages(targetAgent: string, sessionID: string): Message[] {
	return [
		{
			info: { role: 'user', agent: 'architect', sessionID },
			parts: [{ type: 'text', text: 'start' }],
		},
		{
			info: {
				role: 'assistant',
				modelID: 'model-large',
				providerID: 'provider',
				sessionID,
			},
			parts: [
				{
					type: 'tool',
					tool: 'bash',
					state: { status: 'completed', output: 'x'.repeat(6_000) },
				},
			],
		},
		{
			info: { role: 'user', agent: 'architect', sessionID },
			parts: [{ type: 'text', text: 'continue' }],
		},
		{
			info: {
				role: 'assistant',
				modelID: 'model-large',
				providerID: 'provider',
				sessionID,
			},
			parts: [{ type: 'text', text: 'ready' }],
		},
		{
			info: { role: 'user', agent: targetAgent, sessionID },
			parts: [{ type: 'text', text: 'take over' }],
		},
	];
}

function allParts(messages: Message[]) {
	return messages.flatMap((message) => message.parts ?? []);
}

const contextBudget = {
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
		'provider/model-large': 10_000,
		[DEFAULT_MODELS.coder]: 1_000,
	},
};

describe('context-budget production agent-model wiring (#2122)', () => {
	let directory = '';

	beforeEach(() => {
		resetSwarmState();
		directory = createKnowledgeProject();
	});

	afterEach(() => {
		resetSwarmState();
		try {
			safeRmRecursive(directory);
		} catch {
			// Background workers can retain Windows handles briefly; the temp root is
			// OS-reclaimed and cleanup is not part of the behavioral assertion.
		}
	});

	test('the real plugin resolves an unconfigured subagent factory default', async () => {
		const plugin = await bootKnowledgeHost(directory, {
			knowledge: { enabled: false },
			default_agent: 'architect',
			agents: { architect: { model: 'provider/model-large' } },
			context_budget: contextBudget,
		});
		const messages = handoffMessages('coder', 'plugin-subagent-default');

		await plugin.hooks['experimental.chat.messages.transform'](
			{},
			{ messages },
		);

		expect(
			allParts(messages).some(
				(part) =>
					part.type === 'text' && part.text?.includes('[Tool output masked'),
			),
		).toBe(true);
	});

	test('the real plugin preserves UI metadata for a registered primary', async () => {
		const plugin = await bootKnowledgeHost(directory, {
			knowledge: { enabled: false },
			default_agent: 'architect',
			agents: {
				architect: { model: DEFAULT_MODELS.coder },
				coder: { model: DEFAULT_MODELS.coder },
			},
			context_budget: contextBudget,
		});
		const messages = handoffMessages('architect', 'plugin-primary-ui');

		await plugin.hooks['experimental.chat.messages.transform'](
			{},
			{ messages },
		);

		expect(allParts(messages).some((part) => part.type === 'tool')).toBe(true);
	});

	test('the real guardrail chain receives the same incoming-model resolver', async () => {
		const plugin = await bootKnowledgeHost(directory, {
			knowledge: { enabled: false },
			default_agent: 'architect',
			agents: {
				architect: { model: 'provider/gpt-4o' },
				coder: { model: 'provider/gpt-4o-mini' },
			},
			context_budget: { enabled: false },
		});
		const messages: Message[] = [
			{
				info: { role: 'system', sessionID: 'plugin-guardrail-target' },
				parts: [
					{
						type: 'text',
						text: `System prompt
<!-- BEHAVIORAL_GUIDANCE_START -->
Rule for a high-capability model
<!-- BEHAVIORAL_GUIDANCE_END -->`,
					},
				],
			},
			{
				info: {
					role: 'assistant',
					modelID: 'gpt-4o',
					providerID: 'provider',
					sessionID: 'plugin-guardrail-target',
				},
				parts: [{ type: 'text', text: 'ready' }],
			},
			{
				info: {
					role: 'user',
					agent: 'coder',
					sessionID: 'plugin-guardrail-target',
				},
				parts: [{ type: 'text', text: 'take over' }],
			},
		];

		await plugin.hooks['experimental.chat.messages.transform'](
			{},
			{ messages },
		);

		const text = allParts(messages)
			.map((part) => part.text ?? '')
			.join('\n');
		expect(text).not.toContain('Rule for a high-capability model');
		expect(text).toContain('[Enforcement: programmatic gates active]');
	});
});
