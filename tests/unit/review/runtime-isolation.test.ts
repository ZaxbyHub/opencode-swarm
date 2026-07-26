import { afterEach, describe, expect, test } from 'bun:test';
import {
	type AgentDefinition,
	createAgents,
	getSwarmAgents,
	resolveFallbackModel,
} from '../../../src/agents';
import type { CommandContext } from '../../../src/commands/registry';
import {
	handleReviewCommand,
	_internals as reviewCommandInternals,
} from '../../../src/commands/review';
import {
	type PluginConfig,
	resolveAutoReviewConfig,
} from '../../../src/config/schema';
import type { ReviewModelDispatcher } from '../../../src/review/contracts';
import type { RunReviewEngineInput } from '../../../src/review/engine';
import {
	captureReviewAgentModelRegistry,
	resolveReviewAgentNames,
	resolveReviewFallbackModels,
	reviewPrimaryModel,
} from '../../../src/review/runtime';

const originalRunReviewEngine = reviewCommandInternals.runReviewEngine;

afterEach(() => {
	reviewCommandInternals.runReviewEngine = originalRunReviewEngine;
});

function dispatcher(label: string): ReviewModelDispatcher {
	return {
		async dispatch() {
			throw new Error(`${label} should be consumed only by the mocked engine`);
		},
	};
}

describe('review runtime instance isolation', () => {
	test('active architect selects reviewer and validator from the same named swarm', () => {
		const names = [
			'alpha_architect',
			'alpha_reviewer',
			'alpha_critic_finding_validator',
			'longer_swarm_architect',
			'longer_swarm_reviewer',
			'longer_swarm_critic_finding_validator',
		];

		expect(resolveReviewAgentNames(names, 'alpha_architect')).toEqual({
			reviewer: 'alpha_reviewer',
			validator: 'alpha_critic_finding_validator',
		});
		const legacyLongestReviewer = names
			.filter((name) => name.endsWith('_reviewer'))
			.sort((left, right) => right.length - left.length)[0];
		expect(legacyLongestReviewer).toBe('longer_swarm_reviewer');
		expect(resolveReviewAgentNames(names, 'longer_swarm_architect')).toEqual({
			reviewer: 'longer_swarm_reviewer',
			validator: 'longer_swarm_critic_finding_validator',
		});
		expect(() => resolveReviewAgentNames(names)).toThrow(
			/multiple named swarms/i,
		);
	});

	test('plugin A fallback snapshot survives plugin B initialization', () => {
		const configA = {
			swarms: {
				alpha: {
					agents: {
						reviewer: {
							model: 'openai/reviewer-a',
							fallback_models: ['openai/fallback-a'],
						},
					},
				},
			},
		} satisfies PluginConfig;
		const configB = {
			swarms: {
				alpha: {
					agents: {
						reviewer: {
							model: 'openai/reviewer-b',
							fallback_models: ['openai/fallback-b'],
						},
					},
				},
			},
		} satisfies PluginConfig;

		const namesA = createAgents(configA).map((agent) => agent.name);
		const registryA = captureReviewAgentModelRegistry(configA, namesA);
		// This second initialization overwrites the legacy module-global map.
		const namesB = createAgents(configB).map((agent) => agent.name);
		const registryB = captureReviewAgentModelRegistry(configB, namesB);

		expect(resolveFallbackModel('reviewer', 1, getSwarmAgents('alpha'))).toBe(
			'openai/fallback-b',
		);
		expect(resolveReviewFallbackModels('alpha_reviewer', registryA)).toEqual([
			{ providerID: 'openai', modelID: 'fallback-a' },
		]);
		expect(resolveReviewFallbackModels('alpha_reviewer', registryB)).toEqual([
			{ providerID: 'openai', modelID: 'fallback-b' },
		]);
		// Re-read A after B was initialized: its immutable snapshot must not drift.
		expect(resolveReviewFallbackModels('alpha_reviewer', registryA)).toEqual([
			{ providerID: 'openai', modelID: 'fallback-a' },
		]);
	});

	test('captures the default validator fallback in each plugin-local registry', () => {
		const registryA = captureReviewAgentModelRegistry({}, [
			'reviewer',
			'critic_finding_validator',
		]);
		const registryB = captureReviewAgentModelRegistry({}, [
			'alpha_reviewer',
			'alpha_critic_finding_validator',
		]);

		expect(reviewPrimaryModel('critic_finding_validator', registryA)).toBe(
			'opencode/big-pickle',
		);
		expect(
			resolveReviewFallbackModels('critic_finding_validator', registryA),
		).toEqual([{ providerID: 'opencode', modelID: 'gpt-5-nano' }]);
		expect(
			resolveReviewFallbackModels('alpha_critic_finding_validator', registryB),
		).toEqual([{ providerID: 'opencode', modelID: 'gpt-5-nano' }]);
	});

	test('regression F3: malformed entries do not suppress later valid fallbacks', () => {
		const registry = captureReviewAgentModelRegistry(
			{
				agents: {
					reviewer: {
						fallback_models: ['malformed', 'openai/later-valid'],
					},
				},
			},
			['reviewer'],
		);

		// Previous code let parseModelString throw on the first entry, so no
		// primary dispatch or later configured fallback could run.
		expect(resolveReviewFallbackModels('reviewer', registry)).toEqual([
			{ providerID: 'openai', modelID: 'later-valid' },
		]);
	});

	test('overlapping human command contexts retain distinct runtime state', async () => {
		const dispatcherA = dispatcher('A');
		const dispatcherB = dispatcher('B');
		const calls: RunReviewEngineInput[] = [];
		reviewCommandInternals.runReviewEngine = async (input) => {
			calls.push(input);
			await Bun.sleep(input.sessionID === 'session-A' ? 5 : 1);
			const suffix = input.dispatcher === dispatcherA ? 'a' : 'b';
			return {
				status: 'completed',
				blocked: false,
				message: `instance-${suffix}`,
				findings: [],
				blockingFindings: [],
				validationComplete: true,
				evidencePath: `C:\\repo-${suffix.toUpperCase()}\\.swarm\\evidence\\${suffix}.json`,
				scopeHash: suffix.repeat(64),
				modelCalls: 1,
			};
		};
		const configA = resolveAutoReviewConfig({
			enabled: true,
			min_confidence: 0.71,
		});
		const configB = resolveAutoReviewConfig({
			enabled: true,
			min_confidence: 0.89,
		});
		const agents: Record<string, AgentDefinition> = {
			reviewer: {
				name: 'reviewer',
				config: { model: 'openai/reviewer-model' },
			},
			critic_finding_validator: {
				name: 'critic_finding_validator',
				config: { model: 'openai/validator-model' },
			},
		};
		const contextA: CommandContext = {
			directory: 'C:\\repo-A',
			sessionID: 'session-A',
			args: ['--json'],
			agents,
			source: 'chat',
			reviewModelDispatcher: dispatcherA,
			autoReviewConfig: configA,
		};
		const contextB: CommandContext = {
			directory: 'C:\\repo-B',
			sessionID: 'session-B',
			args: ['--json'],
			agents,
			source: 'chat',
			reviewModelDispatcher: dispatcherB,
			autoReviewConfig: configB,
		};

		const [resultA, resultB] = await Promise.all([
			handleReviewCommand(contextA),
			handleReviewCommand(contextB),
		]);

		expect(calls).toHaveLength(2);
		const callA = calls.find((call) => call.sessionID === 'session-A');
		const callB = calls.find((call) => call.sessionID === 'session-B');
		expect(callA?.directory).toBe('C:\\repo-A');
		expect(callA?.dispatcher).toBe(dispatcherA);
		expect(callA?.config.min_confidence).toBe(0.71);
		expect(callB?.directory).toBe('C:\\repo-B');
		expect(callB?.dispatcher).toBe(dispatcherB);
		expect(callB?.config.min_confidence).toBe(0.89);
		expect(resultA).toContain('instance-a');
		expect(resultA).toContain('a'.repeat(64));
		expect(resultA).toContain('repo-A');
		expect(resultA).not.toContain('instance-b');
		expect(resultB).toContain('instance-b');
		expect(resultB).toContain('b'.repeat(64));
		expect(resultB).toContain('repo-B');
		expect(resultB).not.toContain('instance-a');
	});
});
