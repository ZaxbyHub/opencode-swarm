/**
 * Issue #1905: the lean-turbo phase critic boundary-review dispatch
 * (`dispatchPhaseCritic` in `src/turbo/lean/integration.ts`) now fails over to
 * a configured `fallback_models` entry on a transient/quota dispatch error
 * instead of immediately writing a REJECTED verdict (a quota blip previously
 * cascaded into a false phase rejection). Mirrors
 * `tests/unit/turbo/lean/reviewer-fallback.test.ts` for the sibling lean-turbo
 * reviewer site (PR #1901), plus the #1905-specific envelope-preservation pin.
 *
 * Uses the `_internals` DI seam (no `mock.module`) per AGENTS.md invariant #7.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getAgentConfigs } from '../../../../src/agents/index';
import type { PluginConfig } from '../../../../src/config';
import type { ReviewModelDispatcher } from '../../../../src/review/contracts';
import type { ReviewAgentModelRegistry } from '../../../../src/review/runtime';
import { resetSwarmState } from '../../../../src/state';
import {
	_internals,
	dispatchPhaseCritic,
} from '../../../../src/turbo/lean/integration';

function seedCriticFallback(): void {
	const config = {
		agents: {
			critic: {
				model: 'prov/primary-critic',
				fallback_models: ['prov/fb1', 'prov/fb2'],
			},
		},
	} as unknown as PluginConfig;
	getAgentConfigs(config);
}

const originalInternals = { ..._internals };
const injectedDispatcher: ReviewModelDispatcher = {
	dispatch: async () => {
		throw new Error('the _internals dispatch seam should intercept this call');
	},
};

describe('dispatchPhaseCritic — model failover (#1905)', () => {
	beforeEach(() => {
		resetSwarmState();
		seedCriticFallback();
		// Partial mock scope: compile/write/parse exercise only the successful
		// fallback-selection path. Package I/O and parse failures are covered by
		// the sibling integration tests for this module.
		_internals.compileCriticPackage = (async () => ({
			phase: 1,
		})) as unknown as typeof _internals.compileCriticPackage;
		_internals.writeCriticEvidence = async () => '/evidence/critic.json';
		_internals.parseCriticVerdict = () => ({
			verdict: 'APPROVED',
			reason: 'boundary acceptable',
		});
	});

	afterEach(() => {
		Object.assign(_internals, originalInternals);
		resetSwarmState();
	});

	test('direct legacy caller fails over to a fallback model on a quota dispatch error and recovers', async () => {
		const calls: Array<string | undefined> = [];
		_internals.dispatchCriticAgent = async (
			_dir,
			_pkg,
			_agent,
			_timeout,
			_parent,
			model,
		) => {
			calls.push(model ? `${model.providerID}/${model.modelID}` : undefined);
			// Primary (registered model, no override) hits quota; fallback succeeds.
			if (!model)
				throw new Error('429 insufficient_quota: usage limit exceeded');
			return 'VERDICT: APPROVED';
		};

		const result = await dispatchPhaseCritic(
			'/tmp/does-not-matter',
			1,
			'sess-1',
			{
				criticAgent: 'critic',
				timeoutMs: 0,
			},
		);

		// Recovered → APPROVED, NOT the old fail-closed REJECTED.
		expect(result.verdict).toBe('APPROVED');
		// Primary attempted (undefined), then the first fallback.
		expect(calls[0]).toBeUndefined();
		expect(calls[1]).toBe('prov/fb1');
	});

	test('injected plugin runtime uses its instance-local registry instead of the legacy global map', async () => {
		const calls: Array<string | undefined> = [];
		// Partial mock scope: only dispatch selection is under test; the shared
		// ephemeral dispatcher behavior is covered by its dedicated unit suite.
		_internals.dispatchCriticAgent = async (
			_dir,
			_pkg,
			_agent,
			_timeout,
			_parent,
			model,
		) => {
			calls.push(model ? `${model.providerID}/${model.modelID}` : undefined);
			if (!model)
				throw new Error('429 insufficient_quota: usage limit exceeded');
			return 'VERDICT: APPROVED';
		};
		const agentModelRegistry: ReviewAgentModelRegistry = {
			critic: {
				primaryModel: 'instance/primary-critic',
				fallbackModels: ['instance/fallback-critic'],
			},
		};

		const result = await dispatchPhaseCritic(
			'/tmp/does-not-matter',
			1,
			'sess-instance-registry',
			{
				criticAgent: 'critic',
				timeoutMs: 0,
				dispatcher: injectedDispatcher,
				agentModelRegistry,
			},
		);

		expect(result.verdict).toBe('APPROVED');
		expect(calls).toEqual([undefined, 'instance/fallback-critic']);
	});

	test('injected dispatcher without a registry fails closed instead of reading legacy global state', async () => {
		const calls: Array<string | undefined> = [];
		// Partial mock scope: only fallback source selection is under test.
		_internals.dispatchCriticAgent = async (
			_dir,
			_pkg,
			_agent,
			_timeout,
			_parent,
			model,
		) => {
			calls.push(model ? `${model.providerID}/${model.modelID}` : undefined);
			throw new Error('429 insufficient_quota: usage limit exceeded');
		};

		const result = await dispatchPhaseCritic(
			'/tmp/does-not-matter',
			1,
			'sess-injected-missing-registry',
			{
				criticAgent: 'critic',
				timeoutMs: 0,
				dispatcher: injectedDispatcher,
			},
		);

		expect(result.verdict).toBe('REJECTED');
		expect(calls).toEqual([undefined]);
	});

	test('a permanent dispatch error still fails closed (REJECTED) with no failover', async () => {
		const calls: Array<string | undefined> = [];
		_internals.dispatchCriticAgent = async (
			_dir,
			_pkg,
			_agent,
			_timeout,
			_parent,
			model,
		) => {
			calls.push(model ? `${model.providerID}/${model.modelID}` : undefined);
			throw new Error('401 unauthorized: invalid api key');
		};

		const result = await dispatchPhaseCritic(
			'/tmp/does-not-matter',
			1,
			'sess-2',
			{
				criticAgent: 'critic',
				timeoutMs: 0,
			},
		);

		expect(result.verdict).toBe('REJECTED');
		// Only the primary was attempted — no fallover on a permanent error.
		expect(calls).toEqual([undefined]);
	});

	test('a critic dispatch timeout is permanent (no failover) — pins the defense-in-depth carve-out', async () => {
		// The classify step explicitly treats "Critic dispatch timed out" as
		// permanent (mirroring the reviewer). This pins the carve-out so a
		// future classifier change cannot silently start burning the fallback
		// chain on a slow call.
		const calls: Array<string | undefined> = [];
		_internals.dispatchCriticAgent = async (
			_dir,
			_pkg,
			_agent,
			_timeout,
			_parent,
			model,
		) => {
			calls.push(model ? `${model.providerID}/${model.modelID}` : undefined);
			throw new Error('Critic dispatch timed out after 60000ms');
		};

		const result = await dispatchPhaseCritic(
			'/tmp/does-not-matter',
			1,
			'sess-timeout',
			{ criticAgent: 'critic', timeoutMs: 0 },
		);

		expect(result.verdict).toBe('REJECTED');
		// Only the primary attempted — timeout is permanent, no failover.
		expect(calls).toEqual([undefined]);
	});

	test('quota-annotated REJECTED reason when all fallbacks exhausted on a quota error', async () => {
		// No fallback chain seeded for THIS test — resolveFallbackModel returns
		// null, so the primary is the only attempt and the quota error exhausts
		// the (empty) chain immediately. The REJECTED reason should carry the
		// quota annotation.
		const config = {
			agents: { critic: { model: 'prov/primary-critic' } },
		} as unknown as PluginConfig;
		getAgentConfigs(config);
		_internals.dispatchCriticAgent = async () => {
			throw new Error('429 insufficient_quota: usage limit exceeded');
		};

		const result = await dispatchPhaseCritic(
			'/tmp/does-not-matter',
			1,
			'sess-exhausted',
			{ criticAgent: 'critic', timeoutMs: 0 },
		);

		expect(result.verdict).toBe('REJECTED');
		expect(result.reason).toContain('quota/usage limit exhausted');
	});

	test('envelope-shaped quota error via the real defaultDispatchCriticAgent (data:null + error envelope) triggers failover — pins the #1905 envelope-preservation fix', async () => {
		// This is the Critical-finding test: drive the REAL
		// defaultDispatchCriticAgent (not a throwing _internals mock) with a
		// mock client returning { data: null, error: { message: '429 ...' } }.
		// Without the envelope-preservation fix, the classifier would see only
		// "Critic session returned no data" with no quota token → permanent →
		// no failover. The fix embeds JSON.stringify(response.error).
		//
		// We re-assign _internals.dispatchCriticAgent back to the real
		// defaultDispatchCriticAgent (the originalInternals captured above
		// before the beforeEach stubs overwrote it) and seed a mock client.
		const { swarmState } = await import('../../../../src/state');
		const promptCalls: Array<string | undefined> = [];
		swarmState.opencodeClient = {
			session: {
				create: async () => ({ data: { id: 'critic-session-1' } }),
				prompt: async (params: { body?: { model?: unknown } }) => {
					const override = params.body?.model;
					promptCalls.push(
						override
							? `${(override as any).providerID}/${(override as any).modelID}`
							: undefined,
					);
					if (!override) {
						return {
							data: null,
							error: {
								code: 'RATE_LIMITED',
								message: '429 rate_limit_exceeded: too many requests',
							},
						};
					}
					return {
						data: { parts: [{ type: 'text', text: 'VERDICT: APPROVED' }] },
					};
				},
				delete: async () => ({}),
			},
		} as typeof swarmState.opencodeClient;
		// Restore the REAL default dispatch fn (the beforeEach stubbed it).
		_internals.dispatchCriticAgent = originalInternals.dispatchCriticAgent;

		try {
			const result = await dispatchPhaseCritic(
				'/tmp/does-not-matter',
				1,
				'sess-envelope',
				{ criticAgent: 'critic', timeoutMs: 0 },
			);

			// Failover fired on the envelope-shaped error → APPROVED.
			expect(result.verdict).toBe('APPROVED');
			expect(promptCalls[0]).toBeUndefined();
			expect(promptCalls[1]).toBe('prov/fb1');
		} finally {
			swarmState.opencodeClient = undefined;
		}
	});
});
