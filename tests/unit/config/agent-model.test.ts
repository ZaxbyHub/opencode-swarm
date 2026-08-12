import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	parseAgentModel,
	resolveConfiguredAgentModel,
	resolveRegisteredAgentModel,
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
			'(agentName) => resolveConfiguredAgentModel(config, agentName)',
		);
		expect(guardrailsTransformSource).toContain(
			'ctx.resolveAgentModel?.(activeAgent)',
		);
		expect(indexSource).not.toContain('function resolveDelegationModel');
		expect(indexSource).not.toContain('function inferSwarmID');
		expect(adversarialSource).not.toContain('Object.values(config.swarms)');
	});
});
