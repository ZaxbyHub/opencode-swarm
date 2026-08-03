import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { swarmState } from '../../../../src/state';
import {
	_internals,
	dispatchPhaseReviewer,
} from '../../../../src/turbo/lean/reviewer';
import type { ModelOverride } from '../../../../src/utils/model-dispatch-fallback';

const originalDispatchReviewerAgent = _internals.dispatchReviewerAgent;
let directory: string;

beforeEach(() => {
	directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'lean-reviewer-routing-')),
	);
	fs.mkdirSync(path.join(directory, '.swarm', 'evidence', '1', 'lean-turbo'), {
		recursive: true,
	});
	swarmState.generatedAgentNames = [];
});

afterEach(() => {
	_internals.dispatchReviewerAgent = originalDispatchReviewerAgent;
	swarmState.generatedAgentNames = [];
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('Lean phase reviewer agent routing', () => {
	test('dispatch prefers injected multi-swarm names over a later global overwrite', async () => {
		// The process-global registry can be overwritten by another plugin
		// instance; dispatch must remain bound to its injected snapshot.
		let capturedAgentName: string | undefined;
		_internals.dispatchReviewerAgent = mock(
			async (_directory, _pkg, agentName) => {
				capturedAgentName = agentName;
				return 'VERDICT: APPROVED\nREASON: instance-local';
			},
		);
		swarmState.generatedAgentNames = ['beta_reviewer'];

		await dispatchPhaseReviewer(directory, 1, 'alpha-session', {
			generatedAgentNames: ['alpha_reviewer', 'alpha_critic_finding_validator'],
		});

		expect(capturedAgentName).toBe('alpha_reviewer');
	});

	test('binds active-swarm fallback models to the injected plugin snapshot', async () => {
		const attempts: Array<{
			agentName: string;
			model: ModelOverride | undefined;
		}> = [];
		_internals.dispatchReviewerAgent = mock(
			async (_directory, _pkg, agentName, _timeoutMs, _sessionID, model) => {
				attempts.push({ agentName, model });
				if (attempts.length === 1) {
					throw new Error('HTTP 429 quota exceeded');
				}
				return 'VERDICT: APPROVED\nREASON: instance fallback';
			},
		);

		await dispatchPhaseReviewer(directory, 1, 'alpha-session', {
			generatedAgentNames: [
				'alpha_architect',
				'alpha_reviewer',
				'alpha_critic_finding_validator',
				'longer_swarm_architect',
				'longer_swarm_reviewer',
				'longer_swarm_critic_finding_validator',
			],
			activeAgentName: 'alpha_architect',
			agentModelRegistry: {
				alpha_reviewer: {
					primaryModel: 'openai/alpha-primary',
					fallbackModels: ['openai/alpha-fallback'],
				},
				longer_swarm_reviewer: {
					primaryModel: 'openai/longer-primary',
					fallbackModels: ['openai/longer-fallback'],
				},
			},
		});

		expect(attempts).toEqual([
			{ agentName: 'alpha_reviewer', model: undefined },
			{
				agentName: 'alpha_reviewer',
				model: {
					providerID: 'openai',
					modelID: 'alpha-fallback',
				},
			},
		]);
	});

	test('returns the canonical reviewer when no generated names exist', () => {
		expect(_internals.resolveDefaultReviewerAgent([])).toBe('reviewer');
	});

	test('prefers the explicit default swarm without active identity', () => {
		expect(
			_internals.resolveDefaultReviewerAgent([
				'reviewer',
				'local_reviewer',
				'mega_reviewer',
			]),
		).toBe('reviewer');
	});

	test('selects the active named swarm', () => {
		expect(
			_internals.resolveDefaultReviewerAgent(
				['reviewer', 'cloud-architect', 'cloud-reviewer'],
				'cloud-architect',
			),
		).toBe('cloud-reviewer');
	});

	test('falls back to the canonical role when none is generated', () => {
		expect(
			_internals.resolveDefaultReviewerAgent(['mega_coder', 'local_coder']),
		).toBe('reviewer');
	});

	test('rejects ambiguous named swarms without active identity', () => {
		expect(() =>
			_internals.resolveDefaultReviewerAgent([
				'local_reviewer',
				'mega_reviewer',
			]),
		).toThrow(/multiple named swarms/i);
	});
});
