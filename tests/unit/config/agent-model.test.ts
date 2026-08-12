import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentConfigs } from '../../../src/agents';
import {
	parseAgentModel,
	resolveConfiguredAgentModel,
	resolveRegisteredAgentModel,
	resolveRuntimeAgentModel,
	splitEmbeddedAgentVariant,
} from '../../../src/config/agent-model';
import { DEFAULT_MODELS } from '../../../src/config/constants';
import type { PluginConfig } from '../../../src/config/schema';

function config(value: Partial<PluginConfig> = {}): PluginConfig {
	return value as PluginConfig;
}

describe('agent-model exact target resolution', () => {
	test('resolves legacy and empty-swarms top-level overrides', () => {
		const legacy = config({ agents: { coder: { model: 'top/coder' } } });
		const emptySwarms = config({
			agents: { coder: { model: 'top/coder' } },
			swarms: {},
		});

		expect(resolveConfiguredAgentModel(legacy, 'coder')).toBe('top/coder');
		expect(resolveConfiguredAgentModel(legacy, 'Coder')).toBe('top/coder');
		expect(resolveConfiguredAgentModel(emptySwarms, 'coder')).toBe('top/coder');
		expect(resolveConfiguredAgentModel(legacy, 'other_coder')).toBeUndefined();
	});

	test('matches only the exact default or named swarm target', () => {
		const multi = config({
			agents: {
				coder: { model: 'top/coder' },
				reviewer: { model: 'top/reviewer' },
			},
			swarms: {
				default: { agents: {} },
				fast: { agents: { coder: { model: 'fast/coder' } } },
				slow: { agents: { coder: { temperature: 0.2 } } },
			},
		});

		expect(resolveConfiguredAgentModel(multi, 'coder')).toBe('top/coder');
		expect(resolveConfiguredAgentModel(multi, 'fast_coder')).toBe('fast/coder');
		expect(resolveConfiguredAgentModel(multi, 'fast_reviewer')).toBe(
			'top/reviewer',
		);
		// A present swarm role wins as a whole, so missing model does not inherit.
		expect(resolveConfiguredAgentModel(multi, 'slow_coder')).toBeUndefined();
		expect(resolveRegisteredAgentModel(multi, 'slow_coder')).toBe(
			DEFAULT_MODELS.coder,
		);
		expect(resolveConfiguredAgentModel(multi, 'unknown_coder')).toBeUndefined();
	});

	test('does not invent an unprefixed agent without a default swarm', () => {
		const namedOnly = config({
			agents: { coder: { model: 'top/coder' } },
			swarms: { fast: { agents: {} } },
		});

		expect(resolveConfiguredAgentModel(namedOnly, 'coder')).toBeUndefined();
		expect(resolveRegisteredAgentModel(namedOnly, 'coder')).toBeUndefined();
		expect(resolveConfiguredAgentModel(namedOnly, 'fast_coder')).toBe(
			'top/coder',
		);
	});

	test('returns registered defaults only for a valid exact target', () => {
		const legacy = config();

		expect(resolveRegisteredAgentModel(legacy, 'coder')).toBe(
			DEFAULT_MODELS.coder,
		);
		expect(resolveRegisteredAgentModel(legacy, 'architect')).toBe(
			DEFAULT_MODELS.default,
		);
		expect(resolveRegisteredAgentModel(legacy, '')).toBeUndefined();
		expect(resolveRegisteredAgentModel(legacy, 'unknown')).toBeUndefined();
		expect(resolveRegisteredAgentModel(legacy, '__proto__')).toBeUndefined();
	});

	test('trims explicit models and treats blank winning overrides as absent', () => {
		const legacy = config({
			agents: {
				coder: { model: '  provider/model  ' },
				reviewer: { model: '   ' },
			},
		});

		expect(resolveConfiguredAgentModel(legacy, 'coder')).toBe('provider/model');
		expect(resolveConfiguredAgentModel(legacy, 'reviewer')).toBeUndefined();
		expect(resolveRegisteredAgentModel(legacy, 'reviewer')).toBe(
			DEFAULT_MODELS.reviewer,
		);
	});

	test('resolves actual subagent models while preserving primary UI selection', () => {
		const legacy = config({
			agents: { coder: { model: 'runtime/fallback' } },
		});
		const registered = {
			coder: { mode: 'subagent', model: 'factory/coder' },
			curator_init: { mode: 'subagent', model: 'factory/explorer' },
			architect: { mode: 'primary', model: 'factory/architect' },
		};

		expect(resolveRuntimeAgentModel(legacy, registered, 'Coder')).toBe(
			'runtime/fallback',
		);
		expect(resolveRuntimeAgentModel(legacy, registered, 'curator_init')).toBe(
			'factory/explorer',
		);
		expect(
			resolveRuntimeAgentModel(legacy, registered, 'architect'),
		).toBeUndefined();
		expect(
			resolveRuntimeAgentModel(legacy, registered, 'unknown_coder'),
		).toBeUndefined();
	});

	test('reads a runtime fallback mutation before the registered factory model', () => {
		const legacy = config({ agents: { coder: { model: 'primary/model' } } });
		const registered = {
			coder: { mode: 'subagent', model: 'primary/model' },
		};

		expect(resolveRuntimeAgentModel(legacy, registered, 'coder')).toBe(
			'primary/model',
		);
		legacy.agents!.coder!.model = 'fallback/model';
		expect(resolveRuntimeAgentModel(legacy, registered, 'coder')).toBe(
			'fallback/model',
		);
	});

	test('normalizes supported embedded variants to the registered model identity', () => {
		const legacy = config({
			agents: { coder: { model: 'provider/model/high' } },
		});
		const registered = {
			coder: { mode: 'subagent', model: 'provider/model' },
		};

		expect(resolveConfiguredAgentModel(legacy, 'coder')).toBe('provider/model');
		expect(resolveRuntimeAgentModel(legacy, registered, 'coder')).toBe(
			'provider/model',
		);
		expect(
			parseAgentModel(resolveRuntimeAgentModel(legacy, registered, 'coder')!),
		).toEqual({
			providerID: 'provider',
			modelID: 'model',
		});
		expect(splitEmbeddedAgentVariant('lmstudio/qwen/model-path')).toEqual({
			model: 'lmstudio/qwen/model-path',
		});
	});

	test('uses factory defaults for real subagents but not real primary agents', () => {
		const legacy = config();
		const registered = getAgentConfigs(legacy);

		expect(registered.coder.mode).toBe('subagent');
		expect(resolveRuntimeAgentModel(legacy, registered, 'coder')).toBe(
			registered.coder.model,
		);
		expect(registered.architect.mode).toBe('primary');
		expect(
			resolveRuntimeAgentModel(legacy, registered, 'architect'),
		).toBeUndefined();
	});
});

describe('parseAgentModel', () => {
	test.each([
		['model-only', { modelID: 'model-only' }],
		['provider/model', { providerID: 'provider', modelID: 'model' }],
		[
			'provider/model/subpath',
			{ providerID: 'provider', modelID: 'model/subpath' },
		],
		[' provider / model ', { providerID: 'provider', modelID: 'model' }],
	] as const)('parses %s', (input, expected) => {
		expect(parseAgentModel(input)).toEqual(expected);
	});

	test.each([
		'',
		'   ',
		'/model',
		'provider/',
		'provider//model',
		'provider/model/',
	])('rejects malformed input %j', (input) => {
		expect(parseAgentModel(input)).toBeUndefined();
	});
});

describe('agent-model production wiring', () => {
	test('all exact-agent model-selection callers share the central resolver', () => {
		const repositoryRoot = join(import.meta.dir, '..', '..', '..');
		const indexSource = readFileSync(
			join(repositoryRoot, 'src/index.ts'),
			'utf8',
		);
		const contextSource = readFileSync(
			join(repositoryRoot, 'src/hooks/context-budget.ts'),
			'utf8',
		);
		const adversarialSource = readFileSync(
			join(repositoryRoot, 'src/hooks/adversarial-detector.ts'),
			'utf8',
		);
		const guardrailsTransformSource = readFileSync(
			join(repositoryRoot, 'src/hooks/guardrails/messages-transform.ts'),
			'utf8',
		);

		expect(indexSource).toContain("from './config/agent-model.js'");
		expect(contextSource).toContain("from '../config/agent-model'");
		expect(adversarialSource).toContain("from '../config/agent-model'");
		expect(indexSource).toContain(
			'resolveRuntimeAgentModel(config, agents, agentName)',
		);
		expect(guardrailsTransformSource).toContain(
			'ctx.resolveAgentModel?.(targetAgent)',
		);
		expect(indexSource).not.toContain('function resolveDelegationModel');
		expect(indexSource).not.toContain('function inferSwarmID');
		expect(adversarialSource).not.toContain('Object.values(config.swarms)');
	});
});
