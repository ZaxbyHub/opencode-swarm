import { describe, expect, test } from 'bun:test';
import { classifyFullAutoToolAction } from '../../../src/full-auto/policy';

const baseInput = {
	sessionID: 'sess-capability',
	toolName: 'Task',
	args: {},
	directory: '/repo/project',
	fullAutoConfig: {
		enabled: true,
		mode: 'supervised' as const,
		permission_policy: { enabled: true, allow_defaults: true },
	},
};

describe('Full-Auto capability-derived delegation risk', () => {
	test('allows prefixed read-only critic_oversight delegation in supervised mode', () => {
		const result = classifyFullAutoToolAction({
			...baseInput,
			args: { subagent_type: 'mega_critic_oversight' },
			generatedAgentNames: ['mega_critic_oversight'],
			pluginConfig: {},
		});
		expect(result.action).toBe('allow');
	});

	test('escalates prefixed coder delegation because coder can write', () => {
		const result = classifyFullAutoToolAction({
			...baseInput,
			args: { subagent_type: 'mega_coder' },
			generatedAgentNames: ['mega_coder'],
			pluginConfig: {},
		});
		expect(result.action).toBe('escalate_critic');
	});

	test('escalates when opt-in tool maps add risky capabilities to architect', () => {
		const result = classifyFullAutoToolAction({
			...baseInput,
			args: { subagent_type: 'local_architect' },
			generatedAgentNames: ['local_architect'],
			pluginConfig: {
				turbo: {},
			},
		});
		expect(result.action).toBe('escalate_critic');
	});
});
