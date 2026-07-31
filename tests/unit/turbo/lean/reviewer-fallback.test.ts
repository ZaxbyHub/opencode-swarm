/**
 * Issue #1896 (sub-issue 3): the lean-turbo phase reviewer now fails over to a
 * configured `fallback_models` entry on a transient/quota dispatch error instead
 * of immediately writing a REJECTED verdict (a quota blip previously cascaded
 * into a false phase rejection). This is the representative integration proof for
 * the shared model-fallback wiring; the engine itself
 * (`dispatchWithModelFallback`) and the quota classifier are unit-tested
 * separately.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getAgentConfigs } from '../../../../src/agents/index';
import type { PluginConfig } from '../../../../src/config';
import type { ReviewModelDispatcher } from '../../../../src/review/contracts';
import type { ReviewAgentModelRegistry } from '../../../../src/review/runtime';
import { resetSwarmState, swarmState } from '../../../../src/state';
import {
	_internals,
	dispatchPhaseReviewer,
} from '../../../../src/turbo/lean/reviewer';

// Seed the default swarm map so the reviewer role has a fallback chain.
function seedReviewerFallback(): void {
	const config = {
		agents: {
			reviewer: {
				model: 'prov/primary-reviewer',
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

describe('dispatchPhaseReviewer — model failover (#1896)', () => {
	beforeEach(() => {
		resetSwarmState();
		seedReviewerFallback();
		// Partial mock scope: compile/write/parse exercise only the successful
		// fallback-selection path. Package I/O and parse failures are covered by
		// the sibling reviewer tests.
		_internals.compileReviewPackage = (async () => ({
			phase: 1,
		})) as unknown as typeof _internals.compileReviewPackage;
		_internals.writeReviewerEvidence = async () => '/evidence/reviewer.json';
		_internals.parseReviewerVerdict = () => ({
			verdict: 'APPROVED',
			reason: 'looks good',
		});
	});

	afterEach(() => {
		Object.assign(_internals, originalInternals);
		resetSwarmState();
	});

	test('direct legacy caller fails over to a fallback model on a quota dispatch error and recovers', async () => {
		const calls: Array<string | undefined> = [];
		_internals.dispatchReviewerAgent = async (
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

		const result = await dispatchPhaseReviewer(
			'/tmp/does-not-matter',
			1,
			'sess-1',
			{ reviewerAgent: 'reviewer', timeoutMs: 0 },
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
		_internals.dispatchReviewerAgent = async (
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
			reviewer: {
				primaryModel: 'instance/primary-reviewer',
				fallbackModels: ['instance/fallback-reviewer'],
			},
		};

		const result = await dispatchPhaseReviewer(
			'/tmp/does-not-matter',
			1,
			'sess-instance-registry',
			{
				reviewerAgent: 'reviewer',
				timeoutMs: 0,
				dispatcher: injectedDispatcher,
				agentModelRegistry,
			},
		);

		expect(result.verdict).toBe('APPROVED');
		expect(calls).toEqual([undefined, 'instance/fallback-reviewer']);
	});

	test('injected dispatcher without a registry fails closed instead of reading legacy global state', async () => {
		const calls: Array<string | undefined> = [];
		// Partial mock scope: only fallback source selection is under test.
		_internals.dispatchReviewerAgent = async (
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

		const result = await dispatchPhaseReviewer(
			'/tmp/does-not-matter',
			1,
			'sess-injected-missing-registry',
			{
				reviewerAgent: 'reviewer',
				timeoutMs: 0,
				dispatcher: injectedDispatcher,
			},
		);

		expect(result.verdict).toBe('REJECTED');
		expect(calls).toEqual([undefined]);
	});

	test('a permanent dispatch error still fails closed (REJECTED) with no failover', async () => {
		const calls: Array<string | undefined> = [];
		_internals.dispatchReviewerAgent = async (
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

		const result = await dispatchPhaseReviewer(
			'/tmp/does-not-matter',
			1,
			'sess-2',
			{ reviewerAgent: 'reviewer', timeoutMs: 0 },
		);

		expect(result.verdict).toBe('REJECTED');
		// Only the primary was attempted — no fallover on a permanent error.
		expect(calls).toEqual([undefined]);
	});

	test('a reviewer dispatch timeout is permanent (no failover) — pins the defense-in-depth carve-out', async () => {
		// The classify step explicitly treats "Reviewer dispatch timed out" as
		// permanent (mirroring the lane runner). Even though today's transient
		// classifier does not match the spaced "timed out" token anyway, this
		// pins the carve-out so a future timeout-message rewording that DOES
		// match cannot silently start burning the fallback chain.
		const calls: Array<string | undefined> = [];
		_internals.dispatchReviewerAgent = async (
			_dir,
			_pkg,
			_agent,
			_timeout,
			_parent,
			model,
		) => {
			calls.push(model ? `${model.providerID}/${model.modelID}` : undefined);
			throw new Error('Reviewer dispatch timed out after 60000ms');
		};

		const result = await dispatchPhaseReviewer(
			'/tmp/does-not-matter',
			1,
			'sess-timeout',
			{ reviewerAgent: 'reviewer', timeoutMs: 0 },
		);

		expect(result.verdict).toBe('REJECTED');
		// Only the primary attempted — timeout is permanent, no failover.
		expect(calls).toEqual([undefined]);
	});

	test('envelope-shaped quota error via the real defaultDispatchReviewerAgent (data:null + error envelope) triggers failover — pins the #1905 envelope-preservation parity fix', async () => {
		// Issue #1905 critic item 1 (Critical): the sibling reviewer site
		// (already wired in PR #1901) had the SAME envelope-discard gap as
		// auto-review.ts and integration.ts. Without the parity fix at
		// reviewer.ts:486, the classifier would see only "Reviewer session
		// returned no data" with no quota token → permanent → no failover. The
		// fix embeds JSON.stringify(response.error) in the thrown message.
		//
		// Drive the REAL defaultDispatchReviewerAgent with a mock client
		// returning { data: null, error: { message: '429 ...' } }.
		const promptCalls: Array<string | undefined> = [];
		swarmState.opencodeClient = {
			session: {
				create: async () => ({ data: { id: 'reviewer-session-1' } }),
				prompt: async (params: { body?: { model?: unknown } }) => {
					const override = params.body?.model;
					promptCalls.push(
						override
							? `${(override as { providerID: string; modelID: string }).providerID}/${(override as { providerID: string; modelID: string }).modelID}`
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
		// Restore the REAL default dispatch fn (beforeEach stubbed it).
		_internals.dispatchReviewerAgent = originalInternals.dispatchReviewerAgent;

		try {
			const result = await dispatchPhaseReviewer(
				'/tmp/does-not-matter',
				1,
				'sess-envelope',
				{ reviewerAgent: 'reviewer', timeoutMs: 0 },
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
