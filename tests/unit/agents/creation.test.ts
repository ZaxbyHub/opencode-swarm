import { describe, expect, test } from 'bun:test';
import {
	createArchitectAgent,
	createCoderAgent,
	createCriticAgent,
	createExplorerAgent,
	createReviewerAgent,
	createSMEAgent,
	createTestEngineerAgent,
} from '../../../src/agents';

describe('Agent Creation Functions', () => {
	const testModel = 'test-model';
	describe('createArchitectAgent', () => {
		const agent = createArchitectAgent(testModel);
		test('returns correct agent definition structure', () => {
			expect(agent).toHaveProperty('name', 'architect');
			expect(agent).toHaveProperty('description');
			expect(agent).toHaveProperty('config');
		});
		test('has correct model', () => {
			expect(agent.config.model).toBe(testModel);
		});

		test('has correct temperature', () => {
			expect(agent.config.temperature).toBe(0.1);
		});

		test('has non-empty description', () => {
			expect(typeof agent.description).toBe('string');
			expect(agent.description?.length).toBeGreaterThan(0);
		});

		test('has non-empty prompt', () => {
			expect(typeof agent.config.prompt).toBe('string');
			expect(agent.config.prompt?.length).toBeGreaterThan(0);
		});

		test('prompt contains required placeholders', () => {
			const prompt = agent.config.prompt || '';
			expect(prompt).toContain('{{SWARM_ID}}');
			expect(prompt).toContain('{{AGENT_PREFIX}}');
			expect(prompt).toContain('{{QA_RETRY_LIMIT}}');
		});

		test('has no tool restrictions', () => {
			expect(agent.config.tools).toBeUndefined();
		});

		test('handles custom prompt correctly', () => {
			const customPrompt = 'custom prompt';
			const agentWithCustom = createArchitectAgent(testModel, customPrompt);
			expect(agentWithCustom.config.prompt).toStartWith(customPrompt);
			expect(agentWithCustom.config.prompt).toMatch(/PROFILE DEFAULT/);
		});

		test('handles append prompt correctly', () => {
			const appendPrompt = 'additional prompt';
			const agentWithAppend = createArchitectAgent(
				testModel,
				undefined,
				appendPrompt,
			);
			expect(agentWithAppend.config.prompt).toEndWith(appendPrompt);
		});

		test('custom prompt takes precedence over append prompt', () => {
			const custom = 'custom';
			const append = 'append';
			const agentWithBoth = createArchitectAgent(testModel, custom, append);
			expect(agentWithBoth.config.prompt).toStartWith(custom);
			expect(agentWithBoth.config.prompt).toMatch(/PROFILE DEFAULT/);
			expect(agentWithBoth.config.prompt).not.toContain(append);
		});
	});

	describe('createCoderAgent', () => {
		const agent = createCoderAgent(testModel);

		test('returns correct agent definition structure', () => {
			expect(agent).toHaveProperty('name', 'coder');
			expect(agent).toHaveProperty('description');
			expect(agent).toHaveProperty('config');
		});

		test('has correct model', () => {
			expect(agent.config.model).toBe(testModel);
		});

		test('has correct temperature', () => {
			expect(agent.config.temperature).toBe(0.2);
		});

		test('has non-empty description', () => {
			expect(typeof agent.description).toBe('string');
			expect(agent.description?.length).toBeGreaterThan(0);
		});

		test('has non-empty prompt', () => {
			expect(typeof agent.config.prompt).toBe('string');
			expect(agent.config.prompt?.length).toBeGreaterThan(0);
		});

		test('has no tool restrictions', () => {
			expect(agent.config.tools).toBeUndefined();
		});

		test('handles custom prompt correctly', () => {
			const customPrompt = 'custom prompt';
			const agentWithCustom = createCoderAgent(testModel, customPrompt);
			expect(agentWithCustom.config.prompt).toBe(customPrompt);
		});

		test('handles append prompt correctly', () => {
			const appendPrompt = 'additional prompt';
			const agentWithAppend = createCoderAgent(
				testModel,
				undefined,
				appendPrompt,
			);
			expect(agentWithAppend.config.prompt).toEndWith(appendPrompt);
		});

		test('custom prompt takes precedence over append prompt', () => {
			const custom = 'custom';
			const append = 'append';
			const agentWithBoth = createCoderAgent(testModel, custom, append);
			expect(agentWithBoth.config.prompt).toBe(custom);
		});
	});

	describe('createExplorerAgent', () => {
		const agent = createExplorerAgent(testModel);

		test('returns correct agent definition structure', () => {
			expect(agent).toHaveProperty('name', 'explorer');
			expect(agent).toHaveProperty('description');
			expect(agent).toHaveProperty('config');
		});

		test('has correct model', () => {
			expect(agent.config.model).toBe(testModel);
		});

		test('has correct temperature', () => {
			expect(agent.config.temperature).toBe(0.1);
		});

		test('has non-empty description', () => {
			expect(typeof agent.description).toBe('string');
			expect(agent.description?.length).toBeGreaterThan(0);
		});

		test('has non-empty prompt', () => {
			expect(typeof agent.config.prompt).toBe('string');
			expect(agent.config.prompt?.length).toBeGreaterThan(0);
		});

		test('is read-only with tools restrictions', () => {
			expect(agent.config.tools).toBeDefined();
			expect(agent.config.tools?.write).toBe(false);
			expect(agent.config.tools?.edit).toBe(false);
			expect(agent.config.tools?.patch).toBe(false);
		});

		test('handles custom prompt correctly', () => {
			const customPrompt = 'custom prompt';
			const agentWithCustom = createExplorerAgent(testModel, customPrompt);
			expect(agentWithCustom.config.prompt).toBe(customPrompt);
		});

		test('handles append prompt correctly', () => {
			const appendPrompt = 'additional prompt';
			const agentWithAppend = createExplorerAgent(
				testModel,
				undefined,
				appendPrompt,
			);
			expect(agentWithAppend.config.prompt).toEndWith(appendPrompt);
		});

		test('custom prompt takes precedence over append prompt', () => {
			const custom = 'custom';
			const append = 'append';
			const agentWithBoth = createExplorerAgent(testModel, custom, append);
			expect(agentWithBoth.config.prompt).toBe(custom);
		});
	});

	describe('createSMEAgent', () => {
		const agent = createSMEAgent(testModel);

		test('returns correct agent definition structure', () => {
			expect(agent).toHaveProperty('name', 'sme');
			expect(agent).toHaveProperty('description');
			expect(agent).toHaveProperty('config');
		});

		test('has correct model', () => {
			expect(agent.config.model).toBe(testModel);
		});

		test('has correct temperature', () => {
			expect(agent.config.temperature).toBe(0.2);
		});

		test('has non-empty description', () => {
			expect(typeof agent.description).toBe('string');
			expect(agent.description?.length).toBeGreaterThan(0);
		});

		test('has non-empty prompt', () => {
			expect(typeof agent.config.prompt).toBe('string');
			expect(agent.config.prompt?.length).toBeGreaterThan(0);
		});

		test('is read-only with tools restrictions', () => {
			expect(agent.config.tools).toBeDefined();
			expect(agent.config.tools?.write).toBe(false);
			expect(agent.config.tools?.edit).toBe(false);
			expect(agent.config.tools?.patch).toBe(false);
		});

		test('handles custom prompt correctly', () => {
			const customPrompt = 'custom prompt';
			const agentWithCustom = createSMEAgent(testModel, customPrompt);
			expect(agentWithCustom.config.prompt).toBe(customPrompt);
		});

		test('handles append prompt correctly', () => {
			const appendPrompt = 'additional prompt';
			const agentWithAppend = createSMEAgent(
				testModel,
				undefined,
				appendPrompt,
			);
			expect(agentWithAppend.config.prompt).toEndWith(appendPrompt);
		});

		test('custom prompt takes precedence over append prompt', () => {
			const custom = 'custom';
			const append = 'append';
			const agentWithBoth = createSMEAgent(testModel, custom, append);
			expect(agentWithBoth.config.prompt).toBe(custom);
		});
	});

	describe('createReviewerAgent', () => {
		const agent = createReviewerAgent(testModel);

		test('returns correct agent definition structure', () => {
			expect(agent).toHaveProperty('name', 'reviewer');
			expect(agent).toHaveProperty('description');
			expect(agent).toHaveProperty('config');
		});

		test('has correct model', () => {
			expect(agent.config.model).toBe(testModel);
		});

		test('has correct temperature', () => {
			expect(agent.config.temperature).toBe(0.1);
		});

		test('has non-empty description', () => {
			expect(typeof agent.description).toBe('string');
			expect(agent.description?.length).toBeGreaterThan(0);
		});

		test('has non-empty prompt', () => {
			expect(typeof agent.config.prompt).toBe('string');
			expect(agent.config.prompt?.length).toBeGreaterThan(0);
		});

		test('is read-only with tools restrictions', () => {
			expect(agent.config.tools).toBeDefined();
			expect(agent.config.tools?.write).toBe(false);
			expect(agent.config.tools?.edit).toBe(false);
			expect(agent.config.tools?.patch).toBe(false);
		});

		test('handles custom prompt correctly', () => {
			const customPrompt = 'custom prompt';
			const agentWithCustom = createReviewerAgent(testModel, customPrompt);
			expect(agentWithCustom.config.prompt).toBe(customPrompt);
		});

		test('handles append prompt correctly', () => {
			const appendPrompt = 'additional prompt';
			const agentWithAppend = createReviewerAgent(
				testModel,
				undefined,
				appendPrompt,
			);
			expect(agentWithAppend.config.prompt).toEndWith(appendPrompt);
		});

		test('custom prompt takes precedence over append prompt', () => {
			const custom = 'custom';
			const append = 'append';
			const agentWithBoth = createReviewerAgent(testModel, custom, append);
			expect(agentWithBoth.config.prompt).toBe(custom);
		});
	});

	describe('createCriticAgent', () => {
		const agent = createCriticAgent(testModel);

		test('returns correct agent definition structure', () => {
			expect(agent).toHaveProperty('name', 'critic');
			expect(agent).toHaveProperty('description');
			expect(agent).toHaveProperty('config');
		});

		test('has correct model', () => {
			expect(agent.config.model).toBe(testModel);
		});

		test('has correct temperature', () => {
			expect(agent.config.temperature).toBe(0.1);
		});

		test('has non-empty description', () => {
			expect(typeof agent.description).toBe('string');
			expect(agent.description?.length).toBeGreaterThan(0);
		});

		test('has non-empty prompt', () => {
			expect(typeof agent.config.prompt).toBe('string');
			expect(agent.config.prompt?.length).toBeGreaterThan(0);
		});

		test('is read-only with tools restrictions', () => {
			expect(agent.config.tools).toBeDefined();
			expect(agent.config.tools?.write).toBe(false);
			expect(agent.config.tools?.edit).toBe(false);
			expect(agent.config.tools?.patch).toBe(false);
		});

		test('handles custom prompt correctly', () => {
			const customPrompt = 'custom prompt';
			const agentWithCustom = createCriticAgent(testModel, customPrompt);
			expect(agentWithCustom.config.prompt).toBe(customPrompt);
		});

		test('handles append prompt correctly', () => {
			const appendPrompt = 'additional prompt';
			const agentWithAppend = createCriticAgent(
				testModel,
				undefined,
				appendPrompt,
			);
			expect(agentWithAppend.config.prompt).toEndWith(appendPrompt);
		});

		test('custom prompt takes precedence over append prompt', () => {
			const custom = 'custom';
			const append = 'append';
			const agentWithBoth = createCriticAgent(testModel, custom, append);
			expect(agentWithBoth.config.prompt).toBe(custom);
		});
	});

	describe('createTestEngineerAgent', () => {
		const agent = createTestEngineerAgent(testModel);

		test('returns correct agent definition structure', () => {
			expect(agent).toHaveProperty('name', 'test_engineer');
			expect(agent).toHaveProperty('description');
			expect(agent).toHaveProperty('config');
		});

		test('has correct model', () => {
			expect(agent.config.model).toBe(testModel);
		});

		test('has correct temperature', () => {
			expect(agent.config.temperature).toBe(0.2);
		});

		test('has non-empty description', () => {
			expect(typeof agent.description).toBe('string');
			expect(agent.description?.length).toBeGreaterThan(0);
		});

		test('has non-empty prompt', () => {
			expect(typeof agent.config.prompt).toBe('string');
			expect(agent.config.prompt?.length).toBeGreaterThan(0);
		});

		test('has no tool restrictions', () => {
			expect(agent.config.tools).toBeUndefined();
		});

		test('handles custom prompt correctly', () => {
			const customPrompt = 'custom prompt';
			const agentWithCustom = createTestEngineerAgent(testModel, customPrompt);
			expect(agentWithCustom.config.prompt).toBe(customPrompt);
		});

		test('handles append prompt correctly', () => {
			const appendPrompt = 'additional prompt';
			const agentWithAppend = createTestEngineerAgent(
				testModel,
				undefined,
				appendPrompt,
			);
			expect(agentWithAppend.config.prompt).toEndWith(appendPrompt);
		});

		test('custom prompt takes precedence over append prompt', () => {
			const custom = 'custom';
			const append = 'append';
			const agentWithBoth = createTestEngineerAgent(testModel, custom, append);
			expect(agentWithBoth.config.prompt).toBe(custom);
		});

		describe('Prompt Content Verification', () => {
			test('prompt includes test_runner tool with all required scopes', () => {
				const prompt = agent.config.prompt || '';
				expect(prompt).toContain('test_runner');
				expect(prompt).toContain('all');
				expect(prompt).toContain('convention');
				expect(prompt).toContain('graph');
			});

			test('prompt includes framework-none fallback directive', () => {
				const prompt = agent.config.prompt || '';
				expect(prompt).toContain('framework');
				expect(prompt).toContain('none');
				expect(prompt).toContain('fall back');
			});

			test('prompt includes SKIPPED message for no framework', () => {
				const prompt = agent.config.prompt || '';
				expect(prompt).toContain('SKIPPED');
				expect(prompt).toContain('No test framework detected');
			});
		});
	});

	describe('Identity Hardening', () => {
		const subagents = [
			{ name: 'coder', create: createCoderAgent },
			{ name: 'explorer', create: createExplorerAgent },
			{ name: 'sme', create: createSMEAgent },
			{ name: 'reviewer', create: createReviewerAgent },
			{ name: 'critic', create: createCriticAgent },
			{ name: 'test_engineer', create: createTestEngineerAgent },
		];

		for (const { name, create } of subagents) {
			describe(name, () => {
				const agent = create('test-model');
				const prompt = agent.config.prompt || '';

				test('prompt starts with ## IDENTITY header', () => {
					// Some agents start with ## PRESSURE IMMUNITY before ## IDENTITY
					// The behavioral invariant is that ## IDENTITY is present
					const startsWithIdentity = prompt.startsWith('## IDENTITY');
					const startsWithPressureImmunity = prompt.startsWith(
						'## PRESSURE IMMUNITY',
					);
					expect(startsWithIdentity || startsWithPressureImmunity).toBe(true);
					// IDENTITY section must still be present
					expect(prompt).toContain('## IDENTITY');
				});

				test('contains anti-delegation directive', () => {
					expect(prompt).toContain(
						'DO NOT use the Task tool to delegate to other agents',
					);
				});

				test('contains identity reinforcement', () => {
					expect(prompt).toContain('You ARE the agent that does the work');
				});

				test('contains agent reference explanation', () => {
					expect(prompt).toContain('IGNORE them');
					expect(prompt).toContain('context from the orchestrator');
				});

				test('contains WRONG/RIGHT examples', () => {
					expect(prompt).toContain('WRONG:');
					expect(prompt).toContain('RIGHT:');
				});

				test('does not contain "No delegation" as a standalone rule', () => {
					expect(prompt).not.toContain('- No delegation');
				});
			});
		}
	});
});
