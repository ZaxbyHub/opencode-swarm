import { afterEach, describe, expect, test } from 'bun:test';
import {
	type AgentDefinition,
	_internals as agentInternals,
	getAgentConfigs,
} from '../../../src/agents';
import type { PluginConfig } from '../../../src/config';
import {
	hostEvaluate,
	hostFromConfig,
} from '../../helpers/opencode-permission-model';

// Helper to create minimal valid PluginConfig
const minimalConfig = (partial: Partial<PluginConfig> = {}): PluginConfig =>
	partial as PluginConfig;

// Helper to build a synthetic AgentDefinition with an arbitrary `config`
// shape (including malformed `permission` values for defensive tests).
// Casts through `unknown` because callers intentionally construct shapes
// the real `AgentConfig` type would reject (e.g. a non-object permission).
const fakeAgent = (
	name: string,
	config: Record<string, unknown>,
): AgentDefinition => ({
	name,
	description: `synthetic agent: ${name}`,
	config: config as unknown as AgentDefinition['config'],
});

describe('getAgentConfigs - Architect Task Permission Hotfix', () => {
	describe('architect agents get task:allow permission', () => {
		test('default architect (no prefix) gets mode:primary and task:allow permission', () => {
			const configs = getAgentConfigs();
			const architectConfig = configs['architect'];

			expect(architectConfig).toBeDefined();
			expect(architectConfig.mode).toBe('primary');
			expect(architectConfig.permission).toEqual({ task: 'allow' });
			expect(architectConfig.tools?.swarm_command).toBe(true);
		});

		test('cloud_architect gets mode:primary and task:allow permission', () => {
			const config = minimalConfig({
				swarms: {
					cloud: {
						name: 'Cloud Swarm',
						agents: {},
					},
				},
			});
			const configs = getAgentConfigs(config);
			const cloudArchitectConfig = configs['cloud_architect'];

			expect(cloudArchitectConfig).toBeDefined();
			expect(cloudArchitectConfig.mode).toBe('primary');
			expect(cloudArchitectConfig.permission).toEqual({ task: 'allow' });
			expect(cloudArchitectConfig.tools?.swarm_command).toBe(true);
		});

		test('local_architect gets mode:primary and task:allow permission', () => {
			const config = minimalConfig({
				swarms: {
					local: {
						name: 'Local Swarm',
						agents: {},
					},
				},
			});
			const configs = getAgentConfigs(config);
			const localArchitectConfig = configs['local_architect'];

			expect(localArchitectConfig).toBeDefined();
			expect(localArchitectConfig.mode).toBe('primary');
			expect(localArchitectConfig.permission).toEqual({ task: 'allow' });
			expect(localArchitectConfig.tools?.swarm_command).toBe(true);
		});
	});

	describe('non-architect agents remain subagents without task permission', () => {
		test('default coder gets mode:subagent without task permission', () => {
			const configs = getAgentConfigs();
			const coderConfig = configs['coder'];

			expect(coderConfig).toBeDefined();
			expect(coderConfig.mode).toBe('subagent');
			expect(coderConfig.tools?.swarm_command).toBe(true);
			// Non-architects should NOT have task:allow permission
			expect(coderConfig.permission).toBeUndefined();
		});

		test('cloud_coder gets mode:subagent without task permission', () => {
			const config = minimalConfig({
				swarms: {
					cloud: {
						name: 'Cloud Swarm',
						agents: {},
					},
				},
			});
			const configs = getAgentConfigs(config);
			const cloudCoderConfig = configs['cloud_coder'];

			expect(cloudCoderConfig).toBeDefined();
			expect(cloudCoderConfig.mode).toBe('subagent');
			expect(cloudCoderConfig.permission).toBeUndefined();
		});

		test('local_reviewer gets mode:subagent without task permission', () => {
			const config = minimalConfig({
				swarms: {
					local: {
						name: 'Local Swarm',
						agents: {},
					},
				},
			});
			const configs = getAgentConfigs(config);
			const localReviewerConfig = configs['local_reviewer'];

			expect(localReviewerConfig).toBeDefined();
			expect(localReviewerConfig.mode).toBe('subagent');
			expect(localReviewerConfig.tools?.swarm_command).toBe(true);
			expect(localReviewerConfig.permission).toBeUndefined();
		});

		test('explorer gets mode:subagent without task permission', () => {
			const configs = getAgentConfigs();
			const explorerConfig = configs['explorer'];

			expect(explorerConfig).toBeDefined();
			expect(explorerConfig.mode).toBe('subagent');
			expect(explorerConfig.permission).toBeUndefined();
		});

		test('sme gets mode:subagent without task permission', () => {
			const configs = getAgentConfigs();
			const smeConfig = configs['sme'];

			expect(smeConfig).toBeDefined();
			expect(smeConfig.mode).toBe('subagent');
			expect(smeConfig.permission).toBeUndefined();
		});

		test('test_engineer gets mode:subagent without task permission', () => {
			const configs = getAgentConfigs();
			const testEngineerConfig = configs['test_engineer'];

			expect(testEngineerConfig).toBeDefined();
			expect(testEngineerConfig.mode).toBe('subagent');
			expect(testEngineerConfig.permission).toBeUndefined();
		});
	});

	describe('multiple swarm scenarios', () => {
		test('both default and cloud swarms have correct architect permissions', () => {
			const config = minimalConfig({
				swarms: {
					default: {
						name: 'Default Swarm',
						agents: {},
					},
					cloud: {
						name: 'Cloud Swarm',
						agents: {},
					},
				},
			});
			const configs = getAgentConfigs(config);

			// Default swarm architect
			const defaultArchitect = configs['architect'];
			expect(defaultArchitect.mode).toBe('primary');
			expect(defaultArchitect.permission).toEqual({ task: 'allow' });

			// Cloud swarm architect
			const cloudArchitect = configs['cloud_architect'];
			expect(cloudArchitect.mode).toBe('primary');
			expect(cloudArchitect.permission).toEqual({ task: 'allow' });

			// Non-architects in both swarms should be subagents
			expect(configs['coder'].mode).toBe('subagent');
			expect(configs['cloud_coder'].mode).toBe('subagent');
			expect(configs['architect'].tools?.swarm_command).toBe(true);
			expect(configs['cloud_architect'].tools?.swarm_command).toBe(true);
			expect(configs['coder'].tools?.swarm_command).toBe(true);
			expect(configs['cloud_coder'].tools?.swarm_command).toBe(true);
		});
	});
});

/**
 * Regression tests for the primary-agent permission clobber (src/agents/index.ts).
 *
 * `getAgentConfigs` used to REPLACE `sdkConfig.permission` wholesale when
 * granting `task: 'allow'` to a primary agent:
 *   `(sdkConfig.permission as Record<string, 'allow'>) = { task: 'allow' };`
 * Any permission entries the agent's own definition already declared (edit,
 * bash, webfetch, external_directory — including nested per-pattern
 * objects) were silently discarded, and the cast defeated type checking.
 *
 * These tests inject a synthetic agent set via the `_internals.createAgents`
 * DI seam (bun:test `mock.module` leaks across files in this repo's shared
 * test-runner process — see AGENTS.md invariant 7) so we can construct an
 * `AgentDefinition` whose `config.permission` is pre-populated, which no
 * production `create*Agent` factory currently does.
 */
describe('getAgentConfigs - primary agent permission merge (not replace)', () => {
	const realCreateAgents = agentInternals.createAgents;

	afterEach(() => {
		agentInternals.createAgents = realCreateAgents;
	});

	// Disabling tool_filter short-circuits getAgentConfigs before it reaches
	// AGENT_TOOL_MAP lookups, which have no entry for these synthetic names.
	const noToolFilterConfig = () =>
		minimalConfig({ tool_filter: { enabled: false } });

	test('primary agent keeps its own permission entries and gains task:allow', () => {
		agentInternals.createAgents = () => [
			fakeAgent('architect', {
				permission: {
					edit: 'deny',
					external_directory: { 'C:/foo/*': 'allow' },
				},
			}),
			fakeAgent('coder', { permission: { edit: 'deny' } }),
		];

		const configs = getAgentConfigs(noToolFilterConfig());

		expect(configs.architect.mode).toBe('primary');
		expect(configs.architect.permission).toEqual({
			edit: 'deny',
			external_directory: { 'C:/foo/*': 'allow' },
			task: 'allow',
		});
	});

	test('regression (LOW-5): task:allow is emitted LAST, not left in its old slot', () => {
		// POSITION IS PRECEDENCE: the host evaluates permission with `findLast`
		// over Object.entries order and wildcard-matches the permission NAME, so
		// `'*'` also matches `task`. A duplicate key in an object literal keeps
		// its FIRST position, so `{ ...{task:'deny','*':'deny'}, task:'allow' }`
		// leaves `task` at index 0 and `findLast` picks `'*': 'deny'` — the
		// primary agent silently loses delegation.
		//
		// `toEqual` does NOT compare key order, which is why this asserts
		// Object.keys directly.
		agentInternals.createAgents = () => [
			fakeAgent('architect', {
				permission: { task: 'deny', '*': 'deny' },
			}),
		];

		const configs = getAgentConfigs(noToolFilterConfig());
		const permission = configs.architect.permission as Record<string, string>;
		const keys = Object.keys(permission);

		expect(keys[keys.length - 1]).toBe('task');
		expect(permission.task).toBe('allow');
		// The wildcard the agent declared is preserved, just outranked for `task`.
		expect(keys.indexOf('*')).toBeLessThan(keys.indexOf('task'));
		expect(permission['*']).toBe('deny');
	});

	test('regression (LOW-5): a primary agent with a wildcard deny can still delegate', () => {
		// The end-to-end property the key order exists to protect, evaluated
		// through a faithful model of the host's own rule evaluation.
		agentInternals.createAgents = () => [
			fakeAgent('architect', {
				permission: { task: 'deny', '*': 'deny' },
			}),
		];

		const configs = getAgentConfigs(noToolFilterConfig());
		const rules = hostFromConfig(
			configs.architect.permission as Record<string, unknown>,
		);
		expect(hostEvaluate('task', '*', rules).action).toBe('allow');
	});

	test('task:allow wins when the agent definition also declares task', () => {
		agentInternals.createAgents = () => [
			fakeAgent('architect', { permission: { task: 'deny' } }),
		];

		const configs = getAgentConfigs(noToolFilterConfig());

		expect(configs.architect.mode).toBe('primary');
		expect(configs.architect.permission).toEqual({ task: 'allow' });
	});

	test('primary agent with no permission block gets exactly {task: allow}', () => {
		agentInternals.createAgents = () => [fakeAgent('architect', {})];

		const configs = getAgentConfigs(noToolFilterConfig());

		expect(configs.architect.mode).toBe('primary');
		expect(configs.architect.permission).toEqual({ task: 'allow' });
	});

	test("a subagent's own permission block is left untouched", () => {
		agentInternals.createAgents = () => [
			fakeAgent('architect', {}),
			fakeAgent('coder', {
				permission: { edit: 'deny', bash: { 'git *': 'allow' } },
			}),
		];

		const configs = getAgentConfigs(noToolFilterConfig());

		expect(configs.coder.mode).toBe('subagent');
		expect(configs.coder.permission).toEqual({
			edit: 'deny',
			bash: { 'git *': 'allow' },
		});
	});

	test('a non-object permission primitive does not throw and yields {task: allow}', () => {
		agentInternals.createAgents = () => [
			fakeAgent('architect', { permission: 'not-an-object' }),
		];

		expect(() => getAgentConfigs(noToolFilterConfig())).not.toThrow();
		const configs = getAgentConfigs(noToolFilterConfig());
		expect(configs.architect.mode).toBe('primary');
		expect(configs.architect.permission).toEqual({ task: 'allow' });
	});
});
