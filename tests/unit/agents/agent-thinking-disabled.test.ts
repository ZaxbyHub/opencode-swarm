import { describe, expect, test } from 'bun:test';
import {
	createCriticAgent,
	createCriticAutonomousOversightAgent,
	createCriticDriftVerifierAgent,
} from '../../../src/agents/critic';
import {
	type CuratorRole,
	createCuratorAgent,
} from '../../../src/agents/curator-agent';

// Fix B (F-005): extended thinking is disabled by default for the
// classification/verdict agents (curator roles + autonomous-oversight critic),
// and intentionally left enabled for other critic roles. A regression that
// re-enabled thinking would re-flood the OpenCode session log.

const TEST_MODEL = 'test-model';

describe('curator agents disable extended thinking', () => {
	const roles: CuratorRole[] = [
		'curator_init',
		'curator_phase',
		'curator_postmortem',
	];
	for (const role of roles) {
		test(`createCuratorAgent(role=${role}).config.thinking is { type: 'disabled' }`, () => {
			const agent = createCuratorAgent(TEST_MODEL, undefined, undefined, role);
			expect(agent.config.thinking).toEqual({ type: 'disabled' });
		});
	}
});

describe('critic thinking configuration (oversight-only scope)', () => {
	test('createCriticAutonomousOversightAgent disables thinking by default', () => {
		const agent = createCriticAutonomousOversightAgent(TEST_MODEL);
		expect(agent.config.thinking).toEqual({ type: 'disabled' });
	});

	test('createCriticAgent does NOT disable thinking', () => {
		const agent = createCriticAgent(TEST_MODEL);
		expect(agent.config.thinking).toBeUndefined();
	});

	test('createCriticDriftVerifierAgent does NOT disable thinking', () => {
		const agent = createCriticDriftVerifierAgent(TEST_MODEL);
		expect(agent.config.thinking).toBeUndefined();
	});
});
