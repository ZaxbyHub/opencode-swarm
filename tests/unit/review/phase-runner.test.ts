import { afterEach, describe, expect, test } from 'bun:test';
import { resolveAutoReviewConfig } from '../../../src/config/schema';
import type { ReviewModelDispatcher } from '../../../src/review/contracts';
import {
	_internals,
	mayRunPhaseAutoReview,
	runPhaseAutoReview,
} from '../../../src/review/phase-runner';
import { captureReviewAgentModelRegistry } from '../../../src/review/runtime';

const originalRunReviewEngine = _internals.runReviewEngine;
const dispatcher: ReviewModelDispatcher = {
	async dispatch() {
		throw new Error('dispatcher should be consumed by the mocked engine');
	},
};

afterEach(() => {
	_internals.runReviewEngine = originalRunReviewEngine;
});

function input(
	overrides: Partial<Parameters<typeof runPhaseAutoReview>[0]> = {},
): Parameters<typeof runPhaseAutoReview>[0] {
	return {
		directory: 'C:\\repo',
		sessionID: 'session-1',
		phase: 2,
		isFinalPlanPhase: false,
		activeLeanTurbo: false,
		config: resolveAutoReviewConfig({ enabled: true }),
		dispatcher,
		generatedAgentNames: ['reviewer', 'critic_finding_validator'],
		injectAdvisory: () => {},
		...overrides,
	};
}

describe('phase auto-review runner', () => {
	test('dispatches phase and final-plan triggers through the shared engine', async () => {
		const triggers: string[] = [];
		_internals.runReviewEngine = async (request) => {
			triggers.push(request.trigger);
			return {
				status: 'completed',
				blocked: false,
				message: 'complete',
				findings: [],
				blockingFindings: [],
				validationComplete: true,
				scopeHash: `${request.trigger}-hash`,
				modelCalls: 1,
			};
		};

		const phase = await runPhaseAutoReview(input());
		const plan = await runPhaseAutoReview(
			input({ isFinalPlanPhase: true, phase: 3 }),
		);

		expect(triggers).toEqual(['phase_completion', 'plan_completion']);
		expect(phase.scopeHash).toBe('phase_completion-hash');
		expect(plan.scopeHash).toBe('plan_completion-hash');
	});

	test('regression F3: phase review skips malformed fallback entries', async () => {
		let captured: Parameters<typeof _internals.runReviewEngine>[0] | undefined;
		_internals.runReviewEngine = async (request) => {
			captured = request;
			return {
				status: 'completed',
				blocked: false,
				message: 'complete',
				findings: [],
				blockingFindings: [],
				validationComplete: true,
				modelCalls: 1,
			};
		};
		const names = [
			'alpha_architect',
			'alpha_reviewer',
			'alpha_critic_finding_validator',
			'beta_architect',
			'beta_reviewer',
			'beta_critic_finding_validator',
		];
		const pluginConfig = {
			swarms: {
				alpha: {
					agents: {
						reviewer: {
							fallback_models: ['openai/alpha-fallback'],
						},
					},
				},
				beta: {
					agents: {
						reviewer: {
							fallback_models: ['malformed', 'anthropic/beta-fallback'],
						},
						critic_finding_validator: {
							fallback_models: ['invalid', 'opencode/beta-validator-fallback'],
						},
					},
				},
			},
		};

		await runPhaseAutoReview(
			input({
				generatedAgentNames: names,
				activeAgentName: 'beta_architect',
				agentModelRegistry: captureReviewAgentModelRegistry(
					pluginConfig,
					names,
				),
			}),
		);

		expect(captured?.reviewerAgent).toBe('beta_reviewer');
		expect(captured?.validatorAgent).toBe('beta_critic_finding_validator');
		// Previous resolution threw on the first malformed entry and never
		// dispatched the automatic phase review.
		expect(captured?.reviewerFallbackModels).toEqual([
			{ providerID: 'anthropic', modelID: 'beta-fallback' },
		]);
		expect(captured?.validatorFallbackModels).toEqual([
			{ providerID: 'opencode', modelID: 'beta-validator-fallback' },
		]);
	});

	test('disabled and task-only configs do not dispatch', async () => {
		let calls = 0;
		_internals.runReviewEngine = async () => {
			calls += 1;
			throw new Error('unexpected');
		};
		const disabledConfig = resolveAutoReviewConfig({ enabled: false });
		const taskOnlyConfig = resolveAutoReviewConfig({
			enabled: true,
			trigger: 'task_completion',
		});
		const disabled = await runPhaseAutoReview(
			input({ config: disabledConfig }),
		);
		const taskOnly = await runPhaseAutoReview(
			input({ config: taskOnlyConfig }),
		);
		expect(disabled.trigger).toBeUndefined();
		expect(taskOnly.trigger).toBeUndefined();
		expect(mayRunPhaseAutoReview(disabledConfig)).toBe(false);
		expect(mayRunPhaseAutoReview(taskOnlyConfig)).toBe(false);
		expect(calls).toBe(0);
	});

	test('Lean owns advisory review but cannot bypass gate mode', async () => {
		let calls = 0;
		_internals.runReviewEngine = async () => {
			calls += 1;
			return {
				status: 'completed',
				blocked: false,
				message: 'complete',
				findings: [],
				blockingFindings: [],
				validationComplete: true,
				scopeHash: 'gate-hash',
				modelCalls: 1,
			};
		};
		const advisory = await runPhaseAutoReview(input({ activeLeanTurbo: true }));
		const gate = await runPhaseAutoReview(
			input({
				activeLeanTurbo: true,
				config: resolveAutoReviewConfig({
					enabled: true,
					final_review: { mode: 'gate' },
				}),
			}),
		);
		expect(advisory.trigger).toBeUndefined();
		expect(advisory.warnings[0]).toContain('Lean Turbo');
		expect(gate.trigger).toBe('phase_completion');
		expect(gate.scopeHash).toBe('gate-hash');
		expect(calls).toBe(1);
	});

	test('gate retains its trigger when the instance dispatcher is unavailable', async () => {
		const result = await runPhaseAutoReview(
			input({
				dispatcher: undefined,
				config: resolveAutoReviewConfig({
					enabled: true,
					final_review: { mode: 'gate' },
				}),
			}),
		);
		expect(result.trigger).toBe('phase_completion');
		expect(result.scopeHash).toBeUndefined();
		expect(result.warnings[0]).toContain('runtime is unavailable');
	});
});
