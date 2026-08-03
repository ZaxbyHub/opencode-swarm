import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { swarmState } from '../../../../src/state';
import {
	_internals,
	dispatchPhaseCritic,
} from '../../../../src/turbo/lean/integration';

const originalDispatchCriticAgent = _internals.dispatchCriticAgent;
let directory: string;

beforeEach(() => {
	directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'lean-critic-routing-')),
	);
	fs.mkdirSync(path.join(directory, '.swarm', 'evidence', '1', 'lean-turbo'), {
		recursive: true,
	});
	swarmState.generatedAgentNames = [];
});

afterEach(() => {
	_internals.dispatchCriticAgent = originalDispatchCriticAgent;
	swarmState.generatedAgentNames = [];
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('Lean phase critic agent routing', () => {
	test('dispatch prefers injected multi-swarm names over a later global overwrite', async () => {
		// The process-global registry can be overwritten by another plugin
		// instance; dispatch must remain bound to its injected snapshot.
		let capturedAgentName: string | undefined;
		_internals.dispatchCriticAgent = mock(
			async (_directory, _pkg, agentName) => {
				capturedAgentName = agentName;
				return 'VERDICT: APPROVED\nREASON: instance-local';
			},
		);
		swarmState.generatedAgentNames = ['beta_critic'];

		await dispatchPhaseCritic(directory, 1, 'alpha-session', {
			generatedAgentNames: ['alpha_reviewer', 'alpha_critic'],
		});

		expect(capturedAgentName).toBe('alpha_critic');
	});

	test('returns the canonical critic when no generated names exist', () => {
		expect(_internals.resolveDefaultCriticAgent([])).toBe('critic');
	});

	test('prefers the explicit default swarm without active identity', () => {
		expect(
			_internals.resolveDefaultCriticAgent([
				'critic',
				'local_critic',
				'mega_critic',
			]),
		).toBe('critic');
	});

	test('selects the active named swarm', () => {
		expect(
			_internals.resolveDefaultCriticAgent(
				['critic', 'cloud-architect', 'cloud-critic'],
				'cloud-architect',
			),
		).toBe('cloud-critic');
	});

	test('falls back to the canonical role when none is generated', () => {
		expect(
			_internals.resolveDefaultCriticAgent(['mega_coder', 'local_coder']),
		).toBe('critic');
	});

	test('rejects ambiguous named swarms without active identity', () => {
		expect(() =>
			_internals.resolveDefaultCriticAgent(['local_critic', 'mega_critic']),
		).toThrow(/multiple named swarms/i);
	});
});
